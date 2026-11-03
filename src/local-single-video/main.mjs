import { app, BrowserWindow, ipcMain } from 'electron';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { mkdirSync } from 'node:fs';
import { SingleController } from './controller.mjs';
import { readLegacyPositionTarget } from './position-store.mjs';
const root = fileURLToPath(new URL('./', import.meta.url));
app.setName('EducoderSingleVideoAcceptance');
// Share the already accepted entry's data path and Windows single-instance lock.
const sharedDataDir = path.join(app.getPath('appData'), 'EducoderSingleVideoAcceptance');
mkdirSync(sharedDataDir, { recursive: true });
app.setPath('userData', sharedDataDir);
app.setPath('sessionData', sharedDataDir);
let window, controller, closing = false, pendingAction = Promise.resolve();
if (!app.requestSingleInstanceLock()) app.quit();
else {
  app.on('second-instance', () => { window?.restore(); window?.show(); window?.focus(); });
  app.whenReady().then(async () => {
  try {
    const target = await readLegacyPositionTarget(path.join(sharedDataDir, 'observed-position.json'));
    controller = new SingleController({ dataDir: sharedDataDir, appData: app.getPath('appData'), target, connectExistingBridge: false,
      nativeScript: app.isPackaged ? path.join(process.resourcesPath, 'local-single-video-native-control.ps1') : path.join(root, 'local-single-video-native-control.ps1') });
    await controller.init();
  } catch (error) {
    const message = error.message === 'LEGACY_RECORD_MISSING'
      ? '尚无明确选择的本机验收记录。请从主程序扫描课堂、选择方格并打开观看窗口；此入口不会猜测或打开课程。'
      : '旧验收记录无法确认，原文件保留。请交维护者检查，或从主程序选择视频；此入口未打开课程。';
    controller = { status: () => ({ target: '尚未选择视频', courseTitle: '本机单视频验收', page: 1, index: 0,
      stage: 'not-open', media: null, resumeSeconds: 0, actionsAvailable: false, message }),
      act: async () => { throw new Error('LOCAL_RECORD_REQUIRED'); }, dispose: async () => {} };
  }
  const entry = new URL('./ui/index.html', import.meta.url).href;
  function trusted(event) { if (event.sender !== window?.webContents || event.senderFrame !== window.webContents.mainFrame || event.senderFrame?.url !== entry) throw new Error('LOCAL_UI_ONLY'); }
  ipcMain.handle('single:status', event => { trusted(event); return { ...controller.status(), version: app.getVersion(), canReturnHome: false }; });
  ipcMain.handle('single:action', (event, action, ...extra) => {
    trusted(event); if (closing || extra.length) throw new Error('CLOSING');
    pendingAction = controller.act(action); return pendingAction;
  });
  function finish(discardUnsavedPosition = false) {
    if (closing) return closing;
    controller.requestStop?.();
    closing = pendingAction.catch(() => {}).then(() => controller.dispose({ discardUnsavedPosition })).then(() => { window.destroy(); app.quit(); })
      .catch(error => { closing = false; window.webContents.send('single:finish-error', '本机位置尚未保存，窗口保持打开；原文件保留，请检查后重试。'); throw error; });
    return closing;
  }
  ipcMain.handle('single:finish', (event, ...extra) => { trusted(event); if(extra.length)throw new Error('INVALID_ACTION');return finish(); });
  ipcMain.handle('single:discard-and-finish', (event, confirmed, ...extra) => {
    trusted(event); if (confirmed !== true || extra.length || closing || !controller.status().discardAvailable) throw new Error('INVALID_ACTION'); return finish(true);
  });
  ipcMain.handle('single:home', (event, ...extra) => { trusted(event); if(extra.length)throw new Error('INVALID_ACTION');return; });
  window = new BrowserWindow({ width: 900, height: 760, minWidth: 780, minHeight: 690,
    title: `头歌学习助手 · 本地单视频验收 · ${app.getVersion()}`,
    webPreferences: { preload: path.join(root, 'preload.cjs'), nodeIntegration: false, contextIsolation: true, sandbox: true } });
  window.setMenuBarVisibility(false);
  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  window.webContents.on('will-navigate', (event, url) => { if (url !== entry) event.preventDefault(); });
  window.on('close', event => {
    event.preventDefault(); finish().catch(() => {});
  });
  app.on('before-quit', event => { if (!window.isDestroyed()) { event.preventDefault(); window.close(); } });
  await window.loadFile(path.join(root, 'ui/index.html'));
  }).catch(error => {
    console.error('Single-video entry failed to start:', error.message);
    app.exit(1);
  });
}
