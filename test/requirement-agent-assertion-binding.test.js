import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { createServer } from 'node:http';
import { createRequirementAgent } from '../src/runner/requirement-agent.js';
import { evaluateDerivedAssertion } from '../src/runner/requirement-assertions.js';
import { assertionBinding, compareAgentObservation } from '../src/runner/requirement-agent-assertion-binding.js';

test('derived actual values preserve decimal arithmetic and never turn absent operands into zero', () => {
  const rule = { assertion: 'remaining', type: 'number', operator: 'equals', expected: '0.1', unit: '元' };
  const terms = [{ field: ['allocated'], sign: 1 }, { field: ['applied'], sign: -1 }];
  const result = evaluateDerivedAssertion({ allocated: '0.3', applied: '0.2' }, rule, terms);
  assert.equal(result.passed, true); assert.equal(result.exactObserved, '0.1'); assert.equal(result.expected, '0.1');
  assert.equal(result.actualInputs.length, 2);
  assert.equal(evaluateDerivedAssertion({ allocated: '0.3', applied: null }, rule, terms).compared, false);
  assert.equal(evaluateDerivedAssertion({ allocated: '0.3', applied: '' }, rule, terms).compared, false);
  assert.equal(evaluateDerivedAssertion({ allocated: '0.4', applied: '0.2' }, rule, terms).passed, false);
  assert.throws(() => evaluateDerivedAssertion({}, rule, [{ field: ['amount'], sign: 0 }]), /sign/);
  const check = { ...rule, id: 'balance', channel: 'api' };
  for (const terms of [{ field: ['amount'] }, [null]]) {
    assert.throws(() => assertionBinding(check, { data: {} }, { calculation: { terms } }, {}), /calculation.terms must be an array/);
  }
  assert.equal(compareAgentObservation(check, { data: { status: 200, body: { balance: null } } }, { field: ['body', 'balance'] }).missing, true);
  const unavailable = compareAgentObservation(check, { data: { status: 503, body: { error: 'Unavailable' } } }, { field: ['body', 'balance'] });
  assert.equal(unavailable.compared, false); assert.equal(unavailable.missing, undefined);
});

test('SQL binding includes inspected schema proof only from the measured resource and database', () => {
  const schema = { resource: 'database', database: 'isolated', table: 'budget', columns: [{ Field: 'id' }, { Field: 'amount' }],
    indexes: [{ Key_name: 'PRIMARY', Column_name: 'id' }], create: 'CREATE TABLE budget(id BIGINT PRIMARY KEY, amount DECIMAL(18,4))' };
  const binding = assertionBinding({ requirement: '预算记录不变', channel: 'database', type: 'text' },
    { data: { rows: [{ hash: 'opaque' }] }, input: { resource: 'database', database: 'isolated', sql: 'SELECT hash FROM budget' } },
    { field: ['rows', 0, 'hash'] }, {}, { schemas: { correct: schema,
      wrongResource: { ...schema, resource: 'other' }, wrongDatabase: { ...schema, database: 'other' },
      unusedTable: { ...schema, table: 'other' } } });
  assert.deepEqual(binding.databaseSchemas, [schema]);
  assert.equal(binding.actual, undefined); assert.equal(binding.selected[0].valueType, 'string');
});

test('binding receives verified array identity and sibling checks without trusting caller proof or hiding wrong results', async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'agent-array-binding-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(path.join(root, 'source.js'), 'GET /budget is read-only. rows contain key, period, allocated, invalid and remaining. Invalid occupancy is excluded from remaining.');
  const server = createServer((req, res) => { res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ rows: [{ key: 'other', period: '2026-10', allocated: 900, invalid: 777, remaining: 80 },
      { key: 'A', period: '2026-11', allocated: 100, invalid: 777, remaining: 75 }] })); });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const expectation = '分配100元、无效占用777元不扣减，剩余80元。';
  let bindingReviews = 0;
  const adapter = createRequirementAgent({}, { workDir: root, review: async prompt => {
    const payload = JSON.parse(prompt.slice(prompt.lastIndexOf('\n\n') + 2));
    if (payload.kind !== 'assertion_binding') return { accepted: true, errors: [] };
    bindingReviews++;
    assert.equal(payload.planContext.originalExpectation, expectation);
    assert.deepEqual(payload.planContext.checks.map(item => item.id), ['allocated', 'invalid', 'remaining']);
    assert.ok(payload.planContext.checks.every(item => !Object.hasOwn(item, 'expected')));
    assert.equal(payload.actual, undefined);
    assert.deepEqual(payload.verifiedIdentity.map(item => item.value), ['A', '2026-11']);
    assert.ok(payload.verifiedIdentity.every(item => item.field[2] === 1));
    if (payload.selected.some(item => item.field[2] !== 1)) return { accepted: false, errors: ['Identity belongs to a different row'] };
    return { accepted: true, errors: [] };
  }, agentModel: async ({ call }) => ({ close: async () => {}, async turn() {
    const invoke = (tool, args) => call('test_' + tool, { args }, tool);
    const source = await invoke('source', { action: 'read', path: 'source.js' });
    await invoke('register', { name: 'budget', sourceRefs: [source.sourceRef], reason: 'array contract',
      spec: { kind: 'http', resource: 'platform', path: '/budget', method: 'GET', access: 'read', authenticated: false } });
    await invoke('observe', { operation: 'budget', input: {} });
    await invoke('plan', { version: 1, steps: ['Read the identified row and compare each component'], prerequisites: [],
      checks: [['allocated', '分配100元', 100], ['invalid', '无效占用777元不扣减', 777], ['remaining', '剩余80元', 80]].map(([id, requirement, expected]) => ({
        id, line: 1, requirement, channel: 'api', type: 'number', operator: 'equals', expected,
        subject: { key: 'A', period: '2026-11' }, basis: { quote: expectation } })) });
    const observed = await invoke('observe', { operation: 'budget', input: {} });
    const identity = row => ['key', 'period'].map(dimension => ({ dimension, field: ['body', 'rows', row, dimension] }));
    await assert.rejects(invoke('assert', { checkId: 'remaining', observationId: observed.observationId,
      field: ['body', 'rows', 0, 'remaining'], identity: identity(0), verifiedIdentity: identity(1) }), /identity differs/);
    assert.equal(bindingReviews, 0);
    await assert.rejects(invoke('assert', { checkId: 'remaining', observationId: observed.observationId,
      field: ['body', 'rows', 0, 'remaining'], identity: identity(1) }), /different row/);
    for (const id of ['allocated', 'invalid', 'remaining']) {
      const result = await invoke('assert', { checkId: id, observationId: observed.observationId,
        field: ['body', 'rows', 1, id], identity: identity(1), sourceRefs: [source.sourceRef] });
      assert.equal(result.passed, id !== 'remaining');
      if (id === 'remaining') { assert.equal(result.expected, 80); assert.equal(result.observed, 75); }
    }
    await invoke('finish', { actual: 'Correct row has remaining 75; unrelated row with 80 is rejected.' });
    return { text: 'Recorded' };
  } }) });
  const result = await adapter.execute({ item: { caseId: 'C1' }, reports: root, sourceRoot: root, checkOutput: value => value,
    headers: ['预期结果'], row: [expectation], source: {}, standards: '', mutations: [], resourceNames: ['platform'],
    useRead: (_, fn) => fn({ base_url: 'http://127.0.0.1:' + server.address().port }) });
  assert.equal(result.status, '失败'); assert.equal(result.assertions.length, 3); assert.equal(bindingReviews, 4);
});

test('assertion binding rejects wrong indicators and count-as-money, then records actual computation and missing DOM', async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'agent-assertion-semantic-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(path.join(root, 'source.js'), 'GET /budget is read-only. allocated is the total budget; applied is occupied money. Remaining = allocated - applied. diagnostic is unrelated.');
  const server = createServer((req, res) => {
    if (req.url === '/budget') { res.setHeader('content-type', 'application/json'); return res.end('{"allocated":30,"applied":20,"diagnostic":10}'); }
    res.setHeader('content-type', 'text/html; charset=utf-8'); res.end('<main><div id="ready" data-ready="true"></div><table><tr><th>已分配</th><th>已申请</th></tr><tr><td>30</td><td>20</td></tr></table></main>');
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  let bindingReviews = 0;
  const adapter = createRequirementAgent({}, { workDir: root, review: async prompt => {
    const payload = JSON.parse(prompt.slice(prompt.lastIndexOf('\n\n') + 2));
    if (payload.kind !== 'assertion_binding') return { accepted: true, errors: [] };
    bindingReviews++;
    assert.ok(payload.selected.length); assert.equal(payload.actual, undefined);
    if (payload.selected.some(item => item.field.at(-1) === 'applied' || item.field.at(-1) === 'diagnostic') && !payload.calculation) {
      return { accepted: false, errors: ['Selected field is not remaining budget; use verified allocated minus applied'] };
    }
    if (payload.selected.some(item => item.measurement?.read === 'count')) return { accepted: false, errors: ['Element count cannot measure money'] };
    return { accepted: true, errors: [] };
  }, agentModel: async ({ call }) => ({ close: async () => {}, async turn() {
    const invoke = (tool, args) => call('test_' + tool, { args }, tool);
    const source = await invoke('source', { action: 'read', path: 'source.js' });
    await invoke('register', { name: 'budget', sourceRefs: [source.sourceRef], reason: 'module fixture',
      spec: { kind: 'http', resource: 'platform', path: '/budget', method: 'GET', access: 'read', authenticated: false } });
    await invoke('plan', { version: 1, steps: ['Read API and inspect ready page'], prerequisites: [], checks: [
      { id: 'api', line: 1, requirement: 'API剩余10元', channel: 'api', type: 'number', unit: '元', operator: 'equals', expected: 10, basis: { quote: 'API剩余10元' } },
      { id: 'page', line: 2, requirement: '页面显示剩余10元', channel: 'page', type: 'number', unit: '元', operator: 'equals', expected: 10, basis: { quote: '页面显示剩余10元' } },
    ] });
    const api = await invoke('observe', { operation: 'budget', input: {} });
    for (const field of ['applied', 'diagnostic']) await assert.rejects(invoke('assert', { checkId: 'api', observationId: api.observationId,
      field: ['body', field], sourceRefs: [source.sourceRef] }), /not remaining/);
    const calculated = await invoke('assert', { checkId: 'api', observationId: api.observationId, sourceRefs: [source.sourceRef],
      calculation: { terms: [{ field: ['body', 'allocated'], sign: 1 }, { field: ['body', 'applied'], sign: -1 }] } });
    assert.equal(calculated.passed, true); assert.equal(calculated.expected, 10); assert.equal(calculated.actualInputs[1].value, 20);
    await invoke('browser', { resource: 'platform', action: 'goto', path: '/' });
    const page = await invoke('browser', { resource: 'platform', action: 'observe', ready: { selector: '#ready', attribute: 'data-ready', value: 'true' },
      fields: { remainingCount: { selector: 'td:nth-child(3)', read: 'count' }, remainingText: { selector: 'td:nth-child(3)', read: 'text' } } });
    assert.equal(page.data.measurements.remainingText.matches, 0); assert.match(page.data.dom, /已分配/);
    await assert.rejects(invoke('assert', { checkId: 'page', observationId: page.observationId, field: ['values', 'remainingCount'] }), /count cannot measure/);
    const missing = await invoke('assert', { checkId: 'page', observationId: page.observationId, field: ['values', 'remainingText', 0] });
    assert.equal(missing.compared, true); assert.equal(missing.passed, false); assert.equal(missing.observed, null); assert.equal(missing.missing, true);
    await invoke('finish', { actual: 'API calculated remaining is 10; page remaining column is absent, not zero.' });
    return { text: 'Recorded' };
  } }) });
  const result = await adapter.execute({ item: { caseId: 'C1' }, reports: root, sourceRoot: root, checkOutput: value => value,
    headers: ['预期结果'], row: ['1. API剩余10元\n2. 页面显示剩余10元'], source: {}, standards: '', mutations: [], resourceNames: ['platform'],
    useRead: (_, fn) => fn({ base_url: 'http://127.0.0.1:' + server.address().port }) });
  assert.equal(result.status, '失败'); assert.equal(result.assertions.length, 2); assert.equal(bindingReviews, 5);
  const state = JSON.parse(await readFile(path.join(root, 'agent-tool-state.json'), 'utf8'));
  assert.equal(state.cases['C1@1'].errors.length, 3);
});
