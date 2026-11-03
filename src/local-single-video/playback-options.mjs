import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

export const officialRates = Object.freeze([1, 1.5, 2]);
export const defaultPlaybackOptions = Object.freeze({ autoMute: false, speedEnabled: false, speed: 1.5 });
export function validatePlaybackPatch(patch) {
  if (!patch || typeof patch !== 'object' || Array.isArray(patch) || !Object.keys(patch).length
    || Object.keys(patch).some(key => !['autoMute', 'speedEnabled', 'speed'].includes(key))
    || ('autoMute' in patch && typeof patch.autoMute !== 'boolean')
    || ('speedEnabled' in patch && typeof patch.speedEnabled !== 'boolean')
    || ('speed' in patch && ![1.5, 2].includes(patch.speed))) throw new Error('PLAYBACK_OPTIONS_INVALID');
  return patch;
}
function validateFile(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || value.version !== 1) throw new Error('PLAYBACK_OPTIONS_INVALID');
  validatePlaybackPatch({ autoMute: value.autoMute, speedEnabled: value.speedEnabled, speed: value.speed });
  return value;
}
export function createPlaybackOptionsStore(file) {
  let sequence = Promise.resolve();
  async function read() {
    try { return validateFile(JSON.parse(await fs.readFile(file, 'utf8'))); }
    catch (error) { if (error.code === 'ENOENT') return { version: 1, ...defaultPlaybackOptions }; throw new Error('PLAYBACK_OPTIONS_INVALID'); }
  }
  const selected = value => ({ autoMute: value.autoMute, speedEnabled: value.speedEnabled, speed: value.speed });
  return {
    async get() { return selected(await read()); },
    set(patch) {
      try { validatePlaybackPatch(patch); } catch (error) { return Promise.reject(error); }
      const next = sequence.catch(() => {}).then(async () => {
        const value = await read(), result = { ...value, ...patch };
        const temporary = `${file}.${randomUUID()}.tmp`;
        await fs.mkdir(path.dirname(file), { recursive: true });
        try {
          await fs.writeFile(temporary, JSON.stringify(result, null, 2) + '\n', { flag: 'wx' });
          await fs.rename(temporary, file);
        } finally { await fs.rm(temporary, { force: true }); }
        return selected(result);
      });
      sequence = next; return next;
    },
  };
}
