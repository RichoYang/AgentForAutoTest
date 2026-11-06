import test from 'node:test';
import assert from 'node:assert/strict';
import { requirementAgentTools } from '../src/runner/requirement-agent.js';
import { validateToolArguments } from '../src/runner/requirement-agent-contracts.js';
import { checkCoverage, recordGap, resolveGaps } from '../src/runner/requirement-agent-progress.js';
import { runRequirementTest } from '../src/runner/requirement-test.js';
import { executeCases } from '../src/runner/requirement-execution.js';

test('native tool schemas expose actual fields, preserve dynamic inputs and locate malformed nested fields', () => {
  for (const tool of requirementAgentTools) assert.ok(tool.inputSchema.properties.args.properties || tool.inputSchema.properties.args.anyOf);
  validateToolArguments('observe', { operation: 'discovered_business_entry', input: { newlyDiscoveredField: { value: 1 } } });
  assert.throws(() => validateToolArguments('assert', { checkId: 'c', observationId: 'o', field: 'body.amount' }), /args.field/);
  assert.throws(() => validateToolArguments('register', { name: 'entry', sourceRefs: ['S'], reason: 'source-backed',
    spec: { kind: 'http', resource: 'r', access: 'read', unknownExecutionCode: 'exec' } }), /spec.unknownExecutionCode/);
  assert.throws(() => validateToolArguments('snapshot', { resource: 'r', database: 'd', table: 't', scope: {}, pageSize: -1 }), /pageSize/);
});
test('independent check coverage counts identities once and retains historical failures separately', () => {
  const current = { plan: { checks: [{ id: 'a' }, { id: 'b' }] }, assertions: {
    a: [{ compared: true, passed: false }, { compared: true, passed: true }, { compared: true, passed: true }] } };
  const coverage = checkCoverage(current);
  assert.equal(coverage.total, 2); assert.equal(coverage.compared, 1); assert.equal(coverage.historicalAttempts, 3);
  assert.equal(coverage.checks[0].current, 'passed'); assert.equal(coverage.checks[0].historicalFailure, true);
});
test('repeated gaps remain unresolved until the target succeeds, even after new evidence was still rejected', () => {
  const current = { observations: [], assertions: {} };
  const error = { code: 'contract_review', review: { disposition: 'missing_evidence', findings: [{ field: 'query.scope', code: 'scope_missing', reason: 'tenant not established', next: 'read the tenant binding' }] } };
  const details = { tool: 'test_assert', args: { checkId: 'invariance' }, error, evidenceVersion: 'v1' };
  assert.equal(recordGap(current, details).unchanged, 0);
  current.observations.push('irrelevant-new-read');
  assert.equal(recordGap(current, { ...details, args: { ...details.args, observationId: 'new-sql' } }).unchanged, 1);
  assert.equal(recordGap(current, { ...details, evidenceVersion: 'v2' }).unchanged, 2);
  assert.equal(Object.values(current.gaps)[0].evidenceChanges, 1);
  resolveGaps(current, 'test_assert', { checkId: 'other' }); assert.equal(Object.values(current.gaps)[0].resolved, false);
  resolveGaps(current, 'test_assert', { checkId: 'invariance' }); assert.equal(Object.values(current.gaps)[0].resolved, true);
});

test('a persistent field gap is not reset by differently bundled review findings or another alias', () => {
  const current = { assertions: {} }, common = { field: 'plan.checks.invariant', code: 'scope_missing', reason: 'tenant missing', next: 'prove tenant' };
  const record = findings => recordGap(current, { tool: 'test_plan', args: {}, evidenceVersion: 'same',
    error: { review: { disposition: 'missing_evidence', findings } } });
  assert.equal(record([common]).unchanged, 0);
  assert.equal(record([common, { field: 'plan.checks.other', code: 'field_semantics' }]).unchanged, 1);
  assert.equal(record([common, { field: 'plan.checks.third', code: 'identity' }]).unchanged, 2);
  const alias = name => recordGap(current, { tool: 'test_alias', args: { alias: name }, evidenceVersion: 'same', error: { safeMessage: 'Wrong path' } });
  assert.equal(alias('first').unchanged, 0); assert.equal(alias('second').unchanged, 0);
});
test('cancelled jobs remain terminal before intake, resource access or adapter upgrade can mutate their journals', async () => {
  const job = { id: 'JOB-isolated-cancelled', status: 'cancelled', requirement: {} };
  assert.equal((await runRequirementTest(job, null, () => { throw new Error('No output expected'); })).requirementWait, 'requirement_cancelled');
  const journal = { executionBinding: 'old-code', results: { C: { status: '失败' } }, mutations: [{ cleanup: { verified: true } }] };
  const before = structuredClone(journal);
  await assert.rejects(executeCases({ job, journal }), { code: 'requirement_cancelled' });
  assert.deepEqual(journal, before);
});

test('changing mutation request ids or reviewer wording cannot reset the same unresolved object gap', () => {
  const current = {};
  const call = (id, code) => recordGap(current, { tool: 'test_mutate',
    args: { id, operation: 'create', businessKey: 'owned-A' }, evidenceVersion: 'original-evidence',
    error: { review: { disposition: 'missing_evidence', findings: [{ field: 'snapshot.children', code, reason: 'Children not queried' }] } } });
  assert.equal(call('first', 'incomplete_collection').unchanged, 0);
  assert.equal(call('second', 'side_effect_snapshot').unchanged, 1);
  assert.equal(call('third', 'incomplete_collection').unchanged, 2);
  resolveGaps(current, 'test_mutate', { id: 'corrected', operation: 'create', businessKey: 'owned-A' });
  assert.equal(Object.values(current.gaps).every(gap => gap.resolved), true);
});
