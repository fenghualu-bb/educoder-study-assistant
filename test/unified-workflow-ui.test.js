import test from 'node:test';
import assert from 'node:assert/strict';
import { chromium } from 'playwright-core';
import { createServer } from '../src/server.js';
import { listenOnBrowserSafePort } from '../src/loopback-port.js';

const courseUrl = 'https://www.educoder.net/classrooms/SyntheticUnified/video';
const snapshot = { courseUrl, courseTitle: '模拟统一课堂', complete: true, pagesScanned: 1, scannedAt: '2026-10-02T00:00:00Z',
  items: [{ page: 1, index: 0, title: '模拟 A', progress: 20 }, { page: 1, index: 1, title: '模拟 B', progress: 0 }] };
const picks = snapshot.items.map(({ page, index, title }) => ({ courseUrl, page, index, title }));

async function browserPage(run, pageOptions = {}) {
  const browser = await chromium.launch({ executablePath: process.env.CHROME_PATH || 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    headless: true, chromiumSandbox: true });
  try {
    const page = await browser.newPage(pageOptions);
    page.setDefaultTimeout(5_000);
    await run(page);
  } finally { await browser.close(); }
}

async function mainPage(run, { saved = null, recent = null, historyError = false, positionDelay = false, pageOptions = {}, inventory = snapshot, initialState = null } = {}) {
  let currentInventory = inventory;
  const controllerStatus = { phase: 'ready', officialSessionOpen: true };
  const server = createServer({ getStatus: () => controllerStatus, getInventory: () => currentInventory },
    { legacyRunnerDisabled: true, csrfToken: 'synthetic-unified-ui' });
  await listenOnBrowserSafePort(server);
  try {
    await browserPage(async page => {
      await page.addInitScript(({ saved, recent, historyError, positionDelay, initialState }) => {
        const clone = value => value == null ? value : JSON.parse(JSON.stringify(value));
        const listeners = { session: new Set(), closed: new Set(), personal: new Set() };
        window.__calls = []; window.__starts = [];
        window.__saved = clone(saved); window.__recent = clone(recent);
        window.__historyError = historyError; window.__delayPosition = positionDelay;
        window.__preferences = { autoMute: false, speedEnabled: false, speed: 1.5 };
        window.__state = { active: false, embedded: true, viewerOpen: false, opening: false, closing: false,
          revision: 0, version: '0.1.13' };
        if (initialState) window.__state = clone(initialState);
        window.__session = clone(window.__state);
        window.__publish = (state, notify = true) => {
          window.__state = clone(state);
          if (notify) window.__session = clone(state);
          if (notify) for (const callback of listeners.session) callback(clone(state));
          return clone(state);
        };
        window.__notifyClosed = value => { for (const callback of listeners.closed) callback(value); };
        const subscribe = kind => callback => { listeners[kind].add(callback); return () => listeners[kind].delete(callback); };
        const update = patch => window.__publish({ ...window.__state, ...patch, revision: window.__state.revision + 1 }, !window.__quietEvents);
        window.localManualVideo = {
          session: async () => clone(window.__session),
          status: async () => {
            window.__statusReads = (window.__statusReads ?? 0) + 1;
            if (window.__statusError) throw new Error('synthetic status unavailable');
            const captured = clone(window.__state);
            if (window.__delayStatus) return new Promise(resolve => { window.__releaseStatus = () => resolve(captured); });
            return captured;
          },
          start: async request => {
            window.__calls.push('start'); window.__starts.push(clone(request));
            if (window.__delayStart) await new Promise(resolve => { window.__releaseStart = resolve; });
            if (window.__startError) {
              if (window.__startFailure) update({ active: false, stage: 'paused', media: null, queue: null,
                selection: clone(request.selections[0]), failure: clone(window.__startFailure) });
              throw new Error(window.__startError);
            }
            const cursor = request.resumeSaved ? window.__saved.cursor : 0;
            const selection = request.selections[cursor];
            const queue = { mode: request.mode, courseUrl: request.courseUrl,
              active: true, phase: 'playing', reason: '', cursor, total: request.selections.length, completed: cursor,
              selections: clone(request.selections) };
            return update({ active: true, embedded: true, viewerOpen: false, mode: request.mode, selection,
              nextSelection: request.selections[cursor + 1] ?? null, stage: 'playing', failure: null,
              media: { paused: false, currentTime: request.fromBeginning ? 0 : 65, duration: 100, playbackRate: 1, muted: false, volume: 1 },
              resumeSeconds: 65, percent: 20, actionsAvailable: true, playbackOptions: clone(window.__preferences),
              controls: { rates: [1, 1.5, 2] }, queue });
          },
          action: async name => {
            window.__calls.push(name);
            if (name === 'official' || name === 'refresh') return clone(window.__state);
            if (name === 'continue' && window.__state.completionPending) {
              const result = update({ active: false, stage: 'completed', completed: true, completionPending: false,
                media: { ...window.__state.media, paused: true, ended: true },
                queue: { ...window.__state.queue, active: false, phase: 'completed', cursor: window.__state.queue.total, completed: window.__state.queue.total } });
              for (const callback of listeners.closed) callback({ completed: true, discarded: false });
              return result;
            }
            const playing = name === 'continue';
            return update({ stage: playing ? 'playing' : 'paused', media: { ...window.__state.media, paused: !playing },
              queue: window.__state.queue ? { ...window.__state.queue, active: playing, phase: playing ? 'playing' : 'paused',
                reason: playing ? '' : 'USER_PAUSED' } : null });
          },
          finish: async () => {
            window.__calls.push('finish');
            if (window.__delayFinish) await new Promise(resolve => { window.__releaseFinish = resolve; });
            if (window.__finishError) {
              update({ stage: 'paused', media: { ...window.__state.media, paused: true }, discardAvailable: true,
                queue: window.__state.queue ? { ...window.__state.queue, active: false, phase: 'paused' } : null });
              throw new Error('synthetic record conflict');
            }
            if (window.__state.active) {
              const queue = window.__state.queue;
              window.__saved = { mode: window.__state.mode, courseUrl: window.__state.selection.courseUrl,
                total: queue?.total ?? 1, cursor: queue?.cursor ?? 0, active: false, phase: 'stopped',
                selections: clone(queue?.selections ?? [window.__state.selection]) };
              window.__recent = { seconds: window.__state.media.currentTime, selection: clone(window.__state.selection) };
            }
            update({ active: false, embedded: true, viewerOpen: false, stage: 'stopped', media: null, queue: null,
              selection: null, nextSelection: null });
            for (const callback of listeners.closed) callback({ discarded: false });
            return { closed: true };
          },
          discardAndFinish: async () => {
            window.__calls.push('discard');
            update({ active: false, embedded: true, viewerOpen: false, stage: 'stopped', media: null, queue: null });
            for (const callback of listeners.closed) callback({ discarded: true });
          },
          options: async patch => {
            window.__calls.push({ options: clone(patch) });
            if (window.__delayOptions) await new Promise(resolve => { window.__releaseOptions = resolve; });
            if (window.__optionsError) throw new Error('synthetic settings save failed');
            window.__preferences = window.__confirmedOptions ? clone(window.__confirmedOptions) : { ...window.__preferences, ...patch };
            return window.__state.active ? update({ playbackOptions: clone(window.__preferences) }) : clone(window.__preferences);
          },
          playbackOptions: async () => clone(window.__preferences),
          position: async selection => {
            if (window.__positionError) throw new Error('synthetic position read unavailable');
            const result = { seconds: selection.index === 0 ? 65 : 45, selection: clone(selection) };
            if (window.__delayPosition) return new Promise(resolve => { window.__releasePosition = () => resolve(result); });
            return result;
          },
          recent: async () => { if (window.__historyError) throw new Error('synthetic history read unavailable'); return clone(window.__recent); },
          personalSummary: async () => { if (window.__historyError) throw new Error('synthetic history read unavailable'); return clone(window.__saved); },
          onSessionChanged: subscribe('session'), onClosed: subscribe('closed'), onPersonalChanged: subscribe('personal'),
          open: async () => { throw new Error('legacy viewer must not open'); },
          openPersonal: async () => { throw new Error('legacy viewer must not open'); },
          focus: async () => { throw new Error('legacy viewer must not receive focus'); },
        };
      }, { saved, recent, historyError, positionDelay, initialState });
      await page.goto('http://127.0.0.1:' + server.address().port);
      await page.locator('.heatmap-cell').last().waitFor();
      await page.waitForFunction(() => window.studyHome && !document.querySelector('#auto-mute').disabled);
      await run(page, {
        setInventory(value, phase = 'inventory-complete') { currentInventory = value; controllerStatus.phase = phase; },
      });
    }, pageOptions);
  } finally { await new Promise(resolve => server.close(resolve)); }
}

test('first screen offers one-click video playback and a visible temporary batch editor without automatic start', async () => {
  for (const viewport of [{ width: 1200, height: 820 }, { width: 800, height: 600 }]) await mainPage(async page => {
    const batch = page.getByRole('button', { name: '选多条连续播放', exact: true });
    assert.equal(await batch.isVisible(), true);
    const bounds = await batch.boundingBox();
    assert.ok(bounds.y >= 0 && bounds.y + bounds.height <= viewport.height, JSON.stringify({ bounds, viewport }));
    assert.equal(await batch.evaluate(node => Boolean(node.closest('details'))), false);
    assert.equal(await page.locator('#mode-single, #mode-continuous').count(), 0);
    assert.equal(await page.locator('#home-continue').isVisible(), false);
    assert.equal(await page.locator('#selection-area').isVisible(), false);
    assert.match(await page.locator('#app-version').innerText(), /0\.1\.13.*候选版/);
    assert.match(await page.title(), /0\.1\.13.*候选版/);
    assert.equal(await page.locator('#personal-queue-enable, #local-single-video-open, #personal-queue-open, #inventory-search, #inventory-list').count(), 0);
    assert.deepEqual(await page.evaluate(() => window.__calls), []);
    await batch.click();
    assert.equal(await page.locator('#selection-area').isVisible(), true);
    assert.equal(await page.locator('#selection-count').innerText(), '已选 0 条');
    assert.equal(await page.locator('#batch-start').isDisabled(), true);
    await page.locator('.heatmap-cell').first().click(); await page.locator('.heatmap-cell').last().click();
    assert.equal(await page.locator('#batch-start').innerText(), '连续播放所选（2条）');
    assert.deepEqual(await page.evaluate(() => window.__calls), []);
  }, { pageOptions: { viewport } });
});

test('temporary continuous selection starts once and stop returns to default clicks without reviving the old draft', async () => mainPage(async page => {
  await page.locator('#batch-select').click();
  await page.locator('.heatmap-cell').first().click(); await page.locator('.heatmap-cell').last().click();
  assert.equal(await page.locator('#selection-count').innerText(), '已选 2 条');
  assert.deepEqual(await page.locator('#selected-preview li').allTextContents(), ['模拟 A · 第 1 页第 1 条', '模拟 B · 第 1 页第 2 条']);
  assert.deepEqual(await page.locator('.heatmap-cell').evaluateAll(cells => cells.map(cell => cell.dataset.queueOrder)), ['1', '2']);
  assert.deepEqual(await page.evaluate(() => window.__calls), []);
  await page.locator('#batch-start').click();
  assert.deepEqual(await page.evaluate(() => window.__starts), [{ mode: 'continuous', courseUrl, selections: picks, fromBeginning: false, resumeSaved: false, replaceCurrent: false }]);
  assert.equal(await page.locator('#selection-area').isVisible(), false);
  assert.equal(await page.locator('#current-title').innerText(), '模拟 A');
  assert.equal(await page.locator('#next-title').innerText(), '模拟 B');
  assert.equal(await page.locator('#playback-percent').innerText(), '20%');
  assert.equal(await page.locator('#playback-current').innerText(), '1:05');
  assert.equal(await page.locator('#playback-resume').innerText(), '1:05');
  await page.locator('#home-continue').click();
  assert.equal(await page.locator('#home-continue').innerText(), '继续播放');
  for (const id of ['scan', 'load-classrooms', 'classroom-select', 'classroom-url']) assert.equal(await page.locator('#'+id).isDisabled(), true, id);
  assert.deepEqual(await page.locator('.heatmap-cell').evaluateAll(cells => cells.map(cell => cell.disabled)), [false, false]);
  await page.locator('#home-continue').click(); await page.locator('#playback-stop').click();
  await page.waitForFunction(() => document.querySelector('#now-playing').hidden);
  assert.equal(await page.locator('#selection-area').isVisible(), false);
  assert.equal(await page.locator('#home-continue').isVisible(), false);
  assert.deepEqual(await page.evaluate(() => window.__calls), ['start','pause','continue','finish']);
  await page.locator('.heatmap-cell').last().click();
  assert.deepEqual((await page.evaluate(() => window.__starts)).at(-1), { mode:'single', courseUrl, selections:[picks[1]], fromBeginning:false, resumeSaved:false,replaceCurrent:false });
}));

test('batch keyboard toggles, clear and cancellation never start media or change saved history', async () => {
  const saved={mode:'continuous',courseUrl,total:2,cursor:1,active:false,phase:'paused',selections:picks};
  await mainPage(async page => {
    await page.locator('#resume-last-play').waitFor(); await page.locator('#batch-select').click();
    await page.locator('.heatmap-cell').first().press('Enter'); await page.locator('.heatmap-cell').last().press('Enter');
    await page.locator('.heatmap-cell').last().press('Enter');
    assert.deepEqual(await page.locator('.heatmap-cell').evaluateAll(cells=>cells.map(cell=>cell.getAttribute('aria-pressed'))),['true','false']);
    await page.locator('#selection-clear').click();
    assert.equal(await page.locator('#selection-count').innerText(),'已选 0 条');
    assert.equal(await page.locator('#selected-preview li').count(),0);
    assert.equal(await page.locator('#batch-start').isDisabled(),true);
    await page.locator('.heatmap-cell').first().press('Enter'); await page.locator('#selection-cancel').click();
    assert.equal(await page.locator('#selection-area').isVisible(),false);
    assert.deepEqual(await page.evaluate(()=>window.__saved),saved);
    assert.deepEqual(await page.evaluate(()=>window.__calls),[]);
    await page.locator('.heatmap-cell').last().click();
    assert.deepEqual(await page.evaluate(()=>window.__starts),[{mode:'single',courseUrl,selections:[picks[1]],fromBeginning:false,resumeSaved:false,replaceCurrent:false}]);
  },{saved});
});

test('saved playback uses a separate explicit resume button and reopening never starts it', async () => {
  const saved={mode:'continuous',courseUrl,total:2,cursor:1,active:false,phase:'paused',selections:picks};
  await mainPage(async page=>{
    await page.locator('#resume-last-play').waitFor();
    await page.waitForFunction(()=>document.querySelector('#resume-last-description').textContent.includes('0:45'));
    assert.match(await page.locator('#resume-last-description').innerText(),/上次：模拟 B.*0:45.*剩余 1 条.*目前未播放/);
    assert.equal(await page.locator('#home-continue').isVisible(),false);
    assert.deepEqual(await page.evaluate(()=>window.__calls),[]);
    await page.reload(); await page.locator('#resume-last-play').waitFor();
    await page.waitForFunction(()=>!document.querySelector('#resume-last-play').disabled);
    assert.deepEqual(await page.evaluate(()=>window.__calls),[],'reopening remains stopped');
    assert.equal(await page.getByRole('button',{name:'继续上次播放',exact:true}).count(),1);
    await page.locator('#resume-last-play').click();
    assert.deepEqual(await page.evaluate(()=>window.__starts),[{mode:'continuous',courseUrl,selections:picks,fromBeginning:false,resumeSaved:true,replaceCurrent:false}]);
    assert.equal(await page.locator('#current-title').innerText(),'模拟 B');
    assert.equal(await page.locator('#next-title').innerText(),'本次没有下一条');
    assert.equal(await page.locator('#home-continue').innerText(),'暂停播放');
  },{saved});
});

test('a first history read failure is visible and only an explicit retry can enable continuing the saved plan', async () => {
  const saved = { mode: 'continuous', courseUrl, total: 2, cursor: 1, active: false, phase: 'paused', selections: picks };
  await mainPage(async page => {
    const retry = page.getByRole('button', { name: '重试读取上次记录', exact: true });
    await retry.waitFor();
    assert.match(await page.locator('#resume-last-description').innerText(), /上次记录暂未读全.*重试/);
    assert.equal(await page.locator('#resume-last-play').isDisabled(), true);
    assert.deepEqual(await page.evaluate(() => window.__starts), []);
    assert.deepEqual(await page.evaluate(() => window.__saved), saved);
    await page.evaluate(() => { window.__historyError = false; });
    await retry.click();
    const primary = page.getByRole('button', { name: '继续上次播放', exact: true });
    await primary.waitFor();
    assert.equal(await primary.isEnabled(), true);
    assert.match(await page.locator('#resume-last-description').innerText(), /模拟 B.*0:45.*剩余 1 条/);
    assert.equal(await retry.isVisible(), false);
    assert.deepEqual(await page.evaluate(() => window.__calls), []);
    await primary.click();
    assert.deepEqual(await page.evaluate(() => window.__starts), [{ mode: 'continuous', courseUrl, selections: picks, fromBeginning: false, resumeSaved: true, replaceCurrent: false }]);
  }, { saved, historyError: true });
});

test('a previously confirmed saved summary remains visible after a failed refresh but cannot start until revalidated', async () => {
  const saved = { mode: 'continuous', courseUrl, total: 2, cursor: 1, active: false, phase: 'paused', selections: picks };
  await mainPage(async (page, fixture) => {
    await page.getByRole('button', { name: '继续上次播放', exact: true }).waitFor();
    assert.match(await page.locator('#resume-last-description').innerText(), /模拟 B.*0:45/);
    await page.evaluate(() => { window.__historyError = true; });
    fixture.setInventory({ ...snapshot, scannedAt: '2026-10-02T00:00:01Z' });
    const retry = page.getByRole('button', { name: '重试读取上次记录', exact: true });
    await retry.waitFor();
    assert.equal(await page.locator('#resume-last').isVisible(), true);
    assert.match(await page.locator('#resume-last-description').innerText(), /模拟 B.*0:45.*暂未读全.*已确认记录保留/);
    assert.equal(await page.locator('#resume-last-play').isDisabled(), true);
    assert.deepEqual(await page.evaluate(() => window.__calls), []);
    assert.deepEqual(await page.evaluate(() => window.__saved), saved);
    await page.evaluate(() => { window.__historyError = false; });
    await retry.click();
    await page.getByRole('button', { name: '继续上次播放', exact: true }).waitFor();
    assert.equal(await page.locator('#resume-last-play').isEnabled(), true);
    assert.doesNotMatch(await page.locator('#resume-last-description').innerText(), /暂未读全/);
    assert.deepEqual(await page.evaluate(() => window.__calls), []);
  }, { saved });
});

test('saved-position loading blocks history resume; a new explicit batch can opt into starting from the beginning', async()=>{
  const saved={mode:'continuous',courseUrl,total:2,cursor:1,active:false,phase:'paused',selections:picks};
  await mainPage(async page=>{
    await page.waitForFunction(()=>window.__releasePosition);
    assert.match(await page.locator('#resume-last-description').innerText(),/正在读取上次记录/);
    assert.equal(await page.locator('#resume-last-play').isDisabled(),true);
    assert.deepEqual(await page.evaluate(()=>window.__starts),[]);
    await page.evaluate(()=>{window.__delayPosition=false;window.__releasePosition();});
    await page.waitForFunction(()=>!document.querySelector('#resume-last-play').disabled);
    assert.match(await page.locator('#resume-last-description').innerText(),/模拟 B.*0:45/);
    await page.locator('#batch-select').click(); await page.locator('.heatmap-cell').last().click();
    await page.locator('#start-from-beginning').check();
    assert.deepEqual(await page.evaluate(()=>window.__saved),saved);
    await page.locator('#batch-start').click();
    assert.deepEqual(await page.evaluate(()=>window.__starts),[{mode:'continuous',courseUrl,selections:[picks[1]],fromBeginning:true,resumeSaved:false,replaceCurrent:false}]);
    assert.equal(await page.locator('#playback-current').innerText(),'0:00');
  },{saved,positionDelay:true});
});

test('saved history does not redirect a new idle cell click into continuing the old batch',async()=>{
  const saved={mode:'continuous',courseUrl,total:2,cursor:1,active:false,phase:'paused',selections:picks};
  await mainPage(async page=>{
    await page.locator('#resume-last-play').waitFor(); const dialogs=[];
    page.on('dialog',async dialog=>{dialogs.push(dialog.message());await dialog.dismiss();});
    await page.locator('.heatmap-cell').first().click();
    assert.deepEqual(await page.evaluate(()=>window.__starts),[{mode:'single',courseUrl,selections:[picks[0]],fromBeginning:false,resumeSaved:false,replaceCurrent:false}]);
    assert.equal(await page.locator('#current-title').innerText(),'模拟 A');
    assert.deepEqual(dialogs,[]);
  },{saved});
});

test('resume failure keeps original records and never sends a follow-up play or opens batch editing',async()=>{
  const saved={mode:'single',courseUrl,total:1,cursor:0,active:false,phase:'paused',selections:[picks[0]]};
  await mainPage(async page=>{
    await page.locator('#resume-last-play').waitFor(); await page.evaluate(()=>{window.__startError='RESTORE_FAILED';});
    await page.locator('#resume-last-play').click();
    await page.waitForFunction(()=>document.querySelector('#home-viewing-state').textContent.includes('未开始播放'));
    assert.match(await page.locator('#home-viewing-state').innerText(),/记录保留/);
    assert.deepEqual(await page.evaluate(()=>window.__calls),['start']);
    assert.deepEqual(await page.evaluate(()=>window.__saved),saved);
    assert.equal(await page.locator('#selection-area').isVisible(),false);
    assert.equal(await page.locator('#home-continue').isVisible(),false);
  },{saved});
});

test('a failed history resume at a later cursor retries the complete original plan through its independent button',async()=>{
  const saved={mode:'continuous',courseUrl,total:2,cursor:1,active:false,phase:'paused',selections:picks};
  await mainPage(async page=>{
    await page.locator('#resume-last-play').waitFor();await page.evaluate(()=>{window.__startError='RESTORE_FAILED';});
    await page.locator('#resume-last-play').click();
    await page.waitForFunction(()=>document.querySelector('#home-viewing-state').textContent.includes('未开始播放'));
    assert.deepEqual(await page.evaluate(()=>window.__saved),saved);
    assert.deepEqual(await page.evaluate(()=>window.__calls),['start']);
    await page.evaluate(()=>{window.__startError=null;}); await page.locator('#resume-last-play').click();
    const expected={mode:'continuous',courseUrl,selections:picks,fromBeginning:false,resumeSaved:true,replaceCurrent:false};
    assert.deepEqual(await page.evaluate(()=>window.__starts),[expected,expected]);
    assert.equal(await page.locator('#current-title').innerText(),'模拟 B');
    assert.equal(await page.locator('#next-title').innerText(),'本次没有下一条');
    assert.deepEqual(await page.evaluate(()=>window.__calls),['start','start']);
  },{saved});
});

test('pending stop freezes controls; save conflict retains current playback and retry exits without reopening a draft',async()=>mainPage(async page=>{
  await page.locator('#batch-select').click(); await page.locator('.heatmap-cell').first().click();await page.locator('.heatmap-cell').last().click();
  await page.locator('#batch-start').click();await page.evaluate(()=>{window.__delayFinish=true;window.__finishError=true;});
  await page.locator('#playback-stop').click();await page.waitForFunction(()=>window.__releaseFinish);
  assert.equal(await page.locator('#playback-state').innerText(),'正在保存并结束');
  assert.equal(await page.locator('#batch-select').isDisabled(),true);
  assert.equal(await page.locator('#selection-area').isVisible(),false);
  await page.evaluate(()=>{window.__releaseFinish();window.__delayFinish=false;});
  await page.waitForFunction(()=>document.querySelector('#home-viewing-state').textContent.includes('尚未保存'));
  assert.equal(await page.locator('#playback-discard').isVisible(),true);
  assert.equal(await page.locator('#current-title').innerText(),'模拟 A');
  await page.evaluate(()=>{window.__finishError=false;});await page.locator('#playback-stop').click();
  await page.waitForFunction(()=>document.querySelector('#now-playing').hidden);
  assert.equal(await page.locator('#selection-area').isVisible(),false);
  assert.equal(await page.locator('#batch-select').isEnabled(),true);
  assert.deepEqual(await page.evaluate(()=>window.__calls),['start','finish','finish']);
}));

test('partial scan retains later-page picks and a full changed-identity scan requires reselection', async () => {
  const later = { courseUrl, page: 2, index: 0, title: '模拟第二页', cardIdentity: 'https://www.educoder.net/images/synthetic-page2.jpg' };
  const full = { ...snapshot, pagesScanned: 2, items: [snapshot.items[0], { ...later, progress: 0 }] };
  await mainPage(async (page, fixture) => {
    await page.locator('#batch-select').click();
    await page.locator('.heatmap-cell').first().click(); await page.locator('.heatmap-cell').last().click();
    fixture.setInventory({ ...full, complete: false, items: full.items.slice(0, 1) }, 'inventory-scanning');
    await page.waitForFunction(() => document.querySelectorAll('.heatmap-cell').length === 1);
    assert.equal(await page.locator('#selection-count').innerText(), '已选 2 条');
    assert.equal(await page.locator('#batch-start').isDisabled(), true);
    fixture.setInventory(full);
    await page.waitForFunction(() => document.querySelectorAll('.heatmap-cell').length === 2 && !document.querySelector('#batch-start').disabled);
    assert.equal(await page.locator('#selection-count').innerText(), '已选 2 条');
    const changed = { ...full, items: full.items.map(item => ({ ...item, cardIdentity: 'https://www.educoder.net/images/changed-synthetic.jpg' })) };
    fixture.setInventory({ ...changed, complete: false }, 'inventory-scanning');
    await page.waitForFunction(() => document.querySelector('#batch-start').disabled);
    assert.equal(await page.locator('#selection-count').innerText(), '已选 2 条');
    fixture.setInventory(changed);
    await page.waitForFunction(() => document.querySelector('#selection-count').textContent === '已选 0 条');
    assert.equal(await page.locator('#batch-start').isDisabled(), true);
    assert.match(await page.locator('#home-viewing-state').innerText(), /身份有变化/);
    assert.deepEqual(await page.evaluate(() => window.__calls), []);
  }, { inventory: full });
});

test('an alias classroom link uses canonical scanned targets for an explicit from-beginning batch',async()=>mainPage(async page=>{
  await page.getByText('手动填写课堂链接',{exact:true}).click();
  await page.locator('#classroom-url').fill(courseUrl.replace('/video','/announcement?synthetic=1'));
  await page.locator('#batch-select').click();await page.locator('.heatmap-cell').last().click();
  await page.locator('#start-from-beginning').check();await page.locator('#batch-start').click();
  assert.deepEqual(await page.evaluate(()=>window.__starts),[{mode:'continuous',courseUrl,selections:[picks[1]],fromBeginning:true,resumeSaved:false,replaceCurrent:false}]);
  assert.equal(await page.locator('#playback-current').innerText(),'0:00');
}));

test('a paused session event locks course controls and stale session polls cannot release the batch', async () => mainPage(async page => {
  await page.evaluate(pick => {
    window.__publish({ active: true, embedded: true, viewerOpen: false, selection: pick, stage: 'paused',
      media: { paused: true, currentTime: 65, duration: 100, playbackRate: 1 }, revision: 5, version: '0.1.13' });
    window.__session = { active: false, viewerOpen: false, revision: 0, version: '0.1.13' };
  }, picks[0]);
  await page.waitForFunction(() => document.querySelector('#now-playing').hidden === false);
  for (const id of ['scan', 'open', 'load-classrooms', 'classroom-url', 'classroom-select', 'start'])
    assert.equal(await page.locator('#' + id).isDisabled(), true, id);
  await page.waitForTimeout(2200);
  assert.equal(await page.locator('#scan').isDisabled(), true);
  assert.equal(await page.locator('#home-continue').innerText(), '继续播放');
  await page.evaluate(() => window.__publish({ active: false, embedded: true, viewerOpen: false, revision: 6, version: '0.1.13' }));
  await page.waitForFunction(() => !document.querySelector('#scan').disabled);
}));

test('playback settings have one visible source and update preferences without opening or starting media', async () => mainPage(async page => {
  for (const label of ['自动静音', '官方倍速']) assert.equal(await page.getByLabel(label, { exact: true }).count(), 1);
  await page.getByLabel('自动静音', { exact: true }).check();
  await page.getByLabel('官方倍速', { exact: true }).check();
  assert.deepEqual(await page.evaluate(() => window.__calls), [{ options: { autoMute: true } }, { options: { speedEnabled: true } }]);
  assert.equal(await page.locator('#speed-value').isDisabled(), true, 'rates require the actual official controls');
  await page.locator('.heatmap-cell').first().click();
  assert.equal(await page.getByLabel('自动静音', { exact: true }).isDisabled(), true);
  assert.equal(await page.getByLabel('官方倍速', { exact: true }).isDisabled(), true);
  assert.equal(await page.locator('#speed-value').isDisabled(), true);
  assert.match(await page.locator('#options-state').innerText(), /暂停后可改设置/);
  await page.getByRole('button', { name: '暂停播放', exact: true }).click();
  await page.waitForFunction(() => !document.querySelector('#speed-value').disabled);
  await page.getByLabel('官方支持的播放速度', { exact: true }).selectOption('2');
  assert.equal(await page.locator('#speed-value').inputValue(), '2');
  assert.equal(await page.getByLabel('自动静音', { exact: true }).isChecked(), true);
  assert.deepEqual((await page.evaluate(() => window.__calls)).at(-1), { options: { speed: 2 } });
}));


test('pending playback settings keep the requested checkbox across status publications and adopt confirmed service values', async () => mainPage(async page => {
  await page.locator('.heatmap-cell').first().click();
  await page.getByRole('button', { name: '暂停播放', exact: true }).click();
  const mute = page.getByLabel('自动静音', { exact: true });
  await page.waitForFunction(() => !document.querySelector('#auto-mute').disabled);
  assert.equal(await mute.isChecked(), false);
  await page.evaluate(() => {
    window.__delayOptions = true;
    window.__confirmedOptions = { autoMute: true, speedEnabled: true, speed: 2 };
  });
  await mute.check();
  await page.waitForFunction(() => window.__releaseOptions);
  assert.equal(await mute.isChecked(), true, 'the clicked choice remains visible while saving');
  for (const id of ['auto-mute', 'speed-enabled', 'speed-value'])
    assert.equal(await page.locator('#' + id).isDisabled(), true, id);
  assert.deepEqual(await page.evaluate(() => window.__preferences), { autoMute: false, speedEnabled: false, speed: 1.5 });
  const reads = await page.evaluate(() => {
    const reads = window.__statusReads;
    window.__publish({ ...window.__state, revision: window.__state.revision + 1,
      playbackOptions: { autoMute: false, speedEnabled: false, speed: 1.5 } });
    return reads;
  });
  await page.waitForFunction(before => window.__statusReads > before, reads);
  assert.equal(await mute.isChecked(), true, 'an intervening confirmed-old status cannot replace the pending choice');
  assert.equal(await mute.isDisabled(), true);
  assert.equal(await page.getByLabel('官方倍速', { exact: true }).isChecked(), false, 'only the changed field is pending');
  await page.evaluate(() => { window.__delayOptions = false; window.__releaseOptions(); });
  await page.waitForFunction(() => !document.querySelector('#auto-mute').disabled);
  assert.equal(await mute.isChecked(), true);
  assert.equal(await page.getByLabel('官方倍速', { exact: true }).isChecked(), true, 'other fields follow service confirmation');
  assert.equal(await page.locator('#speed-value').inputValue(), '2');
  assert.deepEqual(await page.evaluate(() => window.__preferences), { autoMute: true, speedEnabled: true, speed: 2 });
  assert.deepEqual(await page.evaluate(() => window.__calls), ['start', 'pause', { options: { autoMute: true } }]);
  assert.equal(await page.locator('#home-continue').innerText(), '继续播放');
}));

test('a failed pending setting restores the last confirmed value and allows an explicit retry while remaining paused', async () => mainPage(async page => {
  await page.locator('.heatmap-cell').first().click();
  await page.getByRole('button', { name: '暂停播放', exact: true }).click();
  const mute = page.getByLabel('自动静音', { exact: true });
  await page.waitForFunction(() => !document.querySelector('#auto-mute').disabled);
  await page.evaluate(() => { window.__delayOptions = true; window.__optionsError = true; });
  await mute.check();
  await page.waitForFunction(() => window.__releaseOptions);
  assert.equal(await mute.isChecked(), true);
  assert.equal(await mute.isDisabled(), true);
  await page.evaluate(() => { window.__delayOptions = false; window.__releaseOptions(); });
  await page.waitForFunction(() => !document.querySelector('#auto-mute').disabled);
  assert.equal(await mute.isChecked(), false, 'a rejected save restores the confirmed preference');
  assert.match(await page.locator('#home-viewing-state').innerText(), /播放设置未能保存.*原设置保留/);
  assert.deepEqual(await page.evaluate(() => window.__preferences), { autoMute: false, speedEnabled: false, speed: 1.5 });
  await page.evaluate(() => { window.__delayOptions = true; window.__optionsError = false; window.__releaseOptions = null; });
  await mute.check();
  await page.waitForFunction(() => window.__releaseOptions);
  assert.equal(await mute.isChecked(), true);
  assert.equal(await mute.isDisabled(), true);
  await page.evaluate(() => { window.__delayOptions = false; window.__releaseOptions(); });
  await page.waitForFunction(() => !document.querySelector('#auto-mute').disabled);
  assert.equal(await mute.isChecked(), true);
  assert.deepEqual(await page.evaluate(() => window.__calls), ['start', 'pause', { options: { autoMute: true } }, { options: { autoMute: true } }]);
  assert.doesNotMatch(await page.locator('#home-viewing-state').innerText(), /播放设置未能保存/, 'successful retry clears the outdated settings failure');
  assert.equal(await page.locator('#home-continue').innerText(), '继续播放');
}));

test('playback connection loss preserves an active paused batch and recovery does not send a play action', async () => mainPage(async page => {
  await page.locator('.heatmap-cell').first().click();
  await page.getByRole('button', { name: '暂停播放', exact: true }).click();
  await page.evaluate(() => { window.__statusError = true; });
  await page.waitForFunction(() => document.querySelector('#home-viewing-state').textContent.includes('本机播放连接暂未恢复'));
  assert.equal(await page.locator('#home-continue').isDisabled(), true);
  assert.equal(await page.locator('#batch-select').isDisabled(), true);
  assert.equal(await page.locator('#current-title').innerText(), '模拟 A');
  assert.deepEqual(await page.evaluate(() => window.__calls), ['start', 'pause']);
  await page.evaluate(() => { window.__statusError = false; });
  await page.waitForFunction(() => !document.querySelector('#home-continue').disabled);
  assert.equal(await page.locator('#home-continue').innerText(), '继续播放');
  assert.doesNotMatch(await page.locator('#home-viewing-state').innerText(), /本机播放连接暂未恢复/);
  assert.deepEqual(await page.evaluate(() => window.__calls), ['start', 'pause']);
}));

test('platform verification pause retains current and next and does not turn observed position into completion', async () => mainPage(async page => {
  await page.locator('#batch-select').click();
  await page.locator('.heatmap-cell').first().click(); await page.locator('.heatmap-cell').last().click();
  await page.locator('#batch-start').click();
  await page.evaluate(() => window.__publish({ ...window.__state, revision: window.__state.revision + 1,
    stage: 'paused', media: { ...window.__state.media, paused: true, currentTime: 100 }, percent: 95, resumeSeconds: 100,
    queue: { ...window.__state.queue, active: false, phase: 'paused', reason: 'QUEUE_NOT_CONFIRMED',
      message: '官网尚未确认 100%，连播已暂停。' } }));
  await page.waitForFunction(() => document.querySelector('#playback-percent').textContent === '95%');
  assert.equal(await page.locator('#current-title').innerText(), '模拟 A');
  assert.equal(await page.locator('#next-title').innerText(), '模拟 B');
  assert.equal(await page.locator('#playback-current').innerText(), '1:40');
  assert.equal(await page.locator('#playback-resume').innerText(), '1:40');
  assert.match(await page.locator('#home-viewing-state').innerText(), /官网尚未确认 100%/);
  assert.equal(await page.locator('#playback-stop').isEnabled(), true);
  assert.equal(await page.locator('#scan').isDisabled(), true);
  assert.deepEqual(await page.evaluate(() => window.__calls), ['start']);
}));


test('a delayed pre-pause status cannot overwrite the accepted paused action when its session event is late', async () => mainPage(async page => {
  await page.locator('.heatmap-cell').first().click();
  await page.evaluate(() => { window.__delayStatus = true; window.__quietEvents = true; });
  await page.waitForFunction(() => window.__releaseStatus);
  await page.getByRole('button', { name: '暂停播放', exact: true }).click();
  assert.equal(await page.locator('#home-continue').innerText(), '继续播放');
  await page.evaluate(() => { window.__releaseStatus(); window.__delayStatus = false; });
  await page.waitForTimeout(80);
  assert.equal(await page.locator('#home-continue').innerText(), '继续播放');
  assert.equal(await page.locator('#playback-state').innerText(), '已暂停');
  assert.deepEqual(await page.evaluate(() => window.__calls), ['start', 'pause']);
}));


test('one idle cell click starts its single target and duplicate pending clicks cannot start another transaction',async()=>mainPage(async page=>{
  await page.evaluate(()=>{window.__delayStart=true;});
  await page.locator('.heatmap-cell').first().click();await page.waitForFunction(()=>window.__releaseStart);
  await page.locator('.heatmap-cell').first().evaluate(cell=>{cell.click();cell.click();});
  assert.deepEqual(await page.evaluate(()=>window.__starts),[{mode:'single',courseUrl,selections:[picks[0]],fromBeginning:false,resumeSaved:false,replaceCurrent:false}]);
  await page.evaluate(()=>{window.__delayStart=false;window.__releaseStart();});
  await page.waitForFunction(()=>document.querySelector('#current-title').textContent==='模拟 A');
  assert.equal(await page.locator('#home-continue').innerText(),'暂停播放');
  assert.equal(await page.locator('#selection-area').isVisible(),false);
  assert.deepEqual(await page.evaluate(()=>window.__calls),['start']);
}));

test('repeated current single-video clicks focus playing media and continue paused media without replacement or another start',async()=>{
  const inventory={...snapshot,items:snapshot.items.map((item,index)=>({...item,cardIdentity:`https://www.educoder.net/images/repeat-${index}.jpg`}))};
  const selected={courseUrl,page:1,index:0,title:'模拟 A',cardIdentity:inventory.items[0].cardIdentity};
  await mainPage(async page=>{
    const cell=page.locator('.heatmap-cell').first();await cell.click();
    await page.waitForFunction(()=>window.__state.active);
    await cell.click();await page.waitForFunction(()=>window.__calls.includes('official'));
    assert.equal(await page.locator('#replacement-confirm').isVisible(),false);
    assert.deepEqual(await page.evaluate(()=>window.__starts),[{mode:'single',courseUrl,selections:[selected],fromBeginning:false,resumeSaved:false,replaceCurrent:false}]);
    assert.equal(await page.locator('#playback-current').innerText(),'1:05');
    await page.locator('#home-continue').click();
    assert.equal(await page.locator('#home-continue').innerText(),'继续播放');
    await cell.click();await page.waitForFunction(()=>window.__state.media.paused===false);
    assert.equal(await page.locator('#replacement-confirm').isVisible(),false);
    assert.equal(await page.locator('#home-continue').innerText(),'暂停播放');
    assert.equal((await page.evaluate(()=>window.__starts)).length,1);
    assert.deepEqual(await page.evaluate(()=>window.__calls),['start','official','pause','continue']);
  },{inventory});
});

test('clicking the current video of a multi-video batch cannot silently truncate that batch',async()=>mainPage(async page=>{
  await page.locator('#batch-select').click();await page.locator('.heatmap-cell').first().click();await page.locator('.heatmap-cell').last().click();
  await page.locator('#batch-start').click();await page.locator('.heatmap-cell').first().click();
  assert.equal(await page.locator('#replacement-confirm').isVisible(),true);
  assert.match(await page.locator('#replacement-description').innerText(),/模拟 A.*余下 1 条/);
  assert.equal(await page.locator('#next-title').innerText(),'模拟 B');
  assert.deepEqual(await page.evaluate(()=>window.__calls),['start']);
  await page.locator('#replacement-cancel').click();
  assert.equal(await page.locator('#next-title').innerText(),'模拟 B');
  assert.equal(await page.evaluate(()=>window.__state.queue.total),2);
  assert.deepEqual(await page.evaluate(()=>window.__calls),['start']);
  await page.locator('.heatmap-cell').first().click();await page.locator('#replacement-start').click();
  assert.deepEqual((await page.evaluate(()=>window.__starts)).at(-1),{mode:'single',courseUrl,selections:[picks[0]],fromBeginning:false,resumeSaved:false,replaceCurrent:true});
  assert.equal(await page.locator('#next-title').innerText(),'本次没有下一条');
  assert.deepEqual(await page.evaluate(()=>window.__calls),['start','start']);
}));

test('matching coordinates with a different current card identity still require replacement confirmation',async()=>{
  const inventory={...snapshot,items:snapshot.items.map((item,index)=>({...item,cardIdentity:`https://www.educoder.net/images/identity-${index}.jpg`}))};
  await mainPage(async page=>{
    await page.locator('.heatmap-cell').first().click();
    await page.evaluate(()=>window.__publish({...window.__state,revision:window.__state.revision+1,
      selection:{...window.__state.selection,cardIdentity:'https://www.educoder.net/images/different-current-card.jpg'}}));
    await page.locator('.heatmap-cell').first().click();
    assert.equal(await page.locator('#replacement-confirm').isVisible(),true);
    assert.deepEqual(await page.evaluate(()=>window.__calls),['start']);
    assert.equal((await page.evaluate(()=>window.__starts)).length,1);
  },{inventory});
});

test('single-video replacement requires inline confirmation and cancellation preserves the current playback',async()=>mainPage(async page=>{
  await page.locator('.heatmap-cell').first().click();await page.locator('.heatmap-cell').last().click();
  assert.equal(await page.locator('#replacement-confirm').isVisible(),true);
  assert.match(await page.locator('#replacement-description').innerText(),/保存并结束.*模拟 A.*(?:播放|改播).*模拟 B/);
  assert.equal(await page.locator('#current-title').innerText(),'模拟 A');
  assert.deepEqual(await page.evaluate(()=>window.__calls),['start']);
  await page.locator('#replacement-cancel').click();
  assert.equal(await page.locator('#replacement-confirm').isVisible(),false);
  assert.deepEqual(await page.evaluate(()=>window.__calls),['start']);
  await page.locator('.heatmap-cell').last().click();await page.locator('#replacement-start').click();
  assert.deepEqual((await page.evaluate(()=>window.__starts)).at(-1),{mode:'single',courseUrl,selections:[picks[1]],fromBeginning:false,resumeSaved:false,replaceCurrent:true});
  assert.equal(await page.locator('#current-title').innerText(),'模拟 B');
  assert.equal(await page.locator('#replacement-confirm').isVisible(),false);
  assert.deepEqual(await page.evaluate(()=>window.__calls),['start','start']);
}));

test('active playback accepts a temporary new batch but only confirmation replaces the current plan',async()=>mainPage(async page=>{
  await page.locator('.heatmap-cell').first().click();await page.locator('#batch-select').click();
  assert.equal(await page.locator('#selection-area').isVisible(),true);
  await page.locator('.heatmap-cell').last().click();await page.locator('.heatmap-cell').first().click();
  await page.locator('#batch-start').click();
  assert.equal(await page.locator('#replacement-confirm').isVisible(),true);
  assert.equal(await page.locator('#current-title').innerText(),'模拟 A');
  assert.deepEqual(await page.evaluate(()=>window.__calls),['start']);
  await page.locator('#replacement-start').click();
  assert.deepEqual((await page.evaluate(()=>window.__starts)).at(-1),{mode:'continuous',courseUrl,selections:[picks[1],picks[0]],fromBeginning:false,resumeSaved:false,replaceCurrent:true});
  assert.equal(await page.locator('#current-title').innerText(),'模拟 B');
  assert.equal(await page.locator('#next-title').innerText(),'模拟 A');
  assert.equal(await page.locator('#selection-area').isVisible(),false);
}));

test('ending the current playback cancels pending replacement and never submits it later',async()=>mainPage(async page=>{
  await page.locator('.heatmap-cell').first().click();await page.locator('.heatmap-cell').last().click();
  assert.equal(await page.locator('#replacement-confirm').isVisible(),true);
  assert.equal(await page.locator('#playback-stop').innerText(),'结束本次');
  await page.locator('#playback-stop').click();
  await page.waitForFunction(()=>document.querySelector('#now-playing').hidden);
  assert.equal(await page.locator('#replacement-confirm').isVisible(),false);
  assert.equal(await page.locator('#selection-area').isVisible(),false);
  assert.deepEqual(await page.evaluate(()=>window.__calls),['start','finish']);
  await page.locator('.heatmap-cell').last().click();
  assert.deepEqual((await page.evaluate(()=>window.__starts)).at(-1),{mode:'single',courseUrl,selections:[picks[1]],fromBeginning:false,resumeSaved:false,replaceCurrent:false});
}));

test('an explicit active restart requires replacement confirmation and sends fromBeginning only after confirmation',async()=>mainPage(async page=>{
  await page.locator('.heatmap-cell').first().click();await page.locator('#playback-restart').click();
  assert.equal(await page.locator('#replacement-confirm').isVisible(),true);
  assert.deepEqual(await page.evaluate(()=>window.__calls),['start']);
  await page.locator('#replacement-cancel').click();
  assert.deepEqual(await page.evaluate(()=>window.__calls),['start']);
  await page.locator('#playback-restart').click();await page.locator('#replacement-start').click();
  assert.deepEqual((await page.evaluate(()=>window.__starts)).at(-1),{mode:'single',courseUrl,selections:[picks[0]],fromBeginning:true,resumeSaved:false,replaceCurrent:true});
  assert.equal(await page.locator('#playback-current').innerText(),'0:00');
}));

test('completed inactive playback and a completed closed event retain completion while the next cell click starts once',async()=>mainPage(async page=>{
  await page.locator('.heatmap-cell').first().click();
  await page.evaluate(()=>window.__publish({...window.__state,active:false,completed:true,stage:'completed',revision:window.__state.revision+1,
    media:{...window.__state.media,paused:true,ended:true,currentTime:100},percent:100,
    queue:{...window.__state.queue,active:false,phase:'completed',cursor:1,completed:1}}));
  await page.evaluate(()=>window.__notifyClosed({completed:true,discarded:false}));
  await page.waitForFunction(()=>!document.querySelector('.heatmap-cell').disabled);
  assert.equal(await page.locator('#home-continue').isVisible(),false);
  assert.deepEqual(await page.evaluate(()=>window.__calls),['start']);
  await page.locator('.heatmap-cell').last().click();
  assert.deepEqual((await page.evaluate(()=>window.__starts)).at(-1),{mode:'single',courseUrl,selections:[picks[1]],fromBeginning:false,resumeSaved:false,replaceCurrent:false});
  assert.equal(await page.locator('#replacement-confirm').isVisible(),false);
  assert.deepEqual(await page.evaluate(()=>window.__calls),['start','start']);
}));

test('ended media without official confirmation offers explicit progress verification rather than another start',async()=>mainPage(async page=>{
  await page.locator('.heatmap-cell').first().click();
  await page.evaluate(()=>window.__publish({...window.__state,stage:'ended',revision:window.__state.revision+1,
    media:{...window.__state.media,paused:true,ended:true,currentTime:100},percent:95,
    queue:{...window.__state.queue,active:false,phase:'paused',reason:'QUEUE_NOT_CONFIRMED',message:'官网尚未确认100%'}}));
  await page.waitForFunction(()=>document.querySelector('#home-continue').textContent==='重新核对进度');
  assert.equal(await page.locator('#playback-percent').innerText(),'95%');
  assert.equal(await page.locator('#playback-current').innerText(),'1:40');
  assert.deepEqual(await page.evaluate(()=>window.__calls),['start']);
  await page.locator('#home-continue').click();
  assert.deepEqual(await page.evaluate(()=>window.__calls),['start','continue']);
  assert.equal((await page.evaluate(()=>window.__starts)).length,1);
}));

test('completionPending retries saving and ending without replaying, starting again or losing completion on closed notification',async()=>mainPage(async page=>{
  await page.locator('.heatmap-cell').first().click();
  await page.evaluate(()=>window.__publish({...window.__state,stage:'ended',completed:false,completionPending:true,revision:window.__state.revision+1,
    media:{...window.__state.media,paused:true,ended:true,currentTime:100},percent:100,
    queue:{...window.__state.queue,active:false,phase:'paused',reason:'QUEUE_SAVE_FAILED'}}));
  await page.waitForFunction(()=>document.querySelector('#home-continue').textContent==='重试保存并结束');
  await page.locator('#home-continue').click();
  await page.waitForFunction(()=>document.querySelector('#now-playing').hidden);
  assert.deepEqual(await page.evaluate(()=>window.__calls),['start','continue']);
  assert.equal((await page.evaluate(()=>window.__starts)).length,1);
  assert.equal(await page.evaluate(()=>window.__state.completed),true);
  assert.equal(await page.evaluate(()=>window.__state.media.paused),true);
  assert.equal(await page.locator('#replacement-confirm').isVisible(),false);
  assert.equal(await page.locator('#completion-summary').isVisible(),true);
  assert.match(await page.locator('#completion-summary').innerText(),/官网确认100%/);
}));

test('history position-read failure requires explicit retry and cannot reinterpret a new cell click as resume',async()=>{
  const saved={mode:'continuous',courseUrl,total:2,cursor:1,active:false,phase:'paused',selections:picks};
  await mainPage(async page=>{
    await page.locator('#resume-last-play').waitFor();await page.evaluate(()=>{window.__positionError=true;});
    // Revalidation of unchanged history exercises the failed position read, not only summary failures.
    await page.evaluate(()=>window.studyHome.invalidate());
    await page.locator('#resume-last-retry').waitFor();
    assert.equal(await page.locator('#resume-last-play').isDisabled(),true);
    assert.deepEqual(await page.evaluate(()=>window.__saved),saved);
    assert.deepEqual(await page.evaluate(()=>window.__calls),[]);
    await page.evaluate(()=>{window.__positionError=false;});await page.locator('#resume-last-retry').click();
    await page.waitForFunction(()=>!document.querySelector('#resume-last-play').disabled);
    await page.locator('.heatmap-cell').first().click();
    assert.deepEqual(await page.evaluate(()=>window.__starts),[{mode:'single',courseUrl,selections:[picks[0]],fromBeginning:false,resumeSaved:false,replaceCurrent:false}]);
  },{saved});
});


test('cancelled active batch editing leaves current playback and its saved history untouched',async()=>{
  const saved={mode:'continuous',courseUrl,total:2,cursor:1,active:false,phase:'paused',selections:picks};
  await mainPage(async page=>{
    await page.locator('.heatmap-cell').first().click();await page.locator('#batch-select').click();await page.locator('.heatmap-cell').last().click();
    await page.locator('#selection-cancel').click();
    assert.equal(await page.locator('#selection-area').isVisible(),false);
    assert.equal(await page.locator('#replacement-confirm').isVisible(),false);
    assert.equal(await page.locator('#current-title').innerText(),'模拟 A');
    assert.deepEqual(await page.evaluate(()=>window.__saved),saved);
    assert.deepEqual(await page.evaluate(()=>window.__calls),['start']);
  },{saved});
});

test('a rejected replacement preserves the current playback and sends neither a separate finish nor a follow-up play',async()=>mainPage(async page=>{
  await page.locator('.heatmap-cell').first().click();await page.locator('.heatmap-cell').last().click();
  await page.evaluate(()=>{window.__startError='RECORD_CHANGED';});await page.locator('#replacement-start').click();
  await page.waitForFunction(()=>document.querySelector('#home-viewing-state').textContent.includes('记录'));
  assert.equal(await page.locator('#current-title').innerText(),'模拟 A');
  assert.deepEqual(await page.evaluate(()=>window.__calls),['start','start']);
  assert.equal(await page.evaluate(()=>window.__state.selection.index),0);
  assert.equal((await page.evaluate(()=>window.__starts)).at(-1).replaceCurrent,true);
}));

test('a late saved-position response cannot replace a newly clicked single video or trigger history resume',async()=>{
  const saved={mode:'continuous',courseUrl,total:2,cursor:0,active:false,phase:'paused',selections:picks};
  await mainPage(async page=>{
    await page.waitForFunction(()=>window.__releasePosition);
    assert.equal(await page.locator('#resume-last-play').isDisabled(),true);
    await page.locator('.heatmap-cell').last().click();
    await page.waitForFunction(()=>document.querySelector('#current-title').textContent==='模拟 B');
    await page.evaluate(()=>{window.__delayPosition=false;window.__releasePosition();});
    await page.waitForTimeout(80);
    assert.equal(await page.locator('#current-title').innerText(),'模拟 B');
    assert.deepEqual(await page.evaluate(()=>window.__starts),[{mode:'single',courseUrl,selections:[picks[1]],fromBeginning:false,resumeSaved:false,replaceCurrent:false}]);
    assert.equal(await page.locator('#selection-area').isVisible(),false);
    assert.deepEqual(await page.evaluate(()=>window.__calls),['start']);
  },{saved,positionDelay:true});
});

test('a confirmed completed batch does not recommend its stale recent position as unfinished history',async()=>{
  const saved={mode:'continuous',courseUrl,total:2,cursor:2,active:false,phase:'completed',selections:picks};
  const recent={seconds:100,selection:picks[1]};
  await mainPage(async page=>{
    await page.waitForFunction(()=>!document.querySelector('#resume-last-description').textContent.includes('正在读取'));
    assert.equal(await page.locator('#resume-last').isVisible(),false);
    assert.equal(await page.locator('#home-continue').isVisible(),false);
    assert.deepEqual(await page.evaluate(()=>window.__calls),[]);
    assert.deepEqual(await page.evaluate(()=>window.__saved),saved);
    await page.locator('.heatmap-cell').last().click();
    assert.deepEqual(await page.evaluate(()=>window.__starts),[{mode:'single',courseUrl,selections:[picks[1]],fromBeginning:false,resumeSaved:false,replaceCurrent:false}]);
  },{saved,recent});
});

const liveProgressInventory = { ...snapshot, items: snapshot.items.map((item, index) => ({ ...item, progress: 0,
  cardIdentity: `https://www.educoder.net/images/live-progress-${index}.jpg` })) };
const liveProgressPick = { ...picks[0], cardIdentity: liveProgressInventory.items[0].cardIdentity };

async function assertMapFeedback(page, confirmed) {
  const cell = page.locator('.heatmap-cell').first();
  assert.equal(await cell.getAttribute('data-progress'), confirmed ? '100' : '0');
  assert.equal(await cell.evaluate(node => node.classList.contains('is-complete')), confirmed);
  assert.equal(await cell.evaluate(node => node.style.backgroundColor), confirmed ? 'rgb(23, 60, 140)' : 'rgb(255, 255, 255)');
  assert.match(await cell.getAttribute('aria-label'), confirmed ? /完成度 100%.*已完成/ : /完成度 0%.*未开始/);
  await cell.hover(); await cell.focus();
  assert.match(await page.locator('#heatmap-tooltip-meta').innerText(), confirmed ? /100%.*已完成/ : /0%.*未开始/);
  assert.equal(await page.locator('.heatmap-row-count').innerText(), confirmed ? '1/2' : '0/2');
  assert.equal(await page.locator('#home-metrics strong').innerText(), confirmed ? '1 / 2' : '0 / 2');
  assert.equal(await page.locator('#inventory-completed').innerText(), confirmed ? '1' : '0');
  assert.equal(await page.locator('#inventory-pending').innerText(), confirmed ? '1' : '2');
  assert.equal(await page.locator('#inventory-rate').innerText(), confirmed ? '50%' : '0%');
  if (confirmed) {
    for (const text of [await cell.getAttribute('aria-label'), await page.locator('#heatmap-tooltip-meta').innerText(),
      await page.locator('#home-source').innerText()]) assert.match(text, /本次.*官方.*确认/);
  }
}

async function publishOfficialProgress(page, patch) {
  await page.evaluate(patch => window.__publish({ ...window.__state, ...patch, revision: window.__state.revision + 1 }), patch);
}

test('current-session official 100 updates map color, tooltip, aria and completion totals without rewriting scanned or local records', async () => mainPage(async page => {
  await page.locator('.heatmap-cell').first().click();
  await publishOfficialProgress(page, { percent: 100 });
  await page.waitForFunction(() => document.querySelector('.heatmap-cell').dataset.progress === '100');
  await assertMapFeedback(page, true);
  assert.equal(await page.locator('#playback-percent').innerText(), '100%');
  assert.equal(await page.locator('#playback-current').innerText(), '1:05');
  assert.equal(await page.locator('#playback-resume').innerText(), '1:05');
  assert.deepEqual(await page.evaluate(() => window.__recent), null);
  assert.deepEqual(await page.evaluate(async () => (await (await fetch('/api/inventory')).json()).items), liveProgressInventory.items);
  await publishOfficialProgress(page, { active: false, stage: 'completed', completed: true,
    media: { paused: true, ended: true, currentTime: 65, duration: 100 },
    queue: { mode: 'single', courseUrl, phase: 'completed', active: false, total: 1, cursor: 1, completed: 1, selections: [liveProgressPick] } });
  await page.locator('#completion-summary').waitFor();
  await assertMapFeedback(page, true);
  assert.deepEqual(await page.evaluate(() => window.__calls), ['start']);
}, { inventory: liveProgressInventory }));

test('official 99 and fully elapsed local seconds do not confirm scanned completion', async () => mainPage(async page => {
  await page.locator('.heatmap-cell').first().click();
  await publishOfficialProgress(page, { percent: 99, resumeSeconds: 100,
    media: { paused: true, ended: true, currentTime: 100, duration: 100 } });
  assert.equal(await page.locator('#playback-percent').innerText(), '99%');
  assert.equal(await page.locator('#playback-current').innerText(), '1:40');
  await assertMapFeedback(page, false);
  assert.deepEqual(await page.evaluate(() => window.__calls), ['start']);
}, { inventory: liveProgressInventory }));

test('official 100 for mismatched card identity or classroom cannot confirm the same scanned coordinates', async () => {
  for (const mismatch of [
    { ...liveProgressPick, cardIdentity: 'https://www.educoder.net/images/other-official-card.jpg' },
    { ...liveProgressPick, courseUrl: 'https://www.educoder.net/classrooms/OtherSynthetic/video' },
  ]) await mainPage(async page => {
    await page.locator('.heatmap-cell').first().click();
    await publishOfficialProgress(page, { percent: 100, selection: mismatch });
    await assertMapFeedback(page, false);
    assert.deepEqual(await page.evaluate(() => window.__calls), ['start']);
  }, { inventory: liveProgressInventory });
});

test('a new zero-progress scan clears current-session confirmation and later old completed revisions or preferences cannot restore it', async () => mainPage(async (page, fixture) => {
  await page.locator('.heatmap-cell').first().click();
  await publishOfficialProgress(page, { percent: 100, active: false, stage: 'completed', completed: true,
    media: { paused: true, ended: true, currentTime: 65, duration: 100 },
    queue: { mode: 'single', courseUrl, phase: 'completed', active: false, total: 1, cursor: 1, completed: 1, selections: [liveProgressPick] } });
  await page.waitForFunction(() => document.querySelector('.heatmap-cell').dataset.progress === '100');
  fixture.setInventory({ ...liveProgressInventory, scannedAt: '2026-10-02T00:05:00Z' });
  await page.waitForFunction(() => document.querySelector('.heatmap-cell').dataset.progress === '0');
  await assertMapFeedback(page, false);
  await publishOfficialProgress(page, {});
  await assertMapFeedback(page, false);
  await page.getByLabel('自动静音', { exact: true }).check();
  await assertMapFeedback(page, false);
  assert.deepEqual(await page.evaluate(() => window.__calls), ['start', { options: { autoMute: true } }]);
}, { inventory: liveProgressInventory }));

test('a cold completed official 100 summary without observed current-session activity never overrides a zero-progress scan', async () => {
  const initialState = { active: false, embedded: true, viewerOpen: false, revision: 5, version: '0.1.13',
    selection: liveProgressPick, percent: 100, stage: 'completed', completed: true,
    media: { paused: true, ended: true, currentTime: 100, duration: 100 },
    queue: { mode: 'single', courseUrl, phase: 'completed', active: false, total: 1, cursor: 1, completed: 1, selections: [liveProgressPick] } };
  await mainPage(async page => {
    await page.locator('#completion-summary').waitFor();
    await page.locator('#classroom-current').waitFor();
    assert.equal(await page.locator('#classroom-current').innerText(), liveProgressInventory.courseTitle);
    assert.equal(await page.locator('#classroom-current').getAttribute('aria-label'), '当前课堂');
    await assertMapFeedback(page, false);
    await publishOfficialProgress(page, { percent: 100 });
    await assertMapFeedback(page, false);
    assert.deepEqual(await page.evaluate(() => window.__calls), []);
  }, { inventory: liveProgressInventory, initialState });
});

test('a switching queue keeps the real current video, next video and ordinal while disabling continue but retaining End', async () => {
  const third = { page: 1, index: 2, title: '模拟 C', progress: 0 };
  const inventory = { ...snapshot, items: [...snapshot.items, third] };
  const selections = [...picks, { courseUrl, page: 1, index: 2, title: third.title }];
  await mainPage(async page => {
    await page.locator('#batch-select').click();
    for (const cell of await page.locator('.heatmap-cell').all()) await cell.click();
    await page.locator('#batch-start').click();
    await publishOfficialProgress(page, { selection: selections[0], nextSelection: selections[1],
      media: { paused: true, ended: true, currentTime: 100, duration: 100 },
      queue: { mode: 'continuous', courseUrl, phase: 'switching', active: true,
        total: 3, cursor: 1, currentIndex: 0, completed: 1, selections } });
    assert.equal(await page.locator('#current-title').innerText(), '模拟 A');
    assert.equal(await page.locator('#next-title').innerText(), '模拟 B');
    assert.equal(await page.locator('#current-label').innerText(), '当前 · 第 1 / 3 条');
    assert.equal(await page.locator('#home-continue').innerText(), '正在切换…');
    assert.equal(await page.locator('#home-continue').isDisabled(), true);
    assert.equal(await page.locator('#playback-stop').isEnabled(), true);
    assert.deepEqual(await page.evaluate(() => window.__calls), ['start']);
  }, { inventory });
});

test('a direct single-video restore failure exposes only an explicit from-beginning retry and preserves the old saved plan', async () => {
  const saved = { mode: 'continuous', courseUrl, total: 2, cursor: 1, active: false, phase: 'paused', selections: picks };
  const recent = { seconds: 45, selection: picks[1] };
  for (const code of ['RESTORE_REFUSED', 'INVALID_RESTORE_POSITION', 'OFFICIAL_PROGRESS_CONTROL_UNAVAILABLE', 'OFFICIAL_PROGRESS_CONTROL_AMBIGUOUS']) {
    await mainPage(async page => {
      await page.evaluate(({ code, selection }) => { window.__startError = code;
        window.__startFailure = { code, message: '本机位置恢复失败，请明确选择下一步', selection, operation: 'start' }; }, { code, selection: picks[0] });
      await page.locator('.heatmap-cell').first().click();
      const fromBeginning = page.getByRole('button', { name: '这条从头播放', exact: true });
      await fromBeginning.waitFor();
      assert.equal(await fromBeginning.isEnabled(), true);
      assert.equal(await page.locator('#start-retry').isVisible(), true);
      assert.deepEqual(await page.evaluate(() => window.__calls), ['start']);
      assert.deepEqual(await page.evaluate(() => window.__saved), saved);
      assert.deepEqual(await page.evaluate(() => window.__recent), recent);
      await page.evaluate(() => { window.__startError = null; window.__startFailure = null; });
      await fromBeginning.click();
      await page.waitForFunction(() => window.__state.active);
      assert.deepEqual((await page.evaluate(() => window.__starts)).at(-1), {
        mode: 'single', courseUrl, selections: [picks[0]], fromBeginning: true, resumeSaved: false, replaceCurrent: false });
      assert.equal(await page.locator('#playback-current').innerText(), '0:00');
      assert.deepEqual(await page.evaluate(() => window.__saved), saved);
      assert.deepEqual(await page.evaluate(() => window.__recent), recent);
      assert.deepEqual(await page.evaluate(() => window.__calls), ['start', 'start']);
    }, { saved, recent });
  }
});

test('an ordinary single-video start failure has no restore-specific from-beginning exit or automatic fallback', async () => mainPage(async page => {
  await page.evaluate(selection => { window.__startError = 'PLAY_REFUSED';
    window.__startFailure = { code: 'PLAY_REFUSED', message: '官网播放器未能开始播放', selection, operation: 'start' }; }, picks[0]);
  await page.locator('.heatmap-cell').first().click();
  await page.locator('#start-retry').waitFor();
  assert.equal(await page.getByRole('button', { name: '这条从头播放', exact: true }).isVisible(), false);
  assert.deepEqual(await page.evaluate(() => window.__calls), ['start']);
  assert.equal(await page.locator('#now-playing').isVisible(), false);
}));

test('a restore-specific from-beginning retry cannot start a card whose identity changed in a fresh scan', async () => mainPage(async (page, fixture) => {
  await page.evaluate(selection => { window.__startError = 'RESTORE_REFUSED';
    window.__startFailure = { code: 'RESTORE_REFUSED', message: '本机位置恢复失败', selection, operation: 'start' }; }, picks[0]);
  await page.locator('.heatmap-cell').first().click();
  const fromBeginning = page.getByRole('button', { name: '这条从头播放', exact: true });
  await fromBeginning.waitFor();
  fixture.setInventory({ ...snapshot, scannedAt: '2026-10-02T01:00:00Z',
    items: snapshot.items.map((item, index) => index ? item : { ...item, title: '已替换的模拟 A' }) });
  await page.waitForFunction(() => document.querySelector('.heatmap-cell').getAttribute('aria-label').includes('已替换的模拟 A'));
  assert.equal(await fromBeginning.isVisible(), false);
  assert.deepEqual(await page.evaluate(() => window.__calls), ['start']);
}));

test('switching classrooms hides the previous classroom completed summary even while its completed session remains published', async () => mainPage(async (page, fixture) => {
  await page.locator('.heatmap-cell').first().click();
  await publishOfficialProgress(page, { active: false, stage: 'completed', completed: true, percent: 100,
    queue: { mode: 'single', courseUrl, phase: 'completed', active: false, total: 1, cursor: 1, completed: 1, selections: [picks[0]] } });
  await page.locator('#completion-summary').waitFor();
  assert.match(await page.locator('#completion-summary').innerText(), /模拟 A/);
  const otherCourse = 'https://www.educoder.net/classrooms/OtherCompletionSynthetic/video';
  await page.getByText('手动填写课堂链接', { exact: true }).click();
  await page.locator('#classroom-url').fill(otherCourse);
  assert.equal(await page.locator('#completion-summary').isVisible(), false);
  fixture.setInventory({ ...snapshot, courseUrl: otherCourse, courseTitle: '另一模拟课堂' });
  await page.waitForFunction(() => document.querySelector('#inventory-title').textContent === '另一模拟课堂');
  await publishOfficialProgress(page, {});
  assert.equal(await page.locator('#completion-summary').isVisible(), false);
  assert.deepEqual(await page.evaluate(() => window.__calls), ['start']);
}));

test('legacy acceptance viewer: cold queue viewer exposes prepare before restore or start and completion hides invalid controls', async () => browserPage(async page => {
  await page.addInitScript(() => {
    window.__calls = []; window.__state = { target: '模拟 A', courseTitle: '模拟课堂', page: 1, index: 0, stage: 'not-open', media: null,
      resumeSeconds: 12, restoreAvailable: false, playAllowed: true, queue: { phase: 'ready', active: false, completed: 0, total: 2 } };
    window.singleVideo = { status: async () => window.__state,
      action: async action => { window.__calls.push(action); window.__state = { ...window.__state, stage: 'paused', restoreAvailable: true,
        media: { paused: true, currentTime: action === 'restore' ? 12 : 0, duration: 100, playbackRate: 1 } }; return window.__state; },
      queueAction: async action => { window.__calls.push(`queue:${action}`); window.__state = { ...window.__state, stage: action === 'start' ? 'playing' : 'paused',
        restoreAvailable: action !== 'start', media: { ...window.__state.media, paused: action !== 'start' },
        queue: { ...window.__state.queue, phase: action === 'start' ? 'playing' : 'paused', active: action === 'start' } }; return window.__state; } };
  });
  await page.goto(new URL('../src/local-single-video/ui/index.html', import.meta.url).href);
  const primary = page.locator('#view-primary');
  assert.equal(await primary.isVisible(), true); assert.match(await primary.innerText(), /准备/);
  assert.equal(await page.locator('#restore').isVisible(), false);
  await primary.click(); assert.match(await primary.innerText(), /开始.*连播/);
  await page.locator('#restore').click(); await primary.click(); assert.equal(await primary.innerText(), '暂停');
  await primary.click(); assert.match(await primary.innerText(), /继续.*连播/);
  assert.equal(await page.locator('button[data-queue-action]').count(), 0);
  assert.deepEqual(await page.evaluate(() => window.__calls), ['open', 'restore', 'queue:start', 'queue:pause']);
  await page.evaluate(() => { window.__state = { ...window.__state, stage: 'video-closed', media: null,
    queue: { ...window.__state.queue, phase: 'completed', completed: 2, active: false } }; });
  await page.waitForFunction(() => document.querySelector('#queue-view-state').textContent.includes('已完成'));
  assert.equal(await page.locator('button[data-action="official"]').isVisible(), false);
  assert.equal(await page.locator('button[data-action="refresh"]').isVisible(), false);
}));

test('legacy acceptance viewer: viewer applies shared theme events with no local editor and rejects a stale initial appearance read', async () => browserPage(async page => {
  await page.addInitScript(() => {
    window.studyAppearance = { get: () => new Promise(resolve => { window.__themeRead = resolve; }), onChanged: callback => { window.__themeChanged = callback; } };
    window.singleVideo = { status: async () => ({ target: '模拟 A', courseTitle: '模拟课堂', page: 1, index: 0, stage: 'not-open', media: null, resumeSeconds: 0 }) };
  });
  await page.goto(new URL('../src/local-single-video/ui/index.html', import.meta.url).href);
  assert.equal(await page.locator('#appearance-mode').count(), 0);
  await page.evaluate(() => { window.__themeChanged('dark'); window.__themeRead('light'); });
  assert.equal(await page.locator('html').getAttribute('data-theme'), 'dark');
}));

test('legacy acceptance viewer: viewer primary action follows ready and paused states and late status cannot overwrite an action result', async () => browserPage(async page => {
  await page.addInitScript(() => {
    window.__state = { target: '模拟 A', courseTitle: '模拟课堂', page: 1, index: 0, stage: 'not-open', media: null, resumeSeconds: 0, playAllowed: true };
    window.__calls = [];
    window.singleVideo = { status: async () => { if (window.__delayStatus) return new Promise(resolve => { window.__releaseStatus = resolve; }); return window.__state; },
      action: async value => { window.__calls.push(value); window.__state = { ...window.__state, stage: 'paused', media: { currentTime: 0, duration: 100, paused: true, playbackRate: 1 } }; return window.__state; },
      home: async () => {}, finish: async () => {} };
  });
  await page.goto(new URL('../src/local-single-video/ui/index.html', import.meta.url).href);
  const primary = page.locator('#view-primary');
  assert.equal(await primary.innerText(), '准备所选视频');
  await page.evaluate(() => { window.__delayStatus = true; });
  await page.waitForFunction(() => window.__releaseStatus);
  await primary.click(); assert.equal(await primary.innerText(), '播放');
  await page.evaluate(() => { window.__releaseStatus({ target: '模拟 A', courseTitle: '模拟课堂', page: 1, index: 0, stage: 'not-open', media: null, resumeSeconds: 0 }); window.__delayStatus = false; });
  assert.equal(await primary.innerText(), '播放');
  assert.deepEqual(await page.evaluate(() => window.__calls), ['open']);
  await page.locator('#view-tools > summary').click();
  assert.equal(await page.locator('button[data-action="close-video"]').innerText(), '关闭当前官方视频');
  assert.equal(await page.locator('#view-finish').isVisible(), true); assert.equal(await page.locator('#view-home').isVisible(), true);
}));

test('019 a waiting initial load exposes pause and stop without a stale failure notice', async () => mainPage(async page => {
  await page.evaluate(selection => window.__publish({ active:true,embedded:true,opening:false,closing:false,busy:false,
    revision:20,selection,actionsAvailable:true,restoreHint:'',failure:null,actionError:null,media:null,
    queue:{active:true,phase:'opening',retrying:true,waiting:true,reason:'',retryReason:'MEDIA_NOT_READY',message:'Waiting for official media',
      cursor:0,currentIndex:0,total:1,completed:0,selections:[selection]} }),picks[0]);
  await page.waitForFunction(()=>!document.querySelector('#home-continue').disabled);
  assert.equal(await page.locator('#playback-stop').isEnabled(),true);
  assert.equal(await page.locator('#home-viewing-state').evaluate(el=>el.classList.contains('is-error')),false);
  await page.locator('#home-continue').click();
  assert.deepEqual(await page.evaluate(()=>window.__calls),['pause']);
}));

test('019 waiting for official completion in switching state remains cancellable', async () => mainPage(async page => {
  await page.evaluate(selection=>window.__publish({active:true,embedded:true,opening:false,closing:false,busy:false,revision:20,
    selection,actionsAvailable:true,media:{paused:true,ended:true,currentTime:100,duration:100},
    queue:{active:true,phase:'switching',retrying:true,waiting:true,reason:'',cursor:0,total:2,completed:0,selections:[selection],message:'Waiting'} }),picks[0]);
  await page.waitForFunction(()=>!document.querySelector('#home-continue').disabled);
  await page.locator('#home-continue').click();
  assert.deepEqual(await page.evaluate(()=>window.__calls),['pause']);
}));

test('019 a safe restore fallback is visible while normal official playback continues', async () => mainPage(async page => {
  await page.evaluate(selection=>window.__publish({active:true,embedded:true,opening:false,closing:false,busy:false,revision:20,
    selection,actionsAvailable:true,restoreSkipped:true,restoreHint:'Official restore unavailable; playing actual current position; saved position retained',
    media:{paused:false,ended:false,currentTime:0.5,duration:100},queue:{active:true,phase:'playing',retrying:false,reason:'',cursor:0,total:1,completed:0,selections:[selection]} }),picks[0]);
  await page.waitForFunction(()=>document.querySelector('#home-viewing-state').textContent.includes('saved position retained'));
  assert.equal(await page.locator('#home-viewing-state').evaluate(el=>el.classList.contains('is-error')),false);
  assert.equal(await page.locator('#home-continue').isEnabled(),true);
}));

test('legacy acceptance viewer: viewer guidance follows explicit queue start, pause, reopening and completion without single-video contradictions', async () => browserPage(async page => {
  await page.addInitScript(() => {
    window.__calls = [];
    window.__state = { target: '模拟 A', courseTitle: '模拟课堂', page: 1, index: 0, stage: 'not-open', media: null, resumeSeconds: 0,
      queue: { phase: sessionStorage.getItem('synthetic-queue-reopen') ? 'paused' : 'ready', active: false, completed: 0, total: 3 } };
    window.singleVideo = { status: async () => window.__state, queueAction: async action => {
      window.__calls.push(action);
      window.__state = { ...window.__state, stage: action === 'start' ? 'playing' : 'paused',
        media: { paused: action !== 'start', currentTime: 0, duration: 100, playbackRate: 1, readyState: 4 },
        queue: { ...window.__state.queue, phase: action === 'start' ? 'playing' : 'paused', active: action === 'start' } };
      return window.__state;
    }, action: async action => { window.__calls.push(action);window.__state={...window.__state,stage:'paused',playAllowed:true,
      media:{paused:true,currentTime:0,duration:100,playbackRate:1,readyState:4}};return window.__state;} };
  });
  await page.goto(new URL('../src/local-single-video/ui/index.html', import.meta.url).href);
  const guidance = page.locator('.target .muted');
  assert.match(await guidance.innerText(), /由你启动|主动启动/);
  assert.deepEqual(await page.evaluate(() => window.__calls), []);
  assert.equal(await page.locator('#view-primary').isVisible(), true);
  await page.locator('#view-primary').click();await page.locator('#view-primary').click();
  assert.match(await guidance.innerText(), /真实结束.*官网.*100%.*切换/);
  assert.doesNotMatch(await guidance.innerText(), /只操作所选这一条|不自动播放或跳到下一条|由你启动/);
  assert.doesNotMatch(await page.locator('#message').innerText(), /保持暂停|由你.*播放/);
  await page.locator('#view-primary').click();
  assert.match(await guidance.innerText(), /由你.*继续/);
  await page.evaluate(() => sessionStorage.setItem('synthetic-queue-reopen', 'yes')); await page.reload();
  await page.waitForFunction(() => document.querySelector('#queue-view-state').textContent.includes('已暂停'));
  assert.deepEqual(await page.evaluate(() => window.__calls), []);
  assert.match(await guidance.innerText(), /重开不自动启动/);
  await page.evaluate(() => { window.__state = { ...window.__state, queue: { phase: 'completed', active: false, completed: 3, total: 3 } }; });
  await page.waitForFunction(() => document.querySelector('.target .muted').textContent.includes('已完成'));
  assert.equal(await page.locator('#view-primary').isVisible(), false);
  await page.evaluate(() => { delete window.__state.queue; });
  await page.waitForFunction(() => document.querySelector('.target .muted').textContent.includes('只操作所选这一条'));
  assert.match(await guidance.innerText(), /不自动播放或跳到下一条/);
}));
