import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {createHash} from 'node:crypto';
import {createRequire} from 'node:module';
import {checkPackagedDependencies} from '../scripts/package-dependency-audit.mjs';
const {materializeProductionDependencies}=createRequire(import.meta.url)('../scripts/materialize-production-dependencies.cjs');
const required=['index.mjs','index.js','lib/bootstrap.js','lib/coreBundle.js','lib/utilsBundle.js','LICENSE','NOTICE','ThirdPartyNotices.txt'];
const dep={name:'playwright-core',version:'1.63.0',license:'Apache-2.0',exports:{'.':{import:'./index.mjs',require:'./index.js'}},dependencies:{}};
const pkg={name:'educoder-local-study-control',version:'0.1.18',dependencies:{'playwright-core':'1.63.0'}};
function archiveFixture() {
  const files=new Map([['node_modules/playwright-core/package.json',Buffer.from(JSON.stringify(dep))],...required.map(name=>['node_modules/playwright-core/'+name,Buffer.from('synthetic fixture')])]);
  const header={files:{}};
  for(const name of files.keys()){let current=header;const parts=name.split('/');for(let i=0;i<parts.length;i++){current.files??={};current.files[parts[i]]??=i===parts.length-1?{size:1}:{files:{}};current=current.files[parts[i]];}}
  return {files,header,audit(){return checkPackagedDependencies({entries:[...files.keys()],header,packageJson:pkg,readFile:name=>files.get(name)});}};
}
test('complete internal production dependency passes without external archive links',()=>{
  const fixture=archiveFixture(),result=fixture.audit();assert.deepEqual(result.findings,[]);assert.equal(result.dependencies[0].version,'1.63.0');
});
test('the 017 empty node_modules link cannot satisfy declared runtime dependencies',()=>{
  const result=checkPackagedDependencies({entries:['package.json','node_modules'],header:{files:{node_modules:{link:'synthetic-cache'}}},packageJson:pkg,readFile(){throw new Error('not reached');}});
  assert.ok(result.findings.includes('linked path in app.asar: node_modules'));
  assert.ok(result.findings.includes('missing production dependency: playwright-core'));
});
test('nested links are rejected even when dependency entry names appear complete',()=>{
  const fixture=archiveFixture();fixture.header.files.node_modules.files['playwright-core'].files.index={link:'synthetic-cache'};
  assert.ok(fixture.audit().findings.some(message=>message.includes('linked path in app.asar')));
});
test('wrong version, missing bootstrap or entry, and missing license cannot pass',()=>{
  for(const kind of ['version','bootstrap','entry','license']){
    const fixture=archiveFixture();
    if(kind==='version')fixture.files.set('node_modules/playwright-core/package.json',Buffer.from(JSON.stringify({...dep,version:'0.0.0'})));
    else fixture.files.delete('node_modules/playwright-core/'+({bootstrap:'lib/coreBundle.js',entry:'index.mjs',license:'LICENSE'}[kind]));
    assert.ok(fixture.audit().findings.length,kind);
  }
});
async function stageFixture(t) {
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'educoder-packaging-dependencies-'));
  t.after(async()=>{assert.equal(path.dirname(root).toLowerCase(),path.resolve(os.tmpdir()).toLowerCase());assert.match(path.basename(root),/^educoder-packaging-dependencies-/);await fs.rm(root,{recursive:true,force:true});});
  const projectRoot=path.join(root,'project'),cache=path.join(root,'cache'),buildPath=path.join(root,'packager-tmp','fixture','resources','app');
  await fs.mkdir(buildPath,{recursive:true});await fs.mkdir(path.join(projectRoot,'node_modules'),{recursive:true});await fs.mkdir(cache);
  const lock={version:pkg.version,packages:{'':{version:pkg.version,dependencies:pkg.dependencies},'node_modules/playwright-core':{version:dep.version}}};
  await fs.writeFile(path.join(projectRoot,'package.json'),JSON.stringify(pkg));await fs.writeFile(path.join(projectRoot,'package-lock.json'),JSON.stringify(lock));await fs.writeFile(path.join(buildPath,'package.json'),JSON.stringify(pkg));
  await fs.writeFile(path.join(cache,'package.json'),JSON.stringify(dep));
  for(const name of required){const file=path.join(cache,name);await fs.mkdir(path.dirname(file),{recursive:true});await fs.writeFile(file,'synthetic '+name);}
  await fs.symlink(cache,path.join(projectRoot,'node_modules','playwright-core'),'junction');
  return {root,projectRoot,buildPath,cache,lock};
}
async function fileTable(root,relative='') {const out={};for(const entry of await fs.readdir(path.join(root,relative),{withFileTypes:true})){const name=relative?relative+'/'+entry.name:entry.name;if(entry.isDirectory())Object.assign(out,await fileTable(root,name));else out[name]=createHash('sha256').update(await fs.readFile(path.join(root,name))).digest('hex');}return out;}
test('materializes real production files and licenses from cache without changing its bytes',async t=>{
  const fixture=await stageFixture(t),before=await fileTable(fixture.cache);
  const result=await materializeProductionDependencies(fixture);
  assert.equal(result.version,'1.63.0');assert.equal(result.licensesIncluded,true);assert.equal(result.linksCopied,false);
  const target=path.join(fixture.buildPath,'node_modules','playwright-core');assert.equal((await fs.lstat(target)).isSymbolicLink(),false);
  assert.deepEqual(await fileTable(target),before);assert.deepEqual(await fileTable(fixture.cache),before);
});
test('wrong lock fails before writes and preserves the cache',async t=>{
  const fixture=await stageFixture(t),before=await fileTable(fixture.cache);fixture.lock.packages['node_modules/playwright-core'].version='0.0.0';
  await fs.writeFile(path.join(fixture.projectRoot,'package-lock.json'),JSON.stringify(fixture.lock));
  await assert.rejects(materializeProductionDependencies(fixture),/LOCK_MISMATCH/);
  await assert.rejects(fs.stat(path.join(fixture.buildPath,'node_modules')),error=>error.code==='ENOENT');assert.deepEqual(await fileTable(fixture.cache),before);
});
test('source or cache passed as build stage is rejected before any mutation',async t=>{
  const fixture=await stageFixture(t),before=await fileTable(fixture.cache);
  for(const buildPath of [fixture.projectRoot,fixture.cache])await assert.rejects(materializeProductionDependencies({...fixture,buildPath}),/BUILD_STAGE_OUTSIDE/);
  assert.deepEqual(await fileTable(fixture.cache),before);
});
test('a staged node_modules junction is rejected rather than traversed or removed',async t=>{
  const fixture=await stageFixture(t),before=await fileTable(fixture.cache),link=path.join(fixture.buildPath,'node_modules');
  await fs.symlink(fixture.cache,link,'junction');await assert.rejects(materializeProductionDependencies(fixture),/NODE_MODULES_MUST_BE_EMPTY/);
  assert.equal((await fs.lstat(link)).isSymbolicLink(),true);assert.deepEqual(await fileTable(fixture.cache),before);
});
test('links inside a runtime dependency are rejected before copy',async t=>{
  const fixture=await stageFixture(t);await fs.symlink(fixture.projectRoot,path.join(fixture.cache,'linked-folder'),'junction');
  await assert.rejects(materializeProductionDependencies(fixture),/LINKED_RUNTIME_DEPENDENCY/);
  await assert.rejects(fs.stat(path.join(fixture.buildPath,'node_modules')),error=>error.code==='ENOENT');
});
