import {websiteControls,controlMetadata,websiteFields} from '../shared/website-controls.js';
export {controlMetadata} from '../shared/website-controls.js';
import {waitForCaptureReady,screenshotSecretSelector} from '../shared/website-capture.js';
import {browserLoginState,authResponseState} from '../shared/browser-login-state.js';
import { randomUUID,createHash } from 'node:crypto';
import {BrowserInputError,validateBrowserTool,websitePageLocation} from '../shared/browser-tool-input.js';
import { chromium } from 'playwright';
import { mkdir, chmod } from 'node:fs/promises';
import path from 'node:path';
import { websiteSessionKey, websiteNavigationTarget, websiteRequestAllowed, cleanWebsiteText } from '../shared/website-policy.js';
// One private profile per project/environment/origin. Pages and refs remain per question/job.
export class WebsiteBrowser {
 constructor(dataDir, driver=chromium, authorize=async()=>true){this.authorize=authorize;this.evidenceRoot=path.join(dataDir,'website-evidence');this.root=path.join(dataDir,'website-sessions');this.driver=driver;this.contexts=new Map();this.pages=new Map();this.opening=new Map();}
 async session(e) {
  const key=websiteSessionKey(e.projectId,e.tier,e.baseUrl);
  if(this.contexts.has(key))return this.contexts.get(key);
  if(this.opening.has(key))return this.opening.get(key);
  const p=(async()=>{
   const dir=path.join(this.root,key);await mkdir(dir,{recursive:true,mode:0o700});await chmod(this.root,0o700);await chmod(dir,0o700);
   const context=await this.driver.launchPersistentContext(dir,{headless:false,acceptDownloads:false,serviceWorkers:'block',locale:'zh-CN',args:['--disable-background-networking','--force-webrtc-ip-handling-policy=disable_non_proxied_udp']});
   const session={context,e};this.contexts.set(key,session);
   await context.routeWebSocket('**/*',s=>s.close());
   await context.addInitScript(()=>{for(const key of ['RTCPeerConnection','webkitRTCPeerConnection','WebTransport'])Object.defineProperty(window,key,{value:undefined,configurable:false});});
   await context.route('**/*',async route=>{
    const r=route.request();let page;try{page=r.frame().page();}catch{}
    const state=[...this.pages.values()].find(s=>s.page===page),target=state?.environment??e;
    let allow=false;try{allow=websiteRequestAllowed(target.baseUrl,{url:r.url(),method:r.method(),body:r.postData(),resourceType:r.resourceType()},state?.waiting===true,target.queries?.[state?.job?.environmentAccess?.queryId]?.readEndpoints??[]);}catch{}
    if(allow&&!state)allow=false;
    if(allow&&state) {try{allow=await this.authorize(state.job,state.waiting,r);}catch{allow=false;}}
    if(!allow){if(state){state.blocked.add(`${r.method()} ${new URL(r.url()).pathname}`);if(['xhr','fetch'].includes(r.resourceType())&&!/\.(?:js|css|map|png|jpe?g|svg|ico|woff2?)(?:$)/i.test(new URL(r.url()).pathname)&&new URL(r.url()).origin===new URL(e.baseUrl).origin)state.blockedLoginReads.add(`${r.method()} ${new URL(r.url()).pathname}`);}await route.abort().catch(()=>{});return;}
    await route.continue();
   });
   context.on('close',()=>{this.contexts.delete(key);for(const [id,s]of this.pages)if(s.session===session)this.pages.delete(id);});
   return session;
  })();this.opening.set(key,p);try{return await p;}finally{this.opening.delete(key);}
 }
 async state(job,e){
  const initialTarget=websiteNavigationTarget(job.environmentAccess?.websiteTarget??e.baseUrl,e.baseUrl);
  if(this.pages.has(job.id)){
   const existing=this.pages.get(job.id);
   if(websiteSessionKey(e.projectId,e.tier,e.baseUrl)!==websiteSessionKey(existing.environment.projectId,existing.environment.tier,existing.environment.baseUrl)||e.baseUrl!==existing.environment.baseUrl||initialTarget!==existing.initialTarget)await this.release(job.id);
   else {existing.job=job;existing.environment=e;return existing;}
  }
  const session=await this.session(e),page=await session.context.newPage();
  const s={job,page,session,environment:e,initialTarget,refPrefix:randomUUID(),refs:new Map(),generation:0,waiting:false,sawLogin:false,blocked:new Set(),blockedLoginReads:new Set(),pendingReads:new Set(),lastReadActivity:Date.now()};this.pages.set(job.id,s);
  page.on('request',request=>{
   if(['xhr','fetch','document'].includes(request.resourceType())&&new URL(request.url()).origin===new URL(s.environment.baseUrl).origin){s.pendingReads.add(request);s.lastReadActivity=Date.now();}
  });
  const settled=request=>{if(s.pendingReads.delete(request))s.lastReadActivity=Date.now();};
  page.on('requestfinished',settled);page.on('requestfailed',settled);
  page.on('response',async response=>{
   const req=response.request(),url=new URL(response.url());if(url.origin!==new URL(e.baseUrl).origin)return;
   const tail=url.pathname.split('/').filter(Boolean).at(-1)??'';
   if(req.method()==='POST'&&/^(?:login|signin|sign-in|authenticate|auth|token)(?:\.[a-z]+)?$/i.test(tail)){s.authPostSeen=true;try{s.authResult=authResponseState(response.status(),await response.json());}catch{s.authResult=authResponseState(response.status(),null);}return;}
   const reviewed=s.environment.queries?.[s.job?.environmentAccess?.queryId]?.readEndpoints??[];
   if(s.waiting&&response.status()>=400&&['xhr','fetch'].includes(req.resourceType())&&reviewed.some(x=>x.method===req.method()&&x.path===url.pathname))s.bootstrapFailure={method:req.method(),path:url.pathname,status:response.status()};
  });
  page.setDefaultTimeout(10000);page.on('download',d=>d.cancel().catch(()=>{}));page.on('popup',p=>p.close().catch(()=>{}));page.on('dialog',d=>d.dismiss().catch(()=>{}));
  try{await page.goto(initialTarget,{waitUntil:'domcontentloaded',timeout:30000});}catch(error){await this.release(job.id);throw error;}
  return s;
 }
 async loginStatus(s){
  const state=await s.page.evaluate(browserLoginState);
  if(state.loginRequired&&s.authResult&&!state.verificationRequired&&!state.passwordChangeRequired)Object.assign(state,s.authResult);
  if(state.loginRequired){s.waiting=true;s.sawLogin=true;if(s.bootstrapFailure&&!state.credentialRejected&&!state.verificationRequired&&!state.passwordChangeRequired){const code=s.bootstrapFailure.status;Object.assign(state,code===429?{loginState:'rate_limited',rateLimited:true}:code>=500?{loginState:'service_error',serviceUnavailable:true}:{loginState:'request_error',requestFailed:true});}}
  else if(state.pageReady){if(s.waiting&&s.sawLogin)s.reloadAfterLogin=true;s.waiting=false;s.credentialAttempted=false;s.authResult=null;s.bootstrapFailure=null;}
  if(s.blockedLoginReads.size&&state.loginRequired&&!state.credentialRejected)state.blockedRequests=[...s.blockedLoginReads].slice(-8);
  return {...state,diagnostic:{credentialAttempted:s.credentialAttempted===true,authRequestObserved:s.authPostSeen===true,authResult:s.authResult?.loginState??null,blockedRequests:[...s.blockedLoginReads].slice(-8),bootstrapFailure:s.bootstrapFailure??null}};
 }
 async needsLogin(s){const state=await this.loginStatus(s);return state.loginRequired||!state.pageReady;}
 async loginStatusFor(job,e){return this.loginStatus(await this.state(job,e));}
 async loginReady(job,e){const s=await this.state(job,e);return (await this.loginStatus(s)).pageReady===true;}
 async submitCredentials(job,e,cred,{force=false}={}){
  if(!await this.authorize(job,true,{url:()=>e.baseUrl,method:()=> 'GET',resourceType:()=> 'document'}))throw new Error('当前任务没有有效网站登录范围');
  const opened=this.pages.get(job.id);
  if(opened&&(websiteSessionKey(e.projectId,e.tier,e.baseUrl)!==websiteSessionKey(opened.environment.projectId,opened.environment.tier,opened.environment.baseUrl)||opened.environment.baseUrl!==e.baseUrl))throw new Error('凭据目标与已打开的任务登录范围不一致；本次未导航或填写');
  const s=await this.state(job,e);
  const current=new URL(s.page.url()),base=new URL(e.baseUrl),prefix=base.pathname.replace(/\/$/,'');
  const authPath=/\/(?:login|signin|sign-in|authenticate|auth|captcha|verify)(?:[/?#]|$)/i.test(current.pathname+current.hash);
  if(current.origin!==base.origin||(!authPath&&!(current.pathname===prefix||current.pathname.startsWith(prefix+'/'))))throw new Error('浏览器已离开本次批准的登录范围');
  const before=await this.loginStatus(s);
  if(before.pageReady)return {...before,authenticated:true,attempted:false};
  const policy=createHash('sha256').update(JSON.stringify([e.projectId,e.tier,e.baseUrl,e.credentialRef,job.environmentAccess?.queryId,e.queries?.[job.environmentAccess?.queryId]?.readEndpoints??[]])).digest('hex');
  const correctedPolicy=s.authAttemptPolicy!==undefined&&s.authAttemptPolicy!==policy;
  if(!force&&(before.rateLimited||s.credentialAttempted&&(before.credentialRejected||!correctedPolicy)))return {...before,authenticated:false,attempted:false};
  if(before.passwordChangeRequired)return {...before,authenticated:false,attempted:false};
  const password=s.page.locator('input[type="password"]:visible').first();
  if(!await password.count())return {...before,authenticated:before.pageReady===true,attempted:false};
  s.authResult=null;s.authPostSeen=false;s.bootstrapFailure=null;s.blockedLoginReads.clear();
  const form=password.locator('xpath=ancestor::form[1]');const scope=await form.count()?form:s.page.locator('body');
  const inputs=scope.locator('input:not([type="password"]):not([type="hidden"]):not([type="submit"]):not([type="button"]):not([type="checkbox"]):visible');
  let username=inputs.first();for(let i=0;i<await inputs.count();i++){const el=inputs.nth(i);const label=await el.evaluate(x=>[x.name,x.id,x.autocomplete,x.placeholder,x.getAttribute('aria-label')].join(' '));if(/user|account|login|email|phone|mobile|账号|用户|邮箱|手机/i.test(label)){username=el;break;}}
  if(await username.count())await username.fill(cred.username);
  await password.fill(cred.password);
  if(before.verificationRequired)return {...before,authenticated:false,attempted:false};
  const named=scope.getByRole('button',{name:/^(?:登\s*录|登\s*入|sign\s*in|log\s*in|submit|确定|继续)$/i}).first();
  const submit=await named.count()?named:scope.locator('button[type="submit"]:visible,input[type="submit"]:visible').first();
  if(await submit.count()){s.credentialAttempted=true;s.authAttemptPolicy=policy;await submit.click();}else return {...before,authenticated:false,attempted:false,credentialRejected:false,submissionUnconfirmed:true,loginState:'submission_control_missing'};
  await s.page.waitForTimeout(1200);const status=await this.loginStatus(s);
  if(status.pageReady)s.credentialAttempted=false;
  return {...status,authenticated:status.pageReady===true,attempted:true,submissionUnconfirmed:!s.authPostSeen&&status.loginRequired};
 }
 async run(job,e,tool,args={}) {
  validateBrowserTool(tool,args);
  const s=await this.state(job,e);
  // A ref belongs to one immutable element handle in one page generation, never nth(i).
  const previous=s.operation??Promise.resolve();
  const operation=previous.catch(()=>{}).then(()=>this.perform(s,tool,args));s.operation=operation;
  try{return await operation;}finally{if(s.operation===operation)s.operation=null;}
 }
 async perform(s,tool,args){
  const login=await this.loginStatus(s);
  if(login.loginRequired){await s.page.bringToFront();return {loginRequired:true,stage:'等待本机登录',message:'登录后自动继续原问题，无需回复继续。'};}
  if(tool==='browser_screenshot')return this.screenshot(s);
  if(!login.pageReady)return {stage:'页面尚未就绪',pageStatus:'loading',url:websitePageLocation(s.page.url()),partial:true,pageText:'',controls:[],message:'尚未取得可见业务内容，不能认定登录成功或页面正常。'};
  if(s.reloadAfterLogin){s.reloadAfterLogin=false;await s.page.goto(s.initialTarget,{waitUntil:'domcontentloaded'});}
  if(tool==='connection'||tool==='browser_open'||tool==='browser_snapshot')return this.snapshot(s);
  if(tool==='browser_key'&&args.ref==='page'){await s.page.keyboard.press('Escape');return this.snapshot(s);}
  if(tool==='browser_scroll'&&args.ref==='page'){await s.page.evaluate(direction=>window.scrollBy(direction==='left'?-600:direction==='right'?600:0,direction==='up'?-600:direction==='down'?600:0),args.direction);return this.snapshot(s);}
  const ref=s.refs.get(args.ref);if(!ref)throw new BrowserInputError('BROWSER_REF_STALE','页面引用已过期；先browser_snapshot，再使用新引用。');
  const current=await ref.el.evaluate(controlMetadata,{readNavigationSelectors:s.environment.queries?.[s.job?.environmentAccess?.queryId]?.readNavigationSelectors??[]}).catch(()=>null);
  if(!current||!current.visible)throw new BrowserInputError('BROWSER_REF_STALE','原控件已移除或隐藏；先browser_snapshot，不重复旧操作。');
  if(current.label!==ref.rawLabel||current.type!==ref.type)throw new BrowserInputError('BROWSER_CONTROL_CHANGED','控件内容或用途已改变；重新读取snapshot后选择，不执行原操作。');
  if(current.blocked)throw new Error('该操作可能改变业务状态，本次未执行');
  const expected={browser_search:'search',browser_select:'select',browser_click:'read-action'}[tool];
  if(!['browser_key','browser_scroll'].includes(tool)&&ref.type!==expected&&!(tool==='browser_click'&&ref.type==='search'))throw new BrowserInputError('BROWSER_CONTROL_TYPE','当前引用不是该工具对应的控件；菜单和详情用browser_click，输入框用browser_search，原生下拉框用browser_select。');
  try{
   if(tool==='browser_key')await ref.el.press(args.key,{timeout:8000});
   else if(tool==='browser_scroll')await ref.el.evaluate((el,direction)=>{let p=el;const horizontal=['left','right'].includes(direction);while(p&&!(horizontal?p.scrollWidth>p.clientWidth:p.scrollHeight>p.clientHeight))p=p.parentElement;(p??document.scrollingElement).scrollBy(horizontal?(direction==='left'?-600:600):0,horizontal?0:(direction==='up'?-600:600));},args.direction);
   else if(tool==='browser_search')await ref.el.fill(args.text,{timeout:8000});
   else if(tool==='browser_select')await ref.el.selectOption(args.value,{timeout:8000});
   else await ref.el.click({timeout:8000});
  }catch(error){if(error.name==='TimeoutError')throw new BrowserInputError('BROWSER_OPERATION_TIMEOUT','本次控件操作未确认完成；不要重复点击，先browser_snapshot核对页面是否变化，再决定下一步。不能将工具超时认定为网站故障。');throw error;}
  if(await this.needsLogin(s))return {loginRequired:true,stage:'登录已过期，等待本机重新登录'};
  return this.snapshot(s);
 }
 async snapshot(s){
  await Promise.allSettled([...s.refs.values()].map(r=>r.el.dispose()));s.refs.clear();s.generation++;
  const text=await s.page.locator('body').evaluate(body=>{const w=document.createTreeWalker(body,NodeFilter.SHOW_TEXT),out=[];let n;while((n=w.nextNode())){const p=n.parentElement;if(!p||p.closest('script,style,noscript,input,textarea,[contenteditable],[hidden],[data-sensitive],[data-agentos-secret]')||!p.getClientRects().length||getComputedStyle(p).visibility==='hidden')continue;const t=n.textContent.trim();if(t)out.push(t);}return out.join('\n');});
  const handles=await s.page.locator([websiteControls,...(s.environment.queries?.[s.job?.environmentAccess?.queryId]?.readNavigationSelectors??[])].join(',')).filter({visible:true}).elementHandles();
  const controls=[];
  for(const [i,el]of handles.entries()){
   const info=controls.length<300?await el.evaluate(controlMetadata,{readNavigationSelectors:s.environment.queries?.[s.job?.environmentAccess?.queryId]?.readNavigationSelectors??[]}).catch(()=>null):null;
   if(!info?.type||info.blocked){await el.dispose();continue;}
   const label=cleanWebsiteText(info.label).slice(0,100),ref=`${s.refPrefix}-${s.generation}-${i}`;
   s.refs.set(ref,{el,type:info.type,rawLabel:info.label});controls.push({ref,type:info.type,label,kind:info.kind,...(info.options?{options:info.options}:{})});
  }
  const fields=await s.page.evaluate(websiteFields,{secretSelector:screenshotSecretSelector});
  const loading=await s.page.locator('[aria-busy="true"],.el-loading-mask,.ant-spin-spinning,[role="progressbar"]').evaluateAll(xs=>xs.some(x=>x.getClientRects().length&&getComputedStyle(x).visibility!=='hidden'));
  return {stage:'已读取业务网页',pageStatus:loading?'loading':'ready',loading,controlsLimited:controls.length>=300,url:websitePageLocation(s.page.url()),pageText:cleanWebsiteText(text),fields:fields.slice(0,100),fieldsLimited:fields.length>100,controls,blockedRequests:[...s.blocked].slice(-10),rows:[],note:'来自当前网页；菜单可通过read-action展开；仅当前引用有效。异步列表尚在加载或截图出现新内容后，应使用最新快照的控件，不沿用加载前清单判断按钮缺失。'};
 }
 async screenshot(s){
  if(!/^[A-Za-z0-9_-]+$/.test(s.job.id))throw new Error('Invalid evidence job');
  const readiness=await waitForCaptureReady(s);
  if((await this.loginStatus(s)).loginRequired)return {loginRequired:true,stage:'登录已过期，等待本机重新登录'};
  const dir=path.join(this.evidenceRoot,s.job.id);await mkdir(dir,{recursive:true,mode:0o700});await chmod(this.evidenceRoot,0o700);await chmod(dir,0o700);
  const name=randomUUID()+'.png',file=path.join(dir,name);
  const buffer=await s.page.screenshot({path:file,type:'png',fullPage:false,timeout:10000,mask:[s.page.locator(screenshotSecretSelector)],maskColor:'#6b7280',...(readiness.status==='ready'?{}:{style:'body::after{content:"页面加载尚未完成 · 现场截图";position:fixed;top:8px;right:12px;z-index:2147483647;background:#fff3cd;color:#704d00;padding:6px 10px;border:1px solid #e6ce81;border-radius:4px;font:13px sans-serif;pointer-events:none}'})});await chmod(file,0o600);
  return {...await this.snapshot(s),...(readiness.status==='ready'?{}:{pageStatus:'loading',partial:true}),stage:readiness.status==='ready'?'已保存稳定网页截图':'已保存加载未完成的现场截图',screenshot:{name,sha256:createHash('sha256').update(buffer).digest('hex'),bytes:buffer.length,capturedAt:new Date().toISOString(),url:websitePageLocation(s.page.url()),readiness},rows:[],note:'已等待接口、加载指示和页面稳定；正常业务字段保留，凭据及显式敏感区用灰色遮挡。readiness.status为ready仅代表渲染稳定，不代表业务正常；其它状态是加载未完成的现场证据。截图由控制服务校验后发送原话题，不能代替未打开页面的检查。'};
 }
 async release(id){const s=this.pages.get(id);this.pages.delete(id);await s?.page.close().catch(()=>{});}
 async close(){await Promise.allSettled([...this.contexts.values()].map(s=>s.context.close()));this.contexts.clear();this.pages.clear();}
}
