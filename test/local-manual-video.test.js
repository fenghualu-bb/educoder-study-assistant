import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { pathToFileURL } from 'node:url';
import { PositionStore } from '../src/local-single-video/position-store.mjs';
import { ObservationLedger, freshLedger } from '../src/local-single-video/ledger.mjs';
import { LEGACY_TARGET, targetKey, playerIdentity, resolveScannedSelection, verifyPageSelection } from '../src/local-single-video/target.mjs';
import { SingleController } from '../src/local-single-video/controller.mjs';
import { registerManualVideoDesktop } from '../src/local-manual-video.js';
import { createController } from '../src/controller.js';
import { RunError } from '../src/run-error.js';

const directories = [];
async function temporary() { const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'educoder-manual-test-')); directories.push(dir); return dir; }
after(async () => { for (const dir of directories) { assert.equal(path.dirname(dir).toLowerCase(), os.tmpdir().toLowerCase()); await fs.rm(dir, { recursive: true, force: true }); } });
const targetA = { classroomId: 'SyntheticA', title: '模拟视频一', page: 1, index: 0 };
const targetB = { ...targetA, title: '模拟视频二', index: 1 };
const url = id => `https://www.educoder.net/classrooms/${id}/video`;
const snapshot = (id = 'SyntheticA') => ({ courseUrl: url(id), courseTitle: '模拟课堂', complete: true,
  items: [{ title: targetA.title, page: 1, index: 0, progress: 20 }, { title: targetB.title, page: 1, index: 1, progress: 0 }] });
const request = target => ({ courseUrl: url(target.classroomId), title: target.title, page: target.page, index: target.index });
const media = (currentTime, paused = false) => ({ currentTime, duration: 100, playbackRate: 1, paused, ended: false });
function observed(target, at = 5) { const ledger = new ObservationLedger(freshLedger(target)); ledger.observe(media(0), 1000); ledger.observe(media(at), 1000 + at * 1000); return ledger; }

test('a selection comes only from the matching scanned classroom and exact card; changed or injected targets are refused', () => {
  const selected = resolveScannedSelection(snapshot(), request(targetB));
  assert.equal(selected.index, 1); assert.equal(selected.pageLayout.length, 2);
  for (const bad of [{ ...request(targetB), title: '另一视频' }, { ...request(targetB), page: 2 },
    request({ ...targetB, classroomId: 'OtherClass' }), { ...request(targetB), paid: true }]) assert.throws(() => resolveScannedSelection(snapshot(), bad));
  const duplicate = snapshot(); duplicate.items.push({ ...duplicate.items[1] });
  assert.throws(() => resolveScannedSelection(duplicate, request(targetB)));
});

test('the opened page must match page number, selected title, thumbnail identity and scanned layout', () => {
  const target = { ...targetA, page: 2, cardIdentity: 'https://www.educoder.net/images/a.jpg' };
  const cards = [{ title: target.title, index: 0, cardIdentity: target.cardIdentity, progress: 30 }];
  assert.equal(verifyPageSelection(target, 2, cards, cards).progress, 30);
  assert.throws(() => verifyPageSelection(target, 1, cards, cards));
  assert.throws(() => verifyPageSelection(target, 2, [{ ...cards[0], cardIdentity: 'https://www.educoder.net/images/b.jpg' }], cards));
  assert.throws(() => verifyPageSelection(target, 2, [...cards, { index: 1, title: '新增卡片' }], cards));
  assert.throws(() => playerIdentity('https://example.test/video_info?video_id=1', target));
  assert.throws(() => playerIdentity(url('WrongClass'), target));
  assert.deepEqual(playerIdentity('https://www.educoder.net/video_info?video_id=1&course_id=123&access_token=synthetic', target), {
    pathname: '/video_info', identifiers: { video_id: '1', course_id: '123' } });
});

test('different videos and classrooms persist independent observed positions and survive reloading', async () => {
  const directory = await temporary(); const store = new PositionStore({ directory });
  const anotherClass = { ...targetA, classroomId: 'SyntheticB' };
  const a = await store.load(targetA), b = await store.load(targetB), c = await store.load(anotherClass);
  await store.save(a, observed(targetA).value, null);
  await store.save(b, observed(targetB, 3).value, null);
  const reopened = new PositionStore({ directory });
  assert.equal((await reopened.load(targetA)).observation.position, 5);
  assert.equal((await reopened.load(targetB)).observation.position, 3);
  assert.equal((await reopened.load(anotherClass)).observation.position, 0);
  assert.equal(c.observation.position, 0); assert.notEqual(targetKey(targetA), targetKey(anotherClass));
});

test('legacy 9串1 imports current observed data only once, preserving both its file and newer manual records', async () => {
  const directory = await temporary(), legacyFile = path.join(directory, 'legacy.json');
  const legacy = { ...freshLedger(), position: 40, watchedPrefix: 60, duration: 100 };
  const bytes = JSON.stringify(legacy); await fs.writeFile(legacyFile, bytes);
  const store = new PositionStore({ directory: path.join(directory, 'positions'), legacyFile });
  const record = await store.load(LEGACY_TARGET); assert.equal(record.observation.position, 40);
  await store.save(record, { ...record.observation, position: 55 }, null);
  await fs.writeFile(legacyFile, JSON.stringify({ ...legacy, position: 45 }));
  assert.equal((await store.load(LEGACY_TARGET)).observation.position, 55);
  assert.equal((await store.load(targetA)).observation.position, 0);
  assert.equal(JSON.parse(await fs.readFile(legacyFile, 'utf8')).position, 45);
});

test('legacy migration reads the exact selected target from a validated record without a fixed classroom', async () => {
  const directory = await temporary(), legacyFile = path.join(directory, 'legacy.json');
  const target = { classroomId: 'SyntheticLegacyPrivate', title: '曾经所选的视频', page: 3, index: 2 };
  const value = { ...freshLedger(target), position: 12, watchedPrefix: 12, duration: 100 };
  await fs.writeFile(legacyFile, JSON.stringify(value));
  const store = new PositionStore({ directory: path.join(directory, 'positions'), legacyFile });
  assert.equal((await store.load(target)).observation.position, 12);
  assert.equal((await store.load({ ...target, classroomId: 'SyntheticOther' })).observation.position, 0);
  assert.equal(JSON.parse(await fs.readFile(legacyFile, 'utf8')).position, 12);
});

test('standalone legacy target discovery validates its local record and a missing record creates nothing', async () => {
  const { readLegacyPositionTarget } = await import('../src/local-single-video/position-store.mjs');
  assert.equal(typeof readLegacyPositionTarget, 'function');
  const directory = await temporary(), file = path.join(directory, 'legacy.json');
  await assert.rejects(readLegacyPositionTarget(file), /LEGACY_RECORD_MISSING/);
  assert.deepEqual(await fs.readdir(directory), []);
  const target = { classroomId: 'SyntheticLegacySelected', title: '明确选中的旧视频', page: 2, index: 4 };
  await fs.writeFile(file, JSON.stringify({ ...freshLedger(target), watchedPrefix: 8, position: 8, duration: 100 }));
  assert.deepEqual(await readLegacyPositionTarget(file), target);
  await fs.writeFile(file, JSON.stringify({ ...freshLedger(target), watchedPrefix: 0, position: 90, duration: 100 }));
  await assert.rejects(readLegacyPositionTarget(file), /LEGACY_RECORD_INVALID/);
  assert.equal(JSON.parse(await fs.readFile(file, 'utf8')).position, 90);
});

test('concurrent stale saves and malformed or mismatched records preserve the existing position', async () => {
  const directory = await temporary(); const one = new PositionStore({ directory }), two = new PositionStore({ directory });
  const a = await one.load(targetA), b = await two.load(targetA);
  const results = await Promise.allSettled([one.save(a, observed(targetA).value, null), two.save(b, observed(targetA, 3).value, null)]);
  assert.equal(results.filter(result => result.status === 'fulfilled').length, 1);
  assert.equal(results.find(result => result.status === 'rejected').reason.message, 'RECORD_CHANGED');
  const file = one.file(targetB), corrupt = '{broken'; await fs.writeFile(file, corrupt);
  await assert.rejects(one.load(targetB), /RECORD_INVALID/); assert.equal(await fs.readFile(file, 'utf8'), corrupt);
});

test('normal observed segments after a manual seek can resume, without crediting the skipped gap or a percentage', () => {
  const ledger = new ObservationLedger(freshLedger(targetA));
  ledger.observe(media(50), 1000); ledger.observe(media(51), 2000);
  assert.equal(ledger.value.watchedPrefix, 0); assert.deepEqual(ledger.value.watchedRanges, [[50, 51]]);
  assert.equal(ledger.restorePosition(), 51);
  ledger.capture(media(40, true)); assert.equal(ledger.value.position, 51);
  ledger.observe(media(90), 3000); assert.equal(ledger.value.position, 51);
  ledger.observe({ ...media(91), playbackRate: 2 }, 4000); assert.equal(ledger.value.position, 51);
});

function fakePlayer(id = '1') {
  const player = { value: { ...media(0, true), readyState: 4, muted: false, volume: 0.35 }, closed: false, clicks: 0, currentUrl: `https://www.educoder.net/video_info?video_id=${id}&course_id=123`,
    url() { return this.currentUrl; }, isClosed() { return this.closed; }, async close() { this.closed = true; }, async bringToFront() {}, async waitForFunction() {} };
  player.locator = selector => selector === 'body' ? { innerText: async () => '暂无检查点' }
    : { waitFor: async () => {}, evaluate: async () => ({ ...player.value }), boundingBox: async () => ({ x: 0, y: 0, width: 800, height: 500 }) };
  player.mouse = { move: async () => {}, click: async () => { player.clicks++; player.value.paused = !player.value.paused; } };
  return player;
}
async function manualController(directory, target, { changedPlayerId = false, playbackStore, controlsFactory } = {}) {
  let next = fakePlayer(changedPlayerId ? 'wrong' : '1');
  const list = { closed: false, url: () => url(target.classroomId), isClosed: () => list.closed,
    close: async () => { list.closed = true; }, goto: async () => {}, bringToFront: async () => {}, waitForEvent: async () => next };
  const context = { closed: false, newPage: async () => list, close: async () => { context.closed = true; } };
  const store = new PositionStore({ directory: path.join(directory, 'positions') });
  const controller = new SingleController({ dataDir: directory, appData: directory, target, positionStore: store,
    sessionProvider: async () => ({ context }), nativeScript: 'never-used', connectExistingBridge: false,
    playbackStore, controlsFactory: player => ({
      setPlaying: async playing => { player.clicks++;player.value.paused=!playing;if(playing)player.value.currentTime+=.05; },
      ...(controlsFactory?.(player)??{}),
    }) });
  controller.selectCard = async () => ({ locator: () => ({ click: async () => {} }) });
  controller.native = async (action, _pid, seconds) => { assert.equal(action, 'restore'); next.value.currentTime = seconds; next.value.paused = true; };
  await controller.init();
  return { controller, context, list, player: () => next, renew: () => { next = fakePlayer('1'); } };
}

test('manual controller opens paused, stores only observed position and requires user restore after closing and reopening', async () => {
  const directory = await temporary(); const first = await manualController(directory, targetA);
  try {
    assert.equal(first.controller.status().resumeSeconds, 0); assert.equal(first.controller.context, null);
    await first.controller.act('open'); assert.equal(first.player().clicks, 0); assert.equal(first.controller.status().stage, 'paused');
    await first.controller.act('play'); assert.equal(first.player().value.paused, false);
    first.controller.ledger.observe(media(0), 1000); first.controller.ledger.observe(media(5), 6000); first.player().value.currentTime = 5;
    await first.controller.act('pause'); await first.controller.act('close-video');
    assert.equal(first.controller.status().resumeSeconds, 5); assert.equal(first.context.closed, false);
  } finally { await first.controller.dispose(); }
  assert.equal(first.context.closed, false, 'closing a manual viewer must keep the main official session');
  const reopened = await manualController(directory, targetA);
  try {
    assert.equal(reopened.controller.status().resumeSeconds, 5); assert.equal(reopened.controller.context, null);
    await reopened.controller.act('open'); assert.equal(reopened.player().value.currentTime, 0); assert.equal(reopened.player().clicks, 0);
    await reopened.controller.act('restore'); assert.equal(reopened.player().value.currentTime, 5); assert.equal(reopened.player().value.paused, true);
  } finally { await reopened.controller.dispose(); }
});

test('a different official player cannot reuse a saved video position or receive a play click', async () => {
  const directory = await temporary(); const first = await manualController(directory, targetA);
  await first.controller.act('open'); await first.controller.dispose();
  const changed = await manualController(directory, targetA, { changedPlayerId: true });
  try {
    await changed.controller.act('open'); assert.equal(changed.player().closed, true); assert.equal(changed.player().clicks, 0);
    assert.equal(changed.controller.status().playAllowed, false);
    const previous = changed.controller.ledger.value.position;
    await changed.controller.act('play'); assert.equal(changed.controller.ledger.value.position, previous);
  } finally { await changed.controller.dispose(); }
});

test('a failed position save cannot be swallowed by finish or replace a newer disk record', async () => {
  const directory = await temporary(), f = await manualController(directory, targetA);
  await f.controller.act('open'); await f.controller.act('play');
  f.controller.ledger.observe(media(0), 1000); f.controller.ledger.observe(media(5), 6000); f.player().value.currentTime = 5;
  const other = new PositionStore({ directory: path.join(directory, 'positions') }), latest = await other.load(targetA);
  await other.save(latest, observed(targetA, 9).value, latest.playerIdentity);
  const before = await fs.readFile(other.file(targetA));
  assert.equal((await f.controller.act('pause')).actionError, 'RECORD_CHANGED');
  await assert.rejects(f.controller.dispose(), /RECORD_CHANGED/);
  assert.equal(f.player().closed, true);
  assert.deepEqual(await fs.readFile(other.file(targetA)), before);
});

test('closing only the main official tab creates a new tab on request without closing the shared browser', async () => {
  const context = new EventEmitter(); let closes = 0, created = 0, visited;
  context.close = async () => { closes++; };
  context.newPage = async () => { created++; return { goto: async destination => { visited = destination; }, bringToFront: async () => {} }; };
  const controller = createController({ makeCourse: () => ({}), launch: async () => ({ context, page: { isClosed: () => true } }) });
  await controller.openBrowser(); await controller.openBrowser();
  assert.equal(created, 1); assert.equal(closes, 0); assert.equal(visited, 'https://www.educoder.net/classrooms');
  await controller.shutdown();
});

test('manual login and network failures give distinct recovery advice while preserving the saved position', async () => {
  const directory = await temporary(); const fake = await manualController(directory, targetA);
  fake.controller.ledger = observed(targetA); await fake.controller.persist();
  try {
    for (const [code, text] of [['LOGIN_REQUIRED', /登录/], ['PAGE_LOAD_FAILED', /网络/]]) {
      fake.controller.selectCard = async () => { throw new RunError(code, 'synthetic page failure'); };
      await fake.controller.act('open'); assert.match(fake.controller.status().message, text);
      assert.equal(fake.controller.status().resumeSeconds, 5); assert.equal(fake.player().clicks, 0);
      assert.equal(fake.controller.status().playAllowed, false);
    }
  } finally { await fake.controller.dispose(); }
});

test('manual viewer reacquires a replacement official session without auto play or restore', async () => {
  const directory = await temporary(); const fake = await manualController(directory, targetA);
  try {
    await fake.controller.act('official'); fake.list.closed = true;
    const newPage = { goto: async () => {}, isClosed: () => false, close: async () => {}, bringToFront: async () => {} };
    const replacement = { newPage: async () => newPage };
    fake.controller.sessionProvider = async () => ({ context: replacement });
    await fake.controller.act('official'); assert.equal(fake.controller.context, replacement);
    assert.equal(fake.controller.status().stage, 'official-open'); assert.equal(fake.controller.media, null);
    assert.equal(fake.player().clicks, 0); assert.equal(fake.controller.status().restoreAvailable, false);
  } finally { await fake.controller.dispose(); }
});

test('a media load error blocks a new play click and keeps the real observed record', async () => {
  const directory = await temporary(); const fake = await manualController(directory, targetA);
  try {
    await fake.controller.act('open'); fake.player().value.mediaErrorCode = 3;
    await fake.controller.act('play'); assert.equal(fake.player().clicks, 0);
    assert.equal(fake.controller.status().playAllowed, false); assert.equal(fake.controller.status().actionError, 'MEDIA_DECODE_ERROR');
    assert.match(fake.controller.status().message, /未成功解码/);
  } finally { await fake.controller.dispose(); }
});

test('desktop accepts only a trusted heatmap selection and refuses switching until viewing is finished', async () => {
  const directory = await temporary(); const handlers = new Map(), windows = []; let created = 0, snapshotValue = snapshot(), current;
  class Window extends EventEmitter {
    constructor() { super(); windows.push(this); this.webContents = new EventEmitter(); this.webContents.mainFrame = { url: '' }; this.webContents.setWindowOpenHandler = () => {}; }
    setMenuBarVisibility() {} restore() {} show() {} focus() {} destroy() { this.emit('closed'); }
    async loadFile(file) { this.webContents.mainFrame.url = pathToFileURL(file).href; }
    close() { this.emit('close', { preventDefault() {} }); }
  }
  const main = new Window(), frame = { url: 'http://127.0.0.1:51001/' };
  main.webContents.mainFrame = frame; main.webContents.getURL = () => frame.url;
  const runtime = { origin: 'http://127.0.0.1:51001', controller: { getStatus: () => ({ phase: 'idle' }), getInventory: () => snapshotValue } };
  const manager = registerManualVideoDesktop({ app: { getPath: () => directory, getVersion: () => '0.1.6', isPackaged: false },
    ipcMain: { handle: (name, fn) => handlers.set(name, fn), removeHandler: name => handlers.delete(name) },
    BrowserWindow: Window, window: main, getRuntime: () => runtime,
    controllerFactory: () => { created++; current = { busy: false, init: async () => {}, dispose: async () => {}, status: () => ({ media: current.media }) }; return current; } });
  const event = { sender: main.webContents, senderFrame: frame }, open = handlers.get('local-manual-video:open');
  await assert.rejects(open({ ...event, sender: {} }, request(targetA)));
  await assert.rejects(handlers.get('appearance:set')({ ...event, sender: {} }, 'dark'));
  await assert.rejects(handlers.get('appearance:set')(event, 'invalid'), /APPEARANCE_INVALID/);
  await handlers.get('appearance:set')(event, 'dark'); assert.equal(await handlers.get('appearance:get')(event), 'dark');
  await assert.rejects(open(event, { ...request(targetA), title: '注入视频' })); assert.equal(created, 0);
  await open(event, request(targetA)); assert.equal(created, 1);
  await open(event, request(targetA)); assert.equal(created, 1);
  current.media = media(4, true); await assert.rejects(open(event, request(targetB)), /请先/);
  current.media = null; await assert.rejects(open(event, request(targetB)), /结束观看/);
  const finish = () => { const v = windows.at(-1); return handlers.get('single:finish')({ sender: v.webContents, senderFrame: v.webContents.mainFrame }); };
  await finish(); await open(event, request(targetB)); assert.equal(created, 2);
  await finish(); snapshotValue = snapshot('SyntheticB'); await open(event, request({ ...targetA, classroomId: 'SyntheticB' })); assert.equal(created, 3);
  await manager.close();
});
