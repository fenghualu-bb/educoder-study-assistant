import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { SingleController } from '../src/local-single-video/controller.mjs';
import { PositionStore } from '../src/local-single-video/position-store.mjs';
import { freshLedger, ObservationLedger } from '../src/local-single-video/ledger.mjs';

const target = { classroomId: 'SyntheticController', title: '模拟控制器视频', page: 1, index: 0 };
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
const flush = () => new Promise(resolve => setImmediate(resolve));
const diskError = () => Object.assign(new Error('synthetic temporary disk failure'), { code: 'EIO' });
async function fixture(t, { sessionProvider, nativeProcessFactory } = {}) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'educoder-controller-test-'));
  const store = new PositionStore({ directory: path.join(directory, 'positions') });
  const controller = new SingleController({ dataDir: directory, appData: directory, target, positionStore: store,
    connectExistingBridge: false, nativeProcessFactory, sessionProvider: sessionProvider ?? (async () => { throw new Error('unexpected browser request'); }) });
  await controller.init(); clearTimeout(controller.timer);
  t.after(async () => { await controller.dispose().catch(() => {}); assert.equal(path.dirname(directory).toLowerCase(), os.tmpdir().toLowerCase()); await fs.rm(directory, { recursive: true, force: true }); });
  return { controller, store };
}
const observation = seconds => ({ ...freshLedger(target), duration: 100, watchedPrefix: seconds, position: seconds });

test('actual single-controller finish retries a transient position save after storage recovers', async t => {
  const { controller, store } = await fixture(t), save = store.save.bind(store); let attempts = 0, available = false;
  store.save = async (...args) => { attempts++; if (!available) throw diskError(); return save(...args); };
  controller.ledger.value = observation(5);
  await assert.rejects(controller.dispose(), error => error.code === 'EIO');
  assert.equal((await store.load(target)).observation.position, 0);
  available = true;
  await assert.doesNotReject(controller.dispose());
  assert.equal(attempts, 2);
  assert.equal((await store.load(target)).observation.position, 5);
});

test('a single-controller I/O retry preserves an externally updated record and keeps the conflict terminal', async t => {
  const { controller, store } = await fixture(t), save = store.save.bind(store); let attempts = 0;
  store.save = async (...args) => { if (++attempts === 1) throw diskError(); return save(...args); };
  controller.ledger.value = observation(5);
  await assert.rejects(controller.persist(), error => error.code === 'EIO');
  const external = new PositionStore({ directory: store.directory }), latest = await external.load(target);
  await external.save(latest, observation(9), null);
  const newer = await fs.readFile(store.file(target));
  await assert.rejects(controller.dispose(), /RECORD_CHANGED/);
  await assert.rejects(controller.dispose(), /RECORD_CHANGED/);
  assert.equal(attempts, 2);
  assert.deepEqual(await fs.readFile(store.file(target)), newer);
});

for (const disposeFirst of [false, true]) test(`a rejected card click closes its late owned popup ${disposeFirst ? 'after disposal' : 'without requiring disposal'}`, async t => {
  const popup = deferred(); let pageClosed = 0, popupClosed = 0, contextClosed = 0;
  const list = { closed: false, isClosed: () => list.closed, goto: async () => {},
    close: async () => { list.closed = true; pageClosed++; }, waitForEvent: () => popup.promise };
  const latePlayer = { closed: false, isClosed: () => latePlayer.closed, close: async () => { latePlayer.closed = true; popupClosed++; } };
  const unrelated = { closed: false }, context = { newPage: async () => list, pages: () => [list, unrelated], close: async () => { contextClosed++; } };
  const { controller } = await fixture(t, { sessionProvider: async () => ({ context }) });
  controller.selectCard = async () => ({ locator: () => ({ click: async () => { throw new Error('synthetic card click rejected'); } }) });
  try {
    await assert.rejects(controller.openVideo(), /card click rejected/);
    if (disposeFirst) await controller.dispose();
    popup.resolve(latePlayer); await flush();
    assert.equal(popupClosed, 1);
    assert.equal(contextClosed, 0);
    assert.equal(unrelated.closed, false);
    if (disposeFirst) assert.equal(pageClosed, 1);
  } finally { popup.resolve(latePlayer); }
});

test('disposing while a card click is pending closes a late popup without adopting or playing it', async t => {
  const clicking = deferred(), releaseClick = deferred(), popup = deferred(); let popupClosed = 0;
  const list = { closed: false, isClosed: () => list.closed, goto: async () => {}, close: async () => { list.closed = true; }, waitForEvent: () => popup.promise };
  const latePlayer = { closed: false, isClosed: () => latePlayer.closed, close: async () => { latePlayer.closed = true; popupClosed++; } };
  const context = { newPage: async () => list };
  const { controller } = await fixture(t, { sessionProvider: async () => ({ context }) });
  controller.selectCard = async () => ({ locator: () => ({ click: async () => { clicking.resolve(); await releaseClick.promise; } }) });
  const opening = controller.openVideo(), stopped = assert.rejects(opening, /QUEUE_STOPPED/);
  try {
    await clicking.promise; await controller.dispose();
    popup.resolve(latePlayer); releaseClick.resolve(); await stopped; await flush();
    assert.equal(popupClosed, 1);
    assert.equal(controller.player, null);
    assert.equal(list.closed, true);
  } finally { releaseClick.resolve(); popup.resolve(latePlayer); await stopped; }
});

test('actual controller never reports successful play when an official UI click leaves media paused', async t => {
  const { controller } = await fixture(t);
  const state = { currentTime: 0, duration: 100, paused: true, ended: false, playbackRate: 1, readyState: 4 };
  let coordinates = 0, semanticClicks = 0;
  controller.boundPlayerUrl = 'https://www.educoder.net/video_info?video_id=synthetic&course_id=SyntheticController';
  controller.player = { isClosed: () => false, url: () => controller.boundPlayerUrl,
    bringToFront: async () => {}, close: async () => {},
    locator: () => ({ evaluate: async () => ({ ...state }), innerText: async () => '暂无检查点', boundingBox: async () => ({ x: 0, y: 0, width: 400, height: 120 }) }),
    mouse: { move: async () => {}, click: async () => { coordinates++; } } };
  controller.verifiedPlayer = true; controller.ledger.value.duration = 100;
  controller.controlsFactory = () => ({ setPlaying: async () => { semanticClicks++; } });
  const result = await controller.act('play');
  assert.equal(result.actionError, 'PLAY_NOT_STARTED');
  assert.equal(result.stage, 'paused'); assert.equal(controller.touched, false);
  assert.equal(semanticClicks, 1); assert.equal(coordinates, 0);
});

test('actual single refuses a visible official verification prompt before clicking play', async t => {
  const { controller } = await fixture(t); let clicked = 0;
  const state = { currentTime: 0, duration: 100, paused: true, ended: false, playbackRate: 1, readyState: 4 };
  controller.boundPlayerUrl = 'https://www.educoder.net/video_info?video_id=synthetic&course_id=SyntheticController';
  controller.player = { isClosed: () => false, url: () => controller.boundPlayerUrl, bringToFront: async () => {}, close: async () => {},
    locator: () => ({ evaluate: async () => ({ ...state }), innerText: async () => '请完成身份核验 暂无检查点' }),
    mouse: { move: async () => {}, click: async () => { clicked++; } } };
  controller.verifiedPlayer = true; controller.ledger.value.duration = 100;
  controller.controlsFactory = () => ({ setPlaying: async () => { clicked++; state.paused = false; state.currentTime = .1; } });
  const result = await controller.act('play');
  assert.equal(result.actionError, 'VERIFICATION_REQUIRED'); assert.equal(clicked, 0); assert.equal(result.media.paused, true);
});

for (const moved of [false, true]) test(`actual single ${moved ? 'confirms a paused native restore near its target' : 'refuses native success when the one-second restore did not move media'}`, async t => {
  const { controller, store } = await fixture(t), calls = [];
  const state = { currentTime: 0, duration: 100, paused: true, ended: false, playbackRate: 1, readyState: 4 };
  controller.ledger = new ObservationLedger(observation(1.842));
  await controller.persist();
  controller.boundPlayerUrl = 'https://www.educoder.net/video_info?video_id=synthetic&course_id=SyntheticController';
  controller.player = { isClosed: () => false, url: () => controller.boundPlayerUrl, close: async () => {},
    locator: () => ({ evaluate: async () => ({ ...state }) }) };
  controller.verifiedPlayer = true;
  controller.native = async (action, pid, seconds, duration) => {
    calls.push({ action, seconds, duration });
    if (moved) state.currentTime = 1.03;
    return { success: true };
  };
  const result = await controller.act('restore');
  assert.deepEqual(calls, [{ action: 'restore', seconds: 1, duration: 100 }]);
  assert.equal(result.media.paused, true); assert.equal(result.stage, 'paused');
  if (moved) {
    assert.equal(result.actionError, null); assert.equal(controller.touched, true);
    assert.match(result.message, /已通过官方控件恢复/);
  } else {
    assert.equal(result.actionError, 'RESTORE_REFUSED'); assert.equal(controller.touched, false);
    assert.equal(result.media.currentTime, 0); assert.doesNotMatch(result.message, /已通过官方控件恢复/);
    assert.equal((await store.load(target)).observation.position, 1.842);
  }
});

for (const succeeds of [true, false]) test(`explicit beginning ${succeeds ? 'uses the native official zero position without clearing the observed record' : 'refuses play when the official beginning control fails'}`, async t => {
  const { controller, store } = await fixture(t), calls = [];
  const state = { currentTime: 5, duration: 100, paused: true, ended: false, playbackRate: 1, readyState: 4 };
  controller.ledger = new ObservationLedger(observation(5)); await controller.persist();
  controller.boundPlayerUrl = 'https://www.educoder.net/video_info?video_id=synthetic&course_id=SyntheticController';
  controller.player = { isClosed: () => false, url: () => controller.boundPlayerUrl, close: async () => {},
    locator: () => ({ evaluate: async () => ({ ...state }), innerText: async () => '暂无检查点' }) };
  controller.verifiedPlayer = true;
  controller.native = async (action, pid, seconds, duration) => {
    calls.push({ action, seconds, duration });
    if (!succeeds) throw new Error('RESTORE_REFUSED');
    state.currentTime = 0;
  };
  const result = await controller.act('beginning');
  assert.deepEqual(calls, [{ action: 'restore', seconds: 0, duration: 100 }]);
  assert.equal(result.media.paused, true); assert.equal(controller.touched, false);
  assert.equal((await store.load(target)).observation.position, 5);
  assert.equal(result.actionError, succeeds ? null : 'RESTORE_REFUSED');
  assert.equal(result.media.currentTime, succeeds ? 0 : 5);
});

for (const [diagnostic, expected] of [
  ['OFFICIAL_PROGRESS_CONTROL_AMBIGUOUS', 'OFFICIAL_PROGRESS_CONTROL_AMBIGUOUS'],
  ['PSSecurityException UnauthorizedAccess', 'NATIVE_SCRIPT_BLOCKED'],
  ['PRIVATE_SECRET_CODE', 'RESTORE_REFUSED'],
]) test('013 actual native restore preserves safe refusal '+expected+' and strips diagnostic paths', async t => {
  const { controller } = await fixture(t, { nativeProcessFactory: (_command, _args, options) => spawn(process.execPath,
    ['-e', 'console.error('+JSON.stringify('C:\\private\\token=secret-value '+diagnostic)+');process.exit(1);'], options) });
  controller.nativeScript = 'synthetic-unused.ps1';
  const state = { currentTime: 0, duration: 100, paused: true, ended: false, playbackRate: 1, readyState: 4 };
  controller.ledger = new ObservationLedger(observation(5)); await controller.persist();
  controller.boundPlayerUrl = 'https://www.educoder.net/video_info?video_id=synthetic&course_id=SyntheticController';
  controller.player = { isClosed: () => false, url: () => controller.boundPlayerUrl, close: async () => {}, locator: () => ({ evaluate: async () => ({ ...state }) }) };
  controller.verifiedPlayer = true;
  const refused = await controller.act('restore');
  assert.equal(refused.actionError, expected);
  assert.equal(/private|secret-value|PRIVATE_SECRET_CODE/.test(JSON.stringify(refused)), false);assert.equal(refused.media.currentTime, 0);assert.equal(refused.media.paused, true);assert.equal(controller.touched, false);
});

for (const abortSignal of [false, true]) test('013 cancel pending official focus prevents a late play '+(abortSignal?'through queue abort':'through requestStop'), async t => {
  const { controller, store } = await fixture(t), entered=deferred(), focus=deferred(), clicks=[];
  const media={currentTime:5,duration:100,paused:true,ended:false,playbackRate:1,readyState:4};
  controller.ledger=new ObservationLedger(observation(5));await controller.persist();
  controller.boundPlayerUrl='https://www.educoder.net/video_info?video_id=synthetic&course_id=SyntheticController';
  let closed=false;controller.player={isClosed:()=>closed,url:()=>controller.boundPlayerUrl,
    bringToFront:async()=>{entered.resolve();await focus.promise;},close:async()=>{closed=true;},
    locator:()=>({evaluate:async()=>({...media}),innerText:async()=>'暂无检查点'})};
  controller.verifiedPlayer=true;controller.controlsFactory=()=>({setPlaying:async playing=>{clicks.push(playing);media.paused=!playing;media.currentTime+=.1;}});
  controller.ownedPlayer=controller.player;
  const abort=new AbortController();if(abortSignal)controller.operationSignal=abort.signal;
  const starting=controller.act('play');
  try{await entered.promise;if(abortSignal)abort.abort();else controller.requestStop();focus.resolve();
    const result=await starting;assert.equal(result.actionError,'QUEUE_STOPPED');assert.deepEqual(clicks,[]);assert.equal(controller.touched,false);
    await controller.dispose();assert.equal((await store.load(target)).observation.position,5);assert.equal((await store.load(target)).observation.watchedPrefix,5);
  }finally{focus.resolve();await starting;}
});

for(const conflict of [false,true])test('013 canceled owned play retains unsaved observations and reports '+(conflict?'a newer record conflict':'a retriable save failure'),async t=>{
  const {controller,store}=await fixture(t),entered=deferred(),focus=deferred();let closed=false;
  controller.ledger=new ObservationLedger(observation(5));await controller.persist();controller.ledger=new ObservationLedger(observation(6));
  const media={currentTime:6,duration:100,paused:true,ended:false,playbackRate:1,readyState:4};
  controller.boundPlayerUrl='https://www.educoder.net/video_info?video_id=synthetic&course_id=SyntheticController';
  controller.player={isClosed:()=>closed,url:()=>controller.boundPlayerUrl,bringToFront:async()=>{entered.resolve();await focus.promise;},close:async()=>{closed=true;},locator:()=>({evaluate:async()=>({...media}),innerText:async()=>'暂无检查点'})};
  controller.ownedPlayer=controller.player;controller.verifiedPlayer=true;controller.controlsFactory=()=>({setPlaying:async()=>assert.fail('canceled play reached official controls')});
  const starting=controller.act('play');try{await entered.promise;controller.requestStop();focus.resolve();assert.equal((await starting).actionError,'QUEUE_STOPPED');assert.equal(closed,true);
    if(conflict){const latest=await store.load(target);await store.save(latest,observation(9),null);const newer=await fs.readFile(store.file(target));
      await assert.rejects(controller.dispose(),/RECORD_CHANGED/);await assert.rejects(controller.dispose(),/RECORD_CHANGED/);
      await controller.dispose({discardUnsavedPosition:true});assert.deepEqual(await fs.readFile(store.file(target)),newer);
    }else{const save=store.save.bind(store);let available=false;store.save=async(...args)=>{if(!available)throw diskError();return save(...args);};
      await assert.rejects(controller.dispose(),error=>error.code==='EIO');assert.equal(controller.ledger.value.position,6);assert.equal(controller.ledger.value.watchedPrefix,6);assert.equal((await store.load(target)).observation.position,5);
      available=true;await controller.dispose();assert.equal((await store.load(target)).observation.position,6);assert.equal((await store.load(target)).observation.watchedPrefix,6);
    }
  }finally{focus.resolve();await starting;}
});
