import {QueryInputError} from './environment-tools.js';
import {mkdir,readFile,rename,lstat,realpath} from 'node:fs/promises';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {withSnapshotLock} from '../shared/snapshot-lock.js';
import {privateDirectory,writePrivateFile} from '../shared/private-files.js';
const digest=x=>createHash('sha256').update(JSON.stringify(x)).digest('hex');
export async function withInvestigationSession({dataDir,job,environment},run){
 if(!dataDir||!job)return run(null);
 if(!/^JOB-[A-Za-z0-9-]+$/.test(job.id))throw new Error('调查会话任务编号无效');
 let root=await realpath(dataDir);
 for(const name of ['exports',job.id,'.investigation-session']){
  const next=path.join(root,name);if(name==='.investigation-session')await privateDirectory(next);else try{await mkdir(next,{mode:0o700});}catch(e){if(e.code!=='EEXIST')throw e;}
  if((await lstat(next)).isSymbolicLink()||path.dirname(await realpath(next))!==root)throw new Error('调查会话目录边界校验失败');root=next;
 }
 const binding=digest({policy:1,job:job.id,question:job.questionId,actor:job.senderId,profile:job.originProfile??job.agentProfile,chat:job.chatId,project:job.projectId,environment,source:job.analysisSourceSnapshot?.cacheKey??job.sourceEnvironment});
 return withSnapshotLock(root,async check=>{
  const file=path.join(root,'state.json');let state={binding,records:[],planner:null,schema:null,epoch:0};
  try{const info=await lstat(file);if(!info.isFile()||info.isSymbolicLink())throw new Error('调查会话文件边界校验失败');const saved=JSON.parse(await readFile(file,'utf8'));if(saved.digest!==digest(saved.state))throw new Error('调查会话摘要校验失败');if(saved.state.binding===binding)state=saved.state;}catch(e){if(e.code!=='ENOENT')throw e;}
  const save=async()=>{check();const temp=file+'.'+process.pid+'.tmp';await writePrivateFile(temp,JSON.stringify({state,digest:digest(state)}));check();await rename(temp,file);};
  return run({root,state,save});
 });
}
const reusable=new Set(['schema','tables','select','count','group_count','aggregate','linked_aggregate','read_source_evidence','row_dataset','group_dataset','linked_group_dataset']);
// Persist only successful, task-bound evidence. Each return keeps its original observation time.
export function evidenceTools(base,session,{authorize=async()=>{},now=()=>new Date().toISOString()}={}){
 if(!session)return base;
 let hits=0,executed=0;
 return {...base,spec:[...base.spec,{tool:'inspect_evidence',args:{key:'retainedEvidence目录中的证据键'},description:'读取同一调查保留的成功取证完整结果、原参数和原取证时间。不执行新SQL，不把历史数据冒充实时；仅目录中的实际key，不读取任意文件。'},{tool:'refresh_evidence',args:{reason:'原问题要求最新或证据需重新核对的原因'},description:'显式重新取数：清除本问题可复用查询证据并关闭旧只读事务；后续读取新事务。不会删除历史成果、数据集、文件或修改业务数据。历史取证时间不能冒充实时。独立来源对账需fresh=true，任何只读工具也可传fresh=true强制新取证。'}],
 stats:()=>({reusedEvidence:hits,executedTools:executed,evidenceRecords:session.state.records.length}),
 async run(tool,args={}){
  await authorize();
  if(tool==='inspect_evidence'){const old=session.state.records.find(r=>r.key===args.key);if(!old)throw new QueryInputError('REPORT_INPUT','证据引用不存在或已显式刷新，请按原范围重新取证');hits++;return {...structuredClone(old.result),reused:true,evidenceReadAt:old.readAt,evidenceEpoch:old.epoch};}
  if(tool==='refresh_evidence'){
   if(typeof args.reason!=='string'||!args.reason.trim())throw new QueryInputError('REPORT_INPUT','重新取证需说明原因');
   await base.resetConnection?.();session.state.records=[];session.state.epoch++;await session.save();return {stage:'已切换到新取证周期；旧文件和历史证据保留',epoch:session.state.epoch};
  }
  if(args.fresh!==undefined&&typeof args.fresh!=='boolean')throw new QueryInputError('REPORT_INPUT','fresh必须是布尔值');
  const {fresh=false,...actual}=args;const key=digest({tool,args:JSON.parse(JSON.stringify(actual,(_,v)=>v&&typeof v==='object'&&!Array.isArray(v)?Object.fromEntries(Object.entries(v).sort(([a],[b])=>a.localeCompare(b))):v))});
  const old=!fresh&&reusable.has(tool)&&session.state.records.find(r=>r.key===key);
  if(old){await authorize();hits++;return {...structuredClone(old.result),reused:true,evidenceReadAt:old.readAt,evidenceEpoch:old.epoch,note:[old.result.note,'复用同一问题已成功的完整工具证据，原取证时间未更新；不是新一次数据库读取'].filter(Boolean).join('；')};}
  if(fresh)await base.resetConnection?.();
  executed++;const result=await base.run(tool,actual);
  if(reusable.has(tool)&&!result.partial&&!result.loginRequired&&!result.websiteMismatch){
   const readAt=result.readAt??now(),record={key,tool,args:actual,result,readAt,epoch:session.state.epoch};
   session.state.records=session.state.records.filter(r=>r.key!==key);session.state.records.push(record);
   if(base.exportSchema)session.state.schema=base.exportSchema();await session.save();
   return {...result,evidenceReadAt:readAt,evidenceEpoch:session.state.epoch};
  }
  return result;
 }};
}
export function batchReadTools(base,{authorize=async()=>{}}={}){
 const allowed=new Set(['schema','select','count','group_count','aggregate','linked_aggregate','read_source_evidence']);
 return {...base,spec:[...base.spec,{tool:'read_batch',args:{operations:[{tool:'schema/count/aggregate/select/group_count/linked_aggregate/read_source_evidence',args:{}}]},description:'一次规划多个已明确、互不依赖的只读取证步骤，程序逐项检查授权并顺序执行，返回每项结果/参数错误；不并发冲击数据库、不执行写入，不自动猜字段。可先批量schema，再批量多个条件汇总；新字段必须来自已读结构。用单次aggregate多指标优先于多次明细抽样。成功项可复用，失败项需修正，不重复整批。'}],async run(tool,args){
  if(tool!=='read_batch')return base.run(tool,args);
  if(!Array.isArray(args?.operations)||!args.operations.length||args.operations.some(o=>!allowed.has(o.tool)||!base.spec.some(s=>s.tool===o.tool)||!o.args||typeof o.args!=='object'||Array.isArray(o.args)))throw new QueryInputError('REPORT_INPUT','批量仅允许目录中的明确只读取证工具与参数，不嵌套批量或执行修改');
  const items=[];for(const op of args.operations){await authorize();try{items.push({...op,result:await base.run(op.tool,op.args)});}catch(error){const timeout=/timeout|timed out|超时/i.test(error.message);if(!timeout&&!['QUERY_INPUT','SCHEMA_REQUIRED','SOURCE_INPUT','REPORT_INPUT'].includes(error.code))throw error;items.push({...op,error:{code:timeout?'TIMEOUT':error.code,message:error.message},executed:timeout?undefined:false});if(timeout)return {items,remainingOperations:args.operations.slice(items.length),interrupted:true,stage:'当前查询超时；成功项保留，剩余项未执行，需重建只读连接后补查'};}}
  return {items,stage:'已逐项执行只读取证，失败项明确列出，不能当作全部完成'};
 }};
}
