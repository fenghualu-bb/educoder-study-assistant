import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const script = fileURLToPath(new URL('../scripts/accept-page2.js', import.meta.url));

test('page acceptance rejects a supplied foreign URL before launching any browser', () => {
  const result = spawnSync(process.execPath, [script, '--execute-page2-once', 'https://example.test/classrooms/Synthetic/video'], { encoding: 'utf8' });
  assert.equal(result.status, 2);
  assert.match(result.stderr, /请输入有效的头歌课堂链接/);
});

test('the internal acceptance script refuses to open Chrome without an explicit one-time flag', () => {
  const result = spawnSync(process.execPath, [script], { encoding: 'utf8', timeout: 5_000 });
  assert.equal(result.status, 2);
  assert.match(result.stderr, /仅供开发验收.*--execute-page2-once/);
});
