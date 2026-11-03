import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createPlaybackOptionsStore } from '../src/local-single-video/playback-options.mjs';
import { ObservationLedger, freshLedger } from '../src/local-single-video/ledger.mjs';

async function withStore(run) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'educoder-playback-options-'));
  try { await run(path.join(directory, 'options.json')); }
  finally { assert.equal(path.dirname(directory), os.tmpdir()); await fs.rm(directory, { recursive: true, force: true }); }
}
test('viewing options are independently off by default and persist across reopening without user or course data', async () => {
  await withStore(async file => {
    const store = createPlaybackOptionsStore(file);
    assert.deepEqual(await store.get(), { autoMute: false, speedEnabled: false, speed: 1.5 });
    await assert.rejects(fs.access(file), { code: 'ENOENT' });
    await store.set({ autoMute: true }); await store.set({ speedEnabled: true, speed: 2 });
    const reopened = createPlaybackOptionsStore(file);
    assert.deepEqual(await reopened.get(), { autoMute: true, speedEnabled: true, speed: 2 });
    await reopened.set({ autoMute: false });
    assert.deepEqual(await reopened.get(), { autoMute: false, speedEnabled: true, speed: 2 });
    const data = JSON.parse(await fs.readFile(file, 'utf8'));
    assert.deepEqual(Object.keys(data).sort(), ['autoMute', 'speed', 'speedEnabled', 'version']);
  });
});
test('queued viewing changes preserve both switches and unknown settings', async () => {
  await withStore(async file => {
    await fs.writeFile(file, JSON.stringify({ version: 1, autoMute: false, speedEnabled: false, speed: 1.5, note: 'preserve' }));
    const store = createPlaybackOptionsStore(file);
    await Promise.all([store.set({ autoMute: true }), store.set({ speedEnabled: true, speed: 2 })]);
    assert.deepEqual(await store.get(), { autoMute: true, speedEnabled: true, speed: 2 });
    assert.equal(JSON.parse(await fs.readFile(file, 'utf8')).note, 'preserve');
  });
});
test('malformed settings and unsupported or injected controls cannot overwrite an existing preference', async () => {
  await withStore(async file => {
    const store = createPlaybackOptionsStore(file);
    for (const patch of [{}, { speed: 99 }, { autoMute: 'true' }, { speedEnabled: 1 }, { systemVolume: 0 }])
      await assert.rejects(store.set(patch), /PLAYBACK_OPTIONS_INVALID/);
    await fs.writeFile(file, '{broken');
    await assert.rejects(store.get(), /PLAYBACK_OPTIONS_INVALID/);
    await assert.rejects(store.set({ autoMute: true }), /PLAYBACK_OPTIONS_INVALID/);
    assert.equal(await fs.readFile(file, 'utf8'), '{broken');
  });
});
const media = (time, rate = 1) => ({ currentTime: time, duration: 100, paused: false, playbackRate: rate });
test('confirmed official speed records observed media position, without accepting a seek or unobserved wall time', () => {
  const ledger = new ObservationLedger(freshLedger());
  ledger.allowOfficialRate(2);
  ledger.observe(media(0, 2), 1000); ledger.observe(media(2, 2), 2000); ledger.observe(media(4, 2), 3000);
  assert.equal(ledger.value.position, 4); assert.equal(ledger.value.watchedPrefix, 4);
  ledger.observe(media(50, 2), 4000); assert.equal(ledger.value.position, 4);
  ledger.observe(media(52, 2), 20_000); assert.equal(ledger.value.position, 4);
  ledger.capture({ ...media(90, 2), paused: true }); assert.equal(ledger.restorePosition(), 4);
  assert.equal(ledger.value.duration, 100);
});
test('unapproved speed remains excluded; changing an approved speed discards the transition segment', () => {
  const ledger = new ObservationLedger(freshLedger());
  ledger.observe(media(0, 2), 1000); ledger.observe(media(2, 2), 2000); assert.equal(ledger.value.position, 0);
  ledger.allowOfficialRate(1.5); ledger.observe(media(2, 1.5), 3000); ledger.observe(media(3.5, 1.5), 4000);
  assert.equal(ledger.value.position, 3.5); assert.equal(ledger.value.watchedPrefix, 0);
  ledger.allowOfficialRate(1); ledger.observe(media(5), 5000); assert.equal(ledger.value.position, 3.5);
  assert.throws(() => ledger.allowOfficialRate(99), /OBSERVATION_RATE_INVALID/);
});
