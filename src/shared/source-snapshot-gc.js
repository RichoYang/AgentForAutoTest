import {lstat,readdir,readFile,rm,realpath,mkdir,writeFile,rename} from 'node:fs/promises';
import path from 'node:path';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {createHash,randomUUID} from 'node:crypto';
import {withSnapshotLock} from './snapshot-lock.js';
const execute=promisify(execFile),terminal=new Set(['completed','failed','cancelled','blocked']);
const inside=(root,p)=>p===root||p.startsWith(root+path.sep);
// Use explicit argv, never commands from manifests or source text.
async function g(cwd,args){return (await execute('git',['-C',cwd,'-c',`core.hooksPath=${process.platform==='win32'?'NUL':'/dev/null'}`, ...args],{maxBuffer:16*1024*1024,env:{...process.env,GIT_TERMINAL_PROMPT:'0'}})).stdout.trim();}
const visit=(x,fn)=>{if(typeof x==='string')fn(x);else if(x&&typeof x==='object')for(const v of Object.values(x))visit(v,fn);};
async function regular(file){const s=await lstat(file);if(!s.isFile()||s.isSymbolicLink())throw new Error('unsafe-file');return s;}
async function directory(file){const s=await lstat(file);if(!s.isDirectory()||s.isSymbolicLink()||await realpath(file)!==file)throw new Error('unsafe-directory');}
function references(state,project,root,protectIds=[]){
 const jobs=state.jobs??[],related=jobs.filter(j=>!project.id||j.projectId===project.id);
 const busy=related.some(j=>['queued','running','cancelling'].includes(j.status)&&!j.analysisSourceSnapshot?.workspace);
 const q=new Set(),ids=new Set(protectIds),pins=new Set();
 for(const j of related)if(!terminal.has(j.status))q.add(j.questionId);
 for(const t of state.conversations??[])if(['queued','thinking','decided','ready'].includes(t.status)||t.setupPending&&t.status!=='sent'){if(!t.projectId||!project.id||t.projectId===project.id)q.add(t.questionId);}
 const pending=d=>!d.superseded&&!['sent','delivered','completed','cancelled'].includes(d.status)&&!d.messageId&&!d.deliveredAt;
 for(const collection of [state.reportDeliveries,state.websiteEvidenceDeliveries])for(const d of Object.values(collection??{}))if(pending(d)){q.add(d.questionId);ids.add(d.jobId);}
 for(const [k,c]of Object.entries(state.cardMessages??{}))if(c.revision!==c.deliveredRevision){if(k.startsWith('question:'))q.add(k.slice(9));else if(k.startsWith('job:'))ids.add(k.split(':')[1]);}
 for(const j of jobs)if(!terminal.has(j.status)||q.has(j.questionId)&&j.questionId||ids.has(j.id))visit(j,v=>{if(path.isAbsolute(v)&&inside(root,path.resolve(v)))pins.add(path.resolve(v));});
 return {busy,pinned:folder=>[...pins].some(p=>inside(folder,p)||inside(p,folder))};
}
async function inspect(folder,manifest){
 const ws=manifest.workspace;await directory(folder);await directory(ws);await regular(path.join(folder,'source-manifest.json'));
 const top=await readdir(folder);if(top.some(n=>!['workspace','source-manifest.json','build-owner.json'].includes(n)))throw new Error('unexpected-container-content');
 const roots=manifest.repositories.map(r=>path.resolve(ws,r.path));
 const scan=async d=>{const directories=[];for(const ent of await readdir(d,{withFileTypes:true})){
  const f=path.join(d,ent.name);
  if(ent.isSymbolicLink()){
   const rel=path.relative(ws,f);if(rel.split(path.sep).includes('.git'))throw new Error('git-symlink');
   const cwd=roots.filter(r=>inside(r,f)).sort((a,b)=>b.length-a.length)[0];if(!cwd||!(await g(cwd,['ls-files','--stage','--',path.relative(cwd,f)])).startsWith('120000 '))throw new Error('unexpected-symlink');continue;
  }
  if(ent.name==='.git'&&(!ent.isDirectory()||!roots.includes(d)))throw new Error('worktree-or-unknown-repository');
  if(ent.isDirectory())directories.push(f);else if(!ent.isFile())throw new Error('special-file');
 }await Promise.all(directories.map(scan));};await scan(folder);
 const sources=[];
 const inspectRepo=async r=>{
  const cwd=path.resolve(ws,r.path);await directory(cwd);await directory(path.join(cwd,'.git'));
  if(await realpath(await g(cwd,['rev-parse','--show-toplevel']))!==cwd||await g(cwd,['rev-parse','HEAD'])!==r.commit)throw new Error('changed-commit');
  if(path.resolve(cwd,await g(cwd,['rev-parse','--git-common-dir']))!==path.join(cwd,'.git'))throw new Error('external-git-directory');
  if((await g(cwd,['worktree','list','--porcelain'])).split('\n').filter(n=>n.startsWith('worktree ')).length!==1)throw new Error('registered-worktree');
  if(await lstat(path.join(cwd,'.git','objects','info','alternates')).catch(()=>null))throw new Error('shared-object-store');
  const children=roots.filter(x=>x!==cwd&&inside(cwd,x)).map(x=>':(exclude)'+path.relative(cwd,x).split(path.sep).join('/'));
  if(await g(cwd,['status','--porcelain','--untracked-files=all','--','.',...children]))throw new Error('local-changes');
  const ignored=await g(cwd,['ls-files','--others','--ignored','--exclude-standard','--','.',...children]);
  // Git can still list an ignored child repository as a directory even when the
  // pathspec excludes its contents. That repository is independently checked.
  if(ignored.split('\n').filter(Boolean).some(name=>!roots.some(child=>child!==cwd&&inside(cwd,child)&&inside(child,path.resolve(cwd,name.replace(/[\/]$/,''))))))throw new Error('local-changes');
  const heads=await g(cwd,['for-each-ref','--format=%(objectname)','refs/heads']);if(heads.split('\n').some(c=>c&&c!==r.commit))throw new Error('local-commits');
  const origin=await g(cwd,['remote','get-url','origin']);return {path:r.path,originHash:createHash('sha256').update(origin).digest('hex')};
 };
 for(let offset=0;offset<manifest.repositories.length;offset+=4)sources.push(...await Promise.all(manifest.repositories.slice(offset,offset+4).map(inspectRepo)));
 return sources;
}
function valid(m,folder,source,project){
 if(m.policy!=='isolated-environment-source-v1'||m.sourceRoot!==source||m.workspace!==path.join(folder,'workspace')||!['uat','prd'].includes(m.environment)||!Array.isArray(m.repositories)||!m.repositories.length||!Number.isFinite(Date.parse(m.checkedAt))||m.projectId&&m.projectId!==project.id)return false;
 const seen=new Set();return m.repositories.every(r=>{if(typeof r.path!=='string'||path.isAbsolute(r.path)||r.path!=='.'&&r.path.split('/').some(x=>!x||x==='.'||x==='..')||seen.has(r.path)||!/^[a-f0-9]{40,64}$/.test(r.commit??'')||typeof r.branch!=='string'||!r.branch)return false;seen.add(r.path);return inside(m.workspace,path.resolve(m.workspace,r.path));});
}
async function bytes(folder){
 if(process.platform!=='win32')return Number((await execute('du',['-sk',folder])).stdout.trim().split(/\s/)[0])*1024;
 // Logical file bytes on Windows; lstat never traverses a reparse point.
 let total=0;for(const ent of await readdir(folder)){const file=path.join(folder,ent),info=await lstat(file);total+=info.isDirectory()&&!info.isSymbolicLink()?await bytes(file):info.size;}return total;
}
export async function pruneSourceSnapshots(project,{getState,withState,apply=false,onProgress=async()=>{},protectIds=[]}={}){
 if(project.analysisSourceMode!=='isolated'||!project.analysisSnapshotRoot)return {removed:[],kept:[],unknown:[],skipped:'not-configured'};
 let root=path.resolve(project.analysisSnapshotRoot),source;
 try{if((await lstat(root)).isSymbolicLink())throw new Error('symlink');root=await realpath(root);await directory(root);source=await realpath(project.repoPath);}catch{return {removed:[],kept:[],unknown:[],skipped:'unsafe-or-missing-root'};}
 if(inside(root,source)||inside(source,root)||root===process.cwd()||inside(root,process.cwd()))return {removed:[],kept:[],unknown:[],skipped:'unsafe-root'};
 return withSnapshotLock(root,async(checkLock)=>{
  const candidates=[],kept=[],unknown=[],removed=[];
  const state=await getState();if(references(state,project,root,protectIds).busy)return {removed,kept,unknown,skipped:'project-busy'};
  for(const name of await readdir(root)){
   if(name==='.snapshot.lock'||name==='.snapshot-audit'||/^latest-[a-f0-9]{32}\.json$/.test(name))continue;
   const folder=path.join(root,name);
   if(!/^analysis-[A-Za-z0-9]+$/.test(name)){unknown.push({name,reason:'unknown-or-incomplete-build'});continue;}
   try{await directory(folder);await regular(path.join(folder,'source-manifest.json'));const manifest=JSON.parse(await readFile(path.join(folder,'source-manifest.json'),'utf8'));if(!valid(manifest,folder,source,project))throw new Error('invalid-manifest');candidates.push({name,folder,manifest});}catch{unknown.push({name,reason:'invalid-manifest-or-path'});}
  }
  const latest=new Map();for(const c of candidates)if(!latest.has(c.manifest.environment)||Date.parse(c.manifest.checkedAt)>Date.parse(latest.get(c.manifest.environment).manifest.checkedAt))latest.set(c.manifest.environment,c);
  for(const name of await readdir(root))if(/^latest-[a-f0-9]{32}\.json$/.test(name)){
   try{await regular(path.join(root,name));const pointer=JSON.parse(await readFile(path.join(root,name),'utf8')),c=candidates.find(c=>c.name===pointer.container&&c.manifest.environment===pointer.environment);if(c)latest.set(pointer.environment,c);}catch{ // An ambiguous latest pointer means no reclamation, not a guess.
    return {removed,kept,unknown,skipped:'invalid-latest-pointer'};
   }
  }
  let n=0;
  for(const item of candidates){
   await onProgress({checked:++n,total:candidates.length,name:item.name});
   const refs=references(await getState(),project,root,protectIds);
   if(refs.busy||refs.pinned(item.folder)||latest.get(item.manifest.environment)===item){kept.push({name:item.name,environment:item.manifest.environment,reason:refs.busy?'project-busy':refs.pinned(item.folder)?'active-or-delivery-reference':'latest-environment'});continue;}
   let repositorySources,size;
   try{repositorySources=await inspect(item.folder,item.manifest);size=await bytes(item.folder);}catch(error){unknown.push({name:item.name,environment:item.manifest.environment,reason:error.message||'unverified-local-state'});continue;}
   const entry={name:item.name,environment:item.manifest.environment,bytes:size,reason:'idle-managed-clean-snapshot'};
   if(!apply){removed.push(entry);continue;}
   const remove=async fresh=>{
    const refs=references(fresh,project,root,protectIds);if(refs.busy||refs.pinned(item.folder)){kept.push({...entry,reason:'became-active-before-delete'});return;}
    await directory(item.folder);await regular(path.join(item.folder,'source-manifest.json'));
    if(JSON.stringify(JSON.parse(await readFile(path.join(item.folder,'source-manifest.json'),'utf8')))!==JSON.stringify(item.manifest))throw new Error('Manifest changed during collection');
    // Recheck dirt immediately before removal, inside both the cache lock and state writer.
    await inspect(item.folder,item.manifest);
    const auditRoot=path.join(root,'.snapshot-audit');await mkdir(auditRoot,{recursive:true,mode:0o700});await directory(auditRoot);
    const audit={policy:'source-cache-reclamation-v1',projectId:project.id,manifest:item.manifest,repositorySources,...entry,at:new Date().toISOString(),status:'deleting'};
    const file=path.join(auditRoot,item.name+'.json');const save=async()=>{const temp=file+'.'+randomUUID()+'.tmp';await writeFile(temp,JSON.stringify(audit),{mode:0o600,flag:'wx'});await rename(temp,file);};
    await save();checkLock();await rm(item.folder,{recursive:true,force:false});audit.status='deleted';await save();removed.push(entry);
   };
   try{if(withState)await withState(remove);else await remove(await getState());}catch(error){unknown.push({...entry,reason:'delete-not-confirmed: '+error.message});}
  }
  return {apply,removed,kept,unknown,bytes:removed.reduce((n,r)=>n+r.bytes,0)};
 });
}
