import {loadEnvironments,verifyApprovedPlan,planQuery} from '../shared/environment-access.js';
import {assertSourceRuntimeTier} from '../shared/source-environments.js';
// Renew the same approved read scope while a person logs in, never accept a changed config/grant.
export async function renewWaitingWebsitePlan(context,job,cfg){
 const old=job.environmentAccess;if(!old||old.kind!=='website')throw new Error('Not a website login grant');
 if(Date.parse(old.expiresAt)>Date.now()){verifyApprovedPlan(cfg,old);return job;}
 verifyApprovedPlan(cfg,old,Date.parse(old.expiresAt)-1);
 assertSourceRuntimeTier(context.projects?.projects?.[job.projectId],job.sourceEnvironment,old.tier);
 const plan=planQuery(cfg,{environmentId:old.environmentId,queryId:old.queryId,parameters:old.parameters,...(old.websiteTarget?{websiteTarget:old.websiteTarget}:{})},job.projectId,{profile:old.approvalProfile??job.originProfile,senderId:job.senderId});
 if(plan.configHash!==old.configHash)throw new Error('Website login scope changed');
 return context.store.transact(state=>{
  const current=state.jobs.find(j=>j.id===job.id);
  if(current?.status!=='awaiting_clarification'||!current.result?.browserLoginRequired||current.environmentAccess.configHash!==old.configHash||current.environmentAccess.environmentId!==old.environmentId)throw new Error('Website login state changed');
  if(current.environmentAccess.scopeHash!==old.scopeHash){verifyApprovedPlan(cfg,current.environmentAccess);return structuredClone(current);}
  current.environmentAccess={...plan,startedAt:new Date().toISOString()};
  current.events??=[];current.events.push({type:'website_login_scope_revalidated',at:new Date().toISOString()});
  return structuredClone(current);
 });
}
export async function authorizeWebsiteRequest(context,initial,waiting,request){
 const current=await context.store.getJob(initial.id);if(!current)return false;
 if(current.status==='awaiting_clarification'&&current.result?.browserLoginRequired){
  const cfg=await loadEnvironments();await renewWaitingWebsitePlan(context,current,cfg);
  // Network policy still restricts origin, auth/read endpoints, methods and mutation payloads.
  return true;
 }
 if(current.status!=='running'&&!(current.status==='queued'&&current.browserResumeClaim?.scopeHash===current.environmentAccess?.scopeHash))return false;
 verifyApprovedPlan(await loadEnvironments(),current.environmentAccess);return true;
}
