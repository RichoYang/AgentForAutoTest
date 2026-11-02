import test from 'node:test';
import http from 'node:http';
import assert from 'node:assert/strict';
import {chromium} from 'playwright';
import {chromePage} from '../src/control-plane/chrome-page.js';
import {websiteRequestAllowed} from '../src/shared/website-policy.js';
import {WebsiteBrowser} from '../src/control-plane/website-browser.js';
import {mkdtemp,rm} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {SharedChromeBrowser} from '../src/control-plane/shared-chrome-browser.js';

const baseUrl='https://business.example/app/';
async function fixture(t,body){
 const browser=await chromium.launch({headless:true});t.after(()=>browser.close());const page=await browser.newPage();
 await page.route('**/*',r=>r.fulfill({contentType:'text/html; charset=utf-8',body}));await page.goto(baseUrl+'#/list');
 const q={baseUrl,token:'form-test'};
 const snapshot=()=>page.evaluate(chromePage,{...q,tool:'browser_snapshot'});
 const act=(tool,args)=>page.evaluate(chromePage,{...q,tool,args});
 return {page,q,snapshot,act};
}
test('creation menu and source hash route enter form; stale refs and foreign routes cannot act',async t=>{
 const {page,snapshot,act}=await fixture(t,'<ul role=menu><li role=menuitem onclick="location.hash=\'/project/create/general\'">方案创建</li><li role=menuitem>审批管理</li></ul><a href="#/customer/edit">编辑客户</a><button>提交</button>');
 let r=await snapshot();assert.ok(r.controls.find(x=>x.label==='方案创建'));assert.ok(r.controls.find(x=>x.label==='编辑客户'));assert.equal(r.controls.some(x=>x.label==='提交'),false);
 const old=r.controls[0].ref;assert.equal((await act('browser_click',{ref:old})).acted,true);assert.match(page.url(),/project\/create\/general/);
 assert.ok((await act('browser_click',{ref:old})).error);
 assert.equal((await act('browser_navigate',{url:baseUrl+'#/customer/create'})).acted,true);assert.match(page.url(),/customer\/create/);
 for(const url of ['https://foreign.example/app/#/create',baseUrl+'#/delete/1',baseUrl+'api/save',baseUrl+'unlinked'])assert.ok((await act('browser_navigate',{url})).error,url);
});
test('temporary form changes expose real disabled state and reproduce a dependent date reset without submitting',async t=>{
 const {page,snapshot,act}=await fixture(t,`<div class=ant-form-item><label for=execution>执行日期</label><input id=execution type=date onchange="document.querySelector('#apply').value='';document.querySelector('#apply').disabled=true"></div><div class=ant-form-item><label for=apply>活动可申请时间</label><input id=apply type=date value=2026-11-01></div><button type=submit onclick="document.body.dataset.saved='yes'">保存</button><button onclick="document.body.dataset.saved='yes'">提交</button><input type=password style="display:none" value=hidden-secret>`);
 let r=await snapshot();const ref=r.controls.find(x=>x.label==='执行日期').ref;
 assert.equal((await act('browser_fill',{ref,text:'2026-11-01'})).acted,true);
 r=await snapshot();const field=r.controls.find(x=>x.label==='活动可申请时间');assert.equal(field.disabled,true);assert.equal(field.value,'');
 assert.ok((await act('browser_fill',{ref:field.ref,text:'2026-11-02'})).error);assert.equal(await page.locator('#apply').isDisabled(),true);
 assert.equal(r.controls.some(x=>/保存|提交/.test(x.label)),false);assert.equal(await page.locator('body').getAttribute('data-saved'),null);assert.doesNotMatch(JSON.stringify(r),/hidden-secret/);
});
test('readonly custom date inputs open calendar and dates can be selected, disabled days remain inspectable',async t=>{
 const {page,snapshot,act}=await fixture(t,`<label for=date>申请日期</label><input id=date readonly onclick="document.querySelector('[role=grid]').hidden=false"><div role=grid hidden><button>保存</button><span role=gridcell aria-label="2026-11-01" onclick="document.querySelector('#date').value='2026-11-01'">1</span><span role=gridcell aria-label="2026-10-01" aria-disabled=true>1</span></div>`);
 let r=await snapshot();let f=r.controls.find(x=>x.label==='申请日期');assert.equal(f.readOnly,true);assert.ok((await act('browser_fill',{ref:f.ref,text:'2026-11-01'})).error);
 assert.equal((await act('browser_click',{ref:f.ref})).acted,true);r=await snapshot();let day=r.controls.find(x=>x.label==='2026-11-01');assert.ok(day);assert.equal(r.controls.some(x=>x.label==='保存'),false);assert.equal(r.controls.find(x=>x.label==='2026-10-01').disabled,true);
 assert.equal((await act('browser_click',{ref:day.ref})).acted,true);assert.equal(await page.locator('#date').inputValue(),'2026-11-01');
});
test('non-date forms support temporary native selects and textarea; no Enter or submit event',async t=>{
 const {page,snapshot,act}=await fixture(t,`<form onsubmit="event.preventDefault();document.body.dataset.submitted='yes'"><label for=kind>方案类型</label><select id=kind><option value=a>A</option><option value=b>B</option></select><label for=description>描述</label><textarea id=description></textarea><button type=submit>保存</button></form>`);
 let r=await snapshot();await act('browser_select',{ref:r.controls.find(x=>x.label==='方案类型').ref,value:'b'});r=await snapshot();await act('browser_fill',{ref:r.controls.find(x=>x.label==='描述').ref,text:'temporary values'});
 assert.equal(await page.locator('#kind').inputValue(),'b');assert.equal(await page.locator('#description').inputValue(),'temporary values');assert.equal(await page.locator('body').getAttribute('data-submitted'),null);
});
test('shared Chrome dispatches new tools and refreshes snapshot after actions',async()=>{
 let acted=false;const calls=[];const b=new SharedChromeBrowser(async()=>true,async q=>{calls.push(q);if(q.operation==='find')return {tabId:'1',windowId:'1'};if(q.operation==='inspect')return {url:baseUrl};if(q.script.includes('"tool":"browser_snapshot"'))return {controls:[],pageText:'new form'};acted=true;return {acted:true};});
 for(const tool of ['browser_navigate','browser_fill']){const r=await b.run({id:'form'}, {baseUrl},tool,{url:baseUrl+'#/create',text:'date'});assert.equal(r.pageText,'new form');}
 assert.ok(acted);assert.equal(calls.filter(x=>x.operation==='execute').length,4);
});

test('isolated browser uses same menu/form/disabled inspection program and keeps network writes blocked',async t=>{
 const dir=await mkdtemp(path.join(os.tmpdir(),'agentos-form-'));
 const server=http.createServer((req,res)=>{res.setHeader('content-type','text/html; charset=utf-8');res.end(`<ul role=menu><li role=menuitem>方案创建</li></ul><label for=d>日期</label><input id=d type=date><button>保存</button>`);});await new Promise(r=>server.listen(0,'127.0.0.1',r));
 t.after(()=>new Promise(r=>server.close(r)));
 const driver={launchPersistentContext:(dir,opts)=>chromium.launchPersistentContext(dir,{...opts,headless:true,args:[...opts.args,'--no-proxy-server','--host-resolver-rules=MAP agentos-fixture.test 127.0.0.1']})};
 const localBase=`http://agentos-fixture.test:${server.address().port}/app/`;
 const b=new WebsiteBrowser(dir,driver);t.after(async()=>{await b.close();await rm(dir,{recursive:true,force:true});});
 const job={id:'one'},env={baseUrl:localBase,projectId:'p',tier:'uat'};let r=await b.run(job,env,'connection');assert.ok(r.controls.find(x=>x.label==='方案创建'));
 const old=r.controls.find(x=>x.label==='日期').ref;r=await b.run(job,env,'browser_snapshot');const recovered=await b.run(job,env,'browser_fill',{ref:old,text:'2026-11-01'});assert.match(recovered.interactionError,/引用/);assert.ok(recovered.controls.find(x=>x.label==='日期'));assert.equal(recovered.partial,true);
 r=await b.run(job,env,'browser_navigate',{url:localBase+'#/create'});assert.match(r.url,/#\/create/);
 r=await b.run(job,env,'browser_fill',{ref:r.controls.find(x=>x.label==='日期').ref,text:'2026-11-01'});assert.equal(r.controls.find(x=>x.label==='日期').value,'2026-11-01');assert.equal(r.controls.some(x=>x.label==='保存'),false);
 for(const url of ['https://business.example/app/create','https://business.example/app/edit'])assert.equal(websiteRequestAllowed(baseUrl,{url,method:'GET',resourceType:'document'}),true);
 for(const [url,method,resourceType] of [['https://business.example/app/create','POST','fetch'],['https://business.example/app/save','GET','document'],['https://business.example/app/delete','POST','fetch']])assert.equal(websiteRequestAllowed(baseUrl,{url,method,resourceType}),false);
});
