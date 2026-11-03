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

test('verification requires the same card position, title and 100 percent progress after refresh', async () => {
  const course = new ChromeCourse({}, {}, 'https://www.educoder.net/classrooms/demo8cls/video');
  let restoredPage = 0;
  course.restorePage = async page => { restoredPage = page; };
  course.listCards = async () => [{ title: '目标视频', progress: 99, index: 0 }];
  assert.equal(await course.verify({ title: '目标视频', index: 0 }, 2), false);
  course.listCards = async () => [{ title: '目标视频', progress: 100, index: 0 }];
  assert.equal(await course.verify({ title: '目标视频', index: 0 }, 2), true);
  assert.equal(restoredPage, 2);
});

test('verification stops on a changed or missing card instead of calling it incomplete', async () => {
  const course = new ChromeCourse({}, {}, 'https://www.educoder.net/classrooms/demo8cls/video');
  course.restorePage = async () => {};
  course.listCards = async () => [{ title: '视频 B', progress: 100, index: 0 }];
  await assert.rejects(course.verify({ index: 0, title: '视频 A' }, 1), error => error.code === 'CARD_CHANGED');
  course.listCards = async () => [];
  await assert.rejects(course.verify({ index: 0, title: '视频 A' }, 1), error => error.code === 'CARD_CHANGED');
});

test('a changed progress or page blocks the video click at the last moment', async () => {
  for (const [progress, activePage] of [['100', 2], ['0', 1]]) {
    let clicks = 0;
    const node = { querySelector(selector) {
      if (selector === '[class*="bottomTitle"]') return { textContent: '9 串 4' };
      if (selector === '[role="progressbar"]') return { getAttribute: () => progress };
      return null;
    } };
    const tile = { locator: selector => selector.includes('bottomTitle')
      ? { innerText: async () => '9 串 4' }
      : { click: async () => { clicks++; } },
      evaluate: async fn => {
        const originalDocument = globalThis.document;
        globalThis.document = { querySelector: () => ({ textContent: String(activePage) }) };
        try { return fn(node); } finally { globalThis.document = originalDocument; }
      },
    };
    const page = {
      locator: () => ({ nth: () => tile }),
      waitForEvent: () => { throw new Error('popup must not be requested'); },
    };
    const course = new ChromeCourse({}, page, 'https://www.educoder.net/classrooms/SyntheticCourse/video');
    course.currentPage = 2;
    await assert.rejects(course.openAndWatch({ index: 0, title: '9 串 4' }, {
      expectedPage: 2, expectedProgress: 0,
    }), error => error.code === 'CARD_CHANGED');
    assert.equal(clicks, 0);
  }
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

test('closing a cancelled video also closes its player tab', async () => {
  let closes = 0;
  const abort = new AbortController();
  const playerPage = {
    async bringToFront() {},
    async waitForFunction() {},
    async close() { closes++; },
    locator(selector) {
      if (selector === 'video') return { waitFor: async () => { abort.abort(); } };
      if (selector === 'body') return { innerText: async () => '试题总数 0 暂无检查点' };
      throw new Error(`unexpected player selector ${selector}`);
    },
  };
  const listPage = { waitForEvent: async () => playerPage, locator(selector) {
    assert.equal(selector, '.ant-card-body');
    return { nth: () => ({ locator(child) {
      if (child === '[class*="bottomTitle"]') return { innerText: async () => '待看视频' };
      if (child === '[class*="imgWrap"]') return { click: async () => {} };
      throw new Error(`unexpected tile selector ${child}`);
    } }) };
  } };
  const course = new ChromeCourse({ waitForEvent: async () => { throw new Error('unrelated context event'); } }, listPage, 'https://www.educoder.net/classrooms/SyntheticCourse/video');
  await assert.rejects(course.openAndWatch({ title: '待看视频', index: 0 }, { signal: abort.signal }), /task stopped/);
  assert.equal(closes, 1);
  assert.equal(course.playerPage, null);
});

test('an explicit stop closes an already opened player tab promptly', async () => {
  let closes = 0;
  const course = new ChromeCourse({}, {}, 'https://www.educoder.net/classrooms/SyntheticCourse/video');
  course.playerPage = { isClosed: () => false, close: async () => { closes++; } };
  await course.cancel();
  assert.equal(closes, 1);
  assert.equal(course.playerPage, null);
});

test('stop while waiting for a player popup does not leave a late tab open', async () => {
  let resolvePopup;
  let closes = 0;
  const page = { waitForEvent: () => new Promise(resolve => { resolvePopup = resolve; }),
    locator: () => ({ nth: () => ({ locator: selector => selector.includes('bottomTitle')
    ? { innerText: async () => '待看视频' } : { click: async () => {} } }) }) };
  const course = new ChromeCourse({ waitForEvent: async () => { throw new Error('unrelated context event'); } }, page, 'https://www.educoder.net/classrooms/SyntheticCourse/video');
  const abort = new AbortController();
  const pending = course.openAndWatch({ title: '待看视频', index: 0 }, { signal: abort.signal });
  await new Promise(resolve => setImmediate(resolve));
  abort.abort();
  await assert.rejects(pending, /task stopped/);
  resolvePopup({ close: async () => { closes++; } });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(closes, 1);
});

test('a player popup timeout has a specific page-load failure code', async () => {
  const page = {
    waitForEvent: async () => { throw new Error('Timeout 60000ms exceeded'); },
    locator: () => ({ nth: () => ({ locator: selector => selector.includes('bottomTitle')
      ? { innerText: async () => '待看视频' } : { click: async () => {} } }) }),
  };
  const course = new ChromeCourse({}, page, 'https://www.educoder.net/classrooms/SyntheticCourse/video');
  await assert.rejects(course.openAndWatch({ title: '待看视频', index: 0 }), error => error.code === 'PAGE_LOAD_FAILED');
});

test('a usable video page does not wait for an unrelated load-state event', async () => {
  const abort = new AbortController();
  let videoAttached = false;
  let closes = 0;
  const playerPage = {
    bringToFront: async () => {},
    waitForLoadState: async () => { throw new Error('page.waitForLoadState: Timeout 60000ms exceeded'); },
    locator: selector => selector === 'video'
      ? { waitFor: async () => { videoAttached = true; } }
      : { innerText: async () => { abort.abort(); return '试题总数 0 暂无检查点'; } },
    waitForFunction: async () => {},
    isClosed: () => false,
    close: async () => { closes++; },
  };
  const listPage = {
    waitForEvent: async () => playerPage,
    locator: () => ({ nth: () => ({ locator: selector => selector.includes('bottomTitle')
      ? { innerText: async () => '待看视频' } : { click: async () => {} } }) }),
  };
  const course = new ChromeCourse({}, listPage, 'https://www.educoder.net/classrooms/SyntheticCourse/video');
  await assert.rejects(course.openAndWatch({ title: '待看视频', index: 0 }, { signal: abort.signal }), error => error.code === 'STOPPED');
  assert.equal(videoAttached, true);
  assert.equal(closes, 1);
});

test('a missing video element is a page-load failure instead of UNKNOWN', async () => {
  let closes = 0;
  const playerPage = {
    bringToFront: async () => {},
    waitForLoadState: async () => {},
    locator: () => ({ waitFor: async () => { throw new Error('locator.waitFor: Timeout 120000ms exceeded'); } }),
    isClosed: () => false,
    close: async () => { closes++; },
  };
  const listPage = {
    waitForEvent: async () => playerPage,
    locator: () => ({ nth: () => ({ locator: selector => selector.includes('bottomTitle')
      ? { innerText: async () => '待看视频' } : { click: async () => {} } }) }),
  };
  const course = new ChromeCourse({}, listPage, 'https://www.educoder.net/classrooms/SyntheticCourse/video');
  await assert.rejects(course.openAndWatch({ title: '待看视频', index: 0 }), error => error.code === 'PAGE_LOAD_FAILED');
  assert.equal(closes, 1);
  assert.equal(course.playerPage, null);
});

test('video metadata timeout is classified as page loading, before playback begins', async () => {
  const playerPage = {
    bringToFront: async () => {}, waitForLoadState: async () => {},
    locator: () => ({ waitFor: async () => {} }),
    waitForFunction: async () => { throw new Error('page.waitForFunction: Timeout 180000ms exceeded'); },
    isClosed: () => false, close: async () => {},
  };
  const listPage = {
    waitForEvent: async () => playerPage,
    locator: () => ({ nth: () => ({ locator: selector => selector.includes('bottomTitle')
      ? { innerText: async () => '待看视频' } : { click: async () => {} } }) }),
  };
  const course = new ChromeCourse({}, listPage, 'https://www.educoder.net/classrooms/SyntheticCourse/video');
  await assert.rejects(course.openAndWatch({ title: '待看视频', index: 0 }), error => error.code === 'PAGE_LOAD_FAILED');
});

test('player page body timeout is classified before any playback', async () => {
  const playerPage = {
    bringToFront: async () => {}, waitForLoadState: async () => {},
    locator: selector => selector === 'video' ? { waitFor: async () => {} }
      : { innerText: async () => { throw new Error('locator.innerText: Timeout 30000ms exceeded'); } },
    waitForFunction: async () => {}, isClosed: () => false, close: async () => {},
  };
  const listPage = {
    waitForEvent: async () => playerPage,
    locator: () => ({ nth: () => ({ locator: selector => selector.includes('bottomTitle')
      ? { innerText: async () => '待看视频' } : { click: async () => {} } }) }),
  };
  const course = new ChromeCourse({}, listPage, 'https://www.educoder.net/classrooms/SyntheticCourse/video');
  await assert.rejects(course.openAndWatch({ title: '待看视频', index: 0 }), error => error.code === 'PAGE_LOAD_FAILED');
});
