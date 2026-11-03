import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { ObservationLedger, validateLedger } from '../src/local-single-video/ledger.mjs';
import { PositionStore } from '../src/local-single-video/position-store.mjs';
import { PersonalQueueController } from '../src/personal-queue-controller.mjs';
import { SingleController } from '../src/local-single-video/controller.mjs';
const target={classroomId:'SyntheticDurationReplay',title:'Synthetic replay',page:1,index:0};
const completed=()=>({version:1,target,watchedPrefix:120.04,position:120.04,duration:120.04,watchedRanges:[[0,120.04]]});
const media=(currentTime,duration=120)=>({currentTime,duration,paused:false,ended:false,playbackRate:1,mediaErrorCode:null});

test('same-video replay preserves completed evidence across a small duration decrease and store reload',async t=>{
 const directory=await fs.mkdtemp(path.join(os.tmpdir(),'educoder-duration-replay-'));
 t.after(()=>fs.rm(directory,{recursive:true,force:true}));
 const store=new PositionStore({directory}),record=await store.load(target);
 await store.save(record,completed(),null);
 const ledger=new ObservationLedger(record.observation);
 ledger.observe(media(0),0);ledger.observe(media(.5),500);
 assert.equal(ledger.value.duration,120.04);
 assert.equal(ledger.value.watchedPrefix,120.04);
 assert.equal(ledger.value.position,.5);
 assert.deepEqual(ledger.value.watchedRanges,[[0,120.04]]);
 validateLedger(ledger.value,target);
 await store.save(record,ledger.value,null);
 const loaded=await new PositionStore({directory}).load(target);
 assert.deepEqual(loaded.observation,ledger.value);
});

test('sampling rejects a substantial duration change before altering historical evidence',async()=>{
 for(const duration of [118.5,122]){
  const controller=new SingleController({dataDir:os.tmpdir(),appData:os.tmpdir(),target,positionStore:{},connectExistingBridge:false});
  controller.ledger=new ObservationLedger(completed());controller.player={isClosed:()=>false};controller.verifiedPlayer=true;
  controller.readMedia=async()=>media(.5,duration);
  const before=structuredClone(controller.ledger.value);
  await assert.rejects(controller.sample(),/PLAYER_CHANGED/);
  assert.deepEqual(controller.ledger.value,before);
 }
});

test('a duration fault breaks observation continuity before metadata recovers',async()=>{
 const controller=new SingleController({dataDir:os.tmpdir(),appData:os.tmpdir(),target,positionStore:{},connectExistingBridge:false});
 controller.ledger=new ObservationLedger(completed());controller.player={isClosed:()=>false};controller.verifiedPlayer=true;
 controller.ledger.previous={...media(5),wallMs:Date.now()-500};
 controller.readMedia=async()=>media(5.5,118.5);
 await assert.rejects(controller.sample(),/PLAYER_CHANGED/);
 assert.equal(controller.ledger.previous,null);
 controller.readMedia=async()=>media(6);await controller.sample();
 assert.equal(controller.ledger.value.position,120.04);
 controller.readMedia=async()=>media(6.2);await controller.sample();
 assert.equal(controller.ledger.value.position,6.2);
 validateLedger(controller.ledger.value,target);
});

test('queue duration drift closes only its owned player, preserves the valid record and never advances',async t=>{
 const directory=await fs.mkdtemp(path.join(os.tmpdir(),'educoder-duration-queue-'));
 t.after(()=>fs.rm(directory,{recursive:true,force:true}));
 const store=new PositionStore({directory}),record=await store.load(target);await store.save(record,completed(),null);
 const original=await fs.readFile(store.file(target));
 const single=new SingleController({dataDir:directory,appData:directory,target,positionStore:store,connectExistingBridge:false,sessionProvider:async()=>{throw new Error('No browser permitted');}});
 await single.init();clearTimeout(single.timer);
 let closed=false,listClosed=false,creates=0;
 const player={isClosed:()=>closed,close:async()=>{closed=true;},url:()=> 'https://www.educoder.net/video_info?new_video_id=synthetic'};
 single.player=single.ownedPlayer=player;single.boundPlayerUrl=player.url();single.verifiedPlayer=true;single.media=media(.5,120.04);
 single.page={isClosed:()=>listClosed,close:async()=>{listClosed=true;}};
 single.readMedia=async()=>media(.5,122);
 const queue=new PersonalQueueController({store:{save:async()=>{}},record:{cursor:0,phase:'ready',mode:'continuous',courseUrl:'https://www.educoder.net/classrooms/SyntheticDurationReplay/video'},targets:[target,{...target,index:1}],createSingle:async()=>{creates++;return single;}});
 await queue.start();await queue.job;
 assert.equal(closed,true);assert.equal(creates,1);assert.equal(queue.record.cursor,0);
 assert.equal(queue.record.phase,'paused');assert.equal(queue.record.reason,'PLAYER_CHANGED');
 assert.deepEqual(await fs.readFile(store.file(target)),original);
 await queue.dispose();
});

test('duration validation stays bound to the opened stream across smaller cumulative increases',async()=>{
 const controller=new SingleController({dataDir:os.tmpdir(),appData:os.tmpdir(),target,positionStore:{},connectExistingBridge:false});
 controller.ledger=new ObservationLedger(completed());controller.player={isClosed:()=>false};controller.verifiedPlayer=true;controller.verifiedDuration=120;
 controller.readMedia=async()=>media(0,120);await controller.sample();
 controller.readMedia=async()=>media(.5,120.7);await controller.sample();
 const before=structuredClone(controller.ledger.value);
 controller.readMedia=async()=>media(1,121.4);await assert.rejects(controller.sample(),/PLAYER_CHANGED/);
 assert.deepEqual(controller.ledger.value,before);assert.equal(controller.ledger.previous,null);
});
