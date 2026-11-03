import { readdir, stat, readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { checkPackagedDependencies } from './package-dependency-audit.mjs';

const require = createRequire(import.meta.url);
const asar = require('@electron/asar');
const root = fileURLToPath(new URL('../', import.meta.url));
const appName = 'educoder-local-study-control-win32-x64';
const required = ['package.json', 'src/desktop-main.js', 'src/runtime.js', 'public/index.html'];
const allowedRoots = new Set([
  '.gitignore', 'forge.config.cjs', 'package-lock.json', 'package.json', 'LICENSE',
  'src', 'public', 'node_modules',
]);
const privateRoots = new Set([
  'data', 'vendor', 'build-assets', 'docs', 'test', 'scripts', 'service', 'out', 'run-archive',
  '.private-quarantine', '.git', '.worktrees', '.superpowers', 'evidence', 'installer', 'README.md', 'CHANGELOG.md',
]);
const privateNames = new Set([
  'cookies', 'local state', 'login data', 'web data', 'history',
  'chrome-profile', 'edge-profile', 'user-data', 'course-inventory.json',
  'run-journal.json', 'storage-state.json', '.env',
  'observed-position.json', 'bridge.json', 'events.ndjson',
  'personal-temporary-queue.json', 'manual-playback-options.json', 'appearance.json',
]);

function normaliseEntry(entry) {
  return String(entry).replaceAll('\\', '/').replace(/^\/+/, '');
}

export function checkArchiveEntries(entries) {
  const names = entries.map(normaliseEntry);
  const findings = [];
  for (const name of names) {
    const parts = name.split('/');
    const top = parts[0];
    if (privateRoots.has(top) || /^backup-.*\.zip$/i.test(top)) {
      findings.push('private source path in app.asar');
    } else if (!allowedRoots.has(top)) {
      findings.push('unexpected source path in app.asar');
    } else if (parts.some((part) => privateNames.has(part.toLowerCase()))) {
      findings.push('browser profile file in app.asar');
    }
  }
  for (const item of required) {
    if (!names.includes(item)) findings.push(`missing runtime file: ${item}`);
  }
  return findings;
}

export function checkAppText(content) {
  return /educoder\.net\/classrooms\/[a-z0-9]{5,}/i.test(content)
    || /new_video_id=\d+/i.test(content)
    || /\bclassroomId\s*:\s*['"](?!Synthetic[A-Za-z0-9_-]*['"])[A-Za-z0-9_-]+['"]/i.test(content);
}

export function checkResourceNames(names, edgeOnly, { localSingleVideo = false } = {}) {
  const findings = [];
  const actual = new Set(names);
  if (!actual.has('app.asar')) findings.push('missing app.asar');
  if (edgeOnly && !actual.has('edge-only.marker')) findings.push('missing Edge-only marker');
  if (edgeOnly && actual.has('ms-playwright')) findings.push('unexpected bundled browser in Edge-only package');
  if (!edgeOnly && !actual.has('ms-playwright')) findings.push('missing bundled browser in default package');
  if (localSingleVideo && !actual.has('local-single-video-native-control.ps1')) findings.push('missing local single-video native control');
  for (const name of actual) {
    if (name !== 'app.asar' && name !== 'ms-playwright'
      && !(edgeOnly && name === 'edge-only.marker')
      && !(localSingleVideo && name === 'local-single-video-native-control.ps1')) findings.push('unexpected resource in package');
  }
  return findings;
}

async function checkBrowserResources(browserDir) {
  const findings = [];
  const pending = [browserDir];
  while (pending.length) {
    const directory = pending.pop();
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const name = entry.name.toLowerCase();
      if (privateNames.has(name)) {
        findings.push('browser profile file in bundled browser resources');
      }
      if (entry.isSymbolicLink()) findings.push('symbolic link in bundled browser resources');
      if (entry.isDirectory()) pending.push(path.join(directory, entry.name));
    }
  }
  return findings;
}

export async function auditPackage(packageDir, edgeOnly) {
  const resourceDir = path.join(packageDir, 'resources');
  const resourceNames = await readdir(resourceDir);
  const findings = [];
  const asarPath = path.join(resourceDir, 'app.asar');
  let entryCount = 0;
  let localSingleVideo = false;
  let runtimeDependencies;
  if (resourceNames.includes('app.asar') && !(await stat(asarPath)).isFile()) {
    findings.push('app.asar is not a file');
  } else if (resourceNames.includes('app.asar')) {
    const entries = asar.listPackage(asarPath);
    localSingleVideo = entries.some(entry => normaliseEntry(entry) === 'src/local-single-video/main.mjs');
    entryCount = entries.length;
    findings.push(...checkArchiveEntries(entries));
    runtimeDependencies = checkPackagedDependencies({entries,
      header: asar.getRawHeader(asarPath).header,
      packageJson: JSON.parse(asar.extractFile(asarPath, 'package.json').toString('utf8')),
      readFile: name => asar.extractFile(asarPath, path.normalize(name), false)});
    findings.push(...runtimeDependencies.findings);
    for (const entry of entries) {
      const name = normaliseEntry(entry);
      if (!/^(src|public)\/.*\.(?:js|cjs|mjs|html|json|css|md|txt)$/i.test(name)) continue;
      const bytes = asar.extractFile(asarPath, path.normalize(name));
      const content = bytes.toString('utf8');
      if (checkAppText(content)) {
        findings.push('hard-coded classroom or video link in app.asar');
      }
    }
    if (localSingleVideo && resourceNames.includes('local-single-video-native-control.ps1')) {
      const nativeName = 'src/local-single-video/local-single-video-native-control.ps1';
      try {
        const digest = bytes => createHash('sha256').update(bytes).digest('hex');
        if (digest(await readFile(path.join(resourceDir, 'local-single-video-native-control.ps1')))
          !== digest(asar.extractFile(asarPath, path.normalize(nativeName)))) findings.push('different local single-video native control');
      } catch { findings.push('invalid local single-video native control'); }
    }
  }
  findings.push(...checkResourceNames(resourceNames, edgeOnly, { localSingleVideo }));
  if (!edgeOnly && resourceNames.includes('ms-playwright')) {
    findings.push(...await checkBrowserResources(path.join(resourceDir, 'ms-playwright')));
  }
  return { entries: entryCount, findings, runtimeDependencies };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const variants = [
    ['default', path.join(root, 'out', appName), false],
    ['edge-internal', path.join(root, 'out', 'edge-internal', appName), true],
  ];
  let failed = false;
  for (const [label, directory, edgeOnly] of variants) {
    try {
      const result = await auditPackage(directory, edgeOnly);
      if (result.findings.length) {
        failed = true;
        process.stderr.write(`${label}: FAILED (${result.findings.join('; ')})\n`);
      } else {
        process.stdout.write(`${label}: PASS (${result.entries} asar entries)\n`);
      }
    } catch (error) {
      failed = true;
      process.stderr.write(`${label}: FAILED (${error.code || error.name || 'unreadable package'})\n`);
    }
  }
  if (failed) process.exitCode = 1;
}
