import test from 'node:test';
import assert from 'node:assert/strict';
import {SingleController} from '../src/local-single-video/controller.mjs';
import {ObservationLedger,freshLedger} from '../src/local-single-video/ledger.mjs';

function fixture({newTime=0,safetyError=null}={}){
  const target={classroomId:'SyntheticRestart',title:'Synthetic restart',page:1,index:0},events=[],saved=[];
  const single=new SingleController({dataDir:'.',appData:'.',target,connectExistingBridge:false,positionStore:{save:async(_record,value)=>{events.push('save');saved.push(structuredClone(value));}}});
  single.record={playerIdentity:null};single.ledger=new ObservationLedger({...freshLedger(target),duration:120,position:25,watchedPrefix:25,watchedRanges:[[0,25]]});
  let closed=false;const player={url:()=> 'https://www.educoder.net/classrooms/SyntheticRestart/video_info',isClosed:()=>closed,close:async()=>{events.push('close');closed=true;}};
  single.player=player;single.ownedPlayer=player;single.boundPlayerUrl=player.url();single.verifiedPlayer=true;single.touched=true;
  single.media={currentTime:25,duration:120,paused:true,ended:false,playbackRate:1,readyState:4};single.stage='paused';
  single.sample=async()=>{};
  single.native=async(action,pid,seconds)=>{assert.equal(action,'restore');assert.equal(seconds,0);events.push('zero-refused');throw new Error('OFFICIAL_PROGRESS_CONTROL_UNAVAILABLE');};
  single.openVideo=async()=>{events.push('open-same');const fresh={url:player.url,isClosed:()=>false,close:async()=>{}};single.player=fresh;single.ownedPlayer=fresh;single.boundPlayerUrl=fresh.url();single.media={...single.media,currentTime:newTime,duration:120,paused:true,ended:false};single.stage='paused';single.verifiedPlayer=true;};
  single.inspectPlaybackSafety=async()=>{events.push('safety');if(safetyError)throw new Error(safetyError);};
  return {single,events,saved,player};
}

test('official minimum refusal reopens only the owned paused video and preserves saved observation',async()=>{
  const f=fixture(),before=structuredClone(f.single.ledger.value);const state=await f.single.act('beginning');
  assert.equal(state.actionError,null);assert.equal(state.media.currentTime,0);assert.equal(state.media.paused,true);
  assert.deepEqual(f.events,['zero-refused','save','close','open-same','safety']);
  assert.deepEqual(f.saved,[before]);assert.deepEqual(f.single.ledger.value,before);assert.equal(f.single.touched,false);
});

for(const options of [{newTime:.7},{safetyError:'CHECKPOINT'}])test('reopened official nonzero position or checkpoint never qualifies as beginning',async()=>{
  const f=fixture(options),before=structuredClone(f.single.ledger.value);const state=await f.single.act('beginning');
  assert.equal(state.actionError,options.safetyError??'RESTORE_REFUSED');assert.equal(state.media.paused,true);
  assert.deepEqual(f.saved,[before]);assert.deepEqual(f.single.ledger.value,before);assert.equal(f.events.includes('play'),false);
});

test('cancel during save cannot close or reopen a late beginning player',async()=>{
  const f=fixture(),abort=new AbortController();let release,entered;
  const gate=new Promise(r=>{release=r;}),began=new Promise(r=>{entered=r;});
  f.single.operationSignal=abort.signal;f.single.positionStore.save=async()=>{entered();await gate;};
  const restarting=f.single.act('beginning');await began;abort.abort();release();const state=await restarting;
  assert.equal(state.actionError,'QUEUE_STOPPED');assert.equal(f.player.isClosed(),false);assert.deepEqual(f.events,['zero-refused']);
});

test('a foreign player cannot take the reopen fallback',async()=>{
  const f=fixture();f.single.ownedPlayer={};const state=await f.single.act('beginning');
  assert.equal(state.actionError,'OFFICIAL_PROGRESS_CONTROL_UNAVAILABLE');assert.deepEqual(f.events,['zero-refused']);assert.equal(f.player.isClosed(),false);
});

for(const changed of ['url','handle','ownership'])test(`beginning rechecks ${changed} after the awaited save before closing`,async()=>{
  const f=fixture();let release,entered;
  const gate=new Promise(r=>{release=r;}),began=new Promise(r=>{entered=r;});
  f.single.positionStore.save=async()=>{entered();await gate;};
  const restarting=f.single.act('beginning');await began;
  if(changed==='url')f.player.url=()=> 'https://www.educoder.net/classrooms/SyntheticOther/video_info';
  else if(changed==='handle')f.single.player={...f.player};else f.single.ownedPlayer={};
  release();const state=await restarting;assert.equal(state.actionError,'PLAYER_CHANGED');
  assert.equal(f.player.isClosed(),false);assert.deepEqual(f.events,['zero-refused']);
});

test('beginning confirms the final sampled zero, not only the initial reopened zero',async()=>{
  const f=fixture();f.single.sample=async()=>{if(f.events.includes('open-same'))f.single.media.currentTime=.2;};
  const state=await f.single.act('beginning');assert.equal(state.actionError,'RESTORE_REFUSED');assert.equal(f.saved.length,1);
});

test('cancel during final beginning sample cannot report success',async()=>{
  const f=fixture(),abort=new AbortController();f.single.operationSignal=abort.signal;
  f.single.sample=async()=>{if(f.events.includes('open-same'))abort.abort();};
  const state=await f.single.act('beginning');assert.equal(state.actionError,'QUEUE_STOPPED');assert.equal(f.saved.length,1);
});

test('a failed close cannot reopen a second beginning player',async()=>{
  const f=fixture();f.player.close=async()=>{f.events.push('close-refused');};
  const state=await f.single.act('beginning');assert.equal(state.actionError,'PLAYER_CHANGED');assert.equal(f.events.includes('open-same'),false);
});
