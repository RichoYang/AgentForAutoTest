import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import mysql from 'mysql2/promise';
import { createAgentResources, mysqlParameters } from '../src/runner/requirement-agent-resources.js';

test('SQL parameters preserve exact integer/decimal text and reject already-rounded numbers', () => {
  assert.deepEqual(mysqlParameters([40, '2000000000000000001', '0.1000', 0.1, null, true, false]),
    ['40', '2000000000000000001', '0.1000', '0.1', null, '1', '0']);
  for (const value of [Number.MAX_SAFE_INTEGER + 1, Infinity, NaN]) {
    assert.throws(() => mysqlParameters([value]), /original decimal or integer as a string/);
  }
});

// Explicit opt-in to a dedicated loopback database server; never uses project credentials.
test('real MySQL preserves BIGINT targeting, numeric amounts, rollback and restoration',
  { skip: !process.env.AGENTOS_TEST_MYSQL_PORT }, async () => {
    const port = Number(process.env.AGENTOS_TEST_MYSQL_PORT);
    assert.ok(Number.isInteger(port) && port > 1024 && port !== 3306);
    const database = 'aos_test_' + randomUUID().replaceAll('-', '');
    const resource = { resource_type: 'mysql', host: '127.0.0.1', port, username: 'root', password: '' };
    const connection = await mysql.createConnection({ host: resource.host, port, user: 'root', password: '',
      flags: ['-CLIENT_QUERY_ATTRIBUTES'], supportBigNumbers: true, bigNumberStrings: true });
    try {
      await connection.query('CREATE DATABASE `' + database + '`');
      await connection.query('USE `' + database + '`');
      await connection.query('CREATE TABLE budget (id BIGINT PRIMARY KEY, amount DECIMAL(18,4), enabled INT)');
      await connection.query('INSERT INTO budget VALUES (2000000000000000001,100,1),(2000000000000000002,200,1)');
      const scope = { state: { operations: {}, schemas: {} }, saveState: async () => {},
        useRead: (_name, fn) => fn(resource) };
      const runtime = createAgentResources({}, scope);
      await runtime.schema({ resource: 'mysql', database, table: 'budget' });
      const update = { kind: 'database', resource: 'mysql', database, table: 'budget', access: 'update',
        values: { amount: { $input: 'amount' } }, where: { id: { $input: 'id' } }, expectedRows: 1 };
      const query = { kind: 'database', resource: 'mysql', database, access: 'read',
        sql: 'SELECT id,amount FROM budget WHERE id=? AND enabled=?', params: [{ $input: 'id' }, 1] };
      const id = '2000000000000000001';
      assert.equal((await runtime.performSpec(update, { id, amount: 40 }, resource)).affectedRows, 1);
      assert.deepEqual((await runtime.performSpec(query, { id }, resource)).rows, [{ id, amount: '40.0000' }]);
      await assert.rejects(runtime.performSpec({ ...update, expectedRows: 2 }, { id, amount: 60 }, resource), /expected 2, actual 1; rolled back/);
      assert.equal((await runtime.performSpec(query, { id }, resource)).rows[0].amount, '40.0000');
      await assert.rejects(runtime.performSpec(update, { id: Number(id), amount: 70 }, resource), /exact finite number/);
      await runtime.performSpec(update, { id, amount: 100 }, resource);
      const [rows] = await connection.query('SELECT id,amount FROM budget ORDER BY id');
      assert.deepEqual(rows, [{ id, amount: '100.0000' }, { id: '2000000000000000002', amount: '200.0000' }]);
      await runtime.close();
    } finally {
      await connection.query('DROP DATABASE `' + database + '`');
      await connection.end();
    }
  });
