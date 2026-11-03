import { spawn } from 'node:child_process';

export const localSingleVideoFlag = '--local-single-video-acceptance';
export function acceptanceInvocation({ executablePath, projectRoot, defaultApp = false }) {
  return { executablePath, args: [...(defaultApp ? [projectRoot] : []), localSingleVideoFlag] };
}
export function trustedAcceptanceCaller(event, window, origin) {
  if (!origin || event.sender !== window?.webContents
    || event.senderFrame !== window.webContents.mainFrame) return false;
  try {
    const expected = new URL(origin);
    return expected.protocol === 'http:' && expected.hostname === '127.0.0.1'
      && new URL(event.senderFrame.url).href === expected.href
      && new URL(window.webContents.getURL()).href === expected.href;
  } catch { return false; }
}
export function registerLocalSingleVideo({ ipcMain, window, getRuntime, executablePath, projectRoot,
  defaultApp = false, spawnImpl = spawn }) {
  ipcMain.handle('local-single-video:open', async (event, ...args) => {
    if (args.length || !trustedAcceptanceCaller(event, window, getRuntime()?.origin)) {
      throw new Error('本地单视频验收只能从桌面工作台打开');
    }
    const invocation = acceptanceInvocation({ executablePath, projectRoot, defaultApp });
    await new Promise((resolve, reject) => {
      const child = spawnImpl(invocation.executablePath, invocation.args, {
        windowsHide: true, stdio: 'ignore', detached: false,
      });
      child.once('spawn', () => { child.unref(); resolve(); });
      child.once('error', () => reject(new Error('本地验收窗口暂未打开，请稍后重试')));
    });
    return { opened: true };
  });
  window.once('closed', () => ipcMain.removeHandler('local-single-video:open'));
}
