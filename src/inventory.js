import { classifyRunError } from './run-error.js';

export async function scanCourse(adapter, {
  courseUrl,
  signal,
  onPage = () => {},
  now = () => new Date(),
} = {}) {
  const items = [];
  let pagesScanned = 0;
  let courseTitle = '';
  const snapshot = () => ({
    courseUrl,
    courseTitle,
    scannedAt: now().toISOString(),
    pagesScanned,
    complete: false,
    items,
  });

  try {
    if (signal?.aborted) throw new Error('扫描已停止');
    await adapter.prepare();
    courseTitle = (await adapter.courseTitle())?.trim() ?? '';
    let page = 1;
    while (true) {
      if (signal?.aborted) throw new Error('扫描已停止');
      const cards = await adapter.listCards();
      for (const card of cards) {
        items.push({ page, index: card.index, title: card.title, progress: card.progress,
          ...(card.cardIdentity ? { cardIdentity: card.cardIdentity } : {}) });
      }
      pagesScanned++;
      onPage({ page, pagesScanned, items: [...items] });
      if (signal?.aborted) throw new Error('扫描已停止');
      if (!await adapter.nextPage()) return { ...snapshot(), complete: true };
      page++;
    }
  } catch (error) {
    if (signal?.aborted) return { ...snapshot(), stopped: true };
    const errorCode = classifyRunError(error);
    return { ...snapshot(), error: error.message, ...(errorCode === 'UNKNOWN' ? {} : { errorCode }) };
  }
}
