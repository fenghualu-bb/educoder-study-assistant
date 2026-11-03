import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { runDesktop } from '../src/desktop-lifecycle.js';
import { browserModeFromArgs } from '../src/desktop-browser.js';

function fixture({ lock = true, startRuntime } = {}) {
  const order = [];
  const app = new EventEmitter();
  app.requestSingleInstanceLock = () => lock;
  app.whenReady = async () => {};
  app.getPath = name => name === 'userData'
    ? 'C:\\Users\\student\\AppData\\Roaming\\Study'
    : 'C:\\Users\\student\\AppData\\Local\\Study';
  app.isPackaged = false;
  app.quit = () => { order.push('quit'); app.emit('quit-for-test'); };
  const windows = [];
  class BrowserWindow extends EventEmitter {
    constructor(options) {
      super();
      this.options = options;
      this.webContents = new EventEmitter();
      this.webContents.setWindowOpenHandler = handler => { this.openHandler = handler; };
      windows.push(this);
    }
    async loadFile(file) { order.push(`file:${file}`); }
    async loadURL(url) { order.push(`url:${url}`); }
    isMinimized() { return true; }
    restore() { order.push('restore'); }
    show() { order.push('show'); }
    focus() { order.push('focus'); }
    destroy() { order.push('destroy'); }
  }
  return { app, BrowserWindow, windows, order, startRuntime };
}

test('desktop opens one sandboxed local window and closes the runtime before quitting', async () => {
  let runtimeOptions;
  const f = fixture({ startRuntime: async options => {
    runtimeOptions = options;
    return {
      origin: 'http://127.0.0.1:52001',
      close: async () => { f.order.push('runtime-closed'); },
    };
  } });
  await runDesktop({ ...f, resourcesPath: 'C:\\Electron\\resources', projectRoot: 'C:\\project' });
  const window = f.windows[0];
  assert.equal(f.windows.length, 1);
  assert.equal(runtimeOptions.browserRoot, 'C:\\project\\vendor\\ms-playwright');
  assert.deepEqual(window.options.webPreferences, {
    nodeIntegration: false, contextIsolation: true, sandbox: true,
  });
  assert.ok(f.order.includes('url:http://127.0.0.1:52001'));
  assert.deepEqual(window.openHandler({ url: 'https://evil.example' }), { action: 'deny' });
  const navigation = { preventDefault() { this.blocked = true; } };
  window.webContents.emit('will-navigate', navigation, 'https://evil.example');
  assert.equal(navigation.blocked, true);
  f.app.emit('second-instance');
  assert.deepEqual(f.order.slice(-3), ['restore', 'show', 'focus']);
  let prevented = false;
  const quit = new Promise(resolve => f.app.once('quit-for-test', resolve));
  window.emit('close', { preventDefault() { prevented = true; } });
  await quit;
  assert.equal(prevented, true);
  assert.ok(f.order.indexOf('runtime-closed') < f.order.indexOf('quit'));
});

test('desktop attaches an isolated preload before loading its workbench', async () => {
  const f = fixture({ startRuntime: async () => ({ origin: 'http://127.0.0.1:52001' }) });
  let registered;
  await runDesktop({ ...f, resourcesPath: 'C:\\Electron\\resources', projectRoot: 'C:\\project',
    preloadPath: 'C:\\project\\src\\desktop-preload.cjs', onWindowCreated: value => { registered = value; } });
  assert.equal(f.windows[0].options.webPreferences.preload, 'C:\\project\\src\\desktop-preload.cjs');
  assert.equal(f.windows[0].options.webPreferences.sandbox, true);
  assert.equal(registered.window, f.windows[0]);
  assert.equal(registered.getRuntime().origin, 'http://127.0.0.1:52001');
});

test('desktop keeps the legacy runner disabled in its local runtime', async () => {
  let received;
  const f = fixture({ startRuntime: async options => {
    received = options;
    return { origin: 'http://127.0.0.1:52001' };
  } });
  await runDesktop({ ...f, resourcesPath: 'C:\\Electron\\resources', projectRoot: 'C:\\project' });
  assert.equal(received.legacyRunnerDisabled, true);
  assert.match(received.csrfToken, /^[0-9a-f]{64}$/);
});

test('second desktop instance exits without starting another server', async () => {
  let starts = 0;
  const f = fixture({ lock: false, startRuntime: async () => { starts++; } });
  await runDesktop({ ...f, resourcesPath: 'C:\\Electron\\resources', projectRoot: 'C:\\project' });
  assert.equal(starts, 0);
  assert.equal(f.windows.length, 0);
  assert.deepEqual(f.order, ['quit']);
});

test('candidate version is visible and a different requested version never replaces the current process', async () => {
  const f = fixture({ startRuntime: async () => ({ origin: 'http://127.0.0.1:52001' }) });
  f.app.getVersion = () => '0.1.12';
  let lockData;
  f.app.requestSingleInstanceLock = data => { lockData = data; return true; };
  const conflicts = [];
  await runDesktop({ ...f, resourcesPath: 'C:\\Electron\\resources', projectRoot: 'C:\\project',
    onVersionConflict: value => conflicts.push(value) });
  assert.deepEqual(lockData, { requestedVersion: '0.1.12' });
  assert.match(f.windows[0].options.title, /0\.1\.12.*候选版/);
  f.app.emit('second-instance', {}, ['app.exe'], '', { requestedVersion: '0.1.13' });
  assert.equal(conflicts.length, 1);
  assert.equal(conflicts[0].currentVersion, '0.1.12');
  assert.equal(conflicts[0].requestedVersion, '0.1.13');
  assert.equal(f.windows.length, 1);
  assert.equal(f.order.includes('quit'), false);
});

test('a blocked candidate identifies itself without guessing the version of an older running instance', async () => {
  const f = fixture({ lock: false }); f.app.getVersion = () => '0.1.12';
  let warning;
  await runDesktop({ ...f, resourcesPath: 'C:\\Electron\\resources', projectRoot: 'C:\\project', onSecondaryInstance: value => { warning = value; } });
  assert.equal(warning.version, '0.1.12');
  assert.match(warning.message, /0\.1\.12.*候选版未新建窗口/);
  assert.match(warning.message, /查看该窗口顶部的版本/);
  assert.match(warning.message, /自行关闭/);
  assert.doesNotMatch(warning.message, /当前运行的是.*0\.1\.11/);
  assert.equal(f.windows.length, 0);
});

test('a second instance requesting Edge warns instead of silently reusing the bundled mode', async () => {
  const conflicts = [];
  const f = fixture({ startRuntime: async () => ({ origin: 'http://127.0.0.1:52001' }) });
  await runDesktop({
    ...f, browserMode: 'bundled',
    onModeConflict: conflict => { conflicts.push([conflict.currentMode, conflict.requestedMode]); },
    resourcesPath: 'C:\\Electron\\resources', projectRoot: 'C:\\project',
  });
  f.app.emit('second-instance', {}, ['app.exe', '--study-browser=edge']);
  assert.deepEqual(conflicts, [['bundled', 'edge']]);
  assert.ok(f.order.includes('focus'));
});

test('a second Edge-only package opened by double click is recognized as a mode conflict', async () => {
  const conflicts = [];
  const f = fixture({ startRuntime: async () => ({ origin: 'http://127.0.0.1:52001' }) });
  await runDesktop({
    ...f, browserMode: 'bundled',
    modeFromCommandLine: args => browserModeFromArgs(args, {
      packageResourcesPath: 'C:\\EdgePackage\\resources',
      exists: value => value === 'C:\\EdgePackage\\resources\\edge-only.marker',
    }),
    onModeConflict: conflict => { conflicts.push([conflict.currentMode, conflict.requestedMode]); },
    resourcesPath: 'C:\\Electron\\resources', projectRoot: 'C:\\project',
  });
  f.app.emit('second-instance', {}, ['C:\\EdgePackage\\app.exe']);
  assert.deepEqual(conflicts, [['bundled', 'edge']]);
});

test('missing Edge shows the specific local startup help instead of generic retry text', async () => {
  const error = Object.assign(new Error('未找到 Microsoft Edge'), { code: 'EDGE_NOT_FOUND' });
  const f = fixture({ startRuntime: async () => { throw error; } });
  await runDesktop({ ...f, resourcesPath: 'C:\\Electron\\resources', projectRoot: 'C:\\project' });
  assert.ok(f.order.some(value => value.includes('desktop-edge-missing.html')));
  assert.equal(f.order.some(value => value.startsWith('url:')), false);
});

test('upgrade backup failure shows a local data-safety page instead of a generic startup error', async () => {
  const error = Object.assign(new Error('disk full'), { code: 'UPGRADE_BACKUP_FAILED' });
  const f = fixture({ startRuntime: async () => { throw error; } });
  await runDesktop({ ...f, resourcesPath: 'C:\\Electron\\resources', projectRoot: 'C:\\project' });
  assert.ok(f.order.some(value => value.includes('desktop-upgrade-error.html')));
  assert.equal(f.order.some(value => value.startsWith('url:')), false);
});

test('slow safe shutdown shows a waiting page and exits when cleanup eventually finishes', async () => {
  let finishClose;
  const closing = new Promise(resolve => { finishClose = resolve; });
  const f = fixture({ startRuntime: async () => ({
    origin: 'http://127.0.0.1:52001',
    close: () => closing,
  }) });
  await runDesktop({
    ...f, shutdownTimeoutMs: 5,
    resourcesPath: 'C:\\Electron\\resources', projectRoot: 'C:\\project',
  });
  const quit = new Promise(resolve => f.app.once('quit-for-test', resolve));
  f.windows[0].emit('close', { preventDefault() {} });
  try {
    await new Promise(resolve => setTimeout(resolve, 40));
    assert.ok(f.order.some(value => value.includes('desktop-shutdown-wait.html')));
    assert.equal(f.order.includes('quit'), false);
    assert.equal(f.order.some(value => value.includes('desktop-error.html')), false);
  } finally {
    finishClose();
  }
  await quit;
  assert.ok(f.order.indexOf('destroy') < f.order.indexOf('quit'));
});

test('failed safe shutdown shows a shutdown error, not a startup error', async () => {
  const f = fixture({ startRuntime: async () => ({
    origin: 'http://127.0.0.1:52001',
    close: async () => { throw new Error('cleanup failed'); },
  }) });
  await runDesktop({ ...f, resourcesPath: 'C:\\Electron\\resources', projectRoot: 'C:\\project' });
  f.windows[0].emit('close', { preventDefault() {} });
  await new Promise(resolve => setImmediate(resolve));
  assert.ok(f.order.some(value => value.includes('desktop-shutdown-error.html')));
  assert.equal(f.order.includes('quit'), false);
});

test('a viewer record conflict during application close keeps the live workbench and runtime available', async () => {
  const f = fixture({ startRuntime: async () => ({ origin: 'http://127.0.0.1:52001', close: async () => f.order.push('runtime-closed') }) });
  await runDesktop({ ...f, resourcesPath: 'C:\\Electron\\resources', projectRoot: 'C:\\project',
    onWindowCreated: () => ({ close: async () => { throw Object.assign(new Error('RECORD_CHANGED'), { code: 'RECORD_CHANGED' }); } }) });
  const before = [...f.order]; f.windows[0].emit('close', { preventDefault() {} });
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(f.order, before); assert.equal(f.order.includes('runtime-closed'), false);
  assert.equal(f.order.includes('quit'), false);
});

test('closing during startup waits for a late runtime and closes it before quitting', async () => {
  let started;
  const startupBegan = new Promise(resolve => { started = resolve; });
  let finishStartup;
  const startup = new Promise(resolve => { finishStartup = resolve; });
  const f = fixture({ startRuntime: () => { started(); return startup; } });
  const running = runDesktop({
    ...f, resourcesPath: 'C:\\Electron\\resources', projectRoot: 'C:\\project',
  });
  await startupBegan;
  const quit = new Promise(resolve => f.app.once('quit-for-test', resolve));
  f.windows[0].emit('close', { preventDefault() {} });
  try {
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(f.order.includes('quit'), false);
  } finally {
    finishStartup({ origin: 'http://127.0.0.1:52001', close: async () => { f.order.push('late-runtime-closed'); } });
  }
  await Promise.all([running, quit]);
  assert.ok(f.order.indexOf('late-runtime-closed') < f.order.indexOf('quit'));
  assert.equal(f.order.some(value => value.startsWith('url:')), false);
});

test('closing while the loading page opens never starts a runtime afterward', async () => {
  let started = 0;
  const f = fixture({ startRuntime: async () => { started++; return { origin: 'http://127.0.0.1:52001' }; } });
  let loadingBegan;
  const loadingStarted = new Promise(resolve => { loadingBegan = resolve; });
  let finishLoading;
  const loading = new Promise(resolve => { finishLoading = resolve; });
  f.BrowserWindow.prototype.loadFile = async file => {
    f.order.push(`file:${file}`);
    if (file.includes('desktop-loading.html')) {
      loadingBegan();
      await loading;
    }
  };
  const running = runDesktop({ ...f, resourcesPath: 'C:\\Electron\\resources', projectRoot: 'C:\\project' });
  await loadingStarted;
  const quit = new Promise(resolve => f.app.once('quit-for-test', resolve));
  f.windows[0].emit('close', { preventDefault() {} });
  finishLoading();
  await Promise.all([running, quit]);
  assert.equal(started, 0);
  assert.equal(f.order.some(value => value.startsWith('url:')), false);
});

test('runtime startup error stays in a local error page instead of opening an external site', async () => {
  const f = fixture({ startRuntime: async () => { throw new Error('port failed'); } });
  await runDesktop({ ...f, resourcesPath: 'C:\\Electron\\resources', projectRoot: 'C:\\project' });
  assert.equal(f.windows.length, 1);
  assert.equal(f.order.some(value => value.startsWith('url:')), false);
  assert.ok(f.order.some(value => value.includes('desktop-error.html')));
});
