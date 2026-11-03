import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

// Draft location uses EDUCODER_RETRY_TEST_ROOT. After copying into test/, the
// default is the ordinary project directory; no browser or network is needed.
const root = process.env.EDUCODER_RETRY_TEST_ROOT ?? fileURLToPath(new URL('../', import.meta.url));
const { PersonalQueueStore, resolvePersonalQueue } = await import(pathToFileURL(path.join(root, 'src/personal-queue-store.mjs')).href);
const { PersonalQueueController } = await import(pathToFileURL(path.join(root, 'src/personal-queue-controller.mjs')).href);
const courseUrl = 'https://www.educoder.net/classrooms/SyntheticRetryOnly/video';
const snapshot = { courseUrl, courseTitle: 'Synthetic retry classroom', complete: true, items: [
  { page: 1, index: 0, title: 'Synthetic retry A', progress: 0 },
  { page: 1, index: 1, title: 'Synthetic retry B', progress: 0 }
] };
const selections = snapshot.items.map(({ page, index, title }) => ({ courseUrl, page, index, title }));
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(read, accepts, timeout = 5000) {
  const deadline = Date.now() + timeout;
  let last;
  while (Date.now() < deadline) {
    last = await read();
    if (accepts(last)) return last;
    await delay(1);
  }
  assert.fail('retry fixture timed out: ' + JSON.stringify(last));
}
function deferred() {
  let resolve;
  return { promise: new Promise(done => { resolve = done; }), resolve: value => resolve(value) };
}
async function fixture(t, options = {}) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'educoder-retry-test-'));
  const store = new PersonalQueueStore(path.join(directory, 'queue.json'));
  const plan = resolvePersonalQueue(snapshot, options.single ? [selections[0]] : selections);
  const record = await store.create({ ...plan, mode: options.single ? 'single' : 'continuous' });
  const state = { now: 0, clockStep: options.clockStep ?? 1000, recover: false, playFail: Boolean(options.playFail),
    safetyError: null, gate: null, gateEntered: 0, playReturnPaused: false, playStarted: 0, playInFlight: 0, maxPlayInFlight: 0,
    openPlayers: 0, maxOpenPlayers: 0 };
  const log = [], samples = [], singles = [];
  const createSingle = async target => {
    let media = null, closed = true, watched = 0, officialPercent = 0;
    const child = {
      busy: false, operationSignal: null,
      player: { isClosed: () => closed, close: async () => { if (!closed) state.openPlayers--; closed = true; media = null; log.push([target.index, 'player-close']); } },
      page: { close: async () => { log.push([target.index, 'list-close']); } },
      status() { return { target: target.title, page: target.page, index: target.index,
        stage: media?.ended ? 'ended' : media?.paused ? 'paused' : media ? 'playing' : 'not-open',
        media: media && { ...media }, confirmedWatchedSeconds: watched, confirmedWatchedPrefix: watched,
        resumeSeconds: watched, playAllowed: true, busy: this.busy, actionError: null, percent: officialPercent }; },
      async act(action) {
        log.push([target.index, action, state.now]);
        if (action === 'open') {
          if (this.operationSignal?.aborted) return this.status();
          closed = false; state.openPlayers++; state.maxOpenPlayers = Math.max(state.maxOpenPlayers, state.openPlayers);
          media = { currentTime: 0, duration: 3, paused: true, ended: false, playbackRate: 1, readyState: 4, mediaErrorCode: 0 };
        }
        if (action === 'play') {
          state.playInFlight++; state.maxPlayInFlight = Math.max(state.maxPlayInFlight, state.playInFlight); this.busy = true;
          try {
            if (state.gate) { state.gateEntered++; await state.gate; }
            if (this.operationSignal?.aborted || closed || !media) return { ...this.status(), actionError: 'QUEUE_STOPPED' };
            if (state.playFail || state.playReturnPaused) return { ...this.status(), actionError: 'PLAY_NOT_STARTED' };
            media.paused = false; state.playStarted++;
          } finally { state.playInFlight--; this.busy = false; }
        }
        if (action === 'pause' && media) media.paused = true;
        if (action === 'close-video') await this.player.close();
        return this.status();
      },
      async sample() {
        state.now += state.clockStep;
        if (state.recover && media && !media.paused && !media.ended) {
          media.currentTime = Math.min(media.duration, media.currentTime + 1); watched = media.currentTime;
          if (media.currentTime === media.duration) { media.ended = true; media.paused = true; }
        }
      },
      async inspectPersonalQueueSafety() { if (state.safetyError) throw new Error(state.safetyError); },
      async selectCard() { log.push([target.index, 'verify']); officialPercent = options.percent ?? 100; },
      async persist() { log.push([target.index, 'persist']); },
      async dispose() { log.push([target.index, 'dispose']); await this.player.close(); },
      async changePlaybackOptions() {}, requestStop() {},
      simulateOfficialPause() { if (media) media.paused = true; }
    };
    child.ownedPlayer = child.player; singles.push(child); return child;
  };
  const queue = new PersonalQueueController({ store, record, targets: plan.targets, createSingle,
    now: () => state.now, pollMs: 1, retryBaseMs: options.retryBaseMs ?? 2000, retryMaxMs: options.retryMaxMs ?? 30000,
    stallMs: options.stallMs ?? 30000, verifyMs: 1, verifyAttempts: 3, operationMs: 1000,
    onState: value => samples.push({ ...value, now: state.now }) });
  await queue.init();
  t.after(async () => {
    state.releaseGate?.();
    await queue.dispose().catch(() => {});
    assert.equal(path.dirname(directory).toLowerCase(), os.tmpdir().toLowerCase());
    assert.match(path.basename(directory), /^educoder-retry-test-/);
    await fs.rm(directory, { recursive: true, force: true });
  });
  return { directory, store, record, plan, state, log, samples, singles, queue,
    plays: () => log.filter(([, action]) => action === 'play').length };
}

test('017 no progress beyond 30 seconds remains active and attempts official playback', async t => {
  const f = await fixture(t); await f.queue.start();
  await until(() => ({ status: f.queue.status(), now: f.state.now, plays: f.plays() }),
    value => value.now > 30000 && value.status.queue.retrying && value.plays >= 2);
  assert.equal(f.queue.status().queue.active, true); assert.equal(f.queue.status().queue.phase, 'playing');
  assert.equal(f.record.cursor, 0); assert.equal(f.log.some(([, action]) => action === 'verify'), false);
  assert.equal(f.log.some(([, action]) => action === 'pause'), false);
  await f.queue.pause(); await f.queue.job;
});

test('017 initial temporary play failure retries for hours and many attempts without terminating', async t => {
  const f = await fixture(t, { playFail: true, clockStep: 3600000 }); await f.queue.start();
  await until(() => ({ status: f.queue.status(), plays: f.plays() }), value => value.plays >= 50 && value.status.queue.retrying);
  assert.ok(f.state.now >= 6 * 3600000); assert.equal(f.queue.status().queue.active, true);
  assert.equal(f.record.cursor, 0); assert.equal(f.singles.length, 1); assert.equal(f.state.maxPlayInFlight, 1);
  assert.ok(f.queue.status().queue.retryDelayMs <= 30000); assert.ok(f.queue.status().queue.retryDelayMs >= 2000);
  assert.equal(f.log.some(([, action]) => action === 'pause'), false);
  await f.queue.pause(); await f.queue.job;
});

test('017 progress recovery clears retry state and naturally completes the selected order', async t => {
  const f = await fixture(t, { playFail: true, clockStep: 1000 }); await f.queue.start();
  await until(() => f.queue.status(), value => value.queue.retrying && value.queue.retryAttempts >= 3);
  f.state.playFail = false; f.state.recover = true;
  await f.queue.job;
  const status = f.queue.status();
  assert.equal(status.queue.phase, 'completed'); assert.equal(status.queue.active, false);
  assert.equal(Boolean(status.queue.retrying), false); assert.equal(status.queue.retryAttempts ?? 0, 0);
  assert.equal(status.queue.retryDelayMs ?? 0, 0); assert.equal(status.queue.cursor, 2);
  const firstRetry = f.samples.findIndex(value => value.retrying);
  assert.ok(firstRetry >= 0);
  assert.ok(f.samples.slice(firstRetry + 1).some(value => value.phase === 'playing' && !value.retrying
    && (value.retryAttempts ?? 0) === 0), 'recovery must clear retry state before completion');
  assert.equal(f.state.maxOpenPlayers, 1); assert.equal(f.state.maxPlayInFlight, 1);
  assert.deepEqual(f.log.filter(([, action]) => action === 'verify').map(([index]) => index), [0, 1]);
  const firstDisposed = f.log.findIndex(([index, action]) => index === 0 && action === 'dispose');
  const secondOpened = f.log.findIndex(([index, action]) => index === 1 && action === 'open');
  assert.ok(firstDisposed >= 0 && secondOpened > firstDisposed);
});

test('017 retry backoff reaches a cap while retaining a nonzero interval between attempts', async t => {
  const f = await fixture(t, { playFail: true, retryBaseMs: 2000, retryMaxMs: 8000 }); await f.queue.start();
  await until(() => f.queue.status(), value => value.queue.retrying && value.queue.retryAttempts >= 8);
  assert.equal(f.queue.status().queue.retryDelayMs, 8000);
  const times = f.log.filter(([, action]) => action === 'play').map(([, , now]) => now);
  assert.ok(times.length >= 8);
  for (let index = 1; index < times.length; index++) assert.ok(times[index] - times[index - 1] >= 2000,
    'official play attempts must remain spaced, including after reaching the cap');
  await f.queue.pause(); await f.queue.job;
});

for (const action of ['pause', 'stop', 'dispose', 'request-stop'])
  test('017 ' + action + ' during retry cancels future attempts', async t => {
    const f = await fixture(t, { playFail: true }); await f.queue.start();
    await until(() => f.queue.status(), value => value.queue.retrying && value.queue.retryAttempts >= 2);
    if (action === 'pause') await f.queue.pause();
    else if (action === 'stop') await f.queue.pause(true);
    else if (action === 'dispose') await f.queue.dispose();
    else f.queue.requestStop();
    await f.queue.job; const plays = f.plays(); f.state.now += 24 * 3600000; await delay(30);
    assert.equal(f.plays(), plays); assert.equal(f.queue.status().queue.active, false);
    assert.equal(Boolean(f.queue.status().queue.retrying), false); assert.equal(f.record.cursor, 0);
    if (action === 'pause') assert.equal(f.record.reason, 'USER_PAUSED');
    if (action === 'stop') assert.equal(f.record.reason, 'QUEUE_STOPPED');
  });

test('017 duplicate starts cannot create concurrent retry actions or additional players', async t => {
  const f = await fixture(t, { playFail: true }); await f.queue.start();
  await until(() => f.queue.status(), value => value.queue.retrying && value.queue.retryAttempts >= 2);
  const gate = deferred(); f.state.gate = gate.promise; f.state.releaseGate = gate.resolve;
  await until(() => f.state.gateEntered, value => value > 0);
  const plays = f.plays(); await Promise.all(Array.from({ length: 20 }, () => f.queue.start()));
  f.state.now += 3600000; await delay(20);
  assert.equal(f.plays(), plays); assert.equal(f.state.maxPlayInFlight, 1); assert.equal(f.singles.length, 1);
  await f.queue.pause(true); const starts = f.state.playStarted; gate.resolve(); await f.queue.job;
  assert.equal(f.state.playStarted, starts); assert.equal(f.queue.status().queue.active, false);
  assert.equal(f.record.reason, 'QUEUE_STOPPED'); assert.equal(f.singles.length, 1);
});

test('017 an official user pause after a playing stall prevents the next retry click', async t => {
  const f = await fixture(t); await f.queue.start();
  await until(() => f.queue.status(), value => value.queue.retrying);
  const plays = f.plays(); f.singles[0].simulateOfficialPause(); await f.queue.job;
  assert.equal(f.record.reason, 'QUEUE_WEBSITE_PAUSED'); assert.equal(f.queue.status().queue.active, false);
  assert.equal(f.plays(), plays); assert.equal(f.record.cursor, 0);
  assert.equal(Boolean(f.queue.status().queue.retrying), false);
});

test('017 an official pause during a pending retry cannot schedule another attempt after it settles', async t => {
  const f = await fixture(t); await f.queue.start();
  await until(() => f.queue.status(), value => value.queue.retrying);
  const gate = deferred(); f.state.gate = gate.promise; f.state.releaseGate = gate.resolve;
  await until(() => f.state.gateEntered, value => value > 0);
  const plays = f.plays(); f.singles[0].simulateOfficialPause(); f.state.playReturnPaused = true;
  f.state.now += 20000; gate.resolve(); await f.queue.job;
  f.state.now += 3600000; await delay(30);
  assert.equal(f.record.reason, 'QUEUE_WEBSITE_PAUSED'); assert.equal(f.queue.status().queue.active, false);
  assert.equal(f.plays(), plays); assert.equal(f.state.maxPlayInFlight, 1); assert.equal(f.record.cursor, 0);
  assert.equal(Boolean(f.queue.status().queue.retrying), false);
});

for (const error of ['QUEUE_LOGIN_REQUIRED', 'QUEUE_VERIFICATION', 'QUEUE_PLATFORM_BLOCKED',
  'QUEUE_CHECKPOINT', 'QUEUE_OTHER_PLAYER', 'MEDIA_ERROR', 'PLAYER_CHANGED'])
  test('017 ' + error + ' stops an existing retry before another official play click', async t => {
    const f = await fixture(t, { playFail: true }); await f.queue.start();
    await until(() => f.queue.status(), value => value.queue.retrying && value.queue.retryAttempts >= 2);
    const plays = f.plays(); f.state.safetyError = error; await f.queue.job;
    assert.equal(f.queue.status().queue.active, false); assert.equal(f.record.reason, error);
    assert.equal(Boolean(f.queue.status().queue.retrying), false); assert.equal(f.plays(), plays);
    assert.equal(f.record.cursor, 0); assert.equal(f.log.some(([, action]) => action === 'verify'), false);
  });

test('017 naturally ended but unconfirmed official progress still does not advance or retry play', async t => {
  const f = await fixture(t, { percent: 99 }); f.state.recover = true; await f.queue.start(); await f.queue.job;
  assert.equal(f.record.reason, 'QUEUE_NOT_CONFIRMED'); assert.equal(f.record.cursor, 0);
  assert.equal(f.plays(), 1); assert.equal(f.log.filter(([, action]) => action === 'verify').length, 3);
  assert.equal(f.singles.length, 1); assert.equal(Boolean(f.queue.status().queue.retrying), false);
});
