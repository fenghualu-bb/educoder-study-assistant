import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runCourse } from '../src/runner.js';
import { classifyRunError } from '../src/run-error.js';

test('skips 100 percent cards, completes pending cards, and visits the next page', async () => {
  const pages = [
    [{ title: '已完成', progress: 100 }, { title: '第一页待看', progress: 0 }],
    [{ title: '第二页待看', progress: 0 }],
  ];
  const watched = [];
  let page = 0;
  const adapter = {
    async listCards() { return pages[page].map(card => ({ ...card })); },
    async openAndWatch(card) {
      watched.push(card.title);
      pages[page].find(item => item.title === card.title).progress = 100;
    },
    async verify(card) { return pages[page].find(item => item.title === card.title).progress === 100; },
    async nextPage() {
      if (page === pages.length - 1) return false;
      page++;
      return true;
    },
  };

  const result = await runCourse(adapter);
  assert.deepEqual(watched, ['第一页待看', '第二页待看']);
  assert.deepEqual(result, { completed: 2, pagesVisited: 2 });
});

test('stops when a watched video is not confirmed as 100 percent', async () => {
  const adapter = {
    async listCards() { return [{ title: '未保存', progress: 0 }]; },
    async openAndWatch() {},
    async verify() { return false; },
    async nextPage() { throw new Error('must not advance'); },
  };
  await assert.rejects(runCourse(adapter), /did not reach 100%/);
});

test('respects stop before opening a video', async () => {
  const controller = new AbortController();
  controller.abort();
  const adapter = {
    async listCards() { throw new Error('must not scan'); },
  };
  await assert.rejects(runCourse(adapter, { signal: controller.signal }), /task stopped/);
});

test('single-video test mode verifies one video and does not open the next', async () => {
  const cards = [{ title: '第一条', progress: 0 }, { title: '第二条', progress: 0 }];
  const watched = [];
  const statuses = [];
  const adapter = {
    async listCards() { return cards.map(card => ({ ...card })); },
    async openAndWatch(card) {
      watched.push(card.title);
      cards.find(item => item.title === card.title).progress = 100;
    },
    async verify(card) { return cards.find(item => item.title === card.title).progress === 100; },
    async nextPage() { throw new Error('single-video mode must not advance'); },
  };
  const result = await runCourse(adapter, { maxVideos: 1, onStatus: status => statuses.push(status) });
  assert.deepEqual(watched, ['第一条']);
  assert.deepEqual(result, { completed: 1, pagesVisited: 1, limitReached: true });
  assert.equal(statuses.at(-1).phase, 'limit-reached');
});

test('same-page trial verifies each of three videos before opening the next', async () => {
  const cards = ['第一条', '第二条', '第三条', '第四条'].map(title => ({ title, progress: 0 }));
  const events = [];
  const adapter = {
    async listCards() { return cards.map(card => ({ ...card })); },
    async openAndWatch(card) {
      events.push(`open:${card.title}`);
      cards.find(item => item.title === card.title).progress = 100;
    },
    async verify(card) {
      events.push(`verify:${card.title}`);
      return cards.find(item => item.title === card.title).progress === 100;
    },
    async nextPage() { throw new Error('same-page trial must not advance'); },
  };
  const result = await runCourse(adapter, { maxVideos: 3, maxPages: 1 });
  assert.deepEqual(events, [
    'open:第一条', 'verify:第一条',
    'open:第二条', 'verify:第二条',
    'open:第三条', 'verify:第三条',
  ]);
  assert.deepEqual(result, { completed: 3, pagesVisited: 1, limitReached: true });
  assert.equal(cards[3].progress, 0);
});

test('same-page trial stops at page end even if fewer than three are pending', async () => {
  const cards = [{ title: '第一条', progress: 0 }, { title: '第二条', progress: 100 }];
  const adapter = {
    async listCards() { return cards.map(card => ({ ...card })); },
    async openAndWatch(card) { cards.find(item => item.title === card.title).progress = 100; },
    async verify() { return true; },
    async nextPage() { throw new Error('same-page trial must not advance'); },
  };
  const result = await runCourse(adapter, { maxVideos: 3, maxPages: 1 });
  assert.deepEqual(result, { completed: 1, pagesVisited: 1, pageLimitReached: true });
});

test('the next video waits for verified event persistence', async () => {
  const cards = [{ title: '一', index: 0, progress: 0 }, { title: '二', index: 1, progress: 0 }];
  const trace = [];
  const adapter = {
    listCards: async () => cards.map(item => ({ ...item })),
    openAndWatch: async card => { trace.push(`open:${card.title}`); cards[card.index].progress = 100; },
    verify: async card => { trace.push(`verify:${card.title}`); return true; },
    nextPage: async () => false,
  };
  await runCourse(adapter, { maxVideos: 2, onEvent: async event => trace.push(`save:${event.type}:${event.title}`) });
  assert.deepEqual(trace.slice(0, 7), [
    'save:selected:一', 'open:一', 'save:media-ended:一', 'verify:一',
    'save:verified:一', 'save:selected:二', 'open:二',
  ]);
});

test('a failed journal write before selection prevents opening playback', async () => {
  let opened = 0;
  const adapter = { listCards: async () => [{ title: '一', progress: 0 }], openAndWatch: async () => { opened++; } };
  await assert.rejects(runCourse(adapter, { onEvent: async () => { throw new Error('disk full'); } }), /disk full/);
  assert.equal(opened, 0);
});

test('a locally ended video is not counted until the platform confirms 100 percent', async () => {
  const events = [];
  const adapter = {
    listCards: async () => [{ title: '未确认', progress: 0 }],
    openAndWatch: async () => {},
    verify: async () => false,
  };
  await assert.rejects(runCourse(adapter, { onEvent: async event => events.push(event) }), error => classifyRunError(error) === 'VERIFY_NOT_100');
  assert.deepEqual(events.map(event => event.type), ['selected', 'media-ended', 'failed']);
});

test('a stale list reporting the just-verified card below 100 stops instead of reopening it', async () => {
  let opens = 0;
  const adapter = {
    listCards: async () => [{ title: '重复', progress: 0 }],
    openAndWatch: async () => { opens++; },
    verify: async () => true,
  };
  await assert.rejects(runCourse(adapter), error => classifyRunError(error) === 'VERIFY_NOT_100');
  assert.equal(opens, 1);
});

test('three-page same-name cards remain independent by page and position', async () => {
  let page = 0;
  const cards = Array.from({ length: 3 }, () => [{ title: '同名', progress: 0 }]);
  const opened = [];
  const adapter = {
    listCards: async () => cards[page].map(item => ({ ...item })),
    openAndWatch: async () => { opened.push(page + 1); cards[page][0].progress = 100; },
    verify: async () => true,
    nextPage: async () => ++page < cards.length,
  };
  const result = await runCourse(adapter);
  assert.deepEqual(opened, [1, 2, 3]);
  assert.equal(result.completed, 3);
});

test('a missing next-page control cannot complete a previously scanned two-page course', async () => {
  const statuses = [];
  const events = [];
  const adapter = {
    listCards: async () => [{ index: 0, title: '第一页', progress: 100 }],
    nextPage: async () => false,
    openAndWatch: async () => { throw new Error('must not open a video'); },
  };
  await assert.rejects(runCourse(adapter, {
    expectedLayout: [
      { page: 1, index: 0, title: '第一页' },
      { page: 2, index: 0, title: '第二页' },
    ],
    onStatus: status => statuses.push(status.phase),
    onEvent: async event => { events.push(event); },
  }), error => error.code === 'PAGE_LOAD_FAILED');
  assert.equal(statuses.includes('complete'), false);
  assert.deepEqual(events.map(event => event.type), ['failed']);
});

test('a layout change between two videos blocks selecting the next card', async () => {
  const cards = [{ title: '一', progress: 0 }, { title: '二', progress: 0 }];
  const opened = [];
  const adapter = {
    listCards: async () => cards.map(item => ({ ...item })),
    openAndWatch: async card => {
      opened.push(card.title);
      cards[0].progress = 100;
      cards[1].title = '新标题';
    },
    verify: async () => true,
  };
  await assert.rejects(runCourse(adapter, {
    expectedLayout: [{ page: 1, index: 0, title: '一' }, { page: 1, index: 1, title: '二' }],
  }), error => classifyRunError(error) === 'CARD_CHANGED');
  assert.deepEqual(opened, ['一']);
});

test('stopping during verification never saves verified or opens another video', async () => {
  const abort = new AbortController();
  const events = [];
  const adapter = {
    listCards: async () => [{ title: '一', progress: 0 }, { title: '二', progress: 0 }],
    openAndWatch: async () => {},
    verify: async () => { abort.abort(); return true; },
  };
  await assert.rejects(runCourse(adapter, { signal: abort.signal, onEvent: async event => events.push(event.type) }), /task stopped/);
  assert.deepEqual(events, ['selected', 'media-ended', 'stopped']);
});

test('a development-only single-page run uses the real page number and never advances', async () => {
  const cards = [{ index: 0, title: '9 串 4', progress: 0 }, { index: 1, title: '7 模拟视频甲', progress: 0 }];
  const opened = [];
  const verifiedPages = [];
  const events = [];
  const adapter = {
    listCards: async () => cards.map(card => ({ ...card })),
    openAndWatch: async card => { opened.push(card.title); cards[card.index].progress = 100; },
    verify: async (_, page) => { verifiedPages.push(page); return true; },
    nextPage: async () => { throw new Error('must not advance past page 2'); },
  };
  const result = await runCourse(adapter, {
    startPage: 2, maxPages: 1, maxVideos: 1,
    expectedLayout: [{ page: 2, index: 0, title: '9 串 4' }, { page: 2, index: 1, title: '7 模拟视频甲' }],
    onEvent: async event => events.push(event),
  });
  assert.deepEqual(opened, ['9 串 4']);
  assert.deepEqual(verifiedPages, [2]);
  assert.deepEqual(events.map(event => [event.type, event.page]), [
    ['selected', 2], ['media-ended', 2], ['verified', 2],
  ]);
  assert.deepEqual(result, { completed: 1, pagesVisited: 1, limitReached: true });
  assert.equal(cards[1].progress, 0);
});

test('a bounded later-page trial never reports the entire classroom complete', async () => {
  const adapter = {
    listCards: async () => [{ index: 0, title: '最后一页已看完', progress: 100 }],
    nextPage: async () => false,
  };
  const result = await runCourse(adapter, {
    startPage: 2, maxPages: 2, maxVideos: 3,
    expectedLayout: [{ page: 2, index: 0, title: '最后一页已看完' }],
  });
  assert.deepEqual(result, { completed: 0, pagesVisited: 1, pageLimitReached: true });
});

test('runner passes the selected page and platform progress to the final click guard', async () => {
  const cards = [{ index: 0, title: '9 串 4', progress: 0 }];
  const adapter = {
    listCards: async () => cards.map(card => ({ ...card })),
    openAndWatch: async (_, options) => {
      assert.deepEqual([options.expectedPage, options.expectedProgress], [2, 0]);
      cards[0].progress = 100;
    },
    verify: async () => true,
  };
  const result = await runCourse(adapter, { startPage: 2, maxPages: 1, maxVideos: 1 });
  assert.equal(result.completed, 1);
});
