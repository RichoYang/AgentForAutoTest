import test from 'node:test';
import assert from 'node:assert/strict';
import {chromium} from 'playwright';
import {SharedChromeBrowser} from '../src/control-plane/shared-chrome-browser.js';
import {chromePage} from '../src/control-plane/chrome-page.js';
import {chromeLoginPage} from '../src/control-plane/chrome-login-page.js';
import {failureDiagnostic} from '../src/shared/failure-diagnostic.js';
const e={baseUrl:'https://business.example/app/',projectId:'p',tier:'uat'};
test('daily Chrome reuses scoped tabs with per-job locks and rechecks authorization; never closes user tabs',async()=>{
 const calls=[];let permitted=true;
 const b=new SharedChromeBrowser(async()=>permitted,async q=>{calls.push(q);if(q.operation==='execute')assert.match(q.script,/^JSON.stringify/);return q.operation==='find'?{tabId:String(calls.length),windowId:'1'}:{pageText:'Page password=hidden',controls:[]};});
 const r=await b.run({id:'a'},e,'connection');assert.doesNotMatch(r.pageText,/password=hidden/);
 await b.run({id:'a'},e,'browser_snapshot');assert.equal(calls.filter(x=>x.operation==='find').length,1);
 await b.run({id:'b'},e,'connection');assert.equal(calls.filter(x=>x.operation==='find')[1].exclude.length,1);
 permitted=false;const count=calls.length;await assert.rejects(b.run({id:'a'},e,'browser_snapshot'),/授权/);assert.equal(calls.length,count);
 await b.release('a');await b.close();assert.equal(calls.length,count);
});
test('daily Chrome exposes a safe automation health probe',async()=>{
 const calls=[];const b=new SharedChromeBrowser(async()=>true,async q=>{calls.push(q);return {ok:true,running:true,windows:1};});
 assert.deepEqual(await b.health(),{ok:true,running:true,windows:1});assert.equal(calls[0].operation,'health');
});
test('daily Chrome DOM reads rendered text and rejects stale refs, writes and foreign navigation',async t=>{
 const browser=await chromium.launch({headless:true});t.after(()=>browser.close());const page=await browser.newPage();
 await page.route('**/*',r=>r.fulfill({contentType:'text/html; charset=utf-8',body:`<ul role="menu"><li><div class="ant-menu-submenu-title">预算管理</div></li></ul><h1>Actual page</h1><noscript>Enable JavaScript</noscript><div hidden>Hidden secret</div><input type=password value=secret style="display:none"><input placeholder="查询编号"><button onclick="document.querySelector('h1').textContent='Query done'">查询</button><button>保存</button><a href="https://other.example/">Other</a><a href="/app/detail">详情</a><table><tr class="ant-table-row" data-row-key="2097222728173392000" onclick="document.querySelector('h1').textContent='Row detail'"><td>HD-20260810-0157-01</td><td>3150</td></tr></table>`}));
 await page.goto(e.baseUrl);const q={baseUrl:e.baseUrl,token:'one',tool:'browser_snapshot'};
 const read=()=>page.evaluate(chromePage,q);let r=await read();assert.match(r.pageText,/Actual page/);assert.doesNotMatch(r.pageText,/Enable JavaScript|Hidden secret|secret/);
 assert.equal(r.controls.some(c=>['保存','Other'].includes(c.label)),false);assert.ok(r.controls.some(c=>c.label==='预算管理'));assert.ok(r.controls.some(c=>c.label.includes('HD-20260810-0157-01')));
 const old=r.controls.find(c=>c.label==='查询').ref;await read();
 assert.ok((await page.evaluate(chromePage,{...q,tool:'browser_click',args:{ref:old}})).error);
 // Snapshot refs are replaced, not shared across questions.
 assert.ok((await page.evaluate(chromePage,{...q,token:'other',tool:'browser_click',args:{ref:old}})).error);
 r=await read();const ref=r.controls.find(c=>c.label==='查询').ref;
 assert.equal((await page.evaluate(chromePage,{...q,tool:'browser_click',args:{ref}})).acted,true);
 assert.match((await read()).pageText,/Query done/);
 r=await read();const rowRef=r.controls.find(c=>c.label.includes('HD-20260810-0157-01')).ref;
 assert.equal((await page.evaluate(chromePage,{...q,tool:'browser_click',args:{ref:rowRef}})).acted,true);
 assert.match((await read()).pageText,/Row detail/);
 await page.goto('https://other.example/');assert.ok((await read()).error);
});
test('daily Chrome login status is detected without reading password; native bridge errors are explicit',async t=>{
 const browser=await chromium.launch({headless:true});t.after(()=>browser.close());const page=await browser.newPage();
 await page.route('**/*',r=>r.fulfill({contentType:'text/html; charset=utf-8',body:'<input type=password value="private">'}));await page.goto(e.baseUrl);
 const r=await page.evaluate(chromePage,{baseUrl:e.baseUrl,token:'one',tool:'browser_snapshot'});assert.equal(r.loginRequired,true);assert.doesNotMatch(JSON.stringify(r),/private/);
 assert.equal(r.credentialFormVisible,true);assert.equal(r.verificationRequired,false);
 assert.match(failureDiagnostic(new Error('通过 AppleScript 执行 JavaScript 的功能已关闭')),/BROWSER_BRIDGE/);
});
test('fixed daily Chrome login program fills only the scoped login form',async t=>{
 const browser=await chromium.launch({headless:true});t.after(()=>browser.close());const page=await browser.newPage();
 await page.route('**/*',r=>r.fulfill({contentType:'text/html; charset=utf-8',body:'<form><input name="username"><input type="password"><button type="submit" onclick="event.preventDefault();document.body.dataset.login=this.form.username.value+\':\'+this.form.querySelector(\'input[type=password]\').value">登录</button></form>'}));
 await page.goto(e.baseUrl);const result=await page.evaluate(chromeLoginPage,{baseUrl:e.baseUrl,username:'alice',password:'private-value'});
 assert.equal(result.submitted,true);assert.equal(await page.locator('body').getAttribute('data-login'),'alice:private-value');
 await page.goto('https://other.example/');assert.ok((await page.evaluate(chromeLoginPage,{baseUrl:e.baseUrl,username:'alice',password:'private-value'})).error);
});
test('fixed login program keeps same-origin verification pages waiting instead of claiming success',async t=>{
 const browser=await chromium.launch({headless:true});t.after(()=>browser.close());const page=await browser.newPage();
 await page.route('**/*',r=>r.fulfill({contentType:'text/html; charset=utf-8',body:'<h1>请输入短信验证码</h1><input name="otp">'}));
 await page.goto('https://business.example/login');const result=await page.evaluate(chromeLoginPage,{baseUrl:e.baseUrl,username:'alice',password:'private-value'});
 assert.equal(result.loginRequired,true);assert.equal(result.verificationRequired,true);
});
test('daily Chrome distinguishes verification routes from a rejected credential form',async t=>{
 const browser=await chromium.launch({headless:true});t.after(()=>browser.close());const page=await browser.newPage();
 await page.route('**/*',r=>r.fulfill({contentType:'text/html; charset=utf-8',body:'<h1>请输入短信验证码</h1><input name="otp">'}));
 await page.goto('https://business.example/login');const status=await page.evaluate(chromePage,{baseUrl:e.baseUrl,token:'one',tool:'browser_snapshot'});
 assert.equal(status.loginRequired,true);assert.equal(status.credentialFormVisible,false);assert.equal(status.verificationRequired,true);
});
test('empty and iframe shells are incomplete; safe snapshots preserve hash routes',async t=>{
 const browser=await chromium.launch({headless:true});t.after(()=>browser.close());const page=await browser.newPage();
 await page.route('**/*',r=>r.fulfill({contentType:'text/html',body:'<div id="app"></div>'}));await page.goto(e.baseUrl+'#/report/accrued');
 const q={baseUrl:e.baseUrl,token:'empty',tool:'browser_snapshot'};let r=await page.evaluate(chromePage,q);assert.equal(r.partial,true);assert.equal(r.pageStatus,'empty');assert.match(r.url,/#\/report\/accrued/);
 await page.setContent('<iframe src="about:blank"></iframe>');r=await page.evaluate(chromePage,q);assert.equal(r.pageStatus,'frames');assert.equal(r.partial,true);assert.equal(r.frameCount,1);
});
test('empty Chrome probes keep waiting without holding the shared browser queue and recheck access',async()=>{
 const {waitForBrowser}=await import('../src/runner/browser-readiness.js');let snapshots=0,checks=0;const b=new SharedChromeBrowser(async()=>{checks++;return true;},async q=>q.operation==='find'?{tabId:'1',windowId:'1'}:q.operation==='inspect'?{url:e.baseUrl}:(++snapshots<9?{pageStatus:'empty',partial:true,controls:[]}:{pageStatus:'ready',pageText:'Report ready',controls:[]}));
 const r=await waitForBrowser((tool,args)=>b.run({id:'j'},e,tool,args),'browser_open',{},async()=>{},async()=>{});assert.equal(r.pageStatus,'ready');assert.equal(snapshots,9);assert.ok(checks>=10);
 let allowed=true;const c=new SharedChromeBrowser(async()=>allowed,async q=>q.operation==='find'?{tabId:'1',windowId:'1'}:q.operation==='inspect'?{url:e.baseUrl}:{pageStatus:'empty',partial:true,controls:[]});await assert.rejects(waitForBrowser((tool,args)=>c.run({id:'k'},e,tool,args),'browser_open',{},async()=>{},async()=>{allowed=false;}),/授权/);
});
test('visible loading masks defer reads and actions until content is ready, then safe empty query results count as ready',async t=>{
 const browser=await chromium.launch({headless:true});t.after(()=>browser.close());const page=await browser.newPage();await page.route('**/*',r=>r.fulfill({contentType:'text/html; charset=utf-8',body:'<h1>Report shell</h1><div class="ant-spin-spinning">加载中</div><button onclick="window.clicked=true">查询</button>'}));await page.goto(e.baseUrl);
 const q={baseUrl:e.baseUrl,token:'loading',tool:'browser_snapshot'};assert.equal((await page.evaluate(chromePage,q)).waitingForPage,true);assert.equal((await page.evaluate(chromePage,{...q,tool:'browser_click',args:{ref:'stale'}})).waitingForPage,true);assert.equal(await page.evaluate(()=>window.clicked),undefined);
 await page.locator('.ant-spin-spinning').evaluate(el=>el.remove());const ready=await page.evaluate(chromePage,q);assert.equal(ready.pageStatus,'ready');const ref=ready.controls.find(c=>c.label==='查询').ref;await page.evaluate(chromePage,{...q,tool:'browser_click',args:{ref}});assert.equal(await page.evaluate(()=>window.clicked),true);
 await page.setContent('<p>查询结果为0条</p>');assert.equal((await page.evaluate(chromePage,q)).pageStatus,'ready');
});
test('failed same-origin startup script exposes concrete failure without treating empty business results as a network fault',async t=>{
 const browser=await chromium.launch({headless:true});t.after(()=>browser.close());const page=await browser.newPage();await page.route('**/*',r=>r.request().url().endsWith('startup.js')?r.fulfill({status:503,contentType:'text/javascript',body:''}):r.fulfill({contentType:'text/html; charset=utf-8',body:'<div id="app"></div><script src="/app/startup.js"></script>'}));await page.goto(e.baseUrl);const result=await page.evaluate(chromePage,{baseUrl:e.baseUrl,token:'failed-resource',tool:'browser_snapshot'});assert.equal(result.pageStatus,'empty');assert.equal(result.failedResources[0].status,503);
});
