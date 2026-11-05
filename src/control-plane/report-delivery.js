import {prepareReportParts} from '../shared/report-parts.js';
import {hashFile} from '../shared/file-digest.js';
import {stateView} from '../shared/state-view.js';
import {privateRecipient} from './private-cards.js';
import {reportEligible} from '../shared/report-acceptance.js';
import {createHash} from 'node:crypto';
import {reportFile} from '../shared/report-files.js';
import {messageIdOf} from './live-cards.js';
// Reports are per-question business artifacts, never shared knowledge or a public download URL.
export class ReportDelivery {
 constructor(context){this.context=context;this.workers=new Map();this.closed=false;}
 async enqueue(job){
  if(!job||job.nextJobId||job.status!=='completed'||job.result?.outcome!=='ready')return;
  const snapshot=await this.context.store.read();
  if(!snapshot.jobs.some(j=>(job.questionId?j.questionId===job.questionId:j.id===job.id)&&j.reportFiles?.length))return;
  await this.context.store.transact(state=>{
   const current=state.jobs.find(j=>j.id===job.id);if(current?.status!=='completed'||current.result?.outcome!=='ready')return;
   const q=state.questions?.[job.questionId];
   if(q&&state.jobs.filter(j=>j.questionId===job.questionId).at(-1)?.id!==job.id)return;
   const jobs=job.questionId?state.jobs.filter(j=>j.questionId===job.questionId):[current];
   state.reportDeliveries??={};
   // Only the latest finalized file is the deliverable. Earlier versions stay local.
   const candidates=jobs.flatMap(source=>(source.reportFiles??[]).filter(item=>reportEligible(current.reportReviews?current:source,item)).map(item=>({source:state.jobs.find(j=>j.id===item.sourceJobId)??source,item})));
   const selected=candidates.filter(({item})=>!q||item.questionGeneration===q.generation).slice(-1);
   for(const {source,item} of selected){
    if(q&&item.questionGeneration!==q.generation)continue;
    const key=source.id+':'+item.id;
    for(const [oldKey,entry] of Object.entries(state.reportDeliveries))if(oldKey!==key&&!entry.messageId&&entry.questionId===job.questionId&&entry.questionGeneration===q?.generation)entry.superseded=true;
    if(state.reportDeliveries[key])continue;
    const messageId=q?.messageId??job.originMessageId??job.replyToMessageId;if(!messageId)continue;
    state.reportDeliveries[key]={sourceJobId:source.id,questionId:job.questionId,questionGeneration:q?.generation,item,destination:{messageId,privateRecipient:privateRecipient(state,current),profile:q?.profile??job.originProfile??job.agentProfile,replyInThread:q?.replyInThread??job.originReplyInThread??false},createdAt:new Date().toISOString()};
   }
  });
  await this.retry();
 }
 async recover(){
  const state=await this.context.store.read();const questions=new Set(state.jobs.filter(j=>j.reportFiles?.length).map(j=>j.questionId));
  for(const id of questions){const latest=state.jobs.filter(j=>j.questionId===id).at(-1);if(latest)await this.enqueue(latest);}
 }
 async retry(snapshot){
  if(this.closed||typeof this.context.feishu.replyFile!=='function')return;
  const state=snapshot??await stateView(this.context.store,s=>{const entries=Object.entries(s.reportDeliveries??{}).filter(([,e])=>!e.messageId&&!e.superseded);const ids=new Set(entries.map(([,e])=>e.questionId));return {reportDeliveries:Object.fromEntries(entries),jobs:entries.length?(s.jobs??[]).filter(j=>ids.has(j.questionId)||entries.some(([,e])=>e.sourceJobId===j.id)):[],questions:s.questions};});
  for(const [key,entry] of Object.entries(state.reportDeliveries??{}))if(!entry.messageId&&!entry.superseded&&Date.now()>=(entry.retryAt??0)&&!this.workers.has(key)){
   if(!deliveryEligible(state,entry)){await this.context.store.transact(s=>{s.reportDeliveries[key].superseded=true;});continue;}
   if(entry.questionId&&state.questions?.[entry.questionId]?.generation!==entry.questionGeneration){await this.context.store.transact(s=>{s.reportDeliveries[key].superseded=true;});continue;}
   const work=this.deliver(key,entry);this.workers.set(key,work);work.finally(()=>this.workers.delete(key)).catch(()=>{});
  }
  await Promise.allSettled([...this.workers.values()]);
 }
 async deliver(key,entry){
  try{
   if(!/^[a-f0-9]{64}$/.test(entry.item.verificationHash??'')){await this.context.store.transact(state=>Object.assign(state.reportDeliveries[key],{superseded:true,error:'旧文件无最终核验记录，保留本地，不自动发送'}));return;}
   const {file}=await reportFile(this.context.config.dataDir,entry.sourceJobId,entry.item,{includeContent:false});
   const prepared=await prepareReportParts(file,{binary:entry.item.kind==='requirement-xlsx'});
   try{
    if(await hashFile(file)!==entry.item.sha256)throw new Error('文件在分卷时发生变化');
    const ids=[];
    for(const [index,part] of prepared.parts.entries()){
     const current=await this.context.store.read();
     if(!deliveryEligible(current,entry)||current.reportDeliveries[key]?.superseded||(entry.questionId&&current.questions?.[entry.questionId]?.generation!==entry.questionGeneration))return;
     const recipient=privateRecipient(current,current.jobs.find(j=>j.id===entry.sourceJobId));if(entry.destination.privateRecipient&&entry.destination.privateRecipient!==recipient)throw new Error('Private recipient changed');
     const prior=current.reportDeliveries[key]?.parts?.[index];
     if(prior&&(prior.sha256!==part.sha256||prior.name!==part.name))throw new Error('投递分卷内容发生变化');
     if(prior?.messageId){ids.push(prior.messageId);continue;}
     if(await hashFile(part.file)!==part.sha256)throw new Error('投递分卷摘要不符');
     const identity=prepared.parts.length===1?key:key+':'+index+':'+part.sha256;
     const result=await this.context.feishu.replyFile(entry.destination.messageId,part.file,{...entry.destination,privateRecipient:recipient,idempotencyKey:'aos-report-'+createHash('sha256').update(identity).digest('hex').slice(0,32)});
     const id=messageIdOf(result);if(!id)throw new Error('没有文件消息编号');ids.push(id);
     await this.context.store.transact(state=>{const e=state.reportDeliveries[key];e.parts??=[];e.parts[index]={name:part.name,sha256:part.sha256,bytes:part.bytes,messageId:id,deliveredAt:new Date().toISOString()};});
    }
    await this.context.store.transact(state=>Object.assign(state.reportDeliveries[key],{messageId:ids[0],messageIds:ids,partCount:ids.length,deliveredAt:new Date().toISOString(),failures:0,retryAt:0}));
   }finally{await prepared.close();}
  }catch{
   await this.context.store.transact(state=>{const e=state.reportDeliveries[key];e.failures=(e.failures??0)+1;e.retryAt=Date.now()+Math.min(300000,5000*2**Math.min(e.failures,6));e.error='文件发送或校验未通过；保留文件并等待重试，不重新查询数据库';});
  }
 }
 async close(){this.closed=true;await Promise.allSettled([...this.workers.values()]);}
}

function deliveryEligible(state,entry){const source=state.jobs.find(j=>j.id===entry.sourceJobId);const reviewer=state.jobs.filter(j=>(entry.questionId?j.questionId===entry.questionId:j.id===entry.sourceJobId)&&j.reportReviews?.[entry.item.id]).at(-1);return reportEligible(reviewer??source??{},entry.item);}
