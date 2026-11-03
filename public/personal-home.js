const time=s=>Number.isFinite(s)?`${Math.floor(s/60)}:${String(Math.floor(s%60)).padStart(2,'0')}`:'—';
const key=v=>`${v?.courseUrl??''}:${v?.page}:${v?.index}:${v?.title}:${v?.cardIdentity??''}`;
export function canonicalClassroomUrl(input){
  try{const u=new URL(input),m=u.pathname.match(/^\/classrooms\/([A-Za-z0-9_-]+)(?:\/|$)/);return u.protocol==='https:'&&u.hostname==='www.educoder.net'&&!u.port&&!u.username&&!u.password&&m?`https://www.educoder.net/classrooms/${m[1]}/video`:null;}catch{return null;}
}
export function chooseHomepageState({snapshot,currentUrl,connected=true,phase,officialSessionOpen}){
  currentUrl=canonicalClassroomUrl(currentUrl)??currentUrl;
  if(!connected)return {title:'本机连接暂未恢复',subtitle:'已保存位置保留，连接恢复后再由你开始。'};
  if(!currentUrl)return {title:officialSessionOpen===false?'先连接你的课堂':'还没有选择课堂',subtitle:'打开官方登录窗口，自行登录后读取我的课堂。'};
  if(phase==='inventory-scanning')return {title:'正在读取官方进度',subtitle:'只读扫描完成后，可点击方格播放。'};
  if(snapshot?.courseUrl!==currentUrl)return {title:'这门课堂还没有扫描',subtitle:'刷新官方进度，读取当前课堂的视频。'};
  if(!snapshot.complete)return {title:'课堂扫描尚未完整',subtitle:'已有方格可查看；请完整扫描后再播放。'};
  return {title:snapshot.items?.length?'点击方格播放视频':'这次还没有读到视频',subtitle:snapshot.items?.length?'需要连续看多条时，点击“选多条连续播放”。':'请在官方窗口确认登录和课堂内容，再刷新官方进度。'};
}
if(typeof document!=='undefined'&&typeof window!=='undefined'){
  const el=id=>document.getElementById(id),api=window.localManualVideo;
  const disconnectedMessage='本机播放连接暂未恢复，已保存位置保留；恢复后仍由你决定继续。';
  const optionsFailureMessage='播放设置未能保存，原设置保留；请稍后重试。';
  let ctx={},state=null,picks=[],editing=false,summary=null,recent=null,savedPosition=null,position=null;
  let fromBeginning=false,starting=false,acting=false,stopping=false,polling=false,connected=true,notice='',noticeError=false;
  let replacement=null,retryRequest=null,scanKey='',positionKey='',positionRevision=0,historyRevision=0,operationRevision=0,stateRevision=-1,preferenceRevision=0,speedKey='';
  let preferences={autoMute:false,speedEnabled:false,speed:1.5},pendingPreferences=null,optionsLoaded=false,optionsBusy=false;
  let historyLoading=false,historyError=false,historyRead=false;
  const value=()=>Number.isSafeInteger(ctx.session?.revision)&&ctx.session.revision>(state?.revision??-1)?ctx.session:state??ctx.session??{};
  const locked=()=>Boolean(value().active||value().viewerOpen||value().opening||value().closing||value().replacing||starting||stopping);
  const reliable=()=>ctx.snapshot?.courseUrl===ctx.currentUrl&&ctx.snapshot.complete===true;
  const canChoose=()=>Boolean(api?.start&&ctx.connected!==false&&connected&&!ctx.changing&&!starting&&!stopping&&!acting&&!value().opening&&!value().closing&&!value().replacing&&!['inventory-scanning','preparing','playing','scanning','stopping'].includes(ctx.phase));
  const matches=v=>Boolean(v?.courseUrl===ctx.currentUrl&&ctx.snapshot?.courseUrl===ctx.currentUrl&&ctx.snapshot.items?.some(card=>key({...card,courseUrl:ctx.currentUrl})===key(v)));
  const savedChoices=()=>summary?.courseUrl===ctx.currentUrl&&Array.isArray(summary.selections)?summary.selections:[];
  const savedValid=()=>reliable()&&savedChoices().length===summary?.total&&summary.cursor<summary.total&&savedChoices().every(matches);
  const savedMode=()=>summary?.mode==='single'?'single':'continuous';
  const recentValid=()=>matches(recent?.selection)&&recent.seconds>0
    &&!(summary?.cursor===summary?.total&&savedChoices().some(v=>key(v)===key(recent.selection)))
    &&ctx.snapshot.items.find(v=>key({...v,courseUrl:ctx.currentUrl})===key(recent.selection))?.progress!==100;
  const canResume=()=>historyRead&&!historyLoading&&!historyError&&(savedValid()||recentValid());
  const publishSelection=()=>window.dispatchEvent(new CustomEvent('study-selection-changed',{detail:editing?picks[0]??null:value().selection??null}));
  const say=(text,error=false)=>{notice=text;noticeError=error;};
  function acceptState(next){
    const floor=Math.max(stateRevision,ctx.session?.revision??-1);
    if(Number.isSafeInteger(next?.revision)&&next.revision<floor)return false;
    stateRevision=Math.max(stateRevision,next?.revision??-1);state=next;
    if(next?.playbackOptions&&!optionsBusy){preferences=next.playbackOptions;optionsLoaded=true;}
    return true;
  }
  function decorateMap(){
    const current=value().selection,busy=!canChoose()||!reliable();
    for(const cell of document.querySelectorAll('.heatmap-cell')){
      const index=editing?picks.findIndex(v=>v.courseUrl===ctx.currentUrl&&String(v.page)===cell.dataset.page&&String(v.index)===cell.dataset.index):-1;
      const playing=locked()&&current?.courseUrl===ctx.currentUrl&&String(current.page)===cell.dataset.page&&String(current.index)===cell.dataset.index;
      cell.classList.toggle('is-personal-queued',editing&&index>=0);cell.classList.toggle('is-current-selection',Boolean(playing));
      cell.dataset.queueOrder=index>=0?String(index+1):'';cell.dataset.interaction=!reliable()?'inspect':editing?'select':'play';cell.setAttribute('aria-pressed',String(index>=0||Boolean(playing)));
      const last=recent?.selection;cell.classList.toggle('is-last-position',!locked()&&last?.courseUrl===ctx.currentUrl&&String(last.page)===cell.dataset.page&&String(last.index)===cell.dataset.index);
      cell.dataset.baseLabel??=cell.getAttribute('aria-label')??'';
      cell.setAttribute('aria-label',(!api?.start||!reliable()?'查看：':editing?'选择连续播放：':'播放：')+cell.dataset.baseLabel+(index>=0?`，已选第${index+1}条`:playing?'，当前播放':'')+(api?.start&&busy?'，暂不可播放':''));
      cell.disabled=api?.start?!canChoose():ctx.connected===false||ctx.changing||ctx.phase==='inventory-scanning';
    }
  }
  function renderOptions(){
    const v=value(),display=pendingPreferences??preferences;
    const busy=optionsBusy||!optionsLoaded||ctx.connected===false||!connected||v.busy||v.queue?.active||v.opening||v.closing||v.replacing||starting||acting||stopping||v.optionsError;
    el('auto-mute').checked=display.autoMute;el('speed-enabled').checked=display.speedEnabled;
    el('auto-mute').disabled=busy;el('speed-enabled').disabled=busy;
    const rates=(v.controls?.rates??[]).filter(rate=>rate>1),values=rates.length?rates:[display.speed],identity=JSON.stringify([values,display.speed,Boolean(v.media)]);
    if(identity!==speedKey){
      el('speed-value').replaceChildren(...values.map(rate=>{const o=document.createElement('option');o.value=String(rate);o.textContent=`${rate}x${rates.length?'':v.media?'（不可用）':'（待核对）'}`;return o;}));
      if(!values.includes(display.speed)){const o=document.createElement('option');o.value=String(display.speed);o.textContent=`${display.speed}x（此视频不可用）`;o.disabled=true;el('speed-value').append(o);}speedKey=identity;
    }
    el('speed-value').value=String(display.speed);el('speed-value').disabled=busy||!display.speedEnabled||!rates.length;
    el('options-state').textContent=v.media?`官网当前${v.media.muted||v.media.volume===0?'静音':'有声'} · ${v.media.playbackRate??1}x${v.queue?.active?' · 暂停后可改设置':''}`:'设置会保存，仅使用官网提供的控件';
    el('options-hint').textContent=optionsBusy?'正在保存播放设置…':v.optionsHint||'';
  }
  function render(){
    const v=value(),active=locked(),queue=v.queue,opening=starting||v.opening||v.replacing,closing=stopping||v.closing;
    const canPause=Boolean(queue?.active&&(queue.phase==='playing'||queue.retrying));
    const playing=Boolean(queue?.active&&queue.phase==='playing'&&v.media&&!v.media.paused&&!v.media.ended);
    document.body.classList.toggle('is-viewing',active);document.body.classList.toggle('is-batch-editing',editing);
    el('batch-select').hidden=editing;el('batch-select').disabled=!canChoose()||!reliable()||!ctx.snapshot?.items?.length;
    el('selection-area').hidden=!editing;el('selection-count').textContent=`已选 ${picks.length} 条`;
    el('selection-clear').disabled=!canChoose()||!picks.length;el('selection-cancel').disabled=starting||stopping;
    el('home-title').textContent='选择本次连续播放的视频';el('home-subtitle').textContent=active?'点方格加入或移除，当前播放保持不变；开始所选时再确认更换。':'点方格加入或移除；编号就是本次播放顺序。';
    el('selected-preview').replaceChildren(...picks.map(v=>{const li=document.createElement('li');li.textContent=`${v.title} · 第 ${v.page} 页第 ${v.index+1} 条`;return li;}));
    el('batch-start').textContent=`连续播放所选（${picks.length}条）`;el('batch-start').disabled=!canChoose()||!reliable()||!picks.length||Boolean(replacement);
    el('start-from-beginning').checked=fromBeginning;el('start-from-beginning').disabled=!canChoose();
    el('start-point').textContent=fromBeginning?'已保存位置仍保留':position?.seconds>0?`首条本机位置 ${time(position.seconds)}`:'优先继续各视频本机位置';
    el('map-instruction').textContent=editing?'点方格选择本次连续播放的内容，编号表示顺序。':chooseHomepageState(ctx).subtitle;
    if(reliable()&&ctx.snapshot.items?.length&&!editing)el('map-instruction').textContent='点击方格播放视频；悬停或聚焦查看标题与官方进度。';
    el('now-playing').hidden=!active;
    const phases={opening:'正在开始',playing:'正在播放',verifying:'正在核对官网进度',switching:'正在切换下一条',paused:'已暂停',stopped:'已结束',ready:'正在准备',completed:'本次已播放完成'};
    el('playback-state').textContent=closing?'正在保存并结束':v.replacing?'正在保存并更换':opening?'正在开始':v.completionPending?'完成后尚未保存':queue?.retrying?'等待恢复，稍后重试':phases[queue?.phase]??(playing?'正在播放':'已暂停');
    el('playback-state').classList.toggle('is-playing',playing&&!closing&&!opening);
    const current=v.selection??picks[0],next=v.nextSelection??queue?.selections?.[queue.cursor+1];
    el('current-label').textContent=queue?.total>1?`当前 · 第 ${Math.min((queue.currentIndex??queue.cursor)+1,queue.total)} / ${queue.total} 条`:'当前视频';
    el('current-title').textContent=current?.title||'正在准备所选视频';el('next-title').textContent=next?.title||'本次没有下一条';
    el('playback-current').textContent=time(v.media?.currentTime);el('playback-duration').textContent=v.media?`视频总长 ${time(v.media.duration)}`:'等待官方播放器';
    el('playback-percent').textContent=Number.isFinite(v.percent)?`${v.percent}%`:'待核对';el('playback-resume').textContent=v.resumeSeconds>0?time(v.resumeSeconds):'尚无记录';
    const rechecking=v.media?.ended&&queue?.reason==='QUEUE_NOT_CONFIRMED';
    el('home-continue').textContent=closing?'正在保存…':opening?'正在开始…':queue?.phase==='switching'&&!queue.retrying?'正在切换…':v.completionPending?'重试保存并结束':rechecking?'重新核对进度':canPause?'暂停播放':'继续播放';
    el('home-continue').disabled=closing||opening||queue?.phase==='switching'&&!queue.retrying||acting||ctx.connected===false||!connected||v.busy&&!canPause||(!v.completionPending&&v.actionsAvailable===false)||queue?.phase==='completed'&&!v.completionPending;
    el('playback-stop').disabled=closing||!connected;el('playback-official').hidden=!v.media&&!v.officialFocusAvailable;el('playback-official').disabled=closing||opening||acting||!connected;
    el('playback-restart').hidden=!v.media||v.completionPending;el('playback-restart').disabled=!canChoose()||!reliable()||!current||Boolean(replacement);
    el('playback-discard').hidden=!v.discardAvailable;el('playback-discard').disabled=closing||opening||!connected;
    el('replacement-confirm').hidden=!replacement;
    if(replacement){const r=replacement;const destination=r.mode==='single'?`“${r.selections[0].title}”${r.fromBeginning?'（从头）':''}`:`所选 ${r.selections.length} 条视频`;
      el('replacement-description').textContent=active?`保存并结束当前“${current?.title??'播放'}”${queue?.total>1?`及本批次余下 ${Math.max(0,queue.total-queue.cursor-1)} 条`:''}，${r.fromBeginning?'从头播放':'改播'}${destination}？`:`当前播放已结束，是否播放${destination}？`;
      el('replacement-start').textContent=r.mode==='single'?'保存并播放这条':`保存并连续播放（${r.selections.length}条）`;el('replacement-start').disabled=!canChoose();
    }
    const showHistory=!active&&!editing&&!replacement&&reliable()&&(savedValid()||recentValid()||historyLoading||historyError);
    el('resume-last').hidden=!showHistory;
    const saved=savedValid(),target=saved?savedChoices()[summary.cursor]:recent?.selection,seconds=saved?savedPosition?.seconds:recent?.seconds;
    el('resume-last-description').textContent=(target?`上次：${target.title}${seconds>0?` · 本机位置 ${time(seconds)}`:''}${saved&&summary.total>1?` · 剩余 ${summary.total-summary.cursor} 条`:''}。目前未播放。`:'')+(historyLoading?' 正在读取上次记录…':historyError?' 上次记录暂未读全，请重试；已确认记录保留。':'');
    el('resume-last-play').disabled=!canResume()||!canChoose();el('resume-last-play').hidden=!target;
    el('resume-last-retry').hidden=!historyError;el('resume-last-retry').disabled=historyLoading||!canChoose();
    const completed=!active&&(v.completed||queue?.phase==='completed')&&v.selection?.courseUrl===ctx.currentUrl&&queue?.courseUrl===ctx.currentUrl;el('completion-summary').hidden=!completed;
    el('completion-summary').textContent=`本次${queue?.total>1?` ${queue.total} 条视频`:current?.title?`“${current.title}”`:''}已播放完成，官网确认100%，可以直接点其他视频。`;
    const reason=v.failure?.message||queue?.message||v.message||v.restoreHint||'';
    el('home-viewing-state').textContent=notice||reason;
    el('home-viewing-state').classList.toggle('is-error',noticeError||Boolean(v.failure||v.actionError&&!queue?.retrying||v.discardAvailable||queue?.reason&&!['USER_PAUSED','QUEUE_STOPPED','APP_REOPENED'].includes(queue.reason)));
    el('start-retry').hidden=active||!retryRequest||editing||Boolean(replacement);el('start-retry').disabled=!canChoose()||!reliable();
    const restartFailed=retryRequest?.mode==='single'&&retryRequest.selections.length===1&&!retryRequest.fromBeginning
      &&key(v.failure?.selection)===key(retryRequest.selections[0])
      &&['RESTORE_REFUSED','INVALID_RESTORE_POSITION','OFFICIAL_PROGRESS_CONTROL_UNAVAILABLE','OFFICIAL_PROGRESS_CONTROL_AMBIGUOUS'].includes(v.failure?.code);
    el('start-beginning-retry').hidden=active||!restartFailed||editing||Boolean(replacement);el('start-beginning-retry').disabled=!canChoose()||!reliable();
    const snapshot=ctx.snapshot?.courseUrl===ctx.currentUrl?ctx.snapshot:null;el('home-metrics').replaceChildren();
    if(snapshot?.complete&&snapshot.items?.length){const part=document.createElement('div'),strong=document.createElement('strong'),label=document.createElement('span');strong.textContent=`${snapshot.items.filter(v=>v.progress===100).length} / ${snapshot.items.length}`;label.textContent=snapshot.officialConfirmationCount?'官网已完成 · 扫描与本次确认':'官网已完成 · 扫描记录';part.append(strong,label);el('home-metrics').append(part);}
    el('home-source').textContent=snapshot?.scannedAt&&Number.isFinite(Date.parse(snapshot.scannedAt))?`官网扫描缓存 · ${new Date(snapshot.scannedAt).toLocaleString('zh-CN')}`:'官网完成度与本机观看位置分开显示';
    if(snapshot?.officialConfirmationCount)el('home-source').textContent+=` · 本次官方确认 ${snapshot.officialConfirmationCount} 条`;
    renderOptions();decorateMap();
  }
  function loadPosition(){
    const first=editing?picks[0]:null,identity=first?key(first):'';if(identity===positionKey)return;positionKey=identity;position=null;const revision=++positionRevision;
    if(first&&api?.position&&reliable())api.position(first).then(v=>{if(revision===positionRevision){position=v;render();}}).catch(()=>{if(revision===positionRevision){position=null;render();}});
  }
  async function loadHistory(){
    const revision=++historyRevision,current=ctx.currentUrl;if(!current||!reliable())return;
    historyLoading=true;historyError=false;render();
    try{
      const results=await Promise.allSettled([api?.recent?.(current),api?.personalSummary?.()]);if(revision!==historyRevision||current!==ctx.currentUrl)return;
      if(results[0].status==='fulfilled')recent=results[0].value??null;else historyError=true;
      if(results[1].status==='fulfilled')summary=results[1].value??null;else historyError=true;
      if(savedValid()&&api?.position){try{const v=await api.position(savedChoices()[summary.cursor]);if(revision!==historyRevision)return;savedPosition=v;}catch{if(revision!==historyRevision)return;historyError=true;}}
      else if(!savedValid())savedPosition=null;
      historyRead=!historyError;
    }finally{if(revision===historyRevision){historyLoading=false;render();}}
  }
  function update(next){
    next={...next,currentUrl:canonicalClassroomUrl(next.currentUrl)??next.currentUrl};
    if(ctx.currentUrl!==next.currentUrl){picks=[];editing=false;replacement=null;retryRequest=null;recent=null;summary=null;savedPosition=null;fromBeginning=false;positionKey='';position=null;scanKey='';notice='';historyLoading=false;historyError=false;historyRead=false;++historyRevision;}
    ctx=next;
    const identity=JSON.stringify([next.currentUrl,next.snapshot?.courseUrl,next.snapshot?.complete,next.snapshot?.scannedAt,next.snapshot?.items?.map(v=>[v.page,v.index,v.title,v.cardIdentity??null])]);
    if(identity!==scanKey){scanKey=identity;if(next.snapshot?.complete){const previous=picks.length;picks=picks.filter(matches);if(previous!==picks.length){replacement=null;say('扫描发现所选视频身份有变化，请重新点选。');publishSelection();}if(retryRequest&&!retryRequest.selections.every(matches))retryRequest=null;}loadHistory();positionKey='';}
    loadPosition();render();
  }
  function selectVideo(selection){
    if(!canChoose()||!reliable()||!matches(selection))return;
    if(editing){const index=picks.findIndex(v=>key(v)===key(selection));if(index>=0)picks.splice(index,1);else if(picks.length<1000)picks.push({...selection});replacement=null;retryRequest=null;say('');publishSelection();loadPosition();render();return;}
    requestStart({mode:'single',courseUrl:ctx.currentUrl,selections:[{...selection}],fromBeginning:false,resumeSaved:false});
  }
  function requestStart(request){
    if(!canChoose()||!reliable()||!request.selections.length||!request.selections.every(matches))return;
    const v=value();
    if(locked()&&request.mode==='single'&&!request.fromBeginning&&!request.resumeSaved
      &&request.selections.length===1&&v.queue?.total===1&&key(request.selections[0])===key(v.selection)
      &&['playing','paused'].includes(v.queue.phase)&&v.media&&!v.media.ended&&!v.completionPending&&v.actionsAvailable!==false){
      action(v.queue.active?'official':v.media.paused?'continue':'official');return;
    }
    if(locked()){replacement=request;say('');render();return;}
    start(request);
  }
  async function start(request,{replace=false}={}){
    if(!canChoose()||!reliable()||!api?.start||!request?.selections.length||!request.selections.every(matches))return;
    const sent={...request,replaceCurrent:Boolean(replace&&locked())};replacement=null;retryRequest=request;starting=true;const revision=++operationRevision;say('');render();
    try{const result=await api.start(sent);if(revision===operationRevision){acceptState(result);connected=true;editing=false;picks=[];fromBeginning=false;retryRequest=null;publishSelection();}}
    catch(error){if(revision===operationRevision){await refresh();const reason=value().failure?.message||value().queue?.message||value().message;
      say(reason||(/RECORD_CHANGED|QUEUE_RECORD_CHANGED/.test(String(error.message))?'较新的本机记录已保留，处理后再播放。':'官网播放器未开始播放；本机位置与上次记录保留。请查看官方窗口后重试。'),true);}}
    finally{if(revision===operationRevision){starting=false;render();}}
  }
  async function resume(){
    if(!canResume()||!canChoose())return;
    const saved=savedValid(),selections=saved?savedChoices():[recent.selection];
    await start({mode:saved?savedMode():'single',courseUrl:ctx.currentUrl,selections:selections.map(v=>({...v})),fromBeginning:false,resumeSaved:saved});
  }
  async function refresh(){
    if(polling||!api?.status)return;polling=true;const revision=operationRevision;
    try{const next=await api.status();if(revision!==operationRevision||!acceptState(next))return;connected=true;if(notice===disconnectedMessage)say('');render();}
    catch{if(revision!==operationRevision)return;connected=false;say(disconnectedMessage,true);render();}finally{polling=false;}
  }
  async function action(name){
    if(starting||acting||stopping||!connected||ctx.connected===false||!api?.action)return;acting=true;const revision=++operationRevision;say('');render();
    try{const result=await api.action(name);if(revision===operationRevision){acceptState(result);connected=true;}}
    catch{if(revision===operationRevision){await refresh();say(value().failure?.message||value().queue?.message||value().message||'操作未完成，请查看官方窗口及当前状态。',true);}}
    finally{if(revision===operationRevision){acting=false;render();}}
  }
  async function finish(discard=false){
    if(stopping||!connected||!api?.finish)return;if(discard&&!window.confirm('确认放弃本次未保存位置并结束？原文件或较新的记录会保留。'))return;
    stopping=true;starting=false;acting=false;replacement=null;retryRequest=null;const revision=++operationRevision;say('');render();
    try{const result=await(discard?api.discardAndFinish():api.finish());if(revision===operationRevision){if(result?.active!==undefined)acceptState(result);positionKey='';say(discard?'本次播放已结束，原文件或较新记录保留。':'本次播放已结束，位置已保存。');await refresh();await loadHistory();}}
    catch{if(revision===operationRevision){await refresh();say(value().failure?.message||value().message||'位置尚未保存，保留当前状态；请重试结束本次。',true);}}
    finally{if(revision===operationRevision){stopping=false;loadPosition();render();}}
  }
  async function setOptions(patch){
    if(optionsBusy||starting||acting||stopping||!connected||ctx.connected===false||!api?.options)return;
    optionsBusy=true;pendingPreferences={...preferences,...patch};++operationRevision;++preferenceRevision;render();
    try{const result=await api.options(patch);preferences=result.playbackOptions??result;optionsLoaded=true;if(result.active!==undefined)acceptState(result);if(notice===optionsFailureMessage)say('');}
    catch{say(optionsFailureMessage,true);try{preferences=await api.playbackOptions();}catch{}}
    finally{pendingPreferences=null;optionsBusy=false;render();}
  }
  el('batch-select').addEventListener('click',()=>{if(!canChoose()||!reliable())return;editing=true;picks=[];fromBeginning=false;replacement=null;retryRequest=null;say('');publishSelection();loadPosition();render();});
  el('selection-cancel').addEventListener('click',()=>{if(starting||stopping)return;editing=false;picks=[];fromBeginning=false;replacement=null;say('');publishSelection();loadPosition();render();});
  el('selection-clear').addEventListener('click',()=>{if(!canChoose())return;picks=[];replacement=null;retryRequest=null;fromBeginning=false;say('');publishSelection();loadPosition();render();});
  el('start-from-beginning').addEventListener('change',event=>{fromBeginning=event.target.checked;replacement=null;render();});
  el('batch-start').addEventListener('click',()=>requestStart({mode:'continuous',courseUrl:ctx.currentUrl,selections:picks.map(v=>({...v})),fromBeginning,resumeSaved:false}));
  el('replacement-start').addEventListener('click',()=>{const request=replacement;if(request)start(request,{replace:true});});
  el('replacement-cancel').addEventListener('click',()=>{replacement=null;say('');render();});
  el('home-continue').addEventListener('click',()=>action(value().queue?.active?'pause':'continue'));
  el('playback-restart').addEventListener('click',()=>{const current=value().selection;if(current)requestStart({mode:'single',courseUrl:ctx.currentUrl,selections:[{...current}],fromBeginning:true,resumeSaved:false});});
  el('start-retry').addEventListener('click',()=>{if(retryRequest)requestStart(retryRequest);});
  el('start-beginning-retry').addEventListener('click',()=>{if(retryRequest)requestStart({...retryRequest,fromBeginning:true,resumeSaved:false});});
  el('resume-last-play').addEventListener('click',resume);el('resume-last-retry').addEventListener('click',loadHistory);
  el('playback-stop').addEventListener('click',()=>finish());el('playback-discard').addEventListener('click',()=>finish(true));el('playback-official').addEventListener('click',()=>action('official'));
  el('auto-mute').addEventListener('change',event=>setOptions({autoMute:event.target.checked}));el('speed-enabled').addEventListener('change',event=>setOptions({speedEnabled:event.target.checked}));el('speed-value').addEventListener('change',event=>setOptions({speed:Number(event.target.value)}));
  api?.onPersonalChanged?.(next=>{summary=next;render();});
  api?.onClosed?.(result=>{replacement=null;positionKey='';if(!starting&&!stopping&&!result?.completed)say('本次播放已结束，已保存位置保留。');loadHistory();refresh();render();});
  api?.onSessionChanged?.(next=>{if(acceptState(next)){connected=true;render();}});
  const initialPreferenceRevision=preferenceRevision;
  api?.playbackOptions?.().then(next=>{if(initialPreferenceRevision!==preferenceRevision)return;preferences=next;optionsLoaded=true;render();}).catch(()=>{if(initialPreferenceRevision!==preferenceRevision)return;optionsLoaded=false;render();});
  window.studyHome={update,selectVideo,selectForQueue:selectVideo,decorateMap,canonicalClassroomUrl,invalidate(){scanKey='';positionKey='';update(ctx);}};
  window.dispatchEvent(new Event('study-home-ready'));refresh();setInterval(refresh,700);
}
