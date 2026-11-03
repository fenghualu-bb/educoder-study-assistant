import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtemp, mkdir, writeFile, readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { acceptanceInvocation, registerLocalSingleVideo } from '../src/local-single-video-launcher.js';
import { SingleController } from '../src/local-single-video/controller.mjs';
import { TARGET, freshLedger, officialUrl } from '../src/local-single-video/ledger.mjs';

test('the desktop button can launch only its bundled acceptance mode, without video or account arguments', () => {
  assert.deepEqual(acceptanceInvocation({ executablePath: 'app.exe', projectRoot: 'source' }), {
    executablePath: 'app.exe', args: ['--local-single-video-acceptance'],
  });
  assert.deepEqual(acceptanceInvocation({ executablePath: 'electron.exe', projectRoot: 'source', defaultApp: true }), {
    executablePath: 'electron.exe', args: ['source', '--local-single-video-acceptance'],
  });
});
test('only the main desktop frame may open acceptance; other frames and supplied arguments are refused', async () => {
  const window = new EventEmitter();
  const frame = { url: 'http://127.0.0.1:52001/' };
  window.webContents = { mainFrame: frame, getURL: () => frame.url };
  const origin = 'http://127.0.0.1:52001'; let handler, spawned = 0, removed = false;
  registerLocalSingleVideo({ window, getRuntime: () => ({ origin }), executablePath: 'app.exe',
    ipcMain: { handle: (_name, callback) => { handler = callback; }, removeHandler: () => { removed = true; } },
    spawnImpl: (executable, args) => {
      assert.equal(executable, 'app.exe'); assert.deepEqual(args, ['--local-single-video-acceptance']); spawned++;
      const child = new EventEmitter(); child.unref = () => {};
      queueMicrotask(() => child.emit('spawn')); return child;
    } });
  const legitimate = { sender: window.webContents, senderFrame: frame };
  await assert.rejects(handler({ ...legitimate, sender: {} }));
  await assert.rejects(handler({ ...legitimate, senderFrame: { url: frame.url } }));
  await assert.rejects(handler(legitimate, 'another-video'));
  assert.equal(spawned, 0);
  assert.deepEqual(await handler(legitimate), { opened: true }); assert.equal(spawned, 1);
  window.emit('closed'); assert.equal(removed, true);
});
test('integrated acceptance keeps newer local position even when old bridge history has the same watched range', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'educoder-integrated-position-'));
  const dataDir = path.join(directory, 'data'); const history = path.join(directory, 'history');
  const marker = path.join(directory, 'EducoderSingleVideoAcceptance');
  await Promise.all([mkdir(dataDir), mkdir(history), mkdir(marker)]);
  const record = { ...freshLedger(), position: 285, watchedPrefix: 362.6, duration: 821.9 };
  const bytes = JSON.stringify(record, null, 2) + '\n';
  await writeFile(path.join(dataDir, 'observed-position.json'), bytes);
  const now = Date.now(); const target = { ...TARGET };
  const media = { currentTime: 197.4, duration: 821.9, paused: true, playbackRate: 1 };
  await writeFile(path.join(marker, 'bridge.json'), JSON.stringify({ pid: process.pid, directory: history }));
  await writeFile(path.join(history, 'state.json'), JSON.stringify({ pid: process.pid, target, media,
    courseUrl: officialUrl, updatedAt: new Date(now).toISOString() }));
  await writeFile(path.join(history, 'events.ndjson'), [
    { event: 'normal-speed-play', target, media: { ...media, currentTime: 0 }, at: new Date(now - 365_000).toISOString() },
    { event: 'official-pause', target, media: { ...media, currentTime: 362.6 }, at: new Date(now).toISOString() },
  ].map(value => JSON.stringify(value)).join('\n'));
  const controller = new SingleController({ dataDir, temporary: directory, appData: directory,
    nativeScript: 'unused', connectExistingBridge: false });
  controller.native = async () => { assert.fail('Old bridge must not be queried'); };
  try {
    await controller.init(); assert.equal(controller.status().resumeSeconds, 285);
    assert.equal(controller.bridge, null); assert.equal(await readFile(path.join(dataDir, 'observed-position.json'), 'utf8'), bytes);
  } finally { await controller.dispose(); }
});
