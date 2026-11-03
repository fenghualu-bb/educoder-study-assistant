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

test('requires the user to open the dedicated browser before starting', async () => {
  const controller = createController({ launch: async () => ({}) });
  await assert.rejects(controller.start(listUrl), /先打开头歌专用浏览器/);
});

test('starts a prepared one-video task and exposes only task status', async () => {
  let receivedUrl = '';
  const controller = createController({
    launch: async () => ({ page: { bringToFront: async () => {} } }),
    makeCourse: (_, url) => {
      receivedUrl = url;
      return { prepare: async () => {} };
    },
    run: async (_, { onStatus, maxVideos }) => {
      assert.equal(maxVideos, 1);
      onStatus({ phase: 'verified', page: 1, title: '首条视频', completed: 1 });
      return { completed: 1, pagesVisited: 1, limitReached: true };
    },
    scanInventory: scanComplete,
  });
  await controller.openBrowser();
  await controller.start(listUrl);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(receivedUrl, listUrl);
  assert.deepEqual(controller.getStatus(), { phase: 'limit-reached', completed: 1,
    pagesVisited: 1, limitReached: true, page: 1, officialSessionOpen: true });
});

test('stop aborts the active task before another video can start', async () => {
  let signal;
  const controller = createController({
    launch: async () => ({ page: { bringToFront: async () => {} } }),
    makeCourse: () => ({ prepare: async () => {} }),
    run: async (_, options) => {
      signal = options.signal;
      await new Promise(resolve => signal.addEventListener('abort', resolve, { once: true }));
      return { completed: 0, pagesVisited: 1 };
    },
    scanInventory: scanComplete,
  });
  await controller.openBrowser();
  await controller.start(listUrl);
  await new Promise(resolve => setImmediate(resolve));
  await controller.stop();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(signal.aborted, true);
  assert.equal(controller.getStatus().phase, 'stopped');
});

test('reports reaching the one-page boundary without claiming the classroom is complete', async () => {
  const controller = createController({
    launch: async () => ({ page: { bringToFront: async () => {} } }),
    makeCourse: () => ({ prepare: async () => {} }),
    run: async (_, options) => {
      assert.equal(options.maxVideos, 3);
      assert.equal(options.maxPages, 1);
      return { completed: 1, pagesVisited: 1, pageLimitReached: true };
    },
    scanInventory: scanComplete,
  });
  await controller.openBrowser();
  await controller.start(listUrl, { maxVideos: 3, maxPages: 1 });
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(controller.getStatus(), {
    phase: 'page-limit-reached', completed: 1, pagesVisited: 1, pageLimitReached: true, officialSessionOpen: true,
  });
});

test('a selected later page is reached before a bounded trial begins', async () => {
  let currentPage = 0;
  let ran = false;
  const saved = [];
  const snapshot = { ...completeScan, pagesScanned: 3, items: [
    { page: 1, index: 0, title: '第一页', progress: 100 },
    { page: 2, index: 0, title: '第二页', progress: 0 },
    { page: 3, index: 0, title: '第三页', progress: 0 },
  ] };
  const controller = createController({
    launch: async () => ({ page: { bringToFront: async () => {} } }),
    initialInventory: snapshot,
    scanInventory: async () => snapshot,
    makeCourse: () => ({
      prepare: async () => { currentPage = 1; },
      nextPage: async () => { currentPage++; return true; },
    }),
    run: async (_, options) => {
      ran = true;
      assert.equal(currentPage, 2);
      assert.deepEqual([options.startPage, options.maxPages, options.maxVideos], [2, 2, 3]);
      return { completed: 1, pagesVisited: 2, pageLimitReached: true };
    },
    saveRun: async value => { saved.push(value); },
  });
  await controller.openBrowser();
  await controller.start(listUrl, { startPage: 2, maxPages: 2, maxVideos: 3 });
  await tick();
  assert.equal(ran, true);
  assert.deepEqual(saved[0].limits, { maxVideos: 3, maxPages: 2, startPage: 2 });
  assert.deepEqual(controller.getStatus(), { phase: 'page-limit-reached', completed: 1,
    pagesVisited: 2, pageLimitReached: true, page: 2, officialSessionOpen: true });
});

test('a page absent from the fresh scan blocks a later-page trial before playback', async () => {
  let ran = false;
  const controller = createController({
    launch: async () => ({ page: { bringToFront: async () => {} } }),
    initialInventory: { ...completeScan, pagesScanned: 2, items: [
      { page: 1, index: 0, title: '首条视频', progress: 0 },
      { page: 2, index: 0, title: '第二页', progress: 0 },
    ] },
    scanInventory: async () => ({ ...completeScan, pagesScanned: 1 }),
    makeCourse: () => ({ prepare: async () => {} }),
    run: async () => { ran = true; },
  });
  await controller.openBrowser();
  await controller.start(listUrl, { startPage: 2, maxPages: 2, maxVideos: 1 });
  await tick();
  assert.equal(ran, false);
  assert.equal(controller.getStatus().phase, 'failed');
  assert.equal(controller.getStatus().errorCode, 'PAGE_LOAD_FAILED');
});

test('a changed visible layout blocks the selected later page before any video opens', async () => {
  let ran = false;
  const savedRuns = [];
  let savedInventory;
  const shown = { courseUrl: listUrl, courseTitle: '模拟课堂', pagesScanned: 2,
    complete: true, items: [
      { page: 1, index: 0, title: '第一页', progress: 100 },
      { page: 2, index: 0, title: '原第二页', progress: 0 },
    ] };
  const fresh = { ...shown, items: [shown.items[0], { ...shown.items[1], title: '新第二页' }] };
  const controller = createController({
    launch: async () => ({ page: { bringToFront: async () => {} } }),
    initialInventory: shown,
    scanInventory: async () => fresh,
    saveInventory: async value => { savedInventory = value; },
    makeCourse: () => ({ prepare: async () => {} }),
    run: async () => { ran = true; },
    saveRun: async value => { savedRuns.push(value); },
  });
  await controller.openBrowser();
  await controller.start(listUrl, { startPage: 2, maxPages: 2, maxVideos: 1 });
  await tick();
  assert.equal(ran, false);
  assert.deepEqual(savedRuns, []);
  assert.deepEqual(savedInventory, fresh);
  assert.equal(controller.getStatus().phase, 'needs-confirmation');
  assert.equal(controller.getStatus().errorCode, 'COURSE_CHANGED');
  await controller.openBrowser();
  assert.equal(controller.getStatus().phase, 'needs-confirmation');
});

test('a failed jump to the chosen page stops before opening a video', async () => {
  let ran = false;
  const snapshot = { ...completeScan, pagesScanned: 2, items: [
    { page: 1, index: 0, title: '第一页', progress: 100 },
    { page: 2, index: 0, title: '第二页', progress: 0 },
  ] };
  const controller = createController({
    launch: async () => ({ page: { bringToFront: async () => {} } }),
    initialInventory: snapshot,
    scanInventory: async () => snapshot,
    makeCourse: () => ({ prepare: async () => {}, nextPage: async () => false }),
    run: async () => { ran = true; },
  });
  await controller.openBrowser();
  await controller.start(listUrl, { startPage: 2, maxPages: 1, maxVideos: 1 });
  await tick();
  assert.equal(ran, false);
  assert.equal(controller.getStatus().phase, 'failed');
  assert.equal(controller.getStatus().errorCode, 'PAGE_LOAD_FAILED');
});

test('a two-page trial verifies the chosen page before moving to the next', async () => {
  const pages = [
    [{ index: 0, title: '第一', progress: 100 }],
    [{ index: 0, title: '第二', progress: 0 }],
    [{ index: 0, title: '第三', progress: 0 }],
  ];
  let page = 0;
  const opened = [];
  const saved = [];
  const snapshot = { ...completeScan, pagesScanned: 3,
    items: pages.flatMap((cards, position) => cards.map(card => ({ ...card, page: position + 1 }))) };
  const controller = createController({
    launch: async () => ({ page: { bringToFront: async () => {} } }),
    initialInventory: snapshot,
    scanInventory: async () => snapshot,
    makeCourse: () => ({
      prepare: async () => { page = 0; },
      listCards: async () => pages[page].map(card => ({ ...card })),
      nextPage: async () => { if (page >= 2) return false; page++; return true; },
      openAndWatch: async card => { opened.push(page + 1); pages[page][card.index].progress = 100; },
      verify: async () => true,
    }),
    saveRun: async value => { saved.push(value); },
  });
  await controller.openBrowser();
  await controller.start(listUrl, { startPage: 2, maxPages: 2, maxVideos: 2 });
  await tick();
  assert.deepEqual(opened, [2, 3]);
  const verified = saved.at(-1).events.filter(event => event.type === 'verified');
  assert.deepEqual(verified.map(event => event.page), [2, 3]);
  assert.deepEqual(controller.getStatus().phase, 'limit-reached');
  assert.equal(controller.getStatus().page, 3);
});

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

test('classroom discovery blocks starting a video task until it finishes', async () => {
  let release;
  const pending = new Promise(resolve => { release = resolve; });
  const app = createController({
    launch: async () => ({ page: {} }),
    readClassrooms: async () => pending,
  });
  await app.openBrowser();
  const listing = app.listClassrooms();
  await assert.rejects(app.start(listUrl), /已有任务/);
  release([]);
  assert.deepEqual(await listing, []);
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

test('reopening an existing Chrome session clears the previous task failure', async () => {
  let frontCount = 0;
  const controller = createController({
    launch: async () => ({ page: { bringToFront: async () => { frontCount++; } } }),
    makeCourse: () => ({ prepare: async () => { throw new Error('旧的播放错误'); } }),
    scanInventory: scanComplete,
  });
  await controller.openBrowser();
  await controller.start(listUrl);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(controller.getStatus().phase, 'failed');
  await controller.openBrowser();
  assert.equal(frontCount, 1);
  assert.deepEqual(controller.getStatus(), { phase: 'ready', completed: 0, officialSessionOpen: true });
});

test('startup exposes an interrupted task and opening Chrome does not resume playback', async () => {
  let launches = 0;
  const app = createController({
    launch: async () => { launches++; return { page: { bringToFront: async () => {} } }; },
    initialRun: { phase: 'running', courseUrl: listUrl, events: [], layout: [] },
  });
  assert.equal(app.getStatus().phase, 'interrupted');
  assert.equal(launches, 0);
  await app.openBrowser();
  assert.equal(app.getStatus().phase, 'interrupted');
});

test('startup keeps a stopped run visible until the student chooses another action', async () => {
  const app = createController({
    launch: async () => ({ page: { bringToFront: async () => {} } }),
    initialRun: { phase: 'stopped', events: [
      { type: 'selected', page: 1, index: 6, title: '长视频' },
      { type: 'stopped', code: 'STOPPED' },
    ] },
  });
  assert.deepEqual(app.getStatus(), { phase: 'stopped', completed: 0, officialSessionOpen: false });
  await app.openBrowser();
  assert.deepEqual(app.getStatus(), { phase: 'stopped', completed: 0, officialSessionOpen: true });
});

test('startup restores the last failure code and already verified count', async () => {
  const app = createController({
    launch: async () => ({ page: { bringToFront: async () => {} } }),
    initialRun: { phase: 'failed', events: [
      { type: 'verified', page: 1, index: 2, title: '已完成视频' },
      { type: 'failed', code: 'PAGE_LOAD_FAILED' },
    ] },
  });
  assert.deepEqual(app.getStatus(), { phase: 'failed', completed: 1, errorCode: 'PAGE_LOAD_FAILED', officialSessionOpen: false });
  await app.openBrowser();
  assert.deepEqual(app.getStatus(), { phase: 'failed', completed: 1, errorCode: 'PAGE_LOAD_FAILED', officialSessionOpen: true });
});

test('interrupted startup does not forget verified events from before the interruption', () => {
  const app = createController({
    launch: async () => { throw new Error('must not open browser'); },
    initialRun: { phase: 'running', events: [
      { type: 'verified', page: 1, index: 0, title: '已完成视频' },
    ] },
  });
  assert.deepEqual(app.getStatus(), { phase: 'interrupted', completed: 1, interruptedRun: true, officialSessionOpen: false });
});

test('a new public trial cannot silently overwrite an interrupted run', async () => {
  const saved = [];
  const app = createController({
    launch: async () => ({ page: { bringToFront: async () => {} } }),
    initialRun: { phase: 'running', courseUrl: listUrl, events: [], layout: [] },
    saveRun: async value => { saved.push(value); },
  });
  await app.openBrowser();
  await assert.rejects(app.start(listUrl), /中断任务/);
  assert.deepEqual(saved, []);
  assert.equal(app.getStatus().phase, 'interrupted');
});

test('an interrupted run can be explicitly replaced only after a fresh complete scan', async () => {
  const saved = [];
  let scans = 0;
  const app = createController({
    launch: async () => ({ page: { bringToFront: async () => {} } }),
    initialRun: { phase: 'running', runId: 'old-run', courseUrl: listUrl, events: [], layout: [] },
    makeCourse: () => ({ prepare: async () => {} }),
    scanInventory: async () => { scans++; return completeScan; },
    run: async () => ({ completed: 1, pagesVisited: 1, limitReached: true }),
    saveRun: async value => { saved.push(value); },
  });
  await app.openBrowser();
  await app.scan(listUrl);
  await tick();
  assert.equal(app.getStatus().phase, 'inventory-complete');
  assert.equal(app.getStatus().interruptedRun, true);
  assert.deepEqual(saved, []);
  await assert.rejects(app.start(listUrl), /中断任务/);
  await app.start(listUrl, { replaceInterrupted: true });
  await tick();
  assert.equal(scans, 2);
  assert.notEqual(saved[0].runId, 'old-run');
  assert.equal(app.getStatus().interruptedRun, undefined);
  assert.equal(app.getStatus().phase, 'limit-reached');
});

test('an explicit replacement keeps the interrupted record if preflight is incomplete', async () => {
  const saved = [];
  const app = createController({
    launch: async () => ({ page: { bringToFront: async () => {} } }),
    initialRun: { phase: 'interrupted', runId: 'old-run', courseUrl: listUrl, events: [], layout: [] },
    makeCourse: () => ({ prepare: async () => { throw new Error('must not open player'); } }),
    scanInventory: async () => ({ ...completeScan, complete: false, errorCode: 'SCAN_PARTIAL' }),
    saveRun: async value => { saved.push(value); },
  });
  await app.openBrowser();
  await app.start(listUrl, { replaceInterrupted: true });
  await tick();
  assert.deepEqual(saved, []);
  assert.equal(app.getStatus().interruptedRun, true);
  assert.equal(app.getStatus().errorCode, 'SCAN_PARTIAL');
});

test('stop while saving a new scan cannot archive an older interrupted run', async () => {
  const savedRuns = [];
  let enteredSave;
  const saving = new Promise(resolve => { enteredSave = resolve; });
  let releaseSave;
  const saveWait = new Promise(resolve => { releaseSave = resolve; });
  const app = createController({
    launch: async () => ({ page: { bringToFront: async () => {} } }),
    initialRun: { phase: 'interrupted', runId: 'old-run', courseUrl: listUrl,
      events: [], layout: [] },
    scanInventory: scanComplete,
    saveInventory: async () => { enteredSave(); await saveWait; },
    makeCourse: () => ({ prepare: async () => { throw new Error('must not open'); } }),
    saveRun: async value => { savedRuns.push(value); },
  });
  await app.openBrowser();
  await app.start(listUrl, { replaceInterrupted: true });
  await saving;
  await app.stop();
  releaseSave();
  await tick();
  assert.deepEqual(savedRuns, []);
  assert.equal(app.getStatus().interruptedRun, true);
  assert.equal(app.getStatus().phase, 'stopped');
});

test('a journal write failure stops before playback with a clear code', async () => {
  let opens = 0;
  const app = createController({
    launch: async () => ({ page: { bringToFront: async () => {} } }),
    makeCourse: () => ({ prepare: async () => { opens++; } }),
    scanInventory: scanComplete,
    saveRun: async () => { throw new Error('disk full'); },
  });
  await app.openBrowser();
  await app.start(listUrl);
  await tick();
  assert.equal(opens, 0);
  assert.equal(app.getStatus().errorCode, 'JOURNAL_WRITE_FAILED');
});

test('internal full-course fixture processes two pages only when explicitly enabled', async () => {
  const pages = [
    [{ title: '同名', index: 0, progress: 0 }],
    [{ title: '同名', index: 0, progress: 0 }],
  ];
  let page = 0;
  const opened = [];
  const saved = [];
  const app = createController({
    launch: async () => ({ page: { bringToFront: async () => {} } }),
    allowFullRun: true,
    scanInventory: async () => ({ ...completeScan, pagesScanned: 2, items: [
      { page: 1, index: 0, title: '同名', progress: 0 },
      { page: 2, index: 0, title: '同名', progress: 0 },
    ] }),
    makeCourse: () => ({
      prepare: async () => { page = 0; },
      listCards: async () => pages[page].map(card => ({ ...card })),
      openAndWatch: async () => { opened.push(page + 1); pages[page][0].progress = 100; },
      verify: async () => true,
      nextPage: async () => { if (page === 1) return false; page++; return true; },
    }),
    saveRun: async value => { saved.push(value); },
  });
  await app.openBrowser();
  await app.startFullCourse(listUrl);
  await tick();
  assert.deepEqual(opened, [1, 2]);
  assert.equal(saved.at(-1).phase, 'complete');
  assert.equal(saved.at(-1).mode, 'full');
  assert.equal(app.getStatus().completed, 2);
});

test('full-course mode stays disabled unless explicitly enabled in a fixture', async () => {
  const app = createController({ launch: async () => ({ page: { bringToFront: async () => {} } }) });
  await app.openBrowser();
  await assert.rejects(app.startFullCourse(listUrl), error => error.code === 'FEATURE_DISABLED');
});

test('shutdown stops a running task and saves its journal before closing the browser', async () => {
  const order = [];
  let runStarted;
  const started = new Promise(resolve => { runStarted = resolve; });
  const app = createController({
    launch: async () => ({ context: { close: async () => { order.push('context-closed'); } }, page: {} }),
    makeCourse: () => ({ prepare: async () => {}, cancel: async () => { order.push('player-closed'); } }),
    scanInventory: scanComplete,
    run: async (_, { signal, onEvent }) => {
      runStarted();
      await new Promise(resolve => signal.addEventListener('abort', resolve, { once: true }));
      await onEvent({ type: 'stopped' });
      return { completed: 0, pagesVisited: 1 };
    },
    saveRun: async value => { order.push(`journal-${value.phase}`); },
  });
  await app.openBrowser();
  await app.start(listUrl);
  await started;
  await app.shutdown();
  await app.shutdown();
  assert.equal(order.at(-1), 'context-closed');
  assert.equal(order.filter(value => value === 'context-closed').length, 1);
  assert.ok(order.indexOf('player-closed') < order.indexOf('context-closed'));
  assert.ok(order.indexOf('journal-stopped') < order.indexOf('context-closed'));
  await assert.rejects(app.openBrowser(), /正在关闭|已关闭/);
  await assert.rejects(app.start(listUrl), /正在关闭|已关闭/);
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

test('a partial preflight scan blocks playback and names the failure', async () => {
  let runs = 0;
  const app = createController({
    launch: async () => ({ page: { bringToFront: async () => {} } }),
    makeCourse: () => ({ prepare: async () => {} }),
    scanInventory: async () => ({ ...completeScan, complete: false }),
    run: async () => { runs++; },
  });
  await app.openBrowser();
  await app.start(listUrl);
  await tick();
  assert.equal(runs, 0);
  assert.equal(app.getStatus().errorCode, 'SCAN_PARTIAL');
});

test('preflight reports a known login failure rather than a generic partial scan', async () => {
  const app = createController({
    launch: async () => ({ page: { bringToFront: async () => {} } }),
    makeCourse: () => ({}),
    scanInventory: async () => ({ ...completeScan, complete: false, errorCode: 'LOGIN_REQUIRED', error: '请重新登录' }),
  });
  await app.openBrowser();
  await app.start(listUrl);
  await tick();
  assert.equal(app.getStatus().errorCode, 'LOGIN_REQUIRED');
});

test('a changed layout blocks explicit resume before any video opens', async () => {
  let runs = 0;
  const app = createController({
    launch: async () => ({ page: { bringToFront: async () => {} } }),
    makeCourse: () => ({ prepare: async () => {} }),
    initialRun: { version: 1, runId: 'r1', courseUrl: listUrl, mode: 'trial',
      limits: { maxVideos: 1, maxPages: 1 }, phase: 'running',
      layout: [{ page: 1, index: 0, title: '旧标题' }], events: [], updatedAt: '2026-09-23T00:00:00.000Z' },
    allowFullRun: true,
    scanInventory: scanComplete,
    run: async () => { runs++; },
  });
  await app.openBrowser();
  await app.resumeInterrupted(listUrl);
  await tick();
  assert.equal(runs, 0);
  assert.equal(app.getStatus().phase, 'needs-confirmation');
  assert.equal(app.getStatus().errorCode, 'COURSE_CHANGED');
});

test('an explicit resume scans first and honours platform 100 percent after a saved selection', async () => {
  const order = [];
  const saved = [];
  const initialRun = { version: 1, runId: 'r1', courseUrl: listUrl, mode: 'trial',
    limits: { maxVideos: 1, maxPages: 1 }, phase: 'running',
    layout: [{ page: 1, index: 0, title: '首条视频' }],
    events: [{ type: 'selected', page: 1, index: 0, title: '首条视频', at: '2026-09-23T00:00:00.000Z' }],
    updatedAt: '2026-09-23T00:00:00.000Z' };
  const app = createController({
    launch: async () => ({ page: { bringToFront: async () => {} } }),
    makeCourse: () => ({ prepare: async () => { order.push('prepare'); } }),
    initialRun, allowFullRun: true,
    saveRun: async value => { saved.push(value); },
    scanInventory: async () => { order.push('scan'); return { ...completeScan,
      items: [{ ...completeScan.items[0], progress: 100 }] }; },
    run: async (_, options) => {
      order.push('run');
      assert.equal(options.initialCompleted, 1);
      return { completed: 1, pagesVisited: 1, limitReached: true };
    },
  });
  await app.openBrowser();
  await app.resumeInterrupted(listUrl);
  await tick();
  assert.deepEqual(order, ['scan', 'prepare', 'run']);
  assert.equal(saved[0].phase, 'interrupted');
  assert.equal(app.getStatus().phase, 'limit-reached');
});

test('a failed new preflight cannot rewrite the previous completed journal', async () => {
  const saved = [];
  const previous = { version: 1, runId: 'previous', courseUrl: listUrl, mode: 'trial',
    limits: { maxVideos: 1, maxPages: 1 }, phase: 'complete', layout: [], events: [],
    updatedAt: '2026-09-23T00:00:00.000Z' };
  const app = createController({
    launch: async () => ({ page: { bringToFront: async () => {} } }),
    makeCourse: () => ({}), initialRun: previous,
    scanInventory: async () => ({ ...completeScan, complete: false }),
    saveRun: async value => { saved.push(value); },
  });
  await app.openBrowser();
  await app.start(listUrl);
  await tick();
  assert.deepEqual(saved, []);
  assert.equal(app.getStatus().errorCode, 'SCAN_PARTIAL');
});

test('stop during the fresh preflight scan never begins playback', async () => {
  let scanStarted;
  const scanning = new Promise(resolve => { scanStarted = resolve; });
  let runs = 0;
  const app = createController({
    launch: async () => ({ page: { bringToFront: async () => {} } }),
    makeCourse: () => ({}),
    scanInventory: async (_, { signal }) => {
      scanStarted();
      await new Promise(resolve => signal.addEventListener('abort', resolve, { once: true }));
      return { ...completeScan, complete: false, stopped: true };
    },
    run: async () => { runs++; },
  });
  await app.openBrowser();
  await app.start(listUrl);
  await scanning;
  await app.stop();
  await tick();
  assert.equal(runs, 0);
  assert.equal(app.getStatus().phase, 'stopped');
});

test('stop during buffering closes the player and saves a stopped run, not a verified one', async () => {
  let playing;
  const started = new Promise(resolve => { playing = resolve; });
  const saved = [];
  const opened = [];
  let cancels = 0;
  const app = createController({
    launch: async () => ({ page: { bringToFront: async () => {} } }),
    makeCourse: () => ({
      prepare: async () => {},
      listCards: async () => [{ index: 0, title: '首条视频', progress: 0 }],
      openAndWatch: async (card, { signal, onProgress }) => {
        opened.push(card.title);
        onProgress({ phase: 'buffering', currentTime: 4, duration: 60 });
        playing();
        await new Promise(resolve => signal.addEventListener('abort', resolve, { once: true }));
      },
      verify: async () => { throw new Error('must not verify after stop'); },
      cancel: async () => { cancels++; },
    }),
    scanInventory: scanComplete,
    saveRun: async value => { saved.push(value); },
  });
  await app.openBrowser();
  await app.start(listUrl);
  await started;
  assert.equal(app.getStatus().phase, 'buffering');
  await app.stop();
  await tick();
  assert.deepEqual(opened, ['首条视频']);
  assert.equal(cancels, 1);
  assert.equal(saved.at(-1).phase, 'stopped');
  assert.deepEqual(saved.at(-1).events.map(event => event.type), ['selected', 'stopped']);
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
