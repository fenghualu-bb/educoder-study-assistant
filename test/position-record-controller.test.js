import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { SingleController, playbackFailure } from '../src/local-single-video/controller.mjs';
import { PositionStore } from '../src/local-single-video/position-store.mjs';

const weakTarget = Object.freeze({ classroomId: 'SyntheticController', title: '匿名历史观测', page: 1, index: 0 });
const strongTarget = Object.freeze({ ...weakTarget, cardIdentity: 'https://www.educoder.net/record-compat/controller-card' });
const oldPlayerIdentity = Object.freeze({ pathname: '/video_info', identifiers: { video_id: 'old', course_id: 'SyntheticController' } });

async function fixture(t, { selected = strongTarget, historical = weakTarget, loadError } = {}) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'educoder-record-controller-'));
  const positions = path.join(directory, 'positions');
  await fs.mkdir(positions);
  const store = new PositionStore({ directory: positions });
  const file = store.file(selected);
  const original = { version: 2, target: { ...historical }, revision: 4,
    observation: { version: 1, target: { ...historical }, watchedPrefix: 431.456789, position: 431.456789, duration: 654.32 },
    playerIdentity: structuredClone(oldPlayerIdentity) };
  const bytes = Buffer.from(JSON.stringify(original, null, 4) + '\r\n');
  await fs.writeFile(file, bytes, { flag: 'wx' });
  if (loadError) store.load = async () => { throw loadError; };
  let sessions = 0, nativeProcesses = 0;
  const controller = new SingleController({ dataDir: directory, appData: directory, target: selected,
    positionStore: store, connectExistingBridge: false,
    sessionProvider: async () => { sessions++; throw new Error('unexpected browser request'); },
    nativeProcessFactory: () => { nativeProcesses++; throw new Error('unexpected native process'); } });
  t.after(async () => {
    clearTimeout(controller.timer);
    try { await controller.dispose({ discardUnsavedPosition: true }); }
    finally {
      assert.equal(path.dirname(directory), path.resolve(os.tmpdir()));
      assert.ok(path.basename(directory).startsWith('educoder-record-controller-'));
      await fs.rm(directory, { recursive: true, force: true });
    }
  });
  await controller.init();
  clearTimeout(controller.timer);
  return { directory, positions, store, file, original, bytes, controller,
    get sessions() { return sessions; }, get nativeProcesses() { return nativeProcesses; } };
}

test('controller anchors its ledger to the historical card identity when the current scan lacks identity', async t => {
  const f = await fixture(t, { selected: weakTarget, historical: strongTarget });
  const { controller } = f;
  assert.equal(Boolean(controller.recordError), false);
  assert.deepEqual(controller.target, weakTarget);
  assert.deepEqual(controller.record.target, strongTarget);
  assert.deepEqual(controller.ledger.value.target, strongTarget);
  assert.equal(controller.ledger.value.watchedPrefix, 431.456789);
  assert.equal(controller.ledger.value.duration, 654.32);
  assert.deepEqual(controller.record.playerIdentity, oldPlayerIdentity);
  assert.deepEqual(await fs.readFile(f.file), f.bytes);

  controller.ledger.value.position = 400;
  await controller.persist();
  const saved = JSON.parse(await fs.readFile(f.file, 'utf8'));
  assert.deepEqual(saved.target, strongTarget);
  assert.deepEqual(saved.observation.target, strongTarget);
  assert.equal(saved.observation.position, 400);
  assert.equal(saved.observation.watchedPrefix, 431.456789);
  assert.equal(saved.observation.duration, 654.32);
  assert.deepEqual(saved.playerIdentity, oldPlayerIdentity);
  assert.equal(saved.revision, f.original.revision + 1);
  assert.equal(f.sessions, 0);
  assert.equal(f.nativeProcesses, 0);
});

for (const initialPaused of [true, false]) test('compatible metadata cannot bypass an existing player identity conflict or invoke playback and restore controls' + (initialPaused ? '' : ' even when the mismatched video autoplays'), async t => {
  const f = await fixture(t);
  const { controller } = f;
  assert.equal(Boolean(controller.recordError), false);
  assert.deepEqual(controller.ledger.value.target, strongTarget);
  assert.deepEqual(controller.record.playerIdentity, oldPlayerIdentity);
  assert.deepEqual(await fs.readFile(f.file), f.bytes);

  let popupClosed = 0, pageClosed = 0, bodyReads = 0, cardClicks = 0;
  let nativeCalls = 0, playingCalls = 0, optionCalls = 0, mediaReads = 0;
  const popup = { closed: false, isClosed: () => popup.closed,
    close: async () => { popup.closed = true; popupClosed++; },
    bringToFront: async () => {},
    url: () => 'https://www.educoder.net/video_info?video_id=new&course_id=SyntheticController',
    waitForFunction: async () => {},
    locator: selector => {
      if (selector === 'video') return { waitFor: async () => {} };
      if (selector === 'body') return { innerText: async () => { bodyReads++; return '暂无检查点'; } };
      throw new Error('unexpected popup selector: ' + selector);
    } };
  const page = { closed: false, isClosed: () => page.closed,
    close: async () => { page.closed = true; pageClosed++; },
    waitForEvent: async name => { assert.equal(name, 'popup'); return popup; } };
  controller.openOfficial = async () => { controller.page = page; };
  controller.selectCard = async () => ({ locator: selector => {
    assert.equal(selector, '[class*="imgWrap"]');
    return { click: async () => { cardClicks++; } };
  } });
  controller.readMedia = async () => { mediaReads++; return { currentTime: 0, duration: 654.32, paused: initialPaused,
    ended: false, playbackRate: 1, readyState: 4 }; };
  controller.native = async () => { nativeCalls++; throw new Error('unexpected native control'); };
  controller.setPlaying = async () => { playingCalls++; throw new Error('unexpected playing control'); };
  controller.applyPlaybackOptions = async () => { optionCalls++; };

  const opened = await controller.act('open');
  assert.equal(opened.actionError, 'PLAYER_CHANGED');
  assert.equal(opened.media, null);
  assert.equal(opened.stage, 'video-closed');
  assert.equal(controller.player, null);
  assert.equal(controller.ownedPlayer, null);
  assert.equal(controller.verifiedPlayer, false);
  assert.equal(popupClosed, 1);
  assert.equal(cardClicks, 1);
  assert.equal(bodyReads, 0);
  assert.equal(mediaReads, 0);
  assert.deepEqual(controller.record.playerIdentity, oldPlayerIdentity);
  assert.deepEqual(await fs.readFile(f.file), f.bytes);

  const restored = await controller.act('restore');
  assert.equal(restored.actionError, 'PAUSE_FIRST');
  const played = await controller.act('play');
  assert.equal(played.actionError, 'OPEN_FIRST');
  assert.equal(nativeCalls, 0);
  assert.equal(playingCalls, 0);
  assert.equal(optionCalls, 0);
  assert.equal(f.sessions, 0);
  assert.equal(f.nativeProcesses, 0);
  assert.deepEqual(await fs.readFile(f.file), f.bytes);
  assert.deepEqual(await fs.readdir(f.positions), [path.basename(f.file)]);
  await controller.dispose({ discardUnsavedPosition: true });
  assert.equal(popupClosed, 1);
  assert.equal(pageClosed, 1);
});

test('controller preserves a position read EACCES message and code without opening a session or altering records', async t => {
  const error = Object.assign(new Error('synthetic EACCES'), { code: 'EACCES' });
  const f = await fixture(t, { historical: strongTarget, loadError: error });
  const { controller } = f;
  const expectedFailure = playbackFailure(error);
  assert.equal(controller.recordError, true);
  assert.equal(controller.recordErrorCode, 'EACCES');
  const initial = controller.status();
  assert.equal(initial.message, expectedFailure.message);
  assert.equal(initial.playBlockedReason, 'EACCES');
  assert.equal(initial.playAllowed, false);
  assert.equal(initial.restoreAvailable, false);
  assert.equal(initial.actionsAvailable, false);
  const opened = await controller.act('open');
  assert.equal(opened.actionError, 'EACCES');
  assert.equal(opened.message, expectedFailure.message);
  const restored = await controller.act('restore');
  assert.equal(restored.actionError, 'EACCES');
  assert.equal(restored.message, expectedFailure.message);
  assert.equal(f.sessions, 0);
  assert.equal(f.nativeProcesses, 0);
  assert.equal(controller.player, null);
  assert.deepEqual(await fs.readFile(f.file), f.bytes);
  assert.deepEqual(await fs.readdir(f.positions), [path.basename(f.file)]);
});
