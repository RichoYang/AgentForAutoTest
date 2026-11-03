import {websiteApplication} from '../shared/website-application.js';
import {renewWaitingWebsitePlan} from './website-authorization.js';
import {assertSourceRuntimeTier} from '../shared/source-environments.js';
import {stateView} from '../shared/state-view.js';
import { canonicalWebsite } from '../shared/website-aliases.js';
import { mkdir, writeFile, rename } from 'node:fs/promises';
import path from 'node:path';
import { environmentFile, loadEnvironments, planQuery, verifyApprovedPlan } from '../shared/environment-access.js';
import { websiteUrl, websiteKey } from '../shared/website-policy.js';
let updates=Promise.resolve();
const polling=new WeakMap();
export function prepareWebsiteQuery(context,job,request){
 const pending=updates.then(async()=>{
  if(!request||!['uat','prd'].includes(request.tier))throw Object.assign(new Error('网页排查运行分级无效'),{queryDiagnostic:{code:'WEBSITE_TIER_INVALID',reason:'网页排查未指定有效的测试/生产运行分级。',correction:'按协议使用 uat（测试）或 prd（生产），源码环境ID保持本项目配置。'}});
  const purpose=request.purpose;
  const issue=typeof purpose!=='string'?'type':!purpose.trim()?'empty':/[\u0000-\u001f\u007f]/.test(purpose)?'control_characters':null;
  if(issue)throw Object.assign(new Error('Invalid website purpose'),{queryDiagnostic:{code:'TEXT_PARAMETER',index:0,reason:issue,length:typeof purpose==='string'?purpose.length:null,maxLength:200}});
  assertSourceRuntimeTier(context.projects.projects?.[job.projectId],job.sourceEnvironment,request.tier);
  const cfg=await loadEnvironments();
  const requestedUrl=canonicalWebsite(cfg,job.projectId,request.tier,request.url);
  // A deep page in the same question stays in its already-used application entry.
  // Do not copy a grant or bootstrap endpoint list into a freshly registered page.
  const known=(job.context??[]).slice().reverse().map(c=>cfg.environments[c.result?.environmentEvidence?.environmentId]).find(e=>{
   if(!e||e.kind!=='website'||e.projectId!==job.projectId||e.tier!==request.tier)return false;
   const base=new URL(e.baseUrl),target=new URL(requestedUrl),prefix=base.pathname.replace(/\/$/,'');
   return base.origin===target.origin&&(target.pathname===prefix||target.pathname.startsWith(prefix+'/'));
  });
  const application=websiteApplication(cfg,job.projectId,request.tier,requestedUrl);
  const baseUrl=application?websiteUrl(application.entry.baseUrl):known?websiteUrl(known.baseUrl):requestedUrl,environmentId=application?.environmentId??websiteKey(job.projectId,request.tier,baseUrl);
  if(cfg.environments[environmentId] && websiteUrl(cfg.environments[environmentId].baseUrl)!==baseUrl)throw new Error('网页入口登记冲突，未复用其他页面');
  if(!cfg.environments[environmentId]){
   const owners=context.projects.ownerOpenIdsByProfile??{};
   if(!(owners[job.originProfile]??[]).length)throw new Error('本项目没有配置管理员身份');
   cfg.environments[environmentId]={projectId:job.projectId,tier:request.tier,kind:'website',baseUrl,credentialRef:environmentId,ownerOpenIdsByProfile:owners,membersRead:request.tier==='uat',queries:{investigate:{mode:'investigate',reviewed:true,description:'按原问题查看业务网页、查询与日志；不执行修改、启动或停止',maxRows:20,timeoutMs:10000,parameters:[{name:'purpose',type:'string',maxLength:200}],browser:true}}};
   const file=environmentFile();await mkdir(path.dirname(file),{recursive:true});const temp=file+'.website.tmp';await writeFile(temp,JSON.stringify(cfg,null,2)+'\n',{mode:0o600});await rename(temp,file);
  }
  return {environmentId,queryId:'investigate',parameters:[request.purpose]};
 });updates=pending.catch(()=>{});return pending;
}
export function pollWebsiteLogins(context){
 if(polling.has(context))return polling.get(context);
 const run=resumeWebsiteLogins(context).finally(()=>polling.delete(context));polling.set(context,run);return run;
}
async function resumeWebsiteLogins(context){
 const jobs=await stateView(context.store,s=>(s.jobs??[]).filter(j=>j.status==='awaiting_clarification'&&j.result?.browserLoginRequired===true&&j.environmentAccess?.kind==='website'));
 for(let job of jobs){
  try{
   const cfg=await loadEnvironments(),e=cfg.environments[job.environmentAccess.environmentId];if(!e)continue;
   job=await renewWaitingWebsitePlan(context,job,cfg);
   const recovery=context.websiteCredentials?.recoverLogin?await context.websiteCredentials.recoverLogin(job,e):(await context.websiteCredentials?.autoLogin(job,e),null);
   const login=await context.websiteBrowser.loginStatusFor?.(job,e);
   if(login&&!login.pageReady){
    const state=login.passwordChangeRequired?'password_change_required':login.verificationRequired?'verification_required':login.credentialRejected?'rejected':login.rateLimited?'rate_limited':login.serviceUnavailable?'service_error':login.requestFailed?'request_error':login.blockedRequests?.length?'request_blocked':recovery?.credentialState==='unavailable'?'credential_unavailable':login.loginState??'waiting';
    const messages={credential_unavailable:'本机未能读取此应用的可用凭据。首次使用可在原任务卡提供账号密码；若以前已保存，请维护者检查钥匙串解锁和应用绑定，不必反复重发密码。',service_error:'登录接口服务异常，不能认定账号密码错误；原任务保留，请维护者检查网站服务。',request_error:'登录请求未通过接口检查，不能认定账号密码错误；请维护者检查请求链路。',rate_limited:'登录接口限制了请求频率，不会反复自动提交凭据；原任务保留。',password_change_required:'网站要求修改或重置密码，请由本人在本机页面完成；AgentOS不会更改密码。',verification_required:'网站正在等待验证码、短信或扫码，请在本机页面完成。',rejected:'网站明确拒绝了本次登录；请核对账号状态和凭据后，在原任务卡重新提供。',request_blocked:'登录尚未完成，发现网页请求受到限制；请维护者核对允许范围，当前不能认定密码错误。',loading:'网页仍在加载或只有空白外壳，尚不能确认登录成功。',login_required:'正在使用本机已保存的凭据恢复登录，原任务保留；无需重复发送已有账号密码。',waiting:'尚未确认登录成功，原任务保留。'};
    const changed=await context.store.transact(s=>{const current=s.jobs.find(j=>j.id===job.id);if(current?.status!=='awaiting_clarification'||!current.result?.browserLoginRequired||current.result.browserCredentialState===(recovery?.credentialState??'unknown')&&current.result.browserLoginState===state&&JSON.stringify(current.result.browserLoginDiagnostic??null)===JSON.stringify(login.diagnostic??null))return false;current.result.browserCredentialState=recovery?.credentialState??'unknown';current.result.browserLoginState=state;current.result.browserLoginDiagnostic=login.diagnostic??null;current.result.summary=messages[state]??messages.waiting;current.result.finalMessage=current.result.summary+' 当前网站：'+e.baseUrl;current.updatedAt=new Date().toISOString();return true;});
    if(changed&&context.cards&&job.questionId){const {publishQuestion}=await import('./questions.js');await publishQuestion(context,job.questionId);}
    continue;
   }
   if(!await context.websiteBrowser.loginReady(job,e))continue;
   await context.store.transact(state=>{
    const current=state.jobs.find(j=>j.id===job.id);if(current?.status!=='awaiting_clarification'||!current.result?.browserLoginRequired)return;
    let valid=true;try{verifyApprovedPlan(cfg,current.environmentAccess);}catch{valid=false;}
    current.browserCheckpoint=current.result.browserCheckpoint;
    delete current.browserResumeClaim;
    if(valid){
     // A one-use continuation issued only by the login detector, not by the Runner.
     current.browserResumeClaim={scopeHash:current.environmentAccess.scopeHash,startedAt:current.environmentAccess.startedAt};
     current.status='queued';current.result=null;
    }
    else{const old=current.environmentAccess;const plan=planQuery(cfg,{environmentId:old.environmentId,queryId:old.queryId,parameters:old.parameters},current.projectId,{profile:current.originProfile,senderId:current.senderId});current.environmentAccess=plan;current.status=plan.approvalRequired?'awaiting_environment_approval':'queued';current.result=null;}
    current.updatedAt=new Date().toISOString();current.events.push({type:'browser_login_resumed',at:current.updatedAt});
    const question=state.questions?.[current.questionId];if(question)question.generation++;
   });
  }catch{
   const changed=await context.store.transact(s=>{const current=s.jobs.find(j=>j.id===job.id);if(current?.status!=='awaiting_clarification'||!current.result?.browserLoginRequired||current.result.browserLoginState==='access_check_failed')return false;current.result.browserLoginState='access_check_failed';current.result.summary='网页登录检测或原访问范围核验未完成，不能认定密码错误；请维护者检查浏览器会话、配置和权限。';current.result.finalMessage=current.result.summary;return true;});
   if(changed&&context.cards&&job.questionId){const {publishQuestion}=await import('./questions.js');await publishQuestion(context,job.questionId);}
  }
 }
}
