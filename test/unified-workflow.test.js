import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { pathToFileURL } from 'node:url';
import { registerManualVideoDesktop } from '../src/local-manual-video.js';
import { createController } from '../src/controller.js';
import { chooseHomepageState } from '../public/personal-home.js';
import { runDesktop } from '../src/desktop-lifecycle.js';
import { SingleController } from '../src/local-single-video/controller.mjs';
import { freshLedger } from '../src/local-single-video/ledger.mjs';
import { PositionStore } from '../src/local-single-video/position-store.mjs';

const courseUrl = 'https://www.educoder.net/classrooms/SyntheticUnified/video';
const snapshot = { courseUrl, courseTitle: '模拟统一课堂', complete: true, pagesScanned: 1,
  items: [{ page: 1, index: 0, title: '模拟 A', progress: 20 }, { page: 1, index: 1, title: '模拟 B', progress: 0 }] };
const picks = snapshot.items.map(({ page, index, title }) => ({ courseUrl, page, index, title }));
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
const flush = () => new Promise(resolve => setImmediate(resolve));

async function fixture(t, { initialize, dispose, act, load, makeController, initialInventory = snapshot } = {}) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'educoder-unified-test-'));
  const handlers = new Map(), windows = [], controllers = [], events = [], order = [];
  class Window extends EventEmitter {
    constructor() { super(); windows.push(this); this.destroyed = false; this.webContents = new EventEmitter();
      this.webContents.mainFrame = { url: '' }; this.webContents.setWindowOpenHandler = () => {};
      this.webContents.isDestroyed = () => this.destroyed;
      this.webContents.send = (name, value) => events.push({ name, value }); }
    setMenuBarVisibility() {} restore() {} show() {} focus() { order.push(this === main ? 'main-focused' : 'viewer-focused'); }
    isDestroyed() { return this.destroyed; }
    destroy() { this.destroyed = true; order.push('viewer-destroyed'); this.emit('closed'); }
    close() { this.emit('close', { preventDefault() {} }); }
    async loadFile(file) { this.webContents.mainFrame.url = pathToFileURL(file).href; await load?.(); }
  }
  const main = new Window(), frame = { url: 'http://127.0.0.1:51001/' };
  main.webContents.mainFrame = frame; main.webContents.getURL = () => frame.url;
  const root = createController({ initialInventory, launch: async () => ({ page: { isClosed: () => false }, context: {} }),
    makeCourse: () => ({}), scanInventory: async () => initialInventory, readClassrooms: async () => [] });
  const runtime = { origin: 'http://127.0.0.1:51001', controller: root };
  const manager = registerManualVideoDesktop({ app: { getPath: () => directory, getVersion: () => '0.1.10', isPackaged: false },
    ipcMain: { handle: (name, fn) => handlers.set(name, fn), removeHandler: name => handlers.delete(name) },
    BrowserWindow: Window, window: main, getRuntime: () => runtime,
    controllerFactory: options => {
      const { target } = options;
      const controller = makeController ? makeController(options) : { busy: false, init: async () => initialize?.(),
        status: () => ({ target: target.title, stage: 'not-open', media: null, busy: controller.busy,
          privatePlayerUrl: 'https://synthetic.invalid/?access_token=must-not-leak', playbackOptions: {} }),
        act: async action => { order.push(action); await act?.(action); return controller.status(); },
        dispose: async () => { await dispose?.(); controller.disposed = true; order.push('controller-disposed'); } };
      controllers.push(controller); return controller;
    } });
  const mainEvent = { sender: main.webContents, senderFrame: frame };
  const viewerEvent = () => ({ sender: windows.at(-1).webContents, senderFrame: windows.at(-1).webContents.mainFrame });
  t.after(async () => { await manager.close().catch(() => {}); assert.equal(path.dirname(directory).toLowerCase(), os.tmpdir().toLowerCase()); await fs.rm(directory, { recursive: true, force: true }); });
  return { manager, handlers, windows, controllers, events, order, root, mainEvent, viewerEvent, directory };
}

test('homepage guidance does not silently choose a video from the latest position or a foreign card', () => {
  const input = { snapshot, currentUrl: courseUrl };
  const model = chooseHomepageState({ ...input, recent: { seconds: 65, selection: picks[0] }, manualSelection: picks[1] });
  assert.equal(model.title, '点击方格播放视频');
  assert.match(model.subtitle, /选多条连续播放/);
  const foreign = chooseHomepageState({ ...input, manualSelection: { ...picks[1], courseUrl: courseUrl.replace('SyntheticUnified', 'Other') } });
  assert.deepEqual(foreign, model);
});

test('first-use guidance describes explicit connection, classroom selection, read-only scanning and video choice', () => {
  const input = { snapshot: null, currentUrl: '', connected: true };
  const official = chooseHomepageState({ ...input, phase: 'idle', officialSessionOpen: false });
  assert.match(official.title, /连接.*课堂/);
  assert.match(official.subtitle, /打开官方登录窗口.*自行登录.*读取我的课堂/);
  const ready = chooseHomepageState({ ...input, phase: 'ready', officialSessionOpen: true });
  assert.equal(ready.title, '还没有选择课堂');
  assert.match(ready.subtitle, /读取我的课堂/);
  const unscanned = chooseHomepageState({ ...input, phase: 'ready', currentUrl: courseUrl });
  assert.match(unscanned.subtitle, /刷新官方进度/);
  const scanning = chooseHomepageState({ ...input, phase: 'inventory-scanning', currentUrl: courseUrl });
  assert.match(scanning.title, /读取官方进度/);
  assert.match(scanning.subtitle, /只读扫描/);
  const incomplete = chooseHomepageState({ snapshot: { ...snapshot, complete: false }, currentUrl: courseUrl });
  assert.match(incomplete.subtitle, /完整扫描.*再播放/);
  const scanned = chooseHomepageState({ snapshot, currentUrl: courseUrl, phase: 'inventory-complete' });
  assert.equal(scanned.title, '点击方格播放视频');
  assert.match(scanned.subtitle, /连续播放/);
  const disconnected = chooseHomepageState({ ...input, connected: false });
  assert.match(disconnected.subtitle, /已保存位置保留.*连接恢复后再由你开始/);
});

test('same-target opens during initialization share one controller and one viewer', async t => {
  const gate = deferred(), f = await fixture(t, { initialize: () => gate.promise });
  const open = f.handlers.get('local-manual-video:open');
  const first = open(f.mainEvent, picks[0]), again = open(f.mainEvent, picks[0]);
  gate.resolve();
  const results = await Promise.allSettled([first, again]);
  assert.equal(results.filter(result => result.status === 'fulfilled').length, 2);
  assert.deepEqual(results.map(result => result.value), [{ opened: true, reused: false }, { opened: true, reused: true }]);
  assert.equal(f.controllers.length, 1); assert.equal(f.windows.length, 2);
});

test('an open cold viewer blocks target replacement and root navigation until finish', async t => {
  const f = await fixture(t), open = f.handlers.get('local-manual-video:open');
  await f.root.openBrowser(); await open(f.mainEvent, picks[0]);
  await assert.rejects(open(f.mainEvent, picks[1]), /请先.*结束观看/);
  for (const run of [() => f.root.scan(courseUrl), () => f.root.listClassrooms(), () => f.root.openBrowser(), () => f.root.start(courseUrl)])
    await assert.rejects(run(), /观看/);
  assert.equal(f.controllers.length, 1);
  await f.handlers.get('single:finish')(f.viewerEvent());
  await f.root.listClassrooms();
});

test('session exposes the chosen target and lifecycle without player URLs and refuses forged frames', async t => {
  const f = await fixture(t), session = f.handlers.get('local-manual-video:session');
  assert.equal(typeof session, 'function');
  await f.handlers.get('local-manual-video:open')(f.mainEvent, picks[1]);
  const summary = await session(f.mainEvent);
  assert.equal(summary.viewerOpen, true); assert.equal(summary.stage, 'not-open'); assert.deepEqual(summary.selection, picks[1]);
  assert.doesNotMatch(JSON.stringify(summary), /access_token|privatePlayerUrl|synthetic.invalid/);
  assert.throws(() => session({ ...f.mainEvent, senderFrame: { ...f.mainEvent.senderFrame } }), /主程序/);
  assert.throws(() => f.handlers.get('single:finish')(f.mainEvent), /当前观看窗口/);
});

test('finish waits for an in-flight action then saves and disposes before closing and returning home', async t => {
  const gate = deferred(), began = deferred(), f = await fixture(t, { act: () => { began.resolve(); return gate.promise; } });
  await f.handlers.get('local-manual-video:open')(f.mainEvent, picks[0]);
  const action = f.handlers.get('single:action')(f.viewerEvent(), 'open'); await began.promise;
  let finish;
  try {
    finish = f.handlers.get('single:finish')(f.viewerEvent());
    await flush(); assert.equal(f.windows[1].destroyed, false);
  } finally { gate.resolve(); await action; }
  await finish;
  assert.equal(f.windows[1].destroyed, true);
  assert.ok(f.order.indexOf('controller-disposed') < f.order.indexOf('viewer-destroyed'));
  assert.equal(f.order.at(-1), 'main-focused');
  assert.equal((await f.handlers.get('local-manual-video:session')(f.mainEvent)).viewerOpen, false);
});

test('OS viewer close uses finish and a failed save keeps the viewer locked with an actionable status', async t => {
  let fail = true;
  const f = await fixture(t, { dispose: () => { if (fail) throw new Error('RECORD_CHANGED'); } });
  await f.handlers.get('local-manual-video:open')(f.mainEvent, picks[0]);
  f.windows[1].close(); await flush(); await flush();
  assert.equal(f.windows[1].destroyed, false);
  const summary = await f.handlers.get('local-manual-video:session')(f.mainEvent);
  assert.equal(summary.viewerOpen, true); assert.match(summary.message, /保存|较新/);
  assert.equal(f.events.some(event => event.name === 'local-manual-video:closed'), false);
  await assert.rejects(f.root.scan(courseUrl), /观看/);
  fail = false; await f.handlers.get('single:finish')(f.viewerEvent());
  assert.equal(f.windows[1].destroyed, true);
});

test('close requested during delayed initialization disposes the late controller without opening a viewer', async t => {
  const gate = deferred(), f = await fixture(t, { initialize: () => gate.promise });
  const opening = f.handlers.get('local-manual-video:open')(f.mainEvent, picks[0]);
  const stopping = f.manager.close(); gate.resolve();
  const results = await Promise.allSettled([opening, stopping]);
  assert.equal(f.controllers[0].disposed, true); assert.equal(f.windows.length, 1);
  assert.equal(results[0].status, 'rejected');
});

test('a failed viewer load closes its empty window and leaves root navigation available', async t => {
  const f = await fixture(t, { load: () => { throw new Error('synthetic load failure'); } });
  await assert.rejects(f.handlers.get('local-manual-video:open')(f.mainEvent, picks[0]), /load failure/);
  assert.equal(f.controllers[0].disposed, true); assert.equal(f.windows[1].destroyed, true);
  assert.equal((await f.handlers.get('local-manual-video:session')(f.mainEvent)).viewerOpen, false);
  await f.root.openBrowser();
});

test('concurrent same-queue requests share one cold queue and one viewing window', async t => {
  const gate = deferred(), f = await fixture(t, { initialize: () => gate.promise });
  const request = { courseUrl, selections: picks }, open = f.handlers.get('personal-queue:open');
  const first = open(f.mainEvent, request), again = open(f.mainEvent, request); gate.resolve();
  const results = await Promise.all([first, again]);
  assert.deepEqual(results, [{ opened: true, reused: false }, { opened: true, reused: true }]);
  assert.equal(f.controllers.length, 1); assert.equal(f.windows.length, 2);
  assert.equal(f.handlers.get('single:status')(f.viewerEvent()).queue.active, false);
});

test('an existing queue prompts replacement without publishing a false opening session, and explicit replacement opens the new real controller', async t => {
  const f = await fixture(t, { makeController: options => new SingleController(options) });
  const open = f.handlers.get('personal-queue:open'), first = { courseUrl, selections: [picks[0]], replace: false };
  await open(f.mainEvent, first);
  await f.handlers.get('single:finish')(f.viewerEvent());
  const file = path.join(f.directory, 'EducoderManualVideoPlayer/personal-temporary-queue.json');
  const saved = await fs.readFile(file), previous = await f.handlers.get('local-manual-video:session')(f.mainEvent);
  f.events.length = 0;
  const replacement = { courseUrl, selections: [picks[1]], replace: false };
  await assert.rejects(open(f.mainEvent, replacement), /QUEUE_REPLACE_REQUIRED/);
  assert.equal(f.events.filter(event => event.name === 'local-manual-video:session-changed' && event.value.opening).length, 0);
  assert.deepEqual(await f.handlers.get('local-manual-video:session')(f.mainEvent), previous);
  assert.deepEqual(await fs.readFile(file), saved);
  assert.equal(f.controllers.length, 1);
  await assert.doesNotReject(open(f.mainEvent, { ...replacement, replace: true }));
  const current = await f.handlers.get('local-manual-video:session')(f.mainEvent);
  assert.equal(current.viewerOpen, true); assert.equal(current.opening, false);
  assert.deepEqual(current.selection, picks[1]);
  assert.equal(f.controllers.length, 2);
  assert.equal(f.controllers[1].target.title, picks[1].title);
  const record = JSON.parse(await fs.readFile(file, 'utf8'));
  assert.deepEqual(record.selections, [picks[1]]); assert.equal(record.cursor, 0);
});

test('a secondary candidate shows its version and old-window guidance before quitting without runtime startup', async () => {
  const order = [], app = new EventEmitter(); let starts = 0, notice;
  app.requestSingleInstanceLock = () => false; app.getVersion = () => '0.1.12';
  app.whenReady = async () => order.push('ready'); app.quit = () => order.push('quit');
  await runDesktop({ app, BrowserWindow: class {}, startRuntime: async () => { starts++; },
    onSecondaryInstance: async value => { notice = value; order.push('notice'); } });
  assert.equal(starts, 0); assert.equal(notice?.version, '0.1.12');
  assert.match(notice?.message ?? '', /0\.1\.12.*候选版.*已有助手.*查看.*窗口顶部的版本/);
  assert.match(notice?.message ?? '', /自行关闭.*再打开此候选版.*已保存位置保留/);
  assert.deepEqual(order, ['ready', 'notice', 'quit']);
});

test('manager finish unlocks the classroom after an actual single-controller transient save retry', async t => {
  const f = await fixture(t, { makeController: options => new SingleController(options) });
  await f.handlers.get('local-manual-video:open')(f.mainEvent, picks[0]);
  const child = f.controllers[0]; clearTimeout(child.timer);
  child.ledger.value = { ...freshLedger(child.target), duration: 100, watchedPrefix: 5, position: 5 };
  const save = child.positionStore.save.bind(child.positionStore); let attempts = 0, available = false;
  child.positionStore.save = async (...args) => { attempts++; if (!available) throw Object.assign(new Error('synthetic disk failure'), { code: 'EIO' }); return save(...args); };
  await assert.rejects(f.handlers.get('single:finish')(f.viewerEvent()), error => error.code === 'EIO');
  assert.equal(f.windows[1].destroyed, false);
  await assert.rejects(f.root.scan(courseUrl), /观看/);
  available = true;
  await assert.doesNotReject(f.handlers.get('single:finish')(f.viewerEvent()));
  assert.equal(attempts, 2);
  assert.equal(f.windows[1].destroyed, true);
  assert.equal((await f.handlers.get('local-manual-video:session')(f.mainEvent)).viewerOpen, false);
  assert.equal((await child.positionStore.load(child.target)).observation.position, 5);
  await assert.doesNotReject(f.root.openBrowser());
});

test('only explicit trusted discard exits an actual record conflict without changing the newer disk record', async t => {
  const f = await fixture(t, { makeController: options => new SingleController(options) });
  await f.handlers.get('local-manual-video:open')(f.mainEvent, picks[0]);
  const child = f.controllers[0]; clearTimeout(child.timer);
  child.ledger.value = { ...freshLedger(child.target), duration: 100, watchedPrefix: 5, position: 5 };
  const external = new PositionStore({ directory: child.positionStore.directory }), latest = await external.load(child.target);
  await external.save(latest, { ...freshLedger(child.target), duration: 100, watchedPrefix: 9, position: 9 }, null);
  const newer = await fs.readFile(child.positionStore.file(child.target));
  await assert.rejects(f.manager.close(), /RECORD_CHANGED/);
  assert.equal(f.windows[1].destroyed, false);
  const discard = f.handlers.get('single:discard-and-finish'); assert.equal(typeof discard, 'function');
  assert.throws(() => discard(f.mainEvent, true), /当前观看窗口/);
  assert.throws(() => discard(f.viewerEvent(), false), /INVALID_ACTION/);
  await discard(f.viewerEvent(), true);
  assert.equal(f.windows[1].destroyed, true);
  assert.deepEqual(await fs.readFile(child.positionStore.file(child.target)), newer);
  assert.equal(f.events.findLast(event => event.name === 'local-manual-video:closed').value.discarded, true);
  await assert.doesNotReject(f.handlers.get('local-manual-video:open')(f.mainEvent, picks[0]));
  assert.equal(f.controllers.length, 2);
});

test('queue advancement reports the current target card identity with its title and position', async t => {
  const initialInventory = { ...snapshot, items: snapshot.items.map((item, index) => ({ ...item, cardIdentity: `https://www.educoder.net/images/synthetic-${index}.jpg` })) };
  const selections = initialInventory.items.map(({ page, index, title, cardIdentity }) => ({ courseUrl, page, index, title, cardIdentity }));
  const second = deferred(), release = deferred();
  const f = await fixture(t, { initialInventory, makeController: ({ target }) => {
    let media = null;
    const child = { target, init: async () => {}, status: () => ({ target: target.title, classroomId: target.classroomId,
      page: target.page, index: target.index, stage: media?.ended ? 'ended' : 'not-open', media, percent: 100, confirmedWatchedPrefix: 1 }),
      act: async action => { if (action === 'open') { if (target.index === 1) { second.resolve(); await release.promise; } media = { paused: true, ended: true, currentTime: 1, duration: 1 }; } return child.status(); },
      sample: async () => media, persist: async () => {}, dispose: async () => {}, inspectPersonalQueueSafety: async () => {}, selectCard: async () => {} };
    return child;
  } });
  try {
    await f.handlers.get('personal-queue:open')(f.mainEvent, { courseUrl, selections });
    await f.handlers.get('single:queue-action')(f.viewerEvent(), 'start'); await second.promise;
    const current = await f.handlers.get('local-manual-video:session')(f.mainEvent);
    assert.equal(current.queue.cursor, 1);
    assert.deepEqual(current.selection, selections[1]);
  } finally { release.resolve(); await f.handlers.get('single:finish')(f.viewerEvent()); }
});

test('a queue waiting for its first controller reports the complete chosen first target', async t => {
  const initialInventory = { ...snapshot, items: snapshot.items.map((item, index) => ({ ...item, cardIdentity: `https://www.educoder.net/images/synthetic-${index}.jpg` })) };
  const selections = initialInventory.items.map(({ page, index, title, cardIdentity }) => ({ courseUrl, page, index, title, cardIdentity }));
  const started = deferred(), release = deferred(), f = await fixture(t, { initialInventory, initialize: async () => { started.resolve(); await release.promise; } });
  const opening = f.handlers.get('personal-queue:open')(f.mainEvent, { courseUrl, selections });
  try {
    await started.promise;
    const current = await f.handlers.get('local-manual-video:session')(f.mainEvent);
    assert.equal(current.opening, true);
    assert.deepEqual(current.selection, selections[0]);
  } finally { release.resolve(); await opening; }
});
