function names(entries) { return new Set(entries.map(entry=>String(entry).replaceAll('\\','/').replace(/^\/+/,''))); }
function safeRelative(value) { return typeof value==='string'&&value.startsWith('./')&&!value.includes('\\')&&!value.includes(':')&&value.slice(2).split('/').every(part=>part&&part!=='.'&&part!=='..'); }
export function checkPackagedDependencies({entries,header,packageJson,readFile}) {
  const present = names(entries), findings = [], dependencies = [];
  function inspect(files,relative='') {
    for (const [name,node] of Object.entries(files??{})) {
      const key = relative ? `${relative}/${name}` : name;
      if (Object.hasOwn(node,'link')) findings.push(`linked path in app.asar: ${key}`);
      if (node.files) inspect(node.files,key);
    }
  }
  inspect(header?.files);
  const declared = packageJson?.dependencies;
  if (!declared || Object.keys(declared).join(',')!=='playwright-core' || declared['playwright-core']!=='1.63.0') findings.push('unexpected production dependency policy');
  for (const [name,version] of Object.entries(declared??{})) {
    if (!/^(?:@[a-z0-9_.-]+\/)?[a-z0-9_.-]+$/i.test(name)) { findings.push('invalid production dependency name'); continue; }
    const base=`node_modules/${name}/`, file=base+'package.json';
    if (!present.has(file)) { findings.push(`missing production dependency: ${name}`); continue; }
    let metadata;
    try { metadata=JSON.parse(readFile(file).toString('utf8')); }
    catch { findings.push(`unreadable production dependency: ${name}`); continue; }
    if (metadata.name!==name || metadata.version!==version) findings.push(`different production dependency version: ${name}`);
    if (Object.keys(metadata.dependencies??{}).length) findings.push(`unverified transitive production dependencies: ${name}`);
    const exports=metadata.exports?.['.'];
    for (const mode of ['import','require']) {
      const target=exports?.[mode];
      if (!safeRelative(target) || !present.has(base+target.slice(2))) findings.push(`missing production dependency ${mode} entry: ${name}`);
    }
    if (name==='playwright-core') {
      for (const required of ['lib/bootstrap.js','lib/coreBundle.js','lib/utilsBundle.js','LICENSE','NOTICE','ThirdPartyNotices.txt']) {
        if (!present.has(base+required)) findings.push(`missing production dependency file: ${name}/${required}`);
      }
      if (metadata.license!=='Apache-2.0') findings.push('different production dependency license');
    }
    dependencies.push({name,version:metadata.version,files:[...present].filter(entry=>entry.startsWith(base)&&!headerEntry(header,entry)?.files).length,importEntry:exports?.import,requireEntry:exports?.require});
  }
  return {findings,dependencies,archiveLinksRejected:true};
}
function headerEntry(header,name) { let node=header;for(const piece of name.split('/'))node=node?.files?.[piece];return node; }
