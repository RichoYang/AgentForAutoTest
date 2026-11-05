import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createServer } from 'node:http';
import mysql from 'mysql2';
import { repairPlan } from '../src/runner/requirement-plan.js';
import { createRequirementAdapter } from '../src/runner/requirement-adapter.js';
import { createRequirementAgent } from '../src/runner/requirement-agent.js';
import { executeCases } from '../src/runner/requirement-execution.js';
import { digest, RequirementWait } from '../src/runner/requirement-feishu.js';
import { createAgentResources, readSource, sanitized, validateRouteTemplate } from '../src/runner/requirement-agent-resources.js';

test('database connector preserves fiscal dates and microseconds from the MySQL protocol', async t => {
  const server = mysql.createServer();
  const sockets = new Set();
  server.on('connection', connection => {
    sockets.add(connection.stream);
    connection.stream.once('close', () => sockets.delete(connection.stream));
    connection.on('error', () => {});
    connection.serverHandshake({ protocolVersion: 10, serverVersion: '8.0-fixture', connectionId: 1,
      statusFlags: 2, characterSet: 45, capabilityFlags: 0xffffff, authCallback: (_, done) => done(null) });
    connection.on('query', () => {
      connection.writeColumns([
        { catalog: 'def', schema: 'fixture', table: 'period', orgTable: 'period', name: 'start_date', orgName: 'start_date', characterSet: 45, columnLength: 10, columnType: mysql.Types.DATE, flags: 0, decimals: 0 },
        { catalog: 'def', schema: 'fixture', table: 'period', orgTable: 'period', name: 'updated_at', orgName: 'updated_at', characterSet: 45, columnLength: 26, columnType: mysql.Types.DATETIME, flags: 0, decimals: 6 },
      ]);
      connection.writeTextRow(['2027-04-01', '2027-03-31 23:59:59.123456']);
      connection.writeEof();
    });
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => { for (const socket of sockets) socket.destroy(); await new Promise(resolve => server.close(resolve)); });
  const runtime = createAgentResources({}, { state: { operations: {} }, useRead: (_, call) => call({
    resource_type: 'mysql', host: '127.0.0.1', port: server._server.address().port, username: 'fixture', password: 'fixture',
  }) });
  t.after(() => runtime.close());
  const observed = sanitized(await runtime.schema({ resource: 'mysql' }));
  assert.deepEqual(JSON.parse(JSON.stringify(observed.rows)), [{ start_date: '2027-04-01', updated_at: '2027-03-31 23:59:59.123456' }]);
  assert.equal(sanitized({ at: new Date('2027-04-01T00:00:00Z'), token: 'private' }).at, '2027-04-01T00:00:00.000Z');
  assert.equal(sanitized({ at: new Date('2027-04-01T00:00:00Z'), token: 'private' }).token, '[REDACTED]');
});

test('source search reads the selected repository when child stdin is a pipe', async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'agent-source-')); t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(path.join(root, 'service'));
  await writeFile(path.join(root, 'service', 'budget.js'), 'export const fiscalBalance = 100;\n');
  await writeFile(path.join(root, 'secrets.ini'), 'fiscalBalance=private\n');
  const found = await readSource(root, { action: 'search', path: 'service', pattern: 'fiscalBalance' });
  assert.equal(found.total, 1); assert.match(found.lines[0], /budget\.js:1:export const fiscalBalance/);
  assert.equal((await readSource(root, { action: 'search', path: 'service/budget.js', pattern: 'fiscalBalance' })).total, 1);
  const all = await readSource(root, { action: 'search', pattern: 'fiscalBalance' });
  assert.equal(all.total, 1); assert.doesNotMatch(all.lines.join('\n'), /private/);
  assert.equal((await readSource(root, { action: 'search', pattern: 'missingPattern' })).total, 0);
  assert.throws(() => validateRouteTemplate('/page?key={$input:"key"}', '$.spec.path'), /spec.path uses \{parameter\}/);
});

test('adapter upgrade advances an interrupted attempt once and leaves untouched retry cases unchanged', async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'agent-attempt-')); t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(path.join(root, 'reports'));
  const iniPath = path.join(root, 'env.ini');
  await writeFile(iniPath, '[Demo.Uat.Platform]\nstatus=configured\nai_access=allowed\nai_operation_mode=full_crud\nenvironment=Uat\nbase_url=http://127.0.0.1:1');
  const row = ['dedicated baseline', '1. 金额100元'];
  const index = ['C1', 'C2'].map((caseId, i) => ({ caseId, row: i + 2, requirementIds: [] }));
  const journal = { executionBinding: 'old', publication: { url: 'https://fixture.invalid/sheets/Old', version: 'preserved' },
    results: {}, mutations: [], inFlight: 'C1', caseAttempts: { C1: 2, C2: 2 }, preparations: { C1: { agent: true, prerequisites: [] } },
    executionCases: Object.fromEntries(index.map(item => [item.caseId, { caseVersion: digest([item.caseId, [], row]) }])) };
  await executeCases({ job: { id: 'JOB-local', projectId: 'demo', requirement: {} },
    settings: { environment: { name: 'UAT', platform: 'Demo', iniPath, lockKey: 'local', resources: { platform: { section: 'Demo.Uat.Platform', scope: 'full_crud' } } },
      lockDirectory: path.join(root, 'locks'), execution: { mode: 'agent' } }, project: { repoPath: root }, journal, source: {}, index,
    manifest: { headers: ['前置条件', '预期结果'], rows: [row, row] }, regression: { files: { 'references/execution-standard.md': '' } },
    workDir: root, reportDir: path.join(root, 'reports'), save: async () => {}, progress: async () => {},
    agentModel: async ({ call }) => ({ close: async () => {}, async turn() {
      await call('test_finish', { args: { actual: 'Module fixture has no business evidence.', blocker: {
        dependency: 'fixture', required_action: 'run native acceptance separately', attempts: ['fixture invocation'] } } }, 'finish');
      return { text: 'Recorded' };
    } }) });
  assert.deepEqual(journal.caseAttempts, { C1: 3, C2: 2 });
  assert.deepEqual(journal.executionHistory[0].caseAttempts, { C1: 2, C2: 2 });
  assert.equal(journal.executionHistory[0].inFlight, 'C1');
  assert.equal(journal.executionCases.C1.lastAttempt, 3);
  assert.equal(journal.cleanup.verified, true);
});

test('plan errors retain candidates and correct both syntax and field errors without losing requirements', async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'agent-plan-')); t.after(() => rm(root, { recursive: true, force: true }));
  let calls = 0;
  const result = await repairPlan({ prompt: 'original requirement', operations: { read: {} }, options: { workDir: root },
    scope: { item: { caseId: 'C1' }, checkOutput: value => value }, normalize: value => value.steps,
    async generate(prompt) {
      calls++;
      if (calls === 1) throw Object.assign(new RequirementWait('generator', 'invalid JSON'), { rawOutput: 'not-json' });
      assert.match(prompt, /original requirement/);
      if (calls === 2) { assert.match(prompt, /valid JSON/); return { steps: null, missing: 'missing input' }; }
      assert.match(prompt, /\$\.steps/); assert.match(prompt, /\$\.missing/);
      return { steps: [{ operation: 'read', input: {}, checks: [] }], missing: [] };
    } });
  assert.equal(calls, 3); assert.equal(result.steps.length, 1);
});

test('resource form credentials stay inside the connector and browser faults are explicit and reversible', async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'agent-resource-')); t.after(() => rm(root, { recursive: true, force: true }));
  let logins = 0, navigationWrites = 0;
  const server = createServer(async (req, res) => {
    if (req.url === '/login') {
      let body = ''; for await (const part of req) body += part;
      assert.equal(new URLSearchParams(body).get('password'), 'local-test-secret'); logins++;
      res.setHeader('set-cookie', 'session=local-cookie; HttpOnly'); return res.end('{}');
    }
    if (req.url === '/protected') return res.end(JSON.stringify({ authenticated: req.headers.cookie === 'session=local-cookie' }));
    if (req.url === '/preference') { navigationWrites++; return res.end('{"updated":true}'); }
    if (req.url.startsWith('/navigation')) { res.setHeader('content-type', 'text/html'); return res.end('<script>fetch("/preference",{method:"POST"})</script>'); }
    if (req.url === '/amount') return res.end('{"amount":100}');
    res.setHeader('content-type', 'text/html');
    res.end('<span id="busy">loading</span><span id="amount"></span><script>fetch("/amount").then(r=>r.json()).then(d=>{document.querySelector("#amount").textContent=d.amount;document.querySelector("#busy").remove()})</script>');
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve)); t.after(() => new Promise(resolve => server.close(resolve)));
  const resource = { base_url: 'http://127.0.0.1:' + server.address().port, username: 'fixture', password: 'local-test-secret' };
  const state = { operations: { amount: { kind: 'http', access: 'read', resource: 'platform', path: '/amount', method: 'GET' } } };
  const runtime = createAgentResources({ resourceAuth: { scheduler: { kind: 'form', path: '/login', fields: { user: 'username', password: 'password' } } } },
    { state, reports: root, item: { caseId: 'C1' }, useRead: (_, call) => call(resource) }); t.after(() => runtime.close());
  const operation = { kind: 'http', access: 'read', resource: 'scheduler', path: '/protected', method: 'GET' };
  assert.equal((await runtime.performSpec(operation, {}, resource)).body.authenticated, true);
  assert.equal((await runtime.performSpec(operation, {}, resource)).body.authenticated, true); assert.equal(logins, 1);
  const page = args => runtime.browser({ resource: 'platform', ...args });
  await page({ action: 'fault', operation: 'amount', delayMs: 100, status: 200, body: { amount: 0 } });
  await page({ action: 'goto', path: '/' });
  const wrong = await page({ action: 'observe', ready: { selector: '#busy', state: 'hidden' }, fields: { amount: { selector: '#amount', read: 'text' } } });
  assert.deepEqual(wrong.values.amount, ['0']); assert.equal(wrong.simulatedFault, true);
  await page({ action: 'clear_fault' }); await page({ action: 'goto', path: '/' });
  const restored = await page({ action: 'observe', ready: { selector: '#busy', state: 'hidden' }, fields: { amount: { selector: '#amount', read: 'text' } } });
  assert.deepEqual(restored.values.amount, ['100']); assert.equal(restored.simulatedFault, undefined);
  await page({ action: 'goto', path: '/navigation' });
  await page({ action: 'wait', ready: { selector: 'body', state: 'visible' } });
  assert.equal(navigationWrites, 0);
  const write = await runtime.performSpec({ kind: 'browser', resource: 'platform', access: 'update', action: 'goto',
    path: '/navigation?object={key}', effect: { path: '/preference', method: 'POST' } }, { key: 'A & B' }, resource);
  assert.equal(write.status, 200); assert.equal(navigationWrites, 1);
  assert.match((await page({ action: 'inspect' })).url, /object=A%20%26%20B$/);
});

test('multi-object steps bind independently, wrong candidate is rejected, and asynchronous page readiness waits for business state', async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'agent-binding-')); t.after(() => rm(root, { recursive: true, force: true }));
  const requests = [];
  const server = createServer((req, res) => {
    const url = new URL(req.url, 'http://localhost'); requests.push(url.searchParams.get('account'));
    if (url.pathname === '/balance') return res.end(JSON.stringify({ account: url.searchParams.get('account'), balance: 100 }));
    res.setHeader('content-type', 'text/html');
    res.end('<span id="state">loading</span><span id="amount">0</span><script>setTimeout(()=>{document.querySelector("#amount").textContent="100";document.querySelector("#state").textContent="ready"},350)</script>');
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve)); t.after(() => new Promise(resolve => server.close(resolve)));
  const base_url = 'http://127.0.0.1:' + server.address().port;
  const operation = { kind: 'http', resource: 'platform', path: '/balance', inputs: ['account'], outputs: { balance: ['balance'], account: ['account'] },
    subject: { account: { input: 'account', output: ['account'] } }, observations: [{ id: 'balance', label: '余额', type: 'number', unit: '元', field: ['balance'] }] };
  const scope = { item: { caseId: 'C1' }, headers: ['前置条件', '预期结果'], row: ['经销商 A 和经销商 B', '1. 余额100元'],
    checkOutput: value => value, reports: root, repositories: [], useRead: (_, call) => call({ base_url }) };
  const run = async selected => {
    const adapter = createRequirementAdapter({ operations: { query: operation }, dimensions: { account: { labels: ['经销商'], pattern: '[A-Z]' } } },
      { plan: async () => ({ missing: [], steps: ['A', 'B'].map(account => ({ operation: 'query', input: { account },
        subject: { account: selected ?? account }, checks: [{ field: ['balance'], assertion: 1 }] })) }) });
    return adapter.execute({ ...scope, preparation: await adapter.prepare(scope) });
  };
  assert.equal((await run()).status, '通过'); assert.deepEqual(requests, ['A', 'B']);
  assert.equal((await run('C')).status, '阻断'); assert.equal(requests.length, 2);
  const page = { kind: 'browser', resource: 'platform', path: '/page', authenticated: false,
    ready: { selector: '#state', text: 'ready' }, selectors: { amount: { selector: '#amount', read: 'text' } },
    observations: [{ ...operation.observations[0], field: ['values', 'amount'], encoding: 'decimal-text' }] };
  const adapter = createRequirementAdapter({ operations: { page } }, { plan: async () => ({ missing: [], steps: [
    { operation: 'page', input: {}, checks: [{ field: ['values', 'amount'], assertion: 1 }] }] }) });
  const pageScope = { ...scope, row: ['', '1. 页面显示余额100元'] };
  assert.equal((await adapter.execute({ ...pageScope, preparation: await adapter.prepare(pageScope) })).status, '通过');
});

test('tool channel evidence cannot be relabelled and runner migrates an old unexecuted attempt without changing publication', async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'agent-tools-')); t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(path.join(root, 'reports')); await writeFile(path.join(root, 'source.js'), 'GET /budget returns {key:"A",amount:0}; read-only');
  const server = createServer((_req, res) => res.end('{"key":"A","amount":0}'));
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve)); t.after(() => new Promise(resolve => server.close(resolve)));
  const iniPath = path.join(root, 'env.ini');
  await writeFile(iniPath, '[Demo.Uat.Platform]\nstatus=configured\nai_access=allowed\nai_operation_mode=full_crud\nenvironment=Uat\nbase_url=http://127.0.0.1:' + server.address().port);
  const manifest = { headers: ['前置条件', '预期结果'], rows: [['账户A', '1. 金额100元']] };
  const journal = { executionBinding: 'old', publication: { url: 'https://fixture.invalid/sheets/Old', version: 'preserved' },
    results: { C1: { status: '未执行', actual: 'old unavailable', evidence: [] } }, mutations: [] };
  const originalPublication = structuredClone(journal.publication);
  const job = { id: 'JOB-local', projectId: 'demo', requirement: {} };
  let captured;
  const agentModel = async ({ call }) => ({ close: async () => {}, async turn() {
    const invoke = (name, args) => call('test_' + name, { args }, 'call-' + name);
    const source = await invoke('source', { action: 'read', path: 'source.js' });
    await invoke('register', { name: 'budget', sourceRefs: [source.sourceRef], reason: 'read', spec: { kind: 'http', resource: 'platform', access: 'read', path: '/budget', method: 'GET', authenticated: false } });
    await invoke('register', { name: 'update_budget', sourceRefs: [source.sourceRef], reason: 'module permission fixture', spec: { kind: 'http', resource: 'platform', access: 'update', path: '/budget', method: 'PUT', authenticated: false } });
    await assert.rejects(invoke('mutate', { id: 'shared-without-project-grant', purpose: 'prepare', operation: 'update_budget', input: {},
      businessKey: 'A', ownership: { field: ['body', 'key'], value: 'A' }, shared: true,
      verify: { operation: 'budget', input: {}, before: [{ field: ['body', 'key'], operator: 'equals', expected: 'A' }],
        after: [{ field: ['body', 'key'], operator: 'equals', expected: 'A' }] }, restore: { operation: 'update_budget', input: {} },
      cleanupAction: 'restore the original amount' }), /唯一归属/);
    assert.equal(journal.mutations.length, 0);
    await invoke('observe', { operation: 'budget', input: {}, subject: { account: 'A' } });
    const plan = { version: 1, steps: ['Read A'], prerequisites: [], checks: [{ id: 'balance', line: 1,
      requirement: '金额100元', channel: 'api', type: 'number', operator: 'equals', expected: 100, unit: '元', subject: { account: 'A' }, basis: { quote: '金额100元' } }] };
    const invalid = structuredClone(plan); invalid.checks[0].subject.phase = 'after-create';
    await assert.rejects(invoke('plan', invalid), /subject.phase/);
    const stringLine = structuredClone(plan); stringLine.checks[0].line = '1';
    await assert.rejects(invoke('plan', stringLine), /checks\[0\]\.line must be a 1-based integer/);
    await invoke('plan', plan);
    const observed = await invoke('observe', { operation: 'budget', input: {}, subject: { account: 'A' } });
    await assert.rejects(invoke('assert', { checkId: 'balance', observationId: observed.observationId, field: ['body', 'amount'], identity: [{ dimension: 'account', field: ['body', 'wrong'] }] }));
    captured = await invoke('assert', { checkId: 'balance', observationId: observed.observationId, field: ['body', 'amount'], identity: [{ dimension: 'account', field: ['body', 'key'] }] });
    const changed = structuredClone(plan); changed.checks[0].expected = 0;
    await assert.rejects(invoke('plan', changed), /Frozen expectations/);
    await invoke('finish', { actual: '账户A实测金额0元，低于预期100元。', classification: '产品' });
    return { text: 'Finished' };
  } });
  await executeCases({ job, settings: { environment: { name: 'UAT', platform: 'Demo', iniPath, lockKey: 'local', resources: { platform: { section: 'Demo.Uat.Platform', scope: 'full_crud' } } },
    lockDirectory: path.join(root, 'locks'), execution: { mode: 'agent' } }, project: { repoPath: root }, journal, source: {},
    index: [{ caseId: 'C1', row: 2, requirementIds: [] }], manifest, regression: { files: { 'references/execution-standard.md': '' } },
    workDir: root, reportDir: path.join(root, 'reports'), save: async () => {}, progress: async () => {}, agentModel,
    review: async () => ({ accepted: true, errors: [] }) });
  assert.equal(captured.passed, false); assert.equal(journal.results.C1.status, '失败');
  assert.equal(journal.results.C1.issue.classification, '产品缺陷');
  assert.equal(journal.executionHistory[0].results.C1.status, '未执行');
  assert.equal(journal.caseAttempts.C1, 2); assert.deepEqual(journal.publication, originalPublication);
  assert.equal(journal.cleanup.verified, true);
});
