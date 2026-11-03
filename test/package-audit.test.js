import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { auditPackage, checkAppText, checkArchiveEntries, checkResourceNames } from '../scripts/audit-package.mjs';

test('package privacy catches literal personal targets even when a classroom URL is constructed at runtime', () => {
  assert.equal(checkAppText("const selected = { classroomId: 'PrivateClass123', title: 'Old lesson', page: 1, index: 7 };"), true);
  assert.equal(checkAppText("const selected = { classroomId: 'SyntheticAcceptance', title: '模拟视频', page: 1, index: 0 };"), false);
  assert.equal(checkAppText('const selected = { classroomId: suppliedId };'), false);
});

test('packaging rejects implementation metadata that can contain local paths', () => {
  assert.ok(checkArchiveEntries(['package.json','src/desktop-main.js','src/runtime.js','public/index.html','.superpowers/sdd/task.md']).includes('private source path in app.asar'));
});

const require = createRequire(import.meta.url);
const forge = require('../forge.config.cjs');

const safeEntries = [
  '\\package.json',
  '\\src\\desktop-main.js',
  '\\src\\runtime.js',
  '\\public\\index.html',
  '\\node_modules\\playwright-core\\index.js',
];

test('package audit accepts runtime files without mistaking library code for user data', () => {
  assert.deepEqual(checkArchiveEntries(safeEntries), []);
  assert.deepEqual(checkResourceNames(['app.asar', 'ms-playwright'], false), []);
  assert.deepEqual(checkResourceNames(['app.asar', 'edge-only.marker'], true), []);
});

test('package audit rejects personal profiles, journals, backups and source README', () => {
  const findings = checkArchiveEntries([
    ...safeEntries,
    '\\data\\chrome-profile\\Cookies',
    '\\run-archive\\old.json',
    '\\backup-pre-live-verify-doc.zip',
    '\\README.md',
    '\\.env',
  ]);
  assert.equal(findings.length, 5);
  assert.ok(findings.every((finding) => !finding.includes('Cookies')));
});

test('package audit rejects the offline entitlement reference model from desktop bundles', () => {
  assert.match(checkArchiveEntries([...safeEntries, '\\service\\trial-ledger.js']).join(' '), /private source path/);
  assert.equal(forge.packagerConfig.ignore(fileURLToPath(new URL('../service/trial-ledger.js', import.meta.url))), true);
  assert.equal(forge.packagerConfig.ignore(fileURLToPath(new URL('../src/runtime.js', import.meta.url))), false);
});

test('package audit rejects hard-coded real classroom or video addresses', () => {
  assert.equal(checkAppText('https://www.educoder.net/classrooms/ABCDEFGH/video'), true);
  assert.equal(checkAppText('/video_info?new_video_id=123456'), true);
  assert.equal(checkAppText('https://www.educoder.net/classrooms/${classroomId}/video'), false);
});

test('package audit requires the expected runtime files and rejects extra resources', () => {
  assert.match(checkArchiveEntries(['\\package.json']).join(' '), /runtime/);
  assert.match(checkResourceNames(['app.asar', 'chrome-profile'], true).join(' '), /unexpected resource/);
  assert.match(checkResourceNames(['app.asar'], true).join(' '), /Edge-only marker/);
  assert.match(checkResourceNames(['app.asar'], false).join(' '), /bundled browser/);
  assert.match(checkResourceNames(['app.asar', 'ms-playwright'], true).join(' '), /bundled browser/);
});

test('package audit fails if app.asar is a directory rather than an archive', async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'educoder-package-audit-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  await mkdir(path.join(directory, 'resources', 'app.asar'), { recursive: true });
  const result = await auditPackage(directory, true);
  assert.match(result.findings.join(' '), /app.asar is not a file/);
});

test('single-video native helper is allowed only with that runtime and watching records remain excluded', () => {
  const names = ['app.asar', 'edge-only.marker', 'local-single-video-native-control.ps1'];
  assert.match(checkResourceNames(names, true).join(' '), /unexpected resource/);
  assert.deepEqual(checkResourceNames(names, true, { localSingleVideo: true }), []);
  assert.match(checkResourceNames(['app.asar', 'edge-only.marker'], true, { localSingleVideo: true }).join(' '), /native control/);
  assert.match(checkArchiveEntries([...safeEntries, '\\src\\local-single-video\\observed-position.json']).join(' '), /profile file/);
});
