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

test('019 temporarily missing real duration breaks continuity without changing saved evidence', async t => {
  const { controller, state, store } = await fixture(t), original = await fs.readFile(store.file(target));
  controller.ledger.previous = { ...state, paused: false, currentTime: 4, wallMs: Date.now() - 500 };
  state.duration = Number.NaN; state.readyState = 0;
  await assert.rejects(controller.sample(), /MEDIA_NOT_READY/); assert.equal(controller.ledger.previous, null);
  state.duration = 100; state.readyState = 4; state.currentTime = 4.5; state.paused = false;
  await controller.sample(); assert.equal(controller.ledger.value.position, 5); assert.deepEqual(await fs.readFile(store.file(target)), original);
});

test('019 a canceled late media sample cannot replace the current paused state or observed record', async t => {
  const { controller, state, store } = await fixture(t), original = await fs.readFile(store.file(target));
  let release; const read = new Promise(done => { release = done; }); let entered;
  const pending = new Promise(done => { entered = done; }); controller.readMedia = async () => { entered(); return read; };
  const sampling = controller.sample(); await pending; controller.requestStop();
  const paused = { ...state, currentTime: 0, paused: true }; controller.media = paused;
  release({ ...state, currentTime: 4.5, paused: false });
  await assert.rejects(sampling, /CLOSING/); assert.equal(controller.media, paused); assert.equal(controller.verifiedPlayer, true);
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
