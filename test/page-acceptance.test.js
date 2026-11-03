import { test } from 'node:test';
import assert from 'node:assert/strict';
import { acceptOneVideoAtPage } from '../src/page-acceptance.js';

const courseUrl = 'https://www.educoder.net/classrooms/SyntheticCourse/video';
const target = { page: 2, index: 0, title: '9 串 4', expectedProgress: 0 };

function classroom() {
  const pages = [
    [{ index: 0, title: '已完成', progress: 100 }],
    [{ index: 0, title: '9 串 4', progress: 0 }, { index: 1, title: '7 模拟视频甲', progress: 0 }],
  ];
  let current = 0;
  const trace = [];
  return {
    trace,
    pages,
    adapter: {
      prepare: async () => { current = 0; trace.push('prepare'); },
      courseTitle: async () => '数据结构与算法',
      listCards: async () => pages[current].map(card => ({ ...card })),
      nextPage: async () => { if (current === pages.length - 1) return false; current++; trace.push(`page:${current + 1}`); return true; },
      openAndWatch: async card => { trace.push(`open:${current + 1}:${card.title}`); pages[current][card.index].progress = 100; },
      verify: async (card, page) => { trace.push(`verify:${page}:${card.title}`); return pages[current][card.index].progress === 100; },
    },
  };
}

test('a page-two acceptance scan verifies the exact target and opens only one video', async () => {
  const fixture = classroom();
  const events = [];
  const result = await acceptOneVideoAtPage(fixture.adapter, {
    courseUrl, target,
    onReady: async ({ snapshot }) => {
      assert.equal(snapshot.complete, true);
      assert.equal(snapshot.items.length, 3);
      fixture.trace.push('ready');
    },
    onEvent: async event => events.push(event),
  });
  assert.deepEqual(fixture.trace.slice(-4), ['page:2', 'ready', 'open:2:9 串 4', 'verify:2:9 串 4']);
  assert.deepEqual(events.map(event => [event.type, event.page]), [
    ['selected', 2], ['media-ended', 2], ['verified', 2],
  ]);
  assert.deepEqual(result, { completed: 1, pagesVisited: 1, limitReached: true });
  assert.equal(fixture.pages[1][1].progress, 0);
});

test('a changed target title blocks playback before an event is saved', async () => {
  const fixture = classroom();
  const events = [];
  await assert.rejects(acceptOneVideoAtPage(fixture.adapter, {
    courseUrl, target: { ...target, title: '错误目标' },
    onEvent: async event => events.push(event),
  }), error => error.code === 'CARD_CHANGED');
  assert.equal(fixture.trace.some(item => item.startsWith('open:')), false);
  assert.deepEqual(events, []);
});

test('an already completed target does not fall through to the next pending video', async () => {
  const fixture = classroom();
  fixture.pages[1][0].progress = 100;
  await assert.rejects(acceptOneVideoAtPage(fixture.adapter, { courseUrl, target }), error => error.code === 'CARD_CHANGED');
  assert.equal(fixture.trace.some(item => item.startsWith('open:')), false);
  assert.equal(fixture.pages[1][1].progress, 0);
});

test('a target whose platform progress changed since approval is not opened', async () => {
  const fixture = classroom();
  fixture.pages[1][0].progress = 35;
  await assert.rejects(acceptOneVideoAtPage(fixture.adapter, { courseUrl, target }), error => error.code === 'CARD_CHANGED');
  assert.equal(fixture.trace.some(item => item.startsWith('open:')), false);
});

test('a target changed just before the selected event cannot be opened', async () => {
  const fixture = classroom();
  const originalListCards = fixture.adapter.listCards;
  fixture.adapter.listCards = async () => {
    if (fixture.trace.includes('ready')) fixture.pages[1][0].progress = 35;
    return originalListCards();
  };
  await assert.rejects(acceptOneVideoAtPage(fixture.adapter, {
    courseUrl, target, onReady: async () => fixture.trace.push('ready'),
  }), error => error.code === 'CARD_CHANGED');
  assert.equal(fixture.trace.some(item => item.startsWith('open:')), false);
});
