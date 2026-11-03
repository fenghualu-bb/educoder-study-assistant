import { app, BrowserWindow, dialog, ipcMain } from 'electron';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { browserModeFromArgs, resolveDesktopBrowser } from './desktop-browser.js';
import { runDesktop } from './desktop-lifecycle.js';
import { localSingleVideoFlag } from './local-single-video-launcher.js';
import { registerManualVideoDesktop } from './local-manual-video.js';

if (process.argv.includes(localSingleVideoFlag)) {
  // A separate, explicitly labelled acceptance window; production runtime and permissions are not started.
  import('./local-single-video/main.mjs').catch(error => {
    process.stderr.write(`本地单视频验收未启动：${error.message}\n`);
    app.quit();
  });
} else {
const packageResourcesPath = app.isPackaged ? process.resourcesPath : undefined;
let browserMode = 'bundled';
try { browserMode = browserModeFromArgs(process.argv, { packageResourcesPath }); }
catch { /* The startup page handles invalid choices without launching a browser. */ }

runDesktop({
  app,
  BrowserWindow,
  browserMode,
  onSecondaryInstance: ({ version, message }) => dialog.showMessageBox({ type: 'info',
    title: `头歌学习助手 ${version} · 已有运行窗口`, buttons: ['知道了'], message }),
  onVersionConflict: ({ currentVersion, requestedVersion, window }) => dialog.showMessageBox(window, { type: 'info',
    title: `正在运行 ${currentVersion}`, buttons: ['知道了'],
    message: `当前窗口是 ${currentVersion} 候选版。刚打开的 ${requestedVersion} 没有新建窗口；请先自行关闭当前助手，再打开所需版本。已保存位置保留。` }),
  preloadPath: fileURLToPath(new URL('./desktop-preload.cjs', import.meta.url)),
  onWindowCreated: ({ window, getRuntime }) => registerManualVideoDesktop({ app, ipcMain, BrowserWindow, window, getRuntime }),
  modeFromCommandLine: commandLine => browserModeFromArgs(commandLine, {
    packageResourcesPath: app.isPackaged && commandLine[0]
      ? path.join(path.dirname(commandLine[0]), 'resources') : undefined,
  }),
  onModeConflict: ({ currentMode, requestedMode, window }) => {
    const name = mode => mode === 'edge' ? 'Edge 对照模式' : mode === 'bundled' ? '默认模式' : '无效浏览器模式';
    return dialog.showMessageBox(window, {
      type: 'warning', title: '请先关闭当前窗口', buttons: ['知道了'],
      message: `当前运行的是${name(currentMode)}。请先关闭它，再启动${name(requestedMode)}。`,
    });
  },
  resourcesPath: process.resourcesPath,
  projectRoot: fileURLToPath(new URL('../', import.meta.url)),
  startRuntime: async options => {
    process.env.PLAYWRIGHT_BROWSERS_PATH = options.browserRoot;
    const { chromium } = await import('playwright-core');
    const { browserPath, profileDir, dataDir } = resolveDesktopBrowser({
      args: process.argv, dataDir: options.dataDir,
      profileDir: options.profileDir, bundledPath: chromium.executablePath(),
      packageResourcesPath,
    });
    const { startLocalRuntime } = await import('./runtime.js');
    return startLocalRuntime({
      ...options, browserPath, profileDir, dataDir,
      ...(app.isPackaged ? { appVersion: app.getVersion() } : {}),
    });
  },
}).catch(error => {
  process.stderr.write(`桌面应用启动失败：${error.message}\n`);
  app.quit();
});
}
