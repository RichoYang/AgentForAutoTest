import test from 'node:test';
import assert from 'node:assert/strict';
import { mutationReadbackHash, validateMutationReadback, repairHttpEnvelope } from '../src/runner/requirement-mutation-measurement.js';

test('mutation measurement rejects transport-relative paths before writes and cleanup', () => {
  const snapshot = { status: 200, body: { item: null, rows: [] } };
  const intent = { verifySpec: { kind: 'http' }, snapshot, ownership: { field: ['item', 'key'] },
    stateFields: [['item', 'key']], before: [{ field: ['item'], operator: 'absent' }], after: [{ field: ['item', 'key'], operator: 'equals', expected: 'owned' }] };
  assert.throws(() => validateMutationReadback(intent), /ownership.*body/);
  const repaired = repairHttpEnvelope(intent);
  assert.deepEqual(repaired.ownership.field, ['body', 'item', 'key']);
  validateMutationReadback(repaired);
  const present = { status: 200, body: { item: { key: 'owned' }, rows: [] } };
  assert.notEqual(mutationReadbackHash(snapshot, repaired.stateFields), mutationReadbackHash(present, repaired.stateFields));
  assert.throws(() => mutationReadbackHash(present, [['body', 'item', 'typo']]), /absent.*typo/);
  assert.notEqual(mutationReadbackHash({ body: { value: null } }, [['body', 'value']]), mutationReadbackHash({ body: { value: 0 } }, [['body', 'value']]));
});

test('legacy envelope correction never changes business payload or guesses a nested field', () => {
  const intent = { verifySpec: { kind: 'http' }, snapshot: { status: 200, body: { item: null } },
    input: { key: 'owned' }, restoreInput: { key: 'owned' }, ownership: { field: ['item', 'key'] }, stateFields: [['item']],
    before: [{ field: ['item'], operator: 'absent' }], after: [{ field: ['item', 'key'], operator: 'equals', expected: 'owned' }] };
  const corrected = repairHttpEnvelope(intent);
  assert.deepEqual(corrected.input, intent.input); assert.deepEqual(corrected.restoreInput, intent.restoreInput);
  assert.deepEqual(intent.ownership.field, ['item', 'key']);
  assert.throws(() => repairHttpEnvelope({ ...intent, ownership: { field: ['unknown', 'key'] } }), /cannot prove/);
  assert.throws(() => mutationReadbackHash({ body: { item: { id: 1 } } }, [['body', 'item', 'key']]), /absent/);
});
