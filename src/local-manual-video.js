import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { SingleController, playbackFailure } from './local-single-video/controller.mjs';
import { PositionStore } from './local-single-video/position-store.mjs';
import { resolveScannedSelection, targetKey, targetUrl } from './local-single-video/target.mjs';
import { trustedAcceptanceCaller } from './local-single-video-launcher.js';
import { createAppearanceStore } from './appearance.js';
import { createPlaybackOptionsStore, defaultPlaybackOptions } from './local-single-video/playback-options.mjs';
import { PersonalQueueStore, resolvePersonalQueue } from './personal-queue-store.mjs';
import { PersonalQueueController } from './personal-queue-controller.mjs';
const root = fileURLToPath(new URL('./local-single-video/', import.meta.url));
const entry = new URL('./local-single-video/ui/index.html', import.meta.url).href;

export function registerManualVideoDesktop({ app, ipcMain, BrowserWindow, window, getRuntime,
  controllerFactory = options => new SingleController(options) }) {
  const appData = app.getPath('appData');
  const appearance = createAppearanceStore(path.join(app.getPath('userData'), 'appearance.json'));
  const playbackStore = createPlaybackOptionsStore(path.join(app.getPath('userData'), 'manual-playback-options.json'));
  const dataDir = path.join(appData, 'EducoderManualVideoPlayer');
  const store = new PositionStore({ directory: path.join(dataDir, 'positions'),
    legacyFile: path.join(appData, 'EducoderSingleVideoAcceptance/observed-position.json') });
  const queueStore = new PersonalQueueStore(path.join(dataDir, 'personal-temporary-queue.json'));
  let viewer = null, controller = null, selection = null, opening = null, closing = null, activeKey = null, cleanupTransaction = null;
  let pendingAction = Promise.resolve(), actionRunning = false, revision = 0, message = '', stopped = false, finishError = '';
  let embedded = false, playbackOptions = { ...defaultPlaybackOptions }, coldOptionsError = false;
  let replacement = null, stopGeneration = 0, completedSession = null, failure = null;
  const playbackReady = playbackStore.get().then(value => { playbackOptions = value; }).catch(() => { coldOptionsError = true; });
  const recordFailure = code => ['RECORD_CHANGED', 'RECORD_INVALID', 'LEGACY_RECORD_INVALID', 'QUEUE_RECORD_CHANGED', 'QUEUE_RECORD_INVALID'].includes(code);
  const alive = target => target && !target.isDestroyed?.() && !target.webContents.isDestroyed?.();
  const send = (target, name, value) => { if (alive(target)) { try { target.webContents.send?.(name, value); } catch {} } };
  const focus = target => { if (alive(target)) { target.restore(); target.show(); target.focus(); } };
  const trustedMain = (event, extra = []) => {
    if (extra.length || !trustedAcceptanceCaller(event, window, getRuntime()?.origin)) throw new Error('请从主程序操作观看会话。');
  };
  const trustedViewer = event => {
    if (!alive(viewer) || event.sender !== viewer.webContents || event.senderFrame !== viewer.webContents.mainFrame
      || event.senderFrame.url !== entry) throw new Error('本地观看操作只能来自当前观看窗口');
  };
  const trustedAppearance = event => {
    if (trustedAcceptanceCaller(event, window, getRuntime()?.origin)) return;
    trustedViewer(event);
  };
  const publicSelection = target => target ? { courseUrl: targetUrl(target), page: target.page, index: target.index, title: target.title,
    ...(target.cardIdentity ? { cardIdentity: target.cardIdentity } : {}) } : null;
  const publicCode = value => value ? playbackFailure({ code: value }).code : null;
  const publicQueueReason = value => ['USER_PAUSED', 'APP_REOPENED', ''].includes(value) ? value : publicCode(value);
  const completionPending = () => Boolean(embedded && (controller?.pendingCompletion
    || controller?.completionConfirmed && controller.record.cursor === controller.targets.length));
  function rememberFailure(error, operation, target = controller?.single?.target
    ?? controller?.targets?.[Math.min(controller.record.cursor, controller.targets.length - 1)] ?? selection) {
    failure = { ...playbackFailure(error), operation, selection: publicSelection(target) };
    message = failure.message;
  }
  function session() {
    const state = controller?.status(), queue = state?.queue ?? completedSession?.queue;
    const current = queue ? controller?.single?.target
      ?? controller?.targets?.[Math.min(controller.record.cursor, controller.targets.length - 1)] ?? selection ?? completedSession?.selection : selection;
    const currentIndex = controller?.targets && current
      ? controller.targets.findIndex(target => targetKey(target) === targetKey(current)) : queue?.currentIndex ?? null;
    const media = state?.media ? Object.fromEntries(['currentTime','duration','paused','ended','playbackRate','muted','volume','readyState','officialWatched','officialTotal','mediaErrorCode']
      .filter(key => state.media[key] !== undefined).map(key => [key, state.media[key]])) : null;
    return { active: Boolean(controller || cleanupTransaction || replacement), embedded, mode: queue?.mode ?? (controller ? 'single' : null),
      viewerOpen: Boolean(alive(viewer)), opening: Boolean(opening || replacement), replacing: Boolean(replacement), closing: Boolean(closing), busy: actionRunning || Boolean(state?.busy),
      completed: Boolean(completedSession && !controller && !cleanupTransaction && !replacement), completionPending: completionPending(), failure,
      selection: current?.classroomId ? publicSelection(current) : current ?? null, stage: state?.stage ?? (completedSession ? 'completed' : 'not-open'),
      nextSelection: controller?.targets && queue && currentIndex >= 0 && currentIndex + 1 < controller.targets.length ? publicSelection(controller.targets[currentIndex + 1]) : null,
      media, percent: state?.percent ?? completedSession?.percent ?? null, resumeSeconds: state?.resumeSeconds ?? completedSession?.resumeSeconds ?? 0,
      confirmedWatchedSeconds: state?.confirmedWatchedSeconds ?? completedSession?.confirmedWatchedSeconds ?? 0, confirmedWatchedPrefix: state?.confirmedWatchedPrefix ?? completedSession?.confirmedWatchedPrefix ?? 0,
      restoreAvailable: Boolean(state?.restoreAvailable), restoreSkipped: Boolean(state?.restoreSkipped), restoreHint: state?.restoreHint ?? '',
      playAllowed: Boolean(state?.playAllowed), playBlockedReason: publicCode(state?.playBlockedReason),
      actionsAvailable: Boolean(state?.actionsAvailable && !cleanupTransaction), optionsAvailable: state?.optionsAvailable ?? true,
      optionsError: state?.optionsError ?? coldOptionsError, playbackOptions: { ...(state?.playbackOptions ?? playbackOptions) },
      controls: { mute: Boolean(state?.controls?.mute), rates: [...(state?.controls?.rates ?? [])] }, optionsHint: state?.optionsHint ?? '',
      discardAvailable: Boolean(state?.discardAvailable && !(cleanupTransaction && controller?.canDiscardSaveFailure?.()) || recordFailure(finishError)),
      officialFocusAvailable: Boolean(state?.officialFocusAvailable), actionError: failure?.code ?? publicCode(state?.actionError),
      queue: queue ? { courseUrl: queue.courseUrl, active: queue.active, phase: queue.phase, reason: publicQueueReason(queue.reason),
        retrying: queue.retrying, waiting: queue.waiting, retryReason: publicCode(queue.retryReason), retryAttempts: queue.retryAttempts, retryDelayMs: queue.retryDelayMs,
        mode: queue.mode, cursor: queue.cursor, currentIndex, total: queue.total, completed: queue.completed, message: queue.message,
        selections: controller?.targets?.map(publicSelection) ?? queue.selections } : null,
      message: message || queue?.message || state?.message || '', revision, version: app.getVersion() };
  }
  function publish() {
    ++revision;
    const summary = session();
    getRuntime()?.controller.setViewingSession?.(summary);
    send(window, 'local-manual-video:session-changed', summary);
    return summary;
  }
  function assertIdle() {
    const rootController = getRuntime()?.controller;
    if (!rootController || rootController.isTaskActive?.()
      || ['inventory-scanning', 'preparing', 'playing', 'scanning', 'stopping'].includes(rootController.getStatus().phase)) throw new Error('SCAN_BUSY');
  }
  function assertCanCreate() {
    if (stopped || closing) throw new Error('观看窗口正在结束或保存，请稍后重试。');
    if (actionRunning) throw new Error('请等待当前操作完成');
    assertIdle();
  }
  const notifyQueue = (state, owner = controller) => {
    if (owner !== controller) return;
    if (state.active && (!state.reason || state.retrying)) { failure = null; message = ''; }
    else if (state.reason && !['USER_PAUSED', 'APP_REOPENED', 'QUEUE_STOPPED'].includes(state.reason))
      rememberFailure(controller?.lastError ?? new Error(state.reason), 'playback');
    send(window, 'personal-queue:changed', { ...state, reason: publicQueueReason(state.reason), selections: controller?.targets?.map(publicSelection) ?? [] }); publish();
    const queue = controller;
    if (!embedded || !queue?.completionConfirmed || state.active || state.phase !== 'completed' || queue.autoFinishScheduled) return;
    queue.autoFinishScheduled = true;
    Promise.resolve().then(async () => {
      await queue.job?.catch(() => {});
      await opening?.promise.catch(() => {});
      if (controller !== queue || cleanupTransaction || replacement || closing || stopped || queue.record.phase !== 'completed') return;
      await finish(false, { naturalCompletion: true });
    }).catch(() => {});
  };
  async function makeSingle(target) {
    const single = controllerFactory({ dataDir, appData, target, positionStore: store, playbackStore,
      connectExistingBridge: false, sessionProvider: () => getRuntime().controller.getManualSession(),
      nativeScript: app.isPackaged ? path.join(process.resourcesPath, 'local-single-video-native-control.ps1')
        : path.join(root, 'local-single-video-native-control.ps1') });
    try { await single.init(); return single; }
    catch (error) { await single.dispose().catch(() => {}); throw error; }
  }
  async function cleanupFailedStart(transaction, discardUnsavedPosition = false) {
    controller?.requestStop?.();
    let failure;
    if (!transaction.disposeComplete) {
      try {
        await controller?.dispose({ discardUnsavedPosition, preserveQueueRecord: Boolean(transaction.staged),
          discardForRollbackConflict: discardUnsavedPosition && recordFailure(transaction.rollbackError?.code ?? transaction.rollbackError?.message) });
        transaction.disposeComplete = true;
      } catch (error) { failure = error; }
    }
    if (!transaction.rollbackComplete) {
      try {
        if (!discardUnsavedPosition || !recordFailure(transaction.rollbackError?.code ?? transaction.rollbackError?.message))
          await transaction.staged?.rollback();
        transaction.rollbackComplete = true; transaction.rollbackError = null;
      } catch (error) {
        transaction.rollbackError = error;
        if (!failure || recordFailure(error.code ?? error.message)) failure = error;
      }
    }
    if (failure) throw failure;
    if (cleanupTransaction === transaction) cleanupTransaction = null;
  }
  function operation(key, target, create, { inMain = false, begin, replacementToken } = {}) {
    if (replacement && replacementToken !== replacement) return Promise.reject(new Error('VIEWING_BUSY'));
    if (stopped || closing) return Promise.reject(new Error('观看窗口正在结束或保存，请稍后重试。'));
    if (cleanupTransaction) return Promise.reject(new Error('请先重试停止并保存当前播放，再重新选择。'));
    if (opening) {
      if (opening.key !== key) return Promise.reject(new Error(inMain || embedded ? '请先停止并保存当前播放，再重新选择。' : '请先等待打开完成，并在观看窗口点击「结束观看并返回课堂」，再选择另一条。'));
      return opening.promise.then(() => { focus(inMain ? window : viewer); return inMain ? session() : { opened: true, reused: true }; });
    }
    if (controller || alive(viewer)) {
      if (activeKey !== key) return Promise.reject(new Error(inMain || embedded ? '请先停止并保存当前播放，再重新选择。' : '请先在观看窗口点击「结束观看并返回课堂」，再选择另一条视频或队列。'));
      focus(embedded ? window : viewer); return Promise.resolve(inMain ? session() : { opened: true, reused: true });
    }
    assertCanCreate();
    const transaction = { key, aborted: false, abort: new AbortController(), generation: stopGeneration, replacementToken };
    opening = transaction; selection = target; embedded = inMain; message = ''; finishError = ''; failure = null; completedSession = null; publish();
    transaction.promise = (async () => {
      try {
        controller = await create(transaction);
        checkOpening(transaction);
        selection ??= controller.targets?.[Math.min(controller.record.cursor, controller.targets.length - 1)];
        activeKey = key;
        if (inMain) {
          await begin(controller, transaction);
          checkOpening(transaction);
          return session();
        }
        const nextViewer = new BrowserWindow({ width: 900, height: 800, minWidth: 720, minHeight: 600,
          title: `头歌学习助手 · 观看所选视频 · ${app.getVersion()}`, parent: window,
          webPreferences: { preload: path.join(root, 'preload.cjs'), nodeIntegration: false, contextIsolation: true, sandbox: true } });
        viewer = nextViewer;
        viewer.setMenuBarVisibility(false);
        viewer.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
        viewer.webContents.on('will-navigate', (event, url) => { if (url !== entry) event.preventDefault(); });
        viewer.on('close', event => { event.preventDefault(); finish().catch(() => {}); });
        viewer.once('closed', () => {
          if (viewer !== nextViewer) return;
          viewer = null; finish().catch(() => {});
        });
        await viewer.loadFile(path.join(root, 'ui/index.html'));
        if (transaction.aborted || stopped || closing) throw new Error('CLOSING');
        focus(viewer);
        return { opened: true, reused: false };
      } catch (error) {
        rememberFailure(error, 'start');
        try {
          cleanupTransaction = transaction;
          await cleanupFailedStart(transaction);
          controller = null; selection = null; activeKey = null; embedded = false;
          const failedViewer = viewer; viewer = null;
          if (alive(failedViewer)) failedViewer.destroy();
        }
        catch (failure) {
          finishError = failure.code ?? failure.message;
          rememberFailure(failure, 'save');
        }
        throw error;
      } finally { if (opening === transaction) opening = null; publish(); }
    })();
    return transaction.promise.then(result => inMain ? session() : result);
  }
  function finish(discardUnsavedPosition = false, { replacementToken = null, naturalCompletion = false } = {}) {
    // Invalidate first, including calls that share an already-running save.
    const canceledReplacement = replacementToken ? null : replacement;
    if (!replacementToken) {
      ++stopGeneration;
      if (replacement) { replacement.aborted = true; replacement.abort.abort(); }
    }
    if (opening) { opening.aborted = true; opening.abort.abort(); }
    controller?.requestStop?.();
    const waitForCanceled = result => canceledReplacement
      ? result.then(async value => { await canceledReplacement.promise?.catch(() => {}); return value; }) : result;
    if (closing) return waitForCanceled(closing);
    closing = Promise.resolve().then(async () => {
      await opening?.promise.catch(() => {});
      controller?.requestStop?.();
      await pendingAction.catch(() => {});
      const completing = !discardUnsavedPosition && completionPending();
      const finished = completing ? session() : null;
      try {
        if (cleanupTransaction) await cleanupFailedStart(cleanupTransaction, discardUnsavedPosition);
        else await controller?.dispose({ discardUnsavedPosition });
      }
      catch (error) {
        finishError = error.code ?? error.message;
        rememberFailure(error, completing || naturalCompletion ? 'complete' : 'save');
        send(viewer, 'single:finish-error', message); focus(embedded ? window : viewer); throw error;
      }
      const persistedCompletion = completing ? session() : null;
      completedSession = completing ? { selection: persistedCompletion.selection, queue: { ...persistedCompletion.queue, active: false, phase: 'completed', reason: '', message: '' },
        percent: 100, resumeSeconds: persistedCompletion.resumeSeconds, confirmedWatchedSeconds: persistedCompletion.confirmedWatchedSeconds, confirmedWatchedPrefix: persistedCompletion.confirmedWatchedPrefix } : null;
      controller = null; selection = null; activeKey = null; embedded = false; message = ''; finishError = ''; failure = null;
      const previousViewer = viewer; viewer = null;
      if (alive(previousViewer)) previousViewer.destroy();
      if (!replacementToken) send(window, 'local-manual-video:closed', { discarded: discardUnsavedPosition, completed: completing, selection: finished?.selection ?? null });
      focus(window);
    }).finally(() => { closing = null; publish(); });
    publish(); return waitForCanceled(closing);
  }
  function action(run) {
    if (opening || replacement || closing || cleanupTransaction || actionRunning || !controller) throw new Error('请等待当前操作完成');
    actionRunning = true; publish();
    pendingAction = Promise.resolve().then(() => { failure = null; message = ''; return run(); })
      .catch(error => { rememberFailure(error, 'action'); throw error; }).finally(() => { actionRunning = false; publish(); });
    return pendingAction;
  }
  function assertDiscardSaveFailureIdle() {
    if (recordFailure(finishError)) return;
    if (controller?.canDiscardSaveFailure?.() && (opening || replacement || closing || actionRunning || cleanupTransaction
      || controller.active || controller.starting || controller.busy || controller.single?.busy)) throw new Error('INVALID_ACTION');
  }
  const checkOpening = transaction => {
    if (transaction.aborted || transaction.abort.signal.aborted || transaction.generation !== stopGeneration
      || transaction.replacementToken?.aborted || stopped || closing) throw new Error('CLOSING');
  };
  async function requireCurrent(queue, name, transaction) {
    if (transaction) checkOpening(transaction);
    const state = await queue.bounded(queue.act(name));
    if (transaction) checkOpening(transaction);
    if (state.actionError) throw new Error(publicCode(state.actionError));
    return state;
  }
  async function awaitPlaying(queue, transaction) {
    // The queue owns bounded official operations and cancellable recovery.
    // Do not impose another cumulative timeout on an otherwise valid start.
    while (true) {
      if (transaction) checkOpening(transaction);
      const state = queue.status();
      if (state.queue.phase === 'completed' || (state.queue.active && state.queue.retrying) || (state.queue.phase === 'playing' && state.media && !state.media.paused && !state.media.ended)) return;
      if (!queue.active) throw new Error(publicCode(state.queue.reason) ?? 'PLAY_NOT_STARTED');
      await new Promise(resolve => setTimeout(resolve, 20));
    }
  }
  ipcMain.handle('local-manual-video:status', async (event, ...extra) => { trustedMain(event, extra); await playbackReady; return session(); });
  ipcMain.handle('local-manual-video:playback-options', async (event, ...extra) => {
    trustedMain(event, extra); const value = await playbackStore.get(); playbackOptions = value; coldOptionsError = false; return value;
  });
  ipcMain.handle('local-manual-video:position', async (event, request, ...extra) => {
    trustedMain(event, extra);
    const target = resolveScannedSelection(getRuntime().controller.getInventory(), request);
    const recent = await store.recentForTargets([target]);
    return { seconds: recent?.seconds ?? 0, selection: publicSelection(target) };
  });
  ipcMain.handle('local-manual-video:start', async (event, request, ...extra) => {
    trustedMain(event, extra);
    if (!request || typeof request !== 'object' || Array.isArray(request)
      || Object.keys(request).some(key => !['mode','courseUrl','selections','fromBeginning','resumeSaved','replaceCurrent'].includes(key))
      || !['single','continuous'].includes(request.mode) || request.courseUrl !== getRuntime().controller.getInventory()?.courseUrl
      || (request.fromBeginning !== undefined && typeof request.fromBeginning !== 'boolean')
      || (request.resumeSaved !== undefined && typeof request.resumeSaved !== 'boolean')
      || (request.replaceCurrent !== undefined && typeof request.replaceCurrent !== 'boolean')) throw new Error('QUEUE_SCAN_REQUIRED');
    const plan = { ...resolvePersonalQueue(getRuntime().controller.getInventory(), request.selections), mode: request.mode };
    if (request.mode === 'single' && plan.targets.length !== 1) throw new Error('QUEUE_SCAN_REQUIRED');
    const key = `embedded:${request.mode}:${JSON.stringify(plan.targets.map(publicSelection))}:${request.fromBeginning === true}:${request.resumeSaved === true}`;
    const start = replacementToken => operation(key, null, async transaction => {
      const staged = await queueStore.stage(plan, { resume: request.resumeSaved === true }); transaction.staged = staged;
      checkOpening(transaction);
      selection = plan.targets[Math.min(staged.record.cursor, plan.targets.length - 1)];
      return makeQueue(staged.record, plan.targets, staged.store, true, request.fromBeginning === true);
    }, { inMain: true, replacementToken, begin: async (queue, transaction) => {
      checkOpening(transaction); await queue.start(); await awaitPlaying(queue, transaction);
      await transaction.staged.commit({ signal: transaction.abort.signal }); checkOpening(transaction);
    } });
    if (replacement) {
      if (request.replaceCurrent !== true || replacement.key !== key || replacement.aborted) throw new Error('VIEWING_BUSY');
      return replacement.promise.then(() => session());
    }
    if (request.replaceCurrent !== true || !(controller || opening || cleanupTransaction || alive(viewer))) return start();
    if (stopped || closing) throw new Error('CLOSING');
    assertIdle();
    const token = { key, generation: stopGeneration, aborted: false, abort: new AbortController() };
    replacement = token;
    token.promise = Promise.resolve().then(async () => {
      await finish(false, { replacementToken: token });
      if (token.aborted || token.abort.signal.aborted || token.generation !== stopGeneration || stopped || closing) throw new Error('CLOSING');
      return start(token);
    }).finally(() => { if (replacement === token) replacement = null; publish(); });
    publish();
    return token.promise.then(() => session());
  });
  ipcMain.handle('local-manual-video:action', (event, name, ...extra) => {
    trustedMain(event, extra);
    if (!embedded || !['pause','continue','official','refresh'].includes(name)) throw new Error('INVALID_ACTION');
    if (replacement || opening || cleanupTransaction || actionRunning) throw new Error('VIEWING_BUSY');
    if (name === 'continue' && completionPending() && !controller.active) return finish(false, { naturalCompletion: true }).then(() => session());
    return action(async () => {
      if (name === 'pause') await controller.pause();
      else if (name === 'continue') {
        if (controller.record.cursor < controller.targets.length) {
          if (closing || stopped) throw new Error('CLOSING');
          await controller.start(); await awaitPlaying(controller);
        }
      } else if (name === 'official') {
        if (!controller.single) throw new Error('OPEN_FIRST');
        const state = await controller.single.act('official'); if (state.actionError) throw new Error(publicCode(state.actionError));
      } else await requireCurrent(controller, 'refresh');
      return session();
    }).then(() => session());
  });
  ipcMain.handle('local-manual-video:options', async (event, patch, ...extra) => {
    trustedMain(event, extra);
    if (stopped || opening || replacement || closing || cleanupTransaction || actionRunning || controller?.personalQueue && controller.active) throw new Error('请先暂停播放，再修改播放设置。');
    actionRunning = true; publish();
    pendingAction = Promise.resolve().then(async () => {
      await playbackReady;
      if (controller?.single || controller && !controller.personalQueue) {
        const changed = await controller.changePlaybackOptions(patch);
        if (changed.actionError) throw new Error(publicCode(changed.actionError));
      }
      else await playbackStore.set(patch);
      playbackOptions = await playbackStore.get(); coldOptionsError = false;
    }).finally(() => { actionRunning = false; publish(); });
    await pendingAction; return session();
  });
  ipcMain.handle('local-manual-video:finish', (event, ...extra) => { trustedMain(event, extra); return finish().then(() => session()); });
  ipcMain.handle('local-manual-video:discard-and-finish', (event, confirmed, ...extra) => {
    trustedMain(event, extra);
    if (confirmed !== true || closing || !controller || !session().discardAvailable) throw new Error('INVALID_ACTION');
    assertDiscardSaveFailureIdle();
    return finish(true).then(() => session());
  });
  ipcMain.handle('appearance:get', event => { trustedAppearance(event); return appearance.get(); });
  ipcMain.handle('appearance:set', async (event, mode, ...extra) => {
    trustedMain(event, extra);
    const theme = await appearance.set(mode);
    for (const target of [window, viewer]) send(target, 'appearance:changed', theme);
    return theme;
  });
  ipcMain.handle('local-manual-video:session', (event, ...extra) => { trustedMain(event, extra); return session(); });
  ipcMain.handle('local-manual-video:focus', (event, ...extra) => { trustedMain(event, extra); focus(viewer); });
  ipcMain.handle('local-manual-video:open', async (event, request, ...extra) => {
    trustedMain(event, extra);
    const target = resolveScannedSelection(getRuntime().controller.getInventory(), request);
    return operation(`single:${targetKey(target)}`, target, () => makeSingle(target));
  });
  ipcMain.handle('local-manual-video:recent', async (event, courseUrl, ...extra) => {
    trustedMain(event, extra);
    const snapshot = getRuntime().controller.getInventory();
    if (!snapshot || snapshot.courseUrl !== courseUrl || !Array.isArray(snapshot.items)) return null;
    const targets = snapshot.items.map(item => resolveScannedSelection(snapshot, { courseUrl, page: item.page, index: item.index,
      title: item.title, ...(item.cardIdentity ? { cardIdentity: item.cardIdentity } : {}) }));
    const recent = await store.recentForTargets(targets);
    return recent ? { seconds: recent.seconds, selection: publicSelection(recent.target) } : null;
  });
  ipcMain.handle('personal-queue:summary', async (event, ...extra) => {
    trustedMain(event, extra); if (controller?.personalQueue) return session().queue;
    const saved = await queueStore.read();
    return saved ? { courseUrl: saved.courseUrl, total: saved.selections.length, cursor: saved.cursor, active: false,
        mode: saved.mode ?? (saved.selections.length === 1 ? 'single' : 'continuous'), phase: saved.cursor === saved.selections.length ? 'completed' : 'paused',
      selections: saved.selections.map(({ courseUrl, page, index, title, cardIdentity }) => ({ courseUrl, page, index, title, ...(cardIdentity ? { cardIdentity } : {}) })) } : null;
  });
  ipcMain.handle('personal-queue:focus', (event, ...extra) => { trustedMain(event, extra); focus(viewer); });
  function makeQueue(record, targets, queuePersistence = queueStore, inMain = false, fromBeginning = true) {
    const queue = new PersonalQueueController({ store: queuePersistence, record, targets, createSingle: makeSingle,
      onState: state => notifyQueue(state, queue), assertRootIdle: assertIdle, prepareNextFromBeginning: inMain && fromBeginning, prepareNextFromSaved: inMain && !fromBeginning });
    controller = queue;
    return queue.init().then(() => queue);
  }
  ipcMain.handle('personal-queue:open', async (event, request, ...extra) => {
    trustedMain(event, extra);
    const snapshot = getRuntime().controller.getInventory();
    if (!request || typeof request !== 'object' || Object.keys(request).some(key => !['courseUrl', 'selections', 'replace'].includes(key))
      || request.courseUrl !== snapshot?.courseUrl || (request.replace !== undefined && typeof request.replace !== 'boolean')) throw new Error('QUEUE_SCAN_REQUIRED');
    let plan = resolvePersonalQueue(snapshot, request.selections);
    if (!request.replace && !opening && !controller && !alive(viewer)) {
      assertCanCreate();
      const saved = await queueStore.read();
      if (saved && !opening && !controller && !alive(viewer)) {
        assertCanCreate();
        throw new Error('QUEUE_REPLACE_REQUIRED');
      }
      plan = resolvePersonalQueue(getRuntime().controller.getInventory(), request.selections);
    }
    const key = `queue:${plan.targets.map(targetKey).join(':')}`;
    return operation(key, plan.targets[0], async () => makeQueue(await queueStore.create(plan, { replace: request.replace === true }), plan.targets));
  });
  ipcMain.handle('personal-queue:resume', async (event, ...extra) => {
    trustedMain(event, extra);
    if (alive(viewer) && controller?.personalQueue && !closing) { focus(viewer); return { opened: true, reused: true }; }
    return operation('queue:resume', null, async () => {
      const record = await queueStore.read(); if (!record) throw new Error('QUEUE_EMPTY');
      const plan = resolvePersonalQueue(getRuntime().controller.getInventory(), record.selections);
      selection = plan.targets[Math.min(record.cursor, plan.targets.length - 1)];
      return makeQueue(record, plan.targets);
    });
  });
  ipcMain.handle('single:queue-action', (event, name, ...extra) => {
    trustedViewer(event);
    if (extra.length || !controller?.personalQueue || !['start', 'pause', 'stop'].includes(name)) throw new Error('QUEUE_ACTION_INVALID');
    return action(() => name === 'start' ? controller.start() : controller.pause(name === 'stop'));
  });
  ipcMain.handle('single:status', (event, ...extra) => {
    trustedViewer(event); if (extra.length) throw new Error('INVALID_ACTION');
    const state = controller.status();
    return { ...state, discardAvailable: Boolean(state.discardAvailable || recordFailure(finishError)),
      closing: Boolean(closing), sessionMessage: message, version: app.getVersion(), canReturnHome: true };
  });
  ipcMain.handle('single:action', (event, name, ...extra) => {
    trustedViewer(event); if (extra.length) throw new Error('INVALID_ACTION');
    return action(() => controller.act(name));
  });
  ipcMain.handle('single:options', (event, patch, ...extra) => {
    trustedViewer(event); if (extra.length) throw new Error('INVALID_ACTION');
    return action(() => controller.changePlaybackOptions(patch));
  });
  ipcMain.handle('single:home', (event, ...extra) => { trustedViewer(event); if (extra.length) throw new Error('INVALID_ACTION'); focus(window); });
  ipcMain.handle('single:finish', (event, ...extra) => { trustedViewer(event); if (extra.length) throw new Error('INVALID_ACTION'); return finish(); });
  ipcMain.handle('single:discard-and-finish', (event, confirmed, ...extra) => {
    trustedViewer(event);
    if (confirmed !== true || extra.length || closing || !controller
      || !(controller.status().discardAvailable || recordFailure(finishError))) throw new Error('INVALID_ACTION');
    assertDiscardSaveFailureIdle();
    return finish(true);
  });
  window.once('closed', () => {
    stopped = true; finish().catch(() => {});
    for (const name of ['personal-queue:summary', 'personal-queue:focus', 'personal-queue:open', 'personal-queue:resume', 'single:queue-action',
      'local-manual-video:recent', 'local-manual-video:open', 'local-manual-video:session', 'local-manual-video:focus',
      'local-manual-video:status', 'local-manual-video:playback-options', 'local-manual-video:position', 'local-manual-video:start',
      'local-manual-video:action', 'local-manual-video:options', 'local-manual-video:finish', 'local-manual-video:discard-and-finish',
      'single:status', 'single:action', 'single:options', 'single:home', 'single:finish', 'single:discard-and-finish', 'appearance:get', 'appearance:set']) ipcMain.removeHandler(name);
  });
  return { close() { return finish().then(() => { stopped = true; }); } };
}
