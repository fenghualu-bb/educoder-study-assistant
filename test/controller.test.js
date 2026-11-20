import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createController } from '../src/controller.js';

const listUrl = 'https://www.educoder.net/classrooms/demo8cls/video';
const completeScan = { courseUrl: listUrl, courseTitle: '离散数学', pagesScanned: 1, complete: true,
  items: [{ page: 1, index: 0, title: '首条视频', progress: 0 }] };
const scanComplete = async () => completeScan;
const tick = () => new Promise(resolve => setImmediate(resolve));

async function waitForPhase(controller, wanted) {
  const deadline = Date.now() + 2_000;
  while (Date.now() < deadline) {
    const status = controller.getStatus();
    if (status.phase === wanted || status.phase === 'failed') return status;
    await tick();
  }
  throw new Error(`phase did not reach ${wanted}`);
}

test('scan requires an opened browser session', async () => {
  const controller = createController({ launch: async () => ({}) });
  await assert.rejects(controller.scan(listUrl), /先打开头歌专用浏览器/);
});

test('my classrooms are read only after opening the official browser session', async () => {
  const page = { bringToFront: async () => {} };
  const expected = [{ title: '数据结构与算法', url: listUrl }];
  const app = createController({
    launch: async () => ({ page }),
    readClassrooms: async receivedPage => {
      assert.equal(receivedPage, page);
      return expected;
    },
    makeCourse: () => { throw new Error('listing classrooms must not open videos'); },
  });
  await assert.rejects(app.listClassrooms(), /先打开/);
  await app.openBrowser();
  assert.deepEqual(await app.listClassrooms(), expected);
});

test('scan publishes and saves a complete read-only inventory', async () => {
  const snapshot = {
    courseUrl: listUrl,
    courseTitle: '离散数学',
    scannedAt: '2026-09-23T12:00:00.000Z',
    pagesScanned: 2,
    complete: true,
    items: [{ page: 1, index: 0, title: '集合', progress: 100 }],
  };
  let saved;
  let receivedUrl;
  const controller = createController({
    launch: async () => ({ page: { bringToFront: async () => {} } }),
    makeCourse: (_, url) => { receivedUrl = url; return {}; },
    scanInventory: async (_, options) => {
      assert.equal(options.courseUrl, listUrl);
      options.onPage({ page: 1, pagesScanned: 1, items: snapshot.items });
      return snapshot;
    },
    saveInventory: async value => { saved = value; },
  });
  await controller.openBrowser();
  await controller.scan(listUrl);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(receivedUrl, listUrl);
  assert.deepEqual(saved, snapshot);
  assert.deepEqual(controller.getInventory(), snapshot);
  assert.equal(controller.getStatus().phase, 'inventory-complete');
});

test('a partial scan stays visible and is never labelled complete', async () => {
  const partial = {
    courseUrl: listUrl,
    courseTitle: '离散数学',
    scannedAt: '2026-09-23T12:00:00.000Z',
    pagesScanned: 1,
    complete: false,
    error: '下一页加载超时',
    items: [{ page: 1, index: 0, title: '集合', progress: 10 }],
  };
  const controller = createController({
    launch: async () => ({ page: { bringToFront: async () => {} } }),
    makeCourse: () => ({}),
    scanInventory: async () => partial,
    saveInventory: async () => {},
  });
  await controller.openBrowser();
  await controller.scan(listUrl);
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(controller.getInventory(), partial);
  assert.equal(controller.getStatus().phase, 'inventory-partial');
});

test('shutdown closes a browser that finishes opening after shutdown begins', async () => {
  let finishLaunch;
  let closes = 0;
  const launched = new Promise(resolve => { finishLaunch = resolve; });
  const app = createController({ launch: async () => launched });
  const opening = app.openBrowser();
  const closing = app.shutdown();
  finishLaunch({ context: { close: async () => { closes++; } }, page: {} });
  await Promise.allSettled([opening, closing]);
  assert.equal(closes, 1);
});

test('shutdown retries a transient browser close failure without starting new work', async () => {
  let closes = 0;
  const app = createController({ launch: async () => ({
    page: {}, context: { close: async () => { if (++closes === 1) throw new Error('browser busy'); } },
  }) });
  await app.openBrowser();
  await assert.rejects(app.shutdown(), /browser busy/);
  await app.shutdown();
  assert.equal(closes, 2);
  await assert.rejects(app.openBrowser(), /正在关闭|已关闭/);
});

test('stopping a scan retains the previously complete inventory', async () => {
  const previous = {
    courseUrl: listUrl,
    courseTitle: '离散数学',
    pagesScanned: 8,
    complete: true,
    items: [{ page: 1, index: 0, title: '集合', progress: 100 }],
  };
  const partial = {
    ...previous,
    pagesScanned: 1,
    complete: false,
    stopped: true,
    items: [{ page: 1, index: 0, title: '集合', progress: 100 }],
  };
  let saveCount = 0;
  const controller = createController({
    launch: async () => ({ page: { bringToFront: async () => {} } }),
    makeCourse: () => ({}),
    scanInventory: async (_, options) => {
      options.onPage({ page: 1, pagesScanned: 1, items: partial.items });
      return partial;
    },
    initialInventory: previous,
    saveInventory: async () => { saveCount++; },
  });
  await controller.openBrowser();
  await controller.scan(listUrl);
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(controller.getInventory(), previous);
  assert.equal(controller.getStatus().phase, 'inventory-stopped');
  assert.equal(controller.getStatus().retainedPrevious, true);
  assert.equal(controller.getStatus().pagesScanned, 1);
  assert.equal(saveCount, 0);
});
