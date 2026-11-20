import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, mkdir, readFile, writeFile, rm, readdir, realpath } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { buildWindowsInstaller } from '../scripts/build-windows-installer.mjs';

let root, installer, payload;
const windowsTest = process.platform === 'win32' ? test : test.skip;
async function run(file, args) {
  return new Promise((resolve, reject) => {
    const process = spawn(file, args, { windowsHide: true });
    let stdout = '', stderr = '';
    process.stdout?.on('data', bytes => { stdout += bytes.toString('utf8'); });
    process.stderr?.on('data', bytes => { stderr += bytes.toString('utf8'); });
    process.on('error', reject);
    process.on('close', code => resolve({ code, stdout, stderr }));
  });
}
before(async () => {
  if (process.platform !== 'win32') return;
  root = await mkdtemp(path.join(await realpath(os.tmpdir()), 'educoder-installer-test-'));
  payload = path.join(root, 'synthetic-package');
  await mkdir(path.join(payload, 'resources'), { recursive: true });
  await writeFile(path.join(payload, 'educoder-local-study-control.exe'), 'synthetic app; never launch');
  await writeFile(path.join(payload, 'resources', 'fixture.txt'), 'synthetic fixture\n');
  installer = path.join(root, 'candidate-setup.exe');
  await buildWindowsInstaller({ packageDir: payload, outputFile: installer, version: '0.1.3-candidate' });
});
after(async () => {
  if (root) {
    assert.equal(path.dirname(path.resolve(root)).toLowerCase(), (await realpath(os.tmpdir())).toLowerCase());
    assert.match(path.basename(root), /^educoder-installer-test-/);
    await rm(root, { recursive: true, force: true });
  }
});

windowsTest('installer verifies its embedded payload and version without installing or starting anything', async () => {
  const result = await run(installer, ['--verify-only']);
  assert.equal(result.code, 0);
  assert.deepEqual((await readdir(root)).sort(), ['candidate-setup.exe', 'synthetic-package']);
  const versionScript = path.join(root, 'inspect-version.ps1');
  await writeFile(versionScript, 'param([string]$Path)\n$item = Get-Item -LiteralPath $Path\n$item.VersionInfo.FileVersion\n$item.VersionInfo.ProductVersion\n', 'utf8');
  const version = await run('powershell.exe', ['-NoProfile', '-NonInteractive', '-File', versionScript, installer]);
  assert.equal(version.code, 0);
  assert.deepEqual(version.stdout.trim().split(/\r?\n/), ['0.1.3.0', '0.1.3-candidate']);
});

windowsTest('installer installs intact files and a real shortcut into Chinese paths without launching', async () => {
  const installDir = path.join(root, '中文 安装路径');
  const shortcutDir = path.join(root, '合成 桌面');
  await mkdir(shortcutDir);
  const installation = await run(installer, ['--silent', '--install-dir', installDir, '--shortcut-dir', shortcutDir]);
  assert.equal(installation.code, 0, installation.stderr.trim());
  assert.equal(await readFile(path.join(installDir, 'resources', 'fixture.txt'), 'utf8'), 'synthetic fixture\n');
  assert.equal(await readFile(path.join(installDir, 'educoder-local-study-control.exe'), 'utf8'), 'synthetic app; never launch');
  const shortcuts = await readdir(shortcutDir);
  assert.equal(shortcuts.length, 1);
  assert.match(shortcuts[0], /\.lnk$/i);
  const shortcut = await readFile(path.join(shortcutDir, shortcuts[0]));
  assert.equal(shortcut.readUInt32LE(0), 0x4c);
  assert.equal(shortcut.subarray(4, 20).toString('hex'), '0114020000000000c000000000000046');
});

windowsTest('installer refuses an existing directory and preserves all its contents', async () => {
  const installDir = path.join(root, 'existing');
  const shortcutDir = path.join(root, 'other-shortcuts');
  await mkdir(installDir); await mkdir(shortcutDir);
  await writeFile(path.join(installDir, 'keep.txt'), 'keep byte for byte');
  assert.notEqual((await run(installer, ['--silent', '--install-dir', installDir, '--shortcut-dir', shortcutDir])).code, 0);
  assert.equal(await readFile(path.join(installDir, 'keep.txt'), 'utf8'), 'keep byte for byte');
  assert.deepEqual(await readdir(installDir), ['keep.txt']);
  assert.deepEqual(await readdir(shortcutDir), []);
});

windowsTest('installer detects a changed embedded ZIP before extraction', async () => {
  const corrupted = path.join(root, 'corrupt-setup.exe');
  const bytes = await readFile(installer);
  const zip = bytes.indexOf(Buffer.from([0x50, 0x4b, 0x03, 0x04]));
  assert.ok(zip >= 0);
  bytes[zip + 50] ^= 1;
  await writeFile(corrupted, bytes);
  assert.notEqual((await run(corrupted, ['--verify-only'])).code, 0);
});

windowsTest('installer builder rejects browser profile files in a package', async () => {
  const privatePackage = path.join(root, 'privacy-fixture');
  await mkdir(path.join(privatePackage, 'resources', 'edge-profile'), { recursive: true });
  await writeFile(path.join(privatePackage, 'educoder-local-study-control.exe'), 'synthetic');
  await writeFile(path.join(privatePackage, 'resources', 'edge-profile', 'Cookies'), 'synthetic; contains no real session');
  await assert.rejects(buildWindowsInstaller({ packageDir: privatePackage,
    outputFile: path.join(root, 'must-not-build.exe'), version: '0.1.3-candidate' }), /PRIVATE_PACKAGE_FILE/);
});
