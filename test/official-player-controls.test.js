import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chromium } from 'playwright-core';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { OfficialPlayerControls } from '../src/local-single-video/official-player-controls.mjs';
import { SingleController } from '../src/local-single-video/controller.mjs';
import { PositionStore } from '../src/local-single-video/position-store.mjs';

// Source-free paused synthetic media. Only fixture click handlers write media
// properties, simulating the official page; the production adapter never does.
const fixture = `<!doctype html><style>
video { width: 400px; height: 120px; background: #ddd; display: block; }
#video-controls { display: flex; gap: 16px; padding: 16px; }
[role=menu] { display: none; background: white; }
[role=menuitem] { display: block; padding: 8px; cursor: pointer; }
</style><video id="video"></video><div id="video-controls">
<button id="volume-button">开启/关闭声音</button><div><span id="speed-trigger">倍速</span>
<ul role="menu"><li role="menuitem">1.0x</li><li role="menuitem">1.5x</li><li role="menuitem">2.0x</li></ul></div></div>
<script>
const video = document.querySelector('video'), menu = document.querySelector('[role=menu]');
video.volume = .35; window.clicks = [];
video.addEventListener('mouseenter', () => menu.style.display = 'none');
document.querySelector('#speed-trigger').addEventListener('mouseenter', () => menu.style.display = 'block');
document.querySelector('#volume-button').addEventListener('click', () => { video.muted = !video.muted; clicks.push('mute'); });
for (const item of menu.children) item.addEventListener('click', () => { video.playbackRate = parseFloat(item.textContent); clicks.push(item.textContent); menu.style.display = 'none'; });
</script>`;

async function withPlayer(run) {
  const browser = await chromium.launch({ executablePath: process.env.CHROME_PATH || 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    headless: true, chromiumSandbox: true });
  try { const context = await browser.newContext(), page = await context.newPage(); await page.setContent(fixture); await run(page, new OfficialPlayerControls(page)); }
  finally { await browser.close(); }
}

async function realMediaFixture() {
  const bytes=await fs.readFile(new URL('./fixtures/synthetic-playback.webm',import.meta.url)),type='video/webm';
  return `<!doctype html><style>video{display:block;width:400px;height:160px;background:#ddd}#video-controls{height:32px}</style>
    <video id="video" preload="auto" muted loop src="data:${type};base64,${bytes.toString('base64')}"></video>
    <div id="video-controls"><button id="play-button" aria-label="播放">播放</button></div><script>(()=>{
    const video=document.querySelector('video'),button=document.querySelector('button');window.clicks=[];
    button.onclick=()=>{const action=video.paused?'play':'pause';clicks.push(action);console.log('fixture-click:'+action);if(video.paused)video.play();else video.pause();};
    video.onplay=()=>{button.textContent='暂停';button.setAttribute('aria-label','暂停');};
    video.onpause=()=>{button.textContent='播放';button.setAttribute('aria-label','播放');};
    })();</script>`;
}

test('015 empty official play ID works with a hidden named clone and remains paused after pause',async()=>withPlayer(async(page,controls)=>{
  await page.setContent(await realMediaFixture());await page.waitForFunction(()=>document.querySelector('video').readyState>=3);
  await page.evaluate(()=>{const video=document.querySelector('video'),button=document.querySelector('button');
    video.onplay=null;video.onpause=null;button.id='play';button.textContent='';button.removeAttribute('aria-label');
    const hidden=document.createElement('button');hidden.id='play-button';hidden.setAttribute('aria-label','播放');hidden.hidden=true;document.querySelector('#video-controls').append(hidden);});
  await controls.setPlaying(true);assert.equal(await page.locator('video').evaluate(v=>v.paused),false);
  await controls.setPlaying(false);const time=await page.locator('video').evaluate(v=>v.currentTime);
  await page.waitForTimeout(100);assert.equal(await page.locator('video').evaluate(v=>v.currentTime),time);
  assert.deepEqual(await page.evaluate(()=>clicks),['play','pause']);
}));

test('015 play control waits for readiness, refuses two usable buttons and disabled ancestry',async()=>withPlayer(async(page,controls)=>{
  const html=await realMediaFixture();
  await page.setContent(html);await page.waitForFunction(()=>document.querySelector('video').readyState>=3);
  await page.evaluate(()=>{const b=document.querySelector('button');b.id='play';b.textContent='';b.removeAttribute('aria-label');b.disabled=true;setTimeout(()=>b.disabled=false,100);});
  await controls.setPlaying(true);await controls.setPlaying(false);
  for(const mode of ['two','aria']){
    await page.setContent(html);await page.waitForFunction(()=>document.querySelector('video').readyState>=3);
    await page.evaluate(mode=>{const c=document.querySelector('#video-controls');if(mode==='two'){const b=document.createElement('button');b.id='play';c.append(b);}else c.setAttribute('aria-disabled','true');},mode);
    await assert.rejects(controls.setPlaying(true),/OFFICIAL_PLAY_UNAVAILABLE/);assert.deepEqual(await page.evaluate(()=>clicks),[]);
  }
}));

test('015 official progress range is bound by duration, ignores volume and confirms normal UI seek while paused',async()=>withPlayer(async(page,controls)=>{
  await page.setContent(await realMediaFixture());await page.waitForFunction(()=>document.querySelector('video').readyState>=3);
  const duration=await page.locator('video').evaluate(v=>v.duration);
  await page.evaluate(()=>{const c=document.querySelector('#video-controls'),v=document.querySelector('video');
    const volume=document.createElement('input');volume.type='range';volume.min='0';volume.max='1';volume.value='1';c.append(volume);
    const seek=document.createElement('input');seek.type='range';seek.min='0';seek.max=String(Math.floor(v.duration));seek.step='1';seek.value='0';seek.style.width='400px';seek.id='seek';
    seek.addEventListener('input',()=>v.currentTime=Number(seek.value));c.append(seek);});
  await controls.restorePosition(3,duration);
  assert.deepEqual(await page.locator('video').evaluate(v=>({time:v.currentTime,paused:v.paused})),{time:3,paused:true});
  await page.evaluate(()=>document.querySelector('#video-controls').append(document.querySelector('#seek').cloneNode(true)));
  await assert.rejects(controls.restorePosition(4,duration),/OFFICIAL_PROGRESS_CONTROL_AMBIGUOUS/);
  assert.equal(await page.locator('video').evaluate(v=>v.currentTime),3);
  await assert.rejects(controls.restorePosition(duration+1,duration),/INVALID_RESTORE_POSITION/);
}));

test('016 official full-track pointer handler restores low middle and high saved positions despite native thumb values',async()=>withPlayer(async(page,controls)=>{
  await page.setContent(await realMediaFixture());await page.waitForFunction(()=>document.querySelector('video').readyState>=3);
  const duration=await page.locator('video').evaluate(v=>v.duration);
  await page.evaluate(()=>{const c=document.querySelector('#video-controls'),v=document.querySelector('video'),seek=document.createElement('input');
    seek.type='range';seek.min='0';seek.max=String(Math.floor(v.duration));seek.step='1';seek.style.width='40px';
    seek.onclick=event=>{const box=seek.getBoundingClientRect();v.currentTime=Math.max(0,Math.min(v.duration,Math.floor((event.clientX-box.x)/box.width*v.duration)));};c.append(seek);});
  for(const fraction of [.1,.5,.75,.9]){
    const seconds=Math.floor(duration*fraction),result=await controls.restorePosition(seconds,duration);
    const actual=await page.locator('video').evaluate(v=>({time:v.currentTime,paused:v.paused}));
    assert.equal(actual.paused,true);assert.ok(actual.time>=seconds-1.01&&actual.time<=seconds+.05);assert.equal(result.restoredSeconds,actual.time);
  }
}));

test('official playback UI starts real decoded media, confirms time growth and pauses through the same visible button',async()=>withPlayer(async(page,controls)=>{
  await page.setContent(await realMediaFixture());await page.waitForFunction(()=>document.querySelector('video').readyState>=3);
  await controls.setPlaying(true);
  assert.equal(await page.locator('video').evaluate(video=>video.paused),false);
  assert.ok(await page.locator('video').evaluate(video=>video.currentTime)>0);
  const start=await page.locator('video').evaluate(video=>video.currentTime),wall=Date.now();
  await page.waitForTimeout(500);
  const halfway=await page.locator('video').evaluate(video=>({time:video.currentTime,paused:video.paused,ended:video.ended}));
  assert.equal(halfway.paused,false);assert.equal(halfway.ended,false);
  assert.ok(halfway.time-start>.25&&halfway.time-start<(Date.now()-wall)/1000+.75);
  await page.waitForTimeout(500);
  const second=await page.locator('video').evaluate(video=>({time:video.currentTime,paused:video.paused,ended:video.ended}));
  assert.equal(second.paused,false);assert.equal(second.ended,false);
  assert.ok(second.time-start>.7&&second.time-start<(Date.now()-wall)/1000+.75);
  await controls.setPlaying(false);const stopped=await page.locator('video').evaluate(video=>video.currentTime);
  await page.waitForTimeout(120);
  assert.equal(await page.locator('video').evaluate(video=>video.paused),true);
  assert.equal(await page.locator('video').evaluate(video=>video.currentTime),stopped);
  assert.deepEqual(await page.evaluate(()=>clicks),['play','pause']);
}));

test('official playback refuses absent disabled or ambiguous controls and a click that never starts media',async()=>withPlayer(async(page,controls)=>{
  const html=await realMediaFixture();
  for(const change of [()=>document.querySelector('button').remove(),()=>document.querySelector('button').disabled=true,
    ()=>document.querySelector('#video-controls').append(document.querySelector('button').cloneNode(true))]){
    await page.setContent(html);await page.waitForFunction(()=>document.querySelector('video').readyState>=3);await page.evaluate(change);
    await assert.rejects(controls.setPlaying(true),/OFFICIAL_PLAY_UNAVAILABLE/);
    assert.equal(await page.locator('video').evaluate(video=>video.paused),true);assert.deepEqual(await page.evaluate(()=>clicks),[]);
  }
  await page.setContent(html);await page.waitForFunction(()=>document.querySelector('video').readyState>=3);
  await page.evaluate(()=>{const button=document.querySelector('button');button.replaceWith(button.cloneNode(true));});
  await assert.rejects(controls.setPlaying(true),/PLAY_NOT_STARTED/);
  assert.equal(await page.locator('video').evaluate(video=>video.currentTime),0);
}));

test('official adapter clicks available sound and rate controls without starting or seeking media', async () => {
  await withPlayer(async (page, controls) => {
    assert.equal(await controls.muteAvailable(), true);
    assert.deepEqual(await controls.rates(), [1, 1.5, 2]);
    await controls.setMuted(true); await controls.setMuted(true); await controls.setMuted(false);
    await controls.setRate(1.5); await controls.setRate(2); await controls.setRate(1);
    assert.deepEqual(await page.evaluate(() => ({ clicks, muted: video.muted, volume: video.volume,
      rate: video.playbackRate, paused: video.paused, time: video.currentTime })), {
      clicks: ['mute', 'mute', '1.5x', '2.0x', '1.0x'], muted: false, volume: .35, rate: 1, paused: true, time: 0,
    });
  });
});

test('official adapter refuses absent, hidden, disabled, ambiguous and unsupported speed controls', async () => {
  await withPlayer(async (page, controls) => {
    for (const change of [
      () => document.querySelector('#speed-trigger').remove(),
      () => document.querySelector('#speed-trigger').style.display = 'none',
      () => document.querySelector('#speed-trigger').setAttribute('aria-disabled', 'true'),
      () => document.querySelectorAll('[role=menuitem]')[2].setAttribute('aria-disabled', 'true'),
      () => { const item = document.querySelectorAll('[role=menuitem]')[2]; item.parentNode.append(item.cloneNode(true)); },
      () => document.querySelector('#video-controls').append(document.createElement('video')),
    ]) {
      await page.setContent(fixture); await page.evaluate(change);
      await assert.rejects(controls.setRate(2));
      assert.deepEqual(await page.evaluate(() => clicks), []);
      assert.equal(await page.locator('video').first().evaluate(video => video.playbackRate), 1);
    }
    await page.setContent(fixture); await assert.rejects(controls.setRate(99), /OFFICIAL_SPEED_UNAVAILABLE/);
    await page.evaluate(() => document.querySelector('#volume-button').disabled = true);
    assert.equal(await controls.muteAvailable(), false); await assert.rejects(controls.setMuted(true), /OFFICIAL_MUTE_UNAVAILABLE/);
    assert.deepEqual(await page.evaluate(() => clicks), []);
  });
});

test('013 cancel during real official click actionability closes only the owned paused player without late playback',async()=>withPlayer(async(page,controls)=>{
  const directory=await fs.mkdtemp(path.join(os.tmpdir(),'educoder-cancel-click-')),target={classroomId:'SyntheticCancel',page:1,index:0,title:'合成取消播放'};
  const store=new PositionStore({directory:path.join(directory,'positions')}),context=page.context(),other=await context.newPage(),clicks=[];
  const single=new SingleController({dataDir:directory,appData:directory,target,positionStore:store,connectExistingBridge:false,sessionProvider:async()=>({context}),controlsFactory:()=>controls});
  await single.init();clearTimeout(single.timer);await single.ticking;
  try{
    await page.route('**/*',route=>route.abort());
    const officialUrl='https://www.educoder.net/video_info?video_id=syntheticcancel&course_id=SyntheticCancel';
    await page.route(officialUrl,async route=>route.fulfill({contentType:'text/html; charset=utf-8',body:(await realMediaFixture()).replace('</video>','</video><p>暂无检查点</p>')}));
    await page.goto(officialUrl);await page.waitForFunction(()=>document.querySelector('video').readyState>=3);
    page.on('console',message=>{if(message.text().startsWith('fixture-click:'))clicks.push(message.text().slice(14));});
    const box=await page.locator('#play-button').boundingBox();await page.evaluate(box=>{const overlay=document.createElement('div');overlay.id='click-blocker';Object.assign(overlay.style,{position:'fixed',left:box.x+'px',top:box.y+'px',width:box.width+'px',height:box.height+'px',zIndex:9999,background:'red'});document.body.append(overlay);},box);
    let entered;const clicking=new Promise(resolve=>entered=resolve),setPlaying=controls.setPlaying.bind(controls);
    controls.setPlaying=(playing,callbacks)=>setPlaying(playing,{...callbacks,onClickStarted:()=>{callbacks?.onClickStarted?.();entered();}});
    single.player=page;single.boundPlayerUrl=page.url();single.context=context;single.verifiedPlayer=true;
    single.ownedPlayer=page;
    single.ledger.value.duration=await page.locator('video').evaluate(video=>video.duration);single.ledger.value.position=5;single.ledger.value.watchedPrefix=5;await single.persist();
    const starting=single.act('play');await Promise.race([clicking,starting.then(state=>{throw new Error('play settled before click: '+state.actionError);})]);await page.waitForTimeout(100);assert.deepEqual(clicks,[]);
    single.requestStop();await single.pendingPlayClose?.catch(()=>{});await page.locator('#click-blocker').evaluate(node=>node.remove()).catch(()=>{});
    const stopped=await starting;await single.dispose();
    assert.equal(stopped.actionError,'QUEUE_STOPPED');assert.equal(clicks.includes('play'),false);assert.equal(single.touched,false);assert.equal(page.isClosed(),true);assert.equal(other.isClosed(),false);
    assert.equal((await store.load(target)).observation.position,5);assert.equal((await store.load(target)).observation.watchedPrefix,5);
  }finally{await single.dispose().catch(()=>{});await other.close().catch(()=>{});assert.equal(path.dirname(directory).toLowerCase(),os.tmpdir().toLowerCase());await fs.rm(directory,{recursive:true,force:true});}
}));

async function withObservedPlayer(page, controls, run) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'educoder-confirm-cancel-'));
  const target = { classroomId: 'SyntheticConfirm', page: 1, index: 0, title: '合成异步官方播放' };
  const store = new PositionStore({ directory: path.join(directory, 'positions') });
  const context = page.context(), other = await context.newPage();
  const single = new SingleController({ dataDir: directory, appData: directory, target, positionStore: store,
    connectExistingBridge: false, sessionProvider: async () => ({ context }), controlsFactory: () => controls });
  await single.init(); clearTimeout(single.timer); await single.ticking;
  try {
    await page.route('**/*', route => route.abort());
    const officialUrl='https://www.educoder.net/video_info?video_id=syntheticconfirm&course_id=SyntheticConfirm';
    await page.route(officialUrl,async route=>route.fulfill({contentType:'text/html; charset=utf-8',body:(await realMediaFixture()).replace('</video>', '</video><p>暂无检查点</p>')}));
    await page.goto(officialUrl);
    await page.waitForFunction(() => document.querySelector('video').readyState >= 3);
    single.player = page; single.ownedPlayer = page; single.boundPlayerUrl = page.url();
    single.context = context; single.verifiedPlayer = true;
    single.ledger.value.duration = await page.locator('video').evaluate(video => video.duration);
    single.ledger.value.position = 5; single.ledger.value.watchedPrefix = 5; await single.persist();
    await run({ single, store, target, other });
  } finally {
    await single.dispose().catch(() => {}); await other.close().catch(() => {});
    assert.equal(path.dirname(directory).toLowerCase(), os.tmpdir().toLowerCase());
    await fs.rm(directory, { recursive: true, force: true });
  }
}

for (const abortSignal of [false, true]) test('013 stop before real media confirmation cancels an asynchronous official play handler '+(abortSignal ? 'through queue abort' : 'through requestStop'), async () => withPlayer(async (page, controls) => {
  await withObservedPlayer(page, controls, async ({ single, store, target, other }) => {
    const playingEvents = [], setPlaying = controls.setPlaying.bind(controls);
    let clicked; const clickReturned = new Promise(resolve => { clicked = resolve; });
    page.on('console', message => { if (message.text() === 'fixture-media-playing') playingEvents.push(message.text()); });
    await page.evaluate(() => {
      const video = document.querySelector('video'), button = document.querySelector('#play-button');
      const readiness = new Promise(resolve => { window.releaseOfficialReadiness = resolve; });
      video.addEventListener('playing', () => console.log('fixture-media-playing'));
      // A real site may finish its click handler after a buffer/server check.
      // Only this synthetic site's handler invokes the native media API.
      button.onclick = async () => { if (video.paused) { await readiness; await video.play(); } else video.pause(); };
    });
    controls.setPlaying = (playing, callbacks) => setPlaying(playing, { ...callbacks,
      onClickFinished: () => { callbacks?.onClickFinished?.(); clicked(); } });
    const abort = new AbortController(); if (abortSignal) single.operationSignal = abort.signal;
    const starting = single.act('play');
    try {
      await Promise.race([clickReturned,starting.then(state=>{throw new Error('play settled before confirmation wait: '+state.actionError);})]);
      assert.deepEqual(await page.locator('video').evaluate(video => ({ paused: video.paused, time: video.currentTime })), { paused: true, time: 0 });
      if (abortSignal) abort.abort(); else single.requestStop();
      const closeWasStartedSynchronously = Boolean(single.pendingPlayClose);
      await single.pendingPlayClose?.catch(() => {});
      await page.evaluate(() => window.releaseOfficialReadiness()).catch(() => {});
      const canceled = await starting; await single.dispose();
      assert.equal(canceled.actionError, 'QUEUE_STOPPED');
      assert.deepEqual(playingEvents, []);
      assert.equal(closeWasStartedSynchronously, true); assert.equal(single.touched, false);
      assert.equal(page.isClosed(), true); assert.equal(other.isClosed(), false);
      const saved = await store.load(target);
      assert.equal(saved.observation.position, 5); assert.equal(saved.observation.watchedPrefix, 5);
    } finally {
      await page.evaluate(() => window.releaseOfficialReadiness()).catch(() => {}); await starting;
    }
  });
}));

test('013 stop after real media confirmation uses the normal official pause and saves the observed position', async () => withPlayer(async (page, controls) => {
  await withObservedPlayer(page, controls, async ({ single, store, target, other }) => {
    const clicks = [], setPlaying = controls.setPlaying.bind(controls);
    let confirmed, release; const mediaConfirmed = new Promise(resolve => { confirmed = resolve; });
    const returnGate = new Promise(resolve => { release = resolve; });
    page.on('console', message => { if (message.text().startsWith('fixture-click:')) clicks.push(message.text().slice(14)); });
    controls.setPlaying = async (playing, callbacks) => {
      await setPlaying(playing, callbacks);
      if (playing) { confirmed(); await returnGate; }
    };
    const starting = single.act('play');
    try {
      await Promise.race([mediaConfirmed,starting.then(state=>{throw new Error('play settled before real confirmation: '+state.actionError);})]);
      const media = await page.locator('video').evaluate(video => ({ paused: video.paused, ended: video.ended, time: video.currentTime, ready: video.readyState }));
      assert.equal(media.paused, false); assert.equal(media.ended, false); assert.ok(media.time > .01); assert.ok(media.ready >= 2);
      single.requestStop();
      assert.equal(page.isClosed(), false); assert.equal(single.pendingPlayClose, null);
      release(); const canceled = await starting; await single.dispose();
      assert.equal(canceled.actionError, 'QUEUE_STOPPED');
      assert.deepEqual(clicks, ['play', 'pause']); assert.equal(single.media.paused, true);
      assert.equal(page.isClosed(), true); assert.equal(other.isClosed(), false);
      const saved = await store.load(target);
      assert.equal(saved.observation.watchedPrefix, 5);
      assert.ok(saved.observation.position > .01 && saved.observation.position < 1);
      assert.equal(saved.observation.position, single.media.currentTime);
      assert.equal(single.touched, true);
    } finally { release(); await starting; }
  });
}));

test('016 endpoint restoration refuses before an unsafe pointer correction',async()=>withPlayer(async(page,controls)=>{
  await page.setContent(await realMediaFixture());await page.waitForFunction(()=>document.querySelector('video').readyState>=3);
  const duration=await page.locator('video').evaluate(v=>v.duration);
  await page.evaluate(duration=>{const seek=document.createElement('input');seek.type='range';seek.min='0';seek.max=String(duration);seek.step='1';seek.style.width='40px';seek.onclick=()=>window.seekClicked=true;document.querySelector('#video-controls').append(seek);},duration);
  for(const seconds of [.01,duration-.01]){
    await assert.rejects(controls.restorePosition(seconds,duration),/OFFICIAL_PROGRESS_CONTROL_UNAVAILABLE/);
    assert.equal(await page.evaluate(()=>window.seekClicked===true),false);
    assert.equal(await page.locator('video').evaluate(v=>v.currentTime),0);
  }
}));

test('019 progress readiness is re-read until the official duration-matching control becomes usable',async()=>withPlayer(async(page,controls)=>{
  await page.setContent(await realMediaFixture());await page.waitForFunction(()=>document.querySelector('video').readyState>=3);
  const duration=await page.locator('video').evaluate(v=>v.duration);
  await page.evaluate(duration=>{const seek=document.createElement('input');seek.id='seek';seek.type='range';seek.min='0';seek.max=String(duration+30);seek.step='1';seek.value='0';seek.style.width='400px';seek.disabled=true;
    seek.addEventListener('input',()=>document.querySelector('video').currentTime=Number(seek.value));document.querySelector('#video-controls').append(seek);
    setTimeout(()=>{seek.max=String(Math.floor(duration));seek.disabled=false;},150);},duration);
  await controls.restorePosition(3,duration);assert.equal(await page.locator('video').evaluate(v=>v.currentTime),3);
  await assert.rejects(controls.restorePosition(4,duration+3),/PLAYER_CHANGED/);
  await page.locator('#seek').evaluate(e=>e.remove());
  await assert.rejects(controls.restorePosition(4,duration),/OFFICIAL_PROGRESS_CONTROL_UNAVAILABLE/);
  assert.equal(await page.locator('video').evaluate(v=>v.currentTime),3);
}));

test('019 cancel while awaiting progress readiness prevents a later official restore click',async()=>withPlayer(async(page,controls)=>{
  await page.setContent(await realMediaFixture());await page.waitForFunction(()=>document.querySelector('video').readyState>=3);
  const duration=await page.locator('video').evaluate(v=>v.duration);
  await page.evaluate(duration=>{const seek=document.createElement('input');seek.type='range';seek.min='0';seek.max=String(Math.floor(duration));seek.step='1';seek.style.width='400px';seek.disabled=true;seek.onclick=()=>window.seekClicked=true;
    document.querySelector('#video-controls').append(seek);setTimeout(()=>seek.disabled=false,300);},duration);
  const stopAt=Date.now()+70;
  await assert.rejects(controls.restorePosition(3,duration,()=>{if(Date.now()>=stopAt)throw new Error('QUEUE_STOPPED');}),/QUEUE_STOPPED/);
  await page.waitForTimeout(350);assert.equal(await page.evaluate(()=>window.seekClicked===true),false);
  assert.equal(await page.locator('video').evaluate(v=>v.currentTime),0);
}));
