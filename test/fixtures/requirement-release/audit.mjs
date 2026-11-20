import assert from 'node:assert/strict';
import path from 'node:path';
import {readFile,writeFile} from 'node:fs/promises';
import {execFileSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {digest} from '../../../src/runner/requirement-feishu.js';
import {reportFile} from '../../../src/shared/report-files.js';
import {verifyRunnerScope,runnerScopeHistory} from '../../../src/runner/requirement-agent-request-proof.js';
import {fixtureTables} from './db-fixture-delivery6.mjs';
const read=async name=>JSON.parse((await readFile(name,'utf8')).replace(/^\uFEFF/,''));
const evidence=process.env.AGENTOS_RELEASE_FIXTURE_DIR;
assert.ok(evidence&&path.isAbsolute(evidence),'Set an absolute isolated evidence directory');
const root=path.resolve(evidence,process.argv[2]);
assert.equal(path.dirname(root),path.normalize(evidence));
const fixture=await read(path.join(root,'fixture-receipt.json'));
const execution=await read(path.join(root,'first-result.json'));
const run=await read(path.join(root,'fixture-summary.json'));
const data=path.join(root,'data');
const job=path.join(data,'requirement-tests',fixture.jobId);
const journal=await read(path.join(job,'journal.json'));
const state=await read(path.join(job,'agent-tool-state.json'));
const sha=bytes=>createHash('sha256').update(bytes).digest('hex');
assert.equal(fixture.engine,(await read(path.join(evidence,'../artifact.json'))).sourceSha256);
assert.equal(fixture.injectedPlansOrVerdicts,0);
const originals=await readFile(path.join(import.meta.dirname,fixture.mode+'.json'));
const {headers,rows}=JSON.parse(originals);
assert.deepEqual(fixture.originalCases,{sha256:sha(originals),rows:rows.length,version:digest([headers,...rows])});
assert.equal(journal.publication.external,true);
assert.equal(journal.publication.version,fixture.originalCases.version);
assert.equal(Object.keys(journal.results).length,rows.length);
assert.equal(run.pending,0);
assert.equal(journal.mutations?.length??0,0);
assert.equal(journal.cleanup?.verified,true);
const [primary,secondary]=fixtureTables(fixture.mode);
function verifyDatabaseRead(request) {
  const target=request.resource==='mysql'?primary:request.resource==='secondary'?secondary:null;
  assert.ok(target, 'Unexpected database resource: '+request.resource);
  const detail=request.databaseCall;
  assert.ok([target[0],...(target===primary?[null]:[])].includes(detail.database));
  assert.ok(['identity','schema'].includes(detail.action));
  assert.ok(Array.isArray(request.statementReceipts));
  if(detail.action==='schema'){
    assert.equal(detail.database,target[0]);
    assert.equal(detail.table,target[1]);
  }
  const quoted='`'+target[1]+'`';
  const allowed=detail.action==='identity'?['SELECT 1 AS ready, CURRENT_USER() AS principal, DATABASE() AS databaseName']
    :['SELECT DATABASE() AS databaseName, CURRENT_USER() AS principal','SHOW FULL COLUMNS FROM '+quoted,
      'SHOW INDEX FROM '+quoted,'SHOW CREATE TABLE '+quoted];
  for(const row of request.statementReceipts){
    assert.equal(row.method,'query');
    assert.ok(allowed.includes(row.statement),'Unexpected database statement receipt');
    assert.notEqual(row.outcome,'pending');
  }
}
const cases=Object.entries(state.cases).map(([key,value])=>{
  const requests=runnerScopeHistory(value);
  assert.ok(requests, 'missing trace for '+key);
  assert.equal(value.model?.model, process.env.AGENTOS_CODEX_MODEL);
  assert.equal(value.model?.reasoningEffort, process.env.AGENTOS_CODEX_REASONING_EFFORT);
  assert.ok(requests.every(request=>request.transport==='database'));
  for(const request of requests)verifyDatabaseRead(request);
  const actualScopes=(value.plan?.processChecks ?? []).filter(check=>check.runnerScope).map(check=>({
    id:check.id, structured:check.runnerScope.allowed.every(route=>route.databaseCall),
    proven:value.processProofs?.[check.id]?.proven===true, satisfied:verifyRunnerScope(check,requests).satisfied,
  }));
  return {key,model:value.model,requests:requests.length,diagnostics:value.errors?.length??0,restarts:value.restarts?.length??0,
    statementAttempts:requests.reduce((count,request)=>count+request.statementReceipts.length,0),
    coverage:journal.results[key.split('@')[0]]?.checkCoverage,actualScopes};
});
const summary=execution.result.requirementSummary;
const artifact=execution.result.requirementReport??journal.artifact;
let report=null;
const processDiagnostics=new Map();
if(artifact?.complete) {
  const local=await reportFile(data,fixture.jobId,artifact);
  const receipt=await read(path.join(path.dirname(local.file),artifact.id+'.verification.json'));
  const input=path.join(job,'normalized-report.json');
  assert.equal(receipt.manifestHash,digest(await read(input)));
  assert.equal(receipt.sheetCount,15);
  assert.equal(journal.visualReview.count,15);
  const reopened=JSON.parse(execFileSync(process.execPath,['src/runner/requirement-report-worker.js','verify',
    'D:/Develop/CodeXSkill/run-full-requirement-regression/scripts/build-full-regression-report.mjs',local.file,input],
  {encoding:'utf8',windowsHide:true}));
  assert.equal(reopened.workbookReadbackSha256,artifact.sha256);
  assert.deepEqual(reopened.workbookCounts,receipt.workbookCounts);
  report={file:local.file,sha256:artifact.sha256,sheets:15,counts:receipt.workbookCounts};
  const delivery=await read(path.join(root,'delivery-proof.json'));
  const persisted=await read(path.join(data,'agentos.json'));
  const persistedJob=persisted.jobs.find(item=>item.id===fixture.jobId);
  const deliveryReceipt=persistedJob?.requirementDeliveryReceipt;
  assert.equal(deliveryReceipt?.verified,true);
  assert.equal(deliveryReceipt.messages.length,3);
  assert.equal(new Set(deliveryReceipt.messages.map(message=>message.messageId)).size,3);
  assert.deepEqual(deliveryReceipt.messages.slice(1).map(message=>message.sha256),[artifact.sha256,delivery.bundle.sha256]);
  assert.deepEqual(deliveryReceipt,Object.values(persisted.requirementDeliveries).find(item=>item.jobId===fixture.jobId)?.receipt);
  await writeFile(path.join(root,'delivery-receipt-readback.json'),JSON.stringify({jobId:fixture.jobId,simulatedTransport:true,
    sourceSha256:fixture.engine,receipt:deliveryReceipt},null,2)+'\n',{flag:'wx'});
  const packed=new Map(delivery.bundle.files.map(file=>[file.name,file.sha256]));
  for(const row of Object.values(journal.results)){
    for(const check of Object.values(row.processChecks??{})){
      const ref=check.evidence;
      if(ref?.type!=='process-review')continue;
      assert.equal(ref.sanitized,true);
      assert.equal(ref.path,path.basename(ref.path));
      assert.match(ref.path,/^agent-[a-f0-9]+\.json$/i);
      const bytes=await readFile(path.join(job,'diagnostics',ref.path));
      const sha256=sha(bytes);
      assert.equal(JSON.parse(bytes).jobId,fixture.jobId);
      if(ref.sha256!==undefined)assert.equal(sha256,ref.sha256);
      assert.equal(packed.get(ref.path),sha256);
      processDiagnostics.set(ref.path,sha256);
    }
  }
}
const record={id:fixture.jobId,mode:fixture.mode,sourceSha256:fixture.engine,fixtureCommit:fixture.configCommit,transport:fixture.transport,
  model:fixture.model,summary,cases,report,originalCases:fixture.originalCases,processDiagnostics:[...processDiagnostics].map(([name,sha256])=>({name,sha256})),
  pending:run.pending,cleanup:journal.cleanup?.verified??false,
  jobStatus:run.finalStatus,outcome:execution.result.outcome,wait:execution.result.requirementWait??null,
  results:Object.entries(journal.results).map(([caseId,row])=>({caseId,status:row.status,blocker:row.blocker?.dependency,coverage:row.checkCoverage})),
  connectionEvidence:Object.values(state.observations).filter(row=>row.data.databaseEvidence?.selection).map(row=>({id:row.observationId,
    database:row.data.databaseEvidence.database,selection:row.data.databaseEvidence.selection,requestIds:row.requestIds})),
  runtimeEvidence:Object.values(state.observations).filter(row=>row.data.primaryKey?.complete).map(row=>({
    id:row.observationId,caseId:row.caseKey.split('@')[0],at:row.at,database:row.data.database,table:row.data.table,primaryKey:row.data.primaryKey,requests:row.requestIds,
    selection:row.data.databaseEvidence?.selection,databaseArgument:row.data.databaseEvidence?.databaseArgument,
    boundDatabase:row.data.databaseEvidence?.boundDatabase,
  }))};
await writeFile(path.join(root,'audited-result.json'),JSON.stringify(record,null,2)+'\n',{flag:'wx'});
console.log(JSON.stringify({id:record.id,summary,cases:cases.map(c=>({checks:c.coverage?.compared,scopes:c.actualScopes,errors:c.diagnostics})),report}));
