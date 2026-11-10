import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createRequirementAgent } from '../src/runner/requirement-agent.js';
import { createAgentResources } from '../src/runner/requirement-agent-resources.js';
import { assertionBinding, pageMethodSample, pageStageContext, verifyObservationIdentity, verifyPageMethodShape } from '../src/runner/requirement-agent-assertion-binding.js';
import { validateToolArguments } from '../src/runner/requirement-agent-contracts.js';
import { externalCleanupReceipt, runnerScopeHistory, verifyRunnerScope } from '../src/runner/requirement-agent-request-proof.js';
import { recordGap, resolveGaps } from '../src/runner/requirement-agent-progress.js';

async function fixture(t, handler) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'aos-execution-contract-'));
  const server = createServer(handler);
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => {
    await new Promise(resolve => server.close(resolve));
    await rm(root, { recursive: true, force: true });
  });
  return { root, resource: { base_url: 'http://127.0.0.1:' + server.address().port, resource_type: 'web_platform' } };
}

test('real browser selects an exact visible record across order, duplicate titles and async switching', async t => {
  const { root, resource } = await fixture(t, (req, res) => {
    const mode = new URL(req.url, 'http://127.0.0.1').searchParams.get('mode');
    const rows = [['X-A', 'Same | title'], ['A', 'Same | title'], ['Z', 'Other']];
    if (mode === 'reverse') rows.reverse();
    if (mode === 'duplicate') rows.push(['A', 'Wrong row']);
    if (mode === 'empty') rows.length = 0;
    if (mode === 'single') rows.splice(0, rows.length, ['A', 'Same | title']);
    if (mode === 'api') return res.end(JSON.stringify({ key: 'A', title: 'API substitute' }));
    const data = JSON.stringify(rows);
    res.setHeader('content-type', 'text/html');
    res.end('<div id="busy">Loading</div><main></main><script>setTimeout(()=>{const data='+data
      + ';document.querySelector("main").innerHTML='
      + (mode === 'json' ? '"<pre id=keys>"+JSON.stringify(data.map(r=>r[0]))+"</pre><pre id=titles>"+JSON.stringify(data.map(r=>r[1]))+"</pre>"'
        : mode === 'aggregate' ? '"<pre id=keys>"+data.map(r=>r[0]).join(" | ")+"</pre><pre id=titles>"+data.map(r=>r[1]).join(" | ")+"</pre>"'
          : 'data.map(([key,title])=>"<div class=row><span class=key>"+key+"</span><span class=title>"+title+"</span></div>").join("")')
      + ';document.querySelector("#busy").remove();},50)</script>');
  });
  const runtime = createAgentResources({}, { state: { operations: {} }, reports: root, item: { caseId: 'C' }, attempt: 1, useRead: (_, fn) => fn(resource) });
  t.after(() => runtime.close());
  const ready = { selector: '#busy', state: 'hidden' };
  const query = (mode, layout = 'rows') => ({
    resource: 'api', action: 'observe', ready, record: { name: 'selected', layout,
      ...(layout === 'rows' ? { rows: '.row' } : {}), match: { key: 'A' },
      fields: { key: { read: 'text', selector: layout === 'rows' ? '.key' : '#keys' },
        title: { read: 'text', selector: layout === 'rows' ? '.title' : '#titles' } } },
  });
  const navigate = mode => runtime.browser({ resource: 'api', action: 'goto', path: '/?mode=' + mode });
  const check = { id: 'title', channel: 'page', subject: { key: 'A' } };
  const identity = [{ dimension: 'key', field: ['values', 'selected', 'key'] }];
  for (const [mode, layout] of [['initial','rows'], ['reverse','rows'], ['json','json_parallel'], ['single','rows']]) {
    await navigate(mode);
    const data = await runtime.browser(query(mode, layout));
    assert.deepEqual(data.values.selected, { key: 'A', title: 'Same | title' });
    assert.ok(data.screenshot && data.ready.at >= data.lifecycle.pageAction.startedAt);
    assert.equal((await fetch(resource.base_url + '/?mode=api').then(res => res.json())).title, 'API substitute');
    assert.doesNotThrow(() => assertionBinding(check, { data }, { field: ['values','selected','title'], identity }, {}));
    assert.throws(() => assertionBinding(check, { data }, { field: ['values','selected','title'], identity: [] }, {}), /same matched DOM record/);
  }
  await navigate('initial');
  const sampleInput = query('initial');
  sampleInput.record.match.key = 'X-A';
  const sample = { input: sampleInput, data: await runtime.browser(sampleInput) };
  const stage = { resource: 'api', action: 'goto', path: '/?mode=initial', ready };
  const selection = { field: ['values','selected','title'], identity, sampleSubject: { key: 'X-A' } };
  const sampleCheck = pageMethodSample(check, sample, selection, stage);
  assert.equal(verifyObservationIdentity(sampleCheck, sample, selection)[0].value, 'X-A');
  assert.throws(() => verifyObservationIdentity(check, sample, selection), /Observation identity differs/);
  assert.throws(() => pageMethodSample({ ...check, beforeAction: {} }, sample, selection, stage), /cannot certify a baseline/);
  assert.throws(() => pageMethodSample(check, sample, selection, { ...stage, path: '/?mode=reverse' }), /declared page stage/);
  const actual = { data: await runtime.browser(query('initial')) };
  const method = { field: selection.field, keyField: sampleCheck.sampleKeyField };
  assert.doesNotThrow(() => verifyPageMethodShape(sample, method, actual, selection));
  assert.throws(() => verifyPageMethodShape(sample, method, actual, { field: ['values','selected','key'] }), /preflighted record/);
  assert.throws(() => validateToolArguments('assert',{ checkId: 'title', observationId: 'actual', ...selection }), /sampleSubject/);
  await navigate('duplicate');
  await assert.rejects(runtime.browser(query('duplicate')), /multiple visible rows/);
  await navigate('aggregate');
  await assert.rejects(runtime.browser(query('aggregate','json_parallel')), /JSON arrays/);
  assert.equal((await runtime.browser(query('aggregate','parallel'))).values.selected, null);
  await navigate('empty');
  const empty = await runtime.browser(query('empty'));
  assert.equal(empty.values.selected, null);
  assert.equal(empty.domRecords.selected.rows.length, 0);
  await runtime.close();
});

test('an executable repair freezes a process baseline and preserves an external pending verdict', async t => {
  const key = 'AOS_STAGE_TEST';
  let writes = 0;
  const { root, resource } = await fixture(t, (req, res) => {
    if (req.method === 'POST') writes++;
    res.end(JSON.stringify({ key: writes ? key : null, count: writes, complete: true }));
  });
  await writeFile(path.join(root, 'service.js'), 'Fixture: GET /read counts all test keys; POST /write creates one key, DELETE /write restores.');
  const baseline = { id: 'range', line: 2, requirement: 'Freeze the prepared range before create', kind: 'execution_evidence',
    beforeAction: { operation: 'create_one' }, baselineChannel: 'api' };
  const external = { id: 'owner', line: 3, requirement: 'External owner collects an independent fixture after Job end', kind: 'external_cleanup',
    externalReceipt: { actor: 'fixture owner', correlation: 'external-fixture-A', after: 'job_end' } };
  const business = { id: 'count', line: 1, requirement: 'Count is 1', channel: 'api', expected: 1, type: 'number',
    operator: 'equals', basis: { quote: 'Count is 1' } };
  const agent = createRequirementAgent({}, { workDir: root, review: async prompt => {
    const payload = JSON.parse(prompt.slice(prompt.lastIndexOf('\n\n') + 2));
    if (payload.kind === 'plan') {
      assert.ok(payload.toolContracts.plan.anyOf.at(-1).properties.processChecks.items.properties.beforeAction);
      assert.deepEqual(payload.registeredReadOperations.map(({ name, method, path }) => ({ name, method, path })), [
        { name: 'read_one', method: 'GET', path: '/read' },
      ]);
      if (!payload.plan.processChecks.some(check => check.beforeAction)) return {
        accepted: false, errors: ['Need baseline'], findings: [{ field: 'baselines', code: 'missing', reason: 'Prepared range', next: 'Add baselines' }],
      };
    }
    if (payload.kind === 'mutation') {
      const [proof] = payload.preActionEvidence.process;
      assert.equal(proof.check.id, 'range');
      assert.deepEqual(proof.observations[0].fields, [
        { field: ['body','complete'], value: true }, { field: ['body','count'], value: 0 },
      ]);
      assert.equal(proof.observations[0].lifecycle.role, 'independent_read');
    }
    return { accepted: true, errors: [] };
  }, agentModel: async ({ call }) => ({ close: async () => {}, async turn() {
    const run = (tool,args) => call('test_' + tool, { args });
    const source = await run('source',{ action:'read', path:'service.js' });
    for (const [name, access, method, url] of [['read_one','read','GET','/read'], ['create_one','create','POST','/write'], ['remove_one','delete','DELETE','/write']]) {
      await run('register',{ name, sourceRefs:[source.sourceRef], reason:'Actual fixture route',
        spec:{ resource:'api', kind:'http', access, method, path:url, authenticated:false } });
    }
    const observe = () => run('observe',{ operation:'read_one' });
    const beforeFreeze = await observe();
    const { beforeAction, baselineChannel, ...unbound } = baseline;
    const candidate = { version:1, steps:['Measure prepared range then create'], prerequisites:[], checks:[business], processChecks:[unbound,external] };
    await assert.rejects(run('plan',{...candidate,processChecks:[{...baseline,beforeAction:{operation:'read_one'}},external]}), /registered write in beforeAction/);
    await assert.rejects(run('plan',candidate), error => error.review.findings[0].next.includes('processChecks[].beforeAction'));
    assert.deepEqual((await run('plan',{ action:'inspect' })).candidate,candidate);
    assert.equal((await run('plan',{ action:'repair', replace:{processChecks:[baseline,external]} })).accepted,true);
    await run('measure',{checkId:'count',observationId:beforeFreeze.observationId,field:['body','count']});
    const mutate = () => run('mutate',{ id:'m', purpose:'scenario', operation:'create_one', businessKey:key,
      ownership:{ field:['body','key'],value:key },
      verify:{ operation:'read_one',before:[{field:['body','count'],operator:'equals',expected:0}],
        after:[{field:['body','count'],operator:'equals',expected:1}] },
      restore:{operation:'remove_one'}, cleanupAction:'Remove test object' });
    const process = observationId => run('process',{ checkId:'range',evidenceRefs:[{observationId,fields:[['body','complete'],['body','count']]}] });
    await assert.rejects(process(beforeFreeze.observationId),/independent, frozen/);
    await assert.rejects(mutate(),{code:'action_baseline_missing'});
    assert.equal(writes,0);
    assert.equal((await process((await observe()).observationId)).proven,true);
    await mutate();
    await run('assert',{checkId:'count',observationId:(await observe()).observationId,field:['body','count']});
    assert.equal((await run('process',{checkId:'owner',evidenceRefs:[]})).deferred,true);
    await run('finish',{actual:'Independent business comparison passed. The external receipt is pending.'});
    return { text:'done' };
  } }) });
  const result = await agent.execute({ item:{caseId:'C1'}, reports:root, headers:['预期结果'],
    row:['1. Count is 1\n2. Freeze the prepared range before create\n3. External owner collects an independent fixture after Job end'],
    source:{}, sourceRoot:root, runPrefix:'AOS_', resourceNames:['api'], checkOutput:value=>value, mutations:[],
    useRead:(_,fn)=>fn(resource), invoke:(_intent,apply)=>apply(resource) });
  assert.equal(result.status,'通过');
  assert.equal(result.checkCoverage.compared,1);
  assert.equal(result.checkCoverage.processProven,1);
  assert.deepEqual(result.externalPending,[{checkId:'owner',...external.externalReceipt}]);
  const state = JSON.parse(await readFile(path.join(root,'agent-tool-state.json')));
  assert.ok(state.cases['C1@1'].actionBoundaries['1:m'].processProof.range);
});

test('runner scope checks unlisted API and database attempts and external receipts stay actor and time bound', () => {
  const get = { resource: 'api', transport: 'http', method: 'GET', path: '/order', phase: 'scenario', outcome: 'response' };
  const db = { resource: 'db', transport: 'database', method: 'CONNECT', path: '/', phase: 'prepare', outcome: 'response' };
  const scope = { runnerScope: { phase: 'all', allowed: [get] } };
  assert.equal(verifyRunnerScope(scope, [get]).satisfied, true);
  assert.deepEqual(verifyRunnerScope(scope, [get,db]).violations,[db]);
  assert.equal(verifyRunnerScope(scope,[get,{...get,method:'POST'}]).satisfied,false);
  assert.equal(verifyRunnerScope({runnerScope:{...scope.runnerScope,phase:'scenario'}},[get,db]).satisfied,true);
  assert.throws(()=>verifyRunnerScope(scope,[{...get,outcome:'pending'}]),/unresolved/);
  const restarted = { requestTraceVersion: 2, requestTrace: [get], restarts: [{ requestTraceVersion: 2, requestTrace: [db] }] };
  assert.deepEqual(verifyRunnerScope(scope,runnerScopeHistory(restarted)).violations,[db]);
  assert.equal(runnerScopeHistory({...restarted,restarts:[{requestTraceVersion:1,requestTrace:[]}]}),null);
  const contract = { actor:'owner',correlation:'A' }, after = new Date(Date.now()-1000).toISOString();
  const body = { source:'external audit',...contract,available:true,verified:true,completedAt:new Date().toISOString() };
  assert.equal(externalCleanupReceipt({status:200,body},contract,{mode:'capability'}).available,true);
  assert.equal(externalCleanupReceipt({status:200,body},contract,{mode:'collect',after},body.source).verified,true);
  for (const wrong of [{ actor:'runner' },{ correlation:'B' },{ completedAt:new Date(Date.now()-2000).toISOString() }]) {
    assert.throws(()=>externalCleanupReceipt({status:200,body:{...body,...wrong}},contract,{mode:'collect',after},body.source),/External cleanup/);
  }
});

test('readiness stages require actual declared waits and inspection does not erase recurring baseline gaps', () => {
  const ready = { selector:'#busy',state:'hidden' };
  const stage = { id:'S',step:1,resource:'api',action:'goto',path:'/page',subject:{key:'A'},ready };
  const check = { id:'C',pageStage:'S',measurement:{identity:[{dimension:'key',field:['values','key']}]} };
  validateToolArguments('plan',{action:'repair',replace:{pageStages:[stage]}});
  const record = { observationId:'O',channel:'page',input:{resource:'api',action:'observe'},data:{screenshot:{},
    values:{key:'A'},ready:{at:'2026-01-01T00:00:02Z',condition:{selector:'#wrong',state:'hidden'}},
    lifecycle:{pageAction:{id:'action',action:'goto',path:'/page',startedAt:'2026-01-01T00:00:01Z'}}} };
  const current = { observations:['O'],planAt:'2026-01-01T00:00:00Z',planCandidate:{processChecks:[{id:'P2',beforeAction:{operation:'write'}}]} };
  const plan = { pageStages:[stage],checks:[check] };
  assert.equal(pageStageContext(plan,check,current,{O:record},{observationId:'O'}).valid,false);
  record.data.ready.condition=ready;
  assert.equal(pageStageContext(plan,check,current,{O:record},{observationId:'O'}).valid,true);
  const reject = (field,code) => recordGap(current,{tool:'test_plan',args:{},evidenceVersion:'same',
    error:{review:{findings:[{field,code,reason:'Prepare baseline',next:'Fix'}]}}});
  const first=reject('baselines','baseline_missing');
  resolveGaps(current,'test_plan',{action:'inspect'});
  assert.equal(first.resolved,false);
  const second=reject('plan.processChecks[P2].beforeAction','timing_gap');
  assert.equal(second.id,first.id);
  assert.equal(second.attempts,2);
});
