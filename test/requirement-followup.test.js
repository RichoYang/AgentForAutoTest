import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createRequirementAdapter } from '../src/runner/requirement-adapter.js';

test('declarative adapter runs observable HTTP actions, scopes fixture restoration and registers special evidence', async t => {
  const directory = await mkdtemp(path.join(tmpdir(), 'requirement-adapter-'));
  const fixtures = new Set();
  const server = createServer(async (req, res) => {
    const url = new URL(req.url, 'http://localhost');
    if (url.pathname === '/export') {
      res.setHeader('content-type', 'text/csv');
      return res.end('name,amount\r\n"demo, amount",3\r\n');
    }
    let key = url.searchParams.get('code');
    if (req.method === 'POST') {
      let body = '';
      for await (const chunk of req) body += chunk;
      key = JSON.parse(body).code;
      fixtures.add(key);
    }
    if (req.method === 'DELETE') fixtures.delete(key);
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ exists: fixtures.has(key), key }));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => { await new Promise(resolve => server.close(resolve)); await rm(directory, { recursive: true, force: true }); });
  const resource = { base_url: 'http://127.0.0.1:' + server.address().port };
  const lookup = { kind: 'http', path: '/fixture', outputs: { exists: ['exists'], key: ['key'] } };
  const execution = { operations: {
    fixture: { kind: 'fixture', resource: 'platform', key: 'code', lookup,
      observations: [{ id: 'exists', label: '夹具', type: 'boolean', field: ['exists'] }],
      create: { ...lookup, method: 'POST' }, remove: { ...lookup, method: 'DELETE' } },
    export: { kind: 'csv', resource: 'platform', path: '/export',
      observations: [{ id: 'exportAmount', label: '导出金额', type: 'number', encoding: 'decimal-text', field: ['rows', 0, 1] }],
      codeChain: { repositories: ['sample'], files: ['test fixture HTTP handler'] },
      fixVerification: { issue_id: 'FIX-1', historical_symptom: '曾丢失金额列' } },
  } };
  const plan = async () => ({ missing: [], steps: [
    { operation: 'fixture', input: {}, checks: [{ field: ['exists'], operator: 'equals', expected: true, assertion: 1 }] },
    { operation: 'export', input: {}, checks: [{ field: ['rows', 0, 1], operator: 'equals', expected: 3, assertion: 2 }] },
  ] });
  const adapter = createRequirementAdapter(execution, { plan, workDir: directory });
  const mutations = [];
  const scope = { source: { id: 'sample', revision: 1 }, item: { caseId: 'C1' }, headers: ['预期结果'],
    row: ['1. 夹具存在\n2. 导出金额为 3'], reports: directory, runPrefix: 'AOS_sample',
    useRead: (_, fn) => fn(resource), checkOutput: x => x, standards: '测试后必须清理',
    repositories: [{ name: 'sample', commit: 'example' }], mutations,
    async invoke(intent, fn) {
      const key = 'C1:' + intent.id;
      const receipt = await fn(resource, key);
      mutations.push({ key, caseId: 'C1', intent, receipt });
      return receipt;
    },
    restore: (key, operation, fn) => { assert.equal(operation, 'delete'); return fn(resource, mutations.find(mutation => mutation.key === key)); },
  };
  assert.equal((await adapter.verifyDeployment(scope)).verified, false);
  const result = await adapter.execute({ ...scope, preparation: await adapter.prepare(scope) });
  assert.equal(result.status, '通过');
  assert.equal(result.specialty.export_validations[0].status, '通过');
  assert.equal(result.specialty.fix_verifications[0].outcome, '已修复');
  assert.equal(result.specialty.code_chains[0].entry, '/export');
  assert.equal(fixtures.size, 1);
  assert.equal((await adapter.reconcile({ ...scope, intent: mutations[0].intent, key: mutations[0].key })).status, 'applied');
  const cleanup = await adapter.cleanup(scope);
  assert.equal(cleanup.verified, true);
  assert.equal(cleanup.records[0].status, '已清理');
  assert.equal(fixtures.size, 0);
});
