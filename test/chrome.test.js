import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runInNewContext } from 'node:vm';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { ChromeCourse, launchChrome } from '../src/chrome.js';

function cardNode(title, progress) {
  return { getClientRects: () => [1], querySelector(selector) {
    if (selector === '[class*="bottomTitle"]') return { textContent: title };
    if (selector === '[role="progressbar"]') return progress === undefined ? null : { getAttribute: () => String(progress) };
    return null;
  } };
}

test('a failed first navigation closes the newly launched Chrome context', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'educoder-launch-test-'));
  let closes = 0;
  const context = {
    pages: () => [{ goto: async () => { throw new Error('initial navigation failed'); } }],
    close: async () => { closes++; },
  };
  try {
    await assert.rejects(
      launchChrome(dir, 'C:\\not-installed\\chrome.exe', async () => context),
      /initial navigation failed/,
    );
    assert.equal(closes, 1);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('a bundled browser launch does not silently select installed Chrome', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'educoder-bundled-test-'));
  try {
    await launchChrome(dir, null, async (_, options) => {
      assert.equal(Object.hasOwn(options, 'executablePath'), false);
      return { pages: () => [{ goto: async () => {} }], close: async () => {} };
    });
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('ChromeCourse reads real card data through the page adapter', async () => {
  const page = { waitForFunction: async () => {}, locator(selector) {
    assert.equal(selector, '.ant-card-body');
    return {
      first: () => ({ waitFor: async () => {} }),
      evaluateAll: async fn => fn([cardNode('第一条', 100), cardNode('第二条', 0)]),
    };
  } };
  const course = new ChromeCourse({}, page, 'https://www.educoder.net/classrooms/demo8cls/video');
  assert.deepEqual(await course.listCards(), [
    { title: '第一条', progress: 100, index: 0 },
    { title: '第二条', progress: 0, index: 1 },
  ]);
});

test('listCards waits until every visible card has a readable progress value', async () => {
  let ready = false;
  const nodes = () => [cardNode('3 线性表', 100), cardNode('4 顺序表 1', ready ? 0 : undefined)];
  const page = {
    locator(selector) {
      assert.equal(selector, '.ant-card-body');
      return {
        first: () => ({ waitFor: async () => {} }),
        evaluateAll: async fn => fn(nodes()),
      };
    },
    async waitForFunction(predicate) {
      const originalDocument = globalThis.document;
      try {
        globalThis.document = {
          querySelectorAll: () => nodes(),
          querySelector: () => null,
        };
        assert.equal(predicate(), false);
        ready = true;
        assert.equal(predicate(), true);
      } finally { globalThis.document = originalDocument; }
    },
  };
  const course = new ChromeCourse({}, page, 'https://www.educoder.net/classrooms/SyntheticCourse/video');
  assert.deepEqual(await course.listCards(), [
    { title: '3 线性表', progress: 100, index: 0 },
    { title: '4 顺序表 1', progress: 0, index: 1 },
  ]);
});

test('listCards fails explicitly instead of treating a persistently missing progress as zero', async () => {
  const page = {
    locator: () => ({
      first: () => ({ waitFor: async () => {} }),
      evaluateAll: async fn => fn([cardNode('3 线性表', undefined)]),
    }),
    waitForFunction: async () => { throw new Error('timeout'); },
  };
  const course = new ChromeCourse({}, page, 'https://www.educoder.net/classrooms/SyntheticCourse/video');
  await assert.rejects(course.listCards(), error => error.code === 'LIST_UNAVAILABLE' && /进度/.test(error.message));
});

test('ChromeCourse names a scanned list from the loaded classroom page', async () => {
  const course = new ChromeCourse({}, { title: async () => '模拟测试课堂' }, 'https://www.educoder.net/classrooms/SyntheticCourse/video');
  assert.equal(await course.courseTitle(), '模拟测试课堂');
});

test('ChromeCourse does not advance past the disabled final-page button', async () => {
  const page = { locator(selector) {
    if (selector === 'li.ant-pagination-item') return { allTextContents: async () => ['1'] };
    assert.equal(selector, 'li.ant-pagination-next button');
    return { isDisabled: async () => true, click: async () => { throw new Error('must not click'); } };
  } };
  const course = new ChromeCourse({}, page, 'https://www.educoder.net/classrooms/demo8cls/video');
  assert.equal(await course.nextPage(), false);
});

test('a disabled next button with later numbered pages does not truncate a course scan', async () => {
  const page = { locator(selector) {
    if (selector === 'li.ant-pagination-item') return { allTextContents: async () => ['1', '2', '8'] };
    assert.equal(selector, 'li.ant-pagination-next button');
    return { isDisabled: async () => true, click: async () => { throw new Error('must not click'); } };
  } };
  const course = new ChromeCourse({}, page, 'https://www.educoder.net/classrooms/SyntheticCourse/video');
  await assert.rejects(course.nextPage(), error => error.code === 'PAGE_LOAD_FAILED');
});

test('nextPage ignores the old cards after the page number changes, even with identical titles', async () => {
  let clicked = false;
  const card = thumbnail => ({
    dataset: {},
    getClientRects: () => [1],
    querySelector(selector) {
      if (selector === '[class*="bottomTitle"]') return { textContent: '重复标题' };
      if (selector === '[class*="imgWrap"] img') return { getAttribute: () => thumbnail };
      return null;
    },
  });
  const oldCards = [card('old-thumbnail')];
  const newCards = [card('new-thumbnail')];
  const page = {
    locator(selector) {
      if (selector === '.ant-card-body') return { evaluateAll: async (fn, token) => fn(oldCards, token) };
      assert.equal(selector, 'li.ant-pagination-next button');
      return { isDisabled: async () => false, click: async () => { clicked = true; } };
    },
    async waitForFunction(predicate, args) {
      assert.equal(clicked, true);
      const originalDocument = globalThis.document;
      const results = [];
      try {
        for (const { spinning, cards } of [
          { spinning: false, cards: oldCards },
          { spinning: true, cards: oldCards },
          { spinning: false, cards: newCards },
        ]) {
          globalThis.document = {
            querySelector(selector) {
              if (selector === 'li.ant-pagination-item-active') return { textContent: '2' };
              if (selector === '.ant-spin-spinning') return spinning ? {} : null;
              if (selector === '.ant-card-body') return cards[0];
              return null;
            },
            querySelectorAll(selector) {
              assert.equal(selector, '.ant-card-body');
              return cards;
            },
          };
          results.push(predicate(args));
        }
      } finally {
        globalThis.document = originalDocument;
      }
      assert.deepEqual(results, [false, false, true]);
    },
  };
  const course = new ChromeCourse({}, page, 'https://www.educoder.net/classrooms/SyntheticCourse/video');
  assert.equal(await course.nextPage(), true);
  assert.equal(course.currentPage, 2);
});

test('nextPage accepts newly rendered cards even when their title and thumbnail are identical', async () => {
  let clicked = false;
  const card = () => ({
    dataset: {}, getClientRects: () => [1],
    querySelector(selector) {
      if (selector === '[class*="bottomTitle"]') return { textContent: '重复标题' };
      if (selector === '[class*="imgWrap"] img') return { getAttribute: () => 'same-thumbnail' };
      return null;
    },
  });
  const oldCards = [card()];
  const newCards = [card()];
  const page = {
    locator(selector) {
      if (selector === '.ant-card-body') return { evaluateAll: async (fn, token) => fn(oldCards, token) };
      assert.equal(selector, 'li.ant-pagination-next button');
      return { isDisabled: async () => false, click: async () => { clicked = true; } };
    },
    async waitForFunction(predicate, args) {
      assert.equal(clicked, true);
      const originalDocument = globalThis.document;
      const results = [];
      try {
        for (const cards of [oldCards, newCards]) {
          globalThis.document = {
            querySelector(selector) {
              if (selector === 'li.ant-pagination-item-active') return { textContent: '2' };
              if (selector === '.ant-spin-spinning') return null;
              return null;
            },
            querySelectorAll: () => cards,
          };
          results.push(predicate(args));
        }
      } finally { globalThis.document = originalDocument; }
      assert.deepEqual(results, [false, true]);
    },
  };
  const course = new ChromeCourse({}, page, 'https://www.educoder.net/classrooms/demo123/video');
  assert.equal(await course.nextPage(), true);
  assert.equal(course.currentPage, 2);
});

function chunkErrorPage({ recoverAfterReload }) {
  let reloads = 0;
  const page = {
    async goto() {},
    async reload() { reloads++; },
    async waitForFunction() {},
    locator(selector) {
      if (selector === '.ant-card-body') {
        return { first: () => ({
          waitFor: async () => { if (!recoverAfterReload || reloads === 0) throw new Error('timeout'); },
          isVisible: async () => recoverAfterReload && reloads > 0,
        }) };
      }
      if (selector === 'body') {
        return { innerText: async () => '当前浏览器似乎发生了错误。Loading chunk 93282 failed. (timeout: https://www-cdn.educoder.net/layouts__ShixunDetail__index.async.js)' };
      }
      throw new Error(`unexpected selector ${selector}`);
    },
  };
  return { page, getReloads: () => reloads };
}

test('retries a transient head song CDN chunk failure once before reporting login failure', async () => {
  const fixture = chunkErrorPage({ recoverAfterReload: true });
  const course = new ChromeCourse({}, fixture.page, 'https://www.educoder.net/classrooms/demo8cls/video');
  await course.prepare();
  assert.equal(fixture.getReloads(), 1);
});

test('reports a persistent CDN chunk timeout as a network error', async () => {
  const fixture = chunkErrorPage({ recoverAfterReload: false });
  const course = new ChromeCourse({}, fixture.page, 'https://www.educoder.net/classrooms/demo8cls/video');
  await assert.rejects(course.prepare(), error => error.code === 'CDN_TIMEOUT' && /CDN.*加载超时/.test(error.message));
  assert.equal(fixture.getReloads(), 1);
});

test('a real login redirect is distinguished from a login link on the list page', async () => {
  const page = {
    async goto() {},
    async waitForFunction(predicate) {
      const ready = runInNewContext(`(${predicate.toString()})()`, {
        location: { pathname: new URL(page.url()).pathname },
        document: { querySelector: () => null, body: { innerText: '登录 注册' } },
      });
      assert.equal(Boolean(ready), new URL(page.url()).pathname === '/login', 'login redirects must finish the wait without an absent-card timeout');
      if (!ready) throw new Error('timeout');
    },
    url: () => 'https://www.educoder.net/login',
    locator: selector => selector === '.ant-card-body'
      ? { first: () => ({ isVisible: async () => false }) }
      : { innerText: async () => '登录 注册' },
  };
  const course = new ChromeCourse({}, page, 'https://www.educoder.net/classrooms/demo8cls/video');
  await assert.rejects(course.prepare(), error => error.code === 'LOGIN_REQUIRED'
    && /专用浏览器/.test(error.message) && !/Chrome/.test(error.message));
  page.url = () => 'https://www.educoder.net/classrooms/demo8cls/video';
  await assert.rejects(course.prepare(), error => error.code === 'LIST_UNAVAILABLE'
    && /专用浏览器/.test(error.message) && !/Chrome/.test(error.message));
});
