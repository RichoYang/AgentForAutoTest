import test from 'node:test';import assert from 'node:assert/strict';
import {mkdtemp,writeFile,readFile,rm} from 'node:fs/promises';import os from 'node:os';import path from 'node:path';
import {createRequirementAgent} from '../src/runner/requirement-agent.js';
import {validateMutationReadback,mutationReadbackHash,verifiedMutationCleanup} from '../src/runner/requirement-mutation-measurement.js';
import {planCoverageMatrix,duplicatePlanChecks,pageStageErrors} from '../src/runner/requirement-agent-contracts.js';
import {verifyPageStage,pageStageContext,compareAgentObservation,assertionBinding} from '../src/runner/requirement-agent-assertion-binding.js';
import {createAgentResources,mysqlResultColumns} from '../src/runner/requirement-agent-resources.js';
import {recordGap,resolveGaps} from '../src/runner/requirement-agent-progress.js';
import {createServer} from 'node:http';

test('coverage matrix preserves mixed clauses and legitimate split checks; only exactly duplicate contracts are rejected',()=>{
 const plan={checks:[{id:'delete',line:1,requirement:'product deletion hides search results',channel:'api',field:['visible']},{id:'detail',line:1,requirement:'deleted item has state DELETED',channel:'api',field:['state']}],processChecks:[{id:'cleanup',line:1,requirement:'remove test-owned prerequisite data',kind:'cleanup',relatedCheckIds:['delete','detail']}]};
 const matrix=planCoverageMatrix(['1. Product deletion hides search results; remove test-owned prerequisites afterwards.'],plan);
 assert.equal(matrix[0].business.length,2);assert.equal(matrix[0].process.length,1);assert.match(matrix[0].originalExpectation,/Product deletion/);assert.deepEqual(duplicatePlanChecks(plan),[]);
 assert.match(duplicatePlanChecks({...plan,checks:[...plan.checks,{...plan.checks[0],id:'duplicate'}]})[0],/duplicate.*delete/);
});

test('connector metadata declares exact text separately from null or unknown JSON representation',()=>{
 const columns=mysqlResultColumns([{name:'id',columnType:8},{name:'amount',columnType:246},{name:'date',columnType:12},{name:'count',columnType:3},{name:'json',columnType:245}]);
 assert.deepEqual(columns.map(column=>column.representation),['string','string','string','number',null]);
});

test('new connector metadata does not change legacy full-readback restoration or hide business changes',()=>{
 const original={rows:[{key:'owned',amount:'0.0000',note:null}],count:1},after={...original,columns:[{name:'key',columnType:253,representation:'string'},{name:'amount',columnType:246,representation:'string'}]};
 assert.equal(mutationReadbackHash(original),mutationReadbackHash(after));
 assert.notEqual(mutationReadbackHash(original),mutationReadbackHash({...after,rows:[{key:'owned',amount:'1.0000',note:null}]}));
 assert.notEqual(mutationReadbackHash(original),mutationReadbackHash({...after,rows:[{key:'owned',amount:'0.0000'}]}));
 assert.notEqual(mutationReadbackHash(original),mutationReadbackHash({...after,rows:[],count:0}));
 assert.equal(verifiedMutationCleanup({intent:{agent:true,verifySpec:{kind:'database'},snapshot:original,ownership:{field:['rows',0,'key']},before:[{field:['rows',0,'amount'],operator:'equals',expected:'0.0000'}],after:[{field:['rows',0,'amount'],operator:'equals',expected:'1.0000'}]},cleanup:{verified:true,after}}),true);
});

test('plan review receives exact decimal-text method proof while the original future expectation stays independent',async t=>{
 const root=await mkdtemp(path.join(os.tmpdir(),'aos-plan-types-'));t.after(()=>rm(root,{recursive:true,force:true}));const at=new Date().toISOString();
 const sample={observationId:'sample',caseKey:'C@1',at,channel:'api',input:{resource:'api'},data:{status:200,body:{key:'A',amount:'9007199254740993.0000'}}};
 await writeFile(path.join(root,'agent-tool-state.json'),JSON.stringify({operations:{},sources:{},schemas:{},observations:{sample},cases:{'C@1':{startedAt:at,observations:['sample'],aliases:{},assertions:{},errors:[]}}}));let planReview=false;
 const agent=createRequirementAgent({}, {workDir:root,review:async prompt=>{const payload=JSON.parse(prompt.slice(prompt.lastIndexOf('\n\n')+2));if(payload.kind==='plan'){planReview=true;assert.deepEqual(payload.measurementSamples[0].fields[0].representation,{encoding:'decimal-text',exact:true});assert.equal(payload.plan.checks[0].expected,'9007199254740994.0000');}return {accepted:true,errors:[]};},agentModel:async({call})=>({close:async()=>{},async turn(){
   const plan={version:1,steps:['read amount after the scene'],prerequisites:[],checks:[{id:'amount',line:1,requirement:'amount 9007199254740994.0000',channel:'api',subject:{key:'A'},type:'number',operator:'equals',expected:'9007199254740994.0000',basis:{quote:'amount 9007199254740994.0000'},measurement:{observationId:'sample',field:['body','amount'],identity:[{dimension:'key',field:['body','key']}]}}]};
   await call('test_plan',{args:plan});await call('test_finish',{args:{actual:'Method proof only',blocker:{dependency:'module fixture',required_action:'native acceptance',attempts:['method proof keeps raw decimal text']}}});return {text:'done'};
 }})});
 await agent.execute({item:{caseId:'C'},headers:['预期结果'],row:['1. amount 9007199254740994.0000'],source:{},resourceNames:['api'],mutations:[],reports:root,checkOutput:value=>value});assert.equal(planReview,true);
});

test('known database serialization rejects incompatible after types before a mutation can be sent',()=>{
 const intent={verifySpec:{kind:'database'},snapshot:{rows:[{key:'owned',available:'17'}],columns:[{name:'key',representation:'string'},{name:'available',representation:'string',columnType:8}]},ownership:{field:['rows',0,'key']},stateFields:[['rows',0,'available']],before:[{field:['rows',0,'available'],operator:'equals',expected:'17'}],after:[{field:['rows',0,'available'],operator:'equals',expected:14}]};
 assert.throws(()=>validateMutationReadback(intent),/after.*available.*string/);
 validateMutationReadback({...intent,after:[{...intent.after[0],expected:'14'}]});
 validateMutationReadback({...intent,snapshot:{...intent.snapshot,rows:[]},before:[{field:['rows',0],operator:'absent'}],after:[{field:['rows',0,'available'],operator:'equals',expected:'14'}]});
 const future={channel:'database',data:{...intent.snapshot,rows:[]},input:{sql:'SELECT available FROM owned'}};
 const selected=assertionBinding({requirement:'future amount',type:'number',channel:'database'},future,{field:['rows',0,'available']},{}).selected[0];assert.equal(selected.availability,'empty_collection');assert.equal(selected.queryColumn.representation,'string');
 assert.throws(()=>assertionBinding({requirement:'future amount',type:'number',channel:'database'},future,{field:['rows',0,'typo']},{}),/verified query/);
});

test('real page actions bind preflight, first A, B, return A and extra A without relabelling saved observations',async t=>{
 const root=await mkdtemp(path.join(os.tmpdir(),'aos-page-stages-'));t.after(()=>rm(root,{recursive:true,force:true}));
 const server=createServer((req,res)=>{res.setHeader('content-type','text/html');const key=new URL(req.url,'http://local').searchParams.get('key');res.end('<div id="busy">loading</div><div id="key"></div><div id="amount"></div><script>setTimeout(()=>{document.querySelector("#key").textContent='+JSON.stringify(key)+';document.querySelector("#amount").textContent='+JSON.stringify(key==='A'?'7':'17')+';document.querySelector("#busy").hidden=true},30)</script>');});
 await new Promise(r=>server.listen(0,'127.0.0.1',r));t.after(()=>new Promise(r=>server.close(r)));
 const runtime=createAgentResources({}, {state:{operations:{}},item:{caseId:'C'},reports:root,useRead:(_name,run)=>run({base_url:'http://127.0.0.1:'+server.address().port})});
 const observations={},current={epoch:0,observations:[]},identity=[{dimension:'key',field:['values','key',0]}],fields={key:{selector:'#key',read:'text'},amount:{selector:'#amount',read:'text'}};let serial=0;
 async function call(args){const data=await runtime.browser({resource:'web',...args}),id='saved-'+(++serial);observations[id]={observationId:id,epoch:0,caseKey:'C@1',channel:'page',at:new Date().toISOString(),input:{resource:'web',...args},data};current.observations.push(id);return observations[id];}
 const ready={selector:'#busy',state:'hidden'},observe=()=>call({action:'observe',fields}),goto=key=>call({action:'goto',path:'/page?key='+key,ready});
 try{
  await goto('A');const preA=await observe();await goto('B');const preB=await observe();current.planAt=new Date().toISOString();current.scenarioStartedAt=new Date().toISOString();
  const plan={steps:['first A','switch B','return A'],pageStages:[{id:'first',step:1,resource:'web',action:'goto',path:'/page?key=A',subject:{key:'A'}},{id:'second',step:2,resource:'web',action:'goto',path:'/page?key=B',subject:{key:'B'}},{id:'return',step:3,resource:'web',action:'goto',path:'/page?key=A',subject:{key:'A'}}],checks:['first','second','return'].map((pageStage,i)=>({id:'C'+i,pageStage,channel:'page',subject:{key:i===1?'B':'A'},measurement:{observationId:i===1?preB.observationId:preA.observationId,identity}}))};
  plan.checks.push({...plan.checks[0],id:'C-first-other-field'});current.plan=plan;
  plan.checks.push({...plan.checks[0],id:'C-first-third-field'});
  assert.deepEqual(pageStageErrors(plan,['web']),[]);
  await goto('A');const first=await observe(),firstAgain=await observe();assert.equal(first.data.lifecycle.pageAction.id,firstAgain.data.lifecycle.pageAction.id);
  await goto('B');const second=await observe();await goto('A');const returned=await observe();await goto('A');const extra=await observe();
  const args=record=>({observationId:record.observationId,identity});
  const proof=verifyPageStage(plan,plan.checks[0],current,observations,args(first));assert.deepEqual(proof.candidateObservationIds,[first.observationId,firstAgain.observationId]);
  assert.equal(verifyPageStage(plan,plan.checks[1],current,observations,args(second)).valid,true);assert.equal(verifyPageStage(plan,plan.checks[2],current,observations,args(returned)).valid,true);
  let wrong;try{verifyPageStage(plan,plan.checks[0],current,observations,args(returned));}catch(error){wrong=error;}assert.match(wrong.message,/selected stage return/);assert.match(wrong.message,/C-first-other-field/);assert.match(wrong.message,new RegExp(first.observationId));
  assert.throws(()=>verifyPageStage(plan,plan.checks[0],current,observations,args(extra)),/additional_visit/);
  assert.throws(()=>verifyPageStage(plan,plan.checks[0],current,observations,args(preA)),/unbound/);
  const spoof={...observations,[first.observationId]:{...first,data:{...first.data,values:{...first.data.values,key:['B'],other:['A']}}}};
  assert.equal(pageStageContext(plan,plan.checks[0],current,spoof,{observationId:first.observationId,identity:[{dimension:'key',field:['values','other',0]}]}).valid,false);
  const changedSelector={...observations,[first.observationId]:{...first,data:{...first.data,measurements:{...first.data.measurements,key:{selector:'#unrelated',read:'text'}}}}};
  assert.equal(pageStageContext(plan,plan.checks[0],current,changedSelector,args(first)).valid,false);
  const missing={...current,observations:current.observations.filter(id=>![first.observationId,firstAgain.observationId].includes(id))};assert.throws(()=>verifyPageStage(plan,plan.checks[2],missing,observations,args(returned)),/missing stages: first/);
  assert.equal(pageStageContext(plan,plan.checks[0],{...current,epoch:1},observations).candidateObservationIds.length,0);
  const gaps={...current,gaps:{},assertions:{}};recordGap(gaps,{tool:'test_assert',args:{checkId:'C0'},error:wrong,evidenceVersion:'same'});recordGap(gaps,{tool:'test_assert',args:{checkId:'C-first-other-field'},error:wrong,evidenceVersion:'same'});
  assert.equal(recordGap(gaps,{tool:'test_assert',args:{checkId:'C-first-third-field'},error:wrong,evidenceVersion:'same'}).unchanged,0);assert.equal(Object.keys(gaps.gaps).length,1);
  assert.equal(recordGap(gaps,{tool:'test_assert',args:{checkId:'C0'},error:wrong,evidenceVersion:'new-but-still-wrong'}).unchanged,1);
  assert.equal(recordGap(gaps,{tool:'test_assert',args:{checkId:'C0'},error:wrong,evidenceVersion:'same'}).unchanged,2);
  resolveGaps(gaps,'test_assert',{checkId:'C0'});assert.equal(Object.values(gaps.gaps)[0].resolved,true);
  // A valid phase does not make a wrong product value pass.
  const bad={...first,data:{...first.data,values:{...first.data.values,amount:['0']}}};assert.equal(compareAgentObservation({id:'amount',channel:'page',type:'number',expected:7,operator:'equals'},bad,{field:['values','amount',0]}).passed,false);
  plan.checks.forEach(check=>Object.assign(check,{line:1,requirement:'page amount',type:'number',operator:'equals',expected:check.subject.key==='B'?17:7,basis:{quote:'page amount'}}));
  plan.processChecks=[{id:'Pstage',line:2,requirement:'prove page stages',kind:'execution_evidence',relatedCheckIds:['C0']}];
  await writeFile(path.join(root,'agent-tool-state.json'),JSON.stringify({operations:{},sources:{},schemas:{},observations,cases:{'C@1':{...current,startedAt:preA.at,assertions:{},aliases:{},errors:[]}}}));let semanticReviews=0;
  const agent=createRequirementAgent({}, {workDir:root,review:async prompt=>{semanticReviews++;const payload=JSON.parse(prompt.slice(prompt.lastIndexOf('\n\n')+2));if(payload.kind==='process'){
    assert.equal(payload.observed[0].page.lifecycle.pageAction.id,first.data.lifecycle.pageAction.id);
    assert.equal(payload.related[0].comparedObservations[0].observationId,first.observationId);
    assert.equal(payload.pageTimeline.find(item=>item.observationId===second.observationId).lifecycle.pageAction.id,second.data.lifecycle.pageAction.id);
    assert.equal(payload.pageStages[0].stages[0].observations[0].at,first.at);
  }return {accepted:true,errors:[]};},agentModel:async({call})=>({close:async()=>{},async turn(){
    await assert.rejects(call('test_assert',{args:{checkId:'C0',...args(returned),field:['values','amount',0]}}),error=>error.code==='page_stage'&&error.gap.confirmed.pageStage.relatedCheckIds.includes('C-first-other-field'));
    // One model batch may contain sibling checks before it sees the first
    // rejection. Group their shared gap without tightening the old per-check
    // repeated-no-progress threshold or preventing the model from correcting it.
    for(const checkId of ['C-first-other-field','C-first-third-field'])await assert.rejects(call('test_assert',{args:{checkId,...args(returned),field:['values','amount',0]}}),error=>error.code==='page_stage');
    assert.equal(semanticReviews,0);const saved=await call('test_evidence',{args:{observationId:first.observationId}});assert.equal(saved.usableForCurrentAssertion,true);
    await assert.rejects(call('test_assert',{args:{checkId:'C0',...args(first),field:['values','amount',0],evidenceRefs:[{observationId:first.observationId,fields:[['lifecycle','ready']]}]}}),/actual root fields:.*ready/);assert.equal(semanticReviews,0);
    assert.equal((await call('test_assert',{args:{checkId:'C0',...args(first),field:['values','amount',0]}})).passed,true);assert.equal(semanticReviews,1);
    assert.equal((await call('test_process',{args:{checkId:'Pstage',evidenceRefs:[{observationId:first.observationId,fields:[['values','key']]}]}})).proven,true);
    await call('test_finish',{args:{actual:'Component timing verified',blocker:{dependency:'module fixture',required_action:'full native execution',attempts:['actual page phases and saved evidence']}}});return {text:'done'};
  }})});
  await agent.execute({item:{caseId:'C'},reports:root,headers:['预期结果'],row:['1. page amount\n2. prove page stages'],source:{},resourceNames:['web'],mutations:[],checkOutput:value=>value});
 }finally{await runtime.close();}
});

test('inline identity preflight fails before publishing a frozen plan; the corrected candidate needs no restore',async t=>{
 const root=await mkdtemp(path.join(os.tmpdir(),'aos-plan-candidate-'));t.after(()=>rm(root,{recursive:true,force:true}));
 const at='2026-01-01T00:00:01Z',record={observationId:'sample',caseKey:'C1@1',at,channel:'api',data:{status:200,body:{key:'A',amount:0,children:[]}},input:{resource:'api'}};
 await writeFile(path.join(root,'agent-tool-state.json'),JSON.stringify({operations:{},sources:{},schemas:{},observations:{sample:record},cases:{'C1@1':{startedAt:'2026-01-01T00:00:00Z',aliases:{},assertions:{},observations:['sample'],errors:[]}}}));
 let restores=0;const plan={version:1,steps:['read A after the scenario'],prerequisites:[],checks:[{id:'amount',line:1,requirement:'amount 100',channel:'api',subject:{key:'A'},expected:100,type:'number',operator:'equals',basis:{quote:'amount 100'},measurement:{observationId:'sample',field:['body','amount'],identity:[{dimension:'key',field:['body','children',0,'key']}]}}]};
 const agent=createRequirementAgent({}, {workDir:root,review:async()=>({accepted:true,errors:[]}),agentModel:async({call})=>({close:async()=>{},async turn(){
  await assert.rejects(call('test_plan',{args:plan}),/identity/);
  const saved=JSON.parse(await readFile(path.join(root,'agent-tool-state.json'))).cases['C1@1'];assert.equal(saved.plan,undefined);assert.equal(saved.planAt,undefined);
  const corrected=structuredClone(plan);corrected.checks[0].measurement.identity[0].field=['body','key'];assert.equal((await call('test_plan',{args:corrected})).accepted,true);
  assert.equal(restores,0);await call('test_finish',{args:{actual:'Module candidate validation only',blocker:{dependency:'module fixture',required_action:'native verification',attempts:['candidate corrected before freeze']}}});return {text:'done'};
 }})});
 await agent.execute({item:{caseId:'C1'},headers:['预期结果'],row:['1. amount 100'],source:{},resourceNames:[],mutations:[],reports:root,checkOutput:v=>v,cleanupCase:async()=>{restores++;return {verified:true}}});
});
