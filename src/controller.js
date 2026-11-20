import { scanCourse } from './inventory.js';
import { RunError } from './run-error.js';
import { listMyClassrooms } from './classrooms.js';

export function createController({
  launch,
  makeCourse,
  scanInventory = scanCourse,
  readClassrooms = listMyClassrooms,
  initialInventory = null,
  saveInventory = async () => {},
}) {
  let session = null;
  let activeTask = null;
  let controller = null;
  let status = { phase: 'idle' };
  let inventory = initialInventory;
  let openingSession = null;
  let closing = false;
  let shutdownPromise = null;
  let viewingSession = null;

  function assertViewingIdle() {
    if (!viewingSession?.active && !viewingSession?.viewerOpen && !viewingSession?.opening && !viewingSession?.closing) return;
    const error = new Error('请先停止并保存当前观看，再扫描或切换课堂。');
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
        if (!activeTask && status.phase === 'ready') status = { phase: 'idle', officialWindowClosed: true };
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
        if (!activeTask) status = { phase: 'ready' };
        return;
      }
      await openSession();
      assertOpen();
      status = { phase: 'ready' };
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
        ...(viewingSession ? { viewingSession } : {}) };
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
