import test from 'node:test';
import assert from 'node:assert/strict';
import { buildRecordSnapshot, compareRecordSnapshots } from '../src/runner/requirement-snapshot.js';

const contract = { resource: 'isolated', database: 'sample', table: 'items', scope: { tenant: 'A' },
  key: ['id'], fields: ['id', 'tenant', 'amount', 'date', 'note'], schemaFingerprint: 'schema-v1' };
const proof = { complete: true, expectedCount: 2, consistency: 'repeatable-read', pages: 2,
  startedAt: '2026-11-05T00:00:00Z', finishedAt: '2026-11-05T00:00:01Z' };
const rows = [{ id: '9007199254740993', tenant: 'A', amount: '0.0100', date: '2026-12-31 23:59:59.123456', note: null },
  { id: '9007199254740994', tenant: 'A', amount: '9999999999999.9999', date: '2027-01-01', note: 'x'.repeat(50000) }];
test('complete snapshots retain exact values, canonical row order and explain added/removed/changed records', () => {
  const before = buildRecordSnapshot(contract, rows, proof);
  const reordered = buildRecordSnapshot(contract, [...rows].reverse(), proof);
  assert.equal(before.hash, reordered.hash);
  assert.equal(compareRecordSnapshots(before, reordered).equal, true);
  const after = buildRecordSnapshot(contract, [{ ...rows[0], amount: '0.0200' }, { ...rows[1], id: '9007199254740995' }], proof);
  const diff = compareRecordSnapshots(before, after);
  assert.equal(diff.equal, false); assert.equal(diff.added.length, 1); assert.equal(diff.removed.length, 1);
  assert.deepEqual(diff.changed[0].fields.map(f => f.name), ['amount']);
  assert.equal(diff.changed[0].fields[0].before, '0.0100');
  assert.equal(before.rows[1].note.length, 50000);
});
test('snapshot completeness is enforced for empty sets, scope, duplicate keys, missing fields and unsafe numbers', () => {
  const empty = buildRecordSnapshot(contract, [], { ...proof, expectedCount: 0, pages: 1 });
  assert.equal(empty.count, 0); assert.equal(compareRecordSnapshots(empty, empty).equal, true);
  assert.throws(() => buildRecordSnapshot(contract, rows, { ...proof, expectedCount: 3 }), /count/i);
  assert.throws(() => buildRecordSnapshot(contract, rows, { ...proof, complete: false }), /complete/i);
  assert.throws(() => buildRecordSnapshot(contract, [rows[0], rows[0]], proof), /duplicate/i);
  assert.throws(() => buildRecordSnapshot(contract, [{ ...rows[0], tenant: 'B' }, rows[1]], proof), /scope/i);
  const missing = { ...rows[0] }; delete missing.note;
  assert.throws(() => buildRecordSnapshot(contract, [missing, rows[1]], proof), /field/i);
  assert.throws(() => buildRecordSnapshot(contract, [{ ...rows[0], id: 9007199254740992 }, rows[1]], proof), /exact/i);
  assert.throws(() => compareRecordSnapshots(empty, { ...empty, contract: { ...contract, scope: { tenant: 'B' } } }), /contract/i);
});
