import { LEGACY_TARGET, normalizeTarget, sameTarget } from './target.mjs';
export const TARGET = LEGACY_TARGET;
export { sameTarget };
export const officialUrl = `https://www.educoder.net/classrooms/${TARGET.classroomId}/video`;
export function freshLedger(target = TARGET) {
  return { version: 1, target: normalizeTarget(target), watchedPrefix: 0, position: 0, duration: 0 };
}
export function validateLedger(value, target = TARGET) {
  if (value?.version !== 1 || !sameTarget(value.target, target)
    || !Number.isFinite(value.watchedPrefix) || !Number.isFinite(value.position) || !Number.isFinite(value.duration)
    || value.position < 0 || value.watchedPrefix < 0 || value.duration < value.watchedPrefix || value.position > value.duration) throw new Error('RECORD_INVALID');
  const ranges = value.watchedRanges;
  if (ranges !== undefined && (!Array.isArray(ranges) || ranges.length > 4096 || ranges.some((range, i) =>
    !Array.isArray(range) || range.length !== 2 || !range.every(Number.isFinite) || range[0] < 0
    || range[1] < range[0] || range[1] > value.duration || (i > 0 && range[0] <= ranges[i - 1][1])))) throw new Error('RECORD_INVALID');
  if (value.position > value.watchedPrefix && !ranges?.some(([start, end]) => value.position >= start && value.position <= end)) throw new Error('RECORD_INVALID');
  return { version: 1, target: normalizeTarget(target), watchedPrefix: value.watchedPrefix, position: value.position,
    duration: value.duration, ...(ranges === undefined ? {} : { watchedRanges: ranges.map(range => [...range]) }) };
}
export function importObservedEvents(events, current, target = TARGET) {
  const value = freshLedger(target);
  let start = null;
  for (const event of events) {
    if (!sameTarget(event.target, target) || !event.media || event.media.playbackRate !== 1) continue;
    const media = event.media;
    if (!Number.isFinite(media.currentTime) || !Number.isFinite(media.duration) || media.duration <= 0) continue;
    value.duration = media.duration;
    if (event.event === 'normal-speed-play') start = event;
    else if (start && ['official-pause', 'same-video-player-closed', 'one-video-natural-end'].includes(event.event)) {
      const elapsed = (Date.parse(event.at) - Date.parse(start.at)) / 1000;
      const delta = media.currentTime - start.media.currentTime;
      if (elapsed >= 0 && delta >= 0 && delta <= elapsed + 2
        && start.media.currentTime <= value.watchedPrefix + 1 && media.currentTime <= media.duration) {
        value.watchedPrefix = Math.max(value.watchedPrefix, media.currentTime);
      }
      start = null;
    }
  }
  if (sameTarget(current?.target, target) && current.media?.playbackRate === 1
    && current.media.currentTime >= 0 && current.media.currentTime <= value.watchedPrefix) value.position = current.media.currentTime;
  return validateLedger(value, target);
}
export class ObservationLedger {
  constructor(value = freshLedger(), target = value.target) {
    this.value = validateLedger(value, target); this.previous = null;
    this.ranges = this.value.watchedRanges ?? (this.value.watchedPrefix > 0 ? [[0, this.value.watchedPrefix]] : []);
  }
  observe(media, wallMs) {
    const previous = this.previous;
    this.previous = media && Number.isFinite(media.currentTime) ? { ...media, wallMs } : null;
    if (!this.previous || !previous || previous.paused || previous.playbackRate !== 1 || media.playbackRate !== 1) return;
    const elapsed = (wallMs - previous.wallMs) / 1000;
    const delta = media.currentTime - previous.currentTime;
    if (elapsed < 0 || elapsed > 6 || delta < 0 || delta > elapsed + 0.75
      || !Number.isFinite(media.duration) || previous.currentTime < 0
      || media.currentTime > media.duration) return;
    if (delta <= 0) return;
    // Preserve the bounds of already observed ranges when the same stream
    // reports a slightly shorter duration on replay.
    this.value.duration = Math.max(this.value.duration, media.duration);
    const sorted = [...this.ranges, [previous.currentTime, media.currentTime]].sort((a, b) => a[0] - b[0]);
    const merged = [];
    for (const range of sorted) {
      const last = merged.at(-1);
      if (last && range[0] <= last[1]) last[1] = Math.max(last[1], range[1]); else merged.push([...range]);
    }
    this.ranges = merged; this.value.watchedRanges = merged;
    if (previous.currentTime <= this.value.watchedPrefix + 0.75) this.value.watchedPrefix = Math.max(this.value.watchedPrefix, media.currentTime);
    this.value.position = media.currentTime;
  }
  capture(media) {
    if (media?.playbackRate === 1 && Number.isFinite(media.currentTime)
      && media.currentTime >= 0 && this.ranges.some(([start, end]) => media.currentTime >= start && media.currentTime <= end)) this.value.position = media.currentTime;
  }
  restorePosition() {
    const rounded = Math.floor(this.value.position);
    const seconds = this.ranges.some(([start, end]) => rounded >= start && rounded <= end) ? rounded : this.value.position;
    if (seconds <= 0 || seconds > this.value.duration || !this.ranges.some(([start, end]) => seconds >= start && seconds <= end)) throw new Error('NO_OBSERVED_POSITION');
    return seconds;
  }
}
