import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createController } from '../src/controller.js';
import { loadRunJournal, saveRunJournal } from '../src/run-journal.js';

const listUrl = 'https://www.educoder.net/classrooms/demo8cls/video';
const at = '2026-09-24T00:00:00.000Z';

function journalSaver(file, terminalPhase) {
  let savedTerminal;
  const finished = new Promise(resolve => { savedTerminal = resolve; });
  return {
    finished,
    save: async value => {
      await saveRunJournal(file, value);
      if (value.phase === terminalPhase) savedTerminal();
    },
  };
}

async function waitForSavedTerminal(finished) {
  let timer;
  try {
    await Promise.race([finished, new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error('timed out waiting for terminal journal write')), 2_000);
    })]);
  } finally { clearTimeout(timer); }
  await new Promise(resolve => setImmediate(resolve));
}

test('explicit new trial archives an interrupted journal byte-for-byte before replacing it', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'educoder-replace-run-'));
  const file = path.join(dir, 'run-journal.json');
  const oldRun = { version: 1, runId: 'old-interrupted', courseUrl: listUrl, mode: 'trial',
    limits: { maxVideos: 1, maxPages: 1 }, phase: 'running',
    layout: [{ page: 1, index: 0, title: '旧视频' }],
    events: [{ type: 'selected', page: 1, index: 0, title: '旧视频', at }], updatedAt: at };
  try {
    await saveRunJournal(file, oldRun);
    const oldBytes = await readFile(file);
    const journal = journalSaver(file, 'complete');
    const app = createController({
      launch: async () => ({ page: { bringToFront: async () => {} } }),
      initialRun: await loadRunJournal(file),
      saveRun: journal.save,
      scanInventory: async () => ({ courseUrl: listUrl, courseTitle: '模拟课堂',
        scannedAt: at, pagesScanned: 1, complete: true,
        items: [{ page: 1, index: 0, title: '当前视频', progress: 100 }] }),
      makeCourse: () => ({ prepare: async () => {} }),
      run: async () => ({ completed: 0, pagesVisited: 1, pageLimitReached: true }),
    });
    await app.openBrowser();
    await app.scan(listUrl);
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(app.getStatus().interruptedRun, true);
    await app.start(listUrl, { replaceInterrupted: true });
    await waitForSavedTerminal(journal.finished);
    const archived = await readdir(path.join(dir, 'run-archive'));
    assert.equal(archived.length, 1);
    assert.deepEqual(await readFile(path.join(dir, 'run-archive', archived[0])), oldBytes);
    assert.notEqual((await loadRunJournal(file)).runId, oldRun.runId);
    assert.equal(app.getStatus().interruptedRun, undefined);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('restart rechecks platform 100 percent and durably records a verified event without replaying', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'educoder-recovery-'));
  const file = path.join(dir, 'run.json');
  const initial = {
    version: 1, runId: 'interrupted-r1', courseUrl: listUrl, mode: 'trial',
    limits: { maxVideos: 1, maxPages: 1 }, phase: 'running',
    layout: [{ page: 1, index: 0, title: '首条视频' }],
    events: [
      { type: 'selected', page: 1, index: 0, title: '首条视频', at },
      { type: 'media-ended', page: 1, index: 0, title: '首条视频', at },
    ],
    updatedAt: at,
  };
  try {
    await saveRunJournal(file, initial);
    const journal = journalSaver(file, 'complete');
    let opens = 0;
    const adapter = {
      prepare: async () => {}, courseTitle: async () => '离散数学',
      listCards: async () => [{ page: 1, index: 0, title: '首条视频', progress: 100 }],
      nextPage: async () => false,
      openAndWatch: async () => { opens++; },
      verify: async () => { throw new Error('must not replay completed video'); },
    };
    const app = createController({
      launch: async () => ({ page: { bringToFront: async () => {} } }),
      makeCourse: () => adapter,
      initialRun: await loadRunJournal(file),
      saveRun: journal.save,
      allowFullRun: true,
    });
    assert.equal(app.getStatus().phase, 'interrupted');
    await app.openBrowser();
    assert.equal(app.getStatus().phase, 'interrupted');
    await app.resumeInterrupted(listUrl);
    await waitForSavedTerminal(journal.finished);
    const saved = await loadRunJournal(file);
    assert.equal(app.getStatus().phase, 'limit-reached');
    assert.equal(opens, 0);
    assert.equal(saved.phase, 'complete');
    assert.equal(saved.events.filter(event => event.type === 'verified').length, 1);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('stop during playback saves stopped without verifying or opening the next card', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'educoder-stop-'));
  const file = path.join(dir, 'run.json');
  const cards = [
    { index: 0, title: '第一条', progress: 0 },
    { index: 1, title: '第二条', progress: 0 },
  ];
  const opened = [];
  let cancels = 0;
  let playbackStarted;
  const playing = new Promise(resolve => { playbackStarted = resolve; });
  try {
    const journal = journalSaver(file, 'stopped');
    const adapter = {
      prepare: async () => {}, courseTitle: async () => '离散数学',
      listCards: async () => cards.map(card => ({ ...card })),
      nextPage: async () => false,
      openAndWatch: async (card, { signal }) => {
        opened.push(card.title);
        playbackStarted();
        await new Promise(resolve => signal.addEventListener('abort', resolve, { once: true }));
      },
      verify: async () => { throw new Error('must not verify after stop'); },
      cancel: async () => { cancels++; },
    };
    const app = createController({
      launch: async () => ({ page: { bringToFront: async () => {} } }),
      makeCourse: () => adapter,
      saveRun: journal.save,
    });
    await app.openBrowser();
    await app.start(listUrl, { maxVideos: 3, maxPages: 1 });
    await playing;
    await app.stop();
    await waitForSavedTerminal(journal.finished);
    const saved = await loadRunJournal(file);
    assert.equal(app.getStatus().phase, 'stopped');
    assert.equal(saved.phase, 'stopped');
    assert.deepEqual(saved.events.map(event => event.type), ['selected', 'stopped']);
    assert.deepEqual(opened, ['第一条']);
    assert.equal(cancels, 1);
    assert.equal(cards[1].progress, 0);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('restart does not count a 99-percent card as verified', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'educoder-unverified-'));
  const file = path.join(dir, 'run.json');
  const initial = {
    version: 1, runId: 'interrupted-r2', courseUrl: listUrl, mode: 'trial',
    limits: { maxVideos: 1, maxPages: 1 }, phase: 'running',
    layout: [{ page: 1, index: 0, title: '首条视频' }],
    events: [{ type: 'selected', page: 1, index: 0, title: '首条视频', at }],
    updatedAt: at,
  };
  try {
    await saveRunJournal(file, initial);
    const journal = journalSaver(file, 'failed');
    let opens = 0;
    const adapter = {
      prepare: async () => {}, courseTitle: async () => '离散数学',
      listCards: async () => [{ index: 0, title: '首条视频', progress: 99 }],
      nextPage: async () => false,
      openAndWatch: async () => { opens++; },
      verify: async () => false,
    };
    const app = createController({
      launch: async () => ({ page: { bringToFront: async () => {} } }),
      makeCourse: () => adapter,
      initialRun: await loadRunJournal(file),
      saveRun: journal.save,
      allowFullRun: true,
    });
    await app.openBrowser();
    await app.resumeInterrupted(listUrl);
    await waitForSavedTerminal(journal.finished);
    const saved = await loadRunJournal(file);
    assert.equal(opens, 1);
    assert.equal(app.getStatus().completed, 0);
    assert.equal(app.getStatus().errorCode, 'VERIFY_NOT_100');
    assert.equal(saved.events.some(event => event.type === 'verified'), false);
  } finally { await rm(dir, { recursive: true, force: true }); }
});
