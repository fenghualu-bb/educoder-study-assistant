import { pickNext } from './selection.js';
import { RunError, classifyRunError } from './run-error.js';

function requireRunning(signal) {
  if (signal?.aborted) throw new RunError('STOPPED', 'task stopped');
}

export async function runCourse(adapter, {
  signal,
  onStatus = () => {},
  onEvent = async () => {},
  maxVideos = Infinity,
  maxPages = Infinity,
  initialCompleted = 0,
  expectedLayout = null,
  startPage = 1,
} = {}) {
  if (maxVideos !== Infinity && (!Number.isInteger(maxVideos) || maxVideos < 1)) {
    throw new RangeError('maxVideos must be a positive integer');
  }
  if (maxPages !== Infinity && (!Number.isInteger(maxPages) || maxPages < 1)) {
    throw new RangeError('maxPages must be a positive integer');
  }
  if (!Number.isInteger(initialCompleted) || initialCompleted < 0) throw new RangeError('initialCompleted must be nonnegative');
  if (!Number.isInteger(startPage) || startPage < 1) throw new RangeError('startPage must be a positive integer');

  let page = startPage;
  let pagesVisited = 1;
  let completed = initialCompleted;
  let persistenceFailed = false;
  const verifiedPositions = new Set();
  const emit = async event => {
    try { await onEvent(event); }
    catch (error) { persistenceFailed = true; throw error; }
  };

  try {
    if (completed >= maxVideos) {
      const result = { completed, pagesVisited, limitReached: true };
      onStatus({ phase: 'limit-reached', page, ...result });
      return result;
    }
    while (true) {
      requireRunning(signal);
      const cards = await adapter.listCards();
      if (expectedLayout) {
        const expected = expectedLayout.filter(item => item.page === page);
        if (cards.length !== expected.length || cards.some((card, index) =>
          expected[index]?.index !== index || expected[index]?.title !== card.title
          || (card.index !== undefined && card.index !== index))) {
          throw new RunError('CARD_CHANGED', `第 ${page} 页视频列表已变化`);
        }
      }
      const selected = pickNext(cards);
      if (selected) {
        const card = { ...selected, index: selected.index ?? cards.indexOf(selected) };
        const identity = `${page}:${card.index}:${card.title}`;
        if (verifiedPositions.has(identity)) {
          throw new RunError('VERIFY_NOT_100', `video ${card.title} did not reach 100% after refresh`);
        }
        const eventPosition = { page, index: card.index, title: card.title };
        await emit({ type: 'selected', ...eventPosition });
        requireRunning(signal);
        onStatus({ phase: 'playing', ...eventPosition, completed });
        await adapter.openAndWatch(card, {
          signal,
          expectedPage: page,
          expectedProgress: card.progress,
          onProgress: snapshot => onStatus({
            phase: snapshot.phase ?? 'playing', ...eventPosition, completed,
            currentTime: snapshot.currentTime, duration: snapshot.duration,
          }),
        });
        requireRunning(signal);
        await emit({ type: 'media-ended', ...eventPosition });
        onStatus({ phase: 'verifying', ...eventPosition, completed });
        if (!await adapter.verify(card, page)) {
          throw new RunError('VERIFY_NOT_100', `video ${card.title} did not reach 100% after refresh`);
        }
        requireRunning(signal);
        await emit({ type: 'verified', ...eventPosition });
        verifiedPositions.add(identity);
        completed++;
        onStatus({ phase: 'verified', ...eventPosition, completed });
        if (completed >= maxVideos) {
          const result = { completed, pagesVisited, limitReached: true };
          onStatus({ phase: 'limit-reached', ...eventPosition, ...result });
          return result;
        }
        continue;
      }

      requireRunning(signal);
      if (pagesVisited >= maxPages) {
        const result = { completed, pagesVisited, pageLimitReached: true };
        onStatus({ phase: 'page-limit-reached', page, ...result });
        return result;
      }
      if (!await adapter.nextPage()) {
        if (expectedLayout?.some(item => item.page > page)) {
          throw new RunError('PAGE_LOAD_FAILED', `预扫描有第 ${page + 1} 页，运行时却无法翻页`);
        }
        const pageLimitReached = maxPages !== Infinity;
        const result = { completed, pagesVisited, ...(pageLimitReached ? { pageLimitReached: true } : {}) };
        onStatus({ phase: pageLimitReached ? 'page-limit-reached' : 'complete', page, ...result });
        return result;
      }
      page++;
      pagesVisited++;
      onStatus({ phase: 'scanning', page, completed });
    }
  } catch (error) {
    if (!persistenceFailed) {
      const code = signal?.aborted ? 'STOPPED' : classifyRunError(error);
      await emit({ type: code === 'STOPPED' ? 'stopped' : 'failed', code });
    }
    throw error;
  }
}
