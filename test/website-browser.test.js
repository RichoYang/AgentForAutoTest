import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import {mkdtemp,rm,stat,readFile} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {chromium} from 'playwright';
import {WebsiteBrowser} from '../src/control-plane/website-browser.js';
import {websiteUrl,websiteKey,websiteRequestAllowed} from '../src/shared/website-policy.js';
import {prepareWebsiteQuery,pollWebsiteLogins} from '../src/control-plane/website-query.js';
import {loadEnvironments,planQuery} from '../src/shared/environment-access.js';
import {jobCard} from '../src/control-plane/message-cards.js';
const base='https://business.example/jobs';
test('generic website policy rejects mutation paths, foreign origins and credential URLs',()=>{
 const check=(url,method='GET',body)=>websiteRequestAllowed(base,{url:new URL(url,base).href,method,body,resourceType:'document'});
 for(const p of ['/delete','/runOnce','/job/trigger','/update.json','/save','/get?cmd=delete','https://other.example/index'])assert.equal(check(p),false,p);
 assert.equal(check('/job/pageList','POST','start=0&length=10'),true);
 assert.equal(check('/job/pageList','POST','action=delete'),false);
 assert.equal(check('/unknown','POST',''),false);
 assert.equal(check('/job/logDetailCat','POST','id=1'),true);
 for(const url of ['file:///tmp/a','http://u:p@business.example/','http://127.0.0.1/','http://169.254.169.254/','http://localhost/','http://x.localhost/','https://business.example/?token=x'])assert.throws(()=>websiteUrl(url));
 assert.notEqual(websiteKey('one','uat',base),websiteKey('two','uat',base));assert.notEqual(websiteKey('one','uat',base),websiteKey('one','prd',base));
});
test('real browser waits for login, reuses persistent session, isolates pages and blocks write traffic',async t=>{
 const dir=await mkdtemp(path.join(os.tmpdir(),'agentos-web-test-'));let writes=0,queries=0;
 const server=http.createServer((req,res)=>{
  if(req.url==='/login'&&req.method==='POST'){res.writeHead(302,{'set-cookie':'session=synthetic-test-only; Max-Age=3600; Path=/','location':'/jobs'});res.end();return;}
  if(req.url==='/login'){res.setHeader('content-type','text/html; charset=utf-8');res.end('<form method="post" action="/login"><input type="password"><button>登录</button></form>');return;}
  if(req.url==='/save'){writes++;res.end('bad');return;}
  if(req.url==='/pageList'){queries++;res.end('[]');return;}
  if(!req.headers.cookie){res.writeHead(302,{location:'/login'});res.end();return;}
  res.setHeader('content-type','text/html; charset=utf-8');res.end('<h1>任务列表</h1><button onclick="fetch(\'/pageList\',{method:\'POST\'})">查询</button><button onclick="fetch(\'/save\',{method:\'POST\'})">保存</button><pre>最近成功：2026-01-01 password=synthetic-hidden</pre>');
 });await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
 const driver={launchPersistentContext:(dir,opts)=>chromium.launchPersistentContext(dir,{...opts,headless:true,args:[...opts.args,'--no-proxy-server','--host-resolver-rules=MAP agentos-fixture.test 127.0.0.1']})};
 let browser=new WebsiteBrowser(dir,driver);t.after(async()=>{await browser.close();await new Promise(r=>server.close(r));await rm(dir,{recursive:true,force:true});});
 const e={projectId:'demo',tier:'uat',baseUrl:`http://agentos-fixture.test:${server.address().port}/jobs`},job={id:'one'};
 const first=await browser.run(job,e,'connection');assert.equal(first.loginRequired,true);
 const page=browser.pages.get(job.id).page;await page.locator('input').fill('synthetic-only');await page.locator('button').click();
 assert.equal(await browser.loginReady(job,e),true);const result=await browser.run(job,e,'connection');assert.match(result.pageText,/任务列表/);assert.doesNotMatch(result.pageText,/synthetic-hidden/);assert.equal(result.controls.some(c=>c.label==='保存'),false);
 await browser.run(job,e,'browser_click',{ref:result.controls.find(c=>c.label==='查询').ref});await page.evaluate(()=>fetch('/save',{method:'POST'}).catch(()=>{}));assert.equal(writes,0);assert.equal(queries,1);
 await browser.run({id:'two'},e,'connection');assert.notEqual(browser.pages.get('one').page,browser.pages.get('two').page);
 assert.equal((await stat(path.join(dir,'website-sessions'))).mode&0o777,0o700);
 await browser.close();browser=new WebsiteBrowser(dir,driver);assert.equal((await browser.run({id:'three'},e,'connection')).loginRequired,undefined);
});
test('query-discovered websites produce scoped configs and PRD stays read-only without manual approval',async t=>{
 const dir=await mkdtemp(path.join(os.tmpdir(),'agentos-web-cfg-')),old=process.env.AGENTOS_ENVIRONMENTS_FILE;process.env.AGENTOS_ENVIRONMENTS_FILE=path.join(dir,'env.json');t.after(async()=>{if(old)process.env.AGENTOS_ENVIRONMENTS_FILE=old;else delete process.env.AGENTOS_ENVIRONMENTS_FILE;await rm(dir,{recursive:true,force:true});});
 const context={projects:{ownerOpenIdsByProfile:{owner:['ou_admin']}}},job={projectId:'demo',originProfile:'owner',sourceEnvironment:'prd'};
 const req=await prepareWebsiteQuery(context,job,{url:base,tier:'prd',purpose:'查看调度记录'});const cfg=await loadEnvironments();assert.equal(cfg.environments[req.environmentId].kind,'website');
 const plan=planQuery(cfg,req,'demo',{profile:'owner',senderId:'ou_member'});assert.equal(plan.approvalRequired,false);assert.equal(plan.approvedBy,'policy:read-only');
 await assert.rejects(prepareWebsiteQuery(context,job,{url:base,tier:'uat',purpose:'看日志'}),/环境/);
 const running={id:'pending',projectId:'demo',originProfile:'owner',senderId:'ou_member',status:'awaiting_clarification',result:{browserLoginRequired:true},environmentAccess:{...plan,approvedBy:'ou_admin'},events:[]};const state={jobs:[running]};
 const polling={store:{read:async()=>structuredClone(state),transact:async fn=>fn(state)},websiteBrowser:{loginReady:async()=>true}};
 await pollWebsiteLogins(polling);assert.equal(running.status,'queued');assert.equal(running.result,null);assert.equal(running.senderId,'ou_member');
 running.status='awaiting_clarification';running.result={browserLoginRequired:true};running.environmentAccess=planQuery(cfg,req,'demo',{profile:'owner',senderId:'ou_member'},Date.now()-3600000);await pollWebsiteLogins(polling);assert.equal(running.status,'queued');assert.equal(running.environmentAccess.approvedBy,'policy:read-only');
});
test('waiting login card explains local cooperation without demanding text clarification',()=>{
 const card=JSON.stringify(jobCard({id:'job',status:'awaiting_clarification',stage:'developer',taskIntent:'analysis',createdAt:new Date().toISOString(),updatedAt:new Date().toISOString(),events:[],result:{browserLoginRequired:true,summary:'等待本机登录，完成后自动继续',finalMessage:'任务已保留'}}));
  assert.match(card,/恢复网页登录/);assert.doesNotMatch(card,/clarification_form/);
});
test('waiting automation card is recoverable and does not claim the business login expired',()=>{
 const card=JSON.stringify(jobCard({id:'job',status:'awaiting_clarification',stage:'developer',taskIntent:'analysis',createdAt:new Date().toISOString(),updatedAt:new Date().toISOString(),events:[],result:{browserLoginRequired:true,browserActionRequired:'automation',summary:'等待系统授权',finalMessage:'登录态有效'}}));
 assert.match(card,/等待本机浏览器授权/);assert.doesNotMatch(card,/clarification_form/);
});
test('HTTP source handoff keeps requester and question, rejects stale lease before site registration',async t=>{
 const {createControlPlane}=await import('../src/control-plane/server.js');
 const dir=await mkdtemp(path.join(os.tmpdir(),'agentos-web-handoff-')),old=process.env.AGENTOS_ENVIRONMENTS_FILE;process.env.AGENTOS_ENVIRONMENTS_FILE=path.join(dir,'env.json');
 const app=await createControlPlane({dataDir:dir,storeFile:path.join(dir,'store.json'),conversationFile:path.join(dir,'conversation.json'),memoryFile:path.join(dir,'memory.json'),runnerToken:'test-only',projects:{chatProjectMap:{chat:'demo'},ownerOpenIdsByProfile:{owner:['ou_admin']},projects:{demo:{repoPath:dir}}},agents:{agents:{developer:{profile:'developer',openId:'ou_dev'},owner_intake:{profile:'owner',openId:'ou_bot'}}},feishuClient:{enabled:false},conversationOptions:{enabled:false}});
 await new Promise(r=>app.server.listen(0,'127.0.0.1',r));t.after(async()=>{await new Promise(r=>app.server.close(r));if(old)process.env.AGENTOS_ENVIRONMENTS_FILE=old;else delete process.env.AGENTOS_ENVIRONMENTS_FILE;await rm(dir,{recursive:true,force:true});});
 const created=await app.store.createJob({projectId:'demo',projectName:'demo',chatId:'chat',senderId:'ou_member',originProfile:'owner',questionId:'question-one',stage:'developer',workflow:'analysis_review',taskIntent:'analysis',instruction:'核实调度',sourceEnvironment:'prd'});
 const leased=await app.store.leaseNext('runner');const endpoint=`http://127.0.0.1:${app.server.address().port}/api/v1/jobs/${created.job.id}/events`;
 const post=leaseId=>fetch(endpoint,{method:'POST',headers:{authorization:'Bearer test-only','content-type':'application/json'},body:JSON.stringify({type:'completed',runnerId:'runner',leaseId,result:{outcome:'needs_clarification',summary:'源码找到调度入口，需要网页证据',finalMessage:'源码入口证据',websiteQuery:{url:base,tier:'prd',purpose:'查看任务日志'},environmentQuery:null}})});
 assert.equal((await post('stale')).status,409);assert.deepEqual((await loadEnvironments()).environments,{});
 assert.equal((await post(leased.lease.id)).status,200);const state=await app.store.read();assert.equal(state.jobs.length,2);const next=state.jobs[1];assert.equal(next.senderId,'ou_member');assert.equal(next.questionId,'question-one');assert.equal(next.status,'queued');assert.equal(next.environmentAccess.kind,'website');assert.equal(next.environmentAccess.approvedBy,'policy:read-only');
 const unauthorized=await fetch(`http://127.0.0.1:${app.server.address().port}/api/v1/jobs/${next.id}/website-tool`,{method:'POST',headers:{authorization:'Bearer test-only','content-type':'application/json'},body:JSON.stringify({leaseId:'stale',runnerId:'runner',tool:'connection'})});assert.equal(unauthorized.status,409);
});
