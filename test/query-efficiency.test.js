import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,rm} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {PlannerInputCursor} from '../src/runner/planner-input.js';
import {continuationCatalog,validateContinuation,continuationSourceResult} from '../src/runner/environment-continuation.js';
import {AgentRunner} from '../src/runner/index.js';
import {planQuery} from '../src/shared/environment-access.js';
import {investigateEnvironment} from '../src/runner/environment-investigator.js';

const query={mode:'investigate',reviewed:true,description:'read records',tables:['items'],maxRows:20,timeoutMs:1000,parameters:[{name:'purpose',type:'string'}]};
const entry=(projectId='a',tier='prd')=>({projectId,tier,kind:'mysql',host:'db.invalid',port:3306,database:'db',credentialRef:'synthetic',membersRead:true,ownerOpenIdsByProfile:{owner:['ou_owner']},queries:{investigate:query}});
const cfg={version:1,environments:{a_one:entry(),a_two:entry(),a_sit:entry('a','uat'),b_one:entry('b')}};
const request={environmentId:'a_one',queryId:'investigate',parameters:['read relevant records']};
const job={id:'j',questionId:'q',projectId:'a',originProfile:'owner',senderId:'ou_owner',taskIntent:'analysis',continuousInvestigation:true,stage:'developer',context:[],lease:{id:'l',runnerId:'r'}};
const plan=()=>planQuery(cfg,request,'a',{profile:'owner',senderId:'ou_owner'});
const source={sourceQuestionId:'q',workspace:'/snapshot',sourceSync:{workspace:'/snapshot',cacheKey:'fixed'},handoffGate:{passed:true},verifiedArtifacts:[],outcome:'needs_clarification',finalMessage:'Rules verified; current amounts still require reads',environmentQuery:request,investigation:{status:'continue',blocker:null,goals:[{id:'original-question',status:'open'}]}};
const next={environmentId:'a_two',queryId:'investigate',parameters:['known remaining amounts'],goalIds:null};

test('planner sends changed fields and new results once, preserving errors, schemas and repeated identical observations',()=>{
 const c=new PlannerInputCursor(),base={tools:[{tool:'schema',description:'x'.repeat(3000)}],investigationContext:{originalQuestion:'complete scope'},results:[],progress:{toolCount:0}};
 const a=c.next(base);assert.equal(a.tools.length,1);
 const result={tool:'schema',result:{columns:['actual_column']}};
 const b=c.next({...base,results:[result],progress:{toolCount:1}});assert.equal(b.tools,undefined);assert.deepEqual(b.results,[result]);
 const error={tool:'period_dataset',error:{code:'REPORT_INPUT',message:'range outside current population'}};
 const d=c.next({...base,results:[result,error],progress:{toolCount:2}});assert.deepEqual(d.results,[error]);
 const e=c.next({...base,tools:[{tool:'new_tool'}],results:[result,error,error],progress:{toolCount:3}});assert.deepEqual(e.tools,[{tool:'new_tool'}]);assert.deepEqual(e.results,[error]);
 assert.ok(c.bytes.sent<c.bytes.full*0.55);
 const fresh=new PlannerInputCursor().next({...base,results:[result,error]});assert.ok(fresh.tools);assert.equal(fresh.results.length,2);
});
test('delta handles rolling windows, repeated rows at the boundary and removal of a context field',()=>{
 const c=new PlannerInputCursor();const r={tool:'count',result:{n:'0'}};
 c.next({results:Array(12).fill(r),progress:{toolCount:12},tools:[],optional:'old'});
 const b=c.next({results:Array(12).fill(r),progress:{toolCount:13},tools:[]});assert.equal(b.results.length,1);assert.deepEqual(b.cleared,['optional']);
 assert.equal(c.next({results:Array(12).fill(r),progress:{toolCount:13},tools:[]}).results.length,0);
});
test('same-tier catalog and actual plan validation isolate two systems, environments and unsupported operations',()=>{
 assert.deepEqual(continuationCatalog(cfg,plan(),job).map(e=>e.environmentId),['a_one','a_two']);
 assert.deepEqual(validateContinuation(cfg,plan(),job,next),next);
 for(const environmentId of ['a_sit','b_one','missing'])assert.throws(()=>validateContinuation(cfg,plan(),job,{...next,environmentId}));
 assert.throws(()=>validateContinuation(cfg,plan(),job,{...next,queryId:'write'}));
 assert.throws(()=>validateContinuation(cfg,plan(),job,{...next,parameters:['bad\nparameter']}));
 assert.equal(continuationCatalog(cfg,plan(),{...job,projectId:'b'}).length,0);
});
test('planner proposes a database handoff without executing its target or claiming overall completion',async()=>{
 let calls=0;const ran=[];const result=await investigateEnvironment(plan(),async()=>{},{load:async()=>cfg,credential:async()=>({username:'synthetic-user',password:'synthetic-secret'}),reportJob:job,
  tools:async()=>({spec:[{tool:'connection'},{tool:'list_datasets'},{tool:'group_dataset'}],run:async tool=>{ran.push(tool);return tool==='group_dataset'?{datasetRef:'saved',rowCount:3,rows:[{id:'1'}]}:{};},close:async()=>{}}),
  planner:async()=>({close:async()=>{},next:async input=>{calls++;assert.ok(input.tools.some(t=>t.tool==='continue_environment'));return calls===1?{tool:'group_dataset',arguments:'{}'}:{tool:'continue_environment',arguments:JSON.stringify(next),summary:''};}})});
 assert.deepEqual(ran,['connection','list_datasets','group_dataset']);assert.equal(calls,2);assert.deepEqual(result.nextEnvironmentQuery,next);assert.equal(result.partial,true);
});
test('unresolved tool failure cannot be bypassed by an environment handoff',async()=>{
 const {QueryInputError}=await import('../src/runner/environment-tools.js');let calls=0;
 const result=await investigateEnvironment(plan(),async()=>{},{load:async()=>cfg,credential:async()=>({}),reportJob:job,
 tools:async()=>({spec:[{tool:'connection'},{tool:'select'}],run:async tool=>{if(tool==='select')throw new QueryInputError('REPORT_INPUT','invalid known column');return {};},close:async()=>{}}),
 planner:async()=>({close:async()=>{},next:async()=>[ {tool:'select',arguments:'{}'}, {tool:'continue_environment',arguments:JSON.stringify(next)}, {tool:'finish',summary:'Specific input still unresolved',complete:false}][calls++]})});
 assert.equal(result.nextEnvironmentQuery,null);assert.ok(result.toolInputErrors.some(e=>!e.resolved));assert.equal(result.partial,true);
});
test('restart only continues persisted same-question verified source; failures and delivery return to review',()=>{
 const root={...job,context:[{kind:'analysis_turn',result:source},{kind:'environment_result',result:{outcome:'partial',nextEnvironmentQuery:next}}]};
 assert.deepEqual(continuationSourceResult(JSON.parse(JSON.stringify(root))).environmentQuery,next);
 for(const change of [{environmentFailure:{code:'TIMEOUT'}},{exportFiles:[{id:'f'}]},{toolInputErrors:[{resolved:false}]}])assert.equal(continuationSourceResult({...root,context:[root.context[0],{kind:'environment_result',result:{...root.context[1].result,...change}}]}),null);
 assert.equal(continuationSourceResult({...root,questionId:'foreign'}),null);
 assert.equal(continuationSourceResult({...root,environmentAccess:{}}),null);
 assert.equal(continuationSourceResult({...root,context:[{kind:'analysis_turn',result:{...source,handoffGate:{passed:false}}},root.context[1]]}),null);
});
test('runner skips intermediate source calls, persists both reads and retains final full-source review',async()=>{
 const calls=[];let state={...job};const runner=new AgentRunner({runnerId:'r'},async current=>{
  calls.push(current.environmentAccess?.environmentId??'source');
  if(current.environmentAccess)return {outcome:'partial',finalMessage:'read evidence',nextEnvironmentQuery:current.environmentAccess.environmentId==='a_one'?next:null};
  return current.context.length?{outcome:'ready',finalMessage:'Final review covers original requirements'}:source;
 });
 runner.post=async(url,body)=>{
  if(url.endsWith('/continuous-environment'))state={...state,environmentAccess:body.result.environmentQuery,context:[...state.context??[],{kind:'analysis_turn',result:body.result}]};
  else if(url.endsWith('/continuous-environment-result')){delete state.environmentAccess;state={...state,context:[...state.context,{kind:'environment_result',result:body.result}]};}
  else throw Error('unexpected path');
  return {planned:true,job:structuredClone(state)};
 };
 const result=await runner.executeContinuous(job,async()=>{},new AbortController().signal);
 assert.equal(result.outcome,'ready');assert.deepEqual(calls,['source','a_one','a_two','source']);assert.equal(state.context.filter(x=>x.kind==='environment_result').length,2);
});

test('rejected direct handoff returns to ordinary source analysis and does not execute an ungranted target',async()=>{
 const previous={...job,context:[{kind:'analysis_turn',result:source},{kind:'environment_result',result:{outcome:'partial',nextEnvironmentQuery:next}}]};let executions=0,requests=0;
 const runner=new AgentRunner({},async()=>{executions++;return {outcome:'partial',finalMessage:'Specific configuration changed; existing evidence retained',investigation:{status:'wait',blocker:{kind:'unavailable'}}};});
 runner.post=async()=>{requests++;return {planned:false,job:{...previous,context:[...previous.context,{kind:'query_rejection',result:{code:'CONFIG_CHANGED'}}]}};};
 const result=await runner.executeContinuous(previous,async()=>{},new AbortController().signal);assert.equal(requests,1);assert.equal(executions,1);assert.equal(result.outcome,'partial');
});
test('cancellation prevents a persisted continuation from starting',async()=>{
 const aborted=new AbortController();aborted.abort();let executions=0,posts=0;
 const runner=new AgentRunner({},async()=>{executions++;});runner.post=async()=>{posts++;};
 await assert.rejects(runner.executeContinuous({...job,context:[{kind:'analysis_turn',result:source},{kind:'environment_result',result:{outcome:'partial',nextEnvironmentQuery:next}}]},async()=>{},aborted.signal));assert.equal(executions+posts,0);
});

test('durable long handoff chains survive context compaction and reach the final source prompt with all evidence',async t=>{
 const {JsonStore}=await import('../src/shared/store.js');const {buildPrompt}=await import('../src/runner/codex-executor.js');
 const dir=await mkdtemp(path.join(os.tmpdir(),'query-handoff-')),old=process.env.AGENTOS_ENVIRONMENTS_FILE;process.env.AGENTOS_ENVIRONMENTS_FILE=path.join(dir,'env.json');
 t.after(async()=>{if(old===undefined)delete process.env.AGENTOS_ENVIRONMENTS_FILE;else process.env.AGENTOS_ENVIRONMENTS_FILE=old;await rm(dir,{recursive:true,force:true});});
 await writeFile(process.env.AGENTOS_ENVIRONMENTS_FILE,JSON.stringify(cfg));
 const file=path.join(dir,'state.json'),store=new JsonStore(file),created=await store.createJob({...job,id:undefined});const id=created.job.id,identity={leaseId:'l',runnerId:'r'};
 await store.transact(s=>{const j=s.jobs.find(j=>j.id===id);j.status='running';j.lease={id:'l',runnerId:'r',expiresAt:new Date(Date.now()+60000).toISOString()};});
 let handoff={...source};
 for(let i=0;i<10;i++){
  const req=i?{...next,parameters:['read stage '+i]}:request;
  if(i)handoff.environmentQuery=req;
  const grant=planQuery(cfg,req,'a',{profile:'owner',senderId:'ou_owner'});
  await store.beginContinuousEnvironment(id,identity,grant,handoff);const started=await store.claimEnvironment(id,identity);
  const nextReq=i<9?{...next,parameters:['read stage '+(i+1)]}:null;
  const updated=await store.completeContinuousEnvironment(id,identity,{outcome:'partial',summary:'stage '+i,finalMessage:'distinct-evidence-'+i,
   nextEnvironmentQuery:nextReq,environmentEvidence:{environmentId:grant.environmentId,queryId:grant.queryId,scopeHash:grant.scopeHash,readAt:new Date().toISOString(),lastAuthorizedAt:started.startedAt,rowCount:1,resultHash:String(i).repeat(64),businessProgressHash:String(i).repeat(64)}});
  handoff=continuationSourceResult(updated);
 }
 const saved=await new JsonStore(file).getJob(id);assert.equal(saved.environmentHandoffResults.length,10);assert.equal(saved.context.filter(x=>x.kind==='analysis_turn').length,1);
 const prompt=await buildPrompt(saved,{}, {instruction:'read only',metadata:{}},source.sourceSync,[],source.workspace);
 for(let i=0;i<10;i++)assert.ok(prompt.includes('distinct-evidence-'+i));
 assert.equal(continuationSourceResult(saved),null);
});

test('explicit text delivery omits irrelevant file workflow while file requests keep independent verification',async t=>{
 const {buildPrompt}=await import('../src/runner/codex-executor.js');const dir=await mkdtemp(path.join(os.tmpdir(),'query-text-prompt-')),old=process.env.AGENTOS_ENVIRONMENTS_FILE;process.env.AGENTOS_ENVIRONMENTS_FILE=path.join(dir,'env.json');
 t.after(async()=>{if(old===undefined)delete process.env.AGENTOS_ENVIRONMENTS_FILE;else process.env.AGENTOS_ENVIRONMENTS_FILE=old;await rm(dir,{recursive:true,force:true});});await writeFile(process.env.AGENTOS_ENVIRONMENTS_FILE,JSON.stringify(cfg));
 const base={...job,tabularDelivery:false,originalQuestion:'查当前指标，用文字方式回复，无需csv文档。',context:[]};
 const text=await buildPrompt(base,{}, {instruction:'readonly',metadata:{}},source.sourceSync,[],source.workspace);
 const file=await buildPrompt({...base,tabularDelivery:true,originalQuestion:'导出完整CSV'}, {}, {instruction:'readonly',metadata:{}},source.sourceSync,[],source.workspace);
 assert.match(text,/数据仍须完整、精确和独立核验/);assert.doesNotMatch(text,/上方evidence是程序按文件ID/);assert.match(file,/上方evidence是程序按文件ID/);assert.ok(Buffer.byteLength(text)<Buffer.byteLength(file)-4000);
});

test('planner is closed even when readonly tool cleanup fails',async()=>{
 let closed=0,choices=0;
 await assert.rejects(investigateEnvironment(plan(),async()=>{},{load:async()=>cfg,credential:async()=>({}),reportJob:job,
  tools:async()=>({spec:[{tool:'connection'},{tool:'select'}],run:async tool=>tool==='select'?{rows:[{id:'synthetic'}]}:{},close:async()=>{throw Error('connection already closed');}}),
  planner:async()=>({next:async()=>choices++===0?{tool:'select',arguments:'{}'}:{tool:'finish',summary:'Retain gathered evidence',complete:false},close:async()=>{closed++;}})}),/connection already closed/);
 assert.equal(closed,1);
});
