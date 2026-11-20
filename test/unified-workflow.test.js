import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { pathToFileURL } from 'node:url';
import { registerManualVideoDesktop } from '../src/local-manual-video.js';
import { createController } from '../src/controller.js';
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
          privatePlayerUrl: 'https://synthetic.invalid/?access_token=must-not-leak' }),
        act: async action => { order.push(action); await act?.(action); return controller.status(); },
        dispose: async () => { await dispose?.(); controller.disposed = true; order.push('controller-disposed'); } };
      controllers.push(controller); return controller;
    } });
  const mainEvent = { sender: main.webContents, senderFrame: frame };
  const viewerEvent = () => ({ sender: windows.at(-1).webContents, senderFrame: windows.at(-1).webContents.mainFrame });
  t.after(async () => { await manager.close().catch(() => {}); assert.equal(path.dirname(directory).toLowerCase(), os.tmpdir().toLowerCase()); await fs.rm(directory, { recursive: true, force: true }); });
  return { manager, handlers, windows, controllers, events, order, root, mainEvent, viewerEvent, directory };
}

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
  for (const run of [() => f.root.scan(courseUrl), () => f.root.listClassrooms(), () => f.root.openBrowser()])
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


test('progress-only UI and desktop bridge expose no batch, mute or speed controls', async t => {
  const f = await fixture(t);
  const sources = await Promise.all([
    '../public/index.html', '../public/app.js', '../src/desktop-preload.cjs',
    '../src/local-single-video/ui/index.html', '../src/local-single-video/ui/app.js',
    '../src/local-single-video/preload.cjs',
  ].map(file => fs.readFile(new URL(file, import.meta.url), 'utf8')));
  assert.doesNotMatch(sources.join('\n'), /batch-select|auto-mute|speed-enabled|speed-value|personal-queue:|single:options|\/api\/start/);
  for (const channel of ['personal-queue:open', 'single:queue-action', 'single:options', 'local-manual-video:start'])
    assert.equal(f.handlers.has(channel), false, channel);
  await f.handlers.get('local-manual-video:open')(f.mainEvent, picks[0]);
  const action = f.handlers.get('single:action');
  for (const removed of ['continue', 'next', 'mute', 'speed']) {
    assert.throws(() => action(f.viewerEvent(), removed), /INVALID_ACTION/);
  }
  assert.equal(f.order.includes('play'), false);
});
