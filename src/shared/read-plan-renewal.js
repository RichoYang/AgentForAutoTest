import {planQuery,verifyApprovedPlan} from './environment-access.js';

// Only the control plane may call this for the current running lease. Expiry is
// renewed under today's policy; no environment, principal or query is broadened.
export function renewReadPlan(config,plan,actor,now=Date.now()){
 const expires=Date.parse(plan?.expiresAt);
 if(!Number.isFinite(expires)||!plan.startedAt&&!actor.starting||actor.projectId!==plan.projectId||actor.profile!==plan.approvalProfile)throw new Error('只允许接续原身份的只读查询');
 verifyApprovedPlan(config,plan,Math.min(now,expires-1));
 const next=planQuery(config,{environmentId:plan.environmentId,queryId:plan.queryId,parameters:plan.parameters,...(plan.websiteTarget?{websiteTarget:plan.websiteTarget}:{})},actor.projectId,{senderId:actor.senderId,profile:actor.profile},now);
 if(next.approvalRequired||next.configHash!==plan.configHash)throw new Error('原只读范围或当前授权策略已改变，不能自动续期');
 return {...plan,...next,startedAt:plan.startedAt,previousScopeHash:plan.scopeHash,renewedAt:new Date(now).toISOString()};
}
