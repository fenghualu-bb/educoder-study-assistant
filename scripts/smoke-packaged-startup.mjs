import fs from 'node:fs/promises';
import path from 'node:path';
import {spawn} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {auditPackage} from './audit-package.mjs';

export async function smokePackagedStartup(packageDir,{timeoutMs=30000}={}) {
  const root=path.resolve(packageDir),exe=path.join(root,'educoder-local-study-control.exe');
  const archive=path.join(root,'resources','app.asar');
  for (const file of [exe,archive]) {
    const stat=await fs.lstat(file);
    if(!stat.isFile()||stat.isSymbolicLink())throw new Error('REGULAR_PACKAGED_STARTUP_FILE_REQUIRED');
  }
  // RunAsNode can follow a development-cache ASAR link on the build machine.
  // Refuse such archives before executing the probe; imports must be backed by
  // complete, internal production dependency files.
  const dependencyAudit=await auditPackage(root,true);
  if(dependencyAudit.findings.length)throw new Error('PACKAGED_STARTUP_PREREQUISITE_FAILED');
  const probe=String.raw`const path=require('node:path');const {pathToFileURL}=require('node:url');
(async()=>{if(!process.versions.electron)throw new Error('PACKAGED_ELECTRON_REQUIRED');
const archive=path.join(path.dirname(process.execPath),'resources','app.asar');
const controller=await import(pathToFileURL(path.join(archive,'src','local-single-video','controller.mjs')).href);
const manager=await import(pathToFileURL(path.join(archive,'src','local-manual-video.js')).href);
if(typeof controller.SingleController!=='function'||typeof manager.registerManualVideoDesktop!=='function')throw new Error('STARTUP_MODULE_EXPORTS_MISSING');
process.stdout.write(JSON.stringify({kind:'packaged-startup-import-smoke',controllerImported:true,managerImported:true,electron:process.versions.electron})+'\n');
})().catch(error=>{process.stderr.write(String(error?.stack??error)+'\n');process.exitCode=1;});`;
  const startedAt=new Date().toISOString();
  const result=await new Promise((resolve,reject)=>{
    let settled=false,stdout='',stderr='',timedOut=false;
    const child=spawn(exe,['-e',probe],{cwd:root,windowsHide:true,
      env:{...process.env,ELECTRON_RUN_AS_NODE:'1',NODE_PATH:'',NODE_OPTIONS:''},stdio:['ignore','pipe','pipe']});
    const timer=setTimeout(()=>{timedOut=true;child.kill();},timeoutMs);
    child.stdout.on('data',bytes=>{stdout=(stdout+bytes.toString('utf8')).slice(-32768);});
    child.stderr.on('data',bytes=>{stderr=(stderr+bytes.toString('utf8')).slice(-32768);});
    child.once('error',error=>{if(!settled){settled=true;clearTimeout(timer);reject(error);}});
    child.once('close',exitCode=>{if(!settled){settled=true;clearTimeout(timer);resolve({exitCode,stdout,stderr,timedOut});}});
  });
  let proof;try{proof=JSON.parse(result.stdout.trim());}catch{}
  if(result.exitCode!==0||result.timedOut||proof?.kind!=='packaged-startup-import-smoke'||!proof.controllerImported||!proof.managerImported){
    const error=new Error('PACKAGED_STARTUP_IMPORT_SMOKE_FAILED');error.smoke={...result,startedAt};throw error;
  }
  return {status:'passed',startedAt,completedAt:new Date().toISOString(),exitCode:0,packagedExecutableUsed:true,
    electronRunAsNode:true,externalNodePathDisabled:true,archiveLinksRejected:true,productionDependenciesInternal:true,controllerImported:true,managerImported:true,
    applicationStarted:false,personalStoresRead:false,officialCoursePlayed:false};
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)) {
  if(!process.argv[2])throw new Error('PACKAGE_DIRECTORY_REQUIRED');
  try{console.log(JSON.stringify(await smokePackagedStartup(process.argv[2]),null,2));}
  catch(error){console.log(JSON.stringify({status:'failed',code:error.message,...error.smoke},null,2));process.exitCode=1;}
}
