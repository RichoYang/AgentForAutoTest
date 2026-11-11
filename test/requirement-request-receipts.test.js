import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createRequirementAgent } from '../src/runner/requirement-agent.js';
import { createAgentResources, readSource } from '../src/runner/requirement-agent-resources.js';
import { auditWindow, correlateRequestAudit, externalCleanupReceipt, runnerScopeHistory, verifyRunnerScope } from '../src/runner/requirement-agent-request-proof.js';
import { verifyExternalCleanupAfterJob } from '../src/runner/requirement-external-receipts.js';
import { digest } from '../src/runner/requirement-feishu.js';
import { requirementResources } from '../src/runner/requirement-resources.js';

async function server(t, handle) {
  const service = createServer(handle);
  await new Promise(resolve => service.listen(0, '127.0.0.1', resolve));
  t.after(() => {
    service.closeAllConnections();
    return new Promise(resolve => service.close(resolve));
  });
  return 'http://127.0.0.1:' + service.address().port;
}

test('real HTTP preserves wire parameter multiplicity and links reordered responses to their request IDs', async t => {
  const audited = [];
  let release;
  const order = new Promise(resolve => { release = resolve; });
  const url = await server(t, async (req, res) => {
    const request = new URL(req.url, 'http://127.0.0.1');
    const names = ['key', 'mode', 'value', 'absent'];
    const query = Object.fromEntries(names.map(name => [name, request.searchParams.getAll(name)]));
    const row = { id: randomUUID(), requestId: req.headers['x-agentos-request-id'], method: req.method,
      path: request.pathname, query, unrecordedQuery: 1, correlation: 'Run-A', at: new Date().toISOString() };
    audited.push(row);
    if (query.key[0] === 'A+B') await order;
    else release();
    res.end(JSON.stringify({ key: query.key[0], mode: query.mode[0] }));
  });
  const spec = { kind: 'http', resource: 'portal', path: '/quote?token=fixture-secret', access: 'read',
    query: { key: { $input: 'key' }, mode: { $input: 'mode' }, value: { $input: 'value' } },
    queryEvidence: ['key', 'mode', 'value', 'absent', 'token'], requestCorrelation: true };
  const trace = [];
  const runtime = createAgentResources({}, { state: { operations: { quote: spec } }, startRequest(request) {
    const item = { ...request, id: randomUUID(), phase: 'scenario', caseKey: 'C@1', epoch: 1 };
    trace.push(item);
    return Object.assign(result => Object.assign(item, result), { id: item.id });
  } });
  const resource = { resource_type: 'web_platform', base_url: url };
  const before = new Date().toISOString();
  const [first, second] = await Promise.all([
    runtime.performSpec(spec, { key: 'A+B', mode: 'summary', value: ['', null, 0, '9007199254740993'] }, resource),
    runtime.performSpec(spec, { key: 'B A', mode: 'history', value: '0' }, resource),
  ]);
  assert.equal(first.body.key, 'A+B');
  assert.equal(second.body.key, 'B A');
  assert.notEqual(first.requestId, second.requestId);
  assert.ok(!JSON.stringify([trace, first, second]).includes('fixture-secret'));
  const actual = trace.find(item => item.id === first.requestId);
  assert.deepEqual(actual.query.value, ['', 'null', '0', '9007199254740993']);
  assert.deepEqual(actual.queryInput.value, ['', null, 0, '9007199254740993']);
  assert.deepEqual(actual.query.absent, []);
  assert.equal(actual.operation, 'quote');
  const allowed = { resource: 'portal', transport: 'http', method: 'GET', path: '/quote',
    query: { key: ['A+B'], mode: ['summary'] }, queryInput: { value: ['', null, 0, '9007199254740993'] } };
  const check = { runnerScope: { phase: 'all', allowed: [allowed] } };
  assert.equal(verifyRunnerScope(check, [actual]).satisfied, true);
  assert.equal(verifyRunnerScope(check, [{ ...actual, query: undefined }]).satisfied, false);
  assert.equal(verifyRunnerScope({ runnerScope: { ...check.runnerScope, allowed: [{ ...allowed, exactQuery: true }] } }, [actual]).satisfied, false);
  const wrong = trace.find(item => item.id === second.requestId);
  const history = runnerScopeHistory({ requestTraceVersion: 3, requestTrace: [actual],
    restarts: [{ requestTraceVersion: 3, requestTrace: [wrong] }] });
  assert.deepEqual(verifyRunnerScope(check, history).violations, [wrong]);
  actual.observationIds = ['OBS-1'];
  const through = new Date().toISOString();
  const response = { status: 200, body: { source: 'fixture-audit', correlation: 'Run-A', from: before, through, complete: true, entries: audited } };
  const entries = auditWindow(response, { correlation: 'Run-A', from: before, through }, 'P1', 'fixture-audit',
    ['key', 'mode', 'value', 'absent']).entries.reverse();
  assert.deepEqual(correlateRequestAudit(trace, entries).find(item => item.requestId === actual.id).observationIds, ['OBS-1']);
  assert.throws(() => correlateRequestAudit(trace, entries.slice(1)), { code: 'request_proof_missing' });
  for (const invalid of [[entries[0], entries[0]], [{ ...entries[0], requestId: randomUUID() }, entries[1]],
    [{ ...entries[0], query: { ...entries[0].query, key: ['wrong'] } }, entries[1]]]) {
    assert.throws(() => correlateRequestAudit(trace, invalid), { code: 'request_proof_attribution' });
  }
  const masked = await runtime.performSpec(spec, { key: 'C', mode: 'summary', value: 'token=synthetic-masked' }, resource);
  const maskedRequest = trace.find(item => item.id === masked.requestId);
  assert.equal(Object.hasOwn(maskedRequest.query, 'value'), false);
  assert.equal(Object.hasOwn(maskedRequest.queryInput, 'value'), false);
  assert.equal(maskedRequest.unrecordedQuery, 2);
});

test('finished Job explicitly reads and appends a source-bound late receipt without replacing its report or re-fetching duplicates', async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'agentos-receipt-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const jobId = 'JOB-receipt-fixture', caseId = 'CASE-A';
  const attempt = 2, epoch = 1;
  const binding = { jobId, caseId, attempt, epoch };
  const contract = { operation: 'external_read', actor: 'maintainer', correlation: 'PARCEL-A', after: 'job_end' };
  const terminal = new Date(Date.now() - 1000).toISOString();
  const valid = { ...binding, source: 'warehouse-audit', actor: contract.actor, correlation: contract.correlation,
    completedAt: new Date().toISOString(), verified: true, receiptId: 'RETIRE-A' };
  let body = { ...valid, attempt: 1 };
  let requests = 0;
  const url = await server(t, (request, response) => {
    const query = new URL(request.url, 'http://127.0.0.1').searchParams;
    assert.equal(query.get('jobId'), jobId);
    assert.equal(query.get('correlation'), contract.correlation);
    requests++;
    response.end(JSON.stringify(body));
  });
  const iniPath = path.join(root, 'fixtures.ini');
  await writeFile(iniPath, '[Fixture.Sit.Portal]\nstatus=configured\nenvironment=SIT\nai_access=allowed\nai_operation_mode=read_only\nresource_type=web_platform\nbase_url=' + url);
  const environment = { name: 'SIT', platform: 'Fixture', iniPath, resources: { portal: { section: 'Fixture.Sit.Portal', scope: 'read' } } };
  const resources = await requirementResources(environment, { dataDir: root });
  const source = path.join(root, 'service.js');
  await writeFile(source, 'export const route = "/receipt";\n');
  const original = await readSource(root, { action: 'read', path: 'service.js' });
  const boundary = { resource: resources.identity('portal'), sourceRoot: root, identity: null };
  const spec = { kind: 'http', method: 'GET', path: '/receipt', resource: 'portal', access: 'read', authenticated: false,
    query: { jobId: { $input: 'jobId' }, correlation: { $input: 'correlation' } } };
  const state = { operations: { external_read: spec }, operationProofs: { external_read: { sourceRefs: ['s'], boundary } },
    sources: { s: original }, cases: { [caseId + '@' + attempt]: { epoch,
      plan: { processChecks: ['P1', 'P2'].map(id => ({ id, externalReceipt: contract })) },
      externalPreflights: Object.fromEntries(['P1', 'P2'].map(id => [id,
        { ...binding, evidence: { path: 'capability.json' }, source: valid.source, boundary: digest(boundary) }])),
    } } };
  const fileBytes = Buffer.from('module fixture report bytes');
  const sha = value => createHash('sha256').update(value).digest('hex');
  const artifact = { id: 'report-' + randomUUID(), filename: 'fixture.xlsx', kind: 'requirement-xlsx',
    bytes: fileBytes.length, complete: true, rowCount: 1, sha256: sha(fileBytes) };
  const proof = JSON.stringify({ version: 1, status: 'verified', file: artifact, coverage: { rowCount: 1 },
    kind: artifact.kind, schemaVersion: '1.0', sheetCount: 15, visualReviewHash: 'a'.repeat(64),
    previewHashes: Object.fromEntries(Array.from({ length: 15 }, (_, i) => [i, 'a'.repeat(64)])) });
  artifact.verificationHash = sha(proof);
  const exportDir = path.join(root, 'exports', jobId);
  const jobDir = path.join(root, 'requirement-tests', jobId);
  await mkdir(exportDir, { recursive: true });
  await mkdir(jobDir, { recursive: true });
  await writeFile(path.join(exportDir, artifact.filename), fileBytes);
  await writeFile(path.join(exportDir, artifact.id + '.verification.json'), proof);
  const job = { id: jobId, projectId: 'fixture', status: 'completed', events: [{ type: 'completed', at: terminal }],
    requirement: { url: 'https://fixture.invalid/docx/Receipt' }, result: { requirementReport: artifact } };
  const project = { repoPath: root, requirementTest: { environment, execution: { mode: 'agent' } } };
  const journal = { projectId: job.projectId, url: job.requirement.url, environment: 'SIT', artifact, cleanup: { verified: true },
    caseAttempts: { [caseId]: attempt }, results: { [caseId]: { status: '通过',
      externalPending: ['P1', 'P2'].map(checkId => ({ checkId, ...contract })) } } };
  const originalJournal = JSON.stringify(journal);
  await writeFile(path.join(jobDir, 'journal.json'), originalJournal);
  await writeFile(path.join(jobDir, 'agent-tool-state.json'), JSON.stringify(state));
  const collect = () => verifyExternalCleanupAfterJob(job, project, root);
  for (const wrong of [{ attempt: 1 }, { actor: 'wrong' }, { correlation: 'wrong' }, { source: 'wrong' }, { completedAt: '2000-01-01T00:00:00Z' }]) {
    body = { ...valid, ...wrong };
    assert.equal((await collect()).pending.length, 2);
  }
  body = valid;
  const success = await collect();
  assert.equal(success.receipts.length, 1);
  assert.deepEqual(success.receipts[0].record.checkIds, ['P1', 'P2']);
  assert.equal(success.receipts[0].record.receipt.receiptId, 'RETIRE-A');
  assert.equal(success.receipts[0].record.report.sha256, artifact.sha256);
  assert.equal(success.receipts[0].duplicate, false);
  assert.equal((await collect()).receipts[0].duplicate, true);
  assert.equal(requests, 6);
  assert.equal((await readdir(path.join(jobDir, 'external-receipts'))).length, 1);
  assert.deepEqual(await readFile(path.join(exportDir, artifact.filename)), fileBytes);
  assert.equal(await readFile(path.join(jobDir, 'journal.json'), 'utf8'), originalJournal);
  assert.throws(() => externalCleanupReceipt({ status: 200, body: { ...valid, completedAt: '2000-01-01T00:00:00Z' } },
    contract, { ...binding, mode: 'collect', after: terminal }, valid.source));
});

test('real Chromium links a business-ready page response to the server request and recorded business parameters', async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'agentos-browser-receipt-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const trace = [], received = [];
  const url = await server(t, (req, res) => {
    const request = new URL(req.url, 'http://127.0.0.1');
    if (request.pathname === '/quote') {
      received.push({ requestId: req.headers['x-agentos-request-id'], key: request.searchParams.getAll('key') });
      return res.end(JSON.stringify({ key: request.searchParams.get('key'), value: 0 }));
    }
    res.setHeader('content-type', 'text/html');
    res.end('<span id="busy">busy</span><span id="value"></span><script>fetch("/quote?key=A%2BB&view=current").then(r=>r.json()).then(x=>{document.querySelector("#value").textContent=x.value;document.querySelector("#busy").remove()})</script>');
  });
  const runtime = createAgentResources({}, {
    state: { operations: { quote: { kind: 'http', access: 'read', resource: 'portal', path: '/quote',
      queryEvidence: ['key', 'view'], requestCorrelation: true } } },
    item: { caseId: 'C-browser' }, reports: root,
    useRead: (_, call) => call({ base_url: url }),
    startRequest(request) {
      const row = { ...request, id: randomUUID() };
      trace.push(row);
      return Object.assign(result => Object.assign(row, result), { id: row.id });
    },
  });
  t.after(() => runtime.close());
  const navigation = await runtime.browser({ resource: 'portal', action: 'goto', path: '/' });
  const observed = await runtime.browser({ resource: 'portal', action: 'observe',
    ready: { selector: '#busy', state: 'hidden' }, fields: { value: { selector: '#value', read: 'text' } } });
  const network = [...navigation.network, ...observed.network];
  assert.deepEqual(observed.values.value, ['0']);
  assert.equal(received.length, 1);
  const request = trace.find(row => row.path === '/quote');
  assert.deepEqual(request.query, { key: ['A+B'], view: ['current'] });
  assert.equal(network.find(row => row.path === '/quote').requestId, request.id);
  assert.equal(received[0].requestId, request.id);
});

test('two attributed process proofs retain each other when only their registered audit reads are sent', async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'agentos-two-proofs-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(path.join(root, 'service.js'), 'Fixture GET /item returns value 0; GET /audit returns actual scoped request receipts.');
  const run = 'AOS_TWO_PROOFS', query = { key: ['A'], run: [run] };
  const receipts = [];
  const url = await server(t, (request, response) => {
    const target = new URL(request.url, 'http://127.0.0.1');
    if (target.pathname === '/item') {
      receipts.push({ id: randomUUID(), at: new Date().toISOString(), method: request.method, path: target.pathname,
        requestId: request.headers['x-agentos-request-id'], correlation: target.searchParams.get('run'),
        query: { key: target.searchParams.getAll('key'), run: target.searchParams.getAll('run') }, unrecordedQuery: 0 });
      return response.end(JSON.stringify({ key: 'A', value: 0 }));
    }
    const { correlation, from, through } = Object.fromEntries(target.searchParams);
    const entries = receipts.filter(item => item.correlation === correlation && item.at >= from && item.at <= through);
    response.end(JSON.stringify({ source: 'fixture audit', correlation, from, through, complete: true, entries }));
  });
  const original = '1. Value equals 0\n2. One actual GET uses the registered query\n3. Service receipt matches the response observation';
  const processChecks = ['One actual GET uses the registered query', 'Service receipt matches the response observation'].map((requirement, i) => ({
    id: `P${i + 1}`, line: i + 2, kind: 'execution_evidence', requirement, relatedCheckIds: ['C1'],
    requestProof: { scope: 'service', phase: 'scenario', resource: 'portal',
      requests: [{ method: 'GET', path: '/item', count: 1, query }], audit: { operation: 'read_audit', correlation: run, matchRunner: true } },
  }));
  const agent = createRequirementAgent({}, { workDir: root, review: async () => ({ accepted: true, errors: [] }),
    agentModel: async ({ call }) => ({ close: async () => {}, async turn() {
      const invoke = (name, args) => call('test_' + name, { args });
      const source = await invoke('source', { action: 'read', path: 'service.js' });
      const register = (name, route, fields, correlation) => invoke('register', { name, sourceRefs: [source.sourceRef],
        reason: 'Read from fixture contract', spec: { kind: 'http', method: 'GET', path: route, resource: 'portal', access: 'read',
          authenticated: false, query: Object.fromEntries(fields.map(key => [key, { $input: key }])),
          ...(correlation ? { queryEvidence: fields, requestCorrelation: true } : {}) } });
      await register('uncorrelated_item', '/item', ['key', 'run'], false);
      await register('read_item', '/item', ['key', 'run'], true);
      await register('read_audit', '/audit', ['mode', 'correlation', 'from', 'through'], true);
      for (const check of processChecks) await invoke('plan', { action: 'process_preflight', check });
      await invoke('plan', { version: 1, steps: ['Read and prove the isolated value'], prerequisites: [], processChecks,
        checks: [{ id: 'C1', line: 1, requirement: 'Value equals 0', expected: 0, type: 'number', operator: 'equals',
          channel: 'api', basis: { quote: 'Value equals 0' } }] });
      await assert.rejects(invoke('observe', { operation: 'uncorrelated_item', input: { key: 'A', run } }),
        { code: 'request_correlation_required' });
      assert.equal(receipts.length, 0);
      const actual = await invoke('observe', { operation: 'read_item', input: { key: 'A', run } });
      await invoke('assert', { checkId: 'C1', observationId: actual.observationId, field: ['body', 'value'] });
      for (const check of processChecks) await invoke('process', { checkId: check.id, evidenceRefs: [] });
      const state = JSON.parse(await readFile(path.join(root, 'agent-tool-state.json'))).cases['CASE-A@1'];
      assert.equal(state.processProofs.P1.proven, true, 'Audit read for P2 must not invalidate P1');
      assert.equal(state.processProofs.P2.proven, true);
      await invoke('finish', { actual: 'Value and two related process proofs are complete' });
      return { text: 'done' };
    } }),
  });
  const result = await agent.execute({ jobId: 'JOB-two-proofs', item: { caseId: 'CASE-A' }, reports: root,
    row: [original], headers: ['预期结果'], source: {}, sourceRoot: root, runPrefix: 'AOS_', resourceNames: ['portal'],
    mutations: [], checkOutput: value => value, useRead: (_, read) => read({ base_url: url }) });
  assert.equal(result.status, '通过');
  assert.equal(result.checkCoverage.processProven, 2);
  assert.equal(receipts.length, 1);
});
