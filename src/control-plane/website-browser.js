import { chromePage } from './chrome-page.js';
import { randomUUID } from 'node:crypto';
import { chromium } from 'playwright';
import {privateDirectory} from '../shared/private-files.js';
import path from 'node:path';
import { websiteSessionKey, websiteRequestAllowed, cleanWebsiteText } from '../shared/website-policy.js';
// One private profile per project/environment/origin. Pages and refs remain per question/job.
export class WebsiteBrowser {
 constructor(dataDir, driver=chromium, authorize=async()=>true){this.authorize=authorize;this.root=path.join(dataDir,'website-sessions');this.driver=driver;this.contexts=new Map();this.pages=new Map();this.opening=new Map();}
 async session(e) {
  const key=websiteSessionKey(e.projectId,e.tier,e.baseUrl);
  if(this.contexts.has(key))return this.contexts.get(key);
  if(this.opening.has(key))return this.opening.get(key);
  const p=(async()=>{
   const dir=path.join(this.root,key);await privateDirectory(this.root);await privateDirectory(dir);
   const context=await this.driver.launchPersistentContext(dir,{headless:false,acceptDownloads:false,serviceWorkers:'block',locale:'zh-CN',args:['--disable-background-networking','--force-webrtc-ip-handling-policy=disable_non_proxied_udp']});
   const session={context,e};this.contexts.set(key,session);
   await context.routeWebSocket('**/*',s=>s.close());
   await context.addInitScript(()=>{for(const key of ['RTCPeerConnection','webkitRTCPeerConnection','WebTransport'])Object.defineProperty(window,key,{value:undefined,configurable:false});});
   await context.route('**/*',async route=>{
    const r=route.request();let page;try{page=r.frame().page();}catch{}
    const state=[...this.pages.values()].find(s=>s.page===page);
    let allow=false;try{allow=websiteRequestAllowed(e.baseUrl,{url:r.url(),method:r.method(),body:r.postData(),resourceType:r.resourceType()},state?.waiting===true);}catch{}
    if(allow&&!state)allow=false;
    if(allow&&state) {try{allow=await this.authorize(state.job,state.waiting,r);}catch{allow=false;}}
    if(!allow){if(state)state.blocked.add(`${r.method()} ${new URL(r.url()).pathname}`);await route.abort().catch(()=>{});return;}
    await route.continue();
   });
   context.on('close',()=>{this.contexts.delete(key);for(const [id,s]of this.pages)if(s.session===session)this.pages.delete(id);});
   return session;
  })();this.opening.set(key,p);try{return await p;}finally{this.opening.delete(key);}
 }
 async state(job,e){
  if(this.pages.has(job.id)){const existing=this.pages.get(job.id);if(!existing.page.isClosed?.())return existing;this.pages.delete(job.id);}
  const session=await this.session(e),page=await session.context.newPage();
  const s={job,page,session,refPrefix:randomUUID(),refs:new Map(),generation:0,waiting:false,sawLogin:false,blocked:new Set()};this.pages.set(job.id,s);
  page.setDefaultTimeout(10000);page.on('download',d=>d.cancel().catch(()=>{}));page.on('popup',p=>p.close().catch(()=>{}));page.on('dialog',d=>d.dismiss().catch(()=>{}));
  try{await page.goto(e.baseUrl,{waitUntil:'commit',timeout:30000});}catch(error){if(/timeout|net::ERR/i.test(error.message)){s.navigationPending=true;return s;}await this.release(job.id);throw error;}
  return s;
 }
 async needsLogin(s){
  const password=await s.page.locator('input[type="password"]').first().isVisible().catch(()=>false);
  const login=/\/(?:login|signin)(?:[/?#]|$)/i.test(s.page.url());
  if(password||login){s.waiting=true;s.sawLogin=true;return true;}
  if(s.waiting&&s.sawLogin){s.waiting=false;s.reloadAfterLogin=true;}
  return s.waiting;
 }
 async loginReady(job,e){const s=await this.state(job,e);return !(await this.needsLogin(s));}
 async submitCredentials(job,e,cred,{force=false}={}){const s=await this.state(job,e);if(s.credentialAttempted&&!force)return {authenticated:false,attempted:false};s.credentialAttempted=true;
  const password=s.page.locator('input[type="password"]:visible').first();if(!await password.count()){s.credentialAttempted=false;return {authenticated:true,attempted:false};}
  const form=password.locator('xpath=ancestor::form[1]');const scope=await form.count()?form:s.page.locator('body');
  const username=scope.locator('input:not([type="password"]):not([type="hidden"]):not([type="submit"]):visible').first();if(await username.count())await username.fill(cred.username);
  await password.fill(cred.password);const submit=scope.locator('button[type="submit"],input[type="submit"],button:has-text("登录"),button:has-text("登入")').first();
  if(await submit.count())await submit.click();else await password.press('Enter');await s.page.waitForTimeout(1200);const waiting=await this.needsLogin(s);if(!waiting)s.credentialAttempted=false;return {authenticated:!waiting,attempted:true};}
 async run(job,e,tool,args={}) {
  const s=await this.state(job,e);
  if(s.navigationPending||s.page.url().startsWith('chrome-error:')){try{await s.page.goto(e.baseUrl,{waitUntil:'commit',timeout:30000});s.navigationPending=false;}catch(error){if(!/timeout|net::ERR/i.test(error.message))throw error;return {waitingForPage:true,pageStatus:'network_error',partial:true,stage:'等待网络恢复并重新加载原应用'};}}
  if(await this.needsLogin(s)){await s.page.bringToFront();return {loginRequired:true,stage:'等待本机登录',message:'已在运行AgentOS的电脑上打开登录页面；登录后自动继续原问题，无需回复继续。'};}
  if(s.reloadAfterLogin){s.reloadAfterLogin=false;await s.page.reload({waitUntil:'domcontentloaded'});}
  const result=await s.page.evaluate(chromePage,{baseUrl:e.baseUrl,token:s.refPrefix,tool,args});
  if(result.error){if(result.recoverable)return {...await this.snapshot(s),interactionError:result.error,partial:true,stage:'交互未完成，已刷新控件引用和状态，请调整步骤'};if(/浏览器已离开本次批准/.test(result.error))return {waitingForPage:true,pageStatus:'loading',partial:true,stage:'等待页面跳转回原应用'};throw new Error(result.error);}
  if(result.acted){await s.page.waitForLoadState('domcontentloaded').catch(()=>{});return {...await this.snapshot(s),actionAlreadyPerformed:true};}
  return this.cleanSnapshot(s,result);
 }
 cleanSnapshot(s,result){return {...result,...(['empty','loading','network_error'].includes(result.pageStatus)?{waitingForPage:true}:{}),pageText:cleanWebsiteText(result.pageText),controls:result.controls?.map(c=>({...c,label:cleanWebsiteText(c.label),...(c.value!==undefined?{value:cleanWebsiteText(c.value)}:{})})),blockedRequests:[...s.blocked].slice(-10)};}
 async snapshot(s){return this.cleanSnapshot(s,await s.page.evaluate(chromePage,{baseUrl:s.session.e.baseUrl,token:s.refPrefix,tool:'browser_snapshot'}));}
 async release(id){const s=this.pages.get(id);this.pages.delete(id);await s?.page.close().catch(()=>{});}
 async close(){await Promise.allSettled([...this.contexts.values()].map(s=>s.context.close()));this.contexts.clear();this.pages.clear();}
}
