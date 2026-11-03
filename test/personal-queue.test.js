import test,{after} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {PersonalQueueStore,resolvePersonalQueue} from '../src/personal-queue-store.mjs';
import {PersonalQueueController} from '../src/personal-queue-controller.mjs';
import {chooseHomepageState} from '../public/personal-home.js';
import {PositionStore} from '../src/local-single-video/position-store.mjs';
import {freshLedger,ObservationLedger} from '../src/local-single-video/ledger.mjs';
import {SingleController} from '../src/local-single-video/controller.mjs';
const temporary=[];
after(async()=>{for(const dir of temporary){assert.equal(path.dirname(dir).toLowerCase(),os.tmpdir().toLowerCase());assert.match(path.basename(dir),/^educoder-personal-test-/);await fs.rm(dir,{recursive:true,force:true});}});
const courseUrl='https://www.educoder.net/classrooms/SyntheticPersonal/video';
const snapshot={courseUrl,courseTitle:'模拟个人课堂',complete:true,pagesScanned:1,items:[{page:1,index:0,title:'模拟视频 A',progress:0},{page:1,index:1,title:'模拟视频 B',progress:50}]};
const selections=snapshot.items.map(({page,index,title})=>({courseUrl,page,index,title}));
const delay=ms=>new Promise(resolve=>setTimeout(resolve,ms));
async function fixture(options={}){
  const dir=await fs.mkdtemp(path.join(os.tmpdir(),'educoder-personal-test-'));temporary.push(dir);
  const store=new PersonalQueueStore(path.join(dir,'queue.json')),plan=resolvePersonalQueue(snapshot,selections),record=await store.create(plan),log=[],singles=[];
  let openCount=0,maxOpen=0;
  async function createSingle(target){
    let opened=false,media=null,watched=0,percent=options.percent??100,closed=true;
    const single={busy:false,operationSignal:null,player:{isClosed:()=>closed,close:async()=>{if(opened){openCount--;opened=false;}media=null;closed=true;}},page:{close:async()=>{}},
      status(){return {target:target.title,stage:media?.ended?'ended':media?.paused?'paused':media?'playing':'not-open',media:media&&{...media},confirmedWatchedSeconds:watched,resumeSeconds:options.resume??0,playAllowed:true,actionError:null,busy:this.busy};},
      async act(action){log.push([target.index,action]);if(action==='open'){this.busy=true;await options.openWait;this.busy=false;if(this.operationSignal?.aborted)return this.status();opened=true;openCount++;maxOpen=Math.max(maxOpen,openCount);closed=false;media={paused:true,ended:false,currentTime:options.initialTime??0,duration:3,playbackRate:1};}
        if(action==='play'&&!options.noopPlay)media.paused=false;if(action==='pause'&&media)media.paused=true;
        if(action==='close-video'){if(opened){openCount--;opened=false;}media=null;closed=true;}
        return this.status();},
      async sample(){if(media&&!media.paused&&!media.ended){media.currentTime=Math.min(3,media.currentTime+1);watched=options.gap?0:media.currentTime;if(media.currentTime===3){media.ended=true;media.paused=true;}}},
      async inspectPersonalQueueSafety(){if(options.error)throw new Error(options.error);},
      async selectCard(){log.push([target.index,'verify']);if(options.verifyError)throw new Error(options.verifyError);this.percent=percent;},
      async persist(){},async dispose(){log.push([target.index,'dispose']);if(opened){openCount--;opened=false;}closed=true;media=null;},async changePlaybackOptions(){}
    };
    single.ownedPlayer=single.player;
    const raw=single.status;single.status=function(){return {...raw.call(this),percent:this.percent??0};};
    singles.push(single);return single;
  }
  const queue=new PersonalQueueController({store,record,targets:plan.targets,createSingle,pollMs:1,verifyMs:1,operationMs:1000,stallMs:100,...options.engine});
  await queue.init();return {dir,store,record,plan,queue,log,singles,get maxOpen(){return maxOpen;}};
}
async function settled(queue){await queue.job;return queue.status();}

for(const failure of ['OFFICIAL_PLAY_UNAVAILABLE','PAUSE_NOT_CONFIRMED','false-success'])test('015 pause confirms stopped media and preserves control failure '+failure,async()=>{
  const f=await fixture({engine:{pollMs:10000}});
  try{
    await f.queue.start();for(let i=0;i<100&&f.record.phase!=='playing';i++)await delay(2);
    assert.equal(f.record.phase,'playing');const child=f.queue.single,act=child.act.bind(child);let saves=0;
    child.sample=async()=>{};child.persist=async()=>{saves++;};
    child.act=async action=>action==='pause'?{...child.status(),actionError:failure==='false-success'?null:failure,
      media:failure==='false-success'?{...child.status().media,paused:true}:child.status().media}:act(action);
    const state=await f.queue.pause();await f.queue.job;
    assert.equal(state.queue.reason,failure==='false-success'?'PAUSE_NOT_CONFIRMED':failure);
    assert.equal(state.queue.phase,'paused');assert.equal(state.queue.cursor,0);assert.equal(child.player.isClosed(),true);assert.equal(child.status().media,null);
    assert.ok(saves>0);assert.equal(f.log.some(([index,action])=>index===1&&action==='open'),false);
    child.act=act;await f.queue.start();for(let i=0;i<100&&f.record.phase!=='playing';i++)await delay(2);
    assert.equal(f.record.phase,'playing');assert.equal(f.queue.stopError,null);await f.queue.pause(true);await f.queue.job;
  }finally{await f.queue.dispose();}
});

test('015 busy halt still closes list page after owned popup close failure and reports control cause',async()=>{
  const f=await fixture();let listClosed=0;
  try{const child=f.queue.single;await child.act('open');child.busy=true;
    child.player.close=async()=>{throw new Error('PAUSE_NOT_CONFIRMED');};child.page.close=async()=>{listClosed++;};
    const state=await f.queue.pause();assert.equal(listClosed,1);assert.equal(state.queue.reason,'PAUSE_NOT_CONFIRMED');assert.equal(state.queue.phase,'paused');
    assert.equal(child.player.isClosed(),false);assert.ok(f.queue.stopCloseError);
    child.busy=false;
  }finally{await f.queue.dispose();}
});

test('015 unknown media never silently retains an owned live popup',async()=>{
  const f=await fixture();
  try{const child=f.queue.single;await child.act('open');const status=child.status.bind(child);child.status=()=>({...status(),media:null});
    await f.queue.pause();assert.equal(child.player.isClosed(),true);}
  finally{await f.queue.dispose();}
});

test('015 paused cache is resampled before reporting successful pause',async()=>{
  const f=await fixture();
  try{const child=f.queue.single;await child.act('open');const sample=child.sample.bind(child);let first=true;
    child.sample=async()=>{if(first){first=false;await child.act('play');}else await sample();};
    const state=await f.queue.pause();assert.equal(state.queue.reason,'USER_PAUSED');assert.equal(child.status().media.paused,true);
    assert.ok(f.log.some(([,action])=>action==='pause'));
  }finally{await f.queue.dispose();}
});

test('015 a canceled completion save cannot replace the explicit stop reason with verifying',async()=>{
  const f=await fixture();let release,entered;const gated=new Promise(resolve=>release=resolve),saving=new Promise(resolve=>entered=resolve);let gatedOnce=false;
  try{f.queue.single.persist=async()=>{if(!gatedOnce){gatedOnce=true;entered();await gated;}};
    await f.queue.start();await saving;const stopped=await f.queue.pause(true);assert.equal(stopped.queue.reason,'QUEUE_STOPPED');
    release();await f.queue.job;assert.equal(f.record.reason,'QUEUE_STOPPED');assert.equal(f.record.phase,'stopped');
    const disk=JSON.parse(await fs.readFile(path.join(f.dir,'queue.json'),'utf8'));assert.equal(disk.reason,'QUEUE_STOPPED');assert.equal(disk.phase,'stopped');
  }finally{release();await f.queue.dispose();}
});

async function observedEndedSingle(f) {
  const child = new SingleController({ dataDir: f.dir, appData: f.dir, target: f.plan.targets[0],
    positionStore: new PositionStore({ directory: path.join(f.dir, 'ended-positions') }),
    connectExistingBridge: false, sessionProvider: async () => { throw new Error('unexpected browser request'); } });
  await child.init(); clearTimeout(child.timer); await child.ticking;
  await f.queue.single.dispose(); f.queue.single = child;
  const media = { currentTime: 3, duration: 3, paused: true, ended: true, playbackRate: 1, readyState: 4 };
  let playerClosed = 0, pageClosed = 0, queries = 0, safetyChecks = 0, percent = 99;
  child.boundPlayerUrl = 'https://www.educoder.net/video_info?video_id=synthetic-ended&course_id=SyntheticPersonal';
  child.player = { isClosed: () => playerClosed > 0, url: () => child.boundPlayerUrl,
    close: async () => { if (!playerClosed) playerClosed++; },
    locator: () => ({ evaluate: async () => ({ ...media }), innerText: async () => '暂无检查点' }) };
  child.ownedPlayer=child.player;
  child.page = { isClosed: () => pageClosed > 0, url: () => courseUrl, close: async () => { if (!pageClosed) pageClosed++; } };
  child.context = { pages: () => [child.page, child.player] };
  child.verifiedPlayer = true; child.touched = true; child.media = { ...media }; child.stage = 'ended';
  child.ledger = new ObservationLedger({ ...freshLedger(child.target), duration: 3, watchedPrefix: 3, position: 3 });
  child.selectCard = async () => { child.assertPlayer(); if (child.page.isClosed()) throw new Error('OPEN_FIRST'); queries++; child.percent = percent; };
  const inspect = child.inspectPersonalQueueSafety.bind(child), act = child.act.bind(child), actions = [];
  child.inspectPersonalQueueSafety = async () => { safetyChecks++; return inspect(); };
  child.act = async name => { actions.push(name); return act(name); };
  return { child, media, actions, confirm() { percent = 100; },
    get queries() { return queries; }, get safetyChecks() { return safetyChecks; },
    get playerClosed() { return playerClosed; }, get pageClosed() { return pageClosed; } };
}

test('personal queue stays cold until explicit start and advances exactly in selected order with one player',async()=>{
  const f=await fixture();try{assert.equal(f.queue.status().queue.active,false);assert.deepEqual(f.log,[]);await f.queue.start();const state=await settled(f.queue);
    assert.equal(state.queue.phase,'completed');assert.equal(state.queue.completed,2);assert.equal(f.maxOpen,1);
    assert.deepEqual(f.log.filter(([,action])=>action==='play').map(([index])=>index),[0,1]);
    const verifies=f.log.filter(([,action])=>action==='verify');assert.equal(verifies.length,2);
  }finally{await f.queue.dispose();}
});
test('queue discard still requires its own conflict or a strictly confirmed retained rollback conflict',async()=>{
  const f=await fixture(),before=await fs.readFile(f.store.file);
  try{for(const options of [{discardUnsavedPosition:true},{discardUnsavedPosition:true,preserveQueueRecord:true},
    {discardUnsavedPosition:true,discardForRollbackConflict:true},{discardUnsavedPosition:true,preserveQueueRecord:true,discardForRollbackConflict:'true'}])
      await assert.rejects(f.queue.dispose(options),/DISCARD_NOT_AVAILABLE/);
    assert.equal(f.queue.disposed,false);assert.deepEqual(await fs.readFile(f.store.file),before);
  }finally{await f.queue.dispose();}
});
test('ended media without official100 waits only configured attempts and never opens another video',async()=>{
  const f=await fixture({percent:99});try{await f.queue.start();const state=await settled(f.queue);assert.equal(state.queue.phase,'paused');assert.equal(state.queue.reason,'QUEUE_NOT_CONFIRMED');assert.equal(state.queue.cursor,0);
    assert.equal(f.log.filter(([,a])=>a==='verify').length,3);assert.equal(f.singles.length,1);
  }finally{await f.queue.dispose();}
});

test('an actual ended single remains paused after bounded non100 verification and manual confirmation continues without reopening or replaying it', async () => {
  const f = await fixture(), current = await observedEndedSingle(f);
  try {
    for (let attempt = 1; attempt <= 2; attempt++) {
      await f.queue.start(); const state = await settled(f.queue);
      assert.equal(state.queue.reason, 'QUEUE_NOT_CONFIRMED'); assert.equal(state.queue.cursor, 0);
      assert.equal(state.queue.phase, 'paused'); assert.equal(state.queue.active, false);
      assert.equal(state.media.ended, true); assert.equal(state.media.paused, true);
      assert.equal(current.queries, attempt * 3);
      assert.equal(current.playerClosed, 0); assert.equal(current.pageClosed, 0);
      assert.equal(f.queue.single, current.child); assert.deepEqual(current.actions, []);
      assert.equal((await f.store.read()).cursor, 0);
    }
    const checks = current.safetyChecks;
    current.confirm(); await f.queue.start(); const completed = await settled(f.queue);
    assert.equal(completed.queue.phase, 'completed'); assert.equal(completed.queue.cursor, 2);
    assert.ok(current.safetyChecks > checks); assert.equal(current.queries, 7);
    assert.deepEqual(current.actions, []);
    assert.deepEqual(f.log.filter(([, action]) => action === 'play').map(([index]) => index), [1]);
    assert.equal(current.playerClosed, 1);
    // Intermediate cleanup keeps the list tab alive for the next controller.
    // This fixture's next child is a stub and does not adopt the shared anchor.
    assert.equal(current.pageClosed, 0);
    assert.equal((await current.child.positionStore.load(current.child.target)).observation.position, 3);
  } finally { await f.queue.dispose(); }
});

for (const error of ['QUEUE_OPERATION_TIMEOUT', 'QUEUE_VERIFICATION', 'QUEUE_NOT_CONFIRMED'])
  test(`an actual ended single is still closed when official verification throws ${error} before completing its queries`, async () => {
    const f = await fixture(), current = await observedEndedSingle(f);
    current.child.selectCard = async () => { throw new Error(error); };
    try {
      await f.queue.start(); const state = await settled(f.queue);
      assert.equal(state.queue.reason, error); assert.equal(state.queue.cursor, 0);
      assert.equal(current.playerClosed, 1); assert.equal(current.pageClosed, 1);
      assert.deepEqual(current.actions, []);
    } finally { await f.queue.dispose(); }
  });

test('canceling an actual ended single during a pending official query still closes both owned pages and cannot advance', async () => {
  const f = await fixture(), current = await observedEndedSingle(f);
  let release, began; const wait = new Promise(resolve => { release = resolve; }), pending = new Promise(resolve => { began = resolve; });
  current.child.selectCard = async () => { began(); await wait; current.child.percent = 100; };
  try {
    await f.queue.start(); await pending;
    await f.queue.pause();
    assert.equal(current.playerClosed, 1); assert.equal(current.pageClosed, 1);
    release(); await settled(f.queue);
    assert.equal(f.queue.status().queue.cursor, 0); assert.equal(f.queue.status().queue.reason, 'USER_PAUSED');
    assert.deepEqual(current.actions, []);
  } finally { release(); await f.queue.dispose(); }
});

for (const changed of ['busy', 'ended', 'paused']) test(`completed non100 queries still close an unsafe actual single when ${changed} changes`, async () => {
  const f = await fixture(), current = await observedEndedSingle(f);
  const select = current.child.selectCard;
  current.child.selectCard = async () => {
    await select();
    if (current.queries === 3) {
      if (changed === 'busy') current.child.busy = true;
      else current.media[changed] = false;
    }
  };
  try {
    await f.queue.start(); const state = await settled(f.queue);
    assert.equal(state.queue.reason, 'QUEUE_NOT_CONFIRMED'); assert.equal(state.queue.cursor, 0);
    assert.equal(current.playerClosed, 1); assert.equal(current.pageClosed, 1);
  } finally { await f.queue.dispose(); }
});

test('a manual pause during the ended-state recheck keeps its reason and closes the pending verification pages', async () => {
  const f = await fixture(), current = await observedEndedSingle(f);
  let release, began; const wait = new Promise(resolve => { release = resolve; }), pending = new Promise(resolve => { began = resolve; });
  const sample = current.child.sample.bind(current.child);
  current.child.sample = async () => { began(); await wait; return sample(); };
  try {
    await f.queue.start(); await pending;
    await f.queue.pause();
    assert.equal(current.playerClosed, 1); assert.equal(current.pageClosed, 1);
    release(); await settled(f.queue);
    assert.equal(f.queue.status().queue.reason, 'USER_PAUSED'); assert.equal(f.queue.status().queue.cursor, 0);
    assert.equal((await f.store.read()).reason, 'USER_PAUSED');
  } finally { release(); await f.queue.dispose(); }
});

test('retaining the ended single after non100 queries never overwrites a newer external queue record', async () => {
  const f = await fixture(), current = await observedEndedSingle(f);
  const select = current.child.selectCard; let newer;
  current.child.selectCard = async () => {
    await select();
    if (current.queries === 3) {
      const record = await f.store.read(); record.revision++; record.reason = 'synthetic-external-update';
      newer = Buffer.from(JSON.stringify(record)); await fs.writeFile(f.store.file, newer);
    }
  };
  try {
    await f.queue.start(); const state = await settled(f.queue);
    assert.equal(state.queue.reason, 'QUEUE_RECORD_CHANGED'); assert.equal(state.queue.cursor, 0);
    assert.deepEqual(await fs.readFile(f.store.file), newer); assert.deepEqual(current.actions, []);
    assert.equal(current.playerClosed, 0); assert.equal(current.pageClosed, 0);
  } finally { await f.queue.dispose().catch(() => {}); }
});
test('unconfirmed official play remains retryable without advancing or opening another video',async()=>{
  const f=await fixture({noopPlay:true,engine:{retryBaseMs:1,retryMaxMs:2}});
  try{await f.queue.start();for(let i=0;i<100&&f.log.filter(([,a])=>a==='play').length<2;i++)await delay(2);
    const state=f.queue.status();assert.equal(state.queue.active,true);assert.equal(state.queue.retrying,true);
    assert.equal(state.queue.cursor,0);assert.equal(f.singles.length,1);assert.equal(state.media.currentTime,0);
    await f.queue.pause();await f.queue.job;assert.equal(f.queue.status().queue.reason,'USER_PAUSED');
  }finally{await f.queue.dispose();}
});

test('cold saved classroom and canonical classroom aliases have an actionable homepage next step',()=>{
  const cold=chooseHomepageState({snapshot:null,currentUrl:courseUrl,phase:'idle',officialSessionOpen:false});
  assert.equal(cold.title,'这门课堂还没有扫描');assert.match(cold.subtitle,/刷新官方进度/);
  assert.equal(chooseHomepageState({phase:'idle',officialSessionOpen:false}).title,'先连接你的课堂');
  const ready=chooseHomepageState({snapshot:null,currentUrl:courseUrl,phase:'ready',officialSessionOpen:true});
  assert.equal(ready.title,'这门课堂还没有扫描');assert.match(ready.subtitle,/刷新官方进度/);
  const alias=courseUrl.replace('/video','/announcement?source=synthetic'),pick=selections[1];
  const scanned=chooseHomepageState({snapshot,currentUrl:alias,manualSelection:pick,phase:'ready',officialSessionOpen:true});
  assert.equal(scanned.title,'点击方格播放视频');assert.match(scanned.subtitle,/连续播放/);
});
test('an ended jump with an unwatched gap cannot advance even if the website would report100',async()=>{
  const f=await fixture({gap:true});try{await f.queue.start();const state=await settled(f.queue);assert.equal(state.queue.reason,'QUEUE_UNWATCHED_GAP');assert.equal(f.singles.length,1);assert.equal(f.log.filter(([,a])=>a==='verify').length,0);
  }finally{await f.queue.dispose();}
});
test('official resumed position ahead of observed prefix is refused rather than seeking or skipping',async()=>{
  const f=await fixture({initialTime:2});try{await f.queue.start();assert.equal((await settled(f.queue)).queue.reason,'QUEUE_UNWATCHED_GAP');assert.equal(f.log.filter(([,a])=>a==='play').length,0);
  }finally{await f.queue.dispose();}
});
test('explicit single mode plays an observed noncontiguous range while continuous mode still refuses the same gap',async()=>{
  for(const mode of ['single','continuous']){
    const f=await fixture({initialTime:50,engine:{pollMs:1000}});
    f.record.mode=mode;if(mode==='single'){f.record.selections=[selections[0]];f.queue.targets=[f.plan.targets[0]];}
    const child=f.queue.single,original=child.status;
    child.status=()=>({...original.call(child),confirmedWatchedPrefix:0,confirmedWatchedSeconds:0,resumeSeconds:51});
    try{
      await f.queue.start();await delay(20);
      const plays=f.log.filter(([,action])=>action==='play');
      assert.equal(plays.length,mode==='single'?1:0);
      if(mode==='single')assert.equal(f.queue.status().queue.phase,'playing');
      else assert.equal((await settled(f.queue)).queue.reason,'QUEUE_UNWATCHED_GAP');
    }finally{await f.queue.dispose();}
  }
});
test('single mode never credits an ended noncontiguous range as completion even when official progress is100',async()=>{
  const f=await fixture({gap:true});f.record.mode='single';f.record.selections=[selections[0]];f.queue.targets=[f.plan.targets[0]];
  try{await f.queue.start();const state=await settled(f.queue);assert.equal(state.queue.reason,'QUEUE_UNWATCHED_GAP');
    assert.equal(state.queue.completed,0);assert.equal(state.queue.cursor,0);assert.equal(f.log.filter(([,a])=>a==='verify').length,0);
  }finally{await f.queue.dispose();}
});
for(const error of ['QUEUE_VERIFICATION','QUEUE_CHECKPOINT','QUEUE_LOGIN_REQUIRED','QUEUE_PLATFORM_BLOCKED','QUEUE_OTHER_PLAYER'])test(`${error} pauses before a play click and leaves the cursor unchanged`,async()=>{
  const f=await fixture({error});try{await f.queue.start();const state=await settled(f.queue);assert.equal(state.queue.reason,error);assert.equal(state.queue.cursor,0);assert.equal(f.log.filter(([,a])=>a==='play').length,0);
  }finally{await f.queue.dispose();}
});
test('cancellation while a video is opening cannot produce a late play click or a next player',async()=>{
  let release;const wait=new Promise(resolve=>{release=resolve;});const f=await fixture({openWait:wait});
  try{await f.queue.start();await delay(2);await f.queue.pause(true);release();await settled(f.queue);assert.equal(f.queue.status().queue.active,false);assert.equal(f.log.filter(([,a])=>a==='play').length,0);assert.equal(f.singles.length,1);
  }finally{release();await f.queue.dispose();}
});
test('stop during playing saves state and blocks next; a reopened queue never autoplays or auto-restores',async()=>{
  const f=await fixture({engine:{pollMs:50}});
  try{await f.queue.start();await delay(3);await f.queue.pause(true);await settled(f.queue);assert.equal(f.queue.status().queue.phase,'stopped');assert.equal(f.queue.status().queue.cursor,0);
    const saved=await f.store.read(),calls=[];const reopened=new PersonalQueueController({store:f.store,record:saved,targets:f.plan.targets,createSingle:async()=>({status:()=>({media:null,resumeSeconds:15}),dispose:async()=>{},act:async a=>calls.push(a),persist:async()=>{}})});
    await reopened.init();assert.equal(reopened.status().queue.active,false);assert.equal(reopened.status().queue.phase,'paused');assert.deepEqual(calls,[]);await reopened.dispose();
  }finally{await f.queue.dispose();}
});
test('missing service/website progress interrupts verification and does not open the next player',async()=>{
  const f=await fixture({verifyError:'LOGIN_REQUIRED'});try{await f.queue.start();assert.equal((await settled(f.queue)).queue.reason,'LOGIN_REQUIRED');assert.equal(f.singles.length,1);assert.equal(f.queue.status().queue.cursor,0);
  }finally{await f.queue.dispose();}
});
test('saved queue rejects external revisions, foreign classrooms, duplicate and changed scan selections',async()=>{
  const f=await fixture();try{await assert.rejects(f.store.create(f.plan),/QUEUE_REPLACE_REQUIRED/);
    assert.throws(()=>resolvePersonalQueue(snapshot,[selections[0],selections[0]]),/QUEUE_DUPLICATE/);
    assert.throws(()=>resolvePersonalQueue({...snapshot,complete:false},selections),/QUEUE_SCAN_REQUIRED/);
    assert.throws(()=>resolvePersonalQueue(snapshot,[{...selections[0],courseUrl:courseUrl.replace('SyntheticPersonal','Foreign')}]),/SCAN_CHANGED/);
    assert.throws(()=>resolvePersonalQueue(snapshot,[{...selections[0],title:'错误视频'}]),/SCAN_CHANGED/);
    const external=await f.store.read();external.revision++;external.reason='external-edit';await fs.writeFile(f.store.file,JSON.stringify(external));
    await assert.rejects(f.store.save(f.record),/QUEUE_RECORD_CHANGED/);assert.equal((await f.store.read()).reason,'external-edit');
  }finally{await f.queue.dispose();}
});

test('a staged new batch leaves the saved plan byte-identical until play commit and guarded rollback restores it', async () => {
  const f = await fixture();
  try {
    const before = await fs.readFile(f.store.file), previous = await f.store.read();
    const staged = await f.store.stage({ ...resolvePersonalQueue(snapshot, [selections[1]]), mode: 'single' });
    staged.record.phase = 'opening'; await staged.store.save(staged.record);
    staged.record.phase = 'paused'; await staged.store.save(staged.record);
    assert.deepEqual(await fs.readFile(f.store.file), before);
    staged.record.phase = 'playing'; await staged.commit();
    const committed = await f.store.read();
    assert.notEqual(committed.id, previous.id); assert.equal(committed.mode, 'single');
    assert.deepEqual(committed.selections, [selections[1]]);
    await staged.rollback(); assert.deepEqual(await fs.readFile(f.store.file), before);
  } finally { await f.queue.dispose(); }
});

test('canceling a staged start or committing over a changed saved batch never replaces its disk bytes', async () => {
  const f = await fixture();
  try {
    const before = await fs.readFile(f.store.file), staged = await f.store.stage({ ...f.plan, mode: 'continuous' });
    staged.record.phase = 'playing'; const abort = new AbortController(); abort.abort();
    await assert.rejects(staged.commit({ signal: abort.signal }), /QUEUE_STOPPED/);
    assert.deepEqual(await fs.readFile(f.store.file), before);
    const latest = await f.store.read(); latest.revision++; latest.reason = 'synthetic-external-edit';
    const external = Buffer.from(JSON.stringify(latest)); await fs.writeFile(f.store.file, external);
    await assert.rejects(staged.commit(), /QUEUE_RECORD_CHANGED/);
    await staged.rollback(); assert.deepEqual(await fs.readFile(f.store.file), external);
  } finally { await f.queue.dispose(); }
});

test('a staged rollback cannot replace an externally newer committed batch', async () => {
  const f = await fixture();
  try {
    const staged = await f.store.stage({ ...f.plan, mode: 'continuous' }); staged.record.phase = 'playing'; await staged.commit();
    const latest = await f.store.read(); latest.revision++; latest.reason = 'synthetic-newer-committed-edit';
    const external = Buffer.from(JSON.stringify(latest)); await fs.writeFile(f.store.file, external);
    await assert.rejects(staged.rollback(), /QUEUE_RECORD_CHANGED/);
    assert.deepEqual(await fs.readFile(f.store.file), external);
  } finally { await f.queue.dispose(); }
});

test('staging a saved continuation preserves its id and cursor and refuses a different selected plan', async () => {
  const f = await fixture();
  try {
    f.record.cursor = 1; f.record.phase = 'paused'; await f.store.save(f.record);
    const before = await fs.readFile(f.store.file), previous = await f.store.read();
    await assert.rejects(f.store.stage({ ...resolvePersonalQueue(snapshot, [selections[1]]), mode: 'single' }, { resume: true }), /QUEUE_RECORD_CHANGED/);
    const staged = await f.store.stage({ ...f.plan, mode: 'continuous' }, { resume: true });
    assert.equal(staged.record.id, previous.id); assert.equal(staged.record.cursor, 1);
    staged.record.phase = 'opening'; await staged.store.save(staged.record);
    assert.deepEqual(await fs.readFile(f.store.file), before);
    staged.record.phase = 'playing'; await staged.commit();
    const saved = await f.store.read(); assert.equal(saved.id, previous.id); assert.equal(saved.cursor, 1);
    assert.equal(saved.revision, previous.revision + 1);
  } finally { await f.queue.dispose(); }
});
test('a slow staged commit cannot roll back the controller cursor or lose a queued phase update',async()=>{
  const f=await fixture();let release,began;const gate=new Promise(resolve=>{release=resolve;}),entered=new Promise(resolve=>{began=resolve;});
  try{
    const before=await fs.readFile(f.store.file),staged=await f.store.stage({...f.plan,mode:'continuous'}),snapshotRead=f.store.snapshot.bind(f.store);let first=true;
    f.store.snapshot=async()=>{if(first){first=false;began();await gate;}return snapshotRead();};
    staged.record.phase='playing';const commit=staged.commit();await entered;
    staged.record.cursor=1;staged.record.phase='switching';const updating=staged.store.save(staged.record);
    release();await Promise.all([commit,updating]);const saved=await f.store.read();
    assert.equal(staged.record.cursor,1);assert.equal(staged.record.phase,'switching');assert.equal(saved.cursor,1);assert.equal(saved.phase,'switching');
    await staged.rollback();assert.deepEqual(await fs.readFile(f.store.file),before);
  }finally{release();await f.queue.dispose();}
});
test('canceling immediately after a staged atomic rename restores the old batch and refuses an external newer rollback',async()=>{
  for(const external of [false,true]){
    const f=await fixture(),before=await fs.readFile(f.store.file),staged=await f.store.stage({...f.plan,mode:'continuous'}),abort=new AbortController(),rename=fs.rename;let edited,once=true;
    fs.rename=async(from,to)=>{await rename(from,to);if(to===f.store.file&&once){once=false;if(external){const newer=await f.store.read();newer.revision++;newer.reason='synthetic-post-commit-edit';edited=Buffer.from(JSON.stringify(newer));await fs.writeFile(to,edited);}abort.abort();}};
    try{staged.record.phase='playing';await assert.rejects(staged.commit({signal:abort.signal}),external?/QUEUE_RECORD_CHANGED/:/QUEUE_STOPPED/);
      assert.deepEqual(await fs.readFile(f.store.file),external?edited:before);
    }finally{fs.rename=rename;await f.queue.dispose();}
  }
});
test('homepage requires an explicit video choice and never manufactures selection from a percentage or a recent record',()=>{
  const recent={seconds:65,selection:selections[1]},state=chooseHomepageState({snapshot,currentUrl:courseUrl,recent});assert.equal(state.title,'点击方格播放视频');assert.equal(state.selection,undefined);
  const foreign=chooseHomepageState({snapshot,currentUrl:courseUrl.replace('SyntheticPersonal','Other'),recent});assert.equal(foreign.title,'这门课堂还没有扫描');
  for(const progress of [null,0,100]){const model=chooseHomepageState({snapshot:{...snapshot,items:snapshot.items.map(item=>({...item,progress}))},currentUrl:courseUrl});assert.equal(model.selection,undefined);assert.equal(model.title,'点击方格播放视频');}
});
test('recent-position lookup is read-only, classroom isolated and never manufactures empty records',async()=>{
  const f=await fixture();const store=new PositionStore({directory:path.join(f.dir,'positions')});
  const targets=f.plan.targets;assert.equal(await store.recentForTargets(targets),null);await assert.rejects(fs.access(store.directory));
  const record=await store.load(targets[0]);await store.save(record,{...freshLedger(targets[0]),duration:100,watchedPrefix:65,position:65},null);
  const before=await fs.readFile(store.file(targets[0]));const recent=await store.recentForTargets(targets);assert.equal(recent.seconds,65);assert.equal(recent.target.title,targets[0].title);assert.deepEqual(await fs.readFile(store.file(targets[0])),before);
  assert.equal(await store.recentForTargets([{...targets[0],classroomId:'DifferentSynthetic'}]),null);await f.queue.dispose();
});


test('duplicate concurrent start requests produce one queue job and one selected-order run',async()=>{
  const f=await fixture();try{
    await Promise.all([f.queue.start(),f.queue.start(),f.queue.start()]);await settled(f.queue);
    assert.deepEqual(f.log.filter(([,a])=>a==='play').map(([i])=>i),[0,1]);assert.equal(f.maxOpen,1);
  }finally{await f.queue.dispose();}
});

test('queue inspector distinguishes a lesson about verification from an actual official challenge',async()=>{
  const {SingleController}=await import('../src/local-single-video/controller.mjs');
  const c=Object.create(SingleController.prototype);let text='人脸识别与验证码入门课程 暂无检查点';
  c.boundPlayerUrl='https://www.educoder.net/video_info?video_id=mock&course_id=123';
  c.player={url:()=>c.boundPlayerUrl,isClosed:()=>false,locator:()=>({innerText:async()=>text})};
  c.context={pages:()=>[c.player]};c.media={mediaErrorCode:null};
  await c.inspectPersonalQueueSafety();
  text='请完成身份核验 暂无检查点';await assert.rejects(c.inspectPersonalQueueSafety(),/QUEUE_VERIFICATION/);
  text='暂无检查点';c.media.mediaErrorCode=3;await assert.rejects(c.inspectPersonalQueueSafety(),/MEDIA_DECODE_ERROR/);
});

test('the homepage module is served from the real loopback asset router and unknown files stay denied',async()=>{
  const {createServer}=await import('../src/server.js');const {listenOnBrowserSafePort}=await import('../src/loopback-port.js');
  const server=createServer({getStatus:()=>({phase:'idle'}),getInventory:()=>null});await listenOnBrowserSafePort(server);
  try{const origin=`http://127.0.0.1:${server.address().port}`,res=await fetch(origin+'/personal-home.js');
    assert.equal(res.status,200);assert.match(res.headers.get('content-type'),/text\/javascript/);assert.match(await res.text(),/chooseHomepageState/);
    assert.equal((await fetch(origin+'/src/personal-queue-store.mjs')).status,404);
  }finally{await new Promise(resolve=>server.close(resolve));}
});


test('personal queue IPC requires the actual trusted frame, rejects foreign or extra selections and opens cold',async()=>{
  const {EventEmitter}=await import('node:events');const {pathToFileURL}=await import('node:url');
  const {registerManualVideoDesktop}=await import('../src/local-manual-video.js');
  const directory=await fs.mkdtemp(path.join(os.tmpdir(),'educoder-personal-test-'));temporary.push(directory);const handlers=new Map(),windows=[];let creates=0;
  class Window extends EventEmitter {
    constructor(){super();windows.push(this);this.webContents=new EventEmitter();this.webContents.mainFrame={url:''};this.webContents.setWindowOpenHandler=()=>{};}
    setMenuBarVisibility(){} restore(){} show(){} focus(){} destroy(){this.emit('closed');} close(){this.emit('close',{preventDefault(){}});}
    async loadFile(file){this.webContents.mainFrame.url=pathToFileURL(file).href;}
  }
  const main=new Window(),frame={url:'http://127.0.0.1:51001/'};main.webContents.mainFrame=frame;main.webContents.getURL=()=>frame.url;
  const event={sender:main.webContents,senderFrame:frame},runtime={origin:'http://127.0.0.1:51001',controller:{getStatus:()=>({phase:'idle'}),getInventory:()=>snapshot}};
  const manager=registerManualVideoDesktop({app:{getPath:()=>directory,getVersion:()=> '0.1.9',isPackaged:false},ipcMain:{handle:(name,fn)=>handlers.set(name,fn),removeHandler:name=>handlers.delete(name)},BrowserWindow:Window,window:main,getRuntime:()=>runtime,
    controllerFactory:({target})=>{creates++;return {init:async()=>{},status:()=>({target:target.title,media:null,busy:false}),persist:async()=>{},dispose:async()=>{}};}});
  try {
    const open=handlers.get('personal-queue:open'),request={courseUrl,selections};
    await assert.rejects(open({...event,senderFrame:{...frame}},request));
    await assert.rejects(open(event,{...request,allowPaid:true}));
    await assert.rejects(open(event,{...request,selections:[{...selections[0],courseUrl:'https://www.educoder.net/classrooms/Foreign/video'}]}));
    assert.equal(creates,0);assert.equal(await handlers.get('personal-queue:summary')(event),null);
    await open(event,request);const viewer=windows.at(-1),viewerEvent={sender:viewer.webContents,senderFrame:viewer.webContents.mainFrame};
    const state=handlers.get('single:status')(viewerEvent);assert.equal(state.queue.active,false);assert.equal(state.queue.phase,'ready');assert.equal(state.media,null);assert.equal(creates,1);
    assert.throws(()=>handlers.get('single:queue-action')(event,'start'),/当前观看窗口/);
    assert.throws(()=>handlers.get('single:queue-action')(viewerEvent,'play'),/QUEUE_ACTION_INVALID/);
  }finally{await manager.close();}
});


test('a stop during the first pending disk commit stays stopped and cannot open a late player',async()=>{
  const f=await fixture();let release,started;const wait=new Promise(r=>release=r),begun=new Promise(r=>started=r),read=f.store.read.bind(f.store);let first=true;
  f.store.read=async()=>{if(first){first=false;started();await wait;}return read();};
  try{await f.queue.start();await begun;const stop=f.queue.pause(true);release();await stop;await settled(f.queue);
    assert.equal(f.queue.status().queue.phase,'stopped');assert.equal((await f.store.read()).phase,'stopped');assert.equal(f.log.filter(([,a])=>a==='open'||a==='play').length,0);
  }finally{release();await f.queue.dispose();}
});

test('a stop during a delayed next-controller creation disposes the late child without opening it', async () => {
  const f = await fixture(); let release, began;
  const wait = new Promise(resolve => { release = resolve; }), creating = new Promise(resolve => { began = resolve; });
  const createSingle = f.queue.createSingle;
  f.queue.createSingle = async target => { if (target.index === 1) { began(); await wait; } return createSingle(target); };
  try {
    await f.queue.start(); await creating;
    const stopping = f.queue.pause(true); release(); await stopping; await settled(f.queue);
    assert.equal(f.queue.status().queue.phase, 'stopped');
    assert.equal(f.log.filter(([index, action]) => index === 1 && action === 'open').length, 0);
    assert.equal(f.log.filter(([index, action]) => index === 1 && action === 'dispose').length, 1);
    assert.equal(f.queue.single, null);
  } finally { release(); await f.queue.dispose(); }
});

test('finish during a pending start factory waits for and disposes that child', async () => {
  const f = await fixture(); await f.queue.single.dispose(); f.queue.single = null;
  let release, began;
  const wait = new Promise(resolve => { release = resolve; }), creating = new Promise(resolve => { began = resolve; });
  const createSingle = f.queue.createSingle;
  f.queue.createSingle = async target => { began(); await wait; return createSingle(target); };
  try {
    const starting = f.queue.start(); await creating;
    const finishing = f.queue.dispose(); release(); await Promise.all([starting, finishing]);
    assert.equal(f.queue.single, null);
    assert.equal(f.log.filter(([, action]) => action === 'dispose').length, 2);
    assert.equal(f.log.some(([, action]) => action === 'open' || action === 'play'), false);
  } finally { release(); await f.queue.dispose(); }
});

test('a queue stop surfaces a failed observed-position save and finish cannot report success', async () => {
  const f = await fixture({ engine: { pollMs: 100 } });
  try {
    let started;const playing=new Promise(resolve=>{started=resolve;});
    f.queue.onState=state=>{if(state.phase==='playing')started();};
    await f.queue.start(); await playing;
    const child = f.queue.single, persist = child.persist;
    child.persist = async () => { throw new Error('RECORD_CHANGED'); };
    const state = await f.queue.pause(true); await settled(f.queue);
    assert.equal(state.queue.reason, 'RECORD_CHANGED');
    assert.match(state.queue.message, /较新记录/);
    await assert.rejects(f.queue.dispose(), /RECORD_CHANGED/);
    child.persist = persist;
  } finally { await f.queue.dispose().catch(() => {}); }
});

test('a queue finish retries its actual single-controller save after a transient halt failure', async () => {
  const f = await fixture(), store = new PositionStore({ directory: path.join(f.dir, 'retry-positions') });
  const child = new SingleController({ dataDir: f.dir, appData: f.dir, target: f.plan.targets[0], positionStore: store,
    connectExistingBridge: false, sessionProvider: async () => { throw new Error('unexpected browser request'); } });
  await child.init(); clearTimeout(child.timer); await f.queue.single.dispose(); f.queue.single = child;
  child.ledger.value = { ...freshLedger(child.target), duration: 100, watchedPrefix: 5, position: 5 };
  const save = store.save.bind(store); let attempts = 0, available = false;
  store.save = async (...args) => { attempts++; if (!available) throw Object.assign(new Error('synthetic disk failure'), { code: 'EIO' }); return save(...args); };
  try {
    const paused = await f.queue.pause(true);
    assert.equal(paused.queue.reason, 'QUEUE_SAVE_FAILED');
    await assert.rejects(f.queue.dispose(), error => error.code === 'EIO');
    available = true;
    await assert.doesNotReject(f.queue.dispose());
    assert.equal(attempts, 3);
    assert.equal((await store.load(child.target)).observation.position, 5);
    assert.equal(f.queue.single, null);
  } finally { available = true; await f.queue.dispose().catch(() => {}); }
});

test('a three-target queue initializing cursor one reports that target and completed state retains the last target', async () => {
  const f = await fixture(), plan = resolvePersonalQueue({ ...snapshot, items: [...snapshot.items, { page: 1, index: 2, title: '模拟视频 C', progress: 0 }] },
    [...selections, { courseUrl, page: 1, index: 2, title: '模拟视频 C' }]);
  await f.queue.dispose();
  const record = await f.store.create(plan, { replace: true }); record.cursor = 1; record.phase = 'paused'; await f.store.save(record);
  let release, began; const wait = new Promise(resolve => { release = resolve; }), starting = new Promise(resolve => { began = resolve; });
  const calls = [], queue = new PersonalQueueController({ store: f.store, record, targets: plan.targets, createSingle: async target => {
    began(); await wait; return { target, status: () => ({ target: target.title, page: target.page, index: target.index, media: null }),
      dispose: async () => {}, act: async action => { calls.push(action); } };
  } });
  const initializing = queue.init();
  try {
    await starting;
    const current = queue.status();
    assert.equal(current.target, plan.targets[1].title); assert.equal(current.index, plan.targets[1].index);
    assert.equal(current.queue.cursor, 1); assert.equal(current.queue.active, false); assert.deepEqual(calls, []);
  } finally { release(); await initializing; await queue.dispose(); }
  const completed = new PersonalQueueController({ store: f.store, record: { ...record, cursor: plan.targets.length, phase: 'completed' },
    targets: plan.targets, createSingle: async () => { throw new Error('completed queue must stay cold'); } });
  await completed.init();
  assert.equal(completed.status().target, plan.targets.at(-1).title); assert.equal(completed.status().index, 2);
  await completed.dispose();
});
