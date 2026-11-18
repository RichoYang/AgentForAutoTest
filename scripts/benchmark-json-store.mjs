import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { pathToFileURL } from 'node:url';

const seed = 0x1652026;
const rounds = 3;
const warmups = 5;
const samples = 24;
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const at = '2026-11-18T00:00:00.000Z';
const expiry = '2099-01-01T00:00:00.000Z';

function fixture(count) {
  let random = seed;
  const token = () => {
    random = (Math.imul(random, 1664525) + 1013904223) >>> 0;
    return random.toString(16).padStart(8, '0');
  };
  const jobs = Array.from({ length: count }, (_, i) => ({
    id: 'JOB-' + i, stage: 'requirement_test', projectId: i % 2 ? 'fixture-tpm' : 'fixture-ltx',
    status: i === count - 1 ? 'running' : 'cancelled',
    lease: i === count - 1 ? { id: 'LEASE-fixture', runnerId: 'fixture', expiresAt: expiry } : null,
    updatedAt: at,
    requirement: { root: 'thread-' + i, checkpoint: { nextCase: 0, attempts: [] } },
    events: [{ type: 'progress', at, message: '合成执行证据' }],
    result: { evidence: Array.from({ length: 24 }, () => ({
      hash: token() + token(), payload: Array.from({ length: 48 }, token).join(''),
    })) },
  }));
  return {
    version: 1, jobs, runners: {}, processedMessages: { 'fixture-message': jobs[0].id },
    effects: { 'fixture-effect': { id: 'fixture-receipt' } },
    retention: { undated: { 'effects:fixture-effect': Date.parse(at) } },
  };
}

const findRunning = state => state.jobs.find(job => job.status === 'running');
function changeJob(state) {
  const job = findRunning(state);
  return ++job.requirement.checkpoint.nextCase;
}

const workloads = {
  noop: store => store.transact(state => findRunning(state).id),
  write: store => store.transact(changeJob),
  'write-reopen': async store => {
    const nextCase = await store.transact(changeJob);
    const reopened = new store.constructor(store.file);
    assert.equal(await reopened.select(state => findRunning(state).requirement.checkpoint.nextCase), nextCase);
    return nextCase;
  },
  read: async store => findRunning(await store.read()).id,
};

function summary(times) {
  const sorted = [...times].sort((a, b) => a - b);
  const medianMs = (sorted[Math.floor((sorted.length - 1) / 2)] + sorted[Math.floor(sorted.length / 2)]) / 2;
  return { medianMs, p95Ms: sorted[Math.ceil(sorted.length * 0.95) - 1] };
}

// Count calls on full snapshots only. Run this probe outside the timed samples.
async function probe(store, run) {
  const parse = JSON.parse, stringify = JSON.stringify, clone = globalThis.structuredClone;
  const counts = { fullClones: 0, fullParses: 0, fullStringifies: 0, replacements: 0 };
  const isState = value => value?.version === 1 && Array.isArray(value.jobs) && value.processedMessages != null;
  const before = await stat(store.file, { bigint: true });
  JSON.parse = function (...args) {
    const value = parse.apply(this, args);
    if (isState(value)) counts.fullParses++;
    return value;
  };
  JSON.stringify = function (...args) {
    if (isState(args[0])) counts.fullStringifies++;
    return stringify.apply(this, args);
  };
  globalThis.structuredClone = function (...args) {
    if (isState(args[0])) counts.fullClones++;
    return clone.apply(this, args);
  };
  try {
    await run(store);
  } finally {
    JSON.parse = parse;
    JSON.stringify = stringify;
    globalThis.structuredClone = clone;
  }
  const after = await stat(store.file, { bigint: true });
  counts.replacements = Number(before.ino !== after.ino);
  return counts;
}

async function measure(Store, file, raw, run, count, name) {
  const measurements = [];
  for (let round = 0; round < rounds; round++) {
    await writeFile(file, raw);
    const store = new Store(file);
    await store.select(findRunning);
    for (let i = 0; i < warmups; i++) await run(store);
    const times = [];
    for (let i = 0; i < samples; i++) {
      const start = performance.now();
      await run(store);
      times.push(performance.now() - start);
    }
    const counts = await probe(store, run);
    const written = name === 'write' || name === 'write-reopen';
    const persisted = JSON.parse(await readFile(file, 'utf8'));
    assert.equal(persisted.jobs.length, count);
    assert.equal(findRunning(persisted).requirement.checkpoint.nextCase, written ? warmups + samples + 1 : 0);
    assert.equal(counts.replacements, Number(written));
    assert.deepEqual(await new Store(file).read(), persisted);
    measurements.push({ times, ...summary(times), counts });
  }
  return { ...summary(measurements.flatMap(round => round.times)), rounds: measurements };
}

const [storeArgument, sourceRevision] = process.argv.slice(2);
if (!storeArgument || !sourceRevision) throw new Error('Usage: node scripts/benchmark-json-store.mjs <store.js> <revision>');
const storePath = path.resolve(storeArgument);
const { JsonStore } = await import(pathToFileURL(storePath));
const directory = await mkdtemp(path.join(os.tmpdir(), 'agentos-state-bench-'));
try {
  const results = {};
  for (const [size, count] of [['small', 8], ['large', 800]]) {
    const raw = JSON.stringify(fixture(count)) + '\n';
    const workloadsResult = {};
    for (const [name, run] of Object.entries(workloads)) {
      const file = path.join(directory, size + '-' + name + '.json');
      workloadsResult[name] = await measure(JsonStore, file, raw, run, count, name);
    }
    results[size] = { count, bytes: Buffer.byteLength(raw), sha256: digest(raw), workloads: workloadsResult };
  }
  console.log(JSON.stringify({
    sourceRevision, storeSha256: digest(await readFile(storePath)), benchmarkSha256: digest(await readFile(new URL(import.meta.url))),
    runtime: { node: process.version, execPath: process.execPath, platform: process.platform, arch: process.arch, release: os.release() },
    machine: { cpu: os.cpus()[0]?.model, logicalCpus: os.cpus().length, memoryBytes: os.totalmem(), temporaryDisk: path.parse(directory).root },
    seed, warmupsPerRound: warmups, samplesPerRound: samples, roundCount: rounds, results,
  }, null, 2));
} finally {
  await rm(directory, { recursive: true, force: true });
}
