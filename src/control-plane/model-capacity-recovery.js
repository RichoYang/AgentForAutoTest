import{loadIntegrationProjects,assertTaskReadScope}from '../shared/integration-peers.js';
import {capacityScope}from '../shared/model-capacity-wait.js';
import {loadHarness}from '../runner/harness.js';
import {loadEnvironments}from '../shared/environment-access.js';import {renewReadPlan}from '../shared/read-plan-renewal.js';
import {publishQuestion}from './questions.js';
const polling=new WeakMap();
export function pollModelCapacity(context,{now=Date.now(),load=loadEnvironments,publish=publishQuestion}={}){
 if(polling.has(context))return polling.get(context);
 const work=(async()=>{const snapshot=await context.store.read();for(const original of snapshot.jobs??[]){
  if(context.capacityRecoveryStopped)return;
  if(original.status!=='awaiting_clarification'||!original.result?.modelCapacityWaiting||original.result.modelCapacityState==='access_check_failed'||Date.parse(original.result.modelRecovery?.nextAttemptAt)>now)continue;
  if(!Number.isFinite(Date.parse(original.result.modelRecovery?.nextAttemptAt)))continue;
  try{
   const cp=original.result.modelCheckpoint;if(original.taskIntent!=='analysis'||!cp||!['environment','source'].includes(cp.stage))throw Error('Invalid recovery scope');
   let plan;
   if(cp.stage==='environment'){
    const old=original.environmentAccess;if(!old||old.environmentId!==cp.environmentId||old.queryId!==cp.queryId||old.configHash!==cp.configHash||cp.scopeIdentity!==capacityScope(old))throw Error('Environment scope changed');
    const cfg=await load();if(old.projectId!==original.projectId)assertTaskReadScope(context.config?.projectsFile?await loadIntegrationProjects(context.config.projectsFile):context.projects,original,cfg,old);
    plan=renewReadPlan(cfg,old,{projectId:old.projectId,profile:old.approvalProfile??original.originProfile,senderId:original.senderId,starting:true},now);
    // This is a new lease for checkpoint continuation. The prior claim remains
    // in the audit history; carrying its startedAt would reject the new claim.
    delete plan.startedAt;
   }else if(cp.agentStage&&cp.agentStage!==original.stage||!cp.threadId||cp.questionId!==original.questionId||cp.workspace!==original.analysisSourceSnapshot?.workspace)throw Error('Source continuation not verified');
   if(cp.stage==='source'&&cp.harnessFingerprint&&(await loadHarness({...original,context:[]})).metadata.fingerprint!==cp.harnessFingerprint)throw Error('Source harness changed');
   const changed=await context.store.transact(s=>{const j=s.jobs.find(x=>x.id===original.id);if(context.capacityRecoveryStopped||j?.status!=='awaiting_clarification'||!j.result?.modelCapacityWaiting||j.result.modelRecovery.nextAttemptAt!==original.result.modelRecovery.nextAttemptAt||j.projectId!==original.projectId||j.senderId!==original.senderId||j.originProfile!==original.originProfile||JSON.stringify(j.result.modelCheckpoint)!==JSON.stringify(cp)||j.environmentAccess?.scopeHash!==original.environmentAccess?.scopeHash)return false;
    j.modelRecoveryHistory??=[];j.modelRecoveryHistory.push({at:new Date(now).toISOString(),attempt:j.result.modelRecovery.attempt,previousStartedAt:j.environmentAccess?.startedAt,checkpoint:cp});
    j.modelCheckpoint=cp;j.modelRecovery=j.result.modelRecovery;if(plan)j.environmentAccess=plan;else j.analysisContinuation={questionId:cp.questionId,workspace:cp.workspace,threadId:cp.threadId};
    j.result=null;j.status='queued';j.updatedAt=new Date(now).toISOString();j.events.push({type:'model_capacity_resumed',at:j.updatedAt,attempt:j.modelRecovery.attempt,stage:cp.stage});if(s.questions?.[j.questionId])s.questions[j.questionId].generation++;return true;});
   if(changed&&context.cards&&original.questionId)await publish(context,original.questionId);
  }catch{
   const changed=await context.store.transact(s=>{const j=s.jobs.find(x=>x.id===original.id);if(j?.status!=='awaiting_clarification'||!j.result?.modelCapacityWaiting)return false;j.result.modelCapacityState='access_check_failed';j.result.summary='模型等待现场已保留，但原访问范围或恢复会话核验未通过，请维护者复核；没有自动重放查询。';j.result.finalMessage=j.result.summary;j.updatedAt=new Date(now).toISOString();return true;});
   if(changed&&context.cards&&original.questionId)await publish(context,original.questionId);
  }
 }})();polling.set(context,work);work.finally(()=>{if(polling.get(context)===work)polling.delete(context);}).catch(()=>{});return work;
}
