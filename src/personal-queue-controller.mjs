const sleep=(ms,signal)=>new Promise(resolve=>{ if(signal?.aborted)return resolve();
  const timer=setTimeout(done,ms); function done(){clearTimeout(timer);signal?.removeEventListener('abort',done);resolve();} signal?.addEventListener('abort',done,{once:true}); });
export const personalQueueErrors={
  QUEUE_CHECKPOINT:'遇到检查点，队列已暂停。请在官方页面自行处理；本工具不代答。',
  QUEUE_VERIFICATION:'官方要求验证码、安全或身份核验，队列已暂停，请自行处理。',
  QUEUE_PLATFORM_BLOCKED:'官方页面禁止或限制当前操作，队列已暂停，不会绕过。',
  QUEUE_LOGIN_REQUIRED:'官方登录已失效，队列已暂停；请自行登录后再选择继续。',
  QUEUE_UNWATCHED_GAP:'尚有未观看区间，队列已暂停。请从起点或已连续观看的位置播放，不会跳过。',
  QUEUE_NOT_CONFIRMED:'视频已结束，但官方列表尚未确认100%。已限次等待并暂停，不会打开下一条。',
  QUEUE_STALLED:'上次播放没有真实进展，已暂停；可主动继续播放。',
  QUEUE_WEBSITE_PAUSED:'官方播放器已暂停，队列也已暂停；由你决定何时继续。',
  QUEUE_OTHER_PLAYER:'还有另一个官方视频窗口。队列已暂停，请自行关掉其他播放器。',
  QUEUE_RECORD_CHANGED:'队列记录在另一处更新，较新文件已保留。可明确放弃本次未保存位置后返回课堂。',
  PLAY_NOT_STARTED:'官方视频尚未真正开始播放，队列保持暂停。请查看官方窗口，再主动重试。',
  OFFICIAL_PLAY_UNAVAILABLE:'官方播放控件暂不可用，队列保持暂停。请在官方窗口自行确认。',
  QUEUE_SAVE_FAILED:'本机位置尚未保存，队列已暂停；原文件保留，请检查后重试结束观看。',
  QUEUE_OPERATION_TIMEOUT:'官方页面未及时回应，队列已暂停；保留当前位置，不会无限重试。',
  QUEUE_STOPPED:'队列已停止，当前视频和真实位置已保留。',
  LOGIN_REQUIRED:'官方登录已失效，队列已暂停，请自行登录后继续。',
  PLAYER_CHANGED:'官方播放器已切换，队列已暂停，不会操作其他视频。',
  MEDIA_ERROR:'官方播放器报告错误，队列已暂停，真实位置保留。',
  PAGE_LOAD_FAILED:'官方页面加载失败，队列已暂停，请检查连接后再决定继续。',
  LIST_UNAVAILABLE:'官方列表暂不可读，队列已暂停，不会猜测完成或切换。',
  RECORD_CHANGED:'真实位置已在另一处更新，队列已暂停并保留较新记录。',
  SCAN_BUSY:'当前正在扫描或处理另一任务，个人队列已暂停。',
};
function code(error){
  const value=error?.code??error?.message??'QUEUE_ERROR';
  if(error?.name==='TimeoutError'||/net::ERR_|Timeout \d+ms|timed out/i.test(value))return 'PAGE_LOAD_FAILED';
  return value;
}
function recordConflict(error){return ['RECORD_CHANGED','RECORD_INVALID','QUEUE_RECORD_CHANGED','QUEUE_RECORD_INVALID'].includes(code(error));}
export function isPositionSaveIoError(error){return ['EIO','ENOSPC','EACCES','EPERM','EBUSY','EROFS','EMFILE','ENFILE'].includes(error?.code);}
export function isRecoverableQueueError(error){
  const reason=code(error);
  if(['PAGE_LOAD_FAILED','CDN_TIMEOUT','LIST_UNAVAILABLE','MEDIA_NOT_READY','PAGE_RESET',
    'OFFICIAL_PLAY_UNAVAILABLE','OFFICIAL_CONTROLS_UNAVAILABLE','OFFICIAL_PROGRESS_CONTROL_UNAVAILABLE',
    'MEDIA_NETWORK_ERROR','MEDIA_DECODE_ERROR','PLAY_NOT_STARTED'].includes(reason))return true;
  return false;
}
export class PersonalQueueController {
  constructor({store,record,targets,createSingle,onState=()=>{},assertRootIdle=()=>{},pollMs=1000,verifyMs=5000,verifyAttempts=3,operationMs=30000,stallMs=30000,now=Date.now,retryBaseMs=2000,retryMaxMs=30000,prepareNextFromBeginning=false,prepareNextFromSaved=false}) {
    this.store=store;this.record=record;this.targets=targets;this.createSingle=createSingle;this.onState=onState;this.assertRootIdle=assertRootIdle;
    this.pollMs=pollMs;this.verifyMs=verifyMs;this.verifyAttempts=verifyAttempts;this.operationMs=operationMs;this.stallMs=stallMs;
    this.now=now;this.retryBaseMs=Math.max(1,retryBaseMs);this.retryMaxMs=Math.max(this.retryBaseMs,retryMaxMs);this.clearRetry();
    this.prepareNextFromBeginning=prepareNextFromBeginning;
    this.prepareNextFromSaved=prepareNextFromSaved;
    this.personalQueue=true;this.active=false;this.disposed=false;this.single=null;this.generation=0;this.completionConfirmed=false;
    this.saveFailureCleanupComplete=false;
    if(record.phase!=='ready' && record.phase!=='completed'){record.phase='paused';record.reason='APP_REOPENED';}
  }
  async createCurrent(token=this.generation){
    const creating=(async()=>{
      const child=await this.createSingle(this.targets[this.record.cursor]);
      if(this.disposed||token!==this.generation){child.requestStop?.();await child.dispose();return null;}
      this.single=child;return child;
    })();
    this.creating=creating;
    try{return await creating;}finally{if(this.creating===creating)this.creating=null;}
  }
  async init(){if(this.record.cursor<this.targets.length)await this.createCurrent();this.notify();}
  get pendingCompletion(){return Boolean(this.pendingCompletionProof&&!this.completionConfirmed);}
  get busy(){return this.active && !this.retrying && ['opening','verifying','switching'].includes(this.record.phase);}
  canDiscardSaveFailure(){return Boolean(this.saveFailureCleanupComplete&&this.disposed&&!this.active&&!this.starting&&!this.creating&&!this.busy
    &&(!this.single||this.single.canDiscardSaveFailure?.())&&(this.single?.canDiscardSaveFailure?.()||isPositionSaveIoError(this.queuePersistError)));}
  status(){const target=this.targets[Math.min(this.record.cursor,this.targets.length-1)],state=this.single?.status()??this.completionState??{target:target?.title,page:target?.page,index:target?.index,classroomId:target?.classroomId,courseTitle:this.record.courseTitle,stage:'not-open',media:null,resumeSeconds:0,restoreAvailable:false};
    return {...state,actionError:this.active&&this.retrying?null:state.actionError,actionsAvailable:state.actionsAvailable!==false&&!this.disposed&&this.record.phase!=='completed',discardAvailable:Boolean((state.discardAvailable&&!this.single?.canDiscardSaveFailure?.())||this.canDiscardSaveFailure()||recordConflict(this.stopError)||recordConflict(this.queuePersistError)||recordConflict({message:this.record.reason})),queue:{scope:'personal-temporary',active:this.active,phase:this.record.phase,reason:this.record.reason,
      retrying:this.active&&this.retrying,waiting:this.active&&this.retrying,retryReason:this.retryReason??'',retryAttempts:this.retryAttempts,retryDelayMs:this.retryDelayMs,
      completionPending:this.pendingCompletion,
      cursor:this.record.cursor,total:this.targets.length,completed:this.record.cursor,
      message:this.active&&this.retrying?(this.retryReason==='LIST_UNAVAILABLE'?'正在等待官方列表恢复，再确认当前视频；可随时暂停或结束。':'页面、媒体或官方控件暂未就绪，正在间隔重试；可随时暂停或结束。'):personalQueueErrors[this.record.reason]??(this.record.reason==='APP_REOPENED'?'上次队列已保留；重开不自动恢复或播放。':''),
      courseUrl:this.record.courseUrl,mode:this.record.mode??(this.targets.length===1?'single':'continuous')},busy:this.busy||state.busy};}
  notify(){this.onState(this.status().queue);}
  clearRetry(){this.retrying=false;this.retryPausedAllowed=false;this.retryReason='';this.retryAttempts=0;this.retryDelayMs=0;this.nextRetryAt=0;}
  scheduleRetry(allowPaused=this.retryPausedAllowed,reason=this.retryReason||'PLAY_NOT_STARTED'){this.retrying=true;this.retryPausedAllowed=allowPaused;this.retryReason=reason;++this.retryAttempts;
    this.retryDelayMs=Math.min(this.retryMaxMs,this.retryBaseMs*2**Math.min(this.retryAttempts-1,30));
    this.nextRetryAt=this.now()+this.retryDelayMs;this.notify();}
  async phase(phase,reason=''){this.record.phase=phase;this.record.reason=reason;this.queueStateTouched=true;
    try{await this.store.save(this.record);this.queuePersistError=null;}catch(error){this.queuePersistError=error;throw error;}this.notify();}
  check(token){if(this.disposed||!this.active||token!==this.generation||this.abort.signal.aborted)throw new Error('QUEUE_STOPPED');this.assertRootIdle();}
  async bounded(promise){let timer;try{return await Promise.race([promise,new Promise((_,reject)=>{timer=setTimeout(()=>reject(new Error('QUEUE_OPERATION_TIMEOUT')),this.operationMs);})]);}finally{clearTimeout(timer);}}
  async requireAction(action){
    // The single controller bounds official operations and observes cancellation.
    // Settle mutations before retrying so a late popup or click cannot overlap.
    const state=await this.single.act(action);if(state.actionError)throw new Error(state.actionError);
    if(action==='play'&&(!state.media||state.media.paused||state.media.ended))throw new Error('PLAY_NOT_STARTED');return state;}
  async start(){
    if(this.disposed||this.active||this.starting||this.record.cursor>=this.targets.length)return this.status();
    this.starting=true;const requestGeneration=this.generation;
    try {
      await this.job?.catch(()=>{});
      if(this.disposed||requestGeneration!==this.generation)return this.status();
      if(recordConflict(this.stopError)||recordConflict(this.queuePersistError)||recordConflict({message:this.record.reason})){this.notify();return this.status();}
      if(!this.single)await this.createCurrent(requestGeneration);
      if(this.disposed||requestGeneration!==this.generation)return this.status();
      // Only this explicit start may reopen a player that was already closed.
      // Recovery never receives this grant, and it is consumed before awaiting.
      this.explicitReopenSingle=this.single?.player&&this.single.ownedPlayer===this.single.player&&this.single.player.isClosed?.()
        ?this.single:null;
      this.assertRootIdle();
      this.active=true;this.lastError=null;this.clearRetry();this.abort=new AbortController();
    } finally {this.starting=false;}
    const token=++this.generation;this.notify();
    this.job=this.run(token).catch(async error=>{
      if(token!==this.generation||this.disposed)return;
      this.active=false;this.clearRetry();this.abort.abort();this.lastError=error;
      let reason=this.queuePersistError===error&&!recordConflict(error)||['EBUSY','EIO','EACCES','EPERM','ENOSPC','EROFS','EMFILE'].includes(code(error))?'QUEUE_SAVE_FAILED':code(error);
      try{await this.haltPlayer(false,error);}catch(haltError){this.lastError=haltError;reason=recordConflict(haltError)?code(haltError):haltError===this.stopError&&this.stopErrorSaving?'QUEUE_SAVE_FAILED':code(haltError);}
      if(token!==this.generation||this.disposed)return;
      try{await this.phase('paused',reason);}catch(error){this.lastError=error;this.record.phase='paused';this.record.reason=recordConflict(error)?code(error):'QUEUE_SAVE_FAILED';this.notify();}
    });
    return this.status();
  }
  async run(token){
    while(this.record.cursor<this.targets.length){
      this.check(token);
      if(!this.single)await this.createCurrent(token);
      this.check(token);this.single.operationSignal=this.abort.signal;
      try{await this.playCurrent(token);}
      catch(error){
        this.check(token);
        if(this.queuePersistError===error||!isRecoverableQueueError(error,this.single?.status()))throw error;
        await this.recoverCurrent(error,token);continue;
      }
      this.check(token);this.clearRetry();let state=this.single.status();
      this.assertEnded(state);
      const completing=this.single;
      await completing.persist();this.check(token);await this.phase('verifying');this.check(token);
      let confirmed=false;
      for(let attempt=0;attempt<this.verifyAttempts;attempt++){
        await this.verifyCurrent(completing,token);
        if(completing.status().percent===100){confirmed=true;break;}
        if(attempt+1<this.verifyAttempts)await sleep(this.verifyMs,this.abort.signal);
      }
      if(!confirmed)throw Object.assign(new Error('QUEUE_NOT_CONFIRMED'),{verificationExhausted:true});
      this.check(token);await completing.sample();this.check(token);this.assertEnded(completing.status());
      const completedState=completing.status(),nextCursor=this.record.cursor+1,final=nextCursor===this.targets.length;
      await this.phase('switching');this.check(token);
      // Keep an owned official list tab alive while handing off to the next item.
      // A cursor is committed only after this item's save and cleanup succeed.
      await completing.dispose({preserveOfficialSession:!final});
      if(this.single===completing){this.single=null;this.preparedSingle=null;}
      this.check(token);
      if(final){
        this.completionState=completedState;
        this.pendingCompletionProof={cursor:nextCursor};
        await this.commitPendingCompletion();this.check(token);
        this.active=false;this.notify();return;
      }
      this.record.cursor=nextCursor;await this.phase('switching');this.check(token);
      await this.createCurrent(token);this.check(token);
    }
  }
  assertEnded(state){
    if(!state.media?.ended||!Number.isFinite(state.media.duration)||state.media.duration<=0
      ||state.media.currentTime<state.media.duration-0.75||(state.confirmedWatchedPrefix??state.confirmedWatchedSeconds)<state.media.duration-1)throw new Error('QUEUE_UNWATCHED_GAP');
  }
  async commitPendingCompletion(){
    if(!this.pendingCompletion)return;
    const protectedError=[this.stopError,this.queuePersistError].find(recordConflict);
    if(protectedError)throw protectedError;
    if(recordConflict({message:this.record.reason}))throw new Error(this.record.reason);
    const previousCursor=this.record.cursor;
    this.record.cursor=this.pendingCompletionProof.cursor;
    try{await this.phase('completed');}
    catch(error){
      // Keep the proof in memory, but never persist a completed-length cursor
      // with a failed/paused phase. Explicit finish can retry this save alone.
      this.record.cursor=previousCursor;this.record.phase='paused';
      this.record.reason=recordConflict(error)?code(error):'QUEUE_SAVE_FAILED';
      this.lastError=error;this.notify();throw error;
    }
    this.completionConfirmed=true;this.pendingCompletionProof=null;this.notify();
  }
  async assertCompletionUnchanged(){
    try{
      if(this.store.assertUnchanged)await this.store.assertUnchanged(this.record);
      else if(this.store.read){
        const latest=await this.store.read();
        if(!latest||JSON.stringify(latest)!==JSON.stringify(this.record))throw new Error('QUEUE_RECORD_CHANGED');
      }
      this.queuePersistError=null;
    }catch(error){this.queuePersistError=error;this.lastError=error;this.notify();throw error;}
  }
  async recoverCurrent(error,token){
    let failure=error;
    while(true){
      this.check(token);this.lastError=failure;this.scheduleRetry(true,code(failure));
      await sleep(this.retryDelayMs,this.abort.signal);this.check(token);
      try{
        if(this.single.recoverQueuePlayback){
          const state=await this.single.recoverQueuePlayback(failure);this.check(token);
          if(state?.actionError)throw new Error(state.actionError);
          this.preparedSingle=this.single;
        }
        return;
      }catch(next){
        this.check(token);if(this.queuePersistError===next||!isRecoverableQueueError(next,this.single?.status()))throw next;
        failure=next;
      }
    }
  }
  async verifyCurrent(completing,token){
    while(true){
      this.check(token);if(this.single!==completing)throw new Error('PLAYER_CHANGED');
      try{
        // Reads/navigation already have bounded waits in ChromeCourse. Do not
        // race a navigation against another verification on the same tab.
        await completing.selectCard();this.check(token);
        if(this.retrying){this.clearRetry();this.notify();}
        return;
      }catch(error){
        this.check(token);
        if(!['PAGE_LOAD_FAILED','CDN_TIMEOUT','LIST_UNAVAILABLE','MEDIA_NOT_READY','PAGE_RESET'].includes(code(error)))throw error;
        this.lastError=error;this.scheduleRetry(true,code(error));
        await sleep(this.retryDelayMs,this.abort.signal);this.check(token);
      }
    }
  }
  async playCurrent(token){
      const before=this.single.status();
      if(!before.media||this.explicitReopenSingle===this.single||this.preparedSingle!==this.single&&(this.prepareNextFromBeginning||this.prepareNextFromSaved)){
        await this.phase('opening');this.check(token);
        if(this.single.prepareQueuePlayback){
          const reopenClosedPlayer=this.explicitReopenSingle===this.single;
          const continuingSaved=reopenClosedPlayer&&this.preparedSingle===this.single;
          this.explicitReopenSingle=null;
          const prepared=await this.single.prepareQueuePlayback({fromBeginning:this.prepareNextFromBeginning&&!continuingSaved,
            fromSaved:this.prepareNextFromSaved||continuingSaved,reopenClosedPlayer});this.check(token);
          if(prepared?.actionError)throw new Error(prepared.actionError);
        }else{
          if(!before.media){await this.requireAction('open');this.check(token);}
          if(this.prepareNextFromBeginning||this.prepareNextFromSaved){
            await this.requireAction(this.prepareNextFromSaved&&this.single.status().resumeSeconds>=1?'restore':'beginning');this.check(token);}
        }
        this.preparedSingle=this.single;
      }
      await this.single.inspectPersonalQueueSafety();this.check(token);
      let state=this.single.status();
      if(!state.media?.ended){
        if(!state.media||!state.playAllowed)throw new Error(state.playBlockedReason??(!state.media?'OPEN_FIRST':'QUEUE_PLATFORM_BLOCKED'));
        if(!(this.record.mode==='single'&&this.targets.length===1)&&state.media.currentTime>(state.confirmedWatchedPrefix??state.confirmedWatchedSeconds)+0.75)throw new Error('QUEUE_UNWATCHED_GAP');
        let playFailed=false;
        try{await this.requireAction('play');}catch(error){this.check(token);if(code(error)!=='PLAY_NOT_STARTED')throw error;playFailed=true;}
        this.check(token);
        if(!recordConflict(this.stopError)){this.stopError=null;this.stopErrorSaving=false;this.stopCloseError=null;}
        await this.phase('playing');this.check(token);
        if(playFailed)this.scheduleRetry(Boolean(this.single.status().media?.paused));
        let previous=this.single.status().media?.currentTime??state.media.currentTime,lastProgress=this.now();
        while(true){
          await sleep(this.pollMs,this.abort.signal);this.check(token);
          // Settle each read before recovery can change the owned player.
          // Playwright's page waits are bounded; an outer race would leave a
          // late sample able to publish stale media into a freshly opened item.
          await this.single.sample();this.check(token);await this.single.inspectPersonalQueueSafety();this.check(token);
          state=this.single.status();
          if(state.media?.ended)break;
          if(!state.media||state.media.mediaErrorCode)throw new Error('MEDIA_ERROR');
          if(state.media.paused&&!(this.retrying&&this.retryPausedAllowed))throw new Error('QUEUE_WEBSITE_PAUSED');
          if(!state.playAllowed)throw new Error(state.playBlockedReason??'QUEUE_PLATFORM_BLOCKED');
          if(!(this.record.mode==='single'&&this.targets.length===1)&&state.media.currentTime>(state.confirmedWatchedPrefix??state.confirmedWatchedSeconds)+1)throw new Error('QUEUE_UNWATCHED_GAP');
          if(state.media.currentTime>previous+0.01){previous=state.media.currentTime;lastProgress=this.now();
            if(this.retrying){this.clearRetry();this.notify();}}
          if(!this.retrying&&this.now()-lastProgress>=this.stallMs)this.scheduleRetry();
          if(this.retrying&&this.now()>=this.nextRetryAt){
            // Reuse normal official controls, after the fresh safety checks.
            // Only an unconfirmed play attempt is recoverable automatically.
            try{await this.requireAction('play');}catch(error){this.check(token);
              if(!this.single.status().media?.ended&&code(error)!=='PLAY_NOT_STARTED')throw error;}
            this.check(token);await this.single.sample();this.check(token);
            await this.single.inspectPersonalQueueSafety();this.check(token);
            const latest=this.single.status();
            if(latest.media?.ended)break;
            if(!latest.media||latest.media.mediaErrorCode)throw new Error('MEDIA_ERROR');
            if(latest.media.paused&&!this.retryPausedAllowed)throw new Error('QUEUE_WEBSITE_PAUSED');
            if(latest.media.currentTime>previous+.01){previous=latest.media.currentTime;lastProgress=this.now();this.clearRetry();this.notify();}
            else this.scheduleRetry();
          }
        }
      }
  }
  async haltPlayer(close,failure){
    const child=this.single;if(!child){if(recordConflict(this.stopError))throw this.stopError;return;}
    const player=child.player,page=child.page;
    const remember=(error,saving=false)=>{if(recordConflict(this.stopError))return this.stopError;this.stopError=error;this.stopErrorSaving=saving;return error;};
    const closePlayer=async()=>{
      if(!player||player.isClosed?.())return;
      if(child.player!==player||child.ownedPlayer!==player)throw new Error('PLAYER_CHANGED');
      try{await this.bounded(player.close());}catch(error){if(!player.isClosed?.())throw error;}
      if(!player.isClosed?.())throw new Error('PAUSE_NOT_CONFIRMED');
    };
    const closePage=async()=>{
      if(!page||page.isClosed?.())return;
      if(child.page!==page)throw new Error('PLAYER_CHANGED');
      try{await this.bounded(page.close());}catch(error){if(!page.isClosed?.())throw error;}
      if(typeof page.isClosed==='function'&&!page.isClosed())throw new Error('PAUSE_NOT_CONFIRMED');
    };
    let retainEnded=false;
    if(!close&&!child.busy&&this.record.phase==='verifying'&&code(failure)==='QUEUE_NOT_CONFIRMED'&&failure.verificationExhausted===true){
      try{await this.bounded(child.sample());const media=child.status().media;retainEnded=Boolean(media?.ended&&media.paused);}catch{}
    }
    if(child.busy || this.record.phase==='opening' || (this.record.phase==='verifying'&&!retainEnded)){
      let closeError;
      try{await closePlayer();}catch(error){closeError=error;}
      try{await closePage();}catch(error){closeError??=error;}
      if(closeError){this.stopCloseError=closeError;throw remember(closeError);}
      this.stopCloseError=null;
      if(this.stopError)throw this.stopError;
      return;
    }
    let actionFailure;
    try{
      await this.bounded(child.sample());
      const current=child.status().media;
      if(!current&&player&&!player.isClosed?.()){await closePlayer();if(!child.busy)await this.bounded(child.sample());}
      if(current&&!current.paused&&!current.ended){
        const paused=await this.bounded(child.act('pause'));
        if(paused.actionError)throw new Error(paused.actionError);
        const after=child.status().media;
        if(!paused.media||!after||[paused.media,after].some(media=>!media.paused&&!media.ended))throw new Error('PAUSE_NOT_CONFIRMED');
      }
      if(close&&child.status().media){
        const closed=await this.bounded(child.act('close-video'));
        if(closed.actionError)throw new Error(closed.actionError);
        if(closed.media||child.status().media||(player&&!player.isClosed?.()))throw new Error('PAUSE_NOT_CONFIRMED');
      }
    }catch(error){actionFailure=error;}
    if(actionFailure){
      if(!child.busy){try{await this.bounded(child.sample());if(child.touched&&!child.recordError)child.ledger?.capture?.(child.status().media);}catch{}}
      let stopped=false;
      try{
        await closePlayer();
        if(player&&!player.isClosed?.())throw new Error('PAUSE_NOT_CONFIRMED');
        const latest=child.status().media;
        if(!player&&latest&&!latest.paused&&!latest.ended)throw new Error('PAUSE_NOT_CONFIRMED');
        stopped=true;this.stopCloseError=null;
      }catch(error){this.stopCloseError=error;if(actionFailure instanceof Error)actionFailure.cause??=error;}
      if(stopped&&!child.busy)await this.bounded(child.sample()).catch(()=>{});
    }else this.stopCloseError=null;
    try{await child.persist();}catch(error){throw remember(error,true);}
    if(actionFailure)throw remember(actionFailure);
    if(recordConflict(this.stopError))throw this.stopError;
    this.stopError=null;this.stopErrorSaving=false;
  }
  async pause(stop=false){
    this.active=false;this.clearRetry();++this.generation;this.abort?.abort();this.notify();
    let reason=stop?'QUEUE_STOPPED':'USER_PAUSED';
    try{await this.haltPlayer(stop);}catch(error){this.lastError=error;reason=recordConflict(error)?code(error):error===this.stopError&&this.stopErrorSaving?'QUEUE_SAVE_FAILED':code(error);}
    try{await this.phase(this.stopError?'paused':stop?'stopped':'paused',reason);}catch(error){this.lastError=error;this.record.phase='paused';this.record.reason=recordConflict(error)?code(error):'QUEUE_SAVE_FAILED';this.notify();}
    return this.status();
  }
  requestStop(){this.active=false;this.clearRetry();++this.generation;this.abort?.abort();this.single?.requestStop?.();}
  async act(action){if(action==='pause')return this.pause();if(action==='close-video')return this.pause(true);
    if(this.active)throw new Error('请先暂停个人队列，再单独操作当前视频。');
    await this.job?.catch(()=>{});if(!this.single)return this.status();this.single.operationSignal=null;return {...await this.single.act(action),queue:this.status().queue};}
  async changePlaybackOptions(patch){
    if(this.active||this.starting||this.disposed)throw new Error('OPTIONS_BUSY');
    await this.job?.catch(()=>{});
    if(!this.single)return this.status();
    this.single.operationSignal=null;
    await this.single.changePlaybackOptions(patch);return this.status();
  }
  async dispose({discardUnsavedPosition=false,preserveQueueRecord=false,discardForRollbackConflict=false}={}){
    // Only the trusted manager can confirm a conflict in its retained staged rollback.
    if(discardUnsavedPosition&&!this.status().discardAvailable&&!(preserveQueueRecord===true&&discardForRollbackConflict===true))throw new Error('DISCARD_NOT_AVAILABLE');
    this.saveFailureCleanupComplete=false;
    const wasActive=this.active;
    this.disposed=true;this.requestStop();
    if(!discardUnsavedPosition&&!preserveQueueRecord&&wasActive&&this.record.cursor<this.targets.length)await this.pause();
    await this.creating;
    await this.job?.catch(()=>{});
    if(!discardUnsavedPosition&&!preserveQueueRecord&&this.pendingCompletion)await this.commitPendingCompletion();
    if(preserveQueueRecord&&!recordConflict({message:this.record.reason})){
      this.record.phase=this.record.cursor===this.targets.length?'completed':'stopped';this.record.reason=this.record.phase==='completed'?'':'QUEUE_STOPPED';
    }
    const child=this.single;
    try{await child?.dispose({discardUnsavedPosition});this.single=null;this.saveFailureCleanupComplete=!this.starting&&!this.creating;}
    catch(error){this.saveFailureCleanupComplete=Boolean(!this.starting&&!this.creating&&child?.saveFailureCleanupComplete);throw error;}
    if(discardUnsavedPosition)return;
    if(!recordConflict(this.stopError))this.stopError=null;
    if(this.stopError)throw this.stopError;
    if(this.record.reason==='QUEUE_RECORD_CHANGED')throw new Error('QUEUE_RECORD_CHANGED');
    if(recordConflict(this.queuePersistError))throw this.queuePersistError;
    if(preserveQueueRecord){this.notify();return;}
    if(!this.queueStateTouched&&!this.queuePersistError)return;
    if(this.completionConfirmed&&this.record.phase==='completed'){
      await this.assertCompletionUnchanged();this.notify();return;
    }
    try{await this.phase(this.record.cursor===this.targets.length?'completed':'stopped',this.record.cursor===this.targets.length?'':'QUEUE_STOPPED');}
    catch(error){this.record.phase='paused';this.record.reason=recordConflict(error)?code(error):'QUEUE_SAVE_FAILED';this.notify();throw error;}
  }
}
