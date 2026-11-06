import {createHash,randomUUID} from 'node:crypto';
import {withSnapshotLock} from '../shared/snapshot-lock.js';
import { mkdir, mkdtemp, realpath, writeFile, readFile, readdir, lstat, rename, rm } from 'node:fs/promises';
import path from 'node:path';
import { git, repositories } from './source-sync.js';
import { selectSourceEnvironment } from '../shared/source-environments.js';
const policy = 'isolated-environment-source-v1';
function within(root, target) {
  const relative = path.relative(root, target);
  return relative && relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}
async function settings(project, environment) {
  if (project.analysisSourceMode !== 'isolated') throw new Error('独立分析配置已改变，请重新分析');
  const id = selectSourceEnvironment(project, environment);
  if (!project.analysisSnapshotRoot || !path.isAbsolute(project.analysisSnapshotRoot)) throw new Error('请配置绝对路径 analysisSnapshotRoot');
  const sourceRoot = await realpath(project.repoPath);
  await mkdir(project.analysisSnapshotRoot, { recursive: true, mode: 0o700 });
  if((await lstat(project.analysisSnapshotRoot)).isSymbolicLink())throw new Error('源码缓存根目录不能是符号链接');
  const snapshotRoot = await realpath(project.analysisSnapshotRoot);
  if (snapshotRoot === sourceRoot || within(sourceRoot, snapshotRoot) || within(snapshotRoot, sourceRoot)) throw new Error('分析快照目录必须与个人项目目录分开');
  const repos = await repositories({ ...project, analysisRepositories: project.analysisEnvironments[id].repositories });
  repos.sort((a, b) => a.path.split('/').length - b.path.split('/').length || (a.path === '.' ? -1 : b.path === '.' ? 1 : a.path.localeCompare(b.path)));
  return { id, sourceRoot, snapshotRoot, repos };
}
export async function syncSnapshot(project, environment) {
 const prepared=await settings(project,environment);
 return withSnapshotLock(prepared.snapshotRoot,async(checkLock)=>{
  const {id,sourceRoot,snapshotRoot,repos}=prepared;
  const remote=[];
  for(const repo of repos){
   try{
    const origin=await git(repo.cwd,['remote','get-url','origin']);
    const lines=await git(repo.cwd,['ls-remote','origin',`refs/heads/${repo.branch}`]);
    const [commit,ref]=lines.split(/\s+/);
    if(!/^[a-f0-9]{40,64}$/.test(commit??'')||ref!==`refs/heads/${repo.branch}`)throw new Error();
    remote.push({...repo,origin,originHash:createHash('sha256').update(origin).digest('hex'),commit});
   }catch{throw new Error(`源码快照同步失败：${repo.path} 的 ${repo.branch}；远端分支不可用，未回退到旧缓存或其它环境。`);}
  }
  const cacheKey=createHash('sha256').update(JSON.stringify([project.id??sourceRoot,sourceRoot,id,remote.map(({path,branch,originHash,commit})=>({path,branch,originHash,commit}))])).digest('hex');
  const container=path.join(snapshotRoot,'analysis-'+cacheKey),remoteCheckedAt=new Date().toISOString();
  const existing=await lstat(container).catch(e=>{if(e.code!=='ENOENT')throw e;return null;});
  let report;
  if(existing){
   if(!existing.isDirectory()||existing.isSymbolicLink())throw new Error('快照缓存路径异常，未复用');
   report=JSON.parse(await readFile(path.join(container,'source-manifest.json'),'utf8'));
   if(report.cacheKey!==cacheKey||report.environment!==id||report.sourceRoot!==sourceRoot||report.workspace!==path.join(container,'workspace')||JSON.stringify(report.repositories)!==JSON.stringify(remote.map(({path,branch,commit})=>({path,branch,commit}))))throw new Error('快照缓存身份不一致');
   await verifySnapshotUnlocked(project,report);
  }else{
   const temporary=await mkdtemp(path.join(snapshotRoot,'building-'));
   const workspace=path.join(temporary,'workspace');await mkdir(workspace,{mode:0o700});
   report={policy,cacheKey,projectId:project.id??null,repositorySources:remote.map(({path,originHash})=>({path,originHash})),environment:id,sourceRoot,workspace:path.join(container,'workspace'),checkedAt:remoteCheckedAt,repositories:[]};
   // Rebuilding a reclaimed content identity must preserve its immutable proof.
   try{const dir=path.join(snapshotRoot,'.snapshot-audit'),file=path.join(dir,path.basename(container)+'.json');if((await lstat(dir)).isSymbolicLink()||(await lstat(file)).isSymbolicLink())throw new Error();const old=JSON.parse(await readFile(file,'utf8'));if(old.policy==='source-cache-reclamation-v1'&&old.manifest.cacheKey===cacheKey&&old.manifest.sourceRoot===sourceRoot&&JSON.stringify(old.manifest.repositorySources)===JSON.stringify(report.repositorySources)&&JSON.stringify(old.manifest.repositories)===JSON.stringify(remote.map(({path,branch,commit})=>({path,branch,commit}))))report.checkedAt=old.manifest.checkedAt;}catch{}

   try{
    await writeFile(path.join(temporary,'build-owner.json'),JSON.stringify({policy:'snapshot-build-v1',sourceRoot,environment:id}),{mode:0o600,flag:'wx'});
    for(const repo of remote){
     const target=path.resolve(workspace,repo.path);let ancestor=workspace;
     for(const part of path.relative(workspace,target).split(path.sep).filter(Boolean)){
      ancestor=path.join(ancestor,part);const info=await lstat(ancestor).catch(e=>{if(e.code!=='ENOENT')throw e;return null;});
      if(info?.isSymbolicLink())throw new Error('快照路径包含符号链接');
     }
     await mkdir(target,{recursive:true});
     if((target!==workspace&&!within(workspace,await realpath(target)))||(await readdir(target)).length)throw new Error(`快照路径冲突：${repo.path}`);
     try{
      await git(target,['init']);await git(target,['remote','add','origin',repo.origin]);
      await git(target,['fetch','--depth=1','--no-tags','--no-recurse-submodules','origin',`refs/heads/${repo.branch}`]);
      if(await git(target,['rev-parse','FETCH_HEAD'])!==repo.commit)throw new Error();
      await git(target,['checkout','--detach',repo.commit]);
      report.repositories.push({path:repo.path,branch:repo.branch,commit:repo.commit});
     }catch{throw new Error(`源码快照同步失败：${repo.path} 的 ${repo.branch}；远端可能在同步中变化，请重新核对。未覆盖旧快照或个人源码。`);}
    }
    await writeFile(path.join(temporary,'source-manifest.json'),JSON.stringify(report),{mode:0o600,flag:'wx'});
    checkLock();await rename(temporary,container);
   }catch(error){await rm(temporary,{recursive:true,force:true});throw error;}
   await verifySnapshotUnlocked(project,report);
  }
  const pointer=path.join(snapshotRoot,'latest-'+createHash('sha256').update(JSON.stringify([project.id??sourceRoot,sourceRoot,id])).digest('hex').slice(0,32)+'.json');
  const tmp=pointer+'.'+randomUUID()+'.tmp';await writeFile(tmp,JSON.stringify({environment:id,container:path.basename(container),remoteCheckedAt}),{mode:0o600,flag:'wx'});await rename(tmp,pointer);
  return {...report,remoteCheckedAt};
 });
}
async function verifySnapshotUnlocked(project, report) {
  const { id, sourceRoot, snapshotRoot, repos } = await settings(project, report.environment);
  const ws=await lstat(report.workspace);if(!ws.isDirectory()||ws.isSymbolicLink())throw new Error('源码缓存工作区路径异常');
  const workspace = await realpath(report.workspace);
  const container = path.dirname(workspace);
  if (!within(snapshotRoot, container) || path.dirname(container) !== snapshotRoot || path.basename(workspace) !== 'workspace' || report.sourceRoot !== sourceRoot || report.environment !== id) throw new Error('快照证据路径或环境不匹配');
  if((await lstat(container)).isSymbolicLink()||!(await lstat(path.join(container,'source-manifest.json'))).isFile()||(await lstat(path.join(container,'source-manifest.json'))).isSymbolicLink())throw new Error('源码缓存清单路径异常');
  const manifest = JSON.parse(await readFile(path.join(container, 'source-manifest.json'), 'utf8'));
  const {remoteCheckedAt,...immutable}=report;
  if (JSON.stringify(manifest) !== JSON.stringify(immutable) || report.repositories.length !== repos.length) throw new Error('源码快照清单与任务证据不匹配');
  for (const repo of repos) {
    const cwd = await realpath(path.resolve(workspace, repo.path));
    if (cwd !== workspace && !within(workspace, cwd)) throw new Error('源码快照路径越界');
    if(!(await lstat(path.join(cwd,'.git'))).isDirectory()||(await lstat(path.join(cwd,'.git'))).isSymbolicLink())throw new Error('源码缓存不是独立克隆');
    const proof = report.repositories.find(x => x.path === repo.path && x.branch === repo.branch);
    if (!proof || await realpath(await git(cwd, ['rev-parse', '--show-toplevel'])) !== cwd || await git(cwd, ['rev-parse', 'HEAD']) !== proof.commit) throw new Error('源码已不同于本次分析快照');
    // Independently cloned child repositories are verified below, not untracked dirt in their parent.
    const children = repos.filter(x => x.path !== repo.path && within(cwd, path.resolve(workspace, x.path))).map(x => `:(exclude)${path.relative(cwd, path.resolve(workspace, x.path)).split(path.sep).join('/')}`);
    if (await git(cwd, ['status', '--porcelain', '--untracked-files=all', '--', '.', ...children])) throw new Error('源码快照存在本地修改，请重新分析');
  }
  return report;
}

export async function verifySnapshot(project,report){
 const prepared=await settings(project,report.environment);
 return withSnapshotLock(prepared.snapshotRoot,()=>verifySnapshotUnlocked(project,report));
}
// Reclaimed historical evidence is restored at its EXACT commit and original path.
// A failed restoration never silently substitutes the current branch tip.
export async function restoreSnapshot(project,report){
 const prepared=await settings(project,report.environment);
 return withSnapshotLock(prepared.snapshotRoot,async(checkLock)=>{
  const {snapshotRoot,sourceRoot,repos,id}=prepared,container=path.dirname(report.workspace);
  if(path.dirname(container)!==snapshotRoot||path.basename(report.workspace)!=='workspace'||report.sourceRoot!==sourceRoot||!/^analysis-[A-Za-z0-9]+$/.test(path.basename(container)))throw new Error('历史源码缓存路径不匹配');
  if(await lstat(container).catch(e=>{if(e.code!=='ENOENT')throw e;return null;}))return verifySnapshotUnlocked(project,report);
  let audit;
  try{const dir=path.join(snapshotRoot,'.snapshot-audit');if((await lstat(dir)).isSymbolicLink())throw new Error();const file=path.join(dir,path.basename(container)+'.json');if((await lstat(file)).isSymbolicLink())throw new Error();audit=JSON.parse(await readFile(file,'utf8'));}catch{throw new Error('历史源码缓存已不可用且没有可信提交清单；请恢复原快照，或明确新建问题核对最新版本。未切换提交。');}
  const {remoteCheckedAt,...immutable}=report;
  if(audit.policy!=='source-cache-reclamation-v1'||JSON.stringify(audit.manifest)!==JSON.stringify(immutable))throw new Error('历史源码清理清单与原任务不匹配；未切换提交');
  const tmp=await mkdtemp(path.join(snapshotRoot,'building-'));
  try{
   await writeFile(path.join(tmp,'build-owner.json'),JSON.stringify({policy:'snapshot-build-v1',sourceRoot,environment:id}),{mode:0o600});
   const workspace=path.join(tmp,'workspace');await mkdir(workspace);
   if(repos.length!==report.repositories.length)throw new Error('仓库配置已变化');
   for(const repo of repos){
    const proof=report.repositories.find(r=>r.path===repo.path&&r.branch===repo.branch),origin=await git(repo.cwd,['remote','get-url','origin']);
    const source=audit.repositorySources.find(r=>r.path===repo.path);
    if(!proof||!source||source.originHash!==createHash('sha256').update(origin).digest('hex'))throw new Error('仓库来源已变化');
    const target=path.resolve(workspace,repo.path);if(target!==workspace&&!within(workspace,target))throw new Error('仓库路径越界');
    let ancestor=workspace;for(const part of path.relative(workspace,target).split(path.sep).filter(Boolean)){ancestor=path.join(ancestor,part);if((await lstat(ancestor).catch(()=>null))?.isSymbolicLink())throw new Error('仓库路径包含符号链接');}
    await mkdir(target,{recursive:true});if((await readdir(target)).length)throw new Error('仓库路径冲突');
    await git(target,['init']);await git(target,['remote','add','origin',origin]);await git(target,['fetch','--depth=1','--no-tags','--no-recurse-submodules','origin',proof.commit]);
    if(await git(target,['rev-parse','FETCH_HEAD'])!==proof.commit)throw new Error('提交不一致');await git(target,['checkout','--detach',proof.commit]);
   }
   await writeFile(path.join(tmp,'source-manifest.json'),JSON.stringify(immutable),{mode:0o600});checkLock();await rename(tmp,container);return await verifySnapshotUnlocked(project,report);
  }catch{await rm(tmp,{recursive:true,force:true});throw new Error('历史源码缓存恢复失败：原提交或仓库来源不可用。请维护者恢复原提交后继续，或明确新建问题核对最新版本；没有改用旧缓存或其它提交。');}
 });
}

// Add ancestry only to Git metadata; never checkout a newer branch or rewrite proof.
// The same lock is used by creation, verification and garbage collection.
async function verifyHistoryMetadata(cwd) {
 const root=path.join(cwd,'.git'),pending=[root];
 while(pending.length){
  const dir=pending.pop();
  for(const entry of await readdir(dir,{withFileTypes:true})){
   const file=path.join(dir,entry.name);
   if(entry.isSymbolicLink())throw new Error('Git历史元数据包含符号链接，未写入');
   if(entry.isDirectory())pending.push(file);
  }
 }
 for(const relative of ['commondir','objects/info/alternates','objects/info/http-alternates','worktrees']){
  if(await lstat(path.join(root,relative)).catch(e=>{if(e.code!=='ENOENT')throw e;return null;}))throw new Error('Git历史元数据包含共享对象库或worktree，未写入');
 }
}
export async function prepareSnapshotHistory(project, report) {
 const prepared=await settings(project,report.environment);
 return withSnapshotLock(prepared.snapshotRoot,async()=>{
  await verifySnapshotUnlocked(project,report);
  const results=[];
  for(const proof of report.repositories){
   const cwd=path.resolve(report.workspace,proof.path);
   try {
    await verifyHistoryMetadata(cwd);
    const configured=prepared.repos.find(r=>r.path===proof.path&&r.branch===proof.branch);
    const origin=await git(configured.cwd,['remote','get-url','origin']);
    const actual=await git(cwd,['remote','get-url','origin']);
    const fingerprint=report.repositorySources?.find(r=>r.path===proof.path)?.originHash;
    if(actual!==origin||(fingerprint&&fingerprint!==createHash('sha256').update(origin).digest('hex')))throw new Error('仓库来源变化，未读取其它来源的历史');
    if(await git(cwd,['rev-parse','--is-shallow-repository'])==='true'){
     await git(cwd,['fetch','--unshallow','--no-tags','--no-recurse-submodules','origin',proof.commit]);
    }
    if(await git(cwd,['rev-parse','--is-shallow-repository'])!=='false')throw new Error('上游仍是浅仓库，历史不完整');
    await git(cwd,['rev-list','--count',proof.commit]);
    results.push({...proof,status:'complete',scope:'fixed-commit-ancestors',checkedAt:new Date().toISOString()});
   }catch(error){results.push({...proof,status:'unavailable',reason:error.message,recovery:'恢复原仓库的历史读取或认证后重试同一问题；不切换固定提交。'});}
  }
  await verifySnapshotUnlocked(project,report);
  return {repositories:results,deploymentVerified:false};
 });
}
