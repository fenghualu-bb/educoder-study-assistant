import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
const modes = new Set(['system', 'light', 'dark']);

export function createAppearanceStore(file) {
  let sequence = Promise.resolve();
  async function read() {
    try {
      const value = JSON.parse(await fs.readFile(file, 'utf8'));
      if (!value || typeof value !== 'object' || Array.isArray(value) || !modes.has(value.theme)) throw new Error('APPEARANCE_INVALID');
      return value;
    } catch (error) { if (error.code === 'ENOENT') return { theme: 'system' }; throw new Error('APPEARANCE_INVALID'); }
  }
  return {
    async get() { try { return (await read()).theme; } catch { return 'system'; } },
    set(mode) {
      if (!modes.has(mode)) return Promise.reject(new Error('APPEARANCE_INVALID'));
      const next = sequence.catch(() => {}).then(async () => {
        const value = await read();
        if (value.theme === mode) return mode;
        const temporary = `${file}.${randomUUID()}.tmp`;
        await fs.mkdir(path.dirname(file), { recursive: true });
        try {
          await fs.writeFile(temporary, JSON.stringify({ ...value, theme: mode }, null, 2) + '\n', { flag: 'wx' });
          await fs.rename(temporary, file);
        } finally { await fs.rm(temporary, { force: true }); }
        return mode;
      });
      sequence = next; return next;
    },
  };
}
