import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,rm} from 'node:fs/promises';
import os from 'node:os';import path from 'node:path';import http from 'node:http';
import {chromium} from 'playwright';
import {websiteNavigationTarget} from '../src/shared/website-policy.js';
import {prepareWebsiteQuery} from '../src/control-plane/website-query.js';
import {loadEnvironments,planQuery,verifyApprovedPlan} from '../src/shared/environment-access.js';
import {renewReadPlan} from '../src/shared/read-plan-renewal.js';
import {queryRejection} from '../src/shared/query-repair.js';
import {WebsiteBrowser} from '../src/control-plane/website-browser.js';
const root='https://business.test/app/',url=root+'reports/detail?customer=1001&month=202609';
const entry=(projectId,tier)=>({projectId,tier,kind:'website',baseUrl:root,applicationRoot:true,credentialRef:projectId+'-'+tier,membersRead:false,ownerOpenIdsByProfile:{owner:['ou_admin']},queries:{investigate:{mode:'investigate',reviewed:true,description:'Read reports',maxRows:20,timeoutMs:1000,parameters:[{name:'purpose',type:'string'}],browser:true}}});
test('navigation keeps read filters and hash routes, rejects credential/action and application boundary escapes',()=>{
 assert.equal(websiteNavigationTarget(url,root),url);assert.equal(websiteNavigationTarget(root+'#/reports?month=202609',root),root+'#/reports?month=202609');
 for(const value of [root+'save',root+'reports?action=delete',root+'reports?token=SECRET',root+'#/save',root+'#/reports?password=SECRET','https://other.test/app/reports','https://business.test/app-other/reports',root+'%2f../admin',root+'%252e%252e/admin','file:///tmp/test',root+'reports\n']){
  assert.throws(()=>websiteNavigationTarget(value,root),error=>{const d=queryRejection(error,{});assert.equal(d.code,'WEBSITE_TARGET_INVALID');assert.equal(d.retry,true);assert.doesNotMatch(JSON.stringify(d),/SECRET/);return true;},value);
 }
});
test('same application targets retain credentials, differ by task, survive JSON restore and read-plan renewal',async t=>{
 const dir=await mkdtemp(path.join(os.tmpdir(),'nav-scope-')),previous=process.env.AGENTOS_ENVIRONMENTS_FILE;process.env.AGENTOS_ENVIRONMENTS_FILE=path.join(dir,'env.json');t.after(async()=>{if(previous===undefined)delete process.env.AGENTOS_ENVIRONMENTS_FILE;else process.env.AGENTOS_ENVIRONMENTS_FILE=previous;await rm(dir,{recursive:true,force:true});});
 const cfg={version:1,environments:{one:entry('one','prd'),test:entry('one','uat'),two:entry('two','prd')}};await writeFile(process.env.AGENTOS_ENVIRONMENTS_FILE,JSON.stringify(cfg));
 const context={projects:{projects:{},ownerOpenIdsByProfile:{owner:['ou_admin']}}};
 const requests=await Promise.all([['one','prd',url],['one','uat',url],['two','prd',url],['one','prd',url.replace('1001','1002')]].map(async([projectId,tier,url])=>({projectId,request:await prepareWebsiteQuery(context,{projectId,sourceEnvironment:tier,originProfile:'owner'},{url,tier,purpose:'Read exact report'})})));
 assert.deepEqual(requests.map(x=>x.request.environmentId),['one','test','two','one']);assert.equal(requests[0].request.websiteTarget,url);assert.notEqual(requests[0].request.websiteTarget,requests[3].request.websiteTarget);assert.deepEqual(await loadEnvironments(),cfg);
 const now=Date.now(),actor={profile:'owner',senderId:'ou_member'},plan=planQuery(cfg,requests[0].request,'one',actor,now);verifyApprovedPlan(cfg,JSON.parse(JSON.stringify(plan)),now);
 assert.throws(()=>verifyApprovedPlan(cfg,{...plan,websiteTarget:url.replace('1001','1002')},now),/批准内容/);
 const renewed=renewReadPlan(cfg,{...plan,startedAt:new Date(now).toISOString()},{...actor,projectId:'one'},now+3600000);assert.equal(renewed.websiteTarget,url);verifyApprovedPlan(cfg,renewed,now+3600000);
 const legacy=planQuery(cfg,{environmentId:'one',queryId:'investigate',parameters:['Read']},'one',actor,now);assert.equal(legacy.websiteTarget,undefined);verifyApprovedPlan(cfg,legacy,now);
});
test('real browser returns to approved detail after login and follows changed target without losing session or crossing jobs',async t=>{
 const dir=await mkdtemp(path.join(os.tmpdir(),'nav-browser-'));let logins=0;const seen=[];
 const server=http.createServer((req,res)=>{if(req.url==='/login'&&req.method==='POST'){logins++;res.writeHead(302,{'set-cookie':'session=synthetic; Path=/','location':'/app/'});res.end();return;}if(req.url==='/login'){res.setHeader('content-type','text/html');res.end('<form method="post" action="/login"><input name="username"><input type="password"><button>Login</button></form>');return;}if(!req.headers.cookie){res.writeHead(302,{location:'/login'});res.end();return;}seen.push(req.url);res.setHeader('content-type','text/html');res.end('<h1>Report '+req.url+'</h1>');});await new Promise(r=>server.listen(0,'127.0.0.1',r));
 const driver={launchPersistentContext:(dir,opts)=>chromium.launchPersistentContext(dir,{...opts,headless:true,args:[...opts.args,'--no-proxy-server','--host-resolver-rules=MAP nav-fixture.test 127.0.0.1']})},base=`http://nav-fixture.test:${server.address().port}/app/`,browser=new WebsiteBrowser(dir,driver),e={...entry('one','prd'),baseUrl:base},job={id:'one',environmentAccess:{websiteTarget:base+'reports?customer=1&month=202609'}};
 t.after(async()=>{await browser.close();await new Promise(r=>server.close(r));await rm(dir,{recursive:true,force:true});});
 assert.equal((await browser.run(job,e,'connection')).loginRequired,true);await browser.submitCredentials(job,e,{username:'synthetic',password:'synthetic'});assert.equal(await browser.loginReady(job,e),true);await browser.run(job,e,'connection');assert.equal(browser.pages.get('one').page.url(),job.environmentAccess.websiteTarget);
 job.environmentAccess.websiteTarget=base+'reports?customer=2&month=202609';await browser.run(job,e,'connection');assert.equal(browser.pages.get('one').page.url(),job.environmentAccess.websiteTarget);assert.equal(logins,1);
 await browser.run({id:'two',environmentAccess:{websiteTarget:base+'reports?customer=3'}},e,'connection');assert.equal(browser.pages.get('one').page.url(),job.environmentAccess.websiteTarget);assert.notEqual(browser.pages.get('one').page,browser.pages.get('two').page);assert.ok(seen.includes('/app/reports?customer=1&month=202609'));
});
test('both HTTP handoff paths classify invalid targets and accept scoped detail URLs without losing requester',async t=>{
 const {createControlPlane}=await import('../src/control-plane/server.js');
 const dir=await mkdtemp(path.join(os.tmpdir(),'nav-http-')),previous=process.env.AGENTOS_ENVIRONMENTS_FILE;process.env.AGENTOS_ENVIRONMENTS_FILE=path.join(dir,'env.json');await writeFile(process.env.AGENTOS_ENVIRONMENTS_FILE,JSON.stringify({version:1,environments:{one:entry('one','prd')}}));
 const app=await createControlPlane({dataDir:dir,storeFile:path.join(dir,'store.json'),runnerToken:'test-only',projects:{chatProjectMap:{chat:'one'},projects:{one:{repoPath:dir}},ownerOpenIdsByProfile:{owner:['ou_admin']}},agents:{agents:{developer:{profile:'dev'},owner_intake:{profile:'owner',openId:'ou_bot'}}},feishuClient:{enabled:false},conversationOptions:{enabled:false}});await new Promise(r=>app.server.listen(0,'127.0.0.1',r));t.after(async()=>{app.server.closeAllConnections();await new Promise(r=>app.server.close(r));if(previous===undefined)delete process.env.AGENTOS_ENVIRONMENTS_FILE;else process.env.AGENTOS_ENVIRONMENTS_FILE=previous;await rm(dir,{recursive:true,force:true});});
 for(const continuous of [false,true])for(const valid of [false,true]){
  const {job}=await app.store.createJob({projectId:'one',chatId:'chat',senderId:'ou_member',originProfile:'owner',questionId:'question-'+continuous+'-'+valid,stage:'developer',workflow:'analysis_review',taskIntent:'analysis',continuousInvestigation:continuous,instruction:'Inspect detail',sourceEnvironment:'prd'});
  // Select this fixture directly so earlier auto-repair jobs cannot consume its lease.
  await app.store.transact(s=>{for(const j of s.jobs)if(j.id!==job.id&&j.status==='queued')j.status='completed';});
  const leased=await app.store.leaseNext('runner');assert.equal(leased.id,job.id);
  const endpoint=`http://127.0.0.1:${app.server.address().port}/api/v1/jobs/${job.id}/${continuous?'continuous-environment':'events'}`;
  const body={runnerId:'runner',leaseId:leased.lease.id,...(!continuous?{type:'completed'}:{}),result:{outcome:'needs_clarification',summary:'Inspect exact page',finalMessage:'Existing evidence retained',websiteQuery:{url:valid?url:root+'reports?token=SECRET',tier:'prd',purpose:'Inspect customer and month'}}};
  const response=await fetch(endpoint,{method:'POST',headers:{authorization:'Bearer test-only','content-type':'application/json'},body:JSON.stringify(body)});assert.equal(response.status,200);const reply=await response.json(),state=await app.store.read();
  if(valid){const next=continuous?state.jobs.find(j=>j.id===job.id):state.jobs.at(-1);assert.equal(next.environmentAccess.websiteTarget,url);assert.equal(next.environmentAccess.environmentId,'one');assert.equal(next.senderId,'ou_member');verifyApprovedPlan(await loadEnvironments(),next.environmentAccess);}
  else {const diagnostic=continuous?reply.diagnostic:state.jobs.at(-1).context.at(-1).result.queryRejection;assert.equal(diagnostic.code,'WEBSITE_TARGET_INVALID');assert.equal(diagnostic.retry,true);assert.doesNotMatch(JSON.stringify(reply),/SECRET/);}
 }
});
