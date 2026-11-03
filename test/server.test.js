import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer as createHttpServer } from 'node:http';
import { createServer } from '../src/server.js';
import { listenOnBrowserSafePort } from '../src/loopback-port.js';

async function withServer(handlers, run, options = {}) {
  const server = createServer(handlers, options);
  await listenOnBrowserSafePort(server);
  const origin = `http://127.0.0.1:${server.address().port}`;
  try {
    await run(origin);
  } finally {
    await new Promise(resolve => server.close(resolve));
  }
}

test('returns task status without exposing any credentials', async () => {
  await withServer({ getStatus: () => ({ phase: 'idle', completed: 0 }) }, async origin => {
    const response = await fetch(`${origin}/api/status`);
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { phase: 'idle', completed: 0 });
  });
});

test('returns the latest local course inventory', async () => {
  const snapshot = { courseTitle: '模拟测试课堂', complete: true, items: [{ title: '3 线性表', progress: 100 }] };
  await withServer({ getStatus: () => ({ phase: 'idle' }), getInventory: () => snapshot }, async origin => {
    const response = await fetch(`${origin}/api/inventory`);
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), snapshot);
  });
});

test('scan endpoint accepts a classroom URL but never starts playback', async () => {
  let received;
  await withServer({
    scan: async url => { received = url; },
    start: async () => { throw new Error('must not play'); },
    getStatus: () => ({ phase: 'idle' }),
  }, async origin => {
    const response = await fetch(`${origin}/api/scan`, {
      method: 'POST',
      headers: { Origin: origin, 'Content-Type': 'application/json' },
      body: JSON.stringify({ url: 'https://www.educoder.net/classrooms/SyntheticCourse/announcement' }),
    });
    assert.equal(response.status, 202);
    assert.equal(received, 'https://www.educoder.net/classrooms/SyntheticCourse/video');
  });
});

test('my classrooms endpoint returns official choices without starting playback', async () => {
  let reads = 0;
  await withServer({
    listClassrooms: async () => { reads++; return [{ title: '数据结构与算法', url: 'https://www.educoder.net/classrooms/SyntheticCourse/video' }]; },
    start: async () => { throw new Error('must not play'); },
    getStatus: () => ({ phase: 'ready' }),
  }, async origin => {
    const response = await fetch(`${origin}/api/classrooms`, {
      method: 'POST', headers: { Origin: origin, 'X-Study-Token': 'test-secret', 'Content-Type': 'application/json' }, body: '{}',
    });
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { classrooms: [
      { title: '数据结构与算法', url: 'https://www.educoder.net/classrooms/SyntheticCourse/video' },
    ] });
    assert.equal(reads, 1);
  }, { csrfToken: 'test-secret' });
});

test('scan endpoint blocks cross-origin requests', async () => {
  let scanned = false;
  await withServer({ scan: async () => { scanned = true; }, getStatus: () => ({ phase: 'idle' }) }, async origin => {
    const response = await fetch(`${origin}/api/scan`, {
      method: 'POST',
      headers: { Origin: 'https://example.org', 'Content-Type': 'application/json' },
      body: JSON.stringify({ url: 'https://www.educoder.net/classrooms/SyntheticCourse/video' }),
    });
    assert.equal(response.status, 403);
    assert.equal(scanned, false);
  });
});

test('rejects an external classroom URL before starting a task', async () => {
  let started = false;
  await withServer({ start: async () => { started = true; }, getStatus: () => ({ phase: 'idle' }) }, async origin => {
    const response = await fetch(`${origin}/api/start`, {
      method: 'POST',
      headers: { Origin: origin, 'Content-Type': 'application/json' },
      body: JSON.stringify({ url: 'https://example.org/classrooms/demo8cls/video' }),
    });
    assert.equal(response.status, 400);
    assert.equal(started, false);
  });
});

test('blocks a cross-origin website from launching a local task', async () => {
  let started = false;
  await withServer({ start: async () => { started = true; }, getStatus: () => ({ phase: 'idle' }) }, async origin => {
    const response = await fetch(`${origin}/api/start`, {
      method: 'POST',
      headers: { Origin: 'https://example.org', 'Content-Type': 'application/json' },
      body: JSON.stringify({ url: 'https://www.educoder.net/classrooms/demo8cls/video' }),
    });
    assert.equal(response.status, 403);
    assert.equal(started, false);
  });
});

test('serves a local control page without asking for a head song password', async () => {
  await withServer({ getStatus: () => ({ phase: 'idle' }) }, async origin => {
    const response = await fetch(origin);
    const html = await response.text();
    assert.equal(response.status, 200);
    assert.match(html, /打开头歌/);
    assert.match(html, /开始试运行/);
    assert.match(html, /id="trial-count"/);
    assert.match(html, /id="heatmap-grid"/);
    assert.doesNotMatch(html, /type=["']password["']/i);
  });
});

test('start endpoint defaults to one video on one page', async () => {
  let received;
  await withServer({ start: async (_, options) => { received = options; }, getStatus: () => ({ phase: 'idle' }) }, async origin => {
    const response = await fetch(`${origin}/api/start`, {
      method: 'POST',
      headers: { Origin: origin, 'Content-Type': 'application/json' },
      body: JSON.stringify({ url: 'https://www.educoder.net/classrooms/demo8cls/video' }),
    });
    assert.equal(response.status, 202);
    assert.deepEqual(received, { maxVideos: 1, maxPages: 1, startPage: 1 });
  });
});

test('start endpoint allows at most three videos when explicitly selected', async () => {
  let received;
  await withServer({ start: async (_, options) => { received = options; }, getStatus: () => ({ phase: 'idle' }) }, async origin => {
    const response = await fetch(`${origin}/api/start`, {
      method: 'POST',
      headers: { Origin: origin, 'Content-Type': 'application/json' },
      body: JSON.stringify({ url: 'https://www.educoder.net/classrooms/demo8cls/video', maxVideos: 3 }),
    });
    assert.equal(response.status, 202);
    assert.deepEqual(received, { maxVideos: 3, maxPages: 1, startPage: 1 });
  });
});

test('start endpoint permits at most three videos from a selected page and one following page', async () => {
  let received;
  await withServer({ start: async (_, options) => { received = options; }, getStatus: () => ({ phase: 'idle' }) }, async origin => {
    const response = await fetch(`${origin}/api/start`, {
      method: 'POST',
      headers: { Origin: origin, 'Content-Type': 'application/json' },
      body: JSON.stringify({ url: 'https://www.educoder.net/classrooms/demo8cls/video',
        maxVideos: 3, startPage: 2, maxPages: 2 }),
    });
    assert.equal(response.status, 202);
    assert.deepEqual(received, { maxVideos: 3, maxPages: 2, startPage: 2 });
  });
});

test('start endpoint rejects unbounded pages and invalid start pages before playback', async () => {
  let starts = 0;
  await withServer({ start: async () => { starts++; }, getStatus: () => ({ phase: 'idle' }) }, async origin => {
    for (const options of [{ maxPages: 3 }, { maxPages: 0 }, { startPage: 0 },
      { startPage: 1001 }, { startPage: '2' }, { maxPages: '2' }]) {
      const response = await fetch(`${origin}/api/start`, {
        method: 'POST', headers: { Origin: origin, 'Content-Type': 'application/json' },
        body: JSON.stringify({ url: 'https://www.educoder.net/classrooms/demo8cls/video', ...options }),
      });
      assert.equal(response.status, 400);
    }
    assert.equal(starts, 0);
  });
});

test('start endpoint forwards only an explicit boolean to replace an interrupted run', async () => {
  let received;
  await withServer({ start: async (_, options) => { received = options; }, getStatus: () => ({ phase: 'interrupted' }) }, async origin => {
    const post = replaceInterrupted => fetch(`${origin}/api/start`, {
      method: 'POST', headers: { Origin: origin, 'Content-Type': 'application/json' },
      body: JSON.stringify({ url: 'https://www.educoder.net/classrooms/demo8cls/video', replaceInterrupted }),
    });
    assert.equal((await post('true')).status, 400);
    assert.equal(received, undefined);
    assert.equal((await post(true)).status, 202);
    assert.deepEqual(received, { maxVideos: 1, maxPages: 1, startPage: 1, replaceInterrupted: true });
  });
});

test('start endpoint rejects an attempt to run beyond the safe trial limit', async () => {
  let started = false;
  await withServer({ start: async () => { started = true; }, getStatus: () => ({ phase: 'idle' }) }, async origin => {
    const response = await fetch(`${origin}/api/start`, {
      method: 'POST',
      headers: { Origin: origin, 'Content-Type': 'application/json' },
      body: JSON.stringify({ url: 'https://www.educoder.net/classrooms/demo8cls/video', maxVideos: 500 }),
    });
    assert.equal(response.status, 400);
    assert.equal(started, false);
  });
});

test('the HTTP API has no full-course or resume route', async () => {
  let started = false;
  await withServer({ start: async () => { started = true; }, getStatus: () => ({ phase: 'idle' }) }, async origin => {
    for (const route of ['/api/full-course', '/api/resume']) {
      const response = await fetch(`${origin}${route}`, {
        method: 'POST', headers: { Origin: origin, 'Content-Type': 'application/json' }, body: '{}',
      });
      assert.equal(response.status, 404);
    }
    assert.equal(started, false);
  });
});

test('desktop write operations require the per-launch token as well as the correct origin', async () => {
  let scans = 0;
  await withServer({ scan: async () => { scans++; }, getStatus: () => ({ phase: 'idle' }) }, async origin => {
    const body = JSON.stringify({ url: 'https://www.educoder.net/classrooms/SyntheticCourse/video' });
    const post = headers => fetch(`${origin}/api/scan`, {
      method: 'POST', body,
      headers: { Origin: origin, 'Content-Type': 'application/json', ...headers },
    });
    assert.equal((await post({})).status, 403);
    assert.equal((await post({ 'X-Study-Token': 'wrong' })).status, 403);
    assert.equal(scans, 0);
    assert.deepEqual(await (await fetch(`${origin}/api/bootstrap`)).json(), { csrfToken: 'test-secret', desktopMode: true });
    assert.equal((await post({ 'X-Study-Token': 'test-secret' })).status, 202);
    assert.equal(scans, 1);
  }, { csrfToken: 'test-secret' });
});
