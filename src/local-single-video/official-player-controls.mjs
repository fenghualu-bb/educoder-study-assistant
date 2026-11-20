// All writes are normal UI clicks; media properties are read only.
export class OfficialPlayerControls {
  constructor(page) { this.page = page; }
  async usableControl(candidates, code, check = () => {}) {
    const deadline = Date.now() + 3000;
    const usable = candidates.filter({ visible: true }).and(this.page.locator(
      ':not(:disabled):not([aria-disabled="true"]):not([aria-disabled="true"] *)'));
    while (true) {
      check();
      const count = await usable.count(); check();
      if (count > 1) throw new Error(code);
      if (count === 1) {
        const enabled = await usable.isEnabled(); check();
        const disabled = await usable.getAttribute('aria-disabled'); check();
        if (enabled && disabled !== 'true') return usable;
      }
      if (Date.now() >= deadline) throw new Error(code);
      await this.page.waitForTimeout(Math.min(50, Math.max(1, deadline - Date.now()))); check();
    }
  }
  async setPlaying(playing, { checkOperation = () => {}, onClickStarted = () => {}, onClickFinished = () => {}, onPlaybackConfirmed = () => {} } = {}) {
    const check = playing ? checkOperation : () => {};
    check();
    const current = await this.page.locator('video').evaluate(video => ({ paused: video.paused, ended: video.ended, time: video.currentTime }));
    check();
    if (!playing && (current.paused || current.ended)) return;
    if (playing && current.ended) throw new Error('PLAY_NOT_STARTED');
    if (current.paused === playing) {
      const container = await this.controls(check); check();
      const candidates = container.locator('#play, #play-button')
        .or(container.getByRole('button', { name: /^(?:播放|暂停|play|pause)$/i }));
      const button = await this.usableControl(candidates, 'OFFICIAL_PLAY_UNAVAILABLE', check); check();
      const latest = await this.page.locator('video').evaluate(video => ({ paused: video.paused, ended: video.ended })); check();
      if (playing && latest.ended) throw new Error('PLAY_NOT_STARTED');
      if (latest.paused === playing) {
        if (playing) onClickStarted(); check();
        await button.click({ timeout: 3000 });
        if (playing) onClickFinished(); check();
      }
    }
    try {
      await this.page.waitForFunction(({ playing, time }) => {
        const video = document.querySelector('video');
        return video && (playing ? !video.paused && !video.ended && !video.error && video.readyState >= 2
          && video.currentTime > time + .01 : video.paused || video.ended);
      }, { playing, time: current.time }, { timeout: playing ? 20000 : 5000 });
    } catch { check(); throw new Error(playing ? 'PLAY_NOT_STARTED' : 'PAUSE_NOT_CONFIRMED'); }
    check();
    if (playing) onPlaybackConfirmed();
  }
  async controls(check = () => {}) {
    const container = this.page.locator('#video-controls');
    const containers = await container.count(); check();
    if (containers !== 1) throw new Error('OFFICIAL_CONTROLS_UNAVAILABLE');
    const video = this.page.locator('video');
    const videos = await video.count(); check();
    if (videos !== 1) throw new Error('OFFICIAL_CONTROLS_UNAVAILABLE');
    await video.hover({ timeout: 3000 }); check();
    try { await container.waitFor({ state: 'visible', timeout: 3000 }); check(); }
    catch { check(); throw new Error('OFFICIAL_CONTROLS_UNAVAILABLE'); }
    return container;
  }
  async restorePosition(seconds, duration, check = () => {}) {
    if (!Number.isFinite(seconds) || !Number.isFinite(duration) || duration <= 0 || seconds < 0 || seconds > duration)
      throw new Error('INVALID_RESTORE_POSITION');
    const deadline = Date.now() + 3000;
    let matched;
    while (!matched) {
      const latest = await this.page.locator('video').evaluate(video => ({ paused: video.paused, duration: video.duration })); check();
      if (!latest.paused) throw new Error('PAUSE_FIRST');
      if (!Number.isFinite(latest.duration) || latest.duration <= 0) throw new Error('MEDIA_NOT_READY');
      if (Math.abs(latest.duration - duration) > 1) throw new Error('PLAYER_CHANGED');
      const container = await this.controls(check); check();
      const candidates = container.locator('input[type="range"]').filter({ visible: true });
      const count = await candidates.count(); check();
      const matching = [];
      for (let index = 0; index < count; index++) {
        const control = await candidates.nth(index).elementHandle(); check();
        if (!control) continue;
        const range = await control.evaluate(element => ({ min: Number(element.min || 0), max: Number(element.max || 100),
          step: element.step === 'any' ? null : Number(element.step || 1), disabled: element.disabled,
          ariaDisabled: element.getAttribute('aria-disabled') })); check();
        if (range.min === 0 && Number.isFinite(range.max) && range.max > 0 && Math.abs(range.max - latest.duration) <= 2
          && !range.disabled && range.ariaDisabled !== 'true' && await control.isEnabled()) matching.push({ control, range });
        else await control.dispose();
        check();
      }
      if (matching.length > 1) { await Promise.all(matching.map(item => item.control.dispose())); throw new Error('OFFICIAL_PROGRESS_CONTROL_AMBIGUOUS'); }
      if (matching.length === 1) matched = matching[0];
      else {
        if (Date.now() >= deadline) throw new Error('OFFICIAL_PROGRESS_CONTROL_UNAVAILABLE');
        await this.page.waitForTimeout(Math.min(50, Math.max(1, deadline - Date.now()))); check();
      }
    }
    const { control, range } = matched;
    if (seconds > range.max + .5 || range.step === null || !Number.isFinite(range.step) || range.step <= 0 || range.step > 1)
      throw new Error('OFFICIAL_PROGRESS_CONTROL_UNAVAILABLE');
    const before = await this.page.locator('video').evaluate(video => ({ paused: video.paused, ended: video.ended })); check();
    if (!before.paused) throw new Error('PAUSE_FIRST');
    const stillBound = await control.evaluate((element, expected) => {
      const eligible = [...document.querySelectorAll('#video-controls input[type="range"]')].filter(e => {
        const box=e.getBoundingClientRect(),style=getComputedStyle(e);
        return box.width>0&&box.height>0&&style.visibility==='visible'&&style.display!=='none'&&!e.disabled
          &&!e.closest('[aria-disabled="true"]')&&Number(e.min||0)===0&&Math.abs(Number(e.max||100)-expected.duration)<=2;
      });
      return element.isConnected&&eligible.length===1&&eligible[0]===element&&Number(element.max||100)===expected.max
        &&Number(element.step||1)===expected.step;
    },{duration,max:range.max,step:range.step}); check();
    if (!stillBound) throw new Error('OFFICIAL_PROGRESS_CONTROL_AMBIGUOUS');
    const box = await control.boundingBox(); check();
    if (!box || box.width < 32 || box.height <= 0) throw new Error('OFFICIAL_PROGRESS_CONTROL_UNAVAILABLE');
    // The official seek handler uses the pointer's position across the full
    // track. Native thumb/value geometry is different and is not media time.
    const x = box.width * Math.min(seconds, range.max) / range.max;
    // Do not move the pointer inward at an endpoint: on a long video that
    // would seek past a short saved prefix before confirmation can reject it.
    if (x < .5 || x > box.width - .5) throw new Error('OFFICIAL_PROGRESS_CONTROL_UNAVAILABLE');
    await control.click({ position: { x, y: box.height / 2 }, timeout: 3000 }); check();
    try { await this.page.waitForFunction(({seconds,step}) => { const video = document.querySelector('video');
      return video?.paused && video.currentTime >= seconds-step-.01 && video.currentTime <= seconds+.05;
    }, {seconds,step:range.step}, { timeout: 8000 }); check(); }
    catch { check(); throw new Error('RESTORE_REFUSED'); }
    const restoredSeconds=await this.page.locator('video').evaluate(video=>video.currentTime); check();
    if(restoredSeconds<seconds-range.step-.01||restoredSeconds>seconds+.05)throw new Error('RESTORE_REFUSED');
    return { restoredSeconds };
  }
}
