import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createRequirementAgent } from '../src/runner/requirement-agent.js';

async function runProof(t, mode, execute) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'aos-request-proof-'));
  await writeFile(path.join(root, 'service.js'), 'Isolated POST /bundle, POST /revision, GET /read, GET /audit, DELETE /bundle.');
  let exists = false, writes = 0, auditMode = mode, requests = [];
  const key = 'AOS_PROOF_1';
  const server = createServer((request, response) => {
    const url = new URL(request.url, 'http://127.0.0.1');
    const send = (data, status = 200) => { response.statusCode = status; response.end(JSON.stringify(data)); };
    if (url.pathname === '/audit') {
      const { correlation, from, through } = Object.fromEntries(url.searchParams);
      if (auditMode === 'missing') return send({}, 403);
      return send({ source: 'isolated-server', correlation: auditMode === 'wrong-key' ? 'different-object' : correlation,
        from: auditMode === 'short-window' ? new Date(Date.parse(through) + 1).toISOString() : from, through, complete: auditMode !== 'incomplete', entries: requests });
    }
    if (request.method === 'POST' && url.pathname === '/bundle') {
      requests.push({ id: String(++writes), at: new Date().toISOString(), method: 'POST', path: '/bundle', correlation: key });
      if (mode === 'retry' && writes === 1) return request.socket.destroy();
      exists = true;
      return send({ key }, mode === 'retry' ? 409 : 200);
    }
    if (request.method === 'DELETE' && url.pathname === '/bundle') exists = false;
    return send({ key: exists ? key : null, count: exists ? 1 : 0 });
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => {
    await new Promise(resolve => server.close(resolve));
    await rm(root, { recursive: true, force: true });
  });
  const resource = { base_url: 'http://127.0.0.1:' + server.address().port };
  const mutations = [];
  const audits = [];
  const original = '1. count equals 1\n2. prepare exactly once without calling the revision endpoint\n3. verify the 15-sheet report';
  const agent = createRequirementAgent({}, { workDir: root, review: async prompt => {
    const payload = JSON.parse(prompt.slice(prompt.lastIndexOf('\n\n') + 2));
    if (payload.kind === 'process') audits.push(payload);
    if (payload.kind === 'plan' && payload.plan.processChecks[0].requestProof.scope === 'service') {
      assert.equal(payload.requestPreflights[0].check.id, 'P01');
      assert.equal(payload.requestPreflights[0].source, 'isolated-server');
      assert.equal(payload.requestPreflights[0].evidence.sanitized, true);
    }
    return { accepted: true, errors: [] };
  }, agentModel: async ({ call }) => ({ close: async () => {}, async turn() {
    const invoke = (name, args) => call('test_' + name, { args });
    const source = await invoke('source', { action: 'read', path: 'service.js' });
    for (const [name, method, access, pathname] of [
      ['bundle', 'POST', 'create', '/bundle'], ['read_bundle', 'GET', 'read', '/read'],
      ['delete_bundle', 'DELETE', 'delete', '/bundle'], ['audit_bundle', 'GET', 'read', '/audit'],
    ]) await invoke('register', { name, sourceRefs: [source.sourceRef], reason: 'Fixture operation', spec: {
      kind: 'http', resource: 'api', authenticated: false, method, access, path: pathname,
      ...(name === 'audit_bundle' ? { query: Object.fromEntries(['mode', 'correlation', 'from', 'through'].map(input => [input, { $input: input }])) }
        : { query: { key: { $input: 'key' } } }),
    } });
    const check = { id: 'P01', kind: 'execution_evidence', line: 2, requirement: 'prepare exactly once without calling the revision endpoint',
      relatedCheckIds: ['C01'], requestProof: { scope: ['runner', 'retry'].includes(mode) ? 'runner' : 'service', phase: 'prepare', resource: 'api',
        requests: [{ method: 'POST', path: '/bundle', count: 1 }, { method: 'POST', path: '/revision', count: 0 }],
        ...(['runner', 'retry'].includes(mode) ? {} : { audit: { operation: 'audit_bundle', correlation: key } }) } };
    const mutation = { id: 'prepare', purpose: 'prepare', operation: 'bundle', input: { key }, businessKey: key, ownership: { field: ['body', 'key'], value: key },
      verify: { operation: 'read_bundle', input: { key }, before: [{ field: ['body', 'count'], operator: 'equals', expected: 0 }],
        after: [{ field: ['body', 'count'], operator: 'equals', expected: 1 }] }, restore: { operation: 'delete_bundle', input: { key } }, cleanupAction: 'Remove task-owned fixture' };
    const preflight = () => invoke('plan', { action: 'process_preflight', check });
    const prepare = () => invoke('mutate', mutation);
    const finish = () => invoke('finish', { actual: 'Fixture only' });
    const plan = () => invoke('plan', { version: 1, steps: ['Prepare and check'], prerequisites: [], processChecks: [check,
      { id: 'PReport', line: 3, kind: 'report', requirement: 'verify the 15-sheet report' }], checks: [{ id: 'C01', line: 1, requirement: 'count equals 1',
        channel: 'api', type: 'number', operator: 'equals', expected: 1, basis: { quote: 'count equals 1' } }] });
    const observe = () => invoke('observe', { operation: 'read_bundle', input: { key } });
    const compare = async () => {
      const current = await observe();
      return invoke('assert', { checkId: 'C01', observationId: current.observationId, field: ['body', 'count'] });
    };
    const process = () => invoke('process', { checkId: 'P01', evidenceRefs: [] });
    await execute({ preflight, prepare, plan, compare, process, finish, mutations, audits,
      writes: () => writes, changeAudit: value => { auditMode = value; }, finishMissing: () => invoke('finish', { actual: 'No verdict',
        blocker: { dependency: 'Isolated audit access', required_action: 'Restore scope and coverage', attempts: ['Actual registered audit call'] } }) });
    return { text: 'done' };
  } }) });
  const result = await agent.execute({ item: { caseId: 'C1' }, reports: root, headers: ['预期结果'], row: [original], source: {},
    sourceRoot: root, runPrefix: 'AOS_PROOF_', resourceNames: ['api'], checkOutput: value => value, mutations, getMutations: () => mutations,
    useRead: (_, run) => run(resource), invoke: async (intent, apply) => {
      if (!mutations.length) mutations.push({ key: intent.id, intent, phase: 'prepared', applyAttempts: [] });
      const [record] = mutations;
      record.applyAttempts.push({ status: 'sent' });
      record.receipt = await apply(resource);
      record.phase = 'applied';
      return record.receipt;
    } });
  if (exists) await fetch(resource.base_url + '/bundle?key=' + key, { method: 'DELETE' });
  assert.equal(exists, false);
  const state = JSON.parse(await readFile(path.join(root, 'agent-tool-state.json'), 'utf8'));
  return { result, trace: state.cases['C1@1'].requestTrace };
}

test('Runner-only process proof counts actual transports and permits the report to follow', async t => {
  const { result, trace } = await runProof(t, 'runner', async flow => {
    await flow.prepare(); await flow.plan();
    await assert.rejects(flow.finish(), error => {
      assert.deepEqual(error.gap.details.missingChecks.map(check => [check.checkId, check.status]), [['C01', 'uncompared'], ['P01', 'missing_evidence']]);
      assert.deepEqual(error.gap.details.deferred.map(check => check.checkId), ['PReport']);
      return true;
    });
    await flow.compare(); await flow.process(); await flow.finish();
    assert.equal(flow.audits[0].requestProof.scope, 'runner');
    assert.equal(flow.audits[0].registeredOperations.find(operation => operation.name === 'bundle').spec.path, '/bundle');
  });
  assert.equal(result.status, '通过');
  assert.deepEqual(trace.filter(item => item.method === 'POST').map(item => item.status), [200]);
});

test('one mutation intent does not hide extra transmission attempts, a lost reply, or a non-success reply', async t => {
  const { result, trace } = await runProof(t, 'retry', async flow => {
    await assert.rejects(flow.prepare(), /fetch failed/);
    await flow.prepare(); await flow.plan(); await flow.compare();
    assert.equal(flow.mutations.length, 1);
    assert.equal(flow.writes(), 2);
    await assert.rejects(flow.process(), error => error.code === 'request_proof_contradiction' && /expected 1, actual 2/.test(error.message));
    await flow.finishMissing();
  });
  assert.equal(result.status, '未执行');
  assert.deepEqual(trace.filter(item => item.method === 'POST').map(item => [item.outcome, item.status]), [['no_response', undefined], ['response', 409]]);
});

test('independent service proof refuses unauthorized, incomplete, wrong-key and short-window receipts', async t => {
  const { result } = await runProof(t, 'missing', async flow => {
    await assert.rejects(flow.preflight(), /successful source receipt/);
    await assert.rejects(flow.prepare(), /preflight is incomplete before prepare/);
    assert.equal(flow.writes(), 0);
    flow.changeAudit('full'); await flow.preflight(); await flow.prepare();
    flow.changeAudit('wrong-key'); await assert.rejects(flow.plan(), /correlation does not match/);
    flow.changeAudit('short-window'); await assert.rejects(flow.plan(), /complete coverage/);
    flow.changeAudit('full'); await flow.plan(); await flow.compare();
    flow.changeAudit('missing'); await flow.process(); await flow.finish();
    assert.equal(flow.audits[0].requestProof.window.source, 'isolated-server');
    assert.equal(flow.audits[0].requestProof.matches[0].actual, 1);
  });
  assert.equal(result.status, '通过');
});
