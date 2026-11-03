import { randomUUID } from 'node:crypto';
import { runCourse } from './runner.js';
import { scanCourse } from './inventory.js';
import { compareLayout, layoutFromInventory } from './run-layout.js';
import { RunError, classifyRunError } from './run-error.js';
import { listMyClassrooms } from './classrooms.js';

function restoredStatus(run) {
  const events = run?.events ?? [];
  const completed = new Set(events.filter(event => event.type === 'verified'
    || (event.type === 'trial-reported' && event.status === 'consumed'))
    .map(event => `${event.page}:${event.index}:${event.title}`)).size;
  if (['running', 'interrupted'].includes(run?.phase)) return { phase: 'interrupted', completed };
  if (run?.phase === 'stopped') return { phase: 'stopped', completed };
  if (run?.phase === 'failed') {
    const failure = [...events].reverse().find(event => event.type === 'failed');
    return { phase: 'failed', completed, ...(failure?.code ? { errorCode: failure.code } : {}) };
  }
  return { phase: 'idle', completed: 0 };
}

export function createController({
  launch,
  makeCourse,
  run = runCourse,
  scanInventory = scanCourse,
  readClassrooms = listMyClassrooms,
  initialInventory = null,
  saveInventory = async () => {},
  initialRun = null,
  saveRun = async () => {},
  allowFullRun = false,
}) {
  let session = null;
  let activeTask = null;
  let controller = null;
  let status = restoredStatus(initialRun);
  const preserveRestoredStatus = ['stopped', 'failed'].includes(initialRun?.phase);
  let inventory = initialInventory;
  let runState = initialRun;
  let activeCourse = null;
  let openingSession = null;
  let closing = false;
  let shutdownPromise = null;
  let viewingSession = null;

  function assertViewingIdle() {
    if (!viewingSession?.active && !viewingSession?.viewerOpen && !viewingSession?.opening && !viewingSession?.closing) return;
    const error = new Error('请先停止并保存当前观看，再扫描、切换课堂或开始任务。');
    error.code = 'VIEWING_ACTIVE';
    error.statusCode = 409;
    throw error;
  }

  function assertOpen() {
    if (!closing) return;
    const error = new Error('应用正在关闭，不能开始新操作');
    error.statusCode = 409;
    throw error;
  }

  async function openSession() {
    if (!openingSession) openingSession = Promise.resolve().then(launch).then(next => {
      session = next;
      next.context?.once?.('close', () => {
        if (session !== next) return;
        session = null;
        if (!activeTask && status.phase === 'ready') status = { phase: 'idle', completed: 0, officialWindowClosed: true };
      });
      return next;
    });
    try { return await openingSession; } finally { openingSession = null; }
  }

  function requireSessionPage() {
    if (session && !session.page?.isClosed?.()) return;
    const error = new Error('官方窗口已关闭或尚未打开；请先打开头歌专用浏览器，在官方页面登录后重试。');
    error.statusCode = 400;
    throw error;
  }

  async function stopTask() {
    if (!controller) return;
    controller.abort();
    status = { ...status, phase: 'stopping' };
    await activeCourse?.cancel?.();
  }

  function shutdown() {
    if (shutdownPromise) return shutdownPromise;
    closing = true;
    shutdownPromise = (async () => {
      try {
        await stopTask();
        if (activeTask) await activeTask;
        if (openingSession) await openingSession.catch(() => {});
      } finally {
        await session?.context?.close();
        session = null;
      }
    })().catch(error => {
      shutdownPromise = null;
      throw error;
    });
    return shutdownPromise;
  }

  async function persist(next) {
    try { await saveRun(next); }
    catch (error) { throw new RunError('JOURNAL_WRITE_FAILED', '本机运行记录无法保存，已停止'); }
    runState = next;
  }

  async function setRunPhase(phase) {
    if (!runState) return;
    await persist({ ...runState, phase, updatedAt: new Date().toISOString() });
  }

  async function appendRunEvent(event) {
    const at = new Date().toISOString();
    await persist({ ...runState, events: [...runState.events, { ...event, at }], updatedAt: at });
  }

  async function startedAndVerified(snapshot, savedRun) {
    const key = item => `${item.page}:${item.index}:${item.title}`;
    const platformVerified = new Set(snapshot.items.filter(item => item.progress === 100).map(key));
    const selected = new Map(savedRun.events.filter(event => event.type === 'selected')
      .map(event => [key(event), event]));
    const loggedVerified = new Set(savedRun.events.filter(event => event.type === 'verified').map(key));
    for (const [identity, event] of selected) {
      if (!platformVerified.has(identity) || loggedVerified.has(identity)) continue;
      const at = new Date().toISOString();
      await persist({
        ...runState,
        events: [...runState.events, { type: 'verified', page: event.page, index: event.index, title: event.title, at }],
        updatedAt: at,
      });
      loggedVerified.add(identity);
    }
    return [...selected.keys()].filter(identity => platformVerified.has(identity)).length;
  }

  async function begin(listUrl, { maxVideos = 1, maxPages = Infinity, startPage = 1,
    mode = 'trial', resume = false, replaceInterrupted = false } = {}) {
    assertOpen();
    assertViewingIdle();
    if (!session) {
      const error = new Error('先打开头歌专用浏览器并在头歌登录');
      error.statusCode = 400;
      throw error;
    }
    if (activeTask) {
      const error = new Error('已有任务正在运行');
      error.statusCode = 409;
      throw error;
    }
    if (!resume && !replaceInterrupted && ['running', 'interrupted'].includes(runState?.phase)) {
      const error = new RunError('FEATURE_DISABLED', '存在中断任务；当前试运行不能覆盖其记录');
      error.statusCode = 409;
      throw error;
    }
    if (resume && (!runState || !['running', 'interrupted'].includes(runState.phase) || runState.courseUrl !== listUrl)) {
      throw new RunError('COURSE_CHANGED', '没有与当前课堂匹配的可恢复任务');
    }
    const course = makeCourse(session, listUrl);
    const shownInventory = inventory?.complete && inventory.courseUrl === listUrl ? inventory : null;
    activeCourse = course;
    controller = new AbortController();
    const signal = controller.signal;
    let ownsRun = false;
    status = { phase: 'preparing', completed: 0 };
    activeTask = (async () => {
      try {
        if (resume) {
          await setRunPhase('interrupted');
          ownsRun = true;
        }
        const snapshot = await scanInventory(course, { courseUrl: listUrl, signal });
        if (signal.aborted) throw new RunError('STOPPED', 'task stopped');
        if (!snapshot.complete) throw new RunError(snapshot.errorCode ?? 'SCAN_PARTIAL', snapshot.error || '课程扫描不完整，不能开始播放');
        let layout;
        try { layout = layoutFromInventory(snapshot); }
        catch (error) {
          if (error.message === 'SCAN_PARTIAL') throw new RunError('SCAN_PARTIAL', '扫描中有视频进度无法读取，已停止');
          throw new RunError('COURSE_CHANGED', '扫描到重复或无效的视频位置，已停止');
        }
        inventory = snapshot;
        await saveInventory(snapshot);
        if (signal.aborted) throw new RunError('STOPPED', 'task stopped');
        if (snapshot.courseUrl !== listUrl) throw new RunError('COURSE_CHANGED', '扫描的课堂与当前选择不一致');
        if (startPage > snapshot.pagesScanned) {
          throw new RunError('PAGE_LOAD_FAILED', '所选起始页不在本次扫描结果中，未开始播放');
        }
        if (!resume && (startPage > 1 || (Number.isFinite(maxPages) && maxPages > 1))
          && !shownInventory) {
          throw new RunError('COURSE_CHANGED', '请先完整扫描当前课堂，再选择试运行页码');
        }
        if (!resume && shownInventory) {
          let shownLayout;
          try { shownLayout = layoutFromInventory(shownInventory); }
          catch { throw new RunError('COURSE_CHANGED', '当前显示的课程清单已失效，请重新扫描'); }
          const comparison = compareLayout(shownLayout, snapshot);
          if (!comparison.ok) throw new RunError(comparison.code, '课程视频列表已变化，请核对新清单后重试');
        }
        if (resume) {
          const comparison = compareLayout(runState.layout, snapshot);
          if (!comparison.ok) throw new RunError(comparison.code, '课堂视频列表已变化，须重新确认');
          maxVideos = runState.limits.maxVideos ?? Infinity;
          maxPages = runState.limits.maxPages ?? Infinity;
          startPage = runState.limits.startPage ?? 1;
        }
        if (!Number.isInteger(startPage) || startPage < 1 || startPage > snapshot.pagesScanned) {
          throw new RunError('PAGE_LOAD_FAILED', '所选起始页不在本次扫描结果中，未开始播放');
        }
        if (!resume) {
          const now = new Date().toISOString();
          await persist({
            version: 1, runId: randomUUID(), courseUrl: listUrl, mode,
            limits: { maxVideos: Number.isFinite(maxVideos) ? maxVideos : null,
              maxPages: Number.isFinite(maxPages) ? maxPages : null,
              ...(startPage === 1 ? {} : { startPage }) },
            phase: 'running', layout, events: [], updatedAt: now,
          });
          ownsRun = true;
        }
        await course.prepare();
        if (signal.aborted) throw new RunError('STOPPED', 'task stopped');
        for (let page = 1; page < startPage; page++) {
          if (signal.aborted) throw new RunError('STOPPED', 'task stopped');
          if (!await course.nextPage()) throw new RunError('PAGE_LOAD_FAILED', `无法进入第 ${page + 1} 页`);
          status = { phase: 'scanning', page: page + 1, completed: 0 };
        }
        if (resume) await setRunPhase('running');
        const initialCompleted = resume ? await startedAndVerified(snapshot, runState) : 0;
        const result = await run(course, {
          signal, maxVideos, maxPages, startPage, initialCompleted, expectedLayout: runState.layout,
          onStatus: next => { status = { ...next }; },
          onEvent: appendRunEvent,
        });
        await setRunPhase(signal.aborted ? 'stopped' : 'complete');
        const finishPage = Number.isInteger(status.page) ? { page: status.page } : {};
        status = signal.aborted
          ? { phase: 'stopped', completed: result.completed, ...finishPage }
          : { phase: result.limitReached ? 'limit-reached' : result.pageLimitReached ? 'page-limit-reached' : 'complete',
            ...result, ...finishPage };
      } catch (error) {
        let errorCode = signal.aborted ? 'STOPPED' : classifyRunError(error);
        if (ownsRun && !(resume && ['SCAN_PARTIAL', 'COURSE_CHANGED'].includes(errorCode))) {
          try { await setRunPhase(errorCode === 'STOPPED' ? 'stopped' : 'failed'); }
          catch (saveError) { error = saveError; errorCode = classifyRunError(saveError); }
        }
        status = errorCode === 'COURSE_CHANGED' && (resume || !ownsRun)
          ? { phase: 'needs-confirmation', completed: status.completed ?? 0, errorCode, error: error.message }
          : errorCode === 'STOPPED'
            ? { phase: 'stopped', completed: status.completed ?? 0 }
            : { phase: 'failed', completed: status.completed ?? 0, errorCode, error: error.message };
      } finally {
        activeTask = null;
        activeCourse = null;
        controller = null;
      }
    })();
  }

  return {
    async openBrowser() {
      assertOpen();
      assertViewingIdle();
      if (session) {
        if (session.page?.isClosed?.()) {
          session.page = await session.context.newPage();
          try { await session.page.goto('https://www.educoder.net/classrooms', { waitUntil: 'domcontentloaded', timeout: 60_000 }); }
          catch { throw new RunError('PAGE_LOAD_FAILED', '官方课堂页面暂未加载，请检查网络后重新打开；本机记录保留。'); }
        }
        await session.page?.bringToFront();
        if (!activeTask && !['interrupted', 'needs-confirmation'].includes(status.phase)
          && !(preserveRestoredStatus && ['stopped', 'failed'].includes(status.phase))) {
          status = { phase: 'ready', completed: 0 };
        }
        return;
      }
      await openSession();
      assertOpen();
      if (!['interrupted', 'needs-confirmation'].includes(status.phase)
        && !(preserveRestoredStatus && ['stopped', 'failed'].includes(status.phase))) {
        status = { phase: 'ready', completed: 0 };
      }
    },

    async start(listUrl, { maxVideos = 1, maxPages = Infinity, startPage = 1,
      replaceInterrupted = false } = {}) {
      return begin(listUrl, { maxVideos, maxPages, startPage, replaceInterrupted });
    },

    async listClassrooms() {
      assertOpen();
      assertViewingIdle();
      requireSessionPage();
      if (activeTask) {
        const error = new Error('已有任务正在运行');
        error.statusCode = 409;
        throw error;
      }
      activeTask = Promise.resolve().then(() => readClassrooms(session.page));
      try { return await activeTask; }
      finally { activeTask = null; }
    },

    async startFullCourse(listUrl) {
      if (!allowFullRun) throw new RunError('FEATURE_DISABLED', '整课运行仍处于测试阶段');
      return begin(listUrl, { mode: 'full', maxVideos: Infinity, maxPages: Infinity });
    },

    async resumeInterrupted(listUrl) {
      if (!allowFullRun) throw new RunError('FEATURE_DISABLED', '续跑仍处于测试阶段');
      return begin(listUrl, { resume: true });
    },

    async scan(listUrl) {
      assertOpen();
      assertViewingIdle();
      requireSessionPage();
      if (activeTask) {
        const error = new Error('已有任务正在运行');
        error.statusCode = 409;
        throw error;
      }
      const course = makeCourse(session, listUrl);
      const previousComplete = inventory?.complete ? inventory : null;
      controller = new AbortController();
      const signal = controller.signal;
      status = { phase: 'inventory-scanning', page: 1, pagesScanned: 0, itemsScanned: 0 };
      activeTask = (async () => {
        try {
          const result = await scanInventory(course, {
            courseUrl: listUrl,
            signal,
            onPage: progress => {
              inventory = {
                courseUrl: listUrl,
                courseTitle: '',
                scannedAt: null,
                pagesScanned: progress.pagesScanned,
                complete: false,
                items: progress.items,
              };
              status = {
                phase: 'inventory-scanning',
                page: progress.page,
                pagesScanned: progress.pagesScanned,
                itemsScanned: progress.items.length,
              };
            },
          });
          const retainedPrevious = result.stopped && previousComplete;
          if (retainedPrevious) {
            inventory = previousComplete;
          } else if (result.items.length > 0 || result.complete) {
            inventory = result;
            await saveInventory(result);
          }
          status = {
            phase: result.complete ? 'inventory-complete' : result.stopped ? 'inventory-stopped' : 'inventory-partial',
            pagesScanned: result.pagesScanned,
            itemsScanned: result.items.length,
            error: result.error,
            ...(result.errorCode ? { errorCode: result.errorCode } : {}),
            retainedPrevious: Boolean(retainedPrevious),
          };
        } catch (error) {
          status = { phase: signal.aborted ? 'inventory-stopped' : 'failed', error: error.message,
            ...(error instanceof RunError ? { errorCode: error.code } : {}) };
        } finally {
          activeTask = null;
          controller = null;
        }
      })();
    },

    async stop() {
      await stopTask();
    },

    shutdown,

    getStatus() {
      return { ...status, officialSessionOpen: Boolean(session?.page && !session.page.isClosed?.()),
        ...(viewingSession ? { viewingSession } : {}),
        ...(['running', 'interrupted'].includes(runState?.phase) && !activeTask
          ? { interruptedRun: true } : {}) };
    },

    async getManualSession() {
      assertOpen();
      if (activeTask) throw new Error('SCAN_BUSY');
      if (!session) {
        await openSession();
        assertOpen();
      }
      return session;
    },

    getInventory() {
      return inventory;
    },

    isTaskActive() { return Boolean(activeTask || openingSession); },

    setViewingSession(summary) {
      if ((summary?.active || summary?.viewerOpen || summary?.opening || summary?.closing) && activeTask) throw new Error('SCAN_BUSY');
      viewingSession = summary;
    },
  };
}
