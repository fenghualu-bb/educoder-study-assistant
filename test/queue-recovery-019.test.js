import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { PersonalQueueStore, resolvePersonalQueue } from '../src/personal-queue-store.mjs';
import { PersonalQueueController, isRecoverableQueueError } from '../src/personal-queue-controller.mjs';

const courseUrl='https://www.educoder.net/classrooms/SyntheticQueueRecovery019/video';
const items=[{page:1,index:0,title:'Synthetic first',progress:0},{page:2,index:0,title:'Synthetic next page',progress:0}];
const snapshot={courseUrl,courseTitle:'Synthetic queue recovery',complete:true,pagesScanned:2,items};
const selections=items.map(({page,index,title})=>({courseUrl,page,index,title}));
const sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms));
function deferred(){let resolve;return {promise:new Promise(done=>{resolve=done;}),resolve:value=>resolve(value)};}
async function until(read,predicate,timeout=2000){const limit=Date.now()+timeout;let value;
  while(Date.now()<limit){value=read();if(predicate(value))return value;await sleep(1);}
  assert.fail('Synthetic recovery fixture did not settle: '+JSON.stringify(value));}

async function fixture(t,options={}){
  const directory=await fs.mkdtemp(path.join(os.tmpdir(),'educoder-queue-019-'));
  const store=new PersonalQueueStore(path.join(directory,'queue.json'));
  const plan=resolvePersonalQueue(snapshot,options.single?[selections[0]]:selections);
  const record=await store.create({...plan,mode:options.single?'single':'continuous'});
  const log=[],states=[],singles=[];
  const shared={alive:true,anchor:false,players:0,maxPlayers:0,verifyFailures:options.verifyFailures??0,
    preparingError:options.preparingError??null,preparingFailures:options.preparingFailures??0,
    sampleError:options.sampleError??null,sampleFailures:options.sampleFailures??0,
    recoveryError:options.recoveryError??null,recoveryGate:null,disposeGate:null,verifyGate:null,
    autoProgress:options.autoProgress!==false,percent:options.percent??100,disposeFailure:options.disposeFailure??null,
    recoveryInFlight:0,maxRecoveryInFlight:0};
  async function createSingle(target){
    if(!shared.alive)throw new Error('OFFICIAL_WINDOW_CLOSED');
    let media=null,watched=0,closed=true,pageClosed=false,percent=0;
    const label=target.page;
    const child={busy:false,operationSignal:null,ownedPlayer:null,
      status(){return {target:target.title,page:target.page,index:target.index,media:media&&{...media},
        stage:media?.ended?'ended':media?.paused?'paused':media?'playing':'not-open',
        confirmedWatchedPrefix:watched,confirmedWatchedSeconds:watched,resumeSeconds:watched,
        playAllowed:true,actionsAvailable:true,actionError:null,percent,busy:this.busy};},
      check(){if(this.operationSignal?.aborted)throw new Error('QUEUE_STOPPED');},
      open(){if(!shared.alive)throw new Error('OFFICIAL_WINDOW_CLOSED');if(closed){closed=false;shared.players++;shared.maxPlayers=Math.max(shared.maxPlayers,shared.players);}
        this.ownedPlayer=this.player;shared.anchor=false;media={currentTime:watched,duration:3,paused:true,ended:false,readyState:4,playbackRate:1,mediaErrorCode:null};},
      async prepareQueuePlayback(policy){log.push([label,'prepare',policy]);this.check();
        if(shared.preparingFailures-->0)throw new Error(shared.preparingError);this.open();return this.status();},
      async recoverQueuePlayback(error){shared.recoveryInFlight++;shared.maxRecoveryInFlight=Math.max(shared.maxRecoveryInFlight,shared.recoveryInFlight);
        log.push([label,'recover',error.code??error.message]);this.busy=true;
        try{await shared.recoveryGate;this.check();if(shared.recoveryError)throw new Error(shared.recoveryError);
          await this.player.close();this.check();this.open();return this.status();}
        finally{this.busy=false;shared.recoveryInFlight--;}
      },
      async act(action){log.push([label,action]);if(action==='open')this.open();
        if(action==='play'){this.check();if(!media)throw new Error('OPEN_FIRST');media.paused=false;}
        if(action==='pause'&&media)media.paused=true;
        if(action==='close-video')await this.player.close();return this.status();},
      async sample(){
        if(shared.sampleFailures>0&&media&&!media.paused){shared.sampleFailures--;throw new Error(shared.sampleError);}
        if(media&&!media.paused&&!media.ended&&shared.autoProgress){media.currentTime=Math.min(3,media.currentTime+1);watched=media.currentTime;
          if(media.currentTime===3){media.ended=true;media.paused=true;}}
      },
      async inspectPersonalQueueSafety(){},
      async selectCard(){log.push([label,'verify']);await shared.verifyGate;
        if(shared.verifyFailures-->0)throw new Error('LIST_UNAVAILABLE');percent=shared.percent;
        if(options.afterVerify)options.afterVerify(media);},
      async persist(){log.push([label,'persist']);},
      async dispose({preserveOfficialSession=false}={}){log.push([label,'dispose',preserveOfficialSession]);await shared.disposeGate;
        if(shared.disposeFailure){const failure=shared.disposeFailure;shared.disposeFailure=null;throw Object.assign(new Error('synthetic save'),{code:failure});}
        await this.player.close();shared.anchor=preserveOfficialSession;if(!preserveOfficialSession)shared.alive=false;},
      requestStop(){},async changePlaybackOptions(){}
    };
    child.player={isClosed:()=>closed,close:async()=>{if(!closed)shared.players--;closed=true;media=null;}};
    child.ownedPlayer=child.player;child.page={isClosed:()=>pageClosed,close:async()=>{pageClosed=true;}};
    singles.push(child);return child;
  }
  const queue=new PersonalQueueController({store,record,targets:plan.targets,createSingle,pollMs:1,verifyMs:1,verifyAttempts:3,
    retryBaseMs:options.retryBaseMs??2,retryMaxMs:options.retryMaxMs??8,stallMs:30000,operationMs:100,
    prepareNextFromSaved:true,onState:state=>states.push({...state})});
  await queue.init();
  t.after(async()=>{shared.recoveryGate=null;shared.disposeGate=null;shared.verifyGate=null;
    await queue.dispose().catch(()=>{});
    assert.equal(path.dirname(directory).toLowerCase(),os.tmpdir().toLowerCase());assert.match(path.basename(directory),/^educoder-queue-019-/);
    await fs.rm(directory,{recursive:true,force:true});});
  return {queue,record,store,shared,log,states,singles,plays:()=>log.filter(([,action])=>action==='play')};
}

for(const error of ['PAGE_LOAD_FAILED','MEDIA_NOT_READY','OFFICIAL_CONTROLS_UNAVAILABLE','OFFICIAL_PROGRESS_CONTROL_UNAVAILABLE'])
  test('019 initial '+error+' waits and safely continues the same selected item before the next page',async t=>{
    const f=await fixture(t,{preparingError:error,preparingFailures:1});await f.queue.start();await f.queue.job;
    assert.equal(f.record.phase,'completed');assert.equal(f.record.cursor,2);
    assert.ok(f.states.some(state=>state.active&&state.waiting&&state.retryReason===error&&state.cursor===0));
    assert.deepEqual(f.plays().map(([page])=>page),[1,2]);assert.equal(f.shared.maxPlayers,1);
    assert.equal(f.shared.maxRecoveryInFlight,1);assert.equal(f.shared.alive,false);
  });

for(const error of ['MEDIA_NETWORK_ERROR','MEDIA_DECODE_ERROR','PAGE_RESET'])
  test('019 '+error+' during watching waits, reidentifies and continues without advancing early',async t=>{
    const f=await fixture(t,{sampleError:error,sampleFailures:1});await f.queue.start();await f.queue.job;
    assert.equal(f.record.phase,'completed');assert.equal(f.record.cursor,2);
    const recovery=f.log.findIndex(([,action])=>action==='recover'),next=f.log.findIndex(([page,action])=>page===2&&action==='prepare');
    assert.ok(recovery>=0&&next>recovery);assert.ok(f.states.some(state=>state.waiting&&state.cursor===0));
    assert.deepEqual(f.plays().map(([page])=>page),[1,1,2]);assert.equal(f.shared.maxPlayers,1);
  });

test('019 a network failure while confirming completion retries only the official list, with no replay',async t=>{
  const f=await fixture(t,{verifyFailures:2});await f.queue.start();await f.queue.job;
  assert.equal(f.record.phase,'completed');assert.equal(f.record.cursor,2);
  assert.deepEqual(f.plays().map(([page])=>page),[1,2]);assert.equal(f.log.filter(([,action])=>action==='recover').length,0);
  assert.equal(f.log.filter(([page,action])=>page===1&&action==='verify').length,3);
  assert.ok(f.states.some(state=>state.phase==='verifying'&&state.waiting&&state.cursor===0));
});

test('019 list transport errors do not consume the bounded non100 completion checks',async t=>{
  const f=await fixture(t,{verifyFailures:2,percent:99});await f.queue.start();await f.queue.job;
  assert.equal(f.record.reason,'QUEUE_NOT_CONFIRMED');assert.equal(f.record.cursor,0);
  assert.equal(f.log.filter(([,action])=>action==='verify').length,5);assert.equal(f.plays().length,1);
  assert.equal(f.singles.length,1);assert.equal(f.queue.status().media.ended,true);
});

for(const action of ['pause','stop','dispose','requestStop'])
  test('019 '+action+' cancels recovery waiting before any delayed preparation or play',async t=>{
    const f=await fixture(t,{preparingError:'MEDIA_NOT_READY',preparingFailures:1,retryBaseMs:100,retryMaxMs:100});
    await f.queue.start();await until(()=>f.queue.status(),state=>state.queue.waiting);
    assert.equal(f.queue.status().busy,false);const before=f.log.length;
    if(action==='pause')await f.queue.pause();else if(action==='stop')await f.queue.pause(true);
    else if(action==='dispose')await f.queue.dispose();else f.queue.requestStop();
    await f.queue.job;await sleep(110);
    assert.equal(f.queue.active,false);assert.equal(f.record.cursor,0);assert.equal(f.plays().length,0);
    assert.equal(f.log.slice(before).some(([,name])=>name==='recover'||name==='prepare'),false);
    assert.equal(f.singles.length,1);
  });

test('019 canceling a delayed recovery rejects its late result without starting playback',async t=>{
  const gate=deferred(),f=await fixture(t,{preparingError:'PAGE_RESET',preparingFailures:1});f.shared.recoveryGate=gate.promise;
  await f.queue.start();await until(()=>f.shared.recoveryInFlight,count=>count===1);
  const stopping=f.queue.pause(true);gate.resolve();await stopping;await f.queue.job;
  assert.equal(f.record.reason,'QUEUE_STOPPED');assert.equal(f.record.cursor,0);assert.equal(f.plays().length,0);
  assert.equal(f.singles.length,1);assert.equal(f.shared.maxRecoveryInFlight,1);
});

test('019 duplicate starts during waiting retain one job and one recovery operation',async t=>{
  const gate=deferred(),f=await fixture(t,{preparingError:'PAGE_LOAD_FAILED',preparingFailures:1});f.shared.recoveryGate=gate.promise;
  await f.queue.start();await until(()=>f.shared.recoveryInFlight,count=>count===1);
  await Promise.all(Array.from({length:20},()=>f.queue.start()));
  assert.equal(f.singles.length,1);assert.equal(f.shared.maxRecoveryInFlight,1);gate.resolve();await f.queue.job;
  assert.equal(f.record.cursor,2);assert.deepEqual(f.plays().map(([page])=>page),[1,2]);
});

for(const error of ['QUEUE_LOGIN_REQUIRED','QUEUE_VERIFICATION','QUEUE_PLATFORM_BLOCKED','QUEUE_CHECKPOINT','PLAYER_CHANGED','OFFICIAL_WINDOW_CLOSED','RECORD_CHANGED'])
  test('019 '+error+' detected during recovery terminates without another play or next item',async t=>{
    const f=await fixture(t,{preparingError:'PAGE_RESET',preparingFailures:1,recoveryError:error});await f.queue.start();await f.queue.job;
    assert.equal(f.queue.active,false);assert.equal(f.record.reason,error);assert.equal(f.record.cursor,0);
    assert.equal(f.plays().length,0);assert.equal(f.singles.length,1);assert.equal(f.queue.status().queue.waiting,false);
  });

test('019 intermediate cleanup preserves the official context until the next fresh target is prepared',async t=>{
  const f=await fixture(t);await f.queue.start();await f.queue.job;
  assert.deepEqual(f.log.filter(([,action])=>action==='dispose').map(([page,,keep])=>[page,keep]),[[1,true],[2,false]]);
  assert.equal(f.shared.maxPlayers,1);assert.equal(f.shared.alive,false);assert.equal(f.record.phase,'completed');
  const firstDispose=f.log.findIndex(([page,action])=>page===1&&action==='dispose'),nextPrepare=f.log.findIndex(([page,action])=>page===2&&action==='prepare');
  assert.ok(nextPrepare>firstDispose);assert.equal(f.queue.completionConfirmed,true);
});

test('019 a failed item cleanup cannot advance the cursor or create the next player',async t=>{
  const f=await fixture(t,{disposeFailure:'EIO'});await f.queue.start();await f.queue.job;
  assert.equal(f.record.cursor,0);assert.equal((await f.store.read()).cursor,0);assert.equal(f.record.reason,'QUEUE_SAVE_FAILED');
  assert.equal(f.singles.length,1);assert.equal(f.queue.completionConfirmed,false);
});

test('019 a failed last-item cleanup cannot publish completed state',async t=>{
  const f=await fixture(t,{single:true,disposeFailure:'EIO'});await f.queue.start();await f.queue.job;
  assert.equal(f.record.cursor,0);assert.equal(f.record.phase,'paused');assert.equal(f.queue.completionConfirmed,false);
  assert.equal(f.states.some(state=>state.phase==='completed'),false);
});

test('019 stop during intermediate cleanup prevents cursor commit and late next-target creation',async t=>{
  const gate=deferred(),f=await fixture(t);f.shared.disposeGate=gate.promise;
  await f.queue.start();await until(()=>f.log,log=>log.some(([,action])=>action==='dispose'));
  await f.queue.pause(true);gate.resolve();await f.queue.job;
  assert.equal(f.record.reason,'QUEUE_STOPPED');assert.equal(f.record.cursor,0);assert.equal((await f.store.read()).cursor,0);
  assert.equal(f.singles.length,1);assert.equal(f.queue.single,null);assert.equal(f.queue.completionConfirmed,false);
});

test('019 a canceled late official100 result never advances to another item',async t=>{
  const gate=deferred(),f=await fixture(t);f.shared.verifyGate=gate.promise;
  await f.queue.start();await until(()=>f.log,log=>log.some(([,action])=>action==='verify'));
  await f.queue.pause(true);gate.resolve();await f.queue.job;
  assert.equal(f.record.reason,'QUEUE_STOPPED');assert.equal(f.record.cursor,0);assert.equal(f.singles.length,1);
});

test('019 completion is refused when a fresh sample no longer matches a natural end',async t=>{
  const f=await fixture(t,{afterVerify:media=>{media.duration=5;}});await f.queue.start();await f.queue.job;
  assert.equal(f.record.reason,'QUEUE_UNWATCHED_GAP');assert.equal(f.record.cursor,0);assert.equal(f.singles.length,1);
});

test('019 recoverable classifications exclude ambiguous controls, user closure, identity drift and generic media failure',()=>{
  for(const error of ['OFFICIAL_PROGRESS_CONTROL_AMBIGUOUS','OFFICIAL_WINDOW_AMBIGUOUS','NATIVE_SCRIPT_BLOCKED',
    'OFFICIAL_WINDOW_CLOSED','PLAYER_CHANGED','MEDIA_ERROR','QUEUE_UNWATCHED_GAP','EIO','RECORD_CHANGED'])
    assert.equal(isRecoverableQueueError(new Error(error)),false,error);
  for(const error of ['PAGE_RESET','MEDIA_NOT_READY','MEDIA_NETWORK_ERROR','MEDIA_DECODE_ERROR','LIST_UNAVAILABLE'])
    assert.equal(isRecoverableQueueError(new Error(error)),true,error);
});

test('019 final completion save failure retains proof and explicit finish retries only persistence',async t=>{
  const f=await fixture(t,{single:true}),save=f.store.save.bind(f.store);let unavailable=true,attempts=0;
  f.store.save=async record=>{if(record.phase==='completed'){attempts++;if(unavailable)throw Object.assign(new Error('synthetic disk unavailable'),{code:'EIO'});}return save(record);};
  await f.queue.start();await f.queue.job;
  assert.equal(f.record.cursor,0);assert.equal((await f.store.read()).cursor,0);
  assert.equal(f.record.phase,'paused');assert.equal(f.record.reason,'QUEUE_SAVE_FAILED');
  assert.equal(f.queue.pendingCompletion,true);assert.equal(f.queue.status().queue.completionPending,true);
  assert.equal(f.queue.completionConfirmed,false);assert.equal(f.queue.single,null);
  const plays=f.plays().length,created=f.singles.length;
  await assert.rejects(f.queue.dispose(),error=>error.code==='EIO');
  assert.equal(f.queue.pendingCompletion,true);assert.equal(f.record.cursor,0);
  unavailable=false;await f.queue.dispose();
  assert.equal(f.record.phase,'completed');assert.equal(f.record.cursor,1);assert.equal((await f.store.read()).cursor,1);
  assert.equal(f.queue.pendingCompletion,false);assert.equal(f.queue.completionConfirmed,true);
  assert.equal(f.plays().length,plays);assert.equal(f.singles.length,created);assert.equal(attempts,3);
});

test('019 final completion retry preserves an externally newer queue and cannot recreate a player',async t=>{
  const f=await fixture(t,{single:true}),save=f.store.save.bind(f.store);let once=true;
  f.store.save=async record=>{if(record.phase==='completed'&&once){once=false;throw Object.assign(new Error('synthetic disk unavailable'),{code:'EIO'});}return save(record);};
  await f.queue.start();await f.queue.job;
  const newer=await f.store.read();newer.revision++;newer.reason='synthetic external update';
  const bytes=Buffer.from(JSON.stringify(newer));await fs.writeFile(f.store.file,bytes);
  await assert.rejects(f.queue.dispose(),/QUEUE_RECORD_CHANGED/);
  assert.deepEqual(await fs.readFile(f.store.file),bytes);assert.equal(f.queue.pendingCompletion,true);
  assert.equal(f.queue.completionConfirmed,false);assert.equal(f.record.cursor,0);
  assert.equal(f.plays().length,1);assert.equal(f.singles.length,1);assert.equal(f.queue.single,null);
});

for(const revise of [false,true])test('019 fresh completion guard detects an external post-save change'+(revise?' with a newer revision':' even without revision change'),async t=>{
  const f=await fixture(t,{single:true}),save=f.store.save.bind(f.store);let changedBytes;
  f.store.save=async record=>{const result=await save(record);
    if(record.phase==='completed'&&!changedBytes){const external=await f.store.read();if(revise)external.revision++;
      external.reason='synthetic post-save external update';changedBytes=Buffer.from(JSON.stringify(external));await fs.writeFile(f.store.file,changedBytes);}
    return result;};
  await f.queue.start();await f.queue.job;
  assert.equal(f.queue.completionConfirmed,true);
  await assert.rejects(f.queue.dispose(),/QUEUE_RECORD_CHANGED/);
  assert.deepEqual(await fs.readFile(f.store.file),changedBytes);assert.equal(f.queue.status().discardAvailable,true);
  assert.equal(f.plays().length,1);assert.equal(f.singles.length,1);
  await assert.rejects(f.queue.dispose(),/QUEUE_RECORD_CHANGED/);
  await f.queue.dispose({discardUnsavedPosition:true});assert.deepEqual(await fs.readFile(f.store.file),changedBytes);
});

test('019 paused options wait for the canceled job and clear its signal without starting playback',async t=>{
  const f=await fixture(t,{single:true,autoProgress:false});let settings=0;
  f.queue.single.changePlaybackOptions=async()=>{if(f.queue.single.operationSignal?.aborted)throw new Error('QUEUE_STOPPED');settings++;};
  await f.queue.start();await until(()=>f.record.phase,phase=>phase==='playing');
  await assert.rejects(f.queue.changePlaybackOptions({autoMute:true}),/OPTIONS_BUSY/);assert.equal(settings,0);
  await f.queue.pause();const plays=f.plays().length;
  await f.queue.changePlaybackOptions({autoMute:true});
  assert.equal(f.queue.single.operationSignal,null);assert.equal(settings,1);assert.equal(f.plays().length,plays);
  assert.equal(f.queue.active,false);assert.equal(f.record.reason,'USER_PAUSED');
});

test('019 explicit restart grants closed-player reopening once, while automatic recovery never receives the grant',async t=>{
  const f=await fixture(t,{single:true,autoProgress:false});f.queue.single.ownedPlayer=null;
  await f.queue.start();await until(()=>f.record.phase,phase=>phase==='playing');
  await f.queue.pause(true);assert.equal(f.queue.single.player.isClosed(),true);
  await f.queue.start();await until(()=>f.record.phase,phase=>phase==='playing');await f.queue.pause();
  const prepares=f.log.filter(([,action])=>action==='prepare').map(([, ,policy])=>policy);
  assert.equal(prepares[0].reopenClosedPlayer,false);assert.equal(prepares[1].reopenClosedPlayer,true);
  assert.equal(prepares[1].fromSaved,true);assert.equal(prepares[1].fromBeginning,false);
  assert.equal(f.queue.explicitReopenSingle,null);
});
