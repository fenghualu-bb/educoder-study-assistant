import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { startLocalRuntime } from '../src/runtime.js';

test('runtime does not expose the previous task start API', async () => {
  const dataDir = await mkdtemp(path.join(tmpdir(), 'educoder-candidate-runtime-'));
  let runtime;
  let launches = 0;
  try {
    runtime = await startLocalRuntime({ dataDir, csrfToken: 'synthetic',
      launch: async () => { launches++; throw new Error('must not launch'); } });
    const bootstrap = await (await fetch(`${runtime.origin}/api/bootstrap`)).json();
    assert.deepEqual(bootstrap, { csrfToken: 'synthetic', desktopMode: true });
    const response = await fetch(`${runtime.origin}/api/start`, {
      method: 'POST', headers: { Origin: runtime.origin, 'Content-Type': 'application/json', 'X-Study-Token': 'synthetic' },
      body: JSON.stringify({ url: 'https://www.educoder.net/classrooms/SyntheticClass/video' }),
    });
    assert.equal(response.status, 404);
    assert.equal(launches, 0);
  } finally {
    await runtime?.close();
    await rm(dataDir, { recursive: true, force: true });
  }
});

test('runtime serves the control page on an assigned loopback port and closes cleanly', async () => {
  const dataDir = await mkdtemp(path.join(tmpdir(), 'educoder-runtime-'));
  let runtime;
  let choices = 0;
  try {
    runtime = await startLocalRuntime({
      dataDir, port: 0,
      choosePort: () => ++choices === 1 ? 10080 : 59100 + choices - 2,
      launch: async () => ({ page: {}, context: { close: async () => {} } }),
    });
    assert.match(runtime.origin, /^http:\/\/127\.0\.0\.1:\d+$/);
    assert.ok(Number(new URL(runtime.origin).port) >= 49_152);
    assert.ok(choices >= 2);
    assert.equal((await fetch(`${runtime.origin}/api/status`)).status, 200);
    await runtime.close();
    await runtime.close();
    await assert.rejects(fetch(`${runtime.origin}/api/status`));
  } finally {
    await runtime?.close();
    await rm(dataDir, { recursive: true, force: true });
  }
});

test('runtime uses injected profile directory rather than the source-tree data directory', async () => {
  const dataDir = await mkdtemp(path.join(tmpdir(), 'educoder-runtime-'));
  const profileDir = path.join(dataDir, 'private-browser');
  let receivedProfile;
  let runtime;
  try {
    runtime = await startLocalRuntime({
      dataDir, profileDir, port: 0,
      launch: async dir => {
        receivedProfile = dir;
        return { page: {}, context: { close: async () => {} } };
      },
    });
    await runtime.controller.openBrowser();
    assert.equal(receivedProfile, profileDir);
  } finally {
    await runtime?.close();
    await rm(dataDir, { recursive: true, force: true });
  }
});

test('runtime close retries a transient browser failure after its server has stopped', async () => {
  const dataDir = await mkdtemp(path.join(tmpdir(), 'educoder-runtime-retry-'));
  let runtime;
  let closes = 0;
  try {
    runtime = await startLocalRuntime({ dataDir, launch: async () => ({
      page: {}, context: { close: async () => { if (++closes === 1) throw new Error('browser busy'); } },
    }) });
    await runtime.controller.openBrowser();
    await assert.rejects(runtime.close(), /browser busy/);
    await runtime.close();
    assert.equal(closes, 2);
    await assert.rejects(fetch(`${runtime.origin}/api/status`));
  } finally {
    await runtime?.close().catch(() => {});
    await rm(dataDir, { recursive: true, force: true });
  }
});

test('versioned desktop runtime backs up legacy progress before opening its local listener', async () => {
  const dataDir = await mkdtemp(path.join(tmpdir(), 'educoder-upgrade-runtime-'));
  const inventory = await readFile(new URL('./fixtures/portable-upgrade-inventory.json', import.meta.url));
  const journal = await readFile(new URL('./fixtures/portable-upgrade-run.json', import.meta.url));
  let runtime;
  try {
    await writeFile(path.join(dataDir, 'course-inventory.json'), inventory);
    await writeFile(path.join(dataDir, 'run-journal.json'), journal);
    runtime = await startLocalRuntime({ dataDir, appVersion: '0.1.1' });
    const backups = await readdir(path.join(dataDir, 'upgrade-backups'));
    assert.equal(backups.length, 1);
    assert.match(backups[0], /^legacy-to-0\.1\.1--[a-f0-9]{64}$/);
    const backupDir = path.join(dataDir, 'upgrade-backups', backups[0]);
    assert.deepEqual(await readFile(path.join(backupDir, 'course-inventory.json')), inventory);
    assert.deepEqual(await readFile(path.join(backupDir, 'run-journal.json')), journal);
    assert.deepEqual(JSON.parse(await readFile(path.join(dataDir, 'data-upgrade.json'), 'utf8')),
      { version: 1, appVersion: '0.1.1' });
    assert.deepEqual(runtime.controller.getStatus(), { phase: 'idle', officialSessionOpen: false });
  } finally {
    await runtime?.close();
    await rm(dataDir, { recursive: true, force: true });
  }
});

test('a failed upgrade backup blocks the local listener and preserves the old records', async () => {
  const dataDir = await mkdtemp(path.join(tmpdir(), 'educoder-upgrade-failed-'));
  const inventory = await readFile(new URL('./fixtures/portable-upgrade-inventory.json', import.meta.url));
  const journal = await readFile(new URL('./fixtures/portable-upgrade-run.json', import.meta.url));
  let runtime;
  try {
    await writeFile(path.join(dataDir, 'course-inventory.json'), inventory);
    await writeFile(path.join(dataDir, 'run-journal.json'), journal);
    await writeFile(path.join(dataDir, 'upgrade-backups'), 'obstructed');
    try {
      runtime = await startLocalRuntime({ dataDir, appVersion: '0.1.1' });
      assert.fail('the runtime must reject an unsafe upgrade');
    } catch (error) {
      assert.equal(error.code, 'UPGRADE_BACKUP_FAILED');
    }
    assert.deepEqual(await readFile(path.join(dataDir, 'course-inventory.json')), inventory);
    assert.deepEqual(await readFile(path.join(dataDir, 'run-journal.json')), journal);
    await assert.rejects(readFile(path.join(dataDir, 'data-upgrade.json')), { code: 'ENOENT' });
  } finally {
    await runtime?.close();
    await rm(dataDir, { recursive: true, force: true });
  }
});
