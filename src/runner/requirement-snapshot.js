import { createHash } from 'node:crypto';

const fail = message => { throw Object.assign(new Error(message), { safeMessage: message, code: 'measurement_contract' }); };
// Type tags distinguish null/missing, decimal text/number and nested object values.
// Database decimals, BIGINTs and dates arrive as exact strings from mysql2.
export function canonicalRecordValue(value) {
  if (value === null) return ['null'];
  if (typeof value === 'number') {
    if (!Number.isFinite(value) || Number.isInteger(value) && !Number.isSafeInteger(value)) fail('Snapshot numbers must be exact; supply large integers as strings');
    return ['number', String(value)];
  }
  if (typeof value === 'string' || typeof value === 'boolean') return [typeof value, value];
  if (Array.isArray(value)) return ['array', value.map(canonicalRecordValue)];
  if (value && typeof value === 'object') return ['object', Object.keys(value).sort().map(k => [k, canonicalRecordValue(value[k])])];
  fail('Snapshot field is missing or unsupported');
}
const encoded = value => JSON.stringify(canonicalRecordValue(value));
const hash = value => createHash('sha256').update(encoded(value)).digest('hex');

export function buildRecordSnapshot(contract, rows, proof) {
  if (!proof?.complete || !['repeatable-read', 'immutable-version'].includes(proof.consistency)) fail('A complete consistent collection is required');
  if (!Array.isArray(rows) || rows.length !== proof.expectedCount) fail('Snapshot count differs from the independently collected count');
  if (!contract?.key?.length || !contract.fields?.length || !contract.scope || !Object.keys(contract.scope).length) fail('Snapshot contract needs key, fields and explicit scope');
  if (new Set(contract.fields).size !== contract.fields.length || contract.key.some(k => !contract.fields.includes(k))) fail('Snapshot key fields must be covered exactly once');
  const seen = new Set();
  const entries = rows.map(row => {
    for (const field of contract.fields) if (!Object.hasOwn(row, field)) fail('Snapshot field is absent: ' + field);
    for (const [field, value] of Object.entries(contract.scope)) if (encoded(row[field]) !== encoded(value)) fail('Snapshot row violates scope: ' + field);
    const key = contract.key.map(field => row[field]);
    if (key.some(value => value === null || value === undefined)) fail('Snapshot key cannot be null or missing');
    const sortKey = encoded(key);
    if (seen.has(sortKey)) fail('Snapshot contains duplicate primary keys');
    seen.add(sortKey);
    const data = Object.fromEntries([...contract.fields].sort().map(field => [field, row[field]]));
    return { sortKey, data, record: { key, hash: hash(data), fields: Object.entries(data).map(([name, value]) => ({ name, hash: hash(value) })) } };
  }).sort((a, b) => a.sortKey < b.sortKey ? -1 : a.sortKey > b.sortKey ? 1 : 0);
  return { version: 1, contract, contractHash: hash(contract), count: entries.length,
    hash: hash(entries.map(entry => entry.record)), rows: entries.map(entry => entry.data),
    records: entries.map(entry => entry.record), proof: { ...proof, ordering: 'typed-primary-key',
      fieldCoverage: contract.fields, precision: 'typed exact values; decimal/BIGINT/date text', emptySet: 'zero rows with a deterministic hash' } };
}

export function compareRecordSnapshots(before, after) {
  if (!before?.proof?.complete || !after?.proof?.complete) fail('Both snapshots must be complete');
  // contractHash was computed before redaction. Equal redacted scope values
  // must not make different original scopes comparable.
  if (before.contractHash !== after.contractHash || hash(before.contract) !== hash(after.contract)) fail('Snapshot measurement contract changed; restore and recollect the affected scenario');
  const index = snapshot => new Map(snapshot.records.map((record, i) => [encoded(record.key), { ...record, row: snapshot.rows[i] }]));
  const left = index(before), right = index(after), added = [], removed = [], changed = [];
  for (const [key, record] of left) {
    const next = right.get(key);
    if (!next) removed.push({ key: record.key, row: record.row });
    else if (record.hash !== next.hash) changed.push({ key: record.key, fields: record.fields.filter(field =>
      field.hash !== next.fields.find(other => other.name === field.name)?.hash).map(field => ({ name: field.name,
      before: record.row[field.name], after: next.row[field.name], beforeHash: field.hash,
      afterHash: next.fields.find(other => other.name === field.name)?.hash })) });
  }
  for (const [key, record] of right) if (!left.has(key)) added.push({ key: record.key, row: record.row });
  return { equal: !added.length && !removed.length && !changed.length, beforeHash: before.hash, afterHash: after.hash,
    beforeCount: before.count, afterCount: after.count, added, removed, changed };
}
