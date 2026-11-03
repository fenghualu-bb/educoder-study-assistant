import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { normalizeClassroomUrl } from './course.js';
import { normalizeTarget, targetKey, resolveScannedSelection } from './local-single-video/target.mjs';

export function resolvePersonalQueue(snapshot, selections) {
  if (!snapshot?.complete || !Array.isArray(selections) || !selections.length || selections.length > 1000) throw new Error('QUEUE_SCAN_REQUIRED');
  const targets = selections.map(selection => resolveScannedSelection(snapshot, selection));
  if (new Set(targets.map(targetKey)).size !== targets.length) throw new Error('QUEUE_DUPLICATE');
  return { courseUrl: snapshot.courseUrl, courseTitle: snapshot.courseTitle || '所选课堂',
    selections: selections.map(({ courseUrl, page, index, title, cardIdentity }) => ({ courseUrl, page, index, title, ...(cardIdentity ? { cardIdentity } : {}) })), targets };
}
function validate(record) {
  if (!record || record.version !== 1 || record.scope !== 'personal-temporary' || !Number.isSafeInteger(record.revision) || record.revision < 1
    || !Array.isArray(record.selections) || !record.selections.length || record.selections.length > 1000
    || !Number.isSafeInteger(record.cursor) || record.cursor < 0 || record.cursor > record.selections.length
    || !['ready','opening','playing','verifying','switching','paused','stopped','completed'].includes(record.phase)
    || typeof record.reason !== 'string' || typeof record.id !== 'string'
    || (record.mode !== undefined && !['single', 'continuous'].includes(record.mode))
    || (record.mode === 'single' && record.selections.length !== 1)) throw new Error('QUEUE_RECORD_INVALID');
  const courseUrl = normalizeClassroomUrl(record.courseUrl), classroomId = new URL(courseUrl).pathname.split('/')[2];
  if (courseUrl !== record.courseUrl || record.selections.some(item => item.courseUrl !== courseUrl)) throw new Error('QUEUE_RECORD_INVALID');
  const keys=record.selections.map(item=>targetKey(normalizeTarget({...item,classroomId})));
  if (new Set(keys).size !== keys.length) throw new Error('QUEUE_RECORD_INVALID');
  return structuredClone(record);
}
export class PersonalQueueStore {
  constructor(file) { this.file=file; this.sequence=Promise.resolve(); }
  serialize(action) { const next=this.sequence.catch(()=>{}).then(action);this.sequence=next;return next; }
  async snapshot() {
    try { const bytes=await fs.readFile(this.file);return {bytes,record:validate(JSON.parse(bytes.toString('utf8')))}; }
    catch(error) { if(error.code==='ENOENT')return {bytes:null,record:null};throw new Error('QUEUE_RECORD_INVALID'); }
  }
  async read() {
    try { return validate(JSON.parse(await fs.readFile(this.file,'utf8'))); }
    catch(error) { if(error.code==='ENOENT') return null; throw new Error('QUEUE_RECORD_INVALID'); }
  }
  assertUnchanged(record) {
    const expected=Buffer.from(JSON.stringify(validate(record),null,2)+'\n');
    return this.serialize(async()=>{
      const latest=await this.snapshot();
      if(!latest.bytes||!latest.bytes.equals(expected))throw new Error('QUEUE_RECORD_CHANGED');
    });
  }
  async create(plan, { replace=false }={}) {
    const previous=await this.read();
    if(previous && !replace) throw new Error('QUEUE_REPLACE_REQUIRED');
    const record=validate({version:1,scope:'personal-temporary',id:randomUUID(),revision:1,courseUrl:plan.courseUrl,
      courseTitle:plan.courseTitle,selections:plan.selections,...(plan.mode ? {mode:plan.mode}:{}),cursor:0,phase:'ready',reason:'',updatedAt:new Date().toISOString()});
    await fs.mkdir(path.dirname(this.file),{recursive:true});
    const temporary=this.file+'.'+randomUUID()+'.tmp';
    try { await fs.writeFile(temporary,JSON.stringify(record,null,2)+'\n',{flag:'wx'});
      const latest=await this.read(); if((latest?.id??null)!==(previous?.id??null)||(latest?.revision??null)!==(previous?.revision??null)) throw new Error('QUEUE_RECORD_CHANGED');
      if(!previous) { await fs.copyFile(temporary,this.file,1); } else await fs.rename(temporary,this.file);
    } finally { await fs.rm(temporary,{force:true}); }
    return record;
  }
  async stage(plan,{resume=false}={}) {
    const previous=await this.snapshot(),mode=plan.mode??(plan.selections.length===1?'single':'continuous');
    const saved=previous.record;
    if(resume&&(!saved||saved.courseUrl!==plan.courseUrl||JSON.stringify(saved.selections)!==JSON.stringify(plan.selections)
      ||(saved.mode??(saved.selections.length===1?'single':'continuous'))!==mode))throw new Error('QUEUE_RECORD_CHANGED');
    if(resume&&saved.cursor===saved.selections.length)throw new Error('QUEUE_COMPLETED');
    const record=validate(resume?{...saved,mode}:{version:1,scope:'personal-temporary',id:randomUUID(),revision:1,
      courseUrl:plan.courseUrl,courseTitle:plan.courseTitle,selections:plan.selections,mode,cursor:0,phase:'ready',reason:'',updatedAt:new Date().toISOString()});
    let committed=false,rolledBack=false,owned=null,sequence=Promise.resolve();
    const serialize=action=>{const next=sequence.catch(()=>{}).then(action);sequence=next;return next;};
    const encode=value=>Buffer.from(JSON.stringify(value,null,2)+'\n');
    const matches=(a,b)=>a===null?b===null:b!==null&&a.equals(b);
    const writeGuarded=async(bytes,expected,signal)=>{
      if(signal?.aborted)throw new Error('QUEUE_STOPPED');
      await fs.mkdir(path.dirname(this.file),{recursive:true});
      const temporary=this.file+'.'+randomUUID()+'.tmp';
      try {
        if(bytes!==null)await fs.writeFile(temporary,bytes,{flag:'wx'});
        const latest=await this.snapshot();
        if(!matches(expected,latest.bytes))throw new Error('QUEUE_RECORD_CHANGED');
        if(signal?.aborted)throw new Error('QUEUE_STOPPED');
        if(bytes===null)await fs.rm(this.file);
        else if(expected===null)await fs.copyFile(temporary,this.file,1);
        else await fs.rename(temporary,this.file);
      } finally {await fs.rm(temporary,{force:true});}
    };
    const rollback=async()=>{
      if(!committed)return;
      await writeGuarded(previous.bytes,owned);
      committed=false;rolledBack=true;owned=null;
    };
    return {record,get committed(){return committed;},
      store:{assertUnchanged:input=>serialize(()=>this.serialize(async()=>{
        if(input!==record||rolledBack)throw new Error('QUEUE_RECORD_CHANGED');
        if(!committed)return;
        const latest=await this.snapshot();
        if(!matches(owned,latest.bytes))throw new Error('QUEUE_RECORD_CHANGED');
      })),save:input=>{
        const intended=validate(input);
        return serialize(async()=>{
          if(input!==record||rolledBack)throw new Error('QUEUE_RECORD_CHANGED');
          if(!committed)return;
          const saving={...intended,revision:record.revision};await this.save(saving);owned=encode(saving);
          record.revision=saving.revision;record.updatedAt=saving.updatedAt;
        });
      }},
      commit:({signal}={})=>serialize(()=>this.serialize(async()=>{
        if(rolledBack)throw new Error('QUEUE_STOPPED');
        if(committed)return;
        const next=validate({...record,revision:resume?saved.revision+1:record.revision,updatedAt:new Date().toISOString()});
        const bytes=encode(next);await writeGuarded(bytes,previous.bytes,signal);
        record.revision=next.revision;record.updatedAt=next.updatedAt;committed=true;owned=bytes;
        if(signal?.aborted){await rollback();throw new Error('QUEUE_STOPPED');}
      })),
      rollback:()=>serialize(()=>this.serialize(rollback))};
  }
  async save(record) {
    const intended=structuredClone(record);
    const action=async()=>{
      const current=await this.read();
      if(!current || current.id!==record.id || current.revision!==record.revision) throw new Error('QUEUE_RECORD_CHANGED');
      const next=validate({...intended,revision:record.revision+1,updatedAt:new Date().toISOString()});
      const temporary=this.file+'.'+randomUUID()+'.tmp';
      try { await fs.writeFile(temporary,JSON.stringify(next,null,2)+'\n',{flag:'wx'});
        const latest=await this.read(); if(latest.id!==current.id||latest.revision!==current.revision) throw new Error('QUEUE_RECORD_CHANGED');
        await fs.rename(temporary,this.file);
      } finally { await fs.rm(temporary,{force:true}); }
      Object.assign(record,next);
    };
    const next=this.sequence.catch(()=>{}).then(action); this.sequence=next; return next;
  }
}
