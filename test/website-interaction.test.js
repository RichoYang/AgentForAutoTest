import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import {mkdtemp,rm,mkdir,writeFile,readFile,stat,symlink,realpath} from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {createHash} from 'node:crypto';
import {chromium} from 'playwright';
import {WebsiteBrowser} from '../src/control-plane/website-browser.js';
import {BrowserInputError,validateBrowserTool,websitePageLocation} from '../src/shared/browser-tool-input.js';
import {websiteTools} from '../src/runner/environment-job.js';
import {QueryInputError} from '../src/runner/environment-tools.js';
import {investigateEnvironment} from '../src/runner/environment-investigator.js';
import {prepareWebsiteQuery} from '../src/control-plane/website-query.js';
import {websiteKey} from '../src/shared/website-policy.js';
import {planQuery} from '../src/shared/environment-access.js';
import {WebsiteEvidenceDelivery,websiteEvidenceFile} from '../src/control-plane/website-evidence.js';
import {pruneHistory} from '../src/shared/retention.js';

test('browser arguments fail before page access, URLs retain SPA paths without query tokens',async()=>{
 for(const [tool,args]of [['browser_search',{ref:'one'}],['browser_select',{ref:'one'}],['browser_click',{ref:'one',js:'alert(1)'}],['browser_click',null],['browser_navigate',{}]])assert.throws(()=>validateBrowserTool(tool,args),e=>e.code==='BROWSER_ARGUMENTS');
 const tools=websiteTools({id:'one',lease:{}},{serverUrl:'http://127.0.0.1:1'});await assert.rejects(tools.run('browser_search',{ref:'missing'}),QueryInputError);assert.equal(tools.spec.some(x=>x.tool==='browser_screenshot'),false);
 assert.equal(websiteTools({originalQuestion:'不要截图，只看页面'},{}).spec.some(x=>x.tool==='browser_screenshot'),false);
 assert.equal(websiteTools({originalQuestion:'请附异常截图'},{ }).spec.some(x=>x.tool==='browser_screenshot'),true);
 assert.equal(websitePageLocation('https://example.test/#/orders?token=private'),'https://example.test/#/orders');
});

test('real browser navigates framework/ARIA menus, retains concrete refs and captures masked evidence',async t=>{
 const dir=await mkdtemp(path.join(await realpath(os.tmpdir()),'web-controls-'));let writes=0;const readHits=[];
 const server=http.createServer((req,res)=>{if(req.url==='/catalogOne'||req.url==='/catalogTwo'){readHits.push(req.url);res.end('{}');return;}if(req.url==='/save'){writes++;res.end('bad');return;}res.setHeader('content-type','text/html; charset=utf-8');res.end(`<h1>测试首页</h1><ul role="menubar"><li role="menuitem"><div class="el-submenu__title" onclick="document.querySelector('#orders').hidden=false">订单管理</div><ul id="orders" hidden><li role="menuitem" onclick="location.hash='/orders';document.querySelector('#view').textContent='订单列表'">订单列表</li></ul></li></ul><div id="view">首页内容</div><input id="query" placeholder="搜索名称"><input type="text" readonly placeholder="日期"><button onclick="document.querySelector('#view').textContent='查询结果'">查询</button><button onclick="fetch('/save',{method:'POST'})">保存</button><div id="other"></div>`);});
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
 const driver={launchPersistentContext:(d,o)=>chromium.launchPersistentContext(d,{...o,headless:true,args:[...o.args,'--no-proxy-server','--host-resolver-rules=MAP fixture.test 127.0.0.1']})};
 const browser=new WebsiteBrowser(dir,driver);t.after(async()=>{await browser.close();await new Promise(r=>server.close(r));await rm(dir,{recursive:true,force:true});});
 const e={projectId:'other-system',tier:'uat',baseUrl:`http://fixture.test:${server.address().port}/`},job={id:'job-one'};
 let snapshot=await browser.run(job,e,'connection');const page=browser.pages.get(job.id).page;
 await page.evaluate(()=>{const hidden=document.createElement('div');hidden.hidden=true;hidden.innerHTML='<button>查看隐藏项</button>'.repeat(400);document.body.prepend(hidden);});snapshot=await browser.run(job,e,'browser_snapshot');assert.ok(snapshot.controls.find(c=>c.label==='查询'));assert.ok(snapshot.controls.find(c=>c.label==='订单管理'));assert.equal(snapshot.controls.some(c=>c.label==='查看隐藏项'),false);
 assert.equal(snapshot.controls.filter(c=>c.label==='订单管理').length,1);assert.equal(snapshot.controls.some(c=>c.label==='保存'||c.label==='日期'),false);
 snapshot=await browser.run(job,e,'browser_click',{ref:snapshot.controls.find(c=>c.label==='订单管理').ref});
 snapshot=await browser.run(job,e,'browser_click',{ref:snapshot.controls.find(c=>c.label==='订单列表').ref});assert.match(snapshot.url,/#\/orders$/);assert.match(snapshot.pageText,/订单列表/);
 const query=snapshot.controls.find(c=>c.type==='search');
 // DOM order changes must not redirect the original input ref onto another input.
 await page.evaluate(()=>{const x=document.createElement('input');x.placeholder='搜索其它';x.id='decoy';document.body.prepend(x);});
 snapshot=await browser.run(job,e,'browser_search',{ref:query.ref,text:'synthetic-private-value'});assert.equal(await page.locator('#query').inputValue(),'synthetic-private-value');assert.equal(await page.locator('#decoy').inputValue(),'');
 await assert.rejects(browser.run(job,e,'browser_search',{ref:snapshot.controls.find(c=>c.label==='查询').ref,text:'x'}),e=>e.code==='BROWSER_CONTROL_TYPE');
 const stale=snapshot.controls.find(c=>c.label==='搜索名称').ref;await page.locator('#query').evaluate(el=>el.remove());await assert.rejects(browser.run(job,e,'browser_search',{ref:stale,text:'x'}),e=>e.code==='BROWSER_REF_STALE');
 await page.evaluate(()=>{const button=document.createElement('button');button.textContent='查看';button.onclick=()=>{document.querySelector('#view').textContent='订单详情';};document.body.append(button);});
 const shot=await browser.run(job,e,'browser_screenshot');assert.ok(shot.controls.find(c=>c.label==='查看'));await browser.run(job,e,'browser_click',{ref:shot.controls.find(c=>c.label==='查看').ref});assert.match((await browser.run(job,e,'browser_snapshot')).pageText,/订单详情/);const file=await websiteEvidenceFile(dir,job.id,shot.screenshot);assert.equal((await stat(file)).mode&0o777,0o600);assert.match(shot.screenshot.url,/#\/orders$/);
 await browser.run({id:'job-two'},e,'connection');await assert.rejects(browser.run({id:'job-two'},e,'browser_click',{ref:snapshot.controls[0].ref}),e=>e.code==='BROWSER_REF_STALE');
 await page.evaluate(()=>fetch('/save',{method:'POST'}).catch(()=>{}));assert.equal(writes,0);
 // Hold a detached ref: no 10s locator auto-wait and no accidental click after re-render.
 assert.ok(shot.screenshot.bytes>1000);
 // One browser profile can serve same-origin entries, but each page keeps its own grant.
 const one={...e,baseUrl:e.baseUrl+'entry-one',queries:{investigate:{readEndpoints:[{method:'POST',path:'/catalogOne',reviewed:true}]}}},two={...e,baseUrl:e.baseUrl+'entry-two',queries:{investigate:{readEndpoints:[{method:'POST',path:'/catalogTwo',reviewed:true}]}}};
 await browser.run({id:'grant-one',environmentAccess:{queryId:'investigate'}},one,'connection');await browser.run({id:'grant-two',environmentAccess:{queryId:'investigate'}},two,'connection');
 const second=browser.pages.get('grant-two').page;await second.evaluate(()=>fetch('/catalogTwo',{method:'POST'}));await second.evaluate(()=>fetch('/catalogOne',{method:'POST'}).catch(()=>{}));assert.deepEqual(readHits,['/catalogTwo']);
 const oldPage=browser.pages.get('grant-one').page;await browser.run({id:'grant-one',environmentAccess:{queryId:'investigate'}},two,'connection');assert.notEqual(browser.pages.get('grant-one').page,oldPage);assert.equal(oldPage.isClosed(),true);
 const blank=browser.pages.get('grant-one').page;await blank.evaluate(()=>{document.body.innerHTML='';});const blankShot=await browser.run({id:'grant-one',environmentAccess:{queryId:'investigate'}},two,'browser_screenshot');assert.ok(blankShot.screenshot);
 await blank.evaluate(()=>{document.body.innerHTML='<form><input type="password"></form>';});assert.equal((await browser.run({id:'grant-one'},two,'browser_screenshot')).loginRequired,true);


});

test('browser correction feedback returns to planner and snapshot resolves old-reference errors',async()=>{
 const query={mode:'investigate',reviewed:true,description:'只读网页',maxRows:10,timeoutMs:1000,parameters:[{name:'purpose',type:'string'}]};
 const e={kind:'website',projectId:'demo',tier:'uat',baseUrl:'https://example.test/',membersRead:true,ownerOpenIdsByProfile:{owner:['ou_admin']},queries:{investigate:query}};const cfg={version:1,environments:{web:e}};
 const plan=planQuery(cfg,{environmentId:'web',queryId:'investigate',parameters:['实际检查页面']},'demo',{profile:'owner',senderId:'ou_member'});
 const calls=[];let n=0;const choices=[{tool:'browser_search',arguments:'{"ref":"old","text":"x"}'},{tool:'browser_snapshot',arguments:'{}'},{tool:'browser_click',arguments:'{"ref":"new"}'},{tool:'finish',arguments:'{}',summary:'实际已打开详情',complete:true}];
 const result=await investigateEnvironment(plan,async()=>{},{load:async()=>cfg,tools:async()=>({spec:['connection','browser_search','browser_snapshot','browser_click'].map(tool=>({tool})),run:async(tool)=>{calls.push(tool);if(tool==='browser_search')throw new QueryInputError('BROWSER_REF_STALE','先snapshot');return {stage:tool,pageText:tool,rows:[]};},close:async()=>{}}),planner:async()=>({next:async()=>choices[n++],close:async()=>{}})});
 assert.deepEqual(calls,['connection','browser_search','browser_snapshot','browser_click']);assert.equal(result.partial,false);assert.equal(result.toolInputErrors[0].resolved,true);
});

test('screenshot outbox binds original question/profile, retries without recapturing, checks tampering and request permission',async t=>{
 const dir=await mkdtemp(path.join(await realpath(os.tmpdir()),'web-evidence-'));t.after(()=>rm(dir,{recursive:true,force:true}));
 const bytes=Buffer.from('89504e470d0a1a0a0102030405','hex');const file=path.join(dir,'website-evidence','job','a.png');await mkdir(path.dirname(file),{recursive:true});await writeFile(file,bytes);
 const item={name:'a.png',bytes:bytes.length,sha256:createHash('sha256').update(bytes).digest('hex')};
 const job={id:'job',questionId:'q',status:'running',lease:{id:'lease'},originalQuestion:'请提供异常截图',senderId:'ou_member',originProfile:'profile-a'};
 const state={jobs:[job],questions:{q:{generation:1,messageId:'original-message',profile:'profile-a',replyInThread:true}}};let count=0,fail=true;const sent=[];
 const context={config:{dataDir:dir},store:{read:async()=>structuredClone(state),transact:async fn=>fn(state)},feishu:{replyImage:async(message,file,options)=>{count++;if(fail)throw new Error('network');sent.push({message,options});return {data:{message_id:'image-message'}};}}};
 const delivery=new WebsiteEvidenceDelivery(context);t.after(()=>delivery.close());await delivery.capture(job,item);await delivery.retry();assert.equal(count,1);const entry=Object.values(state.websiteEvidenceDeliveries)[0];assert.equal(entry.messageId,undefined);fail=false;entry.retryAt=0;await delivery.retry();assert.equal(entry.messageId,'image-message');assert.equal(sent[0].message,'original-message');assert.equal(sent[0].options.profile,'profile-a');assert.equal(sent[0].options.replyInThread,true);assert.equal((await delivery.status(job))[0].delivery,'sent');state.questions.q.generation++;assert.equal((await delivery.status(job))[0].delivery,'sent');await delivery.retry();assert.equal(count,2);
 await assert.rejects(delivery.capture({...job,originalQuestion:'只检查页面'},item),/未要求截图/);
 await assert.rejects(websiteEvidenceFile(dir,'job',{...item,name:'../a.png'}));await writeFile(file,Buffer.from('modified'));await assert.rejects(websiteEvidenceFile(dir,'job',item));
 await rm(file);await symlink('/etc/hosts',file);await assert.rejects(websiteEvidenceFile(dir,'job',item));
});

test('pending screenshot delivery protects history; sent evidence expires with closed question',()=>{
 const state={jobs:[{id:'job',questionId:'q',status:'blocked',createdAt:'2020-01-01'}],questions:{q:{id:'q',createdAt:'2020-01-01'}},websiteEvidenceDeliveries:{image:{sourceJobId:'job',questionId:'q'}}};
 assert.equal(pruneHistory(state,Date.now()-86400000).removed.size,0);state.websiteEvidenceDeliveries.image.messageId='sent';assert.equal(pruneHistory(state,Date.now()-86400000).removed.size,2);assert.equal(Object.keys(state.websiteEvidenceDeliveries).length,0);
});


test('HTTP browser transport preserves correctable codes but never converts authorization failures',async t=>{
 let status=400;const server=http.createServer((req,res)=>{res.writeHead(status,{'content-type':'application/json'});res.end(JSON.stringify({code:'BROWSER_REF_STALE',error:'先刷新页面引用'}));});await new Promise(r=>server.listen(0,'127.0.0.1',r));t.after(()=>new Promise(r=>server.close(r)));
 const tools=websiteTools({id:'job',lease:{id:'lease',runnerId:'runner'}},{serverUrl:`http://127.0.0.1:${server.address().port}`,runnerToken:'synthetic'});
 await assert.rejects(tools.run('browser_click',{ref:'one'}),e=>e instanceof QueryInputError&&e.code==='BROWSER_REF_STALE');status=403;await assert.rejects(tools.run('browser_click',{ref:'one'}),e=>!(e instanceof QueryInputError));
});

test('stale screenshot generation and private destination never spill into a public thread',async t=>{
 const dir=await mkdtemp(path.join(await realpath(os.tmpdir()),'web-private-'));t.after(()=>rm(dir,{recursive:true,force:true}));const bytes=Buffer.from('89504e470d0a1a0a010203','hex');const file=path.join(dir,'website-evidence','job','b.png');await mkdir(path.dirname(file),{recursive:true});await writeFile(file,bytes);
 const item={name:'b.png',bytes:bytes.length,sha256:createHash('sha256').update(bytes).digest('hex')},job={id:'job',questionId:'q',status:'running',lease:{id:'lease'},originalQuestion:'请截图',visibility:'requester',senderId:'ou_private'};
 const state={jobs:[job],questions:{q:{generation:1,messageId:'message',profile:'second-profile',visibility:'requester',senderId:'ou_private'}}};const options=[];const context={config:{dataDir:dir},store:{read:async()=>structuredClone(state),transact:async fn=>fn(state)},feishu:{replyImage:async(m,f,o)=>{options.push(o);return {data:{message_id:'private-image'}};}}};const delivery=new WebsiteEvidenceDelivery(context);t.after(()=>delivery.close());await delivery.capture(job,item);await delivery.retry();assert.equal(options[0].privateRecipient,'ou_private');assert.equal(options[0].profile,'second-profile');
 const entry=Object.values(state.websiteEvidenceDeliveries)[0];delete entry.messageId;state.questions.q.generation++;await delivery.retry();assert.equal(entry.superseded,true);assert.equal(options.length,1);
});


test('transient loading is superseded only by confirmed readiness on the same page',async()=>{
 const q={mode:'investigate',reviewed:true,description:'网页',maxRows:10,timeoutMs:1000,parameters:[{name:'purpose',type:'string'}]},e={kind:'website',projectId:'demo',tier:'uat',baseUrl:'https://example.test/',membersRead:true,ownerOpenIdsByProfile:{owner:['ou_admin']},queries:{investigate:q}},cfg={version:1,environments:{web:e}};
 const plan=planQuery(cfg,{environmentId:'web',queryId:'investigate',parameters:['查看页面']},'demo',{profile:'owner',senderId:'ou_member'});
 for(const url of ['https://example.test/','https://example.test/different']){let n=0;const result=await investigateEnvironment(plan,async()=>{},{load:async()=>cfg,tools:async()=>({spec:[{tool:'connection'},{tool:'browser_snapshot'}],run:async tool=>tool==='connection'?{partial:true,pageStatus:'loading',url:'https://example.test/',rows:[]}:{pageStatus:'ready',url,rows:[]},close:async()=>{}}),planner:async()=>({next:async()=>++n===1?{tool:'browser_snapshot',arguments:'{}'}:{tool:'finish',complete:true,summary:'已读取页面'},close:async()=>{}})});assert.equal(result.partial,url!=='https://example.test/');}
});


test('same-question deep-page continuation keeps the already-used entry without copying grants across sites or environments',async t=>{
 const dir=await mkdtemp(path.join(await realpath(os.tmpdir()),'web-entry-')),old=process.env.AGENTOS_ENVIRONMENTS_FILE;process.env.AGENTOS_ENVIRONMENTS_FILE=path.join(dir,'env.json');t.after(async()=>{if(old===undefined)delete process.env.AGENTOS_ENVIRONMENTS_FILE;else process.env.AGENTOS_ENVIRONMENTS_FILE=old;await rm(dir,{recursive:true,force:true});});
 const url='https://business.test/app/',id=websiteKey('demo','uat',url),entry={projectId:'demo',tier:'uat',kind:'website',baseUrl:url,credentialRef:'original-ref',membersRead:true,ownerOpenIdsByProfile:{owner:['ou_admin']},queries:{investigate:{mode:'investigate',reviewed:true,description:'检查网页',maxRows:20,timeoutMs:1000,parameters:[{name:'purpose',type:'string',maxLength:200}],browser:true,readEndpoints:[{method:'POST',path:'/identity/context',reviewed:true}]}}};await writeFile(process.env.AGENTOS_ENVIRONMENTS_FILE,JSON.stringify({version:1,environments:{[id]:entry}}));
 const context={projects:{ownerOpenIdsByProfile:{owner:['ou_admin']},projects:{}}},job={projectId:'demo',sourceEnvironment:'sit',originProfile:'owner',context:[{kind:'environment_result',result:{environmentEvidence:{environmentId:id}}}]};
 assert.equal((await prepareWebsiteQuery(context,job,{url:url+'orders/detail',tier:'uat',purpose:'查看详情'})).environmentId,id);
 for(const [target,project,tier]of [['https://other.test/app/orders','demo','uat'],['https://business.test/application/orders','demo','uat'],[url+'orders','other','uat'],[url+'orders','demo','prd']]){
 const request=await prepareWebsiteQuery(context,{...job,projectId:project,sourceEnvironment:tier==='prd'?'prd':'sit'},{url:target,tier,purpose:'只读检查'});assert.notEqual(request.environmentId,id);const config=JSON.parse(await readFile(process.env.AGENTOS_ENVIRONMENTS_FILE,'utf8'));assert.equal(config.environments[request.environmentId].queries.investigate.readEndpoints,undefined);
 }
});

test('read navigation cards and ARIA links are exposed while mutation cards remain unavailable',async t=>{
 const dir=await mkdtemp(path.join(await realpath(os.tmpdir()),'web-nav-card-'));let writes=0;
 const server=http.createServer((req,res)=>{res.setHeader('content-type','text/html; charset=utf-8');if(req.url==='/execute'){writes++;res.end('bad');return;}if(req.url==='/gateway'){res.end('<h1>读取接口网关</h1>');return;}res.end('<h1>平台首页</h1><div class="ant-card ant-card-hoverable" onclick="location.href=\'/gateway\'">企业级API网关</div><div role="link" onclick="location.href=\'/gateway\'">只读日志入口</div><div class="ant-card ant-card-hoverable" onclick="fetch(\'/execute\',{method:\'POST\'})">立即执行</div>');});
 await new Promise(r=>server.listen(0,'127.0.0.1',r));const driver={launchPersistentContext:(d,o)=>chromium.launchPersistentContext(d,{...o,headless:true,args:[...o.args,'--no-proxy-server','--host-resolver-rules=MAP agentos-fixture.test 127.0.0.1']})};const browser=new WebsiteBrowser(dir,driver);t.after(async()=>{await browser.close();await new Promise(r=>server.close(r));await rm(dir,{recursive:true,force:true});});
 const e={projectId:'test',tier:'uat',baseUrl:`http://agentos-fixture.test:${server.address().port}/`},job={id:'card'};let snap=await browser.run(job,e,'connection');const card=snap.controls.find(c=>c.label==='企业级API网关'),link=snap.controls.find(c=>c.label==='只读日志入口');assert.equal(card.type,'read-action');assert.equal(link.type,'read-action');assert.ok(!snap.controls.some(c=>c.label==='立即执行'));
 snap=await browser.run(job,e,'browser_click',{ref:card.ref});assert.match(snap.pageText,/读取接口网关/);assert.equal(writes,0);
});

test('reviewed custom application component becomes a read reference only in its configured environment',async t=>{
 const dir=await mkdtemp(path.join(await realpath(os.tmpdir()),'custom-read-card-'));const server=http.createServer((req,res)=>{res.setHeader('content-type','text/html; charset=utf-8');if(req.url==='/detail'){res.end('<h1>应用接口清单</h1>');return;}res.end('<h1>应用</h1><label for="publicField">API Key</label><input id="publicField" value="PRIVATE_FIELD_VALUE"><div class="fixture-app-item" onclick="location.href=\'/detail\'">示例应用</div><div class="fixture-app-item">立即执行</div>');});await new Promise(r=>server.listen(0,'127.0.0.1',r));const driver={launchPersistentContext:(d,o)=>chromium.launchPersistentContext(d,{...o,headless:true,args:[...o.args,'--no-proxy-server','--host-resolver-rules=MAP agentos-fixture.test 127.0.0.1']})};const browser=new WebsiteBrowser(dir,driver);t.after(async()=>{await browser.close();await new Promise(r=>server.close(r));await rm(dir,{recursive:true,force:true});});
 const e={projectId:'test',tier:'uat',baseUrl:`http://agentos-fixture.test:${server.address().port}/`,queries:{investigate:{readNavigationSelectors:['.fixture-app-item']}}},j={id:'custom',environmentAccess:{queryId:'investigate'}};
 const no=await browser.run({id:'unconfigured'},{...e,projectId:'other',queries:{}},'connection');assert.ok(!no.controls.some(c=>c.label==='示例应用'));
 let yes=await browser.run(j,e,'connection');assert.doesNotMatch(JSON.stringify(yes.fields),/PRIVATE_FIELD_VALUE/);const ref=yes.controls.find(c=>c.label==='示例应用').ref;assert.ok(!yes.controls.some(c=>c.label==='立即执行'));yes=await browser.run(j,e,'browser_click',{ref});assert.match(yes.pageText,/应用接口清单/);
});
