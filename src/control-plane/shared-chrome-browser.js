import {randomUUID} from 'node:crypto';
import {chromeTransport} from './chrome-transport.js';
import {chromePage} from './chrome-page.js';
import {chromeLoginPage} from './chrome-login-page.js';
import {cleanWebsiteText,websiteUrl} from '../shared/website-policy.js';
export class SharedChromeBrowser{
 constructor(authorize=async()=>true,transport=chromeTransport,wait=ms=>new Promise(resolve=>setTimeout(resolve,ms))){this.wait=wait;this.authorize=authorize;this.transport=transport;this.pages=new Map();this.queue=Promise.resolve();}
 serial(fn){const p=this.queue.then(fn);this.queue=p.catch(()=>{});return p;}
 async allowed(job,e,waiting=false){
  const r={url:()=>websiteUrl(e.baseUrl),method:()=> 'GET',resourceType:()=> 'document'};
  if(!await this.authorize(job,waiting,r))throw new Error('当前问题没有有效网页访问授权');
 }
 async state(job,e,forceNew=false){
  let s=this.pages.get(job.id);if(s){if(s.baseUrl!==websiteUrl(e.baseUrl))throw new Error('任务入口已变化，需要重新申请');return s;}
  const tab=await this.transport({operation:'find',forceNew,baseUrl:websiteUrl(e.baseUrl),exclude:[...this.pages.values()].map(s=>s.tabId)});
  s={...tab,token:randomUUID().replaceAll('-',''),baseUrl:websiteUrl(e.baseUrl),waiting:false};this.pages.set(job.id,s);return s;
 }
 pending(stage,reason,observedUrl){return {waitingForPage:true,partial:true,pageStatus:reason==='network_error'?'network_error':'loading',stage,waitReason:reason,...(observedUrl?{observedUrl}:{})};}
 async recover(job,e,s,reason){
  await this.allowed(job,e,s.waiting);
  if(!s.owned||reason==='closed'){
   this.pages.delete(job.id);await this.state(job,e,true);return this.pending('已重新定位原应用入口，等待业务页面加载','reopening');
  }
  return this.pending('页面仍在跳转，等待返回原应用后继续','redirecting');
 }
 async inspect(job,e,s){
  let info;try{info=await this.transport({operation:'inspect',tabId:s.tabId,windowId:s.windowId});}
  catch(error){if(/原Chrome标签页已关闭/.test(error.message))return this.recover(job,e,s,'closed');throw error;}
  if(!info.url)return null; // Older injected adapters: DOM guard remains authoritative.
  if(info.windowId)s.windowId=info.windowId;
  let current;try{current=new URL(info.url);}catch{return this.pending('等待页面导航完成','loading');}
  if(info.url==='about:blank')return this.pending('等待新标签页加载原应用','loading');
  if(current.protocol==='chrome-error:')return this.networkRecovery(job,e,s);
  const base=new URL(s.baseUrl),prefix=base.pathname.replace(/\/$/,'');
  if(current.origin===base.origin&&(/\/(?:login|signin|sign-in|authenticate|auth|captcha|verify)(?:[/?#]|$)/i.test(current.pathname+current.hash)||current.pathname===prefix||current.pathname.startsWith(prefix+'/')))return null;
  const result=await this.recover(job,e,s,'outside');result.observedUrl=current.origin+current.pathname;return result;
 }
 async networkRecovery(job,e,s){
  await this.allowed(job,e,s.waiting);
  if(!s.owned)return this.recover(job,e,s,'network_error');
  if(Date.now()>=(s.retryAt??0)){await this.transport({operation:'navigate',tabId:s.tabId,windowId:s.windowId,baseUrl:s.baseUrl});s.retryAt=Date.now()+5000;s.token=randomUUID().replaceAll('-','');}
  return this.pending('网络页面尚未恢复，正在等待原应用重新加载','network_error');
 }
 async snapshot(job,e,s,tool,args){
  await this.allowed(job,e,s.waiting);
  const pending=await this.inspect(job,e,s);if(pending)return pending;
  await this.allowed(job,e,s.waiting);
  const request={baseUrl:s.baseUrl,token:s.token,tool,args};
  let raw;try{raw=await this.transport({operation:'execute',tabId:s.tabId,windowId:s.windowId,script:`JSON.stringify((${chromePage.toString()})(${JSON.stringify(request)}))`});}catch(error){if(/原Chrome标签页已关闭/.test(error.message))return this.recover(job,e,s,'closed');throw error;}
  if(raw.pageStatus==='empty'&&raw.failedResources?.length)return this.networkRecovery(job,e,s);
  if(raw.waitingForPage&&raw.pageStatus==='network_error')return this.networkRecovery(job,e,s);
  if(raw.error&&!raw.recoverable){if(/浏览器已离开本次批准/.test(raw.error))return this.recover(job,e,s,'outside');throw new Error(raw.error);}
  if(!raw.waitingForPage){s.waiting=raw.loginRequired===true;if(!s.waiting)s.credentialAttempted=false;}
  if(raw.pageText)raw.pageText=cleanWebsiteText(raw.pageText);
  if(raw.controls)raw.controls=raw.controls.map(c=>({...c,label:cleanWebsiteText(c.label),...(c.value!==undefined?{value:cleanWebsiteText(c.value)}:{}),...(c.options?{options:c.options.map(o=>({...o,label:cleanWebsiteText(o.label)}))}:{})}));
  return raw;
 }
 run(job,e,tool,args={}){return this.serial(async()=>{try{
  if(!['connection','browser_open','browser_snapshot','browser_click','browser_search','browser_select','browser_fill','browser_navigate'].includes(tool))throw new Error('未开放该网页操作');
  await this.allowed(job,e);const s=await this.state(job,e);
  let r=await this.snapshot(job,e,s,tool,args);
  if(r.error&&r.recoverable){const interactionError=r.error;r=await this.snapshot(job,e,s,'browser_snapshot',{});r.interactionError=interactionError;r.partial=true;r.stage='交互未完成，已刷新控件引用和状态，请调整步骤';}
  if(r.acted){r=await this.snapshot(job,e,s,'browser_snapshot',{});r.actionAlreadyPerformed=true;}
  if(['empty','loading','network_error'].includes(r.pageStatus))r={...r,waitingForPage:true,stage:r.stage??'等待页面及业务内容加载'};
  if(r.loginRequired)await this.transport({operation:'focus',tabId:s.tabId,windowId:s.windowId});
  return r;
 }catch(error){if(error.code==='CHROME_WAIT'||/请先打开日常(?:Google )?Chrome/.test(error.message))return {...this.pending('等待Chrome或业务页面恢复响应','browser_unavailable'),...(!['connection','browser_open','browser_snapshot'].includes(tool)?{actionMayHavePerformed:true}:{})};throw error;} });}
 health(){return this.serial(()=>this.transport({operation:'health',timeoutMs:5000}));}
 async submitCredentials(job,e,cred,{force=false}={}){return this.serial(async()=>{
  await this.allowed(job,e,true);const s=await this.state(job,e);
  const pending=await this.inspect(job,e,s);if(pending)return {authenticated:false,attempted:false,waitingForPage:true};
  const statusBefore=await this.snapshot(job,e,s,'browser_snapshot',{});if(statusBefore.waitingForPage||['empty','loading'].includes(statusBefore.pageStatus))return {authenticated:false,attempted:false,waitingForPage:true};
  if(s.credentialAttempted&&!force)return {authenticated:false,attempted:false};
  s.credentialAttempted=true;
  const request={baseUrl:s.baseUrl,username:cred.username,password:cred.password};
  const raw=await this.transport({operation:'execute',tabId:s.tabId,windowId:s.windowId,script:`JSON.stringify((${chromeLoginPage.toString()})(${JSON.stringify(request)}))`});
  if(raw.error)throw new Error(raw.error);
  if(!raw.submitted&&!raw.loginRequired){s.waiting=false;s.credentialAttempted=false;return {authenticated:true,attempted:false};}
  await new Promise(resolve=>setTimeout(resolve,1200));
  const status=await this.snapshot(job,e,s,'browser_snapshot',{});
  return {authenticated:!status.loginRequired&&!status.waitingForPage,attempted:true,
   credentialRejected:status.loginRequired===true&&status.credentialFormVisible===true,
   verificationRequired:status.loginRequired===true&&status.verificationRequired===true};
 });}
 loginReady(job,e){return this.serial(async()=>{await this.allowed(job,e,true);const s=await this.state(job,e);const r=await this.snapshot(job,e,s,'browser_snapshot',{});return !r.loginRequired&&!r.waitingForPage;});}
 async release(id){this.pages.delete(id);}
 async close(){this.pages.clear();} // Never close or quit the user's browser.
}
