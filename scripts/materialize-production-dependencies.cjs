const fs = require('node:fs/promises');
const path = require('node:path');
const {createHash} = require('node:crypto');

const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const inside = (root, file) => { const relative = path.relative(root, file); return Boolean(relative) && !relative.startsWith('..') && !path.isAbsolute(relative); };
async function noLinks(file) {
  const absolute = path.resolve(file), parsed = path.parse(absolute);
  let current = parsed.root;
  for (const piece of absolute.slice(parsed.root.length).split(path.sep).filter(Boolean)) {
    current = path.join(current, piece);
    const stat = await fs.lstat(current);
    if (stat.isSymbolicLink()) throw new Error('LINKED_BUILD_PATH_REFUSED');
  }
}
async function inventory(root, relative = '') {
  const result = {};
  for (const entry of (await fs.readdir(path.join(root, relative), {withFileTypes:true})).sort((a,b)=>a.name.localeCompare(b.name,'en'))) {
    const key = relative ? `${relative}/${entry.name}` : entry.name;
    const file = path.join(root, key), before = await fs.lstat(file);
    if (before.isSymbolicLink()) throw new Error('LINKED_RUNTIME_DEPENDENCY_REFUSED');
    if (before.isDirectory()) Object.assign(result, await inventory(root, key));
    else if (before.isFile()) {
      const bytes = await fs.readFile(file), after = await fs.lstat(file);
      if (before.size !== after.size || before.mtimeMs !== after.mtimeMs) throw new Error('RUNTIME_DEPENDENCY_CHANGED');
      result[key] = hash(bytes);
    } else throw new Error('NONREGULAR_RUNTIME_DEPENDENCY_REFUSED');
  }
  return result;
}
async function materializeProductionDependencies({projectRoot,buildPath}) {
  projectRoot = path.resolve(projectRoot); buildPath = path.resolve(buildPath);
  const stagingRoot = path.resolve(projectRoot,'..','packager-tmp');
  if (!inside(stagingRoot,buildPath) || buildPath === projectRoot) throw new Error('BUILD_STAGE_OUTSIDE_OWNED_TEMP');
  await noLinks(buildPath);
  const sourcePackage = JSON.parse(await fs.readFile(path.join(projectRoot,'package.json'),'utf8'));
  const stagedPackage = JSON.parse(await fs.readFile(path.join(buildPath,'package.json'),'utf8'));
  if (sourcePackage.name !== stagedPackage.name || sourcePackage.version !== stagedPackage.version
    || JSON.stringify(sourcePackage.dependencies) !== JSON.stringify(stagedPackage.dependencies)) throw new Error('BUILD_STAGE_PACKAGE_MISMATCH');
  if (Object.keys(sourcePackage.dependencies ?? {}).join(',') !== 'playwright-core'
    || sourcePackage.dependencies['playwright-core'] !== '1.63.0') throw new Error('RUNTIME_DEPENDENCY_POLICY_CHANGED');
  const lock = JSON.parse(await fs.readFile(path.join(projectRoot,'package-lock.json'),'utf8'));
  if (lock.version !== sourcePackage.version || lock.packages?.['']?.version !== sourcePackage.version
    || lock.packages?.['node_modules/playwright-core']?.version !== sourcePackage.dependencies['playwright-core']
    || JSON.stringify(lock.packages?.['']?.dependencies) !== JSON.stringify(sourcePackage.dependencies)) throw new Error('RUNTIME_DEPENDENCY_LOCK_MISMATCH');
  // Resolve the development cache once. Every copied file below must be a
  // regular file; only the private build stage receives writes.
  const source = await fs.realpath(path.join(projectRoot,'node_modules','playwright-core'));
  await noLinks(source);
  const dependency = JSON.parse(await fs.readFile(path.join(source,'package.json'),'utf8'));
  if (dependency.name !== 'playwright-core' || dependency.version !== sourcePackage.dependencies['playwright-core']
    || Object.keys(dependency.dependencies ?? {}).length || dependency.license !== 'Apache-2.0') throw new Error('CACHED_RUNTIME_DEPENDENCY_MISMATCH');
  const before = await inventory(source);
  for (const name of ['package.json','index.mjs','index.js','lib/bootstrap.js','lib/coreBundle.js','lib/utilsBundle.js','LICENSE','NOTICE','ThirdPartyNotices.txt']) {
    if (!(name in before)) throw new Error('CACHED_RUNTIME_DEPENDENCY_INCOMPLETE');
  }
  const modules = path.join(buildPath,'node_modules');
  try {
    const stat = await fs.lstat(modules);
    if (stat.isSymbolicLink() || !stat.isDirectory() || (await fs.readdir(modules)).length) throw new Error('PACKAGED_NODE_MODULES_MUST_BE_EMPTY_DIRECTORY');
  } catch (error) { if (error.code !== 'ENOENT') throw error; await fs.mkdir(modules); }
  const destination = path.join(modules,'playwright-core');
  await fs.mkdir(destination);
  for (const [name,expected] of Object.entries(before)) {
    const bytes = await fs.readFile(path.join(source,name));
    if (hash(bytes) !== expected) throw new Error('RUNTIME_DEPENDENCY_CHANGED');
    const target = path.join(destination,name);
    await fs.mkdir(path.dirname(target),{recursive:true});
    await fs.writeFile(target,bytes,{flag:'wx'});
  }
  const after = await inventory(source), copied = await inventory(destination);
  if (JSON.stringify(before) !== JSON.stringify(after) || JSON.stringify(before) !== JSON.stringify(copied)) throw new Error('RUNTIME_DEPENDENCY_COPY_MISMATCH');
  return {package:'playwright-core',version:dependency.version,files:Object.keys(before).length,
    sourceSetSha256:hash(Buffer.from(JSON.stringify(before))),licensesIncluded:true,linksCopied:false};
}
module.exports = {materializeProductionDependencies};
