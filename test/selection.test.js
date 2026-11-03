import { test } from 'node:test';
import assert from 'node:assert/strict';
import { pickNext, advance } from '../src/selection.js';

test('skips completed videos and selects the next incomplete one', () => {
  assert.deepEqual(
    pickNext([
      { title: '交运算', progress: 100 },
      { title: '空集', progress: 0 },
    ]),
    { title: '空集', progress: 0 },
  );
});

test('returns null when every video on the page is complete', () => {
  assert.equal(pickNext([{ title: '交运算', progress: 100 }]), null);
});

test('advances only when another page exists', () => {
  assert.equal(advance({ page: 1, hasNext: true }), 2);
  assert.equal(advance({ page: 22, hasNext: false }), null);
});

test('rejects invalid progress data instead of treating it as complete', () => {
  assert.throws(
    () => pickNext([{ title: '未知视频', progress: Number.NaN }]),
    /progress/,
  );
});
