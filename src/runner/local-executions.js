import {rename,readFile,readdir,lstat,unlink} from 'node:fs/promises';
import {hostname} from 'node:os';
import {createHash,randomUUID} from 'node:crypto';
import path from 'node:path';
import {interruptedInvestigation} from '../shared/investigation-budget.js';
import {windowsHelper,windowsQuery} from '../shared/windows-kernel.js';
import {privateDirectory,writePrivateFile} from '../shared/private-files.js';
const name=job=>createHash('sha256').update(JSON.stringify([job.id,job.lease.id])).digest('hex')+'.json';
export async function registerLocalExecution(directory,job,pid,{platform=process.platform}={}){
 let guard;
 if(platform==='win32'){
  const jobName='Local\\AgentOS-'+randomUUID(),helper=windowsHelper('guard',{name:jobName,ownerPid:process.pid,workerPid:pid});
  try{const proof=await helper.first;if(!proof.guarded||!proof.ownerCreated||!proof.workerCreated)throw new Error('Windows worker identity unavailable');guard={...helper,proof,jobName,close:async()=>{helper.child.stdin.end();await helper.closed;}};}catch(error){helper.child.stdin.end();await helper.closed;throw error;}
 }
 if(!directory)return guard;
 try{
 await privateDirectory(directory);if((await lstat(directory)).isSymbolicLink())throw new Error('Execution registry must be private regular directory');
 const entry={version:guard?2:1,host:hostname(),platform,ownerPid:process.pid,workerPid:pid,jobId:job.id,runnerId:job.lease.runnerId,leaseId:job.lease.id,at:new Date().toISOString(),...(guard?{jobName:guard.jobName,ownerCreated:guard.proof.ownerCreated,workerCreated:guard.proof.workerCreated,treePolicy:'windows-job-kill-on-close-v1'}:{})};
 const file=path.join(directory,name(job));await writePrivateFile(file+'.tmp',JSON.stringify(entry));await rename(file+'.tmp',file);
 return guard;
 }catch(error){await guard?.close();throw error;}
}
export function processAbsent(pid){
 try{process.kill(pid,0);return false;}catch(e){return e.code==='ESRCH';}
}
// Local launcher only. Never infer a remote Runner's process identity from its display name.
export async function recoverLocalExecutions(store,directory,{host=hostname(),platform=process.platform,absent=processAbsent}={}){
 let files;try{if((await lstat(directory)).isSymbolicLink())throw new Error('Invalid execution registry');files=await readdir(directory);}catch(e){if(e.code==='ENOENT')return {recovered:0};throw e;}
 let recovered=0;const blocked=[];
 for(const file of files.filter(f=>/^[a-f0-9]{64}\.json$/.test(f))){
  let entry;const full=path.join(directory,file);
  try{const info=await lstat(full);if(!info.isFile()||info.isSymbolicLink()||info.size>4096)continue;entry=JSON.parse(await readFile(full,'utf8'));}catch{continue;}
  if(entry.host!==host||entry.platform!==platform||![entry.ownerPid,entry.workerPid].every(p=>Number.isSafeInteger(p)&&p>1)||file!==name({id:entry.jobId,lease:{id:entry.leaseId}}))continue;
  if(platform==='win32'){
   // Legacy records have no kernel ownership proof. Never infer tree absence from a dead PID.
   if(entry.version!==2||entry.treePolicy!=='windows-job-kill-on-close-v1'||!/^Local\\AgentOS-[a-f0-9-]{36}$/.test(entry.jobName)||!/^\d+$/.test(entry.ownerCreated)||!/^\d+$/.test(entry.workerCreated))continue;
   let proof;try{proof=await windowsQuery('probe',{...entry,name:entry.jobName});}catch(error){blocked.push({jobId:entry.jobId,code:'WINDOWS_PROBE_HELPER_UNAVAILABLE',details:[{field:'helper',code:error.code??'HELPER_FAILED',message:error.message}]});continue;}
   if(proof.errors?.length||proof.active===null){blocked.push({jobId:entry.jobId,code:'WINDOWS_PROCESS_PROOF_UNAVAILABLE',details:proof.errors});continue;}
   if(proof.ownerCreated===entry.ownerCreated||proof.workerCreated===entry.workerCreated||proof.active!==0)continue;
  }else if(entry.version!==1||!absent(entry.ownerPid)||!absent(-entry.workerPid))continue;
  const candidate=await store.select(s=>s.jobs.find(j=>j.id===entry.jobId&&['running','cancelling'].includes(j.status)&&j.lease?.id===entry.leaseId&&j.lease.runnerId===entry.runnerId)?.id);
  if(!candidate){await unlink(full).catch(()=>{});continue;}
  const changed=await store.transact(state=>{
   const job=state.jobs.find(j=>j.id===entry.jobId);
   if(!job||!['running','cancelling'].includes(job.status)||job.lease?.id!==entry.leaseId||job.lease.runnerId!==entry.runnerId)return false;
   const cancelled=job.events?.some(e=>e.type==='cancel_requested');
   job.result=interruptedInvestigation(job,'本机执行器已退出，已确认原任务进程树不存在；已有成果保留，业务动作状态仍须按原台账对账，本轮没有完成交付，不自动重跑业务查询','EXECUTOR_EXITED');
   job.status=cancelled?'cancelled':'blocked';job.lease=null;delete job.environmentAccess;
   job.updatedAt=new Date().toISOString();job.events.push({type:cancelled?'cancelled':'failed',at:job.updatedAt,processesExited:true,recoveredAfterExecutorExit:true});return true;
  });
  if(changed)recovered++;
  // A terminal/stale record cannot authorize a later task or lease.
  await unlink(full).catch(()=>{});
 }
 return {recovered,...(blocked.length?{blocked}:{})};
}
