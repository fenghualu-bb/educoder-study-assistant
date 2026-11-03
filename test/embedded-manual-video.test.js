import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { registerManualVideoDesktop } from '../src/local-manual-video.js';
import { SingleController } from '../src/local-single-video/controller.mjs';
import { PositionStore } from '../src/local-single-video/position-store.mjs';
import { ObservationLedger, freshLedger } from '../src/local-single-video/ledger.mjs';
import { PersonalQueueStore, resolvePersonalQueue } from '../src/personal-queue-store.mjs';
import { resolveScannedSelection } from '../src/local-single-video/target.mjs';
import { createController } from '../src/controller.js';

const courseUrl='https://www.educoder.net/classrooms/SyntheticEmbedded/video';
const snapshot={courseUrl,courseTitle:'合成课堂',complete:true,items:[
  {page:1,index:0,title:'合成视频A',cardIdentity:'https://www.educoder.net/images/synthetic-a.png',progress:0},
  {page:1,index:1,title:'合成视频B',cardIdentity:'https://www.educoder.net/images/synthetic-b.png',progress:0}]};
const selections=snapshot.items.map(({page,index,title,cardIdentity})=>({courseUrl,page,index,title,cardIdentity}));
const delay=ms=>new Promise(resolve=>setTimeout(resolve,ms));
async function until(read,accept,ms=5000){const end=Date.now()+ms;let value;do{value=await read();if(accept(value))return value;await delay(10);}while(Date.now()<end);assert.fail('timed out waiting for '+JSON.stringify(value));}
function ended(child){child.ledger=new ObservationLedger({...freshLedger(child.target),duration:100,position:100,watchedPrefix:100});Object.assign(child.value,{currentTime:100,ended:true,paused:true});child.officialPercent=100;}
async function fixture(t,{saved=false,restoreFails=false,openWait=null,initialTime=0,coldRoot=false,inventory=snapshot}={}){
  const directory=await fs.mkdtemp(path.join(os.tmpdir(),'educoder-embedded-test-')),handlers=new Map(),windows=[],singles=[],log=[],locks=[];
  class Window extends EventEmitter{
    constructor(){super();windows.push(this);this.webContents=new EventEmitter();this.webContents.mainFrame={url:'http://127.0.0.1:51002/'};
      this.webContents.getURL=()=>this.webContents.mainFrame.url;this.webContents.send=(name,state)=>log.push(['event',name,state]);this.webContents.setWindowOpenHandler=()=>{};}
    restore(){}show(){}focus(){}setMenuBarVisibility(){}async loadFile(){}destroy(){this.destroyed=true;this.emit('closed');}isDestroyed(){return !!this.destroyed;}
  }
  const main=new Window(),event={sender:main.webContents,senderFrame:main.webContents.mainFrame},dataDir=path.join(directory,'EducoderManualVideoPlayer');
  const positions=new PositionStore({directory:path.join(dataDir,'positions')}),queueStore=new PersonalQueueStore(path.join(dataDir,'personal-temporary-queue.json'));
  let launches=0;
  const context={pages:()=>[],close:async()=>{},newPage:async()=>({isClosed:()=>false,url:()=>courseUrl,goto:async()=>{},close:async()=>{},bringToFront:async()=>{}})};
  const root=coldRoot?createController({initialInventory:inventory,launch:async()=>{launches++;return {context,page:{isClosed:()=>false}};},makeCourse:()=>({})})
    :{getStatus:()=>({phase:'inventory-complete'}),getInventory:()=>inventory,isTaskActive:()=>false,getManualSession:async()=>({context})};
  const setViewingSession=root.setViewingSession?.bind(root);root.setViewingSession=state=>{setViewingSession?.(state);locks.push(state);};
  if(saved)await queueStore.create({...resolvePersonalQueue(inventory,[selections[1]]),mode:'single'});
  const manager=registerManualVideoDesktop({app:{getPath:()=>directory,getVersion:()=> '0.1.12',isPackaged:false},ipcMain:{handle:(name,fn)=>handlers.set(name,fn),removeHandler:name=>handlers.delete(name)},BrowserWindow:Window,window:main,getRuntime:()=>({origin:'http://127.0.0.1:51002',controller:root}),
    controllerFactory:options=>{
      const child=new SingleController({...options,controlsFactory:()=>({setPlaying:async playing=>{log.push([child.target.index,playing?'play':'pause']);child.value.paused=!playing;if(playing)child.value.currentTime+=.1;},muteAvailable:async()=>true,rates:async()=>[1,1.5,2],setMuted:async muted=>{child.value.muted=muted;},setRate:async rate=>{child.value.playbackRate=rate;}})});
      const init=child.init.bind(child);child.init=async()=>{await init();clearTimeout(child.timer);await child.ticking;};
      child.selectCard=async()=>{child.percent=child.officialPercent??0;return {locator:()=>({click:async()=>{}})};};
      child.openVideo=async()=>{log.push([child.target.index,'open']);await openWait;child.checkOperation();await child.openOfficial();child.value={currentTime:initialTime,duration:100,paused:true,ended:false,playbackRate:1,readyState:4,muted:false,volume:.4};
        child.boundPlayerUrl='https://www.educoder.net/video_info?video_id=synthetic-'+child.target.index;let closed=false;
        child.player={isClosed:()=>closed,url:()=>child.boundPlayerUrl,close:async()=>{closed=true;log.push([child.target.index,'close']);},bringToFront:async()=>{},locator:selector=>selector==='body'?{innerText:async()=> '暂无检查点'}:{evaluate:async()=>({...child.value})}};
        child.ownedPlayer=child.player;
        let listClosed=false;child.page={isClosed:()=>listClosed,url:()=>courseUrl,close:async()=>{listClosed=true;},bringToFront:async()=>{}};child.context={pages:()=>[child.page,child.player]};child.verifiedPlayer=true;child.touched=false;child.stage='paused';await child.sample();await child.applyPlaybackOptions();};
      child.native=async(action,pid,seconds)=>{log.push([child.target.index,'native',seconds]);if(restoreFails)throw new Error(typeof restoreFails==='string'?restoreFails:'RESTORE_REFUSED');child.value.currentTime=seconds;};
      singles.push(child);return child;
    }});
  t.after(async()=>{await manager.close().catch(()=>{});await root.shutdown?.();assert.equal(path.dirname(directory).toLowerCase(),os.tmpdir().toLowerCase());await fs.rm(directory,{recursive:true,force:true});});
  const call=(name,...args)=>{const fn=handlers.get('local-manual-video:'+name);assert.equal(typeof fn,'function','missing embedded IPC '+name);return fn(event,...args);};
  const start=(patch={})=>call('start',{mode:'single',courseUrl,selections:[selections[0]],fromBeginning:false,resumeSaved:false,...patch});
  return {directory,main,event,handlers,windows,singles,log,locks,positions,queueStore,call,start,manager,root,get launches(){return launches;}};
}
async function saveObserved(f,index=0,{position=5,prefix=5,ranges=null}={}){
  const target=resolveScannedSelection(snapshot,selections[index]),record=await f.positions.load(target);
  await f.positions.save(record,{...freshLedger(target),duration:100,position,watchedPrefix:prefix,...(ranges?{watchedRanges:ranges}:{})},null);
}

test('embedded start restores actual Single then plays, creates no helper window, and pause retains the session lock',async t=>{
  const f=await fixture(t);await saveObserved(f);const state=await f.start();
  assert.equal(state.active,true);assert.equal(state.embedded,true);assert.equal(state.viewerOpen,false);assert.equal(f.windows.length,1);
  assert.deepEqual(state.selection,selections[0]);assert.equal(state.stage,'playing');assert.equal(state.media.paused,false);
  assert.deepEqual(f.log.filter(item=>typeof item[0]==='number').map(item=>item.slice(1)),[['open'],['native',5],['play']]);
  const paused=await f.call('action','pause');assert.equal(paused.active,true);assert.equal(paused.queue.active,false);assert.equal(paused.media.paused,true);
  assert.equal(f.locks.at(-1).active,true);const resumed=await f.call('action','continue');assert.equal(resumed.media.paused,false);
  assert.equal(f.log.filter(item=>item[1]==='native').length,1,'continue a live paused player must not seek again');
  await f.call('finish');assert.equal((await f.call('status')).active,false);assert.equal(f.locks.at(-1).active,false);
});

test('cold settings and target-position lookup share one source and never create empty position files',async t=>{
  const f=await fixture(t);assert.equal((await f.call('position',selections[0])).seconds,0);await assert.rejects(fs.access(f.positions.directory));
  await f.call('options',{autoMute:true,speedEnabled:true,speed:1.5});assert.deepEqual(await f.call('playback-options'),{autoMute:true,speedEnabled:true,speed:1.5});
  await saveObserved(f,1,{position:9,prefix:9});const bytes=await fs.readFile(f.positions.file(resolveScannedSelection(snapshot,selections[1])));
  assert.deepEqual(await f.call('position',selections[1]),{seconds:9,selection:selections[1]});assert.equal((await f.call('position',selections[0])).seconds,0);
  assert.deepEqual(await fs.readFile(f.positions.file(resolveScannedSelection(snapshot,selections[1]))),bytes);
  const state=await f.start();assert.deepEqual(state.playbackOptions,{autoMute:true,speedEnabled:true,speed:1.5});assert.equal(state.media.playbackRate,1.5);assert.equal(state.media.muted,true);
});
test('a paused live settings save failure is reported and retry clears its error without playing',async t=>{
  const f=await fixture(t);await f.start();await f.call('action','pause');const child=f.singles[0],set=child.playbackStore.set.bind(child.playbackStore);let attempts=0;
  child.playbackStore.set=async patch=>{attempts++;if(attempts===1)throw Object.assign(new Error('synthetic settings I/O'),{code:'EIO'});return set(patch);};
  const plays=f.log.filter(item=>item[1]==='play').length;
  await assert.rejects(f.call('options',{autoMute:true}),/EIO/);assert.equal((await f.call('status')).playbackOptions.autoMute,false);
  const recovered=await f.call('options',{autoMute:true});assert.equal(recovered.playbackOptions.autoMute,true);assert.equal(recovered.actionError,null);assert.equal(recovered.media.paused,true);
  assert.equal(f.log.filter(item=>item[1]==='play').length,plays);assert.equal(recovered.active,true);
});

test('an unavailable saved restore allows normal official play but an explicit beginning failure keeps the previous batch and position',async t=>{
  for(const fromBeginning of [false,true]){
    const f=await fixture(t,{saved:true,restoreFails:true,initialTime:8});await saveObserved(f);const before=await fs.readFile(f.queueStore.file);
    const positionFile=f.positions.file(resolveScannedSelection(snapshot,selections[0])),position=await fs.readFile(positionFile);
    if(fromBeginning){
      await assert.rejects(f.start({fromBeginning}),/RESTORE_REFUSED/);assert.equal(f.log.some(item=>item[1]==='play'),false);
      assert.deepEqual(await fs.readFile(f.queueStore.file),before);assert.equal((await f.call('status')).active,false);
    }else{
      const state=await f.start({fromBeginning});assert.equal(state.restoreSkipped,true);assert.ok(state.restoreHint);
      assert.equal(state.actionError,null);assert.equal(state.queue.active,true);assert.equal(state.media.paused,false);
      assert.ok(state.media.currentTime>8,'normal official playback retains its actual position');
    }
    assert.deepEqual(await fs.readFile(positionFile),position);assert.equal(f.windows.length,1);
  }
});

test('cancel during embedded preparation cannot produce a late play or replace the saved batch',async t=>{
  let release;const wait=new Promise(resolve=>{release=resolve;}),f=await fixture(t,{saved:true,openWait:wait});const before=await fs.readFile(f.queueStore.file);
  const pending=f.start();pending.catch(()=>{});while(!f.log.some(item=>item[1]==='open'))await delay(1);
  const finished=f.call('finish');release();await assert.rejects(pending);await finished;
  assert.equal(f.log.some(item=>item[1]==='play'),false);assert.deepEqual(await fs.readFile(f.queueStore.file),before);assert.equal((await f.call('status')).active,false);
});
test('cancel after embedded play commit rolls back the old batch, while an external newer committed file remains locked for explicit discard',async t=>{
  for(const external of [false,true]){
    const f=await fixture(t,{saved:true}),before=await fs.readFile(f.queueStore.file),stage=PersonalQueueStore.prototype.stage;
    let release,began;const gate=new Promise(resolve=>{release=resolve;}),entered=new Promise(resolve=>{began=resolve;});let newer;
    PersonalQueueStore.prototype.stage=async function(...args){const result=await stage.apply(this,args);if(this.file===f.queueStore.file){const commit=result.commit;result.commit=async options=>{await commit(options);began();await gate;};}return result;};
    try{
      const starting=f.start();starting.catch(()=>{});await entered;
      assert.equal(f.singles[0].value.paused,false);assert.equal((await f.queueStore.read()).selections[0].index,0);
      if(external){const latest=await f.queueStore.read();latest.revision++;latest.reason='synthetic-external-after-start';newer=Buffer.from(JSON.stringify(latest));await fs.writeFile(f.queueStore.file,newer);}
      const finishing=f.call('finish');finishing.catch(()=>{});release();await assert.rejects(starting,/CLOSING/);
      if(external){await assert.rejects(finishing,/QUEUE_RECORD_CHANGED/);assert.equal((await f.call('status')).active,true);assert.equal((await f.call('status')).discardAvailable,true);await f.call('discard-and-finish',true);}
      else await finishing;
      assert.deepEqual(await fs.readFile(f.queueStore.file),external?newer:before);assert.equal((await f.call('status')).active,false);assert.equal(f.singles[0].player.isClosed(),true);
    }finally{release();PersonalQueueStore.prototype.stage=stage;}
  }
});
test('a canceled start retains its rollback after real rollback I/O failure and retries it before unlocking',async t=>{
  const f=await fixture(t,{saved:true}),before=await fs.readFile(f.queueStore.file),stage=PersonalQueueStore.prototype.stage,rename=fs.rename;
  let release,began,available=false,attempts=0;const gate=new Promise(resolve=>{release=resolve;}),entered=new Promise(resolve=>{began=resolve;});
  PersonalQueueStore.prototype.stage=async function(...args){const result=await stage.apply(this,args);if(this.file===f.queueStore.file){const commit=result.commit;result.commit=async options=>{await commit(options);began();await gate;};}return result;};
  fs.rename=async(from,to)=>{if(to===f.queueStore.file&&(await fs.readFile(from)).equals(before)){attempts++;if(!available)throw Object.assign(new Error('synthetic rollback I/O'),{code:'EBUSY'});}return rename(from,to);};
  try{
    const starting=f.start();starting.catch(()=>{});await entered;const finishing=f.call('finish');finishing.catch(()=>{});release();
    await assert.rejects(starting,/CLOSING/);await assert.rejects(finishing,error=>error.code==='EBUSY');
    const held=await f.call('status');assert.equal(held.active,true);assert.equal(held.opening,false);assert.equal(held.closing,false);assert.equal(held.discardAvailable,false);assert.equal(f.locks.at(-1).active,true);
    assert.equal(f.singles[0].player.isClosed(),true);assert.notDeepEqual(await fs.readFile(f.queueStore.file),before);
    available=true;await f.call('finish');assert.ok(attempts>=2);assert.deepEqual(await fs.readFile(f.queueStore.file),before);assert.equal((await f.call('status')).active,false);
  }finally{release();fs.rename=rename;PersonalQueueStore.prototype.stage=stage;}
});
test('a rollback-only external conflict permits the first explicit discard without asking the disposed queue to discard again',async t=>{
  const f=await fixture(t,{saved:true}),stage=PersonalQueueStore.prototype.stage;let newer,rollbacks=0;
  PersonalQueueStore.prototype.stage=async function(...args){const result=await stage.apply(this,args);if(this.file===f.queueStore.file){const commit=result.commit,rollback=result.rollback;
      result.commit=async options=>{await commit(options);throw new Error('QUEUE_OPERATION_TIMEOUT');};
      result.rollback=async()=>{rollbacks++;if(!newer){const latest=await f.queueStore.read();latest.revision++;latest.reason='synthetic-external-after-disposal';newer=Buffer.from(JSON.stringify(latest));await fs.writeFile(f.queueStore.file,newer);}return rollback();};
    }return result;};
  try{
    await assert.rejects(f.start(),/QUEUE_OPERATION_TIMEOUT/);const held=await f.call('status');assert.equal(held.active,true);assert.equal(held.discardAvailable,true);assert.equal(held.queue.reason,'QUEUE_STOPPED');
    assert.equal(f.singles[0].player.isClosed(),true);await f.call('discard-and-finish',true);
    assert.equal(rollbacks,1);assert.equal((await f.call('status')).active,false);assert.deepEqual(await fs.readFile(f.queueStore.file),newer);
  }finally{PersonalQueueStore.prototype.stage=stage;}
});
test('failed position cleanup can finish after an independently completed rollback or explicitly discard a newer rollback conflict',async t=>{
  for(const external of [false,true]){
    const f=await fixture(t,{saved:true}),before=await fs.readFile(f.queueStore.file),stage=PersonalQueueStore.prototype.stage;await saveObserved(f);
    let release,began,available=false,newer;const gate=new Promise(resolve=>{release=resolve;}),entered=new Promise(resolve=>{began=resolve;});
    PersonalQueueStore.prototype.stage=async function(...args){const result=await stage.apply(this,args);if(this.file===f.queueStore.file){const commit=result.commit,rollback=result.rollback;
        result.commit=async options=>{await commit(options);began();await gate;};
        result.rollback=async()=>{if(external&&!newer){const latest=await f.queueStore.read();latest.revision++;latest.reason='synthetic-external-with-position-io';newer=Buffer.from(JSON.stringify(latest));await fs.writeFile(f.queueStore.file,newer);}return rollback();};
      }return result;};
    try{
      const starting=f.start();starting.catch(()=>{});await entered;const child=f.singles[0],save=child.positionStore.save.bind(child.positionStore);
      child.ledger=new ObservationLedger({...freshLedger(child.target),duration:100,position:6,watchedPrefix:6});child.value.currentTime=6;
      child.positionStore.save=async(...args)=>{if(!available)throw Object.assign(new Error('synthetic position cleanup I/O'),{code:'EBUSY'});return save(...args);};
      const finishing=f.call('finish');finishing.catch(()=>{});release();await assert.rejects(starting,/CLOSING/);await assert.rejects(finishing);
      const held=await f.call('status');assert.equal(held.active,true);assert.equal(held.discardAvailable,external);assert.equal(held.actionsAvailable,false);assert.equal(held.queue.phase,'stopped');assert.equal(held.queue.active,false);
      assert.deepEqual(await fs.readFile(f.queueStore.file),external?newer:before);assert.equal((await f.positions.load(child.target)).observation.position,5);
      if(external)await f.call('discard-and-finish',true);else{available=true;await f.call('finish');}
      assert.equal((await f.call('status')).active,false);assert.deepEqual(await fs.readFile(f.queueStore.file),external?newer:before);
      assert.equal((await f.positions.load(child.target)).observation.position,external?5:6);
    }finally{release();PersonalQueueStore.prototype.stage=stage;}
  }
});

test('saved continuation validates its complete plan and cursor and explicitly restores its current actual Single',async t=>{
  const f=await fixture(t),plan=resolvePersonalQueue(snapshot,selections),saved=await f.queueStore.create({...plan,mode:'continuous'});saved.cursor=1;saved.phase='paused';await f.queueStore.save(saved);
  await saveObserved(f,1,{position:6,prefix:6});const before=await fs.readFile(f.queueStore.file);
  await assert.rejects(f.start({mode:'continuous',selections:[selections[1]],resumeSaved:true}),/QUEUE_RECORD_CHANGED/);assert.deepEqual(await fs.readFile(f.queueStore.file),before);
  const state=await f.start({mode:'continuous',selections,resumeSaved:true});assert.equal(state.queue.cursor,1);assert.deepEqual(state.selection,selections[1]);
  assert.equal(state.queue.selections.length,2);assert.equal(f.log.filter(item=>item[1]==='native')[0][2],6);assert.equal((await f.queueStore.read()).id,saved.id);
});
test('a fully cold root with saved snapshot and batch opens its official session only on explicit saved continuation',async t=>{
  const f=await fixture(t,{saved:true,coldRoot:true});await saveObserved(f,1,{position:6,prefix:6});
  assert.equal(f.root.getStatus().officialSessionOpen,false);assert.equal(f.launches,0);
  await f.call('status');await f.call('position',selections[1]);await f.handlers.get('personal-queue:summary')(f.event);
  assert.equal(f.launches,0);assert.equal((await f.call('status')).active,false);
  const state=await f.start({selections:[selections[1]],resumeSaved:true});
  assert.equal(f.launches,1);assert.equal(state.media.paused,false);assert.equal(state.media.currentTime>6,true);assert.equal(f.windows.length,1);
  assert.deepEqual(f.log.filter(item=>typeof item[0]==='number').map(item=>item.slice(1)),[['open'],['native',6],['play']]);
  await assert.rejects(f.root.openBrowser(),error=>error.code==='VIEWING_ACTIVE');
});

test('explicit single restores a noncontiguous observed range while continuous rejects it without replacing saved metadata',async t=>{
  for(const mode of ['single','continuous']){
    const f=await fixture(t,{saved:true});await saveObserved(f,0,{position:51,prefix:0,ranges:[[50,51]]});const before=await fs.readFile(f.queueStore.file);
    if(mode==='single'){const state=await f.start();assert.equal(state.media.paused,false);assert.equal(state.media.currentTime>51,true);assert.equal(state.confirmedWatchedPrefix,0);}
    else {await assert.rejects(f.start({mode,selections}),/QUEUE_UNWATCHED_GAP/);assert.equal(f.log.some(item=>item[1]==='play'),false);assert.deepEqual(await fs.readFile(f.queueStore.file),before);}
  }
});

test('main playback IPC rejects foreign frames, extra arguments and unscanned identities before creating a controller',async t=>{
  const f=await fixture(t);const handler=f.handlers.get('local-manual-video:start');assert.equal(typeof handler,'function');
  const request={mode:'single',courseUrl,selections:[selections[0]],resumeSaved:false,fromBeginning:false};
  await assert.rejects(Promise.resolve().then(()=>handler({...f.event,sender:{}},request)));
  await assert.rejects(Promise.resolve().then(()=>handler(f.event,request,'extra')));
  await assert.rejects(f.start({selections:[{...selections[0],cardIdentity:'https://www.educoder.net/images/changed.png'}]}));
  await assert.rejects(f.start({mode:'single',selections}));assert.equal(f.singles.length,0);
});

test('duplicate embedded starts share one prepare/play and status excludes internal controller fields',async t=>{
  const f=await fixture(t);const results=await Promise.all([f.start(),f.start(),f.start()]);assert.equal(f.singles.length,1);assert.equal(f.log.filter(item=>item[1]==='play').length,1);
  for(const result of results){assert.equal(result.opening,false);assert.equal(result.active,true);}
  const child=f.singles[0],status=child.status.bind(child);child.status=()=>({...status(),privatePlayerUrl:'https://private.invalid/?token=synthetic'});
  assert.equal(JSON.stringify(await f.call('status')).includes('private.invalid'),false);
  await assert.rejects(f.start({selections:[selections[1]]}),/请先/);
});

test('from beginning uses the official native zero control while a closed-player continue explicitly restores saved observed position',async t=>{
  const f=await fixture(t,{initialTime:8});await saveObserved(f);await f.start({fromBeginning:true});
  assert.deepEqual(f.log.filter(item=>item[1]==='native').map(item=>item[2]),[0]);assert.equal(f.singles[0].value.currentTime<1,true);
  await f.call('action','pause');
  const child=f.singles[0];child.ledger=new ObservationLedger({...freshLedger(child.target),duration:100,position:5,watchedPrefix:5});await child.persist();await child.player.close();
  const resumed=await f.call('action','continue');assert.equal(resumed.media.paused,false);assert.equal(resumed.media.currentTime>5,true);
  assert.deepEqual(f.log.filter(item=>item[1]==='native').map(item=>item[2]),[0,5]);
});

test('embedded finish retries actual position I/O and queue I/O failures before releasing its lock',async t=>{
  for(const failing of ['position','queue']){
    const f=await fixture(t);await f.start();const child=f.singles[0];child.ledger=new ObservationLedger({...freshLedger(child.target),duration:100,position:5,watchedPrefix:5});child.value.currentTime=5;
    let attempts=0;
    if(failing==='position'){
      const save=child.positionStore.save.bind(child.positionStore);child.positionStore.save=async(...args)=>{attempts++;if(attempts===1)throw Object.assign(new Error('synthetic transient I/O'),{code:'EBUSY'});return save(...args);};
    }else{
      const save=PersonalQueueStore.prototype.save;
      PersonalQueueStore.prototype.save=async function(...args){if(this.file===f.queueStore.file){attempts++;if(attempts===1)throw Object.assign(new Error('synthetic transient queue I/O'),{code:'EBUSY'});}return save.apply(this,args);};
      t.after(()=>{PersonalQueueStore.prototype.save=save;});
    }
    await assert.rejects(f.call('finish'),/synthetic transient/);const held=await f.call('status');assert.equal(held.active,true);assert.equal(held.discardAvailable,true);assert.equal(f.locks.at(-1).active,true);
    await assert.rejects(Promise.resolve().then(()=>f.call('discard-and-finish',false)),/INVALID_ACTION/);assert.equal((await f.call('status')).active,true);
    await f.call('finish');assert.equal((await f.call('status')).active,false);assert.ok(attempts>=2);assert.equal((await f.queueStore.read()).phase,'stopped');
  }
});

test('persistent position or queue I/O requires trusted confirmation after cleanup and preserves disk bytes',async t=>{
  for(const failing of ['position','queue']){
    const f=await fixture(t);await f.start();const child=f.singles[0];
    const positionBefore=await fs.readFile(f.positions.file(child.target));const queueBefore=await fs.readFile(f.queueStore.file);
    child.ledger=new ObservationLedger({...freshLedger(child.target),duration:100,position:5,watchedPrefix:5});child.value.currentTime=5;
    let writes=0;
    if(failing==='position')child.positionStore.save=async()=>{writes++;throw Object.assign(new Error('synthetic persistent I/O'),{code:'ENOSPC'});};
    else{const save=PersonalQueueStore.prototype.save;PersonalQueueStore.prototype.save=async function(...args){if(this.file===f.queueStore.file){writes++;throw Object.assign(new Error('synthetic persistent I/O'),{code:'EACCES'});}return save.apply(this,args);};t.after(()=>{PersonalQueueStore.prototype.save=save;});}
    await assert.rejects(f.call('finish'),/synthetic persistent I\/O/);
    const held=await f.call('status');assert.equal(held.discardAvailable,true);assert.equal(held.closing,false);assert.equal(child.player.isClosed(),true);assert.equal(child.page.isClosed(),true);
    for(const confirmation of [undefined,false,'true'])await assert.rejects(Promise.resolve().then(()=>f.call('discard-and-finish',confirmation)),/INVALID_ACTION/);
    const before=writes;await f.call('discard-and-finish',true);assert.equal(writes,before);assert.equal((await f.call('status')).active,false);
    assert.deepEqual(await fs.readFile(f.queueStore.file),queueBefore);
    if(failing==='position')assert.deepEqual(await fs.readFile(f.positions.file(child.target)),positionBefore);
  }
});

test('embedded conflict keeps the main session until explicit discard and never overwrites the newer position',async t=>{
  const f=await fixture(t);await f.start();const child=f.singles[0],record=await f.positions.load(child.target);
  await f.positions.save(record,{...freshLedger(child.target),duration:100,position:9,watchedPrefix:9},null);const bytes=await fs.readFile(f.positions.file(child.target));
  child.ledger=new ObservationLedger({...freshLedger(child.target),duration:100,position:5,watchedPrefix:5});child.value.currentTime=5;
  await assert.rejects(f.call('finish'),/RECORD_CHANGED/);const held=await f.call('status');assert.equal(held.active,true);assert.equal(held.discardAvailable,true);assert.equal(f.windows.length,1);
  await assert.rejects(f.start({selections:[selections[1]]}),/请先/);await f.call('discard-and-finish',true);
  assert.equal((await f.call('status')).active,false);assert.deepEqual(await fs.readFile(f.positions.file(child.target)),bytes);
});

test('embedded continuous advancement publishes the entire current card identity and starts the next through official beginning',async t=>{
  const f=await fixture(t,{initialTime:8});await f.start({mode:'continuous',selections,fromBeginning:true});const child=f.singles[0];
  child.ledger=new ObservationLedger({...freshLedger(child.target),duration:100,position:100,watchedPrefix:100});child.value.currentTime=100;child.value.ended=true;child.value.paused=true;child.officialPercent=100;
  const deadline=Date.now()+4000;while((await f.call('status')).queue.cursor!==1&&Date.now()<deadline)await delay(20);
  while((await f.call('status')).queue.phase!=='playing'&&Date.now()<deadline)await delay(20);
  const state=await f.call('status');assert.deepEqual(state.selection,selections[1]);assert.equal(state.nextSelection,null);assert.equal(state.queue.cursor,1);assert.equal(state.media.paused,false);
  assert.deepEqual(f.log.filter(item=>item[1]==='native').map(item=>[item[0],item[2]]),[[0,0],[1,0]]);assert.equal(f.windows.length,1);
});

test('013 natural confirmation saves and releases the actual session with a completed summary',async t=>{
  const f=await fixture(t);await f.start();ended(f.singles[0]);
  const state=await until(()=>f.call('status'),value=>value.active===false);
  assert.equal(state.completed,true);assert.equal(state.completionPending,false);assert.equal(state.stage,'completed');assert.deepEqual(state.selection,selections[0]);
  assert.equal(state.queue.phase,'completed');assert.equal(state.queue.cursor,1);assert.equal(f.locks.at(-1).active,false);assert.equal(f.singles[0].player.isClosed(),true);
  assert.equal((await f.queueStore.read()).phase,'completed');
  const closed=f.log.filter(item=>item[1]==='local-manual-video:closed').at(-1)[2];assert.equal(closed.completed,true);assert.deepEqual(closed.selection,selections[0]);
});

test('013 completion save failure remains active and continue only retries the guarded save without playback',async t=>{
  const f=await fixture(t);await f.start();const save=PersonalQueueStore.prototype.save;let available=false,attempts=0;
  PersonalQueueStore.prototype.save=async function(record){if(this.file===f.queueStore.file&&record.phase==='completed'){attempts++;if(!available)throw Object.assign(new Error('synthetic completion I/O'),{code:'EBUSY'});}return save.call(this,record);};
  try{
    ended(f.singles[0]);const held=await until(()=>f.call('status'),value=>value.queue?.reason==='QUEUE_SAVE_FAILED');
    assert.equal(held.active,true);assert.equal(held.completed,false);assert.equal(held.completionPending,true);assert.equal(f.locks.at(-1).active,true);
    const plays=f.log.filter(item=>item[1]==='play').length;available=true;const recovered=await f.call('action','continue');
    assert.equal(recovered.active,false);assert.equal(recovered.completed,true);assert.equal(recovered.completionPending,false);assert.ok(attempts>=2);
    assert.equal(f.log.filter(item=>item[1]==='play').length,plays);assert.equal((await f.queueStore.read()).phase,'completed');
  }finally{PersonalQueueStore.prototype.save=save;}
});

test('013 explicit active replacement saves the original observed position before starting the selected new target',async t=>{
  const f=await fixture(t);await f.start();const child=f.singles[0];child.ledger=new ObservationLedger({...freshLedger(child.target),duration:100,position:7,watchedPrefix:7});child.value.currentTime=7;
  const replaced=await f.start({selections:[selections[1]],replaceCurrent:true});
  assert.deepEqual(replaced.selection,selections[1]);assert.equal(replaced.media.paused,false);assert.equal(replaced.replacing,false);
  assert.equal((await f.positions.load(child.target)).observation.position,7);assert.equal(child.player.isClosed(),true);
  assert.ok(f.log.findIndex(item=>item[0]===0&&item[1]==='close')<f.log.findIndex(item=>item[0]===1&&item[1]==='open'));
  assert.ok(f.locks.every(value=>value.active||!value.replacing),'replacement may never publish an unlocked transaction');
});

test('013 failed original save forbids replacement and a later explicit retry recovers the same record',async t=>{
  const f=await fixture(t);await f.start();const child=f.singles[0],save=child.positionStore.save.bind(child.positionStore);let available=false;
  child.ledger=new ObservationLedger({...freshLedger(child.target),duration:100,position:7,watchedPrefix:7});child.value.currentTime=7;
  child.positionStore.save=async(...args)=>{if(!available)throw Object.assign(new Error('synthetic original-save I/O'),{code:'EBUSY'});return save(...args);};
  await assert.rejects(f.start({selections:[selections[1]],replaceCurrent:true}),/synthetic original-save/);
  assert.equal(f.singles.length,1);assert.equal((await f.call('status')).active,true);assert.equal((await f.queueStore.read()).selections[0].index,0);
  available=true;const recovered=await f.start({selections:[selections[1]],replaceCurrent:true});assert.deepEqual(recovered.selection,selections[1]);assert.equal((await f.positions.load(child.target)).observation.position,7);
});

test('013 failed new start retains the last successfully saved original batch',async t=>{
  const f=await fixture(t,{restoreFails:'OFFICIAL_PROGRESS_CONTROL_AMBIGUOUS'});await f.start();await saveObserved(f,1);let savedOld;
  const save=PersonalQueueStore.prototype.save;PersonalQueueStore.prototype.save=async function(record){const result=await save.call(this,record);if(this.file===f.queueStore.file&&record.selections[0].index===0&&record.phase==='stopped')savedOld=await fs.readFile(this.file);return result;};
  try{await assert.rejects(f.start({selections:[selections[1]],replaceCurrent:true}),/OFFICIAL_PROGRESS_CONTROL_AMBIGUOUS/);assert.ok(savedOld);assert.deepEqual(await fs.readFile(f.queueStore.file),savedOld);assert.equal((await f.call('status')).active,false);assert.equal(f.log.some(item=>item[0]===1&&item[1]==='play'),false);}
  finally{PersonalQueueStore.prototype.save=save;}
});

test('013 duplicate replacement shares its transaction and stop or close cancels its original-save gap',async t=>{
  for(const cancel of ['finish','close','none']){
    const f=await fixture(t);await f.start();const child=f.singles[0],dispose=child.dispose.bind(child);let release,began;const gate=new Promise(resolve=>release=resolve),entered=new Promise(resolve=>began=resolve);
    child.dispose=async options=>{began();await gate;return dispose(options);};
    const request={selections:[selections[1]],replaceCurrent:true},first=f.start(request),duplicate=f.start(request);first.catch(()=>{});duplicate.catch(()=>{});
    try{
      const waiting=await until(()=>f.call('status'),state=>state.replacing===true,1000);await entered;assert.equal(waiting.active,true);assert.equal(waiting.opening,true);
      let stopping;if(cancel==='finish')stopping=f.call('finish');else if(cancel==='close')stopping=f.manager.close();release();
      if(stopping){await stopping;await assert.rejects(first,/CLOSING/);await assert.rejects(duplicate,/CLOSING/);assert.equal(f.singles.length,1);assert.equal((await f.call('status')).active,false);assert.equal((await f.queueStore.read()).selections[0].index,0);}
      else{const results=await Promise.all([first,duplicate]);assert.deepEqual(results[0].selection,selections[1]);assert.deepEqual(results[1].selection,selections[1]);assert.equal(f.singles.length,2);}
    }finally{release();}
  }
});

test('013 replacement record conflict never opens the new target or overwrites the newer position',async t=>{
  const f=await fixture(t);await f.start();const child=f.singles[0],newer=await f.positions.load(child.target);await f.positions.save(newer,{...freshLedger(child.target),duration:100,position:9,watchedPrefix:9},null);
  const bytes=await fs.readFile(f.positions.file(child.target));child.ledger=new ObservationLedger({...freshLedger(child.target),duration:100,position:5,watchedPrefix:5});child.value.currentTime=5;
  await assert.rejects(f.start({selections:[selections[1]],replaceCurrent:true}),/RECORD_CHANGED/);assert.equal(f.singles.length,1);const held=await f.call('status');assert.equal(held.discardAvailable,true);assert.equal(held.failure.code,'RECORD_CHANGED');
  await f.call('discard-and-finish',true);assert.deepEqual(await fs.readFile(f.positions.file(child.target)),bytes);
});

test('013 failed native start exposes only its safe concrete reason after the child is cleaned up',async t=>{
  const f=await fixture(t,{restoreFails:true,initialTime:8});await saveObserved(f);await assert.rejects(f.start({fromBeginning:true}),/RESTORE_REFUSED/);
  const state=await f.call('status');assert.equal(state.active,false);assert.equal(state.actionError,'RESTORE_REFUSED');assert.equal(state.failure.code,'RESTORE_REFUSED');assert.deepEqual(state.failure.selection,selections[0]);
  assert.match(state.failure.message,/官方控件未恢复/);assert.equal(state.message,state.failure.message);assert.equal(f.log.some(item=>item[1]==='play'),false);
});

test('019 each next video restores its own position or uses explicit safe official playback when restore is unavailable',async t=>{
  for(const refused of [false,true]){
    const f=await fixture(t,{restoreFails:refused});await saveObserved(f,1,{position:6,prefix:6});await f.start({mode:'continuous',selections});ended(f.singles[0]);
    const state=await until(()=>f.call('status'),value=>value.queue?.cursor===1&&value.queue.phase==='playing');
    assert.deepEqual(state.selection,selections[1]);assert.deepEqual(f.log.filter(item=>item[0]===1&&item[1]==='native').map(item=>item[2]),[6]);
    assert.equal(f.log.some(item=>item[0]===1&&item[1]==='play'),true);assert.equal(state.active,true);
    if(refused){assert.equal(state.queue.active,true);assert.equal(state.failure,null);assert.equal(state.restoreSkipped,true);assert.ok(state.restoreHint);assert.ok(state.media.currentTime<6);assert.equal((await f.positions.load(f.singles[1].target)).observation.position,6);}
    else assert.ok(state.media.currentTime>6);
  }
});

test('013 unknown native errors never expose file paths, credentials or raw codes in public state',async t=>{
  const f=await fixture(t);await saveObserved(f);const init=SingleController.prototype.init;
  SingleController.prototype.init=async function(){await init.call(this);this.native=async()=>{throw Object.assign(new Error('C:\\private\\token=secret-value'),{code:'PRIVATE_SECRET_CODE'});};};
  try{await assert.rejects(f.start(),/OPERATION_FAILED/);const state=await f.call('status');assert.equal(state.failure.code,'OPERATION_FAILED');assert.equal(/private|secret-value|PRIVATE_SECRET_CODE/.test(JSON.stringify(state)),false);assert.equal(f.log.some(item=>item[1]==='play'),false);}
  finally{SingleController.prototype.init=init;}
});

test('013 stop in the published gap after original save cancels a not-yet-started replacement',async t=>{
  const f=await fixture(t);await f.start();const child=f.singles[0];child.ledger=new ObservationLedger({...freshLedger(child.target),duration:100,position:7,watchedPrefix:7});child.value.currentTime=7;
  const publish=f.root.setViewingSession;let cancel,seen=false;
  f.root.setViewingSession=state=>{publish(state);if(!seen&&state.replacing&&!state.closing&&!state.selection){seen=true;cancel=f.call('finish');}};
  await assert.rejects(f.start({selections:[selections[1]],replaceCurrent:true}),/CLOSING/);await cancel;
  assert.equal(seen,true);assert.equal(f.singles.length,1);assert.equal((await f.call('status')).active,false);
  assert.equal((await f.positions.load(child.target)).observation.position,7);assert.equal((await f.queueStore.read()).selections[0].index,0);
});

test('013 natural completion keeps a newer external queue record and requires explicit discard',async t=>{
  const f=await fixture(t);await f.start();const save=PersonalQueueStore.prototype.save;let newer;
  PersonalQueueStore.prototype.save=async function(record){const result=await save.call(this,record);if(this.file===f.queueStore.file&&record.phase==='completed'&&!newer){const latest=await this.read();latest.revision++;latest.reason='synthetic-newer-completion';newer=Buffer.from(JSON.stringify(latest));await fs.writeFile(this.file,newer);}return result;};
  try{
    ended(f.singles[0]);const held=await until(()=>f.call('status'),value=>value.failure?.code==='QUEUE_RECORD_CHANGED'&&!value.closing);
    assert.equal(held.active,true);assert.equal(held.completed,false);assert.equal(held.completionPending,true);assert.equal(held.discardAvailable,true);
    await assert.rejects(f.call('action','continue'),/QUEUE_RECORD_CHANGED/);assert.deepEqual(await fs.readFile(f.queueStore.file),newer);
    await f.call('discard-and-finish',true);assert.equal((await f.call('status')).completed,false);assert.equal((await f.call('status')).active,false);assert.deepEqual(await fs.readFile(f.queueStore.file),newer);
  }finally{PersonalQueueStore.prototype.save=save;}
});

for(const stop of [false,true])test('013 current index and next selection stay with the actual Single during delayed disposal'+(stop?' and stop':' through advancement'),async t=>{
  const inventory={...snapshot,items:[...snapshot.items,{page:1,index:2,title:'合成视频C',cardIdentity:'https://www.educoder.net/images/synthetic-c.png',progress:0}]};
  const picks=inventory.items.map(({page,index,title,cardIdentity})=>({courseUrl,page,index,title,cardIdentity}));
  const f=await fixture(t,{inventory});await f.start({mode:'continuous',selections:picks,fromBeginning:true});const child=f.singles[0],persist=child.persist.bind(child);
  let release,entered;const gate=new Promise(resolve=>release=resolve),saving=new Promise(resolve=>entered=resolve);
  child.persist=async(...args)=>{if(child.disposed){entered();await gate;}return persist(...args);};
  try{
    ended(child);await saving;
    const waiting=await f.call('status');assert.equal(waiting.queue.cursor,0);assert.equal(waiting.queue.phase,'switching');assert.equal(child.player.isClosed(),false);
    assert.deepEqual(waiting.selection,picks[0]);assert.equal(waiting.percent,100);assert.deepEqual(waiting.nextSelection,picks[1]);assert.equal(waiting.queue.currentIndex,0);
    if(stop){const finishing=f.call('finish');release();await finishing;assert.equal(f.singles.length,1);assert.equal((await f.call('status')).active,false);assert.equal((await f.positions.load(child.target)).observation.position,100);}
    else{
      release();const next=await until(()=>f.call('status'),value=>value.selection?.index===1&&value.queue.phase==='playing');
      assert.equal(next.queue.currentIndex,1);assert.deepEqual(next.nextSelection,picks[2]);assert.notEqual(next.percent,100);
      ended(f.singles[1]);await until(()=>f.call('status'),value=>value.selection?.index===2&&value.queue.phase==='playing');ended(f.singles[2]);
      const completed=await until(()=>f.call('status'),value=>value.completed);assert.equal(completed.queue.currentIndex,2);assert.equal(completed.nextSelection,null);assert.deepEqual(completed.selection,picks[2]);
    }
  }finally{release();}
});
