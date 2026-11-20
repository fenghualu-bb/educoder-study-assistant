import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { SingleController, playbackFailure } from './local-single-video/controller.mjs';
import { PositionStore } from './local-single-video/position-store.mjs';
import { resolveScannedSelection, targetKey, targetUrl } from './local-single-video/target.mjs';
import { trustedAcceptanceCaller } from './local-single-video-launcher.js';
import { createAppearanceStore } from './appearance.js';

const root = fileURLToPath(new URL('./local-single-video/', import.meta.url));
const entry = new URL('./local-single-video/ui/index.html', import.meta.url).href;
const actions = new Set(['official', 'open', 'play', 'pause', 'close-video', 'restore', 'refresh']);

export function registerManualVideoDesktop({ app, ipcMain, BrowserWindow, window, getRuntime,
  controllerFactory = options => new SingleController(options) }) {
  const appData = app.getPath('appData');
  const appearance = createAppearanceStore(path.join(app.getPath('userData'), 'appearance.json'));
  const dataDir = path.join(appData, 'EducoderManualVideoPlayer');
  const store = new PositionStore({
    directory: path.join(dataDir, 'positions'),
    legacyFile: path.join(appData, 'EducoderSingleVideoAcceptance/observed-position.json'),
  });
  let viewer, controller, selection, activeKey, opening, closing, pendingAction, finishError;
  let stopped = false;
  let revision = 0;

  const alive = target => target && !target.isDestroyed?.() && !target.webContents.isDestroyed?.();
  const send = (target, channel, value) => {
    if (alive(target)) {
      try { target.webContents.send?.(channel, value); } catch { /* The window may close before delivery. */ }
    }
  };
  const focus = target => {
    if (!alive(target)) return;
    target.restore();
    target.show();
    target.focus();
  };
  const trustedMain = (event, extra) => {
    if (extra.length || !trustedAcceptanceCaller(event, window, getRuntime()?.origin)) throw new Error('请从主程序操作观看会话。');
  };
  const trustedViewer = (event, extra) => {
    if (extra.length || !alive(viewer) || event.sender !== viewer.webContents || event.senderFrame !== viewer.webContents.mainFrame
      || event.senderFrame.url !== entry) throw new Error('本地观看操作只能来自当前观看窗口');
  };
  const canDiscard = () => controller?.status().discardAvailable
    || ['RECORD_CHANGED', 'RECORD_INVALID', 'LEGACY_RECORD_INVALID'].includes(finishError?.code);

  function session() {
    return {
      active: Boolean(controller),
      viewerOpen: Boolean(alive(viewer)),
      opening: Boolean(opening),
      closing: Boolean(closing),
      selection: selection ?? null,
      stage: controller?.status().stage ?? 'not-open',
      message: finishError?.message ?? '',
      revision,
      version: app.getVersion(),
    };
  }

  function publish() {
    revision++;
    const summary = session();
    getRuntime()?.controller.setViewingSession?.(summary);
    send(window, 'local-manual-video:session-changed', summary);
  }

  function clearViewer() {
    const previous = viewer;
    viewer = null;
    controller = null;
    selection = null;
    activeKey = null;
    finishError = null;
    if (alive(previous)) previous.destroy();
  }

  function open(target, request) {
    if (stopped || closing) throw new Error('观看窗口正在结束或保存，请稍后重试。');
    if (controller) {
      if (targetKey(target) !== activeKey) throw new Error('请先结束观看并返回课堂，再选择另一条。');
      if (opening) return opening.then(() => { focus(viewer); return { opened: true, reused: true }; });
      focus(viewer);
      return { opened: true, reused: true };
    }
    const runtime = getRuntime().controller;
    if (runtime.isTaskActive?.()) throw new Error('SCAN_BUSY');
    selection = { ...request, courseUrl: targetUrl(target) };
    activeKey = targetKey(target);
    controller = controllerFactory({
      dataDir, appData, target, positionStore: store, connectExistingBridge: false,
      sessionProvider: () => getRuntime().controller.getManualSession(),
      nativeScript: app.isPackaged ? path.join(process.resourcesPath, 'local-single-video-native-control.ps1')
        : path.join(root, 'local-single-video-native-control.ps1'),
    });
    opening = Promise.resolve().then(async () => {
      await controller.init();
      if (stopped || closing) throw new Error('CLOSING');
      const next = new BrowserWindow({
        width: 900, height: 750, minWidth: 720, minHeight: 600,
        title: `头歌学习助手 · 观看所选视频 · ${app.getVersion()}`,
        parent: window,
        webPreferences: { preload: path.join(root, 'preload.cjs'), nodeIntegration: false, contextIsolation: true, sandbox: true },
      });
      viewer = next;
      next.setMenuBarVisibility(false);
      next.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
      next.webContents.on('will-navigate', (event, url) => { if (url !== entry) event.preventDefault(); });
      next.on('close', event => { event.preventDefault(); finish().catch(() => {}); });
      next.once('closed', () => { if (viewer === next) finish().catch(() => {}); });
      await next.loadFile(path.join(root, 'ui/index.html'));
      if (stopped || closing) throw new Error('CLOSING');
      focus(next);
      return { opened: true, reused: false };
    }).catch(async error => {
      try {
        await controller.dispose();
        clearViewer();
      } catch (saveError) {
        finishError = playbackFailure(saveError);
        send(viewer, 'single:finish-error', finishError.message);
      }
      throw error;
    }).finally(() => {
      opening = null;
      publish();
    });
    publish();
    return opening;
  }

  function finish(discardUnsavedPosition = false) {
    if (closing) return closing;
    controller?.requestStop?.();
    closing = Promise.resolve().then(async () => {
      await opening?.catch(() => {});
      await pendingAction?.catch(() => {});
      const hadController = Boolean(controller);
      await controller?.dispose({ discardUnsavedPosition });
      clearViewer();
      if (hadController) send(window, 'local-manual-video:closed', { discarded: discardUnsavedPosition });
      focus(window);
    }).catch(error => {
      finishError = playbackFailure(error);
      send(viewer, 'single:finish-error', finishError.message);
      focus(viewer);
      throw error;
    }).finally(() => {
      closing = null;
      publish();
    });
    publish();
    return closing;
  }

  const handlers = new Map([
    ['local-manual-video:open', async (event, request, ...extra) => {
      trustedMain(event, extra);
      const snapshot = getRuntime().controller.getInventory();
      if (!snapshot?.complete) throw new Error('请先完成当前课堂扫描。');
      const target = resolveScannedSelection(snapshot, request);
      return open(target, request);
    }],
    ['local-manual-video:session', (event, ...extra) => { trustedMain(event, extra); return session(); }],
    ['appearance:get', (event, ...extra) => {
      if (extra.length || !trustedAcceptanceCaller(event, window, getRuntime()?.origin)) trustedViewer(event, extra);
      return appearance.get();
    }],
    ['appearance:set', async (event, mode, ...extra) => {
      trustedMain(event, extra);
      const theme = await appearance.set(mode);
      send(window, 'appearance:changed', theme);
      send(viewer, 'appearance:changed', theme);
      return theme;
    }],
    ['single:status', (event, ...extra) => {
      trustedViewer(event, extra);
      return {
        ...controller.status(),
        discardAvailable: Boolean(canDiscard()),
        closing: Boolean(closing),
        sessionMessage: finishError?.message ?? '',
        version: app.getVersion(),
        canReturnHome: true,
      };
    }],
    ['single:action', (event, action, ...extra) => {
      trustedViewer(event, extra);
      if (!actions.has(action) || opening || closing || !controller || pendingAction) throw new Error('INVALID_ACTION');
      pendingAction = controller.act(action).finally(() => { pendingAction = null; });
      return pendingAction;
    }],
    ['single:home', (event, ...extra) => { trustedViewer(event, extra); focus(window); }],
    ['single:finish', (event, ...extra) => { trustedViewer(event, extra); return finish(); }],
    ['single:discard-and-finish', (event, confirmed, ...extra) => {
      trustedViewer(event, extra);
      if (confirmed !== true || closing || pendingAction || !controller || !canDiscard()) throw new Error('INVALID_ACTION');
      return finish(true);
    }],
  ]);
  for (const [channel, handle] of handlers) ipcMain.handle(channel, handle);
  window.once('closed', () => {
    stopped = true;
    finish().catch(() => {});
    for (const channel of handlers.keys()) ipcMain.removeHandler(channel);
  });
  return { close() { return finish().then(() => { stopped = true; }); } };
}
