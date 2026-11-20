import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chromium } from 'playwright-core';
import { createServer } from '../src/server.js';
import { listenOnBrowserSafePort } from '../src/loopback-port.js';
import { RunError } from '../src/run-error.js';

test('missing Edge guidance does not imply the Edge-only package has a bundled-browser fallback', async () => {
  const browser = await chromium.launch({
    executablePath: process.env.CHROME_PATH || 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    headless: true,
    chromiumSandbox: true,
  });
  try {
    const page = await browser.newPage();
    await page.goto(new URL('../public/desktop-edge-missing.html', import.meta.url).href);
    const guidance = await page.locator('main').innerText();
    assert.match(guidance, /安装 Edge/);
    assert.match(guidance, /默认内部包/);
    assert.doesNotMatch(guidance, /不带 Edge 测试参数/);
  } finally {
    await browser.close();
  }
});

test('upgrade backup error page asks the student to keep records for recovery', async () => {
  const browser = await chromium.launch({
    executablePath: process.env.CHROME_PATH || 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    headless: true,
    chromiumSandbox: true,
  });
  try {
    const page = await browser.newPage();
    await page.goto(new URL('../public/desktop-upgrade-error.html', import.meta.url).href);
    const guidance = await page.locator('main').innerText();
    assert.match(guidance, /保留.*记录/);
    assert.match(guidance, /联系.*维护者/);
    assert.doesNotMatch(guidance, /C:\\Users\\|cookie|token/i);
  } finally {
    await browser.close();
  }
});

test('initial page guidance does not assume Chrome before the application script loads', async () => {
  const browser = await chromium.launch({
    executablePath: process.env.CHROME_PATH || 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    headless: true,
    chromiumSandbox: true,
  });
  try {
    const page = await browser.newPage();
    await page.route('**/app.js', route => route.abort());
    await page.goto(new URL('../public/index.html', import.meta.url).href);
    assert.match(await page.locator('#browser-instruction').innerText(), /专用浏览器/);
    assert.equal(await page.locator('#classroom-tools').evaluate(details => details.open), false);
    assert.match(await page.locator('#open').innerText(), /官方.*窗口/);
  } finally {
    await browser.close();
  }
});

async function withPage(inventory, run, status = { phase: 'idle', completed: 0 }, pageOptions = {}, serverOptions = {}) {
  const server = createServer({
    getStatus: () => status,
    getInventory: () => typeof inventory === 'function' ? inventory() : inventory,
    ...serverOptions.handlers,
  }, { csrfToken: serverOptions.csrfToken });
  await listenOnBrowserSafePort(server);
  const origin = `http://127.0.0.1:${server.address().port}`;
  let browser;
  try {
    browser = await chromium.launch({
      executablePath: process.env.CHROME_PATH || 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
      headless: true,
      chromiumSandbox: true,
    });
    const page = await browser.newPage(pageOptions);
    await page.addInitScript(({ keepClassroomToolsClosed, keepReadStatusClosed }) => document.addEventListener('DOMContentLoaded', () => {
      if (!keepClassroomToolsClosed) document.querySelector('#classroom-tools').open = true;
      // Status regression cases explicitly open the secondary read-status panel.
      if (!keepReadStatusClosed) document.querySelector('details.status').open = true;
    }), { keepClassroomToolsClosed: Boolean(serverOptions.keepClassroomToolsClosed), keepReadStatusClosed: Boolean(serverOptions.keepReadStatusClosed) });
    await serverOptions.beforeNavigate?.(page);
    await page.goto(origin);
    await run(page);
  } finally {
    await browser?.close();
    await new Promise(resolve => server.close(resolve));
  }
}

test('homepage classroom discovery failures stay visible with auxiliary controls collapsed',async()=>{
  let expired=true;
  await withPage(null,async page=>{
    await page.waitForFunction(()=>!document.querySelector('#load-classrooms').disabled);
    assert.equal(await page.locator('#classroom-tools').evaluate(details=>details.open),false);
    await page.locator('#load-classrooms').click();await page.locator('#form-error').waitFor({state:'visible',timeout:2000});
    assert.match(await page.locator('#form-error').innerText(),/官方页面重新登录/);
    expired=false;await page.locator('#load-classrooms').click();await page.waitForFunction(()=>document.querySelector('#form-error').textContent.includes('暂无可选课程'));
    assert.equal(await page.locator('#form-error').isVisible(),true);
    assert.equal(await page.locator('#classroom-tools').evaluate(details=>details.open),false);
  },{phase:'ready',completed:0,officialSessionOpen:true},{},{csrfToken:'synthetic-folded-error',keepClassroomToolsClosed:true,
    handlers:{listClassrooms:async()=>{if(expired)throw new RunError('LOGIN_REQUIRED','synthetic login expired');return [];}}});
});

test('a failed first scan exposes its official error while the read-status details remain closed', async () => {
  await withPage(null, async page => {
    await page.locator('#error').waitFor({ state: 'visible' });
    assert.match(await page.locator('#error').innerText(), /视频列表加载失败.*再试/);
    assert.equal(await page.locator('details.status').evaluate(details => details.open), false);
    assert.equal(await page.locator('details.status > summary').isVisible(), true);
    assert.equal(await page.locator('#copy-diagnostic').isVisible(), true);
  }, { phase: 'inventory-partial', completed: 0, errorCode: 'PAGE_LOAD_FAILED', pagesScanned: 0 }, {},
  { csrfToken: 'synthetic-first-scan-failure', keepReadStatusClosed: true, keepClassroomToolsClosed: true });
});

async function manualBridge(page) {
  await page.addInitScript(() => {
    const listeners = { changed: new Set(), closed: new Set() };
    window.__manualOpens = [];
    window.__session = { active: false, viewerOpen: false, revision: 0, version: '0.2.0' };
    const publish = value => {
      window.__session = { ...value, revision: window.__session.revision + 1, version: '0.2.0' };
      for (const callback of listeners.changed) callback(window.__session);
    };
    window.localManualVideo = {
      open: async selection => {
        window.__manualOpens.push(selection);
        publish({ active: true, viewerOpen: true, stage: 'not-open', selection });
      },
      session: async () => window.__session,
      onSessionChanged: callback => { listeners.changed.add(callback); },
      onClosed: callback => { listeners.closed.add(callback); },
    };
    window.__closeManualViewer = () => {
      publish({ active: false, viewerOpen: false });
      for (const callback of listeners.closed) callback({ discarded: false });
    };
  });
}

test('first-use local flow connects, scans, selects one video explicitly and clears selection when switching classrooms', async () => {
  const status = { phase: 'idle', completed: 0 };
  const a = 'https://www.educoder.net/classrooms/SyntheticA/video';
  const b = 'https://www.educoder.net/classrooms/SyntheticB/video';
  let snapshot = null, opens = 0, scans = 0;
  await withPage(() => snapshot, async page => {
    assert.match(await page.locator('#app-intro').innerText(), /查看官方进度.*打开所选视频/);
    assert.equal(await page.locator('#scan').isDisabled(), true);
    await page.locator('#open').click();
    await page.waitForFunction(() => !document.querySelector('#load-classrooms').disabled);
    assert.equal(opens, 1);
    assert.equal(await page.locator('#load-classrooms').isVisible(), true);
    await page.locator('#load-classrooms').click();
    await page.locator('#classroom-select').waitFor({ state: 'visible' });
    assert.equal(opens, 1, 'the prominent action must discover classrooms rather than open the official browser again');
    await page.locator('#classroom-select').selectOption(a);
    const cell = page.locator('.heatmap-cell').first(); await cell.waitFor();
    assert.equal(scans, 1);
    assert.deepEqual(await page.evaluate(() => window.__manualOpens), []);
    await cell.focus(); await page.keyboard.press('Enter');
    await page.waitForFunction(() => window.__manualOpens.length === 1);
    assert.deepEqual(await page.evaluate(() => window.__manualOpens), [{ courseUrl: a, title: '模拟视频一', page: 1, index: 0 }]);
    assert.equal(await page.evaluate(() => window.__session.stage), 'not-open');
    assert.equal(await page.locator('#classroom-select').isDisabled(), true);
    await page.evaluate(() => window.__closeManualViewer());
    await page.waitForFunction(() => !document.querySelector('#classroom-select').disabled);
    assert.match(await page.locator('#home-viewing-state').innerText(), /保存|保留/);
    await page.locator('#classroom-select').selectOption(b);
    await page.locator('#inventory-title').filter({ hasText: '课堂 B' }).waitFor();
    assert.equal(scans, 2);
    assert.equal(await page.locator('#home-viewing-state').innerText(), '');
    assert.equal(await page.locator('#map-instruction').isVisible(), true);
    assert.match(await page.locator('#map-instruction').innerText(), /点击方格打开所选视频/);
    assert.equal(await page.locator('.heatmap-cell').count(), 0);
    assert.equal(await page.locator('#inventory-list, #inventory-search').count(), 0);
  }, status, {}, { csrfToken: 'synthetic-flow', beforeNavigate: manualBridge, handlers: {
    openBrowser: async () => { opens++; status.phase = 'ready'; },
    listClassrooms: async () => [{ title: '课堂 A', url: a }, { title: '课堂 B', url: b }],
    scan: async url => { scans++; status.phase = 'inventory-complete'; snapshot = { courseUrl: url,
      courseTitle: url === a ? '课堂 A' : '课堂 B', pagesScanned: 1, complete: true,
      items: url === a ? [{ title: '模拟视频一', page: 1, index: 0, progress: 0 }] : [] }; },
    start: async () => { throw new Error('local selection must not execute a formal task'); },
  } });
});

test('official login expiry and empty classroom results explain the next action without any extra account', async () => {
  let expired = true;
  await withPage(null, async page => {
    await page.locator('#load-classrooms').click();
    await page.locator('#form-error').waitFor({ state: 'visible' });
    assert.match(await page.locator('#form-error').innerText(), /官方页面重新登录/);
    assert.doesNotMatch(await page.locator('#form-error').innerText(), /短信|LOGIN_REQUIRED/);
    expired = false; await page.locator('#load-classrooms').click();
    await page.waitForFunction(() => document.querySelector('#form-error').textContent.includes('课堂'));
    assert.match(await page.locator('#form-error').innerText(), /暂无可选课程.*手动粘贴/);
    assert.equal(await page.locator('#scan').isDisabled(), true);
    assert.deepEqual(await page.evaluate(() => window.__manualOpens), []);
  }, { phase: 'ready', completed: 0 }, {}, { csrfToken: 'synthetic-login',
    beforeNavigate: manualBridge, handlers: { listClassrooms: async () => {
      if (expired) throw new RunError('LOGIN_REQUIRED', 'synthetic login expired');
      return [];
    } } });
});

test('local service loss disables actions but retains the map and selection; reconnection never opens or plays', async () => {
  const snapshot = { courseUrl: 'https://www.educoder.net/classrooms/SyntheticRecovery/video',
    courseTitle: '隔离恢复课堂', complete: true, pagesScanned: 1,
    items: [{ page: 1, index: 0, title: '记录仍保留', progress: 20 }] };
  await withPage(snapshot, async page => {
    await page.locator('.heatmap-cell').waitFor();
    await page.route('**/api/status', route => route.abort());
    await page.locator('#local-connection').waitFor({ state: 'visible', timeout: 4_000 });
    assert.match(await page.locator('#local-connection').innerText(), /已保存.*不会自动开始/);
    for (const id of ['open', 'load-classrooms', 'scan'])
      assert.equal(await page.locator(`#${id}`).isDisabled(), true);
    assert.equal(await page.locator('.heatmap-cell').count(), 1);
    assert.match(await page.locator('.heatmap-cell').getAttribute('aria-label'), /记录仍保留/);
    await page.unroute('**/api/status');
    await page.locator('#local-connection').waitFor({ state: 'hidden', timeout: 4_000 });
    assert.deepEqual(await page.evaluate(() => window.__manualOpens), []);
  }, { phase: 'ready', completed: 0 }, {}, { csrfToken: 'synthetic-recovery',
    beforeNavigate: manualBridge });
});

test('appearance follows system until explicitly chosen and preserves white-to-blue and unknown encoding in both themes', async () => {
  const snapshot = { courseUrl: 'https://www.educoder.net/classrooms/SyntheticColors/video',
    courseTitle: '极端进度与未知状态', complete: true, pagesScanned: 1,
    items: [{ page: 1, index: 0, title: '零进度', progress: 0 },
      { page: 1, index: 1, title: '全部完成', progress: 100 }, { page: 1, index: 2, title: '进度未读取' }] };
  await withPage(snapshot, async page => {
    await page.locator('.heatmap-cell').nth(2).waitFor();
    assert.equal(await page.locator('#appearance-mode').inputValue(), 'system');
    await page.emulateMedia({ colorScheme: 'dark' });
    assert.equal(await page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue('--app-bg').trim()), '#0e1420');
    const cells = page.locator('.heatmap-cell');
    for (const mode of ['light', 'dark']) {
      await page.locator('#appearance-mode').selectOption(mode);
      assert.equal(await page.locator('html').getAttribute('data-theme'), mode);
      const colors = await cells.evaluateAll(nodes => nodes.map(node => getComputedStyle(node).backgroundColor));
      assert.deepEqual(colors.slice(0, 2), ['rgb(255, 255, 255)', 'rgb(23, 60, 140)']);
      assert.match(await cells.nth(2).getAttribute('aria-label'), /待确认|未知/);
      assert.equal(await cells.nth(2).innerText(), '?');
      assert.equal(await cells.nth(2).evaluate(node => getComputedStyle(node).borderStyle), 'dashed');
    }
    await page.emulateMedia({ colorScheme: 'light' });
    assert.equal(await page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue('--app-bg').trim()), '#0e1420');
    await page.reload(); await cells.nth(2).waitFor();
    assert.equal(await page.locator('#appearance-mode').inputValue(), 'dark');
    await page.emulateMedia({ forcedColors: 'active' });
    assert.equal(await cells.nth(1).evaluate(node => getComputedStyle(node, '::before').content), '"100"');
  }, undefined, {}, { csrfToken: 'synthetic-colors', beforeNavigate: manualBridge });
});

test('heatmap keeps exact official values on a smooth ramp with readable glyphs and distinct unknown cells in both themes', async () => {
  const values = [...Array.from({ length: 101 }, (_, index) => index), 35.5, null, -1, 101, '0', undefined];
  const snapshot = { courseUrl: 'https://www.educoder.net/classrooms/SyntheticSmoothColors/video',
    courseTitle: 'Synthetic official palette', complete: true, pagesScanned: Math.ceil(values.length / 14),
    items: values.map((progress, index) => ({ page: Math.floor(index / 14) + 1, index: index % 14,
      title: `Official sample ${index}`, progress })) };
  const luminance = color => {
    const channels = color.match(/[\d.]+/g).slice(0, 3).map(Number).map(value => {
      const encoded = value / 255;
      return encoded <= 0.04045 ? encoded / 12.92 : ((encoded + 0.055) / 1.055) ** 2.4;
    });
    return 0.2126 * channels[0] + 0.7152 * channels[1] + 0.0722 * channels[2];
  };
  const contrast = (one, two) => (Math.max(luminance(one), luminance(two)) + 0.05) / (Math.min(luminance(one), luminance(two)) + 0.05);
  await withPage(snapshot, async page => {
    const cells = page.locator('.heatmap-cell'); await cells.last().waitFor();
    let previousColors;
    for (const theme of ['light', 'dark']) {
      await page.locator('#appearance-mode').selectOption(theme);
      const styles = await cells.evaluateAll(nodes => nodes.map(node => ({
        value: node.dataset.progress, background: getComputedStyle(node).backgroundColor,
        ink: getComputedStyle(node, '::before').color, border: getComputedStyle(node).borderColor,
        borderStyle: getComputedStyle(node).borderStyle, pattern: getComputedStyle(node).backgroundImage,
        text: node.textContent, unknown: node.classList.contains('is-unknown'),
      })));
      const colors = styles.slice(0, 101).map(style => style.background);
      assert.equal(colors[0], 'rgb(255, 255, 255)'); assert.equal(colors[100], 'rgb(23, 60, 140)');
      if (previousColors) assert.deepEqual(colors, previousColors); previousColors = colors;
      for (let index = 1; index <= 100; index++) {
        assert.ok(luminance(colors[index]) < luminance(colors[index - 1]), `Progress ${index} must darken continuously`);
        assert.equal(styles[index].value, String(index));
      }
      const lightness = colors.map(color => 116 * Math.cbrt(luminance(color)) - 16);
      const gaps = Array.from({ length: 10 }, (_, index) => lightness[index * 10] - lightness[(index + 1) * 10]);
      assert.ok(Math.max(...gaps) / Math.min(...gaps) < 1.35, `Uneven perceived lightness: ${gaps}`);
      assert.ok(contrast(colors[10], colors[0]) >= 1.18, 'Low official progress needs a visible tint');
      for (const style of styles.slice(0, 102)) assert.ok(contrast(style.ink, style.background) >= 4.5, `Unreadable playback glyph at ${style.value}`);
      const panel = await page.locator('.inventory-panel').evaluate(node => getComputedStyle(node).backgroundColor);
      assert.ok(contrast(styles[100].border, panel) >= 3, 'Completed cells need a visible boundary in this theme');
      for (const style of styles.slice(102)) {
        assert.equal(style.unknown, true); assert.equal(style.value, '?'); assert.equal(style.text, '?');
        assert.equal(style.borderStyle, 'dashed'); assert.notEqual(style.background, colors[0]);
        assert.match(style.pattern, /repeating-linear-gradient/);
      }
      const legend = await page.locator('.heatmap-legend-scale').evaluate(node => getComputedStyle(node).backgroundImage);
      for (let progress = 0; progress <= 100; progress += 10) assert.ok(legend.includes(`${colors[progress]} ${progress}%`));
      assert.equal(await page.locator('.heatmap-row').count(), snapshot.pagesScanned);
      assert.equal(await cells.nth(101).getAttribute('data-progress'), '35.5');
      await cells.nth(101).focus(); assert.match(await page.locator('#heatmap-tooltip-meta').innerText(), /35\.5%/);
      assert.equal(await page.locator('#inventory-done').innerText(), '1');
    }
    assert.deepEqual(await page.evaluate(() => window.__manualOpens), []);
    assert.equal(await page.locator('#inventory-list, #inventory-search').count(), 0);
  }, { phase: 'ready', completed: 0, officialSessionOpen: true }, {},
  { csrfToken: 'synthetic-smooth-palette', beforeNavigate: manualBridge });
});

test('a loading scan blocks selection, explains failure and can retry all-complete or all-zero snapshots without wrapping pages', async () => {
  const courseUrl = 'https://www.educoder.net/classrooms/SyntheticScan/video';
  const status = { phase: 'ready', completed: 0 }; let snapshot = null, finishScan;
  const waiting = new Promise(resolve => { finishScan = resolve; }); let scans = 0;
  await withPage(() => snapshot, async page => {
    await page.locator('#classroom-url').fill(courseUrl); await page.locator('#scan').click();
    try {
      await page.waitForFunction(() => document.querySelector('#phase').textContent.includes('正在扫描'), null, { timeout: 4_000 });
      assert.equal(await page.locator('#scan').isDisabled(), true);
      assert.equal(await page.locator('.heatmap-cell').count(), 0);
    } finally { finishScan(); }
    await page.locator('#error').waitFor({ state: 'visible' });
    assert.match(await page.locator('#error').innerText(), /加载失败.*网络/);
    for (const mode of ['light', 'dark']) {
      await page.locator('#appearance-mode').selectOption(mode);
      for (const progress of [100, 0]) {
        await page.locator('#scan').click();
        await page.waitForFunction(expected => document.querySelector('#inventory-done').textContent === expected, progress === 100 ? '28' : '0');
        const colors = await page.locator('.heatmap-cell').evaluateAll(nodes => nodes.map(node => getComputedStyle(node).backgroundColor));
        assert.equal(colors.length, 28); assert.ok(colors.every(color => color === (progress ? 'rgb(23, 60, 140)' : 'rgb(255, 255, 255)')));
        assert.equal(await page.locator('.heatmap-row').count(), 2);
        assert.equal(await page.locator('.heatmap-row').first().locator('.heatmap-cell').count(), 14);
      }
    }
    assert.deepEqual(await page.evaluate(() => window.__manualOpens), []);
  }, status, {}, { csrfToken: 'synthetic-scan', beforeNavigate: manualBridge, handlers: {
    scan: async () => {
      scans++;
      if (scans === 1) { status.phase = 'inventory-scanning'; await waiting;
        status.phase = 'inventory-partial'; status.errorCode = 'PAGE_LOAD_FAILED'; return; }
      status.phase = 'inventory-complete'; delete status.errorCode;
      const progress = scans % 2 === 0 ? 100 : 0;
      snapshot = { courseUrl, courseTitle: '极端进度示例', complete: true, pagesScanned: 2,
        items: Array.from({ length: 28 }, (_, i) => ({ title: `模拟 ${i + 1}`, page: Math.floor(i / 14) + 1, index: i % 14, progress })) };
    },
  } });
});

test('desktop scan obtains a launch token before sending a write request', async () => {
  let scans = 0;
  await withPage(null, async page => {
    await page.locator('#classroom-url').fill('https://www.educoder.net/classrooms/SyntheticCourse/video');
    await page.locator('#scan').click();
    const deadline = Date.now() + 2_000;
    while (!scans && Date.now() < deadline) await page.waitForTimeout(50);
    assert.equal(scans, 1);
    assert.equal(await page.locator('#form-error').isVisible(), false);
  }, { phase: 'idle', completed: 0 }, {}, {
    csrfToken: 'test-secret',
    handlers: { scan: async () => { scans++; } },
  });
});

test('student selects a joined classroom and immediately starts a read-only scan', async () => {
  const url = 'https://www.educoder.net/classrooms/SyntheticCourse/video';
  let scannedUrl;
  await withPage(null, async page => {
    await page.locator('#load-classrooms').click();
    await page.locator('#classroom-select').waitFor({ state: 'visible', timeout: 2_000 });
    assert.equal(await page.locator('#classroom-select option').count(), 3);
    await page.locator('#classroom-select').selectOption(url);
    const deadline = Date.now() + 2_000;
    while (!scannedUrl && Date.now() < deadline) await page.waitForTimeout(50);
    assert.equal(scannedUrl, url);
    assert.equal(await page.locator('#classroom-url').inputValue(), url);
  }, { phase: 'ready', completed: 0 }, {}, { csrfToken: 'test-secret', handlers: {
    listClassrooms: async () => [
      { title: '离散数学', url: 'https://www.educoder.net/classrooms/demo8cls/video' },
      { title: '数据结构与算法', url },
    ],
    scan: async receivedUrl => { scannedUrl = receivedUrl; },
    start: async () => { throw new Error('selecting a classroom must not play a video'); },
  } });
});

test('classroom identifiers differing only by case are not treated as the same course', async () => {
  const inventory = { courseUrl: 'https://www.educoder.net/classrooms/AbC123/video',
    courseTitle: '课堂 A', scannedAt: '2026-09-25T00:00:00.000Z', pagesScanned: 2,
    complete: true, items: [{ page: 1, index: 0, title: '第一条', progress: 0 }] };
  await withPage(inventory, async page => {
    await page.locator('#inventory-title').waitFor({ timeout: 2_000 });
    await page.locator('#classroom-url').fill('https://www.educoder.net/classrooms/abc123/video');
    assert.equal(await page.locator('#course-mismatch').isVisible(), true);
  }, { phase: 'ready', completed: 0 });
});

test('manual classroom link remains available when my classroom discovery fails', async () => {
  let scannedUrl;
  await withPage(null, async page => {
    await page.locator('#load-classrooms').click();
    await page.locator('#form-error').waitFor({ state: 'visible', timeout: 2_000 });
    assert.match(await page.locator('#form-error').textContent(), /暂时无法读取/);
    assert.equal(await page.locator('#classroom-url').isVisible(), true);
    await page.locator('#classroom-url').fill('https://www.educoder.net/classrooms/SyntheticCourse/video');
    await page.locator('#scan').click();
    const deadline = Date.now() + 2_000;
    while (!scannedUrl && Date.now() < deadline) await page.waitForTimeout(50);
    assert.equal(scannedUrl, 'https://www.educoder.net/classrooms/SyntheticCourse/video');
  }, { phase: 'ready', completed: 0 }, {}, { csrfToken: 'test-secret', handlers: {
    listClassrooms: async () => { throw new Error('暂时无法读取我的课堂'); },
    scan: async url => { scannedUrl = url; },
  } });
});

test('classroom discovery immediately disables other course actions until the choices arrive', async () => {
  let release;
  const choices = new Promise(resolve => { release = resolve; });
  await withPage(null, async page => {
    await page.locator('#load-classrooms').click();
    try {
      assert.equal(await page.locator('#load-classrooms').isDisabled(), true);
      assert.equal(await page.locator('#scan').isDisabled(), true);
      assert.equal(await page.locator('#classroom-select').isDisabled(), true);
    } finally {
      release([]);
    }
    await page.locator('#load-classrooms').waitFor({ state: 'visible', timeout: 2_000 });
  }, { phase: 'ready', completed: 0 }, {}, { csrfToken: 'test-secret', handlers: {
    listClassrooms: async () => choices,
  } });
});

test('opening the official browser disables classroom actions until the session is ready', async () => {
  let finishOpening;
  const opening = new Promise(resolve => { finishOpening = resolve; });
  await withPage(null, async page => {
    await page.locator('#open').click();
    try {
      assert.equal(await page.locator('#open').isDisabled(), true);
      assert.equal(await page.locator('#load-classrooms').isDisabled(), true);
      assert.equal(await page.locator('#scan').isDisabled(), true);
    } finally {
      finishOpening();
    }
    await page.locator('#open').waitFor({ state: 'visible', timeout: 2_000 });
  }, { phase: 'idle', completed: 0 }, {}, { csrfToken: 'test-secret', handlers: {
    openBrowser: async () => opening,
  } });
});

test('desktop page names its own browser instead of requiring installed Chrome', async () => {
  await withPage(null, async page => {
    await page.waitForFunction(() => document.querySelector('#open')?.textContent.includes('官方登录'), null, { timeout: 2_000 });
    assert.equal(await page.locator('#open').innerText(), '打开官方登录窗口');
    assert.match(await page.locator('#app-intro').innerText(), /查看官方进度.*打开所选视频/);
    assert.match(await page.locator('#browser-instruction').textContent(), /专用浏览器/);
  }, { phase: 'idle', completed: 0 }, {}, { csrfToken: 'test-secret' });
});

test('copied diagnostic describes the failure without leaking raw page errors', async () => {
  await withPage(null, async page => {
    await page.locator('#copy-diagnostic').waitFor({ state: 'visible', timeout: 2_000 });
    await page.evaluate(() => {
      window.__copiedDiagnostic = '';
      Object.defineProperty(navigator, 'clipboard', { configurable: true, value: {
        writeText: async value => { window.__copiedDiagnostic = value; },
      } });
    });
    await page.locator('#copy-diagnostic').click();
    const copied = await page.evaluate(() => window.__copiedDiagnostic);
    assert.match(copied, /MEDIA_ERROR/);
    assert.match(copied, /failed/);
    assert.doesNotMatch(copied, /secret-cookie|private-video-title/);
  }, { phase: 'failed', errorCode: 'MEDIA_ERROR', error: 'secret-cookie private-video-title' });
});

test('a scan page-load failure tells the user how to retry', async () => {
  await withPage(null, async page => {
    await page.locator('#error').waitFor({ state: 'visible', timeout: 2_000 });
    assert.match(await page.locator('#error').textContent(), /视频列表加载失败.*再试/);
  }, { phase: 'failed', completed: 1, errorCode: 'PAGE_LOAD_FAILED', error: 'page.waitForLoadState timeout' });
});

test('student workspace prioritizes scan and heatmap without a text list', async () => {
  const inventory = {
    courseUrl: 'https://www.educoder.net/classrooms/SyntheticCourse/video',
    courseTitle: '模拟测试课堂',
    scannedAt: '2026-09-23T12:00:00.000Z',
    pagesScanned: 2,
    complete: true,
    items: [
      { page: 1, index: 0, title: '3 线性表', progress: 100 },
      { page: 1, index: 1, title: '4 顺序表 1', progress: 0 },
      { page: 2, index: 0, title: '4 顺序表 2', progress: 35 },
    ],
  };
  await withPage(inventory, async page => {
    await page.locator('#inventory-title').waitFor({ timeout: 2_000 });
    assert.equal(await page.locator('#inventory-title').textContent(), inventory.courseTitle);
    assert.equal(await page.locator('#inventory-completed').textContent(), '1');
    assert.equal(await page.locator('#inventory-total').textContent(), '3');
    assert.equal(await page.locator('#inventory-pending').textContent(), '2');
    assert.equal(await page.locator('.heatmap-cell').count(), 3);
    assert.equal(await page.locator('#inventory-details').count(), 0);
    assert.equal(await page.locator('#inventory-search').count(), 0);
    assert.equal(await page.locator('#filter-pending').count(), 0);
    assert.equal(await page.locator('#scan').isVisible(), true);
    const geometry = await page.evaluate(() => ({
      sidebar: document.querySelector('.workspace-sidebar').getBoundingClientRect(),
      content: document.querySelector('.workspace-content').getBoundingClientRect(),
    }));
    assert.ok(geometry.sidebar.bottom <= geometry.content.top, 'classroom selection precedes the playback workspace');
  });
});

test('student draft survives reload and distinguishes a different saved classroom', async () => {
  const inventory = {
    courseUrl: 'https://www.educoder.net/classrooms/SyntheticCourse/video',
    courseTitle: '模拟测试课堂',
    scannedAt: '2026-09-23T12:00:00.000Z',
    pagesScanned: 8,
    complete: true,
    items: [{ page: 1, index: 0, title: '3 线性表', progress: 100 }],
  };
  await withPage(inventory, async page => {
    await page.locator('#classroom-url').fill('https://www.educoder.net/classrooms/demo8cls/announcement');
    await page.locator('#course-mismatch').waitFor({ state: 'visible', timeout: 2_000 });
    assert.match(await page.locator('#course-mismatch').textContent(), /模拟测试课堂/);
    await page.reload();
    assert.equal(await page.locator('#classroom-url').inputValue(), 'https://www.educoder.net/classrooms/demo8cls/announcement');
    await page.locator('#use-snapshot-course').click();
    assert.equal(await page.locator('#classroom-url').inputValue(), inventory.courseUrl);
    assert.equal(await page.locator('#course-mismatch').isVisible(), false);
  });
});

test('scan status reports pages and videos rather than playback counts', async () => {
  const inventory = {
    courseUrl: 'https://www.educoder.net/classrooms/SyntheticCourse/video',
    courseTitle: '模拟测试课堂',
    scannedAt: '2026-09-23T12:00:00.000Z',
    pagesScanned: 8,
    complete: true,
    items: [{ page: 1, index: 0, title: '3 线性表', progress: 100 }],
  };
  await withPage(inventory, async page => {
    await page.locator('#phase').waitFor();
    assert.match(await page.locator('#status-title').textContent(), /扫描/);
    assert.equal(await page.locator('strong#page').evaluate(el => el.previousElementSibling.textContent), '已扫描页');
    assert.equal(await page.locator('#page').textContent(), '8');
    assert.equal(await page.locator('strong#completed').evaluate(el => el.previousElementSibling.textContent), '已读取视频');
    assert.equal(await page.locator('#completed').textContent(), '106');
    assert.equal(await page.locator('#time').textContent(), '只读');
    assert.equal(await page.locator('#video').isVisible(), false);
  }, { phase: 'inventory-complete', pagesScanned: 8, itemsScanned: 106 });
});

test('invalid classroom link error remains visible until the user changes the field', async () => {
  await withPage(null, async page => {
    await page.locator('#classroom-url').fill('https://example.org/classrooms/wrong/video');
    await page.locator('#scan').click();
    await page.locator('#form-error').waitFor({ state: 'visible', timeout: 2_000 });
    assert.match(await page.locator('#form-error').textContent(), /有效的头歌课堂链接/);
    await page.waitForTimeout(2_300);
    assert.equal(await page.locator('#form-error').isVisible(), true);
    await page.locator('#classroom-url').fill('https://www.educoder.net/classrooms/SyntheticCourse/video');
    assert.equal(await page.locator('#form-error').isVisible(), false);
  });
});

test('mobile workspace stacks controls above the course heatmap', async () => {
  const inventory = {
    courseUrl: 'https://www.educoder.net/classrooms/SyntheticCourse/video',
    courseTitle: '模拟测试课堂',
    scannedAt: '2026-09-23T12:00:00.000Z',
    pagesScanned: 1,
    complete: true,
    items: [{ page: 1, index: 0, title: '3 线性表', progress: 100 }],
  };
  await withPage(inventory, async page => {
    const geometry = await page.evaluate(() => ({
      sidebar: document.querySelector('.workspace-sidebar').getBoundingClientRect(),
      content: document.querySelector('.workspace-content').getBoundingClientRect(),
      pageWidth: document.documentElement.scrollWidth,
      viewportWidth: window.innerWidth,
    }));
    assert.ok(geometry.sidebar.bottom <= geometry.content.top);
    assert.ok(geometry.pageWidth <= geometry.viewportWidth);
  }, undefined, { viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });
});

test('video heatmap arranges videos by page and darkens with exact completion', async () => {
  const inventory = {
    courseUrl: 'https://www.educoder.net/classrooms/SyntheticCourse/video',
    courseTitle: '模拟测试课堂',
    scannedAt: '2026-09-23T12:00:00.000Z',
    pagesScanned: 2,
    complete: true,
    items: [
      { page: 1, index: 0, title: '3 线性表', progress: 100 },
      { page: 1, index: 1, title: '4 顺序表 1', progress: 0 },
      { page: 2, index: 0, title: '4 顺序表 2', progress: 35 },
    ],
  };
  await withPage(inventory, async page => {
    await page.locator('.heatmap-cell').first().waitFor({ timeout: 2_000 });
    assert.equal(await page.locator('.heatmap-row').count(), 2);
    assert.equal(await page.locator('.heatmap-cell').count(), 3);
    assert.match(await page.locator('.heatmap-row').first().textContent(), /第 1 页/);
    const colors = await page.locator('.heatmap-cell').evaluateAll(cells => cells.map(cell => getComputedStyle(cell).backgroundColor));
    const brightness = color => color.match(/\d+/g).slice(0, 3).map(Number).reduce((sum, value) => sum + value, 0);
    assert.ok(brightness(colors[1]) > brightness(colors[2]));
    assert.ok(brightness(colors[2]) > brightness(colors[0]));
    const completedCell = page.locator('.heatmap-cell').first();
    assert.match(await completedCell.getAttribute('aria-label'), /已完成/);
    assert.equal(await completedCell.getAttribute('aria-controls'), 'heatmap-tooltip');
    assert.equal(await completedCell.getAttribute('aria-describedby'), 'heatmap-tooltip');
    await completedCell.focus();
    assert.equal(await completedCell.getAttribute('aria-expanded'), 'true');
    await page.locator('.heatmap-cell[data-page="2"][data-index="0"]').hover();
    await page.locator('#heatmap-tooltip').waitFor({ state: 'visible', timeout: 2_000 });
    const detail = await page.locator('#heatmap-tooltip').textContent();
    assert.match(detail, /4 顺序表 2/);
    assert.match(detail, /第 2 页/);
    assert.match(detail, /35%/);
  });
});

test('touch users can tap a heatmap cell for details without starting a video', async () => {
  const inventory = {
    courseUrl: 'https://www.educoder.net/classrooms/SyntheticCourse/video',
    courseTitle: '模拟测试课堂',
    scannedAt: '2026-09-23T12:00:00.000Z',
    pagesScanned: 1,
    complete: true,
    items: [{ page: 1, index: 0, title: '3 线性表', progress: 100 }],
  };
  await withPage(inventory, async page => {
    await page.locator('.heatmap-cell').first().tap({ timeout: 2_000 });
    assert.equal(await page.locator('#heatmap-tooltip').isVisible(), true);
    assert.match(await page.locator('#heatmap-tooltip').textContent(), /3 线性表/);
    assert.match(page.url(), /127\.0\.0\.1/);
    await page.locator('#heatmap-heading').click();
    assert.equal(await page.locator('#heatmap-tooltip').isVisible(), false);
  }, undefined, { viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });
});

test('a long video title keeps the touch tooltip inside a short mobile viewport', async () => {
  const inventory = {
    courseUrl: 'https://www.educoder.net/classrooms/SyntheticCourse/video',
    courseTitle: '模拟测试课堂',
    scannedAt: '2026-09-23T12:00:00.000Z',
    pagesScanned: 1,
    complete: true,
    items: [{
      page: 1,
      index: 0,
      title: '数据结构与算法中关于动态查找表和二叉查找树的应用讲解'.repeat(4),
      progress: 35,
    }],
  };
  await withPage(inventory, async page => {
    await page.locator('.heatmap-cell').first().tap();
    const bounds = await page.locator('#heatmap-tooltip').evaluate(tooltip => {
      const rect = tooltip.getBoundingClientRect();
      return { top: rect.top, bottom: rect.bottom, viewport: window.innerHeight };
    });
    assert.ok(bounds.top >= 8, JSON.stringify(bounds));
    assert.ok(bounds.bottom <= bounds.viewport - 8, JSON.stringify(bounds));
  }, undefined, { viewport: { width: 390, height: 260 }, hasTouch: true, isMobile: true });
});

test('a live scan update keeps keyboard focus on the same video square', async () => {
  const first = { page: 1, index: 0, title: '3 线性表', progress: 35 };
  let snapshot = {
    courseUrl: 'https://www.educoder.net/classrooms/SyntheticCourse/video',
    courseTitle: '模拟测试课堂',
    scannedAt: null,
    pagesScanned: 1,
    complete: false,
    items: [first],
  };
  await withPage(() => snapshot, async page => {
    const firstCell = page.locator('.heatmap-cell[data-page="1"][data-index="0"]');
    await firstCell.waitFor({ timeout: 2_000 });
    await firstCell.focus();
    assert.equal(await firstCell.evaluate(cell => document.activeElement === cell), true);
    snapshot = { ...snapshot, pagesScanned: 2, items: [first, { page: 2, index: 0, title: '4 顺序表 1', progress: 0 }] };
    await page.waitForFunction(() => document.querySelectorAll('.heatmap-cell').length === 2, null, { timeout: 5_000 });
    assert.equal(await firstCell.evaluate(cell => document.activeElement === cell), true);
    assert.equal(await page.locator('#heatmap-tooltip').isVisible(), true);
  });
});

test('arrow keys move heatmap focus while a single Tab exits the graph', async () => {
  const inventory = {
    courseUrl: 'https://www.educoder.net/classrooms/SyntheticCourse/video',
    courseTitle: '模拟测试课堂',
    scannedAt: '2026-09-23T12:00:00.000Z',
    pagesScanned: 1,
    complete: true,
    items: [
      { page: 1, index: 0, title: '第一条', progress: 100 },
      { page: 1, index: 1, title: '第二条', progress: 35 },
    ],
  };
  await withPage(inventory, async page => {
    await page.locator('.heatmap-cell').first().click();
    assert.match(await page.locator('#heatmap-tooltip').textContent(), /第一条/);
    await page.keyboard.press('ArrowRight');
    assert.match(await page.locator('#heatmap-tooltip').textContent(), /第二条/);
    await page.keyboard.press('Tab');
    assert.equal(await page.locator('#heatmap-tooltip').isVisible(), false);
  });
});

test('a pinned tooltip does not stay at an unrelated screen position after scrolling', async () => {
  const inventory = {
    courseUrl: 'https://www.educoder.net/classrooms/SyntheticCourse/video',
    courseTitle: '模拟测试课堂',
    scannedAt: '2026-09-23T12:00:00.000Z',
    pagesScanned: 1,
    complete: true,
    items: [{ page: 1, index: 0, title: '3 线性表', progress: 100 }],
  };
  await withPage(inventory, async page => {
    await page.locator('.heatmap-cell').first().click();
    const before = await page.evaluate(() => ({
      cellTop: document.querySelector('.heatmap-cell').getBoundingClientRect().top,
      tooltipTop: document.querySelector('#heatmap-tooltip').getBoundingClientRect().top,
    }));
    await page.evaluate(() => window.scrollBy(0, -100));
    await page.waitForFunction(top => Math.abs(document.querySelector('.heatmap-cell').getBoundingClientRect().top - top) > 20, before.cellTop, { timeout: 2_000 });
    await page.waitForFunction(top => {
      const tooltip = document.querySelector('#heatmap-tooltip');
      return tooltip.hidden || Math.abs(tooltip.getBoundingClientRect().top - top) > 20;
    }, before.tooltipTop, { timeout: 2_000 });
    const after = await page.evaluate(() => ({
      hidden: document.querySelector('#heatmap-tooltip').hidden,
      tooltipTop: document.querySelector('#heatmap-tooltip').getBoundingClientRect().top,
    }));
    assert.ok(after.hidden || Math.abs(after.tooltipTop - before.tooltipTop) > 20, JSON.stringify({ before, after }));
  }, undefined, { viewport: { width: 1100, height: 400 } });
});

test('partial scan is conspicuously labelled and does not imply a whole-course total', async () => {
  const inventory = {
    courseUrl: 'https://www.educoder.net/classrooms/SyntheticCourse/video',
    courseTitle: '模拟测试课堂',
    scannedAt: '2026-09-23T12:00:00.000Z',
    pagesScanned: 1,
    complete: false,
    error: '第 2 页加载超时',
    items: [{ page: 1, index: 0, title: '3 线性表', progress: 100 }],
  };
  await withPage(inventory, async page => {
    await page.locator('#inventory-warning').waitFor({ state: 'visible', timeout: 2_000 });
    assert.match(await page.locator('#inventory-warning').textContent(), /仅扫描了 1 页/);
    assert.match(await page.locator('#inventory-warning').textContent(), /第 2 页加载超时/);
    assert.match(await page.locator('#inventory-scope').textContent(), /已扫描/);
  });
});

test('a failed zero-page scan labels any retained complete snapshot as old data', async () => {
  const inventory = {
    courseUrl: 'https://www.educoder.net/classrooms/demo8cls/video',
    courseTitle: '离散数学',
    scannedAt: '2026-09-22T12:00:00.000Z',
    pagesScanned: 1,
    complete: true,
    items: [{ page: 1, index: 0, title: '集合', progress: 100 }],
  };
  await withPage(inventory, async page => {
    await page.locator('#inventory-warning').waitFor({ state: 'visible', timeout: 2_000 });
    assert.match(await page.locator('#inventory-warning').textContent(), /上次扫描结果/);
    assert.match(await page.locator('#inventory-warning').textContent(), /新课堂加载超时/);
    assert.equal(await page.locator('#inventory-title').textContent(), '离散数学');
  }, { phase: 'inventory-partial', pagesScanned: 0, itemsScanned: 0, error: '新课堂加载超时' });
});

test('stopped scan makes the retained complete snapshot explicit', async () => {
  const inventory = {
    courseUrl: 'https://www.educoder.net/classrooms/SyntheticCourse/video',
    courseTitle: '模拟测试课堂',
    scannedAt: '2026-09-23T12:00:00.000Z',
    pagesScanned: 8,
    complete: true,
    items: [{ page: 1, index: 0, title: '3 线性表', progress: 100 }],
  };
  await withPage(inventory, async page => {
    await page.locator('#inventory-warning').waitFor({ state: 'visible', timeout: 2_000 });
    assert.match(await page.locator('#inventory-warning').textContent(), /上次完整清单/);
    assert.match(await page.locator('#inventory-warning').textContent(), /6 页/);
    assert.equal(await page.locator('#inventory-title').textContent(), inventory.courseTitle);
  }, { phase: 'inventory-stopped', pagesScanned: 6, itemsScanned: 90, retainedPrevious: true });
});
