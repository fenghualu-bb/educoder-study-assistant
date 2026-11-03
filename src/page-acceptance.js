import { normalizeClassroomUrl } from './course.js';
import { scanCourse } from './inventory.js';
import { layoutFromInventory } from './run-layout.js';
import { runCourse } from './runner.js';
import { pickNext } from './selection.js';
import { RunError } from './run-error.js';

export async function acceptOneVideoAtPage(adapter, {
  courseUrl,
  target,
  signal,
  onReady = async () => {},
  onEvent = async () => {},
  onStatus = () => {},
} = {}) {
  if (normalizeClassroomUrl(courseUrl) !== courseUrl) throw new RangeError('courseUrl must be the video list URL');
  if (!Number.isInteger(target?.page) || target.page < 1 || !Number.isInteger(target.index)
    || target.index < 0 || typeof target.title !== 'string' || !target.title.trim()
    || !Number.isInteger(target.expectedProgress) || target.expectedProgress < 0 || target.expectedProgress >= 100) {
    throw new RangeError('target must identify one pending page, position, title and exact progress');
  }

  const snapshot = await scanCourse(adapter, { courseUrl, signal });
  if (signal?.aborted) throw new RunError('STOPPED', 'task stopped');
  if (!snapshot.complete) throw new RunError(snapshot.errorCode ?? 'SCAN_PARTIAL', snapshot.error || '课程完整扫描失败');
  const layout = layoutFromInventory(snapshot);
  const planned = snapshot.items.find(item => item.page === target.page && item.index === target.index);
  if (!planned || planned.title !== target.title || planned.progress !== target.expectedProgress) {
    throw new RunError('CARD_CHANGED', '指定的视频不再是待处理目标，未打开播放器');
  }

  await adapter.prepare();
  for (let page = 1; page < target.page; page++) {
    if (signal?.aborted) throw new RunError('STOPPED', 'task stopped');
    if (!await adapter.nextPage()) throw new RunError('PAGE_LOAD_FAILED', `无法抵达第 ${target.page} 页`);
  }
  const current = await adapter.listCards();
  const firstPending = pickNext(current);
  const firstIndex = firstPending?.index ?? current.indexOf(firstPending);
  if (!firstPending || firstIndex !== target.index || firstPending.title !== target.title
    || firstPending.progress !== target.expectedProgress) {
    throw new RunError('CARD_CHANGED', '目标页首条待看视频已变化，未打开播放器');
  }
  await onReady({ snapshot, layout, target: planned });
  return runCourse(adapter, {
    signal, onStatus,
    onEvent: async event => {
      if (event.type === 'selected') {
        const live = (await adapter.listCards())[target.index];
        if (event.page !== target.page || event.index !== target.index || event.title !== target.title
          || !live || live.title !== target.title || live.progress !== target.expectedProgress) {
          throw new RunError('CARD_CHANGED', '目标视频进度或位置在开始前发生变化，未打开播放器');
        }
      }
      await onEvent(event);
    },
    startPage: target.page, maxPages: 1, maxVideos: 1,
    expectedLayout: layout,
  });
}
