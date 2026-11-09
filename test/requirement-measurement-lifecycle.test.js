import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createRequirementAgent } from '../src/runner/requirement-agent.js';
import { createServer } from 'node:http';

// Module regression only: reviews and model tool choices are controlled here.
// Native model acceptance is recorded separately by verify-requirement-chain.
test('original baseline can receive completeness evidence; post-action replacement requires verified recovery and a new epoch', async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'aos-measurement-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const before = { observationId: 'original', caseKey: 'C1@1', at: '2026-01-01T00:00:01Z', channel: 'database',
    input: { resource: 'db', database: 'd', sql: 'SELECT tenant, hash, count, complete FROM evidence WHERE tenant=?', params: ['A'] },
    data: { rows: [{ tenant: 'A', hash: 'frozen', count: 2, complete: true }] } };
  const after = { ...before, observationId: 'later', at: '2026-01-01T00:00:05Z' };
  const plan = { version: 1, steps: ['Independent invariant'], prerequisites: [], checks: [{ id: 'invariant', line: 1,
    requirement: 'records unchanged', subject: { tenant: 'A' }, channel: 'database', type: 'text', operator: 'equals', expected: 'frozen',
    basis: { observationId: 'original', field: ['rows', 0, 'hash'], explanation: 'independent original collection' } }] };
  await writeFile(path.join(root, 'agent-tool-state.json'), JSON.stringify({ operations: {}, sources: {}, schemas: {}, observations: { original: before, later: after },
    cases: { 'C1@1': { startedAt: '2026-01-01T00:00:00Z', planAt: '2026-01-01T00:00:02Z', scenarioStartedAt: '2026-01-01T00:00:03Z',
      plan, aliases: {}, assertions: {}, observations: ['original', 'later'], errors: [] } } }));
  let cleanup = 0, reviewed;
  const agent = createRequirementAgent({}, { workDir: root, review: async prompt => { reviewed = prompt; return { accepted: true, errors: [] }; },
    agentModel: async ({ call }) => ({ close: async () => {}, async turn() {
      const invoke = (name, args) => call('test_' + name, { args });
      const selection = { checkId: 'invariant', observationId: 'original', field: ['rows', 0, 'hash'], identity: [{ dimension: 'tenant', field: ['rows', 0, 'tenant'] }],
        evidenceRefs: [{ observationId: 'original', fields: [['rows', 0, 'count'], ['rows', 0, 'complete']] }],
        constraints: [{ observationId: 'original', field: ['rows', 0, 'complete'], operator: 'equals', expected: true }] };
      assert.equal((await invoke('measure', selection)).proven, true);
      assert.match(reviewed, /"value":2/); assert.match(reviewed, /2026-01-01T00:00:01Z/);
      const reviewPayload = JSON.parse(reviewed.slice(reviewed.lastIndexOf('\n\n') + 2));
      assert.equal(reviewPayload.stage, 'preflight');
      assert.equal(reviewPayload.baseline.observationId, 'original');
      assert.equal(reviewPayload.baseline.lifecycle.scenarioStartedAt, '2026-01-01T00:00:03Z');
      assert.equal(reviewPayload.baseline.lifecycle.collectedBeforeScenario, true);
      const receipt = await invoke('evidence', { evidenceRef: (await invoke('measure', selection)).evidence.path });
      assert.equal(receipt.kind, 'audit'); assert.equal(receipt.usableForCurrentAssertion, false);
      assert.equal(receipt.data.checkId, 'invariant');
      await assert.rejects(invoke('evidence', { evidenceRef: '../outside.json' }), /not a saved observation/);
      await assert.rejects(invoke('alias', { alias: 'audit', observationId: receipt.evidenceRef,
        field: ['checkId'], value: 'invariant', purpose: 'Audit must not become a business observation' }), /measurement epoch/);
      await assert.rejects(invoke('measure', { ...selection, observationId: 'later' }), /Post-action/);
      await assert.rejects(invoke('measure', { ...selection, evidenceRefs: [{ observationId: 'later', fields: [['rows', 0, 'count']] }] }), /later queries/);
      await assert.rejects(invoke('plan', { ...plan, checks: [{ ...plan.checks[0], expected: 'new value' }] }), /Frozen expectations/);
      await assert.rejects(invoke('measure', { action: 'restart', reason: 'Cannot prove original collection scope' }), { code: 'cleanup_pending' });
      const restarted = await invoke('measure', { action: 'restart', reason: 'Cannot prove original collection scope' });
      assert.equal(restarted.epoch, 1);
      const history = await invoke('evidence', { observationId: 'original' });
      assert.equal(history.historical, true); assert.equal(history.usableForCurrentAssertion, false);
      await assert.rejects(invoke('alias', { alias: 'old', observationId: 'original', field: ['rows', 0, 'tenant'], value: 'A', purpose: 'test' }), /measurement epoch/);
      await invoke('finish', { actual: 'Recovery proved; isolated regression stops before preparing the new scenario.', blocker: {
        dependency: 'module regression', required_action: 'native acceptance covers actual new execution', attempts: ['restoration readback'] } });
      return { text: 'done' };
    } }) });
  await agent.execute({ item: { caseId: 'C1' }, reports: root, headers: ['预期结果'], row: ['1. records unchanged'],
    source: {}, resourceNames: ['db'], mutations: [], checkOutput: value => value, cleanupCase: async () => ({ verified: ++cleanup > 1, evidence: [] }) });
  const saved = JSON.parse(await readFile(path.join(root, 'agent-tool-state.json'))).cases['C1@1'];
  assert.equal(saved.restarts.length, 1); assert.deepEqual(saved.restarts[0].plan, plan);
  assert.equal(saved.restarts[0].preflights.invariant.completeness[0].actual, true);
  assert.equal(saved.plan, undefined); assert.equal(cleanup, 2);
});

test('correcting an unmeasured identity invalidates its preflight without changing the frozen expectation', async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'aos-identity-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const observation = { observationId: 'current', caseKey: 'C1@1', channel: 'api', at: new Date().toISOString(),
    data: { status: 200, body: [{ key: 'A', amount: 0 }, { key: 'B', amount: 0 }], path: '/amount', method: 'GET' } };
  const plan = { version: 1, steps: ['measure amount'], prerequisites: [], checks: [{ id: 'amount', line: 1, requirement: 'amount 100', channel: 'api',
    subject: { key: 'A' }, expected: 100, operator: 'equals', type: 'number', basis: { quote: 'amount 100' } }] };
  await writeFile(path.join(root, 'agent-tool-state.json'), JSON.stringify({ operations: {}, sources: {}, schemas: {}, observations: { current: observation }, cases: {
    'C1@1': { plan, planAt: observation.at, startedAt: observation.at, preflights: { amount: { original: true } }, observations: ['current'], assertions: {}, aliases: {}, errors: [] } } }));
  const agent = createRequirementAgent({}, { workDir: root, review: async () => ({ accepted: true, errors: [] }),
    agentModel: async ({ call }) => ({ close: async () => {}, async turn() {
      const corrected = await call('test_plan', { args: { identityCorrections: [{ checkId: 'amount', subject: { key: 'B' } }] } });
      assert.deepEqual(corrected.measurementPending, ['amount']);
      await call('test_finish', { args: { actual: 'Module boundary checked', blocker: { dependency: 'module', required_action: 'native', attempts: ['correction'] } } });
      return { text: 'done' };
    } }) });
  await agent.execute({ item: { caseId: 'C1' }, reports: root, headers: ['预期结果'], row: ['1. amount 100'], source: {}, resourceNames: [], mutations: [], checkOutput: value => value });
  const saved = JSON.parse(await readFile(path.join(root, 'agent-tool-state.json'))).cases['C1@1'];
  assert.equal(saved.plan.checks[0].expected, 100); assert.equal(saved.preflights.amount, undefined);
  assert.equal(saved.planRevisions[0].plan.checks[0].subject.key, 'A');
});

test('operation reuse rechecks actual source and resource boundaries while live responses remain fresh', async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'aos-operation-proof-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const file = path.join(root, 'service.js'); await writeFile(file, "GET '/value' is a read-only endpoint; amount changes live.");
  let reads = 0, resourceVersion = 'first';
  const server = createServer((_request, response) => response.end(JSON.stringify({ amount: ++reads })));
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  let reviews = 0;
  const agent = createRequirementAgent({ knowledgeFile: path.join(root, 'knowledge.json') }, { workDir: root,
    review: async () => { reviews++; return { accepted: true, errors: [] }; },
    agentModel: async ({ call }) => ({ close: async () => {}, async turn() {
      const invoke = (name, args) => call('test_' + name, { args });
      const first = await invoke('source', { action: 'read', path: 'service.js' });
      const contract = { name: 'read_value', sourceRefs: [first.sourceRef], reason: 'actual source',
        spec: { resource: 'api', kind: 'http', access: 'read', path: '/value', method: 'GET', authenticated: false } };
      await invoke('register', contract); assert.equal((await invoke('register', contract)).reused, true);
      assert.equal((await invoke('observe', { operation: 'read_value' })).data.body.amount, 1);
      assert.equal((await invoke('observe', { operation: 'read_value' })).data.body.amount, 2);
      await writeFile(file, "GET '/value' remains read-only, with new source version and amount semantics.");
      await assert.rejects(invoke('observe', { operation: 'read_value' }), /source changed/);
      const fresh = await invoke('source', { action: 'read', path: 'service.js' });
      await invoke('register', { ...contract, sourceRefs: [fresh.sourceRef] });
      resourceVersion = 'second';
      await assert.rejects(invoke('observe', { operation: 'read_value' }), /resource\/schema\/identity changed/);
      await invoke('register', { ...contract, sourceRefs: [fresh.sourceRef] });
      assert.equal((await invoke('observe', { operation: 'read_value' })).data.body.amount, 3);
      await invoke('finish', { actual: 'Boundary verification module only', blocker: { dependency: 'module', required_action: 'native acceptance', attempts: ['actual source changed'] } });
      return { text: 'done' };
    } }) });
  await agent.execute({ item: { caseId: 'C1' }, reports: root, sourceRoot: root, resourceNames: ['api'], resourceIdentity: () => resourceVersion,
    useRead: (_, run) => run({ base_url: 'http://127.0.0.1:' + server.address().port }),
    headers: ['预期结果'], row: ['1. Module only'], source: {}, checkOutput: value => value, mutations: [] });
  assert.equal(reviews, 3); assert.equal(reads, 3);
  const knowledge = JSON.parse(await readFile(path.join(root, 'knowledge.json')));
  assert.equal(knowledge.operations.read_value.operation.routeTemplate, '/value');
  assert.equal(knowledge.operations.read_value.boundary.resource, 'second');
  assert.equal(knowledge.operations.read_value.amount, undefined);
});

test('process expectations reuse real ledger evidence, cannot skip cleanup, and invalidate after further effects', async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'aos-process-proof-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const at = new Date().toISOString(), original = '1. amount 100\n2. restore owned rows and verify zero remaining';
  const observation = { observationId: 'remaining', caseKey: 'C1@1', channel: 'database', at,
    input: { resource: 'db', database: 'isolated', sql: 'SELECT COUNT(*) count FROM records WHERE tenant=?', params: ['owned'] }, data: { rows: [{ count: '0' }] } };
  await writeFile(path.join(root, 'agent-tool-state.json'), JSON.stringify({ operations: {}, sources: {}, schemas: {}, observations: { remaining: observation }, cases: {
    'C1@1': { startedAt: at, observations: ['remaining'], assertions: { amount: [{ compared: true, passed: false, expected: 100, observed: 95, evidence: { path: 'actual-comparison.json' } }] }, aliases: {}, errors: [] } } }));
  const mutations = [{ key: 'M1', intent: { purpose: 'scenario' }, phase: 'applied', cleanup: { verified: true } }];
  const agent = createRequirementAgent({}, { workDir: root, review: async prompt => {
    const payload = JSON.parse(prompt.slice(prompt.lastIndexOf('\n\n') + 2));
    if (payload.kind === 'process') {
      assert.equal(payload.mutations[0].key, 'M1'); assert.equal(payload.cleanup.verified, true);
      assert.equal(payload.observed[0].fields[0].value, '0'); assert.match(payload.observed[0].query.sql, /tenant=\?/);
      assert.match(payload.reportContract, /not yet claimed complete/);
      assert.equal(payload.related[0].compared, true);
      assert.deepEqual(payload.related[0].assertionEvidence, [{ path: 'actual-comparison.json' }]);
      assert.equal(payload.related[0].attempts, undefined);
    }
    return { accepted: true, errors: [] };
  }, agentModel: async ({ call }) => ({ close: async () => {}, async turn() {
    const invoke = (name, args) => call('test_' + name, { args });
    await invoke('plan', { version: 1, steps: ['compare amount', 'restore and verify count'], prerequisites: [],
      checks: [{ id: 'amount', line: 1, requirement: 'amount 100', channel: 'api', type: 'number', expected: 100, operator: 'equals', basis: { quote: 'amount 100' } }],
      processChecks: [{ id: 'cleanup', line: 2, requirement: 'restore owned rows and verify zero remaining', kind: 'cleanup', relatedCheckIds: ['amount'] }] });
    const args = { checkId: 'cleanup', evidenceRefs: [{ observationId: 'remaining', fields: [['rows', 0, 'count']] }] };
    await assert.rejects(invoke('process', args), /requires test_cleanup/);
    await invoke('cleanup', {}); assert.equal((await invoke('process', args)).proven, true);
    mutations[0].receipt = { changed: true };
    await assert.rejects(invoke('finish', { actual: 'Must not accept stale process proof' }), error => {
      assert.match(error.safeMessage, /Incomplete checks: cleanup \(process, cleanup, invalidated\)/);
      assert.equal(error.gap.details.missingChecks[0].evidence.previousProof.sanitized, true);
      assert.deepEqual(error.gap.details.productFailures, ['amount']);
      return true;
    });
    await invoke('process', args);
    assert.equal((await invoke('finish', { actual: 'Product failure retained and cleanup proven from real ledger' })).status, '失败');
    return { text: 'done' };
  } }) });
  const result = await agent.execute({ item: { caseId: 'C1' }, reports: root, headers: ['预期结果'], row: [original], source: {},
    resourceNames: ['db'], checkOutput: value => value, mutations, getMutations: () => mutations,
    cleanupCase: async () => ({ verified: true, evidence: [], pending: [] }) });
  assert.equal(result.checkCoverage.total, 1); assert.equal(result.checkCoverage.processTotal, 1); assert.equal(result.checkCoverage.processProven, 1);
});

test('restoration waits for actual asynchronous completion before touching an in-flight mutation', async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'aos-async-restore-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  let state = 'PROCESSING', earlyRestore = false, restores = 0;
  const server = createServer((request, response) => {
    if (request.method === 'POST') { earlyRestore ||= state === 'PROCESSING'; restores++; state = 'PENDING'; }
    response.end(JSON.stringify({ item: { key: 'owned', state } }));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const resource = { base_url: 'http://127.0.0.1:' + server.address().port };
  const intent = { id: 'approve', agent: true, operation: 'trigger', resource: 'api', target: 'approve', businessKey: 'owned',
    ownership: { field: ['body', 'item', 'key'], value: 'owned' }, stateFields: [['body', 'item']],
    snapshot: { status: 200, body: { item: { key: 'owned', state: 'PENDING' } } },
    verifySpec: { kind: 'http', resource: 'api', access: 'read', method: 'GET', path: '/', authenticated: false }, verifyInput: {},
    restoreSpec: { kind: 'http', resource: 'api', access: 'update', method: 'POST', path: '/', authenticated: false }, restoreInput: {},
    before: [{ field: ['body', 'item', 'state'], operator: 'equals', expected: 'PENDING' }],
    after: [{ field: ['body', 'item', 'state'], operator: 'equals', expected: 'APPROVED' }],
    ready: { field: ['body', 'item', 'state'], operator: 'not_equals', value: 'PROCESSING', timeoutMs: 1000 }, cleanupAction: 'Restore original state' };
  const mutation = { key: 'M', caseId: 'C', intent };
  const scope = { jobId: 'isolated', projectId: 'test', item: { caseId: 'C' }, reports: root, checkOutput: value => value,
    mutations: [mutation], useRead: (_, run) => run(resource), restore: (_key, _access, run) => run(resource),
    saveCleanup: async (_key, update) => { mutation.cleanup = { ...mutation.cleanup, ...update }; } };
  const agent = createRequirementAgent({}, { workDir: root });
  intent.ready.timeoutMs = 1;
  assert.equal((await agent.cleanup(scope)).verified, false);
  assert.equal(restores, 0);
  intent.ready.timeoutMs = 1000;
  const completion = setTimeout(() => { state = 'APPROVED'; }, 80);
  t.after(() => clearTimeout(completion));
  assert.equal((await agent.cleanup(scope)).verified, true);
  assert.equal(earlyRestore, false); assert.equal(restores, 1); assert.equal(state, 'PENDING');
});
