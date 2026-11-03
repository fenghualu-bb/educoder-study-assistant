import { test } from 'node:test';
import assert from 'node:assert/strict';
import { scanCourse } from '../src/inventory.js';
import { RunError } from '../src/run-error.js';

const courseUrl = 'https://www.educoder.net/classrooms/SyntheticCourse/video';
const scannedAt = '2026-09-23T12:00:00.000Z';

test('scans every page without opening a video and keeps exact percentages', async () => {
  const pages = [
    [{ title: '3 线性表', progress: 100, index: 0 }, { title: '4 顺序表 1', progress: 0, index: 1 }],
    [{ title: '4 顺序表 2', progress: 38, index: 0 }],
  ];
  let page = 0;
  let prepared = false;
  const updates = [];
  const adapter = {
    async prepare() { prepared = true; },
    async courseTitle() { return '模拟测试课堂'; },
    async listCards() { assert.equal(prepared, true); return pages[page]; },
    async nextPage() { if (page === pages.length - 1) return false; page++; return true; },
    async openAndWatch() { throw new Error('scan must not play'); },
  };
  const result = await scanCourse(adapter, {
    courseUrl,
    now: () => new Date(scannedAt),
    onPage: snapshot => updates.push(snapshot.pagesScanned),
  });
  assert.deepEqual(updates, [1, 2]);
  assert.deepEqual(result, {
    courseUrl,
    courseTitle: '模拟测试课堂',
    scannedAt,
    pagesScanned: 2,
    complete: true,
    items: [
      { page: 1, index: 0, title: '3 线性表', progress: 100 },
      { page: 1, index: 1, title: '4 顺序表 1', progress: 0 },
      { page: 2, index: 0, title: '4 顺序表 2', progress: 38 },
    ],
  });
});

test('a later page failure preserves scanned entries and marks totals incomplete', async () => {
  let page = 0;
  const adapter = {
    async prepare() {},
    async courseTitle() { return '模拟测试课堂'; },
    async listCards() {
      if (page === 1) throw new Error('第 2 页加载超时');
      return [{ title: '3 线性表', progress: 100, index: 0 }];
    },
    async nextPage() { page++; return true; },
  };
  const result = await scanCourse(adapter, { courseUrl, now: () => new Date(scannedAt) });
  assert.equal(result.complete, false);
  assert.equal(result.pagesScanned, 1);
  assert.equal(result.error, '第 2 页加载超时');
  assert.deepEqual(result.items, [{ page: 1, index: 0, title: '3 线性表', progress: 100 }]);
});

test('stopping after a page never advances into the next page', async () => {
  const abort = new AbortController();
  const adapter = {
    async prepare() {},
    async courseTitle() { return '模拟测试课堂'; },
    async listCards() { return [{ title: '3 线性表', progress: 100, index: 0 }]; },
    async nextPage() { throw new Error('must not advance after stop'); },
  };
  const result = await scanCourse(adapter, {
    courseUrl,
    signal: abort.signal,
    now: () => new Date(scannedAt),
    onPage: () => abort.abort(),
  });
  assert.equal(result.complete, false);
  assert.equal(result.stopped, true);
  assert.equal(result.pagesScanned, 1);
});

test('a named login failure survives read-only scanning for accurate task feedback', async () => {
  const adapter = { prepare: async () => { throw new RunError('LOGIN_REQUIRED', '请重新登录'); } };
  const result = await scanCourse(adapter, { courseUrl });
  assert.equal(result.complete, false);
  assert.equal(result.errorCode, 'LOGIN_REQUIRED');
});
