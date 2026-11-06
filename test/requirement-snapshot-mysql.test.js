import test from 'node:test';
import assert from 'node:assert/strict';
import mysql from 'mysql2/promise';
import { createAgentResources } from '../src/runner/requirement-agent-resources.js';
import { compareRecordSnapshots } from '../src/runner/requirement-snapshot.js';

const port = Number(process.env.AGENTOS_TEST_MYSQL_PORT);
test('real MySQL snapshot proves full paginated tenant scope, exact precision, empty sets and change details', { skip: !port }, async t => {
  assert.ok(port > 1024 && port !== 3306, 'Use a dedicated loopback test database only');
  const conn = await mysql.createConnection({ host: '127.0.0.1', port, user: 'root', password: '', flags: ['-CLIENT_QUERY_ATTRIBUTES'] });
  const database = 'aos_snapshot_' + Date.now();
  await conn.query(`CREATE DATABASE ${database}`);
  t.after(async () => { await conn.query(`DROP DATABASE ${database}`); await conn.end(); });
  await conn.query(`CREATE TABLE ${database}.items (id BIGINT PRIMARY KEY, tenant VARCHAR(8), amount DECIMAL(20,4), at_time DATETIME(6), note LONGTEXT) ENGINE=InnoDB`);
  for (let i = 0; i < 7; i++) await conn.execute(`INSERT INTO ${database}.items VALUES (?,?,?,?,?)`,
    [String(9007199254740993n + BigInt(i)), i === 6 ? 'B' : 'A', '123456789.0100', '2026-12-31 23:59:59.123456', i === 0 ? null : 'x'.repeat(5000)]);
  const state = { operations: {}, schemas: {} };
  const runtime = createAgentResources({}, { state, saveState: async () => {}, useRead: (_, run) => run({ resource_type: 'mysql', host: '127.0.0.1', port, username: 'root', password: '' }) });
  t.after(() => runtime.close());
  const args = { resource: 'mysql', database, table: 'items', scope: { tenant: 'A' }, pageSize: 2 };
  const first = await runtime.snapshot(args);
  assert.equal(first.count, 6); assert.deepEqual(first.proof.pageCounts, [2, 2, 2, 0]);
  assert.equal(first.rows[0].id, '9007199254740993'); assert.equal(first.rows[0].amount, '123456789.0100');
  assert.equal(first.rows[0].at_time, '2026-12-31 23:59:59.123456'); assert.equal(first.rows[0].note, null);
  assert.equal((await runtime.snapshot({ ...args, scope: { tenant: 'empty' } })).count, 0);
  assert.equal((await runtime.snapshot({ ...args, scope: { tenant: 'A', amount: '123456789.01' } })).count, 6);
  await assert.rejects(runtime.snapshot({ ...args, scope: { tenant: 'A', amount: '123456789.01001' } }), /lose precision/);
  assert.equal(compareRecordSnapshots(first, await runtime.snapshot({ ...args, pageSize: 3 })).equal, true);
  await conn.execute(`UPDATE ${database}.items SET amount=? WHERE id=?`, ['0.0100', '9007199254740993']);
  await conn.execute(`DELETE FROM ${database}.items WHERE id=?`, ['9007199254740994']);
  await conn.execute(`INSERT INTO ${database}.items VALUES (?,?,?,?,?)`, ['9007199254741010', 'A', '1.0000', '2027-01-01', 'new']);
  const diff = compareRecordSnapshots(first, await runtime.snapshot(args));
  assert.equal(diff.changed.length, 1); assert.equal(diff.added.length, 1); assert.equal(diff.removed.length, 1);
  assert.equal(diff.changed[0].fields[0].before, '123456789.0100');
  await assert.rejects(runtime.snapshot({ ...args, fields: ['id', 'amount'] }), /scope fields/);
});

test('real concurrent commits cannot split a paginated collection across versions', { skip: !port }, async t => {
  assert.ok(port > 1024 && port !== 3306);
  const conn = await mysql.createConnection({ host: '127.0.0.1', port, user: 'root', password: '', flags: ['-CLIENT_QUERY_ATTRIBUTES'] });
  const database = 'aos_consistency_' + Date.now();
  await conn.query(`CREATE DATABASE ${database}`);
  t.after(async () => { await conn.query(`DROP DATABASE ${database}`); await conn.end(); });
  await conn.query(`CREATE TABLE ${database}.items (id INT PRIMARY KEY, tenant VARCHAR(8), revision INT) ENGINE=InnoDB`);
  const values = Array.from({ length: 2000 }, (_, id) => `(${id},'A',0)`).join(',');
  await conn.query(`INSERT INTO ${database}.items VALUES ${values}`);
  const runtime = createAgentResources({}, { state: { operations: {}, schemas: {} }, saveState: async () => {},
    useRead: (_, run) => run({ resource_type: 'mysql', host: '127.0.0.1', port, username: 'root', password: '' }) });
  t.after(() => runtime.close());
  let finished = false, overlapped = false;
  const capture = runtime.snapshot({ resource: 'mysql', database, table: 'items', scope: { tenant: 'A' }, pageSize: 1 }).finally(() => { finished = true; });
  while (!finished) {
    const [processes] = await conn.query('SHOW FULL PROCESSLIST');
    if (processes.some(row => row.db === database && /SELECT .*ORDER BY/.test(row.Info ?? ''))) {
      await conn.query(`UPDATE ${database}.items SET revision=1`);
      await conn.query(`INSERT INTO ${database}.items VALUES(2001,'A',1)`);
      overlapped = true; break;
    }
    await new Promise(resolve => setTimeout(resolve, 1));
  }
  const snapshot = await capture;
  assert.equal(overlapped, true, 'Concurrent commit must occur during actual page reads');
  assert.equal(snapshot.count, 2000); assert.ok(snapshot.rows.every(row => row.revision === 0));
  assert.equal((await runtime.snapshot({ resource: 'mysql', database, table: 'items', scope: { tenant: 'A' } })).count, 2001);
});

test('TIMESTAMP snapshots stay comparable when the server default timezone changes', { skip: !port }, async t => {
  assert.ok(port > 1024 && port !== 3306);
  const conn = await mysql.createConnection({ host: '127.0.0.1', port, user: 'root', password: '', flags: ['-CLIENT_QUERY_ATTRIBUTES'] });
  const [[{ zone }]] = await conn.query('SELECT @@GLOBAL.time_zone AS zone');
  const database = 'aos_timezone_' + Date.now();
  await conn.query('CREATE DATABASE ' + database);
  t.after(async () => { await conn.query('SET GLOBAL time_zone=?', [zone]); await conn.query('DROP DATABASE ' + database); await conn.end(); });
  await conn.query(`CREATE TABLE ${database}.items(id INT PRIMARY KEY,tenant VARCHAR(4),stamp TIMESTAMP(6)) ENGINE=InnoDB`);
  await conn.query("SET time_zone='+00:00'");
  await conn.query(`INSERT INTO ${database}.items VALUES(1,'A','2026-01-02 03:04:05.123456')`);
  const runtime = createAgentResources({}, { state: { operations: {}, schemas: {} }, saveState: async () => {},
    useRead: (_, run) => run({ resource_type: 'mysql', host: '127.0.0.1', port, username: 'root', password: '' }) });
  t.after(() => runtime.close());
  const args = { resource: 'mysql', database, table: 'items', scope: { tenant: 'A' } };
  await conn.query("SET GLOBAL time_zone='+00:00'"); const first = await runtime.snapshot(args);
  await conn.query("SET GLOBAL time_zone='+08:00'"); const second = await runtime.snapshot(args);
  assert.equal(first.rows[0].stamp, '2026-01-02 03:04:05.123456');
  assert.equal(compareRecordSnapshots(first, second).equal, true);
  assert.equal(second.contract.timestampTimeZone, '+00:00');
});
