import assert from 'node:assert/strict';
import { mkdtemp, readFile, rename, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { ControlReceipts, controlDigest } from '../src/shared/control-receipts.js';
import { JsonStore } from '../src/shared/store.js';

const cancelled = {
  id: 'JOB-cancelled', projectId: 'fixture-ltx', stage: 'requirement_test',
  status: 'cancelled', lease: null, events: [{ type: 'cancelled', processesExited: true }],
};
const running = {
  id: 'JOB-running', projectId: 'fixture-tpm', stage: 'requirement_test', status: 'running', events: [],
  lease: { id: 'LEASE-fixture', runnerId: 'runner', expiresAt: '2099-01-01T00:00:00.000Z' },
  requirement: { checkpoint: { orderedCases: ['row-7', 'row-9'], next: 1, obsolete: true } },
};
const legacy = {
  version: 1, jobs: [cancelled, running], runners: {},
  processedMessages: { 'old-message': 'JOB-cancelled' },
  effects: { 'created-once': { recordId: 'fixture-record' } },
  requirementDeliveries: { fixture: { messageId: 'attachment-ack' } },
  // Retained foreign/legacy data must round-trip without the Store interpreting it.
  legacyCleanup: [{ jobId: running.id, recordId: 'fixture-record', phase: 'prepared', restored: false }],
};

async function setup(t, state = legacy) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'agentos-store-contract-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const file = path.join(directory, 'state.json');
  await writeFile(file, JSON.stringify(state) + '\n');
  return new JsonStore(file);
}

async function assertPersisted(store, expected) {
  assert.deepEqual(JSON.parse(await readFile(store.file, 'utf8')), expected);
  assert.deepEqual(await store.read(), expected);
  assert.deepEqual(await new JsonStore(store.file).read(), expected);
}

test('old requirement state round-trips deep edits, historical cancellation, lease and effect deduplication', async t => {
  t.mock.method(Date, 'now', () => Date.parse('2026-11-18T00:00:00Z'));
  const store = await setup(t);
  const expected = structuredClone(legacy);
  const bytes = await readFile(store.file);
  assert.equal(await store.leaseNext('other-runner', ['requirement_test']), null);
  assert.equal(await store.transact(s => s.jobs[0].status), 'cancelled');
  assert.deepEqual(await store.transactEffect('created-once', () => assert.fail('replayed an effect')),
    legacy.effects['created-once']);
  assert.deepEqual(await readFile(store.file), bytes);
  const edit = state => {
    const checkpoint = state.jobs[1].requirement.checkpoint;
    checkpoint.orderedCases.splice(1, 0, 'row-8');
    delete checkpoint.obsolete;
    checkpoint.next++;
    state.jobs[1].events.push({ type: 'progress', row: 'row-8' });
    return checkpoint;
  };
  assert.deepEqual(await store.transact(edit), edit(expected));
  const result = { recordId: 'second-receipt' };
  assert.deepEqual(await store.transactEffect('new-effect', () => result), result);
  expected.effects['new-effect'] = result;
  expected.retention = { undated: { 'effects:new-effect': Date.now() } };
  await assertPersisted(store, expected);
});

test('detached reads, caller values and transaction returns cannot mutate committed state', async t => {
  const store = await setup(t);
  const expected = structuredClone(legacy);
  const supplied = { nested: { rows: [7] }, optional: undefined };
  const returned = await store.transact(state => {
    state.newValue = supplied;
    return { fromDraft: state.jobs[1], supplied, callable: () => 3 };
  });
  assert.equal(returned.callable(), 3);
  assert.equal(returned.supplied, supplied);
  expected.newValue = { nested: { rows: [7] } };
  supplied.nested.rows.push(8);
  returned.fromDraft.lease.expiresAt = null;
  const read = await store.read();
  read.jobs[0].status = 'queued';
  const selected = await store.select(s => new Map([['job', s.jobs[1]]]));
  selected.get('job').events.push({ type: 'not persisted' });
  await assertPersisted(store, expected);
});

test('failed callbacks and JSON encoding release the queue without committing partial state', async t => {
  const store = await setup(t);
  const expected = structuredClone(legacy);
  const started = Promise.withResolvers();
  const release = Promise.withResolvers();
  const failed = store.transact(async state => {
    state.jobs[0].status = 'queued';
    started.resolve();
    await release.promise;
    throw new RangeError('fixture failure');
  });
  const rejected = assert.rejects(failed, { name: 'RangeError', message: 'fixture failure' });
  await started.promise;
  const next = store.transact(state => {
    assert.equal(state.jobs[0].status, 'cancelled');
    return ++state.jobs[1].requirement.checkpoint.next;
  });
  const encodingFailure = assert.rejects(store.transact(state => { state.invalid = 1n; }), TypeError);
  try {
    await assertPersisted(store, expected);
  } finally {
    release.resolve();
  }
  await rejected;
  assert.equal(await next, ++expected.jobs[1].requirement.checkpoint.next);
  await encodingFailure;
  assert.equal(await store.transact(state => ++state.jobs[1].requirement.checkpoint.next),
    ++expected.jobs[1].requirement.checkpoint.next);
  await assertPersisted(store, expected);
});

test('durable control receipt shares its outer draft with nested transactions and reads', async t => {
  const store = await setup(t);
  const receipts = new ControlReceipts(store);
  const meta = {
    id: '12345678-1234-1234-1234-123456789abc', route: '/fixture',
    digest: controlDigest('/fixture', {}), runnerId: 'runner', jobId: running.id,
  };
  const result = await receipts.commit(meta, async () => {
    await store.transact(state => { state.jobs[1].requirement.checkpoint.next++; });
    const pending = await store.read();
    assert.equal(pending.jobs[1].requirement.checkpoint.next, 2);
    pending.jobs[1].requirement.checkpoint.next = -1;
    return store.select(state => state.jobs[1].requirement.checkpoint.next);
  });
  assert.equal(result, 2);
  const reopened = new JsonStore(store.file);
  assert.equal((await reopened.getJob(running.id)).requirement.checkpoint.next, 2);
  assert.equal(await new ControlReceipts(reopened).commit(meta, () => assert.fail('replayed a receipt')), 2);
  const expected = structuredClone(legacy);
  expected.jobs[1].requirement.checkpoint.next = 2;
  const { controlReceipts, ...remaining } = await reopened.read();
  assert.equal(controlReceipts[meta.id].digest, meta.digest);
  assert.deepEqual(remaining, expected);
});

test('external atomic replacement invalidates even a warm cache before the next transaction', async t => {
  const store = await setup(t);
  assert.equal((await store.read()).jobs[1].lease.runnerId, 'runner');
  const replacement = structuredClone(legacy);
  replacement.jobs[1].lease.runnerId = 'extern';
  const original = await readFile(store.file, 'utf8');
  const raw = JSON.stringify(replacement) + '\n';
  assert.equal(raw.length, original.length);
  await writeFile(store.file + '.external', raw);
  await rename(store.file + '.external', store.file);
  assert.equal(await store.transact(state => {
    state.jobs[1].requirement.checkpoint.next++;
    return state.jobs[1].lease.runnerId;
  }), 'extern');
  replacement.jobs[1].requirement.checkpoint.next++;
  await assertPersisted(store, replacement);
});

test('a missing file can be initialized and noncanonical JSON retains its read semantics', async t => {
  const seeded = await setup(t);
  const store = new JsonStore(seeded.file + '.new');
  const empty = { version: 1, jobs: [], runners: {}, processedMessages: {} };
  assert.deepEqual(await store.read(), empty);
  await store.transact(state => state);
  await assertPersisted(store, empty);
  await writeFile(store.file, '{ "jobs":[], "numeric":[-0,1e400], "__proto__":{"own":true} }');
  const read = await store.read();
  assert.equal(Object.getPrototypeOf(read), Object.prototype);
  assert.equal(Object.hasOwn(read, '__proto__'), true);
  assert.deepEqual(read.numeric, [-0, Infinity]);
  assert.deepEqual(await store.transact(state => state.numeric), [-0, Infinity]);
  assert.deepEqual((await store.read()).numeric, [0, null]);
});
