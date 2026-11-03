import { readdir, readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const asar = createRequire(import.meta.url)('@electron/asar');
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
async function runtimeFiles(directory, base = directory) {
  const files = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const file = path.join(directory, entry.name);
    if (entry.isDirectory()) files.push(...await runtimeFiles(file, base));
    else if (entry.isFile()) files.push(path.relative(base, file).replaceAll('\\', '/'));
  }
  return files.sort();
}
export async function verifyPackageSource(packageDir, sourceDir = root) {
  const archive = path.join(packageDir, 'resources', 'app.asar');
  const entries = new Set(asar.listPackage(archive).map(s => s.replaceAll('\\', '/').replace(/^\/+/, '')));
  const hashes = {}, findings = [];
  for (const folder of ['src', 'public']) {
    for (const relative of await runtimeFiles(path.join(sourceDir, folder))) {
      const name = `${folder}/${relative}`;
      hashes[name] = digest(await readFile(path.join(sourceDir, name)));
      if (!entries.has(name)) findings.push(`missing ${name}`);
      else if (digest(asar.extractFile(archive, path.normalize(name))) !== hashes[name]) findings.push(`different ${name}`);
    }
  }
  for (const name of entries) if (/^(src|public)\/.+\.[^/]+$/.test(name) && !(name in hashes)) findings.push(`extra ${name}`);
  const sourcePackage = JSON.parse(await readFile(path.join(sourceDir, 'package.json'), 'utf8'));
  const builtPackage = JSON.parse(asar.extractFile(archive, 'package.json').toString('utf8'));
  for (const field of ['name', 'version', 'main', 'type', 'dependencies']) {
    if (JSON.stringify(builtPackage[field]) !== JSON.stringify(sourcePackage[field])) findings.push(`different package.${field}`);
  }
  return { version: sourcePackage.version, runtimeFiles: Object.keys(hashes).length, findings, sourceSha256: hashes };
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const packageDir = process.argv[2];
  if (!packageDir) throw new Error('Usage: node scripts/verify-package-source.mjs PACKAGE_DIR');
  const result = await verifyPackageSource(packageDir);
  console.log(`${result.findings.length ? 'FAILED' : 'PASS'}: ${result.runtimeFiles} runtime files, version ${result.version}`);
  if (result.findings.length) { console.error(result.findings.join('\n')); process.exitCode = 1; }
}
