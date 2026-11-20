const time = seconds => Number.isFinite(seconds) ? `${Math.floor(seconds / 60)}:${String(Math.floor(seconds % 60)).padStart(2, '0')}` : '—';
const stages = { 'not-open': '等待你准备所选视频', 'official-open': '官方窗口已打开，请自行登录', 'video-closed': '视频已关闭，位置已保留', paused: '已暂停，不会自动播放', playing: '正在播放', ended: '这一条已结束，不会打开下一条' };
let submitting = false, finishing = false, refreshing = false, requestRevision = 0, latestState = null, connected = false;
let speedChoicesKey = '';
function render(state) {
  latestState = { ...state, version: state.version ?? latestState?.version }; state = latestState;
  connected = true;
  const pending = submitting || finishing || state.closing;
  const primary = document.querySelector('#view-primary');
  primary.hidden = state.actionsAvailable === false || state.stage === 'ended';
  primary.dataset.action = !state.media ? 'open' : state.stage === 'playing' ? 'pause' : 'play';
  primary.textContent = !state.media ? '准备所选视频' : state.stage === 'playing' ? '暂停' : '播放';

  document.querySelector('#target-title').textContent = state.target;
  document.querySelector('#target-course').textContent = `${state.courseTitle} · 第 ${state.page} 页第 ${state.index + 1} 条`;
  if (state.version) document.querySelector('#version').textContent = state.version;
  const open = ['paused', 'playing', 'ended'].includes(state.stage) && state.media;
  document.querySelector('#stage').textContent = finishing || state.closing ? '正在安全保存并结束观看…' : state.busy || submitting ? '正在处理你的操作…'
    : state.media?.mediaErrorCode ? '官方播放器加载失败；位置保留'
    : state.stage === 'playing' && state.media?.readyState < 3 ? '官方播放器正在缓冲；等待真实进度'
    : stages[state.stage] ?? '等待官方窗口';
  document.querySelector('#connection').textContent = state.manualMode ? '复用主程序的官方会话' : state.attachedExistingWindow ? '已连接现有官方窗口' : '本地单视频窗口';
  document.querySelector('#current').textContent = open ? time(state.media.currentTime) : '—';
  document.querySelector('#duration').textContent = open ? `视频总长 ${time(state.media.duration)}` : '等待打开视频';
  document.querySelector('#percent').textContent = Number.isFinite(state.percent) ? `${state.percent}%` : '—';
  document.querySelector('#resume').textContent = state.resumeSeconds > 0 ? time(state.resumeSeconds) : '尚无记录';
  document.querySelector('#restore').textContent = state.resumeSeconds > 0 ? `恢复到 ${time(state.resumeSeconds)}（不播放）` : '恢复到记录位置（不播放）';
  document.querySelector('.recovery').hidden=!state.restoreAvailable || state.actionsAvailable === false;
  document.querySelector('#message').textContent = state.sessionMessage || state.message || '打开所选视频后保持暂停。恢复和播放都由你选择。';
  for (const button of document.querySelectorAll('button[data-action]')) {
    const action = button.dataset.action;
    button.disabled = pending || state.busy || state.actionsAvailable === false
      || (action === 'play' && (!open || state.playAllowed === false || state.stage === 'playing' || state.stage === 'ended'))
      || (action === 'pause' && (!open || state.stage !== 'playing'))
      || (action === 'close-video' && !open)
      || (action === 'restore' && !state.restoreAvailable)
      || (action === 'refresh' && state.stage === 'playing');
    if(action==='official')button.hidden=!(state.officialFocusAvailable??Boolean(open));
    if(action==='close-video')button.hidden=!open;
    if(action==='refresh')button.hidden=!open||state.stage==='playing';
  }
  document.querySelector('#view-tools').hidden=state.actionsAvailable===false||![...document.querySelectorAll('#view-tools button')].some(button=>!button.hidden);
  document.querySelector('#view-home').hidden=state.canReturnHome===false;
  document.querySelector('#view-home').disabled=finishing||state.closing;
  document.querySelector('#view-finish').disabled=finishing||state.closing;
  document.querySelector('#view-finish').classList.toggle('primary',state.actionsAvailable === false || state.stage === 'ended');
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
  }
  finally{refreshing=false;}
}
for (const button of document.querySelectorAll('button[data-action]')) button.addEventListener('click', async () => {
  if (submitting||finishing||!connected) return; submitting = true;const revision=++requestRevision;
  if(latestState)render(latestState);
  try { const state = await window.singleVideo.action(button.dataset.action);
    if(revision===requestRevision){submitting = false;render(state);} }
  catch { if(revision===requestRevision){submitting = false;await refresh();document.querySelector('#message').textContent = '操作未完成，请查看官方窗口。';} }
});
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
