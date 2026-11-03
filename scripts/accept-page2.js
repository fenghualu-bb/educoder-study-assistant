import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { acceptOneVideoAtPage } from '../src/page-acceptance.js';
import { ChromeCourse, launchChrome } from '../src/chrome.js';
import { loadRunJournal, saveRunJournal } from '../src/run-journal.js';
import { classifyRunError } from '../src/run-error.js';
import { normalizeClassroomUrl } from '../src/course.js';

const target = { page: 2, index: 0, title: '9 串 4', expectedProgress: 0 };
const profileDir = fileURLToPath(new URL('../data/chrome-profile/', import.meta.url));
const runFile = fileURLToPath(new URL('../data/acceptance-page2-2026-09-24.json', import.meta.url));

async function main(courseUrl) {
  if (await loadRunJournal(runFile)) throw new Error('本次第 2 页验收已有记录，拒绝重复试播');
  let session;
  let runState = null;
  let lastPhase = '';
  let lastMediaTime = -30;
  try {
    session = await launchChrome(profileDir);
    const adapter = new ChromeCourse(session.context, session.page, courseUrl);
    const result = await acceptOneVideoAtPage(adapter, {
      courseUrl,
      target,
      onReady: async ({ layout }) => {
        const now = new Date().toISOString();
        const record = {
          version: 1, runId: randomUUID(), courseUrl, mode: 'trial',
          limits: { maxVideos: 1, maxPages: 1 }, phase: 'running',
          layout, events: [], updatedAt: now,
        };
        await saveRunJournal(runFile, record);
        runState = record;
        process.stdout.write('完整只读预检和第 2 页目标核对通过；最多试播 1 条。\n');
      },
      onEvent: async event => {
        const at = new Date().toISOString();
        const next = { ...runState, events: [...runState.events, { ...event, at }], updatedAt: at };
        await saveRunJournal(runFile, next);
        runState = next;
      },
      onStatus: status => {
        if (status.phase !== lastPhase || (Number.isFinite(status.currentTime) && status.currentTime - lastMediaTime >= 30)) {
          process.stdout.write(`阶段=${status.phase} 页=${status.page ?? '-'} 已核验=${status.completed ?? 0} 播放=${Math.floor(status.currentTime ?? 0)}/${Math.floor(status.duration ?? 0)}秒\n`);
          lastPhase = status.phase;
          if (Number.isFinite(status.currentTime)) lastMediaTime = status.currentTime;
        }
      },
    });
    if (result.completed !== 1 || !result.limitReached) throw new Error('单条验收未达到核验门槛');
    const complete = { ...runState, phase: 'complete', updatedAt: new Date().toISOString() };
    await saveRunJournal(runFile, complete);
    runState = complete;
    process.stdout.write('第 2 页目标视频已由头歌列表核验为 100%；未启动下一条。\n');
  } catch (error) {
    if (runState) {
      const phase = classifyRunError(error) === 'STOPPED' ? 'stopped' : 'failed';
      try { await saveRunJournal(runFile, { ...runState, phase, updatedAt: new Date().toISOString() }); }
      catch { process.stderr.write('运行记录最终状态保存失败；原记录仍留在本机。\n'); }
    }
    process.stderr.write(`验收停止：${error.message}\n`);
    process.exitCode = 1;
  } finally {
    await session?.context?.close();
  }
}

if (process.argv.length !== 4 || process.argv[2] !== '--execute-page2-once') {
  process.stderr.write('仅供开发验收；必须明确传入 --execute-page2-once 和课堂链接，默认不会打开 Chrome 或播放视频。\n');
  process.exitCode = 2;
} else {
  let selectedCourse;
  try { selectedCourse = normalizeClassroomUrl(process.argv[3]); }
  catch { process.stderr.write('请输入有效的头歌课堂链接；未打开浏览器或开始验收。\n'); process.exitCode = 2; }
  if (selectedCourse) await main(selectedCourse);
}
