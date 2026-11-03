import { test } from 'node:test';
import assert from 'node:assert/strict';
import { classifyPlayback, watchVideo } from '../src/player.js';
import { classifyRunError } from '../src/run-error.js';

test('only a natural media end counts as complete', () => {
  assert.equal(classifyPlayback({ ended: true, error: null }, 0, 50_000, 120_000), 'complete');
  assert.equal(classifyPlayback({ ended: false, currentTime: 50, duration: 50, error: null }, 0, 50_000, 120_000), 'playing');
});

test('media error and a long stall stop playback', () => {
  assert.equal(classifyPlayback({ ended: false, error: { code: 2 } }, 0, 1, 120_000), 'failed');
  assert.equal(classifyPlayback({ ended: false, error: null }, 0, 120_001, 120_000), 'stalled');
});

test('watchVideo waits for actual end across temporary buffering', async () => {
  const states = [
    { currentTime: 0, duration: 50, ended: false, error: null },
    { currentTime: 19.8, duration: 50, ended: false, error: null },
    { currentTime: 19.8, duration: 50, ended: false, error: null },
    { currentTime: 50, duration: 50, ended: true, error: null },
  ];
  const seen = [];
  let time = 0;
  const player = {
    async play() {},
    async snapshot() { return states.shift() ?? states.at(-1); },
  };
  const result = await watchVideo(player, {
    now: () => time,
    delay: async () => { time += 30_000; },
    onProgress: s => seen.push(s.currentTime),
  });
  assert.equal(result.ended, true);
  assert.deepEqual(seen, [0, 19.8, 19.8, 50]);
});

test('watchVideo stops after 120 seconds without progress', async () => {
  let time = 0;
  const player = {
    async play() {},
    async snapshot() { return { currentTime: 0, duration: 50, ended: false, error: null }; },
  };
  await assert.rejects(
    watchVideo(player, { now: () => time, delay: async () => { time += 30_000; }, stallMs: 120_000 }),
    /120 seconds without progress/,
  );
});

test('a long video can recover from more than two minutes of buffering', async () => {
  let time = 0;
  const states = [
    { currentTime: 61, duration: 337, ended: false, error: null },
    { currentTime: 61, duration: 337, ended: false, error: null },
    { currentTime: 61, duration: 337, ended: false, error: null },
    { currentTime: 61, duration: 337, ended: false, error: null },
    { currentTime: 61, duration: 337, ended: false, error: null },
    { currentTime: 61, duration: 337, ended: false, error: null },
    { currentTime: 62, duration: 337, ended: false, error: null },
    { currentTime: 337, duration: 337, ended: true, error: null },
  ];
  const player = {
    async play() {},
    async snapshot() { return states.shift(); },
  };
  const result = await watchVideo(player, {
    now: () => time,
    delay: async () => { time += 30_000; },
  });
  assert.equal(result.ended, true);
  assert.equal(time, 210_000);
});

test('long video still fails after five minutes without progress', async () => {
  let time = 0;
  const player = {
    async play() {},
    async snapshot() { return { currentTime: 61, duration: 337, ended: false, error: null }; },
  };
  await assert.rejects(
    watchVideo(player, { now: () => time, delay: async () => { time += 30_000; } }),
    /300 seconds without progress/,
  );
});

test('slow but moving video cannot run beyond its total wall-time limit', async () => {
  let time = 0;
  const player = {
    async play() {},
    async snapshot() { return { currentTime: time / 1000, duration: 337, ended: time >= 150_000, error: null }; },
  };
  await assert.rejects(
    watchVideo(player, { now: () => time, delay: async () => { time += 30_000; }, maxElapsedMs: 100_000 }),
    /100 seconds total/,
  );
});

test('reports buffering only after actual media time stops for six seconds', async () => {
  let time = 0;
  const phases = [];
  let reads = 0;
  const player = {
    play: async () => {},
    snapshot: async () => ({ currentTime: reads++ < 4 ? 0 : 1, duration: 60, ended: false, error: null, paused: false }),
  };
  const controller = new AbortController();
  await assert.rejects(watchVideo(player, {
    signal: controller.signal,
    now: () => time,
    delay: async ms => { time += ms; if (time >= 12_000) controller.abort(); },
    pollMs: 3_000,
    onProgress: value => phases.push(value.phase),
  }), /task stopped/);
  assert.deepEqual(phases.slice(0, 4), ['playing', 'playing', 'buffering', 'buffering']);
});

test('media failures have stable diagnostic codes', async () => {
  const player = { play: async () => {}, snapshot: async () => ({ currentTime: 0, duration: 50, ended: false, error: { code: 2 } }) };
  await assert.rejects(watchVideo(player), error => classifyRunError(error) === 'MEDIA_ERROR');
});
