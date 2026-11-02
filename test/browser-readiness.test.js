import test from 'node:test';import assert from 'node:assert/strict';
import {SharedChromeBrowser} from '../src/control-plane/shared-chrome-browser.js';
import {waitForBrowser} from '../src/runner/browser-readiness.js';
const e={baseUrl:'https://business.example/app/',projectId:'p',tier:'prd'},job={id:'JOB-ready'};
test('new blank tab waits before any DOM read, then continues after arbitrarily many probes',async()=>{
 let inspections=0,reads=0,waits=0;const b=new SharedChromeBrowser(async()=>true,async q=>{if(q.operation==='find')return {tabId:'1',windowId:'1',owned:true};if(q.operation==='inspect')return {url:++inspections<15?'about:blank':e.baseUrl};reads++;return {pageStatus:'ready',pageText:'Ready',controls:[]};});
 const r=await waitForBrowser((t,a)=>b.run(job,e,t,a),'connection',{},async()=>{},async()=>{waits++;});assert.equal(r.pageText,'Ready');assert.equal(reads,1);assert.equal(waits,14);
});
test('foreign user tab is never read or navigated: create one background owned tab and keep waiting there',async()=>{
 const calls=[];let finds=0,ready=false;const b=new SharedChromeBrowser(async()=>true,async q=>{calls.push(q);if(q.operation==='find')return {tabId:String(++finds),windowId:'1',owned:finds>1};if(q.operation==='inspect')return {url:q.tabId==='1'?'https://other.example/private':ready?e.baseUrl:'about:blank'};return {pageStatus:'ready',pageText:'Ready',controls:[]};});
 const r=await b.run(job,e,'connection');assert.equal(r.waitingForPage,true);assert.equal(finds,2);assert.equal(calls.some(q=>q.operation==='execute'),false);assert.equal(calls.some(q=>q.operation==='navigate'),false);
 await b.run(job,e,'browser_snapshot');assert.equal(finds,2);ready=true;assert.equal((await b.run(job,e,'browser_snapshot')).pageStatus,'ready');assert.equal(calls.find(q=>q.operation==='execute').tabId,'2');
});
test('closed tab is reacquired with new refs; moved tabs keep their actual window',async()=>{
 let finds=0,closed=true;const calls=[];const b=new SharedChromeBrowser(async()=>true,async q=>{calls.push(q);if(q.operation==='find')return {tabId:String(++finds),windowId:'1',owned:true};if(q.operation==='inspect'){if(closed){closed=false;throw Error('原Chrome标签页已关闭');}return {url:e.baseUrl,windowId:'moved'};}return {pageStatus:'ready',controls:[]};});
 assert.equal((await b.run(job,e,'connection')).waitingForPage,true);assert.equal(finds,2);await b.run(job,e,'browser_snapshot');assert.equal(calls.find(q=>q.operation==='execute').windowId,'moved');
});
test('owned network error reloads only original approved entry, never reloads a user tab',async()=>{
 const calls=[];let ready=false;const b=new SharedChromeBrowser(async()=>true,async q=>{calls.push(q);if(q.operation==='find')return {tabId:'1',windowId:'1',owned:true};if(q.operation==='inspect')return {url:ready?e.baseUrl:'chrome-error://chromewebdata/'};return {pageStatus:'ready',controls:[]};});
 assert.equal((await b.run(job,e,'connection')).waitingForPage,true);assert.equal(calls.filter(q=>q.operation==='navigate').length,1);await b.run(job,e,'browser_snapshot');assert.equal(calls.filter(q=>q.operation==='navigate').length,1);assert.equal(calls.find(q=>q.operation==='navigate').baseUrl,e.baseUrl);ready=true;assert.equal((await b.run(job,e,'browser_snapshot')).pageStatus,'ready');
});
test('completed click is not replayed after slow results; deferred action returns new references',async()=>{
 for(const performed of [true,false]){const calls=[];let polls=0;const r=await waitForBrowser(async(t,a)=>{calls.push(t);return t==='browser_click'?{waitingForPage:true,actionAlreadyPerformed:performed}:++polls<5?{waitingForPage:true}:{controls:[{ref:'new'}],pageStatus:'ready'};},'browser_click',{ref:'old'},async()=>{},async()=>{});assert.equal(calls.filter(t=>t==='browser_click').length,1);assert.equal(r.actionAlreadyPerformed===true,performed);assert.equal(r.actionDeferred===true,!performed);assert.equal(r.controls[0].ref,'new');}
});
test('waiting page does not hold global Chrome queue, so another job can read',async()=>{
 let other=false;const b=new SharedChromeBrowser(async()=>true,async q=>q.operation==='find'?{tabId:q.exclude.length?'2':'1',windowId:'1'}:q.operation==='inspect'?{url:e.baseUrl}:q.tabId==='1'&&!other?{pageStatus:'loading'}:{pageStatus:'ready',pageText:'Ready'});
 await waitForBrowser((t,a)=>b.run(job,e,t,a),'connection',{},async()=>{},async()=>{assert.equal((await b.run({id:'second'},e,'connection')).pageStatus,'ready');other=true;});
});
test('Chrome unavailable is waiting; auth revocation and user stop end polling',async()=>{
 const b=new SharedChromeBrowser(async()=>true,async()=>{throw Error('请先打开日常Google Chrome');});assert.equal((await b.run(job,e,'connection')).waitingForPage,true);
 let polls=0;await assert.rejects(waitForBrowser(async()=>{polls++;return {waitingForPage:true};},'connection',{},async()=>{},async()=>{throw Error('user cancelled');}),/cancelled/);assert.equal(polls,1);
 let authorized=true;const c=new SharedChromeBrowser(async()=>authorized,async q=>q.operation==='find'?{tabId:'1',windowId:'1'}:q.operation==='inspect'?{url:'about:blank'}:{});await assert.rejects(waitForBrowser((t,a)=>c.run(job,e,t,a),'connection',{},async()=>{},async()=>{authorized=false;}),/授权/);
});
test('uncertain action response is not reported as unexecuted and is never automatically replayed',async()=>{
 const calls=[];const result=await waitForBrowser(async t=>{calls.push(t);return t==='browser_search'?{waitingForPage:true,actionMayHavePerformed:true}:{pageStatus:'ready',controls:[]};},'browser_search',{},async()=>{},async()=>{});assert.deepEqual(calls,['browser_search','browser_snapshot']);assert.equal(result.actionOutcomeUnknown,true);assert.equal(result.actionDeferred,undefined);assert.match(result.interactionError,/不要盲目重复/);
});
test('tab closes between URL inspection and DOM read: recover instead of red failure',async()=>{
 let finds=0;const b=new SharedChromeBrowser(async()=>true,async q=>{if(q.operation==='find')return {tabId:String(++finds),windowId:'1',owned:true};if(q.operation==='inspect')return {url:e.baseUrl};throw Error('原Chrome标签页已关闭');});assert.equal((await b.run(job,e,'connection')).waitingForPage,true);assert.equal(finds,2);
});
test('confirmed failed startup assets retry owned entry while ordinary slow empty shells are not repeatedly reloaded',async()=>{
 for(const failed of [true,false]){let navigations=0;const b=new SharedChromeBrowser(async()=>true,async q=>q.operation==='find'?{tabId:'1',windowId:'1',owned:true}:q.operation==='inspect'?{url:e.baseUrl}:q.operation==='navigate'?(navigations++,{ok:true}):{pageStatus:'empty',...(failed?{failedResources:[{status:503,type:'script'}]}:{})});assert.equal((await b.run(job,e,'connection')).waitingForPage,true);assert.equal(navigations,failed?1:0);}
});
test('authorization lost during metadata inspection prevents DOM action and recovery navigation',async()=>{
 let allowed=true,executed=false;const b=new SharedChromeBrowser(async()=>allowed,async q=>{if(q.operation==='find')return {tabId:'1',windowId:'1',owned:true};if(q.operation==='inspect'){allowed=false;return {url:e.baseUrl};}executed=true;return {};});await assert.rejects(b.run(job,e,'browser_click',{ref:'old'}),/授权/);assert.equal(executed,false);
});
