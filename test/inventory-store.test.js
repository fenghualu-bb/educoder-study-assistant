import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { loadInventory, saveInventory } from '../src/inventory-store.js';

test('saves the latest local scan and replaces it atomically without credentials', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'educoder-inventory-test-'));
  const file = path.join(directory, 'progress.json');
  try {
    assert.equal(await loadInventory(file), null);
    const first = {
      courseUrl: 'https://www.educoder.net/classrooms/SyntheticCourse/video',
      courseTitle: '模拟测试课堂',
      scannedAt: '2026-09-23T12:00:00.000Z',
      pagesScanned: 1,
      complete: false,
      items: [{ page: 1, index: 0, title: '3 线性表', progress: 18 }],
    };
    await saveInventory(file, first);
    assert.deepEqual(await loadInventory(file), first);
    const latest = { ...first, complete: true, items: [{ ...first.items[0], progress: 100 }] };
    await saveInventory(file, latest);
    assert.deepEqual(await loadInventory(file), latest);
    assert.doesNotMatch(await readFile(file, 'utf8'), /password|cookie|token/i);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
