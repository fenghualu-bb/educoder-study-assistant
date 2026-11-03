import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { SingleController } from '../src/local-single-video/controller.mjs';
import { PositionStore } from '../src/local-single-video/position-store.mjs';
import { ObservationLedger, freshLedger } from '../src/local-single-video/ledger.mjs';

const target = { classroomId: 'SyntheticRecovery019', title: 'Synthetic selected video', page: 1, index: 0 };
const url = 'https://www.educoder.net/video_info?video_id=synthetic019&course_id=SyntheticRecovery019';
const saved = () => ({ ...freshLedger(target), duration: 100, watchedPrefix: 5, position: 5, watchedRanges: [[0, 5]] });
const media = () => ({ currentTime: 0, duration: 100, paused: true, ended: false, playbackRate: 1, readyState: 4, mediaErrorCode: null });
function player(state, body = '暂无检查点') {
  const page = new EventEmitter(); page.closed = false; page.address = url;
  page.isClosed = () => page.closed; page.url = () => page.address;
  page.close = async () => { page.closed = true; }; page.bringToFront = async () => {};
  page.locator = selector => selector === 'body' ? { innerText: async () => body } : { count: async () => 1, evaluate: async () => ({ ...state }) };
  return page;
}
async function fixture(t) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'educoder-recovery019-'));
  const store = new PositionStore({ directory: path.join(directory, 'positions') });
  const controller = new SingleController({ dataDir: directory, appData: directory, target, positionStore: store,
    connectExistingBridge: false, sessionProvider: async () => { throw new Error('unexpected browser'); } });
  await controller.init(); clearTimeout(controller.timer);
  controller.ledger = new ObservationLedger(saved()); await controller.persist();
  const state = media(); controller.player = controller.ownedPlayer = player(state);
  controller.boundPlayerUrl = url; controller.verifiedPlayer = true; controller.verifiedDuration = 100; controller.media = { ...state };
  controller.context = { pages: () => [controller.player] };
  t.after(async () => { await controller.dispose().catch(() => {}); await fs.rm(directory, { recursive: true, force: true }); });
  return { controller, state, store };
}

for (const code of ['OFFICIAL_PROGRESS_CONTROL_UNAVAILABLE', 'OFFICIAL_CONTROLS_UNAVAILABLE', 'RESTORE_REFUSED'])
  test(`019 prepare allows normal official play after ${code}, preserving earlier observations`, async t => {
    const { controller, state, store } = await fixture(t), original = await fs.readFile(store.file(target));
    const calls = []; controller.native = async () => { calls.push('restore'); throw new Error(code); };
    controller.controlsFactory = () => ({ setPlaying: async playing => { calls.push(playing ? 'play' : 'pause'); state.paused = !playing; if (playing) state.currentTime = .1; } });
    const prepared = await controller.prepareQueuePlayback({ fromSaved: true });
    assert.equal(prepared.actionError, null); assert.equal(prepared.restoreSkipped, true); assert.match(prepared.restoreHint, /原保存位置保留/);
    assert.deepEqual(await fs.readFile(store.file(target)), original); assert.equal(controller.touched, false);
    const playing = await controller.act('play'); assert.equal(playing.actionError, null); assert.equal(playing.media.paused, false);
    assert.deepEqual(calls, ['restore', 'play']); assert.equal(playing.resumeSeconds, 5); assert.equal(playing.restoreSkipped, true);
  });

for (const code of ['OFFICIAL_PROGRESS_CONTROL_AMBIGUOUS', 'PLAYER_CHANGED', 'RECORD_CHANGED', 'QUEUE_STOPPED'])
  test(`019 prepare keeps ${code} terminal and never falls back to play`, async t => {
    const { controller, store } = await fixture(t), original = await fs.readFile(store.file(target)); let clicks = 0;
    controller.native = async () => { throw new Error(code); }; controller.controlsFactory = () => ({ setPlaying: async () => { clicks++; } });
    await assert.rejects(controller.prepareQueuePlayback({ fromSaved: true }), new RegExp(code));
    assert.equal(clicks, 0); assert.equal(controller.restoreSkipped, false); assert.deepEqual(await fs.readFile(store.file(target)), original);
  });

test('019 an explicitly requested beginning failure cannot degrade to playback from another position', async t => {
  const { controller, state } = await fixture(t); state.currentTime = 3;
  controller.native = async () => { throw new Error('RESTORE_REFUSED'); };
  await assert.rejects(controller.prepareQueuePlayback({ fromBeginning: true }), /RESTORE_REFUSED/);
  assert.equal(controller.restoreSkipped, false); assert.equal(state.paused, true); assert.equal(state.currentTime, 3);
});

test('019 temporarily missing real duration breaks continuity without changing saved evidence', async t => {
  const { controller, state, store } = await fixture(t), original = await fs.readFile(store.file(target));
  controller.ledger.previous = { ...state, paused: false, currentTime: 4, wallMs: Date.now() - 500 };
  state.duration = Number.NaN; state.readyState = 0;
  await assert.rejects(controller.sample(), /MEDIA_NOT_READY/); assert.equal(controller.ledger.previous, null);
  state.duration = 100; state.readyState = 4; state.currentTime = 4.5; state.paused = false;
  await controller.sample(); assert.equal(controller.ledger.value.position, 5); assert.deepEqual(await fs.readFile(store.file(target)), original);
});

test('019 owned homepage reset reselects exactly the existing target using fresh player state', async t => {
  const { controller, store } = await fixture(t), old = controller.player, original = await fs.readFile(store.file(target));
  old.address = 'https://www.educoder.net/'; controller.playerControls = { obsolete: true };
  controller.page = { isClosed: () => false, close: async () => assert.fail('list must remain open during recovery') };
  await assert.rejects(controller.sample(), /PAGE_RESET/);
  await assert.rejects(controller.sample(), /PAGE_RESET/); let opens = 0;
  const fresh = media();
  controller.openVideo = async () => { opens++; controller.player = controller.ownedPlayer = player(fresh); controller.boundPlayerUrl = url; controller.verifiedPlayer = true; controller.verifiedDuration = 100; controller.media = { ...fresh }; controller.stage = 'paused'; };
  controller.native = async (_action, _pid, seconds) => { fresh.currentTime = seconds; return { restoredSeconds: seconds }; };
  const result = await controller.recoverQueuePlayback(new Error('PAGE_RESET'));
  assert.equal(opens, 1); assert.equal(old.closed, true); assert.equal(result.media.currentTime, 5); assert.equal(result.media.paused, true);
  assert.equal(controller.playerControls, null); assert.equal(controller.ledger.previous, null);
  assert.deepEqual(await fs.readFile(store.file(target)), original);
  controller.page = null;
});

for (const [address, body, code] of [
  ['https://www.educoder.net/login', '请先登录', 'QUEUE_LOGIN_REQUIRED'],
  ['https://www.educoder.net/', '请完成身份核验', 'QUEUE_VERIFICATION'],
  ['https://www.educoder.net/', '无观看权限', 'QUEUE_PLATFORM_BLOCKED'],
  ['https://www.educoder.net/video_info?video_id=other019', '暂无检查点', 'PLAYER_CHANGED'],
]) test(`019 recovery refuses ${code} before closing or opening any page`, async t => {
  const { controller, state } = await fixture(t); controller.player = controller.ownedPlayer = player(state, body); controller.player.address = address;
  let opens = 0; controller.openVideo = async () => { opens++; };
  await assert.rejects(controller.recoverQueuePlayback(new Error('PAGE_RESET')), new RegExp(code));
  assert.equal(controller.player.closed, false); assert.equal(opens, 0);
});

test('019 a manually closed official window never reopens through recovery', async t => {
  const { controller } = await fixture(t); controller.player.closed = true; let opens = 0;
  controller.openVideo = async () => { opens++; };
  await assert.rejects(controller.recoverQueuePlayback(new Error('MEDIA_NOT_READY')), /OFFICIAL_WINDOW_CLOSED/); assert.equal(opens, 0);
});

test('019 an explicit user start can reopen an already closed owned selected player', async t => {
  const { controller, state } = await fixture(t); controller.player.closed = true; controller.media = null; let opens = 0;
  controller.openVideo = async () => { opens++; controller.player = controller.ownedPlayer = player(state); controller.boundPlayerUrl = url; controller.verifiedPlayer = true; controller.media = { ...state }; };
  const result = await controller.prepareQueuePlayback({ reopenClosedPlayer: true });
  assert.equal(opens, 1); assert.equal(result.media.paused, true); assert.equal(result.actionError, null);
});

test('019 an explicit user start cannot re-adopt a closed player that this controller does not own', async t => {
  const { controller } = await fixture(t); controller.player.closed = true; controller.ownedPlayer = null;
  controller.openVideo = async () => assert.fail('unowned player must not reopen');
  await assert.rejects(controller.prepareQueuePlayback({ reopenClosedPlayer: true }), /OFFICIAL_WINDOW_CLOSED/);
});

test('019 a temporarily unavailable initial list is actually re-read before normal playback', async t => {
  const { controller, state } = await fixture(t); controller.player = controller.ownedPlayer = null; controller.media = null;
  let reads = 0; controller.openVideo = async () => { reads++; controller.player = controller.ownedPlayer = player(state); controller.boundPlayerUrl = url; controller.verifiedPlayer = true; controller.media = { ...state }; };
  controller.native = async (_action, _pid, seconds) => { state.currentTime = seconds; return { restoredSeconds: seconds }; };
  const result = await controller.recoverQueuePlayback(new Error('LIST_UNAVAILABLE'));
  assert.equal(reads, 1); assert.equal(result.media.currentTime, 5); assert.equal(result.media.paused, true);
});

test('019 an expired progress control rechecks the explicit preparation intent before any play', async t => {
  const { controller, state } = await fixture(t); state.currentTime = 3; controller.queuePreparation = { fromBeginning: true, fromSaved: false };
  controller.native = async () => { throw new Error('RESTORE_REFUSED'); };
  await assert.rejects(controller.recoverQueuePlayback(new Error('OFFICIAL_PROGRESS_CONTROL_UNAVAILABLE')), /RESTORE_REFUSED/);
  assert.equal(controller.restoreSkipped, false); assert.equal(state.currentTime, 3); assert.equal(state.paused, true);
});

test('019 cancellation while owned reset closes prevents a late reselect or play', async t => {
  const { controller } = await fixture(t); let release; const closing = new Promise(done => { release = done; });
  let entered; const starting = new Promise(done => { entered = done; }); let opens = 0;
  controller.player.address = 'https://www.educoder.net/'; const old = controller.player;
  old.close = async () => { entered(); await closing; old.closed = true; }; controller.openVideo = async () => { opens++; };
  const recovery = controller.recoverQueuePlayback(new Error('PAGE_RESET'));
  await starting; controller.requestStop(); release(); await assert.rejects(recovery, /QUEUE_STOPPED/); assert.equal(opens, 0);
});

test('019 a canceled late media sample cannot replace the current paused state or observed record', async t => {
  const { controller, state, store } = await fixture(t), original = await fs.readFile(store.file(target));
  let release; const read = new Promise(done => { release = done; }); let entered;
  const pending = new Promise(done => { entered = done; }); controller.readMedia = async () => { entered(); return read; };
  const abort = new AbortController(); controller.operationSignal = abort.signal;
  const sampling = controller.sample(); await pending; abort.abort();
  const paused = { ...state, currentTime: 0, paused: true }; controller.media = paused;
  release({ ...state, currentTime: 4.5, paused: false });
  await assert.rejects(sampling, /QUEUE_STOPPED/); assert.equal(controller.media, paused); assert.equal(controller.verifiedPlayer, true);
  assert.deepEqual(await fs.readFile(store.file(target)), original); controller.readMedia = async () => paused;
});

test('019 media code4 is recoverable only with fresh owned media-network failure evidence', async t => {
  const { controller, state } = await fixture(t); controller.watchPlayerNetwork(controller.player); state.mediaErrorCode = 4;
  await assert.rejects(controller.sample(), /MEDIA_UNSUPPORTED/);
  controller.player.emit('requestfailed', { resourceType: () => 'media', failure: () => ({ errorText: 'net::ERR_INTERNET_DISCONNECTED' }) });
  await assert.rejects(controller.sample(), /MEDIA_NETWORK_ERROR/);
  const old = controller.player; controller.player = controller.ownedPlayer = player(state); controller.watchPlayerNetwork(controller.player);
  old.emit('requestfailed', { resourceType: () => 'media', failure: () => ({ errorText: 'net::ERR_INTERNET_DISCONNECTED' }) });
  await assert.rejects(controller.sample(), /MEDIA_UNSUPPORTED/);
});

test('019 natural intermediate disposal keeps and hands over the owned official list tab', async t => {
  const { controller } = await fixture(t); let listClosed = 0, created = 0;
  const list = { closed: false, isClosed: () => list.closed, close: async () => { list.closed = true; listClosed++; }, bringToFront: async () => {} };
  controller.page = list; const context = controller.context = { pages: () => [list], newPage: async () => { created++; throw new Error('unneeded page'); } };
  await controller.dispose({ preserveOfficialSession: true }); assert.equal(listClosed, 0); assert.equal(controller.page, null);
  const next = new SingleController({ dataDir: os.tmpdir(), appData: os.tmpdir(), target, connectExistingBridge: false, sessionProvider: async () => ({ context }) });
  await next.openOfficial(); assert.equal(next.page, list); assert.equal(created, 0);
  await next.dispose(); assert.equal(listClosed, 1);
});
