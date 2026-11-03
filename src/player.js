import { RunError } from './run-error.js';

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

export function classifyPlayback(snapshot, lastProgressAt, now, stallMs) {
  if (snapshot.error) return 'failed';
  if (snapshot.ended) return 'complete';
  if (now - lastProgressAt > stallMs) return 'stalled';
  return 'playing';
}

export async function watchVideo(player, {
  signal,
  onProgress = () => {},
  stallMs,
  maxElapsedMs = 45 * 60_000,
  pollMs = 3_000,
  now = Date.now,
  delay = sleep,
} = {}) {
  if (signal?.aborted) throw new RunError('STOPPED', 'task stopped');
  await player.play();
  let lastTime = -1;
  const startedAt = now();
  let lastProgressAt = startedAt;

  while (true) {
    if (signal?.aborted) throw new RunError('STOPPED', 'task stopped');
    const snapshot = await player.snapshot();
    if (Number.isFinite(snapshot.currentTime) && snapshot.currentTime > lastTime) {
      lastTime = snapshot.currentTime;
      lastProgressAt = now();
    }
    const idleForMs = now() - lastProgressAt;
    onProgress({ ...snapshot, phase: snapshot.ended ? 'ended' : idleForMs >= 6_000 ? 'buffering' : 'playing', idleForMs });
    const allowedStallMs = stallMs ?? (snapshot.duration >= 180 ? 300_000 : 120_000);
    const state = classifyPlayback(snapshot, lastProgressAt, now(), allowedStallMs);
    if (state === 'complete') return snapshot;
    if (state === 'failed') throw new RunError('MEDIA_ERROR', 'video media error');
    if (now() - startedAt > maxElapsedMs) throw new RunError('MEDIA_TIMEOUT', `video exceeded ${Math.round(maxElapsedMs / 1000)} seconds total`);
    if (state === 'stalled') throw new RunError('MEDIA_STALL', `video stalled for ${Math.round(allowedStallMs / 1000)} seconds without progress`);
    await delay(pollMs);
  }
}
