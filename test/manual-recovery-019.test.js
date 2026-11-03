import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { registerManualVideoDesktop } from '../src/local-manual-video.js';
import { SingleController } from '../src/local-single-video/controller.mjs';
import { ObservationLedger, freshLedger } from '../src/local-single-video/ledger.mjs';
import { PersonalQueueController } from '../src/personal-queue-controller.mjs';
import { PersonalQueueStore, resolvePersonalQueue } from '../src/personal-queue-store.mjs';

// Actual IPC, staged queue persistence and controllers; only the official browser
// boundary is synthetic. No application profiles or real courses are involved.
const courseUrl = 'https://www.educoder.net/classrooms/SyntheticManualRecovery019/video';
const snapshot = { courseUrl, courseTitle: 'Synthetic recovery', complete: true, items: [
  { page: 1, index: 0, title: 'Synthetic A', cardIdentity: 'https://www.educoder.net/images/manual-recovery-a.png', progress: 0 },
  { page: 1, index: 1, title: 'Synthetic B', cardIdentity: 'https://www.educoder.net/images/manual-recovery-b.png', progress: 0 },
] };
const selections = snapshot.items.map(({ page, index, title, cardIdentity }) => ({ courseUrl, page, index, title, cardIdentity }));
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(read, accept, milliseconds = 2000) {
  const deadline = Date.now() + milliseconds;
  let state;
  do { state = await read(); if (accept(state)) return state; await delay(5); } while (Date.now() < deadline);
  assert.fail('Recovery integration did not reach expected state: ' + JSON.stringify(state));
}
function gate() {
  let release, enter;
  return { wait: new Promise(resolve => { release = resolve; }), entered: new Promise(resolve => { enter = resolve; }),
    release: () => release(), enter: () => enter() };
}
async function fixture(t, { failFirstOpen = false, saved = false, recoveryGate = null, advanceMedia = false, reopeningGate = null } = {}) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'educoder-manual-recovery-019-'));
  const handlers = new Map(), children = [], queues = [], events = [], published = [];
  const queueStore = new PersonalQueueStore(path.join(directory, 'EducoderManualVideoPlayer/personal-temporary-queue.json'));
  class Window extends EventEmitter {
    constructor() {
      super(); this.webContents = new EventEmitter(); this.webContents.mainFrame = { url: 'http://127.0.0.1:51919/' };
      this.webContents.getURL = () => this.webContents.mainFrame.url;
      this.webContents.send = (name, state) => events.push({ name, state });
      this.webContents.setWindowOpenHandler = () => {};
    }
    restore() {} show() {} focus() {} setMenuBarVisibility() {} async loadFile() {}
    isDestroyed() { return Boolean(this.destroyed); }
    destroy() { this.destroyed = true; this.emit('closed'); }
  }
  const window = new Window(), event = { sender: window.webContents, senderFrame: window.webContents.mainFrame };
  const context = { pages: () => [], close: async () => {}, newPage: async () => ({ isClosed: () => false,
    url: () => courseUrl, goto: async () => {}, close: async () => {}, bringToFront: async () => {} }) };
  const root = { getStatus: () => ({ phase: 'inventory-complete' }), getInventory: () => snapshot,
    isTaskActive: () => false, getManualSession: async () => ({ context }), setViewingSession: state => published.push(state) };
  const originalInit = PersonalQueueController.prototype.init;
  PersonalQueueController.prototype.init = function () {
    if (this.targets[0]?.classroomId === 'SyntheticManualRecovery019') {
      // Short intervals keep the same ordering and cancellation code under test.
      this.pollMs = 10; this.retryBaseMs = this.retryMaxMs = 20; queues.push(this);
    }
    return originalInit.call(this);
  };
  if (saved) await queueStore.create({ ...resolvePersonalQueue(snapshot, [selections[1]]), mode: 'single' });
  const manager = registerManualVideoDesktop({ app: { getPath: () => directory, getVersion: () => '0.1.19', isPackaged: false },
    ipcMain: { handle: (name, handler) => handlers.set(name, handler), removeHandler: name => handlers.delete(name) },
    BrowserWindow: Window, window, getRuntime: () => ({ origin: 'http://127.0.0.1:51919', controller: root }),
    controllerFactory: options => {
      const child = new SingleController({ ...options, controlsFactory: () => ({
        setPlaying: async playing => { child.actions.push(playing ? 'play' : 'pause'); child.value.paused = !playing; if (playing) child.value.currentTime += 0.1; },
        muteAvailable: async () => true, rates: async () => [1], setMuted: async muted => { child.value.muted = muted; },
      }) });
      child.actions = []; let openAttempts = 0;
      const init = child.init.bind(child);
      child.init = async () => { await init(); clearTimeout(child.timer); await child.ticking; };
      child.selectCard = async () => { child.percent = 0; return { locator: () => ({ click: async () => {} }) }; };
      child.openVideo = async () => {
        child.actions.push('open');
        if (failFirstOpen && children.indexOf(child) === 0 && ++openAttempts === 1) throw new Error(typeof failFirstOpen === 'string' ? failFirstOpen : 'PAGE_LOAD_FAILED');
        child.checkOperation(); await child.openOfficial();
        child.value = { currentTime: 0, duration: 100, paused: true, ended: false, playbackRate: 1, readyState: 4, muted: false, volume: 0.5 };
        child.boundPlayerUrl = 'https://www.educoder.net/video_info?video_id=synthetic-manual-' + child.target.index;
        let playerClosed = false, pageClosed = false;
        child.player = { isClosed: () => playerClosed, url: () => child.boundPlayerUrl,
          close: async () => { playerClosed = true; child.actions.push('close'); }, bringToFront: async () => {},
          locator: selector => selector === 'body' ? { innerText: async () => '\u6682\u65e0\u68c0\u67e5\u70b9' } : { evaluate: async () => {
            if (advanceMedia && !child.value.paused && !child.value.ended) child.value.currentTime += 0.1;
            return { ...child.value };
          } } };
        child.ownedPlayer = child.player;
        child.page = { isClosed: () => pageClosed, url: () => courseUrl, close: async () => { pageClosed = true; }, bringToFront: async () => {} };
        child.context = { pages: () => [child.page, child.player] }; child.verifiedPlayer = true;
        if (reopeningGate && openAttempts === 2) { reopeningGate.enter(); await reopeningGate.wait; child.checkOperation(); }
        child.touched = false; child.stage = 'paused'; await child.sample(); await child.applyPlaybackOptions();
      };
      child.native = async (_action, _pid, seconds) => { child.actions.push('restore'); child.value.currentTime = seconds; };
      const recover = child.recoverQueuePlayback.bind(child);
      child.recoverQueuePlayback = async error => {
        child.actions.push('recover');
        if (recoveryGate && children.indexOf(child) === 0) { recoveryGate.enter(); await recoveryGate.wait; }
        return recover(error);
      };
      children.push(child); return child;
    } });
  t.after(async () => {
    recoveryGate?.release(); reopeningGate?.release(); await manager.close().catch(() => {});
    PersonalQueueController.prototype.init = originalInit;
    assert.equal(path.dirname(directory).toLowerCase(), os.tmpdir().toLowerCase());
    await fs.rm(directory, { recursive: true, force: true });
  });
  const call = (name, ...args) => handlers.get('local-manual-video:' + name)(event, ...args);
  const start = (patch = {}) => call('start', { mode: 'single', courseUrl, selections: [selections[0]], fromBeginning: false, resumeSaved: false, ...patch });
  return { call, start, children, queues, events, published, queueStore, manager };
}

test('019 initial network wait commits the selected batch and user pause cancels its pending recovery', async t => {
  const recovery = gate(), f = await fixture(t, { failFirstOpen: true, saved: true, recoveryGate: recovery });
  const waiting = await f.start();
  assert.equal(waiting.opening, false); assert.equal(waiting.active, true); assert.equal(waiting.queue.retrying, true);
  assert.equal(waiting.failure, null); assert.equal((await f.queueStore.read()).selections[0].index, 0);
  await recovery.entered;
  const paused = await f.call('action', 'pause');
  assert.equal(paused.queue.active, false); assert.equal(paused.queue.reason, 'USER_PAUSED');
  recovery.release(); await f.queues[0].job;
  assert.equal(f.children[0].actions.includes('play'), false);
  assert.equal((await f.call('status')).queue.reason, 'USER_PAUSED');
});

test('019 continue with a new transient failure returns a cancellable wait and cannot later play after pause', async t => {
  const recovery = gate(), f = await fixture(t, { recoveryGate: recovery });
  await f.start(); await f.call('action', 'pause');
  const child = f.children[0], safety = child.inspectPersonalQueueSafety.bind(child); let fail = true;
  child.inspectPersonalQueueSafety = async () => { if (fail) { fail = false; throw new Error('PAGE_LOAD_FAILED'); } return safety(); };
  const playsBefore = child.actions.filter(action => action === 'play').length;
  const waiting = await f.call('action', 'continue');
  assert.equal(waiting.busy, false); assert.equal(waiting.queue.retrying, true); await recovery.entered;
  await f.call('action', 'pause'); recovery.release(); await f.queues[0].job;
  assert.equal(child.actions.filter(action => action === 'play').length, playsBefore);
  assert.equal((await f.call('status')).queue.reason, 'USER_PAUSED');
});

test('019 finish during a committed initial recovery keeps the selected saved batch and releases its lock', async t => {
  const recovery = gate(), f = await fixture(t, { failFirstOpen: true, saved: true, recoveryGate: recovery });
  await f.start(); await recovery.entered;
  const finishing = f.call('finish'); recovery.release(); await finishing;
  assert.equal((await f.call('status')).active, false); assert.equal(f.children[0].actions.includes('play'), false);
  const saved = await f.queueStore.read(); assert.equal(saved.selections[0].index, 0); assert.equal(saved.phase, 'stopped');
});

test('019 replacement drains old recovery and rejects stale old queue state notifications', async t => {
  const recovery = gate(), f = await fixture(t, { failFirstOpen: true, recoveryGate: recovery });
  await f.start(); await recovery.entered;
  const old = f.queues[0], replacing = f.start({ selections: [selections[1]], replaceCurrent: true });
  replacing.catch(() => {});
  await until(() => f.call('status'), state => state.replacing);
  recovery.release(); const current = await replacing;
  assert.deepEqual(current.selection, selections[1]); assert.equal(current.media.paused, false);
  assert.equal(f.children[0].actions.includes('play'), false);
  const eventCount = f.events.length, revision = current.revision;
  old.lastError = new Error('LOGIN_REQUIRED');
  old.onState({ ...old.status().queue, active: false, phase: 'paused', reason: 'LOGIN_REQUIRED' });
  old.completionConfirmed = true;
  old.onState({ ...old.status().queue, active: false, phase: 'completed', reason: '' });
  await delay(25);
  const stable = await f.call('status');
  assert.equal(stable.revision, revision); assert.equal(f.events.length, eventCount);
  assert.deepEqual(stable.selection, selections[1]); assert.equal(stable.failure, null); assert.equal(stable.queue.active, true);
});

test('019 duplicate starts share one committed recovery and do not create a second child', async t => {
  const recovery = gate(), f = await fixture(t, { failFirstOpen: true, recoveryGate: recovery });
  const [first, second] = await Promise.all([f.start(), f.start()]);
  assert.deepEqual(first.selection, selections[0]); assert.deepEqual(second.selection, selections[0]);
  assert.equal(f.children.length, 1); assert.equal(f.queues.length, 1);
  assert.equal(first.queue.retrying, true); assert.equal(second.queue.retrying, true);
  await recovery.entered;
  const finishing = f.call('finish'); recovery.release(); await finishing;
  assert.equal(f.children[0].actions.includes('play'), false);
});

test('019 a temporarily unavailable selected list is actually read again after readiness recovers', async t => {
  const f = await fixture(t, { failFirstOpen: 'LIST_UNAVAILABLE', advanceMedia: true });
  const waiting = await f.start(); assert.equal(waiting.queue.retrying, true);
  const playing = await until(() => f.call('status'), state => state.queue?.phase === 'playing' && state.media?.paused === false && !state.queue.retrying);
  assert.equal(playing.failure, null); assert.equal(playing.queue.retrying, false);
  assert.ok(f.children[0].actions.filter(action => action === 'open').length >= 2);
  assert.equal(f.children.length, 1);
});

test('019 pause during a retry popup opening cancels it and explicit continue can reopen the selected video', async t => {
  const reopening = gate(), f = await fixture(t, { failFirstOpen: true, reopeningGate: reopening, advanceMedia: true });
  await f.start(); await reopening.entered;
  const paused = await f.call('action', 'pause');
  assert.equal(paused.queue.reason, 'USER_PAUSED'); assert.equal(f.children[0].player.isClosed(), true);
  reopening.release(); await f.queues[0].job;
  assert.equal(f.children[0].actions.includes('play'), false);
  const resumed = await f.call('action', 'continue');
  assert.equal(resumed.queue.active, true); assert.equal(resumed.media.paused, false);
  assert.deepEqual(resumed.selection, selections[0]);
});

test('019 first final completion write failure retains its real proof and continue retries only saving', async t => {
  const f = await fixture(t); await f.start();
  const child = f.children[0], originalSave = PersonalQueueStore.prototype.save;
  let available = false, attempts = 0;
  PersonalQueueStore.prototype.save = async function (record) {
    if (this.file === f.queueStore.file && record.phase === 'completed') {
      attempts++;
      if (!available) throw Object.assign(new Error('Synthetic first final completion write failure'), { code: 'EBUSY' });
    }
    return originalSave.call(this, record);
  };
  t.after(() => { PersonalQueueStore.prototype.save = originalSave; });
  // This is a fully observed synthetic ending, not a product completion write.
  child.ledger = new ObservationLedger({ ...freshLedger(child.target), duration: 100, position: 100, watchedPrefix: 100 });
  Object.assign(child.value, { currentTime: 100, ended: true, paused: true });
  child.selectCard = async () => { child.percent = 100; return { locator: () => ({ click: async () => {} }) }; };
  const pending = await until(() => f.call('status'), state => state.queue?.reason === 'QUEUE_SAVE_FAILED');
  assert.equal(pending.active, true); assert.equal(pending.completed, false); assert.equal(pending.completionPending, true);
  assert.equal(pending.queue.active, false); assert.equal(f.queues[0].completionConfirmed, false);
  assert.notEqual((await f.queueStore.read()).phase, 'completed');
  assert.equal(child.player.isClosed(), true);
  assert.equal(f.events.some(item => item.name === 'local-manual-video:closed' && item.state.completed), false);
  const playsBefore = child.actions.filter(action => action === 'play').length;
  available = true; const completed = await f.call('action', 'continue');
  assert.equal(completed.active, false); assert.equal(completed.completed, true); assert.equal(completed.completionPending, false);
  assert.equal(completed.queue.cursor, 1); assert.equal((await f.queueStore.read()).phase, 'completed');
  assert.equal(child.actions.filter(action => action === 'play').length, playsBefore); assert.equal(f.children.length, 1);
  assert.ok(attempts >= 2);
});
