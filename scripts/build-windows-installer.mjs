import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createReadStream, existsSync } from 'node:fs';
import { lstat, readdir, mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const projectRoot = fileURLToPath(new URL('../', import.meta.url));
const privateNames = /^(?:data|chrome-profile|edge-profile|browser-profile|user-data|cookies|local state|login data|web data|history|course-inventory\.json|run-journal\.json|storage-state\.json|\.env(?:\..*)?|\.private-quarantine)$/i;
async function digest(file) {
  const hash = createHash('sha256');
  for await (const bytes of createReadStream(file)) hash.update(bytes);
  return hash.digest('hex');
}
async function packageFiles(root, dir = root) {
  const files = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    if (privateNames.test(entry.name)) throw new Error('PRIVATE_PACKAGE_FILE');
    if (/[\t\r\n]/.test(entry.name)) throw new Error('INVALID_PACKAGE_PATH');
    const file = path.join(dir, entry.name);
    const info = await lstat(file);
    if (info.isSymbolicLink()) throw new Error('PACKAGE_LINK_NOT_ALLOWED');
    if (info.isDirectory()) files.push(...await packageFiles(root, file));
    else if (info.isFile()) files.push({ path: path.relative(root, file).replaceAll('\\', '/'),
      sha256: await digest(file), bytes: info.size });
    else throw new Error('INVALID_PACKAGE_FILE');
  }
  return files.sort((a, b) => a.path.localeCompare(b.path, 'en'));
}
async function command(file, args, options = {}) {
  await new Promise((resolve, reject) => {
    const child = spawn(file, args, { ...options, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let output = '';
    for (const stream of [child.stdout, child.stderr]) stream.on('data', bytes => { output = (output + bytes.toString('utf8')).slice(-8_000); });
    child.once('error', reject);
    child.once('close', code => code === 0 ? resolve() : reject(new Error(`INSTALLER_BUILD_FAILED (${path.basename(file)} exit ${code})\n${output}`)));
  });
}

export async function buildWindowsInstaller({ packageDir, outputFile, version,
  sevenZip = 'C:\\Program Files\\7-Zip\\7z.exe',
  compiler = 'C:\\Windows\\Microsoft.NET\\Framework64\\v4.0.30319\\csc.exe' }) {
  if (process.platform !== 'win32') throw new Error('WINDOWS_BUILD_REQUIRED');
  if (!/^\d+\.\d+\.\d+(?:-[a-z0-9.]+)?$/.test(version)) throw new Error('INVALID_INSTALLER_VERSION');
  const source = path.resolve(packageDir);
  const destination = path.resolve(outputFile);
  const relative = path.relative(source, destination);
  if (!relative.startsWith('..') && !path.isAbsolute(relative)) throw new Error('INSTALLER_OUTPUT_INSIDE_PACKAGE');
  if (existsSync(destination)) throw new Error('INSTALLER_OUTPUT_ALREADY_EXISTS');
  const files = await packageFiles(source);
  if (!files.some(file => file.path === 'educoder-local-study-control.exe')) throw new Error('PACKAGE_EXE_MISSING');
  if (!existsSync(sevenZip) || !existsSync(compiler)) throw new Error('INSTALLER_BUILD_TOOLS_MISSING');
  const temporary = await mkdtemp(path.join(os.tmpdir(), 'educoder-installer-build-'));
  try {
    const zip = path.join(temporary, 'payload.zip');
    await command(sevenZip, ['a', '-tzip', '-mx=7', '-bd', zip, '.\\*'], { cwd: source });
    const payloadSha256 = await digest(zip);
    const manifest = path.join(temporary, 'payload.tsv');
    const shaFile = path.join(temporary, 'payload.sha256');
    const versionFile = path.join(temporary, 'version.txt');
    const assemblyFile = path.join(temporary, 'version.cs');
    await writeFile(manifest, files.map(file => `${file.sha256}\t${file.path}`).join('\n') + '\n', 'utf8');
    await writeFile(shaFile, payloadSha256, 'ascii');
    await writeFile(versionFile, version, 'ascii');
    const assemblyVersion = `${version.split('-')[0]}.0`;
    await writeFile(assemblyFile, `using System.Reflection;\n[assembly: AssemblyVersion("${assemblyVersion}")]\n[assembly: AssemblyFileVersion("${assemblyVersion}")]\n[assembly: AssemblyInformationalVersion("${version}")]\n`, 'ascii');
    await mkdir(path.dirname(destination), { recursive: true });
    await command(compiler, ['/nologo', '/target:winexe', '/platform:x64', '/optimize+', '/debug-', '/utf8output',
      '/reference:System.IO.Compression.dll', '/reference:System.IO.Compression.FileSystem.dll',
      '/reference:System.Windows.Forms.dll', '/reference:System.Drawing.dll',
      `/win32manifest:${path.join(projectRoot, 'installer', 'installer.manifest')}`,
      `/resource:${zip},educoder.payload.zip`, `/resource:${shaFile},educoder.payload.sha256`,
      `/resource:${manifest},educoder.payload.manifest`, `/resource:${versionFile},educoder.version`,
      `/out:${destination}`, path.join(projectRoot, 'installer', 'CandidateInstaller.cs'), assemblyFile]);
    return { outputFile: destination, version, payloadSha256, installerSha256: await digest(destination), files };
  } finally {
    if (path.dirname(path.resolve(temporary)).toLowerCase() !== path.resolve(os.tmpdir()).toLowerCase()
      || !path.basename(temporary).startsWith('educoder-installer-build-')) throw new Error('UNSAFE_BUILD_CLEANUP');
    await rm(temporary, { recursive: true, force: true });
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [packageDir, outputFile, version] = process.argv.slice(2);
  if (!packageDir || !outputFile || !version) throw new Error('Usage: node scripts/build-windows-installer.mjs PACKAGE_DIR OUTPUT_EXE VERSION');
  const result = await buildWindowsInstaller({ packageDir, outputFile, version });
  await writeFile(`${result.outputFile}.json`, JSON.stringify(result, null, 2) + '\n');
  console.log(`Installer built: ${path.basename(result.outputFile)} (${result.files.length} files)`);
}
