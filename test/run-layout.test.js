import { test } from 'node:test';
import assert from 'node:assert/strict';
import { compareLayout, layoutFromInventory } from '../src/run-layout.js';

const original = { complete: true, items: [
  { page: 2, index: 0, title: '同名', progress: 0 },
  { page: 1, index: 0, title: '同名', progress: 0 },
  { page: 3, index: 0, title: '最后一讲', progress: 0 },
] };

test('same titles on different pages have distinct ordered positions and progress may change', () => {
  const layout = layoutFromInventory(original);
  assert.deepEqual(layout, [
    { page: 1, index: 0, title: '同名' },
    { page: 2, index: 0, title: '同名' },
    { page: 3, index: 0, title: '最后一讲' },
  ]);
  assert.deepEqual(compareLayout(layout, { ...original, items: original.items.map(item => ({ ...item, progress: 100 })) }), { ok: true });
});

test('a partial scan, changed card, duplicate position, added or removed video blocks resume', () => {
  const layout = layoutFromInventory(original);
  assert.deepEqual(compareLayout(layout, { ...original, complete: false }), { ok: false, code: 'SCAN_PARTIAL' });
  assert.deepEqual(compareLayout(layout, { ...original, items: [{ ...original.items[0], title: '新视频' }, ...original.items.slice(1)] }), { ok: false, code: 'COURSE_CHANGED' });
  assert.deepEqual(compareLayout(layout, { ...original, items: [...original.items, original.items[0]] }), { ok: false, code: 'COURSE_CHANGED' });
  assert.deepEqual(compareLayout(layout, { ...original, items: original.items.slice(1) }), { ok: false, code: 'COURSE_CHANGED' });
  assert.deepEqual(compareLayout(layout, { ...original, items: [...original.items, { page: 3, index: 1, title: '新增', progress: 0 }] }), { ok: false, code: 'COURSE_CHANGED' });
});

test('a supposedly complete scan with unreadable progress is not safe for playback', () => {
  const broken = { ...original, items: [{ ...original.items[0], progress: null }, ...original.items.slice(1)] };
  assert.throws(() => layoutFromInventory(broken), /SCAN_PARTIAL/);
  assert.deepEqual(compareLayout(layoutFromInventory(original), broken), { ok: false, code: 'SCAN_PARTIAL' });
});
