import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { chromium } from 'playwright-core';
import { ChromeCourse } from '../chrome.js';
import { normalizeClassroomUrl } from '../course.js';
import { normalizeTarget, targetUrl, verifyPageSelection, playerIdentity } from './target.mjs';
import { TARGET, sameTarget, ObservationLedger, importObservedEvents, freshLedger, validateLedger } from './ledger.mjs';
import { OfficialPlayerControls } from './official-player-controls.mjs';
const positionSaveErrors = new Set(['EBUSY', 'EIO', 'EACCES', 'EPERM', 'ENOSPC', 'EROFS', 'EMFILE']);
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const errors = {
  RECORD_INVALID: '本地播放记录无法确认，原文件已保留。请交维护者处理。',
  NO_OBSERVED_POSITION: '还没有可确认的本机观看位置；不能用官网百分比换算。',
  TARGET_CHANGED: '限定视频的位置或标题变了，已停止操作。不会打开其他视频。',
  LOGIN_REQUIRED: '请先在官方窗口自行登录头歌，再打开这条视频。',
  CHECKPOINT: '此视频需要在官方页面处理检查点，本入口不会代答。',
  NORMAL_SPEED: '请在官方播放器选择 1 倍速后继续。',
  OPEN_FIRST: '请先打开这条视频。',
  PAUSE_FIRST: '请先暂停，再选择恢复位置。',
  RESTORE_REFUSED: '官方控件未恢复到记录位置，已停止；不会强制修改媒体时间。',
  BRIDGE_TIMEOUT: '官方窗口暂未回应。保留当前状态，可稍后重试。',
  PLAYER_CHANGED: '官方页面已经切换，不能操作其他视频；请重新打开限定视频。',
  PROFILE_BUSY: '专用官方窗口正在被另一程序使用。请先完成该窗口操作，本入口不会关闭它。',
  RECORD_CHANGED: '这条视频的位置已在另一窗口更新，较新记录已保留。可明确放弃本次未保存位置后返回课堂。',
  LEGACY_RECORD_INVALID: '旧单视频记录无法确认，原文件已保留；请交维护者处理。',
  SCAN_BUSY: '请等只读扫描结束后再打开手动观看窗口。',
  PAGE_LOAD_FAILED: '官方页面暂未加载，请检查网络后重新打开；本机观看位置保留。',
  CDN_TIMEOUT: '头歌页面资源暂未加载，请稍后重新打开；本机观看位置保留。',
  LIST_UNAVAILABLE: '所选视频列表暂不可读取，请在官方窗口检查登录和课堂访问权限，再重新扫描。',
  MEDIA_ERROR: '官方播放器加载失败，请关窗保留位置，恢复网络后重新打开；不会自动续播。',
  OFFICIAL_PLAY_UNAVAILABLE: '未找到唯一可用的官方播放控件。请在官方窗口自行操作；本机未开始播放。',
  OFFICIAL_CONTROLS_UNAVAILABLE: '官方播放器控件尚未就绪，未开始播放。请查看官方窗口后主动重试。',
  PLAY_NOT_STARTED: '官方视频尚未真正开始播放。请查看官方窗口，再主动重试。',
  PAUSE_NOT_CONFIRMED: '官方播放器尚未确认暂停。请在官方窗口自行暂停；当前位置保留。',
  VERIFICATION_REQUIRED: '官方要求安全或身份核验，本次播放未开始。请在官方窗口自行处理。',
  PLATFORM_BLOCKED: '官方页面禁止或限制播放，本次操作已停止；不会绕过限制。',
  OTHER_PLAYER: '还有另一个官方视频窗口。请自行关闭其他播放器，再决定是否播放。',
  NATIVE_CONTROL_UNAVAILABLE: '本机官方窗口控件无法使用，未恢复或播放；请检查官方窗口后主动重试。',
  NATIVE_SCRIPT_BLOCKED: '本机系统限制运行官方窗口控件，未恢复或播放；请交维护者检查运行权限，原位置保留。',
  NATIVE_CONTROL_TIMEOUT: '本机官方窗口控件未及时回应，未恢复或播放；请检查官方窗口后主动重试。',
  OWNED_BROWSER_UNAVAILABLE: '未找到本程序拥有的唯一官方浏览器，未恢复或播放；请关闭当前控制后重新打开官方窗口。',
  OFFICIAL_WINDOW_AMBIGUOUS: '无法确认唯一的官方浏览器窗口，未恢复或播放；请自行处理多余窗口后重试。',
  OFFICIAL_PROGRESS_CONTROL_AMBIGUOUS: '官方进度控件无法确认唯一，未恢复或播放；请在官方窗口自行确认。',
  OFFICIAL_PROGRESS_CONTROL_UNAVAILABLE: '官方进度控件无法操作或与当前时长不一致，未恢复或播放；不会改写媒体时间。',
  INVALID_RESTORE_POSITION: '本机恢复位置不在当前视频范围内，未恢复或播放；原记录保留。',
  OFFICIAL_WINDOW_CLOSED: '官方窗口已关闭，已保存位置保留；请主动重新开始。',
  CLOSING: '本次操作已取消，已保存位置保留。',
  ENDED: '这条视频已结束；不会重新播放。',
  INVALID_ACTION: '当前操作不可用，请等待当前播放操作结束。',
  OPERATION_FAILED: '操作未完成，请查看官方窗口；本机位置保留，不会自动重试播放。',
};
Object.assign(errors, {
  MEDIA_NOT_READY: '官方视频时长或媒体暂未就绪，请检查官方窗口后重试；已保存位置保留。',
  PAGE_RESET: '官方页面返回了主页或课堂页，请重新打开所选视频；已保存位置保留。',
  MEDIA_UNSUPPORTED: '官方播放器无法使用当前媒体，已暂停；请在官方页面确认，不会绕过限制。',
  MEDIA_NETWORK_ERROR: '官方媒体连接暂时中断，请等连接恢复后重试；已保存位置保留。',
  MEDIA_DECODE_ERROR: '官方媒体暂未成功解码，请稍后重新打开所选视频；已保存位置保留。',
});
const readinessErrors = Object.freeze(['PAGE_LOAD_FAILED', 'CDN_TIMEOUT', 'LIST_UNAVAILABLE', 'MEDIA_NETWORK_ERROR', 'MEDIA_DECODE_ERROR',
  'MEDIA_NOT_READY', 'PAGE_RESET', 'PLAY_NOT_STARTED', 'OFFICIAL_PLAY_UNAVAILABLE', 'OFFICIAL_CONTROLS_UNAVAILABLE', 'OFFICIAL_PROGRESS_CONTROL_UNAVAILABLE']);
function resetPage(urlValue, target) {
  try {
    const url = new URL(urlValue);
    return url.origin === 'https://www.educoder.net' && !url.username && !url.password
      && (url.pathname === '/' || url.pathname === '/classrooms' || url.pathname === '/classrooms/'
        || new RegExp(`^/classrooms/${target.classroomId}/?(?:video/?)?$`).test(url.pathname));
  } catch { return false; }
}
export function playbackFailure(error) {
  const code = error?.code ?? error?.message;
  if (Object.hasOwn(errors, code)) return { code, message: errors[code] };
  if (positionSaveErrors.has(code))
    return { code, message: '本机位置尚未保存，原文件保留；请检查后主动重试保存。' };
  if (/Target (?:page, context or browser )?has been closed|Browser.*closed|Session closed/i.test(error?.message ?? '')) {
    return { code: 'OFFICIAL_WINDOW_CLOSED', message: errors.OFFICIAL_WINDOW_CLOSED };
  }
  if (error?.name === 'TimeoutError' || /net::ERR_|Timeout \d+ms|timed out/i.test(error?.message ?? ''))
    return { code: 'PAGE_LOAD_FAILED', message: errors.PAGE_LOAD_FAILED };
  return { code: 'OPERATION_FAILED', message: errors.OPERATION_FAILED };
}
function errorMessage(error) { return playbackFailure(error).message; }
export class SingleController {
  constructor({ dataDir, nativeScript, appData, temporary = os.tmpdir(), connectExistingBridge = true,
    target = TARGET, positionStore, sessionProvider,
    controlsFactory = page => new OfficialPlayerControls(page), nativeProcessFactory = spawn }) {
    this.dataDir = dataDir; this.nativeScript = nativeScript; this.appData = appData;
    this.marker = path.join(temporary, 'EducoderSingleVideoAcceptance/bridge.json');
    this.recordFile = path.join(dataDir, 'observed-position.json');
    this.target = normalizeTarget(target); this.courseTitle = target.courseTitle ?? '所选课堂';
    this.expectedPageLayout = target.pageLayout; this.officialUrl = targetUrl(this.target);
    this.positionStore = positionStore; this.sessionProvider = sessionProvider; this.ownsContext = !sessionProvider;
    this.ledger = new ObservationLedger(freshLedger(this.target)); this.bridge = null; this.context = null; this.page = null; this.player = null;
    this.boundPlayerUrl = null; this.media = null; this.percent = null; this.stage = 'not-open'; this.message = '';
    this.ownedPlayer = null; this.pendingPlay = null; this.pendingPlayClose = null;
    this.busy = false; this.disposed = false; this.touched = false; this.sequence = Promise.resolve();
    this.saveFailureCleanupComplete = false;
    this.connectExistingBridge = connectExistingBridge && !positionStore && !sessionProvider;
    this.controlsFactory = controlsFactory;
    this.nativeProcessFactory = nativeProcessFactory;
    this.playerControls = null;
  }
  async init() {
    await fs.mkdir(this.dataDir, { recursive: true });
    try {
      if (this.positionStore) {
        this.record = await this.positionStore.load(this.target);
        this.ledger = new ObservationLedger(this.record.observation, this.record.target);
        this.savedValue = JSON.stringify([this.ledger.value, this.record.playerIdentity]);
      } else this.ledger = new ObservationLedger(validateLedger(JSON.parse(await fs.readFile(this.recordFile, 'utf8')), this.target));
    } catch (error) { if (error.code !== 'ENOENT') {
      const failure = playbackFailure(error);
      this.recordError = true; this.recordErrorCode = failure.code; this.message = failure.message;
    } }
    try {
      if (!this.connectExistingBridge) throw new Error('BRIDGE_DISABLED');
      const marker = JSON.parse(await fs.readFile(this.marker, 'utf8'));
      if (!Number.isSafeInteger(marker.pid) || marker.pid < 1 || !path.isAbsolute(marker.directory)) throw new Error('INVALID_BRIDGE');
      const state = JSON.parse(await fs.readFile(path.join(marker.directory, 'state.json'), 'utf8'));
      if (state.pid !== marker.pid || state.courseUrl !== this.officialUrl || !sameTarget(state.target, this.target)
        || Date.now() - Date.parse(state.updatedAt) > 10_000 || state.processEndedAt) throw new Error('STALE_BRIDGE');
      await this.native('check', marker.pid);
      this.bridge = marker;
      const events = (await fs.readFile(path.join(marker.directory, 'events.ndjson'), 'utf8')).trim().split(/\r?\n/).map(line => JSON.parse(line));
      const imported = importObservedEvents(events, state, this.target);
      if (imported.watchedPrefix >= this.ledger.value.watchedPrefix && !this.recordError) this.ledger = new ObservationLedger(imported);
      this.touched = true;
      await this.syncBridge(); await this.persist();
    } catch { /* No live bridge: the bundled controller can open its own official session on a user click. */ }
    await this.tick();
  }
  async persist() {
    if (this.persistError && this.recordError) throw this.persistError;
    if (this.recordError) return;
    if (this.positionStore) {
      const value = JSON.stringify([this.ledger.value, this.record.playerIdentity]);
      if (value === this.savedValue) return;
      try { await this.positionStore.save(this.record, this.ledger.value, this.record.playerIdentity); }
      catch (error) {
        this.persistError = error;
        if (['RECORD_CHANGED', 'RECORD_INVALID', 'LEGACY_RECORD_INVALID'].includes(error.code ?? error.message)) { this.recordError = true; this.recordErrorCode = error.code ?? error.message; }
        throw error;
      }
      this.persistError = null; this.savedValue = value; return;
    }
    const value = JSON.stringify(this.ledger.value, null, 2) + '\n';
    if (value === this.savedValue) return;
    const temporary = `${this.recordFile}.tmp`;
    await fs.writeFile(temporary, value, 'utf8'); await fs.rename(temporary, this.recordFile); this.savedValue = value;
  }
  async native(action, ownerPid = this.bridge?.pid ?? process.pid, seconds = 0, duration = this.media?.duration ?? 0) {
    if (action === 'restore' && !this.bridge && this.positionStore && this.playerControls?.restorePosition) {
      this.assertPlayer();
      if (!this.verifiedPlayer || this.ownedPlayer !== this.player || ownerPid !== process.pid) throw new Error('PLAYER_CHANGED');
      return this.playerControls.restorePosition(seconds, duration, () => { this.checkOperation(); this.assertPlayer(); });
    }
    return new Promise((resolve, reject) => {
      const child = this.nativeProcessFactory('powershell.exe', ['-NoProfile', '-NonInteractive', '-File', this.nativeScript,
        '-OwnerPid', String(ownerPid), '-Action', action, '-Seconds', String(seconds), '-Duration', String(duration)],
        { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
      let output = '', diagnostic = ''; const timeout = setTimeout(() => { child.kill(); reject(new Error('NATIVE_CONTROL_TIMEOUT')); }, 20_000);
      child.stdout.on('data', bytes => { output += bytes.toString('utf8'); });
      child.stderr.on('data', bytes => { diagnostic = (diagnostic + bytes.toString('utf8')).slice(0, 16_384); });
      child.once('error', () => { clearTimeout(timeout); reject(new Error('NATIVE_CONTROL_UNAVAILABLE')); });
      child.once('close', code => {
        clearTimeout(timeout);
        if (code !== 0) {
          const reason = ['OWNED_BROWSER_UNAVAILABLE', 'OFFICIAL_WINDOW_AMBIGUOUS', 'OFFICIAL_PROGRESS_CONTROL_AMBIGUOUS',
            'OFFICIAL_PROGRESS_CONTROL_UNAVAILABLE', 'INVALID_RESTORE_POSITION'].find(value => new RegExp(`(?:^|[^A-Z0-9_])${value}(?:[^A-Z0-9_]|$)`).test(diagnostic));
          const blocked = /PSSecurityException|UnauthorizedAccess|running scripts is disabled|禁止运行脚本/.test(diagnostic);
          reject(new Error(reason ?? (blocked ? 'NATIVE_SCRIPT_BLOCKED' : 'RESTORE_REFUSED'))); return;
        }
        try { resolve(JSON.parse(output.replace(/^\uFEFF/, '').trim())); }
        catch { reject(new Error('RESTORE_REFUSED')); }
      });
    });
  }
  async syncBridge() {
    const state = JSON.parse(await fs.readFile(path.join(this.bridge.directory, 'state.json'), 'utf8'));
    if (!sameTarget(state.target, this.target) || state.courseUrl !== this.officialUrl || state.pid !== this.bridge.pid || state.processEndedAt) throw new Error('PLAYER_CHANGED');
    this.bridgeState = state;
    this.stage = ['player-interrupted', 'single-video-selected'].includes(state.stage) ? 'video-closed'
      : state.media?.ended ? 'ended' : state.media?.paused ? 'paused' : state.media ? 'playing' : 'not-open';
    this.media = state.media;
    if (Number.isFinite(state.platformProgress)) this.percent = state.platformProgress;
  }
  async bridgeCommand(action) {
    const id = randomUUID();
    await fs.writeFile(path.join(this.bridge.directory, 'command.json'), JSON.stringify({ id, action }));
    const deadline = Date.now() + 100_000;
    while (Date.now() < deadline) {
      await delay(200); await this.syncBridge();
      if (this.bridgeState.commandId === id) {
        if (this.bridgeState.commandError) throw new Error(this.bridgeState.commandError);
        return;
      }
    }
    throw new Error('BRIDGE_TIMEOUT');
  }
  assertPlayer() {
    if (!this.player || this.player.isClosed()) throw new Error('OPEN_FIRST');
    if (this.player.url() !== this.boundPlayerUrl) {
      let url;
      try { url = new URL(this.player.url()); } catch { throw new Error('PLAYER_CHANGED'); }
      if (url.origin === 'https://www.educoder.net' && /^\/(?:login|signin|users?\/login)(?:\/|$)/i.test(url.pathname)) throw new Error('LOGIN_REQUIRED');
      if (this.ownedPlayer === this.player && resetPage(url.href, this.target)) throw new Error('PAGE_RESET');
      throw new Error('PLAYER_CHANGED');
    }
  }
  watchPlayerNetwork(player) {
    this.clearPlayerNetworkWatch(); this.mediaNetworkFailure = false;
    const failed = request => {
      if (this.player !== player || this.ownedPlayer !== player || this.disposed) return;
      if (request.resourceType() !== 'media') return;
      if (/net::ERR_(?:INTERNET_DISCONNECTED|NETWORK_CHANGED|CONNECTION_[A-Z_]+|NAME_NOT_RESOLVED|TIMED_OUT|FAILED|HTTP_RESPONSE_CODE_FAILURE)/.test(request.failure()?.errorText ?? '')) this.mediaNetworkFailure = true;
    };
    player.on?.('requestfailed', failed); this.playerNetworkWatch = { player, failed };
  }
  clearPlayerNetworkWatch() {
    if (this.playerNetworkWatch) this.playerNetworkWatch.player.off?.('requestfailed', this.playerNetworkWatch.failed);
    this.playerNetworkWatch = null;
  }
  mediaFailureCode(media) {
    if (media?.mediaErrorCode === 2 || (media?.mediaErrorCode === 4 && this.mediaNetworkFailure)) return 'MEDIA_NETWORK_ERROR';
    if (media?.mediaErrorCode === 3) return 'MEDIA_DECODE_ERROR';
    return media?.mediaErrorCode === 4 ? 'MEDIA_UNSUPPORTED' : 'MEDIA_ERROR';
  }
  async readMedia() {
    this.assertPlayer();
    const sampledPlayer = this.player;
    const check = () => {
      if (this.player !== sampledPlayer) throw new Error('PLAYER_CHANGED');
      if (sampledPlayer.isClosed()) throw new Error('OFFICIAL_WINDOW_CLOSED');
      this.assertPlayer();
    };
    const videos = sampledPlayer.locator('video');
    if (typeof videos.count === 'function') {
      const count = await videos.count(); check();
      if (count !== 1) throw new Error(count === 0 ? 'MEDIA_NOT_READY' : 'PLAYER_CHANGED');
    }
    const media = await videos.evaluate(video => {
      const watched = document.body.innerText.match(/观看\s*(\d{2}:\d{2}:\d{2})\s*\/\s*(\d{2}:\d{2}:\d{2})/);
      return { currentTime: video.currentTime, duration: video.duration, paused: video.paused, ended: video.ended,
        playbackRate: video.playbackRate, readyState: video.readyState, officialWatched: watched?.[1] ?? null,
        officialTotal: watched?.[2] ?? null, mediaErrorCode: video.error?.code ?? null };
    });
    check(); return media;
  }
  async setPlaying(playing) {
    this.assertPlayer();
    if (!playing) {
      await this.player.bringToFront();
      this.playerControls ??= this.controlsFactory(this.player);
      if (!this.playerControls.setPlaying) throw new Error('OFFICIAL_PLAY_UNAVAILABLE');
      await this.playerControls.setPlaying(false); return;
    }
    this.checkOperation();
    const attempt = { player: this.player, phase: 'focus', cancelled: false,
      owned: !this.bridge && this.verifiedPlayer && this.player === this.ownedPlayer && this.media?.paused && !this.media.ended };
    this.pendingPlay = attempt;
    const check = () => {
      this.checkOperation();
      if (attempt.cancelled) throw new Error('CLOSING');
      if (this.player !== attempt.player) throw new Error('PLAYER_CHANGED');
    };
    try {
      check(); await attempt.player.bringToFront(); check(); this.assertPlayer();
      this.playerControls ??= this.controlsFactory(attempt.player);
      if (!this.playerControls.setPlaying) throw new Error('OFFICIAL_PLAY_UNAVAILABLE');
      attempt.phase = 'controls';
      await this.playerControls.setPlaying(true, { checkOperation: check,
        onClickStarted: () => { check(); attempt.phase = 'click'; },
        onClickFinished: () => { attempt.phase = 'awaiting-media'; },
        onPlaybackConfirmed: () => { check(); attempt.phase = 'playing-confirmed'; this.touched = true; } });
      check();
    } catch (error) {
      check(); throw error;
    } finally {
      await attempt.close?.catch(() => {});
      if (this.pendingPlay === attempt) this.pendingPlay = null;
    }
  }
  cancelPendingPlay(attempt = this.pendingPlay) {
    if (!attempt || attempt.cancelled) return;
    attempt.cancelled = true;
    // A returned UI click may still have an asynchronous official play handler.
    // Close immediately until real media playback has been confirmed; after
    // confirmation disposal samples, pauses and saves through the normal path.
    if (attempt.phase === 'playing-confirmed' || !attempt.owned || this.player !== attempt.player || attempt.player.isClosed()) return;
    try { attempt.close = Promise.resolve(attempt.player.close()); }
    catch (error) { attempt.close = Promise.reject(error); }
    this.pendingPlayClose = attempt.close;
    attempt.close.catch(() => {});
  }
  requestStop() { this.operationCancelled = true; this.observationEpoch = (this.observationEpoch ?? 0) + 1; this.cancelPendingPlay(); }
  checkOperation() { if (this.disposed || this.operationCancelled) throw new Error('CLOSING'); }
  async inspectPageRestrictions(page = this.player) {
    if (!page || page.isClosed()) throw new Error('OFFICIAL_WINDOW_CLOSED');
    let pathname;
    try { const url = new URL(page.url()); if (url.origin !== 'https://www.educoder.net') throw new Error('PLAYER_CHANGED'); pathname = url.pathname; }
    catch { throw new Error('PLAYER_CHANGED'); }
    const body = await page.locator('body').innerText({ timeout: 3000 });
    if (/^\/(?:login|signin|users?\/login)(?:\/|$)/i.test(pathname) || /请先登录|登录已失效|重新登录/.test(body)) throw new Error('LOGIN_REQUIRED');
    if (/请输入.*验证码|请完成.*(?:验证|校验|核验|认证)|需要.*(?:身份核验|人脸识别|实名认证)|拖动滑块|安全验证|账号验证|请.*(?:验证身份|进行验证|滑动拼图)/.test(body)) throw new Error('VERIFICATION_REQUIRED');
    if (/无权限|无观看权限|访问受限|禁止访问|限制.*(?:访问|播放)|课件已锁定|视频已锁定/.test(body)) throw new Error('PLATFORM_BLOCKED');
    return body;
  }
  async inspectPlaybackSafety() {
    await this.inspectPageRestrictions();
    this.assertPlayer();
    const pathname = new URL(this.player.url()).pathname;
    const body = await this.player.locator('body').innerText({ timeout: 3000 });
    if (/^\/(?:login|signin|users?\/login)(?:\/|$)/i.test(pathname) || /请先登录|登录已失效|重新登录/.test(body)) throw new Error('LOGIN_REQUIRED');
    if (/请输入.*验证码|请完成.*(?:验证|核验|认证)|需要.*(?:身份核验|人脸识别|实名认证)|拖动滑块|滑块验证|人机验证|请.*(?:验证身份|身份认证|活体检测)/.test(body)) throw new Error('VERIFICATION_REQUIRED');
    if (/无权访问|无观看权限|访问受限|禁止播放|不允许.*播放|课件不存在|视频不存在/.test(body)) throw new Error('PLATFORM_BLOCKED');
    if (this.checkpoint || /试题总数\s*[1-9]/.test(body) || !body.includes('暂无检查点')) throw new Error('CHECKPOINT');
    const players=(this.context?.pages?.()??[]).filter(page=>{try{return !page.isClosed() && new URL(page.url()).origin==='https://www.educoder.net' && /video_info|videoInfo|\/Video\/Detail\//i.test(new URL(page.url()).pathname);}catch{return false;}});
    if (players.length>1) throw new Error('OTHER_PLAYER');
    if (this.media?.mediaErrorCode) throw new Error(this.mediaFailureCode(this.media));
  }
  async openOfficial() {
    this.checkOperation();
    if (this.bridge) { await this.native('focus'); return; }
    if (this.sessionProvider) {
      const session = await this.sessionProvider();
      this.checkOperation();
      if (this.context && this.context !== session.context) {
        this.player = null; this.ownedPlayer = null; this.page = null; this.media = null; this.verifiedPlayer = false;
        this.ledger.previous = null; this.stage = 'video-closed';
      }
      this.context = session.context;
      if (this.player && !this.player.isClosed()) { await this.player.bringToFront(); return; }
      if (this.page && !this.page.isClosed()) { await this.page.bringToFront(); return; }
      this.page = await this.context.newPage();
      try {
        this.checkOperation();
        await this.page.goto('https://www.educoder.net/classrooms', { waitUntil: 'domcontentloaded', timeout: 45_000 });
        this.checkOperation(); this.stage = 'official-open'; return;
      } catch (error) { await this.page.close().catch(() => {}); throw error; }
    }
    if (this.context) { await (this.player && !this.player.isClosed() ? this.player : this.page).bringToFront(); return; }
    const executablePath = [process.env['ProgramFiles(x86)'], process.env.ProgramFiles].filter(Boolean)
      .map(base => path.join(base, 'Microsoft/Edge/Application/msedge.exe'));
    let browser;
    for (const candidate of executablePath) { try { await fs.access(candidate); browser = candidate; break; } catch {} }
    if (!browser) throw new Error('请先安装本机 Microsoft Edge。');
    const profile = path.join(this.appData, 'educoder-local-study-control/browser-profile-edge');
    try { this.context = await chromium.launchPersistentContext(profile, { executablePath: browser, headless: false,
      chromiumSandbox: true, viewport: { width: 1280, height: 900 }, acceptDownloads: false }); }
    catch (error) { if (/ProcessSingleton|profile|already in use/i.test(error.message)) throw new Error('PROFILE_BUSY'); throw error; }
    this.page = this.context.pages()[0] ?? await this.context.newPage();
    await this.page.goto('https://www.educoder.net/classrooms', { waitUntil: 'domcontentloaded', timeout: 45_000 });
    this.stage = 'official-open';
  }
  async selectCard() {
    await this.inspectPageRestrictions(this.page);
    const course = new ChromeCourse(this.context, this.page, this.officialUrl);
    try { await course.prepare(); }
    catch (error) { await this.inspectPageRestrictions(this.page); throw error; }
    await this.inspectPageRestrictions(this.page);
    if (normalizeClassroomUrl(this.page.url()) !== this.officialUrl) throw new Error('TARGET_CHANGED');
    while (course.currentPage < this.target.page) if (!await course.nextPage()) throw new Error('TARGET_CHANGED');
    const cards = await course.listCards();
    const page = await this.page.locator('li.ant-pagination-item-active').textContent().catch(() => null);
    const card = verifyPageSelection(this.target, page ? Number(page.trim()) : 1, cards, this.expectedPageLayout);
    const tile = this.page.locator('.ant-card-body').nth(this.target.index);
    const percent = card.progress;
    if (!Number.isFinite(percent) || percent < 0 || percent > 100) throw new Error('TARGET_CHANGED');
    this.percent = percent; return tile;
  }
  async openVideo() {
    this.checkOperation();
    if (this.bridge) {
      if (this.stage !== 'video-closed' && this.media) { await this.native('focus'); return; }
      await this.bridgeCommand('open-same');
      if (this.media && !this.media.paused && !this.media.ended) await this.bridgeCommand('pause');
      this.touched = false; this.ledger.previous = null; return;
    }
    if (this.player && !this.player.isClosed()) { this.assertPlayer(); await this.player.bringToFront(); return; }
    await this.openOfficial(); const tile = await this.selectCard(); this.checkOperation();
    let failed = false, ownedPlayer = null;
    const opened = this.page.waitForEvent('popup', { timeout: 45_000 }).then(async player => {
      ownedPlayer = player;
      if (failed || this.disposed || this.operationCancelled) {
        if (!player.isClosed()) await player.close().catch(() => {});
        throw new Error('CLOSING');
      }
      this.player = player; this.ownedPlayer = player; this.watchPlayerNetwork(player); return player;
    });
    opened.catch(() => {});
    try {
      this.checkOperation(); await tile.locator('[class*="imgWrap"]').click(); await opened;
      this.checkOperation(); await this.player.bringToFront(); this.playerControls = null;
      try { await this.player.locator('video').waitFor({ state: 'attached', timeout: 3000 }); }
      catch (error) {
        await this.inspectPageRestrictions(this.player); this.checkOperation();
        if (this.ownedPlayer === this.player && resetPage(this.player.url(), this.target)) throw new Error('PAGE_RESET');
        if (playbackFailure(error).code === 'PAGE_LOAD_FAILED') throw new Error('MEDIA_NOT_READY');
        throw error;
      }
      this.checkOperation();
      const candidateUrl = new URL(this.player.url());
      if (candidateUrl.origin === 'https://www.educoder.net'
        && /^\/(?:login|signin|users?\/login)(?:\/|$)/i.test(candidateUrl.pathname)) throw new Error('LOGIN_REQUIRED');
      if (resetPage(candidateUrl.href, this.target)) {
        await this.inspectPageRestrictions(this.player); this.checkOperation(); throw new Error('PAGE_RESET');
      }
      this.boundPlayerUrl = this.player.url();
      const identity = playerIdentity(this.boundPlayerUrl, this.target);
      // A URL identity conflict needs no page contents or media controls. In
      // particular, do not pause an autoplaying different video before refusing.
      if (this.record?.playerIdentity && JSON.stringify(this.record.playerIdentity) !== JSON.stringify(identity)) throw new Error('PLAYER_CHANGED');
      await this.inspectPageRestrictions(this.player); this.checkOperation(); this.assertPlayer();
      this.media = await this.readMedia();
      if (!this.media.paused) { await this.setPlaying(false); this.media = await this.readMedia(); }
      if (!this.media.paused && !this.media.ended) throw new Error('RESTORE_REFUSED');
      try { await this.player.waitForFunction(() => Number.isFinite(document.querySelector('video')?.duration)
        && document.querySelector('video').duration > 0 && document.querySelector('video').readyState >= 2
        && !document.querySelector('video').error, null, { timeout: 3000 }); }
      catch (error) {
        this.checkOperation(); await this.inspectPageRestrictions(this.player); this.assertPlayer();
        const latest = await this.readMedia();
        if (latest.mediaErrorCode) throw new Error(this.mediaFailureCode(latest));
        if (playbackFailure(error).code === 'PAGE_LOAD_FAILED') throw new Error('MEDIA_NOT_READY');
        throw error;
      }
      this.media = await this.readMedia();
      if (this.record?.playerIdentity && JSON.stringify(this.record.playerIdentity) !== JSON.stringify(identity)) throw new Error('PLAYER_CHANGED');
      if (this.ledger.value.duration > 0 && Math.abs(this.ledger.value.duration - this.media.duration) > 1) throw new Error('PLAYER_CHANGED');
      const body = await this.player.locator('body').innerText();
      this.checkpoint = /试题总数\s*[1-9]/.test(body) || !body.includes('暂无检查点');
      if (this.record) this.record.playerIdentity = identity;
      this.verifiedDuration = this.media.duration;
      if (this.ledger.value.duration === 0) this.ledger.value.duration = this.media.duration;
      this.checkOperation(); this.verifiedPlayer = true; this.touched = false; this.stage = 'paused'; this.ledger.previous = null;
      this.readinessFailure = null;
      this.playerControls = null;
      this.muteBaseline = null; this.speedConfirmed = false;
    } catch (error) {
      failed = true;
      if (this.playerNetworkWatch?.player === ownedPlayer) this.clearPlayerNetworkWatch();
      if (ownedPlayer && !ownedPlayer.isClosed()) await ownedPlayer.close().catch(() => {});
      if (this.player === ownedPlayer) this.player = null;
      if (this.ownedPlayer === ownedPlayer) this.ownedPlayer = null;
      this.verifiedPlayer = false; this.media = null; this.stage = 'video-closed'; throw error;
    }
  }
  async sample() {
    const epoch = this.observationEpoch;
    const sampledPlayer = this.player;
    if (this.bridge) await this.syncBridge();
    else if (this.player && !this.player.isClosed()) {
      if (this.positionStore && !this.verifiedPlayer) {
        // The periodic sampler may identify a reset before another user action.
        // Preserve that safe classification until re-identification succeeds;
        // first inspect the current URL so login/other-video changes still win.
        this.assertPlayer(); throw new Error(this.readinessFailure ?? 'PLAYER_CHANGED');
      }
      try {
        const sampled = await this.readMedia();
        if (epoch !== this.observationEpoch) throw new Error('CLOSING');
        this.media = sampled;
      }
      catch (error) {
        this.ledger.previous = null;
        if (playbackFailure(error).code !== 'CLOSING' && this.player === sampledPlayer) {
          const failure = playbackFailure(error).code;
          this.readinessFailure = readinessErrors.includes(failure) ? failure : null;
          this.media = null; this.stage = 'video-closed'; this.verifiedPlayer = false;
        }
        throw error;
      }
      const expectedDuration = this.verifiedDuration ?? this.ledger.value.duration;
      if (this.positionStore && expectedDuration > 0 && Number.isFinite(this.media.duration)
        && this.media.duration > 0 && Math.abs(expectedDuration - this.media.duration) > 1) {
        this.ledger.previous = null; throw new Error('PLAYER_CHANGED');
      }
      if (this.media.mediaErrorCode) {
        this.ledger.previous = null;
        throw new Error(this.mediaFailureCode(this.media));
      }
      if (!Number.isFinite(this.media.duration) || this.media.duration <= 0
        || (this.media.readyState !== undefined && this.media.readyState < 2)) {
        this.ledger.previous = null; throw new Error('MEDIA_NOT_READY');
      }
      this.stage = this.media.ended ? 'ended' : this.media.paused ? 'paused' : 'playing';
      if (this.media.mediaErrorCode) this.message = errors.MEDIA_ERROR;
    } else if (this.player) { this.stage = 'video-closed'; this.media = null; }
    if (!this.recordError && !['not-open', 'video-closed', 'official-open'].includes(this.stage)) this.ledger.observe(this.media, Date.now());
  }
  async tick() {
    if (this.disposed) return;
    this.ticking = (async () => {
      if (!this.busy) { try { await this.sample(); await this.persist(); } catch (error) { this.message = errorMessage(error); } }
    })();
    await this.ticking; this.ticking = null;
    if (!this.disposed) this.timer = setTimeout(() => this.tick(), 1000);
  }
  canDiscardSaveFailure() {
    const closed = page => !page || (typeof page.isClosed === 'function' && page.isClosed());
    return Boolean(this.saveFailureCleanupComplete && this.disposed && this.positionStore && !this.bridge
      && !this.busy && !this.pendingPlay && !this.ticking && closed(this.player) && closed(this.page)
      && positionSaveErrors.has(this.persistError?.code));
  }
  status() {
    const playBlockedReason = this.recordError ? this.recordErrorCode ?? 'RECORD_INVALID'
      : this.checkpoint ? 'CHECKPOINT' : this.media?.mediaErrorCode ? this.mediaFailureCode(this.media)
      : this.positionStore && !this.verifiedPlayer ? 'OPEN_FIRST'
      : this.media && this.media.playbackRate !== 1 ? 'NORMAL_SPEED' : null;
    return { target: this.target.title, classroomId: this.target.classroomId,
      page: this.target.page, index: this.target.index, courseTitle: this.courseTitle, stage: this.stage,
      media: this.media, percent: this.percent, resumeSeconds: Math.floor(this.ledger.value.position),
      confirmedWatchedSeconds: Math.floor(this.ledger.value.watchedPrefix), confirmedWatchedPrefix: this.ledger.value.watchedPrefix, busy: this.busy, message: this.message,
      restoreAvailable: !this.recordError && !this.checkpoint && this.ledger.value.position >= 1 && this.stage === 'paused',
      playAllowed: !playBlockedReason, playBlockedReason, manualMode: Boolean(this.sessionProvider),
      officialFocusAvailable: Boolean(this.bridge || (this.player && !this.player.isClosed()) || (this.page && !this.page.isClosed())),
      discardAvailable: Boolean(this.recordError || this.canDiscardSaveFailure()), actionsAvailable: !this.disposed && !this.recordError,
      attachedExistingWindow: Boolean(this.bridge), actionError: this.actionError ?? null };
  }
  async act(action) {
    if (!['official', 'open', 'play', 'pause', 'close-video', 'restore', 'beginning', 'refresh'].includes(action)) throw new Error('INVALID_ACTION');
    if (this.disposed) throw new Error('CLOSING');
    if (this.busy) return this.status();
    this.busy = true; this.message = ''; this.actionError = null;
    await this.ticking?.catch(() => {});
    try {
      if (action === 'official') await this.openOfficial();
      else if (action === 'open') {
        if (this.recordError) throw new Error(this.recordErrorCode ?? 'RECORD_INVALID');
        await this.openVideo(); this.message = this.checkpoint ? errors.CHECKPOINT
          : '已打开所选视频，保持暂停。可选择恢复位置，或主动点击播放。';
      }
      else if (action === 'play') {
        this.checkOperation(); await this.sample(); if (!this.media || ['not-open', 'video-closed'].includes(this.stage)) throw new Error('OPEN_FIRST');
        if (this.recordError) throw new Error(this.recordErrorCode ?? 'RECORD_INVALID');
        if (this.media.mediaErrorCode) throw new Error('MEDIA_ERROR');
        if (this.checkpoint) throw new Error('CHECKPOINT');
        if (!this.bridge) await this.inspectPlaybackSafety();
        if (this.media.playbackRate !== 1) throw new Error('NORMAL_SPEED');
        if (this.media.ended) throw new Error('ENDED');
        const before = this.media.currentTime;
        this.checkOperation(); if (this.bridge) await this.bridgeCommand('play');
        else await this.setPlaying(true);
        await this.sample(); this.checkOperation();
        if (!this.media || this.media.paused || this.media.ended || this.media.readyState < 2
          || !(this.media.currentTime > before + .01)) throw new Error('PLAY_NOT_STARTED');
        this.touched = true;
      } else if (action === 'pause') {
        await this.sample(); if (!this.media || this.stage === 'video-closed') throw new Error('OPEN_FIRST');
        if (this.bridge) await this.bridgeCommand('pause'); else if (!this.media.paused && !this.media.ended) await this.setPlaying(false);
        await this.sample(); if (!this.media.paused && !this.media.ended) throw new Error('PAUSE_NOT_CONFIRMED');
        if (this.touched) this.ledger.capture(this.media);
      } else if (action === 'close-video') {
        await this.sample(); if (!this.media || this.stage === 'video-closed') throw new Error('OPEN_FIRST');
        if (this.bridge) await this.bridgeCommand('close-player');
        else { if (!this.media.paused && !this.media.ended) await this.setPlaying(false); this.media = await this.readMedia(); await this.player.close(); }
        if (this.touched) this.ledger.capture(this.media);
        this.stage = 'video-closed'; this.media = null; this.ledger.previous = null;
        this.message = '位置已保留。重开不会自动恢复或播放，请自行选择。';
      } else if (action === 'restore' || action === 'beginning') {
        this.checkOperation();
        if (this.recordError) throw new Error(this.recordErrorCode ?? 'RECORD_INVALID');
        if (this.checkpoint) throw new Error('CHECKPOINT');
        await this.sample(); if (!this.media || this.stage !== 'paused' || !this.media.paused) throw new Error('PAUSE_FIRST');
        const seconds = action === 'beginning' ? 0 : this.ledger.restorePosition();
        let expectedSeconds=seconds;
        if (action !== 'beginning' || this.media.currentTime > 0.05) {
          let restored;
          try { restored=await this.native('restore', this.bridge?.pid ?? process.pid, seconds, this.media.duration); }
          catch (error) {
            if (action !== 'beginning' || this.bridge || !this.positionStore || !this.verifiedPlayer
              || this.ownedPlayer !== this.player || (error.code ?? error.message) !== 'OFFICIAL_PROGRESS_CONTROL_UNAVAILABLE') throw error;
            // The official range may ignore its unchanged minimum value. Reopen
            // this owned video normally; never nudge forward or write media time.
            this.checkOperation(); this.assertPlayer(); const reopenPlayer=this.player;
            await this.persist(); this.checkOperation(); this.assertPlayer();
            if (!this.verifiedPlayer || this.player !== reopenPlayer || this.ownedPlayer !== reopenPlayer) throw new Error('PLAYER_CHANGED');
            await reopenPlayer.close(); this.checkOperation();
            if (!reopenPlayer.isClosed() || this.player !== reopenPlayer || this.ownedPlayer !== reopenPlayer) throw new Error('PLAYER_CHANGED');
            this.media=null; this.stage='video-closed'; this.ledger.previous=null; this.touched=false;
            this.verifiedPlayer=false; this.playerControls=null;
            await this.openVideo(); this.checkOperation(); await this.inspectPlaybackSafety(); this.checkOperation(); this.assertPlayer();
            if (!this.media?.paused || this.media.currentTime > .05) throw new Error('RESTORE_REFUSED');
          }
          if(!this.bridge&&this.positionStore&&this.playerControls?.restorePosition&&Number.isFinite(restored?.restoredSeconds)){
            if(restored.restoredSeconds<seconds-1.01||restored.restoredSeconds>seconds+.05)throw new Error('RESTORE_REFUSED');
            expectedSeconds=restored.restoredSeconds;
          }
        }
        this.checkOperation();
        const deadline = Date.now() + 8_000;
        do { await delay(250); this.checkOperation(); await this.sample(); this.checkOperation(); } while (this.media && Math.abs(this.media.currentTime - expectedSeconds) > 0.5 && Date.now() < deadline);
        if (!this.media || !Number.isFinite(this.media.currentTime) || this.media.currentTime < 0
          || Math.abs(this.media.currentTime - expectedSeconds) > 0.5 || !this.media.paused
          || action === 'beginning' && this.media.currentTime > .05) throw new Error('RESTORE_REFUSED');
        this.ledger.previous = null;
        if (action === 'restore') this.touched = true;
        this.message = action === 'restore' ? '已通过官方控件恢复，仍保持暂停。请主动点击播放。' : '已通过官方控件回到起点，仍保持暂停。';
      } else if (action === 'refresh') {
        await this.sample(); if (this.stage === 'playing') throw new Error('请先暂停，再读取官网保存进度。');
        if (this.bridge) await this.bridgeCommand('verify-selected');
        else { if (!this.page) throw new Error('OPEN_FIRST'); await this.selectCard(); }
      }
      await this.persist();
    } catch (error) { this.actionError = playbackFailure(error).code; this.message = errorMessage(error); }
    finally { this.busy = false; }
    return this.status();
  }
  async dispose({ discardUnsavedPosition = false } = {}) {
    this.saveFailureCleanupComplete = false;
    this.requestStop();
    this.disposed = true; clearTimeout(this.timer);
    await this.pendingPlayClose?.catch(() => {});
    await this.ticking?.catch(() => {});
    await this.sample().catch(() => {});
    try {
      if (this.media && !this.media.paused && !this.media.ended) {
        if (this.bridge) await this.bridgeCommand('pause'); else await this.setPlaying(false);
        await this.sample();
      }
      if (!discardUnsavedPosition) {
        if (this.touched) this.ledger.capture(this.media);
        await this.persist();
      }
    }
    finally {
      this.clearPlayerNetworkWatch();
      if (!this.bridge && this.ownsContext) await this.context?.close();
      else if (!this.bridge) {
        if (this.player && !this.player.isClosed()) await this.player.close();
        if (this.page && !this.page.isClosed()) await this.page.close();
      }
      const closed = page => !page || (typeof page.isClosed === 'function' && page.isClosed());
      this.saveFailureCleanupComplete = !this.bridge && !this.busy && !this.pendingPlay && !this.ticking
        && closed(this.player) && closed(this.page);
    }
  }
}
