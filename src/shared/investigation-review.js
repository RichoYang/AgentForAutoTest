import {currentUserQuestion}from './user-request-scope.js';
import {assessReportDelivery} from './report-acceptance.js';
import {sourcePreparationProgress} from './source-preparation.js';
import {investigationLimits} from './investigation-budget.js';
import { createHash } from 'node:crypto';
const nonempty = s => typeof s === 'string' && s.trim().length > 0;
export const QUESTION_GOAL_ID = 'original-question';
const causalQuestion = /(?:为什么|为何|为啥|原因|根因|怎么回事|咋回事|分析.{0,12}(?:报错|失败|异常)|(?:报错|失败|异常).{0,12}(?:怎么|咋))|(?:\bwhy\b|root\s*cause|what\s+caused|reason\s+for)/i;
const deepInvestigation = /(?:深度|深入|彻底|完整|全面).{0,8}(?:排查|调查|分析)|(?:排查|调查|分析).{0,8}(?:到底|根因)|查到底|刨根问底|deep\s+(?:investigation|dive)|root\s*cause/i;
const causalGoal = /(?:cause|reason|root|failure|unfinished|原因|根因|成因|为何|为什么|未完成|失败|异常)/i;
const causalUncertainty = /(?:根因|原因|具体(?:超时|失败|异常)?(?:步骤|环节|位置)?).{0,16}(?:未查明|未找到|未确认|不能确认|无法确认|无法确定|不能确定|未知)|(?:尚未|尚不能|无法|不能).{0,12}(?:确认|确定|定位).{0,12}(?:根因|原因|步骤|环节|位置)/;
const diagnosticKinds = new Set(['application_log','runtime_trace','database','source','comparison','calculation','web_runtime']);
const operationGuidance = /(?:怎么|如何|怎样|在哪|哪里).{0,18}(?:操作|创建|新增|配置|发起|申请|填写|保存|提交|办理)|(?:操作|创建|新增|配置|发起|申请|填写|保存|提交|办理).{0,18}(?:怎么|如何|怎样|步骤|流程|入口)|(?:能不能|是否能|可不可以).{0,12}(?:操作|创建|新增|配置|发起|申请|保存|提交|办理)|(?:how\s+to|where\s+(?:can|do)\s+i).{0,30}(?:create|configure|submit|apply|operate)/i;
const explicitLiveVerification = /(?:实际|直接|现场).{0,10}(?:操作|打开|进入|登录|实测|验证)|(?:打开|进入|登录).{0,12}(?:页面|系统).{0,12}(?:看看|看一下|确认|验证|操作)|(?:当前|现在).{0,10}(?:账号|用户|页面|权限).{0,12}(?:能否|是否|可以|展示|显示)|(?:帮我|请).{0,10}(?:实测|实际操作|代为操作|创建一条|提交一次)|(?:live|current\s+account|actually).{0,20}(?:verify|test|open|submit)/i;

function originalAcceptanceText(job){
 if(!nonempty(currentUserQuestion(job)))return job.instruction??'';
 const text=currentUserQuestion(job);
 // Short references retain their resolved subject. A substantive original
 // request is authoritative; appended historical knowledge never adds goals.
 const rest=text.replace(/(?:prd|uat|sit|测试|生产)\s*环境/gi,'').replace(/深度|深入|彻底|完整|全面|排查|调查|分析|一下|请|帮我|继续|接着|再|看看|查一下|这个问题|该问题|上述问题|前面的问题|在|中|[\s，,。.!！?？]/g,'');
 return rest?text:text+'\n'+String(job.instruction??'').split(/已有历史知识|已有知识资料/)[0];
}

export function requiresCausalEvidence(job) {
 // Generated directions must not add a causal acceptance gate to a report.
 return causalQuestion.test(originalAcceptanceText(job));
}
export function requiresDeepInvestigation(job) {
 return deepInvestigation.test(originalAcceptanceText(job));
}
export function isOperationGuidanceQuestion(job) {
 return operationGuidance.test(originalAcceptanceText(job));
}
export function requiresLiveVerification(job) {
 // Generated investigation instructions must not expand the user's acceptance target.
 return explicitLiveVerification.test(currentUserQuestion(job));
}

function unresolvedDeepCause(job,result){
 if(!requiresDeepInvestigation(job)||!requiresCausalEvidence(job))return false;
 const goals=result.investigation?.goals??[];
 if(goals.some(goal=>goal.id!==QUESTION_GOAL_ID&&goal.status==='open'
   &&causalGoal.test(`${goal.id ?? ''} ${goal.evidence ?? ''}`)))return true;
 const unresolved=[result.investigation?.nextStep,result.investigation?.causalAssessment?.alternatives,
  ...(result.handoff?.risks??[])].filter(Boolean).join(' ');
 return /(?:原因|根因|为何|为什么|未完成|失败|异常).{0,20}(?:尚未|仍未|未)(?:核实|确认|查明|定位|调查)|(?:尚未|仍未|未)(?:核实|确认|查明|定位|调查).{0,20}(?:原因|根因|为何|为什么|未完成|失败|异常)/.test(unresolved);
}

export function causalEvidenceComplete(job,result) {
 if(!requiresCausalEvidence(job))return true;
 if(unresolvedDeepCause(job,result))return false;
 const assessment=result.investigation?.causalAssessment;
 if(!assessment||!['confirmed','highly_supported'].includes(assessment.status)
   ||!['direct','reproduced','multi_evidence'].includes(assessment.link)||!nonempty(assessment.mechanism))return false;
 const evidence=(assessment.evidence??[]).filter(item=>nonempty(item?.reference)&&nonempty(item?.finding));
 const direct=evidence.some(item=>item.kind==='business_error');
 const independent=new Set(evidence.filter(item=>diagnosticKinds.has(item.kind)).map(item=>item.kind));
 if(!direct&&independent.size<2)return false;
 const conclusion=[assessment.mechanism,result.investigation?.goals?.find(goal=>goal.id===QUESTION_GOAL_ID)?.evidence,result.summary].filter(Boolean).join(' ');
 return !causalUncertainty.test(conclusion);
}

const questionAnswered=(job,result,root)=>root?.required===true&&root.status==='verified'&&nonempty(root.evidence)&&causalEvidenceComplete(job,result);
// Task acceptance describes whether the question was answered, not whether the
// inspected subject is healthy. Preserve contradictory failed checks as findings.
function answeredQuestionChecks(checks,root,answered){
 if(!Array.isArray(checks))return checks;
 const ids=new Set(checks.map(c=>c?.id));
 return checks.flatMap(check=>{
  if(!answered||check?.id!==QUESTION_GOAL_ID||check.required!==true||check.status!=='failed'||!nonempty(check.evidence))return [check];
  let id=QUESTION_GOAL_ID+'-finding',n=1;while(ids.has(id))id=QUESTION_GOAL_ID+'-finding-'+(++n);ids.add(id);
  return [{...check,status:'passed',evidence:root.evidence},{...check,id,required:false}];
 });
}
// The question is the acceptance target. Investigation leads may aid that target,
// but discovering a new field must not silently expand the user's request.
export function normalizeQuestionScope(job, result) {
 if(job.taskIntent!=='analysis'||!['developer','owner_report'].includes(job.stage)||result.sourceSyncBlocked||!['ready','partial','blocked','needs_clarification'].includes(result.outcome))return result;
 const investigation=result.investigation;
 if(!investigation?.goals?.some(goal=>goal.id===QUESTION_GOAL_ID))return result;
 const goals=investigation.goals.map(goal=>goal.id===QUESTION_GOAL_ID?goal:{...goal,required:false});
 let root=goals.find(goal=>goal.id===QUESTION_GOAL_ID);
 const causalIncomplete=requiresCausalEvidence(job)&&root?.status==='verified'&&!causalEvidenceComplete(job,result);
 if(causalIncomplete){root={...root,status:'open'};goals.splice(goals.findIndex(goal=>goal.id===QUESTION_GOAL_ID),1,root);}
 const answered=questionAnswered(job,{...result,investigation:{...investigation,goals}},root);
 const promoted=answered&&result.outcome!=='ready';
 const completedWithFindings=answered&&result.handoff?.checks?.some(check=>check?.id===QUESTION_GOAL_ID&&check.required===true&&check.status==='failed'&&nonempty(check.evidence));
 const handoff=result.handoff?{...result.handoff,checks:answeredQuestionChecks(result.handoff.checks?.map(check=>check?.id===QUESTION_GOAL_ID?check:check&&({...check,required:false})),root,answered),
  ...(answered?{returnTo:'none',risks:[...new Set([...(result.handoff.risks??[]),...(investigation.blocker?[`补充调查受限：${investigation.blocker.needed}`]:[])])]}:{})}:result.handoff;
 const causalNote='用户询问的是原因，但现有材料只证明了现象或候选路径，因果证据尚未闭环。';
 return {...result,outcome:answered?'ready':causalIncomplete&&result.outcome==='ready'?'partial':result.outcome,
  ...(causalIncomplete?{summary:`${causalNote} ${result.summary??''}`.slice(0,1200)}:{}),
  ...(promoted?{summary:`原问题已核实：${root.evidence}。补充调查的限制见详情。`.slice(0,1200),
   finalMessage:`原问题已核实：${root.evidence}\n\n补充调查说明（不影响上述结论）：\n${result.finalMessage??''}`} : {}),
  ...(completedWithFindings?{summary:`调查已完成；存在未通过项。${root.evidence}`.slice(0,1200),finalMessage:`原问题检查已完成，发现未通过项；具体异常及无法对照的项目如下。\n\n${result.finalMessage??''}`} : {}),
  investigation:{...investigation,goals,status:answered?'complete':investigation.status==='complete'?'continue':investigation.status,
   blocker:answered?null:investigation.blocker},handoff,
  ...(answered?{environmentQuery:null,websiteQuery:null,environmentSetup:null}: {})};
}
export function investigationComplete(job, result) {
 const r=result.investigation;
 if(r?.status!=='complete'||r.blocker||!r.goals?.length)return false;
 if(job.questionScopePolicy==='original-question-v1'&&!r.goals.some(goal=>goal.id===QUESTION_GOAL_ID))return false;
 const ids=new Set();
 const questionScoped=r.goals.some(g=>g.id===QUESTION_GOAL_ID);
 for(const g of r.goals){
  if(!nonempty(g.id)||ids.has(g.id))return false;
  if((questionScoped?g.id===QUESTION_GOAL_ID:g.required!==false)&&!nonempty(g.evidence))return false;
  if(questionScoped?(g.id===QUESTION_GOAL_ID&&(g.required!==true||g.status!=='verified')):(g.required!==false&&g.status!=='verified'))return false;
  ids.add(g.id);
 }
 if(questionScoped)return causalEvidenceComplete(job,result);
 // A later report cannot obtain completion by omitting a previously declared required goal.
 return (job.context??[]).every(x=>(x.result?.investigation?.goals??[])
  .filter(g=>g.required!==false).every(g=>ids.has(g.id)));
}
// Source-derived instructions remain useful even when optional live-page verification is unavailable.
// This is deliberately narrower than generic partial results or actual failed business validation.
export function isSourceBackedOperationGuidance(job,result){
 const root=result.investigation?.goals?.find(goal=>goal.id===QUESTION_GOAL_ID);
 return job.taskIntent==='analysis'&&['developer','owner_report'].includes(job.stage)&&!result.sourceSyncBlocked
   &&isOperationGuidanceQuestion(job)&&!requiresLiveVerification(job)&&!requiresCausalEvidence(job)
   &&result.investigation?.status==='wait'&&['approval','login','unavailable'].includes(result.investigation?.blocker?.kind)
   &&root?.status==='open'&&nonempty(root.evidence)&&nonempty(result.finalMessage)
   &&result.handoff?.artifacts?.some(a=>a.kind==='code')&&result.handoff?.risks?.length>0
   &&result.handoff?.checks?.some(c=>c.status==='passed'&&c.id!==QUESTION_GOAL_ID)
   &&result.sourceSync?.repositories?.length>0;
}
export function assessInvestigation(job,result){
 result=assessReportDelivery(job,result);
 result=normalizeQuestionScope(job,result);
 // Models may label the same evidence ready, partial or blocked. Normalize all three
 // before the handoff gate, rather than leaving a failed original-question check in partial.
 if(['ready','partial','blocked'].includes(result.outcome)&&isSourceBackedOperationGuidance(job,result)){
  result={...result,outcome:'partial',handoff:{...result.handoff,returnTo:'none',
   checks:result.handoff.checks.map(check=>check.id===QUESTION_GOAL_ID&&check.status==='failed'?{...check,status:'not_run'}:check),
   risks:[...new Set([...(result.handoff.risks??[]),'当前页面、当前账号权限及提交后的真实状态尚未实测；源码确认的操作路径可以先用于指导。'])]}};
 }
 if(job.taskIntent==='analysis'&&['developer','owner_report'].includes(job.stage)&&!result.sourceSyncBlocked
   &&result.outcome!=='partial'
   && (result.environmentSetup || result.investigation?.status==='wait'&&['login','user_input'].includes(result.investigation?.blocker?.kind)))
  return {...result,outcome:'needs_clarification'};
 if(job.taskIntent==='analysis'&&['developer','owner_report'].includes(job.stage)&&!result.sourceSyncBlocked
   &&result.outcome==='blocked'&&result.investigation?.status==='wait'&&result.investigation?.blocker?.kind==='unavailable'){
  const goals=result.investigation.goals??[],root=goals.find(goal=>goal.id===QUESTION_GOAL_ID);
  const supportingGoal=goals.some(goal=>goal.id!==QUESTION_GOAL_ID&&goal.status==='verified'&&nonempty(goal.evidence));
  const supportingCause=(result.investigation.causalAssessment?.evidence??[])
   .some(item=>diagnosticKinds.has(item?.kind)&&nonempty(item.reference)&&nonempty(item.finding));
  const usefulEvidence=nonempty(root?.evidence)&&nonempty(result.finalMessage)
   &&result.handoff?.artifacts?.length&&result.handoff?.risks?.length&&(supportingGoal||supportingCause);
  if(usefulEvidence)result={...result,outcome:'partial',handoff:{...result.handoff,returnTo:'none',
   checks:result.handoff.checks?.map(check=>check.id===QUESTION_GOAL_ID&&check.status==='failed'?{...check,status:'not_run'}:check)}};
 }
 if(job.taskIntent!=='analysis'||!['developer','owner_report'].includes(job.stage)||!['ready','partial'].includes(result.outcome))return result;
 if(investigationComplete(job,result))return result;
 const note='原问题仍有待核实目标，继续自查；尚不能认定排查完成。';
 return {...result,outcome:'partial',summary:result.summary||note,
  handoff: result.handoff ? {...result.handoff,risks:[...new Set([...(result.handoff.risks??[]),note])]} : result.handoff};
}
function signature(result){
 const r=result.investigation;
 // Do not count restated next-step plans, summaries or timestamps as new evidence.
 const evidence=r?.goals?.map(g=>[g.id,g.status,g.evidence]).sort((a,b)=>a[0].localeCompare(b[0]));
 return createHash('sha256').update(JSON.stringify(evidence??result.handoff?.checks??[])).digest('hex');
}
export function reviewDecision(job,result){
 const r=result.investigation,b=r?.blocker;
 if(r?.status==='wait'&&['login','approval','user_input','unavailable'].includes(b?.kind)
   &&nonempty(b.needed)&&nonempty(b.evidence)&&r.attempts?.some(nonempty))
  return {continue:false,reason:`等待外部配合：${b.needed}；已核实的阻碍：${b.evidence}`};
 return {continue:true};
}

export function continuousReviewDecision(job,result){
 const r=result?.investigation,b=r?.blocker;
 if(result?.outcome!=='partial'||r?.status!=='continue'||b)return {continue:false};
 return {continue:true};
}

const targetKey = value => `${value?.environmentId ?? ''}:${value?.queryId ?? ''}`;
const verifiedGoals = result => new Set((result?.investigation?.goals ?? [])
 .filter(goal => goal.status === 'verified' && nonempty(goal.id) && nonempty(goal.evidence)).map(goal => goal.id));
const continuationMetadata = (request,currentResult) => {
 const ids=request?.goalIds;
 if(ids==null)return {ok:true,metadata:null};
 if(!Array.isArray(ids)||!ids.length||ids.length>8||new Set(ids).size!==ids.length||ids.some(id=>!nonempty(id)))
  return {ok:false,reason:'定向补查必须列出1至8个未完成目标 goalIds。'};
 const goals=new Map((currentResult?.investigation?.goals??[]).map(goal=>[goal.id,goal]));
 const invalid=ids.filter(id=>{const goal=goals.get(id);return !goal||goal.required===false||goal.status!=='open';});
 if(invalid.length)return {ok:false,reason:`定向补查只能关联本轮仍未核实的核心目标：${invalid.join('、')}。`};
 const sorted=[...ids].sort();
 const evidence=sorted.map(id=>{const goal=goals.get(id);return [id,goal.status,goal.evidence??''];});
 const evidenceHash=createHash('sha256').update(JSON.stringify(evidence)).digest('hex');
 const continuationKey=createHash('sha256').update(JSON.stringify([targetKey(request),sorted,evidenceHash])).digest('hex');
 return {ok:true,metadata:{continuationGoalIds:sorted,continuationEvidenceHash:evidenceHash,continuationKey}};
};

// Only concrete tool validation failures qualify, never planner prose or permission/runtime errors.
// Each finite failure category can recover once per question and environment target.
function toolCorrectionProgress(jobs,job,request,currentResult){
 const targeted=continuationMetadata(request,currentResult);
 if(!targeted.ok||!targeted.metadata)return null;
 const latest=[...(job.context??[])].reverse().find(c=>c.kind==='environment_result')?.result;
 if(!latest||latest.environmentFailure||targetKey(latest.environmentEvidence)!==targetKey(request))return null;
 const categories=[
  ['field-type',/报表含不支持的字段值/],
  ['aggregate-shape',/aggregates必须包含/],
  ['join-grain',/覆盖核验主键必须|lookup关联键重复|来源主键为空或重复/],
 ];
 const used=new Set([...jobs,job].flatMap(j=>j.investigationProgress?.toolCorrections??[]));
 const keys=[...new Set((latest.toolInputErrors??[]).filter(e=>e.resolved===false&&['REPORT_INPUT','QUERY_INPUT'].includes(e.code)&&['group_dataset','linked_group_dataset','enrich_dataset','compose_report'].includes(e.tool)).flatMap(e=>categories.filter(([,pattern])=>pattern.test(e.message??'')).map(([category])=>createHash('sha256').update(JSON.stringify([targetKey(request),category])).digest('hex'))))].filter(k=>!used.has(k));
 return keys.length?{...targeted.metadata,toolCorrectionKeys:keys}:null;
}

// One environment worker may perform many tool calls. Starting more workers for the
// same target without closing another goal is a stalled orchestration loop.
export function environmentContinuation(state,job,request,currentResult){
 const jobs=(state.jobs??[]).filter(item=>item.questionId===job.questionId&&item.taskIntent==='analysis');
 const limits=investigationLimits();
 const correction=toolCorrectionProgress(jobs,job,request,currentResult);
 const preparation=sourcePreparationProgress({...job,investigationProgress:{...job.investigationProgress,preparationSeen:jobs.flatMap(j=>j.investigationProgress?.preparationSeen??[]),preparationRecoveries:jobs.reduce((n,j)=>n+(j.investigationProgress?.preparationRecoveries??0),0)}},currentResult,request);
 if(correction)return {continue:true,metadata:correction};
 const contexts=jobs.flatMap(item=>item.context??[]).map(entry=>entry.result).filter(Boolean);
 const targeted=continuationMetadata(request,currentResult);
 if(!targeted.ok)return {continue:false,reason:targeted.reason};
 if(preparation)return {continue:true,metadata:{...targeted.metadata,...preparation}};
 return {continue:true,metadata:targeted.metadata};
}
