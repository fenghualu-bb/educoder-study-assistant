import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createAppearanceStore } from '../src/appearance.js';
async function isolated(run) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'educoder-appearance-test-'));
  try { await run(path.join(directory, 'appearance.json')); }
  finally { assert.equal(path.dirname(directory).toLowerCase(), os.tmpdir().toLowerCase()); await fs.rm(directory, { recursive: true, force: true }); }
}
test('appearance follows the system initially and preserves an explicit choice across reopening', async () => isolated(async file => {
  const store = createAppearanceStore(file); assert.equal(await store.get(), 'system');
  await store.set('dark'); assert.equal(await createAppearanceStore(file).get(), 'dark');
  await store.set('system'); assert.equal(await createAppearanceStore(file).get(), 'system');
}));
test('concurrent appearance choices serialize and keep unrelated existing settings', async () => isolated(async file => {
  await fs.writeFile(file, JSON.stringify({ theme: 'light', unrelated: 'preserve' }));
  const store = createAppearanceStore(file); await Promise.all([store.set('dark'), store.set('light')]);
  assert.deepEqual(JSON.parse(await fs.readFile(file, 'utf8')), { theme: 'light', unrelated: 'preserve' });
}));
test('invalid choices and malformed existing appearance files are preserved', async () => isolated(async file => {
  const original = '{ user edited unfinished setting'; await fs.writeFile(file, original);
  const store = createAppearanceStore(file); assert.equal(await store.get(), 'system');
  await assert.rejects(store.set('dark'), /APPEARANCE_INVALID/);
  await assert.rejects(store.set({ theme: 'light' }), /APPEARANCE_INVALID/);
  assert.equal(await fs.readFile(file, 'utf8'), original);
}));
