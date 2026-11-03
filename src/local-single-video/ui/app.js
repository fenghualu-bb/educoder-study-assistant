const time = seconds => Number.isFinite(seconds) ? `${Math.floor(seconds / 60)}:${String(Math.floor(seconds % 60)).padStart(2, '0')}` : '—';
const stages = { 'not-open': '等待你准备所选视频', 'official-open': '官方窗口已打开，请自行登录', 'video-closed': '视频已关闭，位置已保留', paused: '已暂停，不会自动播放', playing: '正常播放 · 1 倍速', ended: '这一条已结束，不会打开下一条' };
let submitting = false, finishing = false, refreshing = false, requestRevision = 0, latestState = null, connected = false;
let speedChoicesKey = '';
function renderPlaybackOptions(state, open) {
  const section = document.querySelector('#viewing-options'); section.hidden = !state.optionsAvailable;
  if (section.hidden) return;
  const options = state.playbackOptions, busy = submitting || state.busy || state.queue?.active || state.optionsError;
  const mute = document.querySelector('#auto-mute'), enabled = document.querySelector('#speed-enabled'), speed = document.querySelector('#speed-value');
  mute.checked = options.autoMute; enabled.checked = options.speedEnabled;
  mute.disabled = busy; enabled.disabled = busy;
  const rates = open ? (state.controls?.rates ?? []).filter(rate => rate > 1) : [];
  const key = JSON.stringify([rates, options.speed, Boolean(open)]);
  if (key !== speedChoicesKey) {
    const values = rates.length ? rates : [options.speed];
    speed.replaceChildren(...values.map(rate => { const option = document.createElement('option'); option.value = String(rate);
      option.textContent = `${rate}x${rates.length ? '' : open ? '（不可用）' : '（待核对）'}`; return option; }));
    if (rates.length && !rates.includes(options.speed)) {
      const saved = document.createElement('option'); saved.value = String(options.speed); saved.textContent = `${options.speed}x（此视频不可用）`; saved.disabled = true; speed.append(saved);
    }
    speedChoicesKey = key;
  }
  speed.value = String(options.speed); speed.disabled = busy || !open || !rates.length;
  const silent = state.media?.muted || state.media?.volume === 0;
  document.querySelector('#mute-state').textContent = !open ? `${options.autoMute ? '已启用' : '已关闭'} · 打开视频后应用，只控制官方声音`
    : `${options.autoMute ? '已启用' : '已关闭'} · 官网当前${silent ? '静音' : '有声'}${options.autoMute && !state.controls?.mute ? '，声音控件不可用' : ''}`;
  document.querySelector('#speed-state').textContent = !open ? `${options.speedEnabled ? '已启用' : '已关闭'} · 打开后核对官方菜单`
    : `${options.speedEnabled ? '已启用' : '已关闭'} · 官网当前 ${state.media.playbackRate}x${!rates.length ? '；此视频未开放倍速' : ''}`;
  document.querySelector('#options-hint').textContent = state.optionsHint || '两个选项独立保存；关闭静音恢复原声音状态，关闭倍速恢复 1x。';
}
function render(state) {
  latestState = { ...state, version: state.version ?? latestState?.version }; state = latestState;
  connected = true;
  const pending = submitting || finishing || state.closing;
  const queue=state.queue;document.querySelector('#personal-queue-view').hidden=!queue;
  document.querySelector('#target-guidance').textContent=!queue?'只操作所选这一条。打开后保持暂停，不自动播放或跳到下一条。'
    :queue.phase==='completed'?'所选队列已完成；重开不会自动恢复或开始播放。'
    :queue.active?'按所选顺序播放；真实结束且官网确认100%后才切换，验证或异常时暂停。'
    :'队列由你启动或继续；真实结束且官网确认100%后才切换，重开不自动启动。';
  if(queue){const phases={ready:'队列等待启动',paused:'队列已暂停',stopped:'队列已停止',completed:'队列已完成',opening:'正在打开当前视频',playing:'队列正在播放',verifying:'正在核对官方100%',switching:'正在切换下一条'};
    document.querySelector('#queue-view-state').textContent=`${phases[queue.phase]??'队列暂停，需要处理'} · 已由官网确认 ${queue.completed} / ${queue.total} 条`;
    document.querySelector('#queue-view-hint').textContent=queue.message||'开始由你确认；切换前核对真实结束和官网100%。恢复仅到已观看位置，重开不自动启动。';
  }
  const completed=queue?.phase==='completed',primary=document.querySelector('#view-primary');
  primary.hidden=completed||state.actionsAvailable===false||(!queue&&state.stage==='ended');
  primary.dataset.action=queue?.active?'queue-pause':!state.media?'open':queue?'queue-start':state.stage==='playing'?'pause':'play';
  primary.textContent=queue?.active?'暂停':!state.media?'准备所选视频':queue?(queue.phase==='ready'?'开始所选连播':'继续所选连播'):state.stage==='playing'?'暂停':'播放';

  document.querySelector('#target-title').textContent = state.target;
  document.querySelector('#target-course').textContent = `${state.courseTitle} · 第 ${state.page} 页第 ${state.index + 1} 条`;
  if (state.version) document.querySelector('#version').textContent = state.version;
  const open = ['paused', 'playing', 'ended'].includes(state.stage) && state.media;
  document.querySelector('#stage').textContent = finishing || state.closing ? '正在安全保存并结束观看…' : state.busy || submitting ? '正在处理你的操作…'
    : state.media?.mediaErrorCode ? '官方播放器加载失败；位置保留'
    : state.stage === 'playing' && state.media?.readyState < 3 ? '官方播放器正在缓冲；等待真实进度'
    : state.stage === 'playing' ? `正常播放 · ${state.media?.playbackRate ?? 1} 倍速（官网播放器）`
    : queue?.phase === 'completed' ? '个人队列已完成，播放窗口已关闭'
    : queue && state.stage === 'ended' ? (queue.active ? '当前视频已结束，正在核对官方记录' : '当前视频已结束，队列保持暂停')
    : stages[state.stage] ?? '等待官方窗口';
  document.querySelector('#connection').textContent = state.manualMode ? '复用主程序的官方会话' : state.attachedExistingWindow ? '已连接现有官方窗口' : '本地单视频窗口';
  document.querySelector('#current').textContent = open ? time(state.media.currentTime) : '—';
  document.querySelector('#duration').textContent = open ? `视频总长 ${time(state.media.duration)}` : '等待打开视频';
  document.querySelector('#percent').textContent = Number.isFinite(state.percent) ? `${state.percent}%` : '—';
  document.querySelector('#resume').textContent = state.resumeSeconds > 0 ? time(state.resumeSeconds) : '尚无记录';
  document.querySelector('#restore').textContent = state.resumeSeconds > 0 ? `恢复到 ${time(state.resumeSeconds)}（不播放）` : '恢复到记录位置（不播放）';
  document.querySelector('.recovery').hidden=!state.restoreAvailable||Boolean(queue?.active)||state.actionsAvailable===false;
  document.querySelector('#message').textContent = state.sessionMessage || queue?.message || state.message || state.restoreHint || (queue ? '' : state.attachedExistingWindow ? '当前暂停窗口已保留。你可以直接操作，不需要重新安装或输入命令。' : '打开所选视频后保持暂停；恢复和播放都由你选择。');
  renderPlaybackOptions(state, open);
  for (const button of document.querySelectorAll('button[data-action]')) {
    const action = button.dataset.action;
    if(action==='queue-pause')button.disabled=pending||state.closing||!queue?.active;
    else if(action==='queue-start')button.disabled=pending||state.busy||queue?.active||!open||state.playAllowed===false||completed;
    else button.disabled = pending || state.busy || state.queue?.active || state.actionsAvailable === false
      || (action === 'play' && (!open || state.playAllowed === false || state.stage === 'playing' || state.stage === 'ended'))
      || (action === 'pause' && (!open || state.stage !== 'playing'))
      || (action === 'close-video' && !open)
      || (action === 'restore' && !state.restoreAvailable)
      || (action === 'refresh' && state.stage === 'playing');
    if(action==='official')button.hidden=completed||!(state.officialFocusAvailable??Boolean(open));
    if(action==='close-video')button.hidden=!open||completed;
    if(action==='refresh')button.hidden=!open||state.stage==='playing'||completed;
  }
  document.querySelector('#view-tools').hidden=state.actionsAvailable===false||completed||![...document.querySelectorAll('#view-tools button')].some(button=>!button.hidden);
  document.querySelector('#view-home').hidden=state.canReturnHome===false;
  document.querySelector('#view-home').disabled=finishing||state.closing;
  document.querySelector('#view-finish').disabled=finishing||state.closing;
  document.querySelector('#view-finish').classList.toggle('primary',completed||state.actionsAvailable===false||(!queue&&state.stage==='ended'));
  document.querySelector('#view-discard').hidden=!state.discardAvailable;
  document.querySelector('#view-discard').disabled=pending||state.busy;
}
async function refresh() {
  if(refreshing||submitting||finishing)return;
  refreshing=true;const revision=requestRevision;
  try { const state=await window.singleVideo.status();if(revision===requestRevision&&!submitting&&!finishing)render(state); }
  catch {
    if(revision!==requestRevision||submitting||finishing)return;
    connected=false;
    document.querySelector('#stage').textContent = '本地观看窗口暂未连接';
    document.querySelector('#message').textContent = '请等连接恢复，或关闭本观看窗口后重开；已保存位置保留，不会自动恢复或播放。';
    for (const button of document.querySelectorAll('button')) button.disabled = true;
    for (const control of document.querySelectorAll('#viewing-options input, #viewing-options select')) control.disabled = true;
  }
  finally{refreshing=false;}
}
for (const button of document.querySelectorAll('button[data-action]')) button.addEventListener('click', async () => {
  if (submitting||finishing||!connected) return; submitting = true;const revision=++requestRevision;
  if(latestState)render(latestState);
  try { const action=button.dataset.action,state=action==='queue-start'||action==='queue-pause'
    ?await window.singleVideo.queueAction(action==='queue-start'?'start':'pause'):await window.singleVideo.action(action);
    if(revision===requestRevision){submitting = false;render(state);} }
  catch { if(revision===requestRevision){submitting = false;await refresh();document.querySelector('#message').textContent = '操作未完成，请查看官方窗口。';} }
});
async function setPlaybackOptions(patch) {
  if (submitting||finishing||!connected) return; submitting = true;const revision=++requestRevision;
  for (const control of document.querySelectorAll('button[data-action], #viewing-options input, #viewing-options select')) control.disabled = true;
  try { const state = await window.singleVideo.options(patch);if(revision===requestRevision){submitting = false; render(state);} }
  catch {if(revision===requestRevision){submitting = false; await refresh(); document.querySelector('#message').textContent = '观看选项未能保存，原设置保留；请稍后重试。';} }
}
document.querySelector('#auto-mute').addEventListener('change', event => setPlaybackOptions({ autoMute: event.target.checked }));
document.querySelector('#speed-enabled').addEventListener('change', event => setPlaybackOptions({ speedEnabled: event.target.checked }));
document.querySelector('#speed-value').addEventListener('change', event => setPlaybackOptions({ speed: Number(event.target.value) }));
refresh(); setInterval(refresh, 1000);

document.querySelector('#view-home').addEventListener('click',async()=>{if(!connected||finishing)return;try{await window.singleVideo.home();}catch{document.querySelector('#message').textContent='课堂窗口暂未回应，请稍后重试返回。';}});
document.querySelector('#view-finish').addEventListener('click',async()=>{
  if(!connected||finishing)return;finishing=true;++requestRevision;if(latestState)render(latestState);
  try{await window.singleVideo.finish();}catch{finishing=false;submitting=false;await refresh();document.querySelector('#message').textContent='位置尚未保存，窗口保持打开；原文件保留，请检查后重试结束观看。';}
});
document.querySelector('#view-discard').addEventListener('click',async()=>{
  if(!connected||finishing||submitting||!latestState?.discardAvailable)return;
  if(!window.confirm('确认放弃本次未保存的观看位置并返回课堂？原文件或较新的本机记录会保留，不会被覆盖。'))return;
  finishing=true;++requestRevision;render(latestState);
  try{await window.singleVideo.discardAndFinish();}
  catch{finishing=false;submitting=false;await refresh();document.querySelector('#message').textContent='安全退出尚未完成；窗口保留，请稍后重试。';}
});
window.singleVideo.onFinishError?.(message=>{finishing=false;submitting=false;++requestRevision;refresh();document.querySelector('#message').textContent=message;});
