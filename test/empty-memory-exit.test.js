import {fork} from 'node:child_process';
import {once} from 'node:events';
import {pathToFileURL} from 'node:url';
import test from 'node:test';import assert from 'node:assert/strict';
import {mkdtemp,rm,readFile,writeFile,readdir} from 'node:fs/promises';import os from 'node:os';import path from 'node:path';
import {ReportDatasets} from '../src/runner/report-datasets.js';import {inspectReport} from '../src/shared/report-inspection.js';
import {JsonStore} from '../src/shared/store.js';import {LiveCards} from '../src/control-plane/live-cards.js';
import {registerLocalExecution,recoverLocalExecutions} from '../src/runner/local-executions.js';
const fixture=async t=>{const root=await mkdtemp(path.join(os.tmpdir(),'empty-memory-'));t.after(()=>rm(root,{recursive:true,force:true}));return root;};
test('known amount totals and missing counts reconcile with empty cells, including all-null amounts',async t=>{
 for(const allNull of [false,true]){
 const root=await fixture(t),directory=path.join(root,'exports','J'),d=new ReportDatasets({directory,scope:'test',maxRows:10});
 const collect=(sql,rows,columns=['id','amount'])=>d.collect({sql,params:[],columns,numericColumns:columns.includes('amount')?['amount']:[]},async()=>[rows]);
 const src=await collect('SELECT grouped',[{id:'1',amount:allNull?null:'9007199254740993.12'},{id:'2',amount:null},{id:'3',amount:null}]);
 const pop=await collect('SELECT independent ids',[{id:'1'},{id:'2'},{id:'3'}],['id']);
 const ref=await collect('SELECT independent total',[{id:'bucket',amount:allNull?null:'9007199254740993.12'}]);
 const columns=[{label:'编号',value:{op:'key'}},{label:'金额',total:true,value:{op:'field',source:'s1',column:'amount',missing:'empty'}}];
 const draft=await d.compose({sources:[{name:'s1',datasetRef:src.datasetRef,keyColumn:'id'}],columns});
 if(allNull)assert.equal(draft.totals['金额'],null);
 const final=await d.finalize({datasetRef:draft.datasetRef,requirement:'全部对象金额保留空值，不视为零',scopeEvidence:'合成全对象独立范围',expectedColumns:columns.map(c=>c.label),populationRef:pop.datasetRef,populationKey:'id',columnRules:columns.map(c=>({label:c.label,definition:'原始金额和空值保留',evidence:'合成表字段及明确缺失规则'})),checks:[{source:'s1',column:'amount',referenceRef:ref.datasetRef,referenceColumn:'amount',evidence:'相同范围独立汇总'}]});
 assert.equal(final.totals[0].missingCount,allNull?3:2);assert.equal(final.totals[0].total,allNull?null:'9007199254740993.12');assert.equal(final.totals[0].missingPolicy,'empty');
 const body=await readFile(path.join(directory,final.exportFile.filename),'utf8');assert.match(body,/"2",""/);
 const inspected=await inspectReport(root,{id:'J',reportFiles:[final.exportFile]},{fileId:final.exportFile.id});assert.equal(inspected.rowCount??inspected.file?.rowCount??3,3);
 }
});
test('empty missing values still cannot enter numeric arithmetic or silently accept malformed amounts',async t=>{
 const root=await fixture(t),d=new ReportDatasets({directory:root,maxRows:10});const s=await d.collect({sql:'s',params:[],columns:['id','amount']},async()=>[[{id:'1',amount:null}]]);
 await assert.rejects(d.compose({sources:[{name:'s1',datasetRef:s.datasetRef,keyColumn:'id'}],columns:[{label:'金额',value:{op:'add',args:[{op:'field',source:'s1',column:'amount',missing:'empty'},{op:'field',source:'s1',column:'amount',missing:'zero'}]}}]}),/金额/);
});
test('projected reads are detached, cold loads coalesce, and card retries do not clone job history',async t=>{
 const root=await fixture(t),s=new JsonStore(path.join(root,'state.json'));await s.transact(x=>{x.jobs=[{id:'j',history:'x'.repeat(3000000)}];x.cardMessages={a:{revision:1,deliveredRevision:1}};});
 const cold=new JsonStore(s.file);let loads=0;const load=cold.loadSnapshot.bind(cold);cold.loadSnapshot=()=>{loads++;return load();};
 await Promise.all(Array.from({length:20},()=>cold.select(s=>s.jobs[0].id)));assert.equal(loads,1);
 const view=await cold.select(s=>s.cardMessages);view.a.revision=9;assert.equal((await cold.select(s=>s.cardMessages.a.revision)),1);
 cold.read=()=>{throw new Error('Full root read forbidden on hot retry');};const c=new LiveCards(cold,{replyCard:async()=>{},updateCard:async()=>{}});await Promise.all([c.retry(),c.retry()]);await c.stop();
});
test('startup recovers only matching dead local owners and absent entire worker groups, with preserved evidence',async t=>{
 const root=await fixture(t),store=new JsonStore(path.join(root,'state.json')),directory=path.join(root,'registry');
 const job={id:'j',status:'running',taskIntent:'analysis',lease:{id:'lease',runnerId:'runner'},events:[],context:[{result:{summary:'kept evidence'}}]};await store.transact(s=>s.jobs.push(job));await registerLocalExecution(directory,job,999999,{platform:'linux'});
 let probes=[];const result=await recoverLocalExecutions(store,directory,{platform:'linux',absent:pid=>{probes.push(pid);return true;}});assert.equal(result.recovered,1);assert.ok(probes.includes(-999999));const j=await store.getJob('j');assert.equal(j.status,'blocked');assert.equal(j.result.investigationStopped.code,'EXECUTOR_EXITED');assert.equal(j.context[0].result.summary,'kept evidence');assert.equal(j.lease,null);assert.equal((await readdir(directory)).length,0);
});
test('live/reused process IDs, remaining descendants, foreign hosts, wrong leases and Windows never authorize replay',async t=>{
 for(const scenario of ['owner-live','child-live','foreign','stale','windows']){
  const root=await fixture(t),store=new JsonStore(path.join(root,'state.json')),dir=path.join(root,'registry'),job={id:'j',status:'cancelling',lease:{id:'l',runnerId:'r'},events:[]};await store.transact(s=>s.jobs.push(job));await registerLocalExecution(dir,job,999998,{platform:'linux'});
  if(scenario==='stale')await store.transact(s=>s.jobs[0].lease.id='new');
  const result=await recoverLocalExecutions(store,dir,{platform:scenario==='windows'?'win32':'linux',...(scenario==='foreign'?{host:'different-host'}:{}),absent:pid=>scenario==='owner-live'?pid<0:scenario==='child-live'?pid>0:true});assert.equal(result.recovered,0);assert.equal((await store.getJob('j')).status,'cancelling');
 }
});

test('losing the IPC parent exits the worker; normal completion remains successful',async t=>{
 const root=await fixture(t),module=pathToFileURL(path.resolve('src/runner/parent-exit.js')).href;
 for(const normal of [false,true]){
  const file=path.join(root,normal?'normal.mjs':'lost.mjs');await writeFile(file,`import {fenceParentExit} from ${JSON.stringify(module)};const finish=fenceParentExit();process.send('ready');process.on('message',()=>{${normal?"finish();process.disconnect();":"setInterval(()=>{},1000);"}});`);
  const worker=fork(file,[],{detached:process.platform!=='win32',execArgv:[],stdio:['ignore','ignore','ignore','ipc']});t.after(()=>{try{process.platform==='win32'?worker.kill():process.kill(-worker.pid,'SIGKILL');}catch{}});
  await once(worker,'message');const exited=once(worker,'exit');if(normal)worker.send('finish');else worker.disconnect();const [code,signal]=await exited;assert.equal(normal?code===0:process.platform==='win32'?code===1:signal==='SIGKILL',true);
 }
});
test('an unknown independent total cannot certify a known zero',async t=>{
 const root=await fixture(t),d=new ReportDatasets({directory:root,maxRows:10});
 const collect=(sql,amount)=>d.collect({sql,params:[],columns:['id','amount'],numericColumns:['amount']},async()=>[[{id:'1',amount}]]);
 const src=await collect('source','0'),pop=await collect('population','0'),ref=await collect('reference',null);
 const columns=[{label:'金额',value:{op:'field',source:'s1',column:'amount',missing:'empty'}}];const draft=await d.compose({sources:[{name:'s1',datasetRef:src.datasetRef,keyColumn:'id'}],columns});
 await assert.rejects(d.finalize({datasetRef:draft.datasetRef,requirement:'明确金额未知不冒充零',scopeEvidence:'独立完整对象范围',expectedColumns:['金额'],populationRef:pop.datasetRef,populationKey:'id',columnRules:[{label:'金额',definition:'空值保留不视为零',evidence:'合成金额来源定义'}],checks:[{source:'s1',column:'amount',referenceRef:ref.datasetRef,referenceColumn:'amount',evidence:'独立金额合计基准'}]}),/全为空不能当作已知零/);
});
