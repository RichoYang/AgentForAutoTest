import {createHash}from 'node:crypto';
export const capacityScope=plan=>createHash('sha256').update(JSON.stringify([plan.projectId,plan.environmentId,plan.queryId,plan.parameters,plan.configHash,plan.websiteTarget??null])).digest('hex');
export const isModelCapacityError=error=>error?.code==='MODEL_CAPACITY'||/selected model is at capacity|model.{0,40}(?:at capacity|overloaded|temporarily unavailable)/i.test(String(error?.message??error??''));
export function modelCapacityWait(checkpoint,previous={},now=Date.now()){
 const attempt=(previous.attempt??0)+1,delayMs=Math.min(60000,5000*2**Math.min(attempt-1,4));
 const modelRecovery={attempt,firstWaitAt:previous.firstWaitAt??new Date(now).toISOString(),nextAttemptAt:new Date(now+delayMs).toISOString(),stage:checkpoint.stage};
 return {outcome:'needs_clarification',modelCapacityWaiting:true,modelCapacityState:'waiting',modelFailure:{code:'MODEL_CAPACITY',stage:checkpoint.stage==='environment'?'planning':'source_analysis'},modelRecovery,modelCheckpoint:checkpoint,
  summary:'模型服务暂时繁忙，任务已保留，等待自动恢复；无需重新提问或提供凭据。',
  finalMessage:`模型服务返回 MODEL_CAPACITY，当前步骤尚未完成。已保存原问题、已有证据和恢复现场，预计 ${delayMs/1000} 秒后按原身份和范围自动接续。不会自动重放已完成的业务查询，不会修改模型配置。可在原卡取消任务。`,verification:[]};
}
