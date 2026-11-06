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
  await mkdir(path.join(root, '.git'));
  await writeFile(path.join(root, '.gitignore'), 'service/\n');
  await mkdir(path.join(root, 'service', 'node_modules'));
  await writeFile(path.join(root, 'service', 'node_modules', 'noise.js'), 'fiscalBalance=private\n');
  await writeFile(path.join(root, 'service', 'secrets.ini'), 'fiscalBalance=private\n');
  await writeFile(path.join(root, 'service', 'budget.js'), 'export const fiscalBalance = 100;\n');
  await writeFile(path.join(root, 'secrets.ini'), 'fiscalBalance=private\n');
  const found = await readSource(root, { action: 'search', path: 'service', pattern: 'fiscalBalance' });
  assert.equal(found.total, 1); assert.match(found.lines[0], /budget\.js:1:export const fiscalBalance/);
  assert.equal((await readSource(root, { action: 'search', path: 'service/budget.js', pattern: 'fiscalBalance' })).total, 1);
  const all = await readSource(root, { action: 'search', pattern: 'fiscalBalance' });
  assert.equal(all.total, 1); assert.doesNotMatch(all.lines.join('\n'), /private/);
  const files = await readSource(root, { action: 'files' });
  assert.ok(files.lines.some(file => /budget.js$/.test(file))); assert.doesNotMatch(files.lines.join('\n'), /secrets.ini|noise.js/);
  assert.equal((await readSource(root, { action: 'search', pattern: 'missingPattern' })).total, 0);
  assert.throws(() => validateRouteTemplate('/page?key={$input:"key"}', '$.spec.path'), /spec.path uses \{parameter\}/);
});

test('connector retains public authenticated identity and rejects changed or secret identities across recovery', async t => {
  let userId = 'operator-A', loginCount = 0, writes = 0;
  const server = createServer(async (req, res) => {
    if (req.url === '/login') {
      for await (const _ of req) { /* consume fixture credentials without logging */ }
      loginCount++; res.setHeader('content-type', 'application/json');
      return res.end(JSON.stringify({ data: { userId, token: 'private-session', password: 'never-export' } }));
    }
    if (req.url === '/preference') { writes++; return res.end('{}'); }
    res.setHeader('content-type', 'text/html');
    res.end('<input id="account"><input id="password"><button id="login" onclick="fetch(\'/login\',{method:\'POST\'})">login</button>');
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const resource = { base_url: 'http://127.0.0.1:' + server.address().port, username: 'fixture', password: 'secret' };
  const config = { login: { resource: 'platform', path: '/login', tokenField: ['data', 'token'],
    identityFields: { userId: ['data', 'userId'] }, accountSelector: '#account', passwordSelector: '#password', submitSelector: '#login' } };
  const open = settings => createAgentResources(settings, { state: { operations: {} } });
  const first = open(config);
  const proof = await first.authenticationEvidence('platform', resource);
  assert.deepEqual(proof.identity, { userId: 'operator-A' });
  assert.equal(proof.response.data.token, '[REDACTED]'); assert.equal(proof.response.data.password, '[REDACTED]');
  assert.doesNotMatch(JSON.stringify(proof), /private-session|never-export/);
  await first.verifyAuthentication('platform', resource, proof);
  await assert.rejects(first.verifyAuthentication('platform', resource, { identity: { userId: 'operator-other' } }), /identity changed/);
  assert.equal(await first.authenticationEvidence('unrelated', resource), null);
  assert.equal(loginCount, 1); await first.close();
  userId = 'operator-B';
  const recovered = open(config);
  await assert.rejects(recovered.verifyAuthentication('platform', resource, proof), /identity changed/);
  assert.equal(writes, 0); await recovered.close();
  const badConfig = structuredClone(config); badConfig.login.identityFields.userId = ['data', 'token'];
  const invalid = open(badConfig);
  await assert.rejects(invalid.authenticationEvidence('platform', resource), /not a public identity/);
  await assert.rejects(invalid.authenticationEvidence('platform', resource), /not a public identity/);
  assert.equal(loginCount, 4); await invalid.close();
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

test('failed-case retry preserves same Job history and passed results, and refuses unresolved writes', async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'agent-failed-retry-')); t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(path.join(root, 'reports'));
  const iniPath = path.join(root, 'env.ini');
  await writeFile(iniPath, '[Demo.Uat.Platform]\nstatus=configured\nai_access=allowed\nai_operation_mode=full_crud\nenvironment=Uat\nbase_url=http://127.0.0.1:1');
  const publication = { url: 'https://fixture.invalid/Original', version: 'unchanged' };
  const journal = { publication, results: { C1: { status: '失败', actual: 'original failure' }, C2: { status: '通过', actual: 'retained pass' } },
    mutations: [{ key: 'pending', cleanup: { verified: false } }], caseAttempts: { C1: 1, C2: 1 } };
  const job = { id: 'JOB-original', projectId: 'demo', requirement: { retryRequest: 'message-1', retryStatuses: ['失败', '未执行'] } };
  let calls = 0;
  const run = () => executeCases({ job, journal,
    settings: { environment: { name: 'UAT', platform: 'Demo', iniPath, lockKey: 'local', resources: { platform: { section: 'Demo.Uat.Platform', scope: 'full_crud' } } },
      lockDirectory: path.join(root, 'locks'), execution: { mode: 'agent' } }, project: { repoPath: root }, source: {},
    index: ['C1', 'C2', 'C3'].map((caseId, i) => ({ caseId, row: i + 2, requirementIds: [] })),
    manifest: { headers: ['前置条件', '预期结果'], rows: Array.from({ length: 3 }, () => ['fixture', '1. 金额100元']) },
    regression: { files: { 'references/execution-standard.md': '' } }, workDir: root, reportDir: path.join(root, 'reports'),
    save: async () => {}, progress: async () => {}, agentModel: async ({ call }) => ({ close: async () => {}, async turn() {
      calls++;
      await call('test_finish', { args: { actual: 'Module fixture only', blocker: { dependency: 'fixture', required_action: 'native acceptance', attempts: ['module only'] } } }, 'finish');
      return { text: 'recorded' };
    } }) });
  await assert.rejects(run(), { code: 'cleanup_pending' }); assert.equal(calls, 0);
  journal.mutations[0].cleanup.verified = true;
  await run();
  assert.equal(calls, 2); assert.equal(journal.caseAttempts.C1, 2); assert.equal(journal.caseAttempts.C2, 1);
  assert.equal(journal.caseAttempts.C3, 1); assert.equal(journal.results.C2.status, '通过');
  assert.equal(journal.executionHistory[0].results.C1.actual, 'original failure');
  assert.equal(journal.executionHistory[0].reason, 'retry_failed');
  assert.deepEqual(journal.publication, publication); assert.equal(journal.cleanup.verified, true);
  await run(); assert.equal(calls, 2); assert.equal(journal.executionHistory.length, 1);
});

test('measurement query mismatches are recoverable tool errors while matching queries retain real failures', async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'agent-measurement-')); t.after(() => rm(root, { recursive: true, force: true }));
  const query = "SELECT SHA2(JSON_OBJECT('name',name),256) AS hash FROM account WHERE id=?";
  const badQuery = query.replace("'name',name", "'name',reason");
  const baseline = { observationId: 'baseline', caseKey: 'C1@1', channel: 'database', at: '2026-01-01T00:00:01Z',
    input: { resource: 'db', database: 'fixture', sql: query, params: ['A'] }, data: { rows: [{ hash: 'before' }] } };
  const observations = { baseline, mismatch: { ...baseline, observationId: 'mismatch', at: '2026-01-01T00:00:03Z', input: { ...baseline.input, sql: badQuery }, data: { rows: [{ hash: 'different' }] } },
    corrected: { ...baseline, observationId: 'corrected', at: '2026-01-01T00:00:04Z' },
    productFailure: { ...baseline, observationId: 'productFailure', at: '2026-01-01T00:00:05Z', data: { rows: [{ hash: 'changed' }] } } };
  const plan = { checks: [{ id: 'unchanged', line: 1, requirement: 'existing records unchanged', channel: 'database', expected: 'before', type: 'text', operator: 'equals',
    basis: { observationId: 'baseline', field: ['rows', 0, 'hash'], explanation: 'invariance' } }] };
  await writeFile(path.join(root, 'agent-tool-state.json'), JSON.stringify({ operations: {}, sources: {}, schemas: {}, observations,
    cases: { 'C1@1': { startedAt: '2026-01-01T00:00:00Z', planAt: '2026-01-01T00:00:02Z', plan, assertions: {}, aliases: {}, observations: Object.keys(observations), errors: [] } } }));
  let reviews = 0;
  const adapter = createRequirementAgent({}, { workDir: root, review: async prompt => {
    if (!prompt.includes('"kind":"measurement"')) return { accepted: true, errors: [] };
    reviews++; assert.match(prompt, /JSON_OBJECT/); assert.doesNotMatch(prompt, /"hash":"different"|"hash":"changed"/);
    return { accepted: false, errors: ['actual.query.sql maps name to reason instead of name'] };
  }, agentModel: async ({ call }) => ({ close: async () => {}, async turn() {
    const compare = observationId => call('test_assert', { args: { checkId: 'unchanged', observationId, field: ['rows', 0, 'hash'] } }, observationId);
    await call('test_measure', { args: { checkId: 'unchanged', observationId: 'baseline', field: ['rows', 0, 'hash'] } }, 'preflight');
    await assert.rejects(compare('mismatch'), /maps name to reason/);
    assert.equal((await compare('corrected')).passed, true);
    assert.equal((await compare('productFailure')).passed, false);
    await call('test_finish', { args: { actual: 'Corrected query passed, later genuine data change failed.' } }, 'finish');
    return { text: 'recorded' };
  } }) });
  const result = await adapter.execute({ item: { caseId: 'C1' }, attempt: 1, reports: root, checkOutput: value => value,
    headers: ['预期结果'], row: ['1. existing records unchanged'], source: {}, resourceNames: [], mutations: [], standards: '' });
  assert.equal(reviews, 1); assert.equal(result.status, '失败'); assert.equal(result.assertions.length, 2);
  const saved = JSON.parse(await readFile(path.join(root, 'agent-tool-state.json'), 'utf8'));
  assert.equal(saved.cases['C1@1'].errors.length, 1);
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
  const request = await runtime.performSpec({ kind: 'http', access: 'read', resource: 'platform', method: 'GET',
    path: '/amount?account={account}', query: { period: { $input: 'period' }, token: 'never-export' }, authenticated: false }, { account: 'A & B', period: '2027-04' }, resource);
  assert.deepEqual(request.request.query, { account: 'A & B', period: '2027-04', token: '[REDACTED]' });
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

test('a page screenshot cannot launder captured API values into a page assertion', async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'agent-page-origin-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(path.join(root, 'source.js'), 'GET /amount returns {key:"A",amount:100}; read-only');
  const server = createServer((req, res) => {
    if (req.url === '/amount') { res.setHeader('content-type', 'application/json'); return setTimeout(() => res.end('{"key":"A","amount":100}'), 100); }
    res.setHeader('content-type', 'text/html');
    res.end('<input id="key" value="A"><input id="amount" value="0"><div id="busy">loading</div><script>fetch("/amount").then(r=>r.json()).then(()=>document.querySelector("#busy").remove())</script>');
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const adapter = createRequirementAgent({}, { workDir: root, review: async () => ({ accepted: true, errors: [] }),
    agentModel: async ({ call }) => ({ close: async () => {}, async turn() {
      const invoke = (name, args) => call('test_' + name, { args }, name);
      const source = await invoke('source', { action: 'read', path: 'source.js' });
      await invoke('register', { name: 'amount', reason: 'Fixture read contract', sourceRefs: [source.sourceRef], spec: { kind: 'http', resource: 'platform', method: 'GET', path: '/amount', access: 'read', authenticated: false } });
      await invoke('observe', { operation: 'amount', input: {}, subject: { key: 'A' } });
      await invoke('plan', { version: 1, steps: ['Open page and wait until business load finishes'], prerequisites: [], checks: [
        { id: 'amount', line: 1, requirement: '页面金额100元', channel: 'page', subject: { key: 'A' }, expected: 100,
          operator: 'equals', type: 'number', unit: '元', basis: { quote: '页面金额100元' } }] });
      await invoke('browser', { resource: 'platform', action: 'goto', path: '/' });
      const observed = await invoke('browser', { resource: 'platform', action: 'observe', ready: { selector: '#busy', state: 'hidden' }, fields: { key: { selector: '#key', read: 'input' }, amount: { selector: '#amount', read: 'input' } } });
      assert.equal(observed.data.network.find(entry => entry.path === '/amount').body.amount, 100);
      const args = { checkId: 'amount', observationId: observed.observationId, field: ['network', 0, 'body', 'amount'], identity: [{ dimension: 'key', field: ['values', 'key'] }] };
      await assert.rejects(invoke('assert', args), /observed DOM values/);
      await assert.rejects(invoke('assert', { ...args, field: ['values', 'amount'], identity: [{ dimension: 'key', field: ['network', 0, 'body', 'key'] }] }), /observed DOM values/);
      const compared = await invoke('assert', { ...args, field: ['values', 'amount'] });
      assert.equal(compared.passed, false);
      await invoke('finish', { actual: '页面实际0元，接口100元；页面不符合预期。', classification: '产品' });
      return { text: 'Recorded page failure' };
    } }) });
  const result = await adapter.execute({ item: { caseId: 'PAGE' }, attempt: 1, checkOutput: value => value, reports: root, sourceRoot: root,
    source: {}, headers: ['预期结果'], row: ['1. 页面金额100元'], standards: '', resourceNames: ['platform'],
    useRead: (_, call) => call({ base_url: 'http://127.0.0.1:' + server.address().port }) });
  assert.equal(result.status, '失败');
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
  const priorObservation = { observationId: 'old-observation', caseKey: 'C1@1', channel: 'api',
    data: { body: { key: 'A', amount: 100 } }, at: '2026-01-01T00:00:00Z' };
  await mkdir(path.join(root, 'diagnostics'));
  await writeFile(path.join(root, 'diagnostics', 'old-error.json'), JSON.stringify({ tool: 'test_assert',
    args: { checkId: 'balance', field: ['body', 'count'] }, code: 'Error', message: 'Element count is not money' }));
  await writeFile(path.join(root, 'agent-tool-state.json'), JSON.stringify({ version: 1, operations: {}, sources: {}, schemas: {},
    observations: { 'old-observation': priorObservation }, cases: { 'C1@1': { observations: ['old-observation'], aliases: {},
      errors: [{ path: 'old-error.json' }, { path: 'missing-error.json' }] } } }));
  let captured;
  const agentModel = async ({ call }) => ({ close: async () => {}, async turn(prompt) {
    const invoke = (name, args) => call('test_' + name, { args }, 'call-' + name);
    assert.equal(JSON.parse(prompt).priorAttemptReference[0].caseKey, 'C1@1');
    const priorErrors = JSON.parse(prompt).priorAttemptReference[0].diagnostics;
    assert.equal(priorErrors[0].message, 'Element count is not money');
    assert.deepEqual(priorErrors[0].args.field, ['body', 'count']);
    assert.equal(priorErrors[1].unavailable, true);
    const history = await invoke('evidence', { observationId: 'old-observation' });
    assert.equal(history.historical, true); assert.equal(history.usableForCurrentAssertion, false);
    assert.equal(history.at, priorObservation.at); assert.equal(history.data.body.amount, 100);
    await assert.rejects(invoke('alias', { alias: 'A', value: 'A', observationId: 'old-observation', field: ['body', 'key'], purpose: 'historical identity must not bind' }), /case attempt/);
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
    await assert.rejects(invoke('plan', stringLine), /checks\[0\]\.line must be (?:a 1-based )?integer/);
    const staleBaseline = structuredClone(plan); staleBaseline.checks[0].basis = { observationId: 'old-observation', field: ['body', 'amount'], explanation: 'historical baseline' };
    await assert.rejects(invoke('plan', staleBaseline), /case attempt/);
    await invoke('plan', plan);
    assert.deepEqual((await invoke('plan', { action: 'inspect' })).plan, plan);
    const badExplanation = structuredClone(plan); badExplanation.checks[0].basis.explanation = 'rewritten';
    await assert.rejects(invoke('plan', badExplanation), /checks\[0\]\.basis\.explanation is frozen/);
    await invoke('plan', { identityCorrections: [{ checkId: 'balance', subject: { accountId: 'A' } }] });
    await invoke('plan', { identityCorrections: [{ checkId: 'balance', subject: { account: 'A' } }] });
    await assert.rejects(invoke('assert', { checkId: 'balance', observationId: 'old-observation', field: ['body', 'amount'], identity: [{ dimension: 'account', field: ['body', 'key'] }] }), /case attempt/);
    const observed = await invoke('observe', { operation: 'budget', input: {}, subject: { account: 'A' } });
    await assert.rejects(invoke('assert', { checkId: 'balance', observationId: observed.observationId, field: ['body', 'amount'],
      identity: [{ dimension: 'account', field: ['body', 'key'] }],
      evidenceRefs: [{ observationId: 'old-observation', fields: [['body', 'key']] }] }), /case attempt/);
    await assert.rejects(invoke('assert', { checkId: 'balance', observationId: observed.observationId, field: ['body', 'amount'], identity: [{ dimension: 'account', field: ['body', 'wrong'] }] }));
    captured = await invoke('assert', { checkId: 'balance', observationId: observed.observationId, field: ['body', 'amount'], identity: [{ dimension: 'account', field: ['body', 'key'] }] });
    await assert.rejects(invoke('plan', { identityCorrections: [{ checkId: 'balance', subject: { accountId: 'A' } }] }), /compared check/);
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
