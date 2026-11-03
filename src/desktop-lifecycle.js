import { randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { browserModeFromArgs } from './desktop-browser.js';
import { resolveDesktopPaths } from './desktop-paths.js';

const loadingPage = fileURLToPath(new URL('../public/desktop-loading.html', import.meta.url));
const errorPage = fileURLToPath(new URL('../public/desktop-error.html', import.meta.url));
const edgeMissingPage = fileURLToPath(new URL('../public/desktop-edge-missing.html', import.meta.url));
const upgradeErrorPage = fileURLToPath(new URL('../public/desktop-upgrade-error.html', import.meta.url));
const shutdownWaitPage = fileURLToPath(new URL('../public/desktop-shutdown-wait.html', import.meta.url));
const shutdownErrorPage = fileURLToPath(new URL('../public/desktop-shutdown-error.html', import.meta.url));

function closeWithDeadline(close, milliseconds = 10_000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('安全停止超时')), milliseconds);
    Promise.resolve().then(close).then(
      () => { clearTimeout(timer); resolve(); },
      error => { clearTimeout(timer); reject(error); },
    );
  });
}

export async function runDesktop({ app, BrowserWindow, startRuntime, resourcesPath, projectRoot,
  browserMode = 'bundled', modeFromCommandLine = browserModeFromArgs,
  onModeConflict = () => {}, onSecondaryInstance = () => {}, onVersionConflict = () => {}, shutdownTimeoutMs = 10_000,
  preloadPath, onWindowCreated = () => {},
  // The early automated runner stays closed in the desktop app; viewing goes through the personal home.
  legacyRunnerDisabled = true }) {
  const version = app.getVersion?.() ?? '当前候选';
  if (!app.requestSingleInstanceLock({ requestedVersion: version })) {
    try {
      await app.whenReady();
      await onSecondaryInstance({ version, message: `头歌学习助手 ${version} 候选版未新建窗口：已有助手正在运行。请查看该窗口顶部的版本；若不是 ${version}，请先自行关闭它，再打开此候选版。已保存位置保留。` });
    } finally { app.quit(); }
    return { secondary: true };
  }
  let window;
  let runtime;
  let startingRuntime;
  let allowClose = false;
  let closing = false;
  const finishClose = () => {
    if (allowClose) return;
    allowClose = true;
    window.destroy();
    app.quit();
  };
  app.on('second-instance', (_event, commandLine = [], _workingDirectory, additionalData) => {
    if (!window) return;
    if (window.isMinimized()) window.restore();
    window.show();
    window.focus();
    const requestedVersion = additionalData?.requestedVersion;
    if (typeof requestedVersion === 'string' && /^\d+\.\d+\.\d+$/.test(requestedVersion) && requestedVersion !== version) {
      try { onVersionConflict({ currentVersion: version, requestedVersion, window })?.catch?.(() => {}); } catch {}
    }
    let requestedMode;
    try { requestedMode = modeFromCommandLine(commandLine); }
    catch { requestedMode = 'invalid'; }
    if (requestedMode !== browserMode) {
      try { onModeConflict({ currentMode: browserMode, requestedMode, window })?.catch?.(() => {}); }
      catch { /* Keep the existing desktop window usable if its warning cannot be shown. */ }
    }
  });
  await app.whenReady();
  const paths = resolveDesktopPaths({
    userData: app.getPath('userData'),
    sessionData: app.getPath('sessionData'),
    resourcesPath,
    packaged: app.isPackaged,
    projectRoot,
  });
  window = new BrowserWindow({
    width: 1200, height: 820, minWidth: 800, minHeight: 600,
    title: `头歌学习助手 · ${version} 候选版`,
    webPreferences: { nodeIntegration: false, contextIsolation: true, sandbox: true,
      ...(preloadPath ? { preload: preloadPath } : {}) },
  });
  const extension = onWindowCreated({ window, getRuntime: () => runtime });
  window.webContents.on('page-title-updated', event => event.preventDefault());
  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  window.webContents.on('will-navigate', (event, url) => {
    if (!runtime || new URL(url).origin !== runtime.origin) event.preventDefault();
  });
  window.on('close', event => {
    if (allowClose) return;
    event.preventDefault();
    if (closing) return;
    closing = true;
    let extensionFinished = !extension?.close;
    const pendingClose = Promise.resolve().then(async () => {
      if (startingRuntime) {
        try { runtime = await startingRuntime; }
        catch { return; }
      }
      await extension?.close?.();
      extensionFinished = true;
      await runtime?.close();
    });
    closeWithDeadline(() => pendingClose, shutdownTimeoutMs).then(finishClose).catch(async error => {
      if (error.message === '安全停止超时') {
        if (extensionFinished) await window.loadFile(shutdownWaitPage);
        pendingClose.then(finishClose).catch(async () => {
          closing = false;
          if (extensionFinished) await window.loadFile(shutdownErrorPage);
        });
      } else {
        closing = false;
        if (extensionFinished) await window.loadFile(shutdownErrorPage);
      }
    });
  });
  app.on('before-quit', event => {
    if (allowClose) return;
    event.preventDefault();
    window?.close();
  });
  await window.loadFile(loadingPage);
  try {
    startingRuntime = Promise.resolve().then(() => closing ? null : startRuntime({
      dataDir: paths.dataDir,
      profileDir: paths.profileDir,
      browserRoot: paths.browserRoot,
      port: 0,
      csrfToken: randomBytes(32).toString('hex'),
      legacyRunnerDisabled,
    }));
    runtime = await startingRuntime;
    if (closing) return { window, runtime, paths, secondary: false };
    await window.loadURL(runtime.origin);
  } catch (error) {
    if (!closing) await window.loadFile(error?.code === 'EDGE_NOT_FOUND' ? edgeMissingPage
      : error?.code === 'UPGRADE_BACKUP_FAILED' ? upgradeErrorPage : errorPage);
  }
  return { window, runtime, paths, secondary: false };
}
