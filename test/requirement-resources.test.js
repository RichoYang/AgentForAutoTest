import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import path from 'node:path';
import os from 'node:os';
import mysql from 'mysql2/promise';
import { requirementResources, resourceBindingKey } from '../src/runner/requirement-resources.js';
import { createAgentResources, sanitized } from '../src/runner/requirement-agent-resources.js';

const section = (name, fields = '', tier = 'Sit', mode = 'full_crud') =>
  `[${name}]\nstatus=configured\nenvironment=${tier}\nai_access=allowed\nai_operation_mode=${mode}\n${fields}\n`;

async function fixture(t, text, resources, extra = {}) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'aos-ini-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const iniPath = path.join(root, 'resource.ini');
  await writeFile(iniPath, text);
  return { root, env: { name: 'SIT', platform: 'Demo', iniPath, resources, ...extra }, write: value => writeFile(iniPath, value) };
}

test('explicit INI bindings report isolated format, policy and protocol failures and intersect operations', async t => {
  const { env } = await fixture(t, '[AiPolicy]\nsit_access=allowed\ndestructive_database_operations=explicit_authorization_required\n'
    + section('Demo.Sit', 'allowed_operations=query,create,update\ndelete_access=forbidden', 'Sit', 'create_update_read')
    + section('Demo.Sit.Bad', 'Port=30\nport=31') + section('Demo.Sit.Bad', 'other=value')
    + section('Demo.Sit.Policy', 'allowed_operations=query,launch') + section('Demo.Prd.Api', '', 'Prd')
    + section('Demox.Sit.Api') + section('Demo.Uat.Other', '', 'Uat')
    + section('Demo.Sit.Mongo', 'resource_type=mongodb')
    + section('Demo.Sit.Missing', 'resource_type=mysql\nhost=\nusername=')
    + section('Demo.Sit.Db', 'resource_type=mysql\nhost=127.0.0.1\nport=3306\nusername=fixture\npassword=fixture-only'), {
    main: { section: 'Demo.Sit', scope: 'full_crud' }, bad: { section: 'Demo.Sit.Bad', scope: 'read' },
    unknown: { section: 'Demo.Sit.Policy', scope: 'read' }, unsupported: { section: 'Demo.Sit.Mongo', scope: 'read' },
    prd: { section: 'Demo.Prd.Api', scope: 'read' }, other: { section: 'Demox.Sit.Api', scope: 'read' },
    alias: { section: 'Demo.Uat.Other', scope: 'read' }, missing: { section: 'Demo.Sit.Missing', scope: 'read' },
    db: { section: 'Demo.Sit.Db', scope: 'full_crud' },
  }, { aliases: ['UAT', 'PRD'] });
  const bound = await requirementResources(env, { allowUnavailable: true });
  assert.deepEqual(bound.names, ['main', 'alias', 'db']);
  assert.deepEqual(bound.catalog.main.allowedOperations, ['read', 'create', 'update']);
  assert.deepEqual(bound.catalog.db.allowedOperations, ['read']);
  assert.equal(bound.catalog.db.databaseWriteAuthorizationRequired, true);
  await bound.assertWrite('main', 'update');
  for (const operation of ['delete', 'trigger']) await assert.rejects(bound.assertWrite('main', operation), { code: 'environment_scope' });
  assert.match(bound.catalog.bad.detail, /重复字段 port.*重复配置节/);
  assert.equal(bound.catalog.unknown.code, 'unknown_policy');
  assert.equal(bound.catalog.unsupported.code, 'connector_unsupported');
  assert.equal(bound.catalog.missing.code, 'connection_fields');
  assert.equal(bound.catalog.prd.code, 'binding_mismatch');
  assert.equal(bound.catalog.other.code, 'binding_mismatch');
});

test('credential rotation and policy withdrawal fence reads and old fingerprints without invalidating unrelated sections', async t => {
  const first = section('Demo.Sit.Api', 'base_url=http://127.0.0.1:9/path?public=sample\naccount_role=reader\npublic_password=fixture!one\nadmin_key=fixtureAdmin');
  const { root, env, write } = await fixture(t, first + '[GitHubKey]\nadmin_key=operator-only\n', {
    api: { section: 'Demo.Sit.Api', scope: 'read', fields: { password: 'public_password' } },
  });
  const [key1, key2] = await Promise.all([resourceBindingKey(root), resourceBindingKey(root)]);
  assert.deepEqual(key1, key2);
  const original = await requirementResources(env, { dataDir: root });
  const fingerprint = original.identity('api');
  assert.match(fingerprint, /^v2:[a-f0-9]{64}$/);
  assert.equal(original.catalog.api.base_url, 'http://127.0.0.1:9/path');
  assert.equal(original.catalog.api.account_role, 'reader');
  await original.use('api', 'read', resource => assert.equal(resource.password, 'fixture!one'));
  assert.throws(() => original.checkOutput({ unexpected: 'fixture!one' }), { code: 'execution_evidence' });
  assert.throws(() => original.checkOutput('fixtureAdmin'), { code: 'execution_evidence' });
  assert.deepEqual(sanitized({ admin_key: 'a', public_password: 'b', note: 'public_password=x' }),
    { admin_key: '[REDACTED]', public_password: '[REDACTED]', note: 'public_password=[REDACTED]' });
  await write(first + '[GitHubKey]\nadmin_key=new-operator-only\n');
  await original.assertRead('api');
  assert.equal((await requirementResources(env, { dataDir: root })).identity('api'), fingerprint);
  await write(first.replace('fixture!one', 'fixture!two'));
  await assert.rejects(original.use('api', 'read', () => assert.fail('old read handle dispatched')), /身份或策略已变化/);
  const changed = await requirementResources(env, { dataDir: root });
  assert.notEqual(changed.identity('api'), fingerprint);
  await write(first.replace('ai_access=allowed', 'ai_access=explicit_user_confirmation_required'));
  await assert.rejects(changed.assertRead('api'), /ai_access 未授予/);
});

test('browser connector uses separate resource logins and checks live role identity without leaking session tokens', async t => {
  let readerRole = 'reader';
  const browserHits = [];
  const server = createServer(async (request, response) => {
    const send = value => { response.setHeader('content-type', 'application/json'); response.end(JSON.stringify(value)); };
    if (request.url === '/login') {
      let raw = ''; for await (const chunk of request) raw += chunk;
      const { account, password } = JSON.parse(raw);
      const valid = ['reader', 'approver'].includes(account) && password === `isolated-${account}-password`;
      if (!valid) { response.statusCode = 403; return send({ error: 'rejected' }); }
      browserHits.push(account);
      return send({ token: 'session-' + account, public_password: password });
    }
    if (request.url === '/me') return send({ role: request.headers['x-session'] === 'session-reader' ? readerRole : 'approver' });
    if (request.url === '/business') return send({ reached: true });
    response.setHeader('content-type', 'text/html; charset=utf-8');
    response.end(`<input placeholder="请输入用户名"><input type="password"><button onclick="fetch('/login',{method:'POST',body:JSON.stringify({account:document.querySelector('input').value,password:document.querySelector('[type=password]').value})})">登录</button>`);
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const url = 'http://127.0.0.1:' + server.address().port;
  const web = account => section('Demo.Sit.' + account, `resource_type=web_platform\nbase_url=${url}\naccount=${account}\npassword=isolated-${account}-password`);
  const { env } = await fixture(t, web('reader') + web('approver'), {
    reader: { section: 'Demo.Sit.reader', scope: 'read' }, approver: { section: 'Demo.Sit.approver', scope: 'read' },
  });
  const resources = await requirementResources(env);
  const login = { path: '/login', tokenField: ['token'], header: 'x-session', identityProbe: { path: '/me', identityFields: { role: ['role'] } } };
  const runtime = createAgentResources({ logins: { reader: login, approver: login } }, {
    state: { operations: {} }, useRead: (key, run) => resources.use(key, 'read', run),
    assertRead: resources.assertRead, rememberSecret: resources.rememberSecret, connectionProbeOnly: true,
  });
  try {
    const reader = await runtime.inspect('reader');
    const approver = await runtime.inspect('approver');
    assert.deepEqual(browserHits, ['reader', 'approver']);
    assert.deepEqual(reader.identity, { role: 'reader' });
    assert.deepEqual(approver.identity, { role: 'approver' });
    assert.doesNotMatch(JSON.stringify(reader), /session-reader|isolated-reader-password/);
    assert.throws(() => resources.checkOutput({ arbitrary: 'session-reader' }), { code: 'execution_evidence' });
    readerRole = 'revoked';
    await assert.rejects(resources.use('reader', 'read', resource => runtime.verifyAuthentication('reader', resource, reader)), /identity changed/);
  } finally { await runtime.close(); }
});

test('read-labelled management operations cannot delete, consume or trigger via HTTP or browser', async t => {
  const requests = [];
  const server = createServer((request, response) => {
    requests.push(request.url);
    response.end('Read-only management page');
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const base_url = 'http://127.0.0.1:' + server.address().port;
  const scheduler = { resource_type: 'xxl_job', base_url };
  const runtime = createAgentResources({}, { state: { operations: {} }, useRead: (_key, run) => run(scheduler) });
  t.after(() => runtime.close());
  for (const [resource_type, method, pathname] of [['rabbitmq', 'POST', '/api/queues/vhost/key/get'],
    ['rabbitmq', 'DELETE', '/api/queues/vhost/key'], ['xxl_job', 'GET', '/jobinfo/trigger'],
    ['xxl_job', 'GET', '/jobinfo/%74rigger;path=ignored']]) {
    await assert.rejects(runtime.performSpec({ resource: 'admin', kind: 'http', access: 'read', method, path: pathname }, {},
      { resource_type, base_url }), /cannot be registered as read-only/);
  }
  await runtime.browser({ resource: 'admin', action: 'goto', path: '/jobinfo/records' });
  await assert.rejects(runtime.browser({ resource: 'admin', action: 'goto', path: '/jobinfo/%74rigger;path=ignored' }), /ERR_FAILED/);
  assert.deepEqual(requests, ['/jobinfo/records']);
});

test('real MySQL connector returns identity and selected database metadata and refuses alternate database selection',
  { skip: !process.env.AGENTOS_TEST_MYSQL_PORT }, async t => {
    const port = Number(process.env.AGENTOS_TEST_MYSQL_PORT);
    assert.ok(port > 1024);
    const admin = await mysql.createConnection({ host: '127.0.0.1', port, user: 'root', password: '' });
    const name = 'aos_ini_' + Date.now(), account = name;
    await admin.query('CREATE DATABASE ??', [name]);
    await admin.query('CREATE USER ?@? IDENTIFIED BY ?', [account, '127.0.0.1', 'fixture-connection-password']);
    t.after(async () => { await admin.query('DROP USER ?@?', [account, '127.0.0.1']); await admin.query('DROP DATABASE ??', [name]); await admin.end(); });
    await admin.query('GRANT SELECT ON ?? .* TO ?@?', [name, account, '127.0.0.1']);
    const { env } = await fixture(t, section('Demo.Sit.Db',
      `resource_type=mysql\nhost=127.0.0.1\nport=${port}\nusername=${account}\npassword=fixture-connection-password\ndatabase_name=not_specified`),
    { db: { section: 'Demo.Sit.Db', scope: 'read', database: name } });
    const resources = await requirementResources(env);
    const runtime = createAgentResources({}, { state: { operations: {} }, useRead: (key, run) => resources.use(key, 'read', run) });
    assert.deepEqual(await runtime.inspect('db'), { connector: 'mysql', connected: true, principalMatchesConfiguredUser: true,
      database: name, globalPrivilege: false, grantEntries: 2 });
    assert.deepEqual(await runtime.schema({ resource: 'db' }), { rows: [{ Database: name }] });
    await assert.rejects(runtime.schema({ resource: 'db', database: 'other' }), { code: 'environment_scope' });
  });

test('MySQL discovers and selects related schemas independently of the configured default', {
  skip: !process.env.AGENTOS_TEST_MYSQL_PORT,
}, async t => {
  const port = Number(process.env.AGENTOS_TEST_MYSQL_PORT);
  assert.ok(port > 1024);
  const admin = await mysql.createConnection({ host: '127.0.0.1', port, user: 'root', password: '' });
  const prefix = 'aos_discovery_' + Date.now();
  const databases = [prefix + '_sales_sit', prefix + '_stock_sit', prefix + '_stock_prd'];
  const account = prefix.slice(0, 32);
  const password = 'synthetic-db-discovery-password';
  const created = [];
  let accountCreated = false;
  t.after(async () => {
    try {
      if (accountCreated) await admin.query('DROP USER ?@?', [account, '127.0.0.1']);
      for (const database of created) await admin.query('DROP DATABASE ??', [database]);
    } finally { await admin.end(); }
  });
  for (const [index, database] of databases.entries()) {
    await admin.query('CREATE DATABASE ??', [database]);
    created.push(database);
    await admin.query('CREATE TABLE ??.stock (code VARCHAR(12) PRIMARY KEY, quantity INT NOT NULL)', [database]);
    await admin.query('INSERT INTO ??.stock VALUES (?, ?)', [database, 'item-1', index + 7]);
  }
  await admin.query('CREATE USER ?@? IDENTIFIED BY ?', [account, '127.0.0.1', password]);
  accountCreated = true;
  await admin.query('GRANT SELECT ON *.* TO ?@?', [account, '127.0.0.1']);
  const mysqlSection = 'resource_type=mysql\nhost=127.0.0.1\nport=' + port + '\nusername=' + account + '\npassword=' + password;
  const { env } = await fixture(t, section('Demo.Sit.Main', mysqlSection + '\ndatabase_name=' + databases[0])
    + section('Demo.Sit.Other', mysqlSection), {
    main: { section: 'Demo.Sit.Main', scope: 'read' },
    other: { section: 'Demo.Sit.Other', scope: 'read' },
  });
  const resources = await requirementResources(env);
  const runtime = createAgentResources({}, { state: {}, saveState: async () => {},
    useRead: (key, run) => resources.use(key, 'read', run) });
  const discovery = (await runtime.schema({ resource: 'main' })).rows.map(row => row.Database);
  assert.ok(discovery.includes(databases[0]));
  assert.ok(discovery.includes(databases[1]));
  assert.ok(!discovery.includes(databases[2]));
  assert.equal((await runtime.inspect('other')).database, null);
  assert.equal((await runtime.inspect('main', databases[1])).database, databases[1]);
  assert.equal((await runtime.inspect('main', databases[1])).globalPrivilege, true);
  assert.ok((await runtime.schema({ resource: 'main', database: databases[1] })).rows.some(row => Object.values(row).includes('stock')));
  const query = (resource, database) => resources.use(resource, 'read', connection => runtime.performSpec({
    kind: 'database', access: 'read', resource, database, sql: 'SELECT code, quantity FROM stock WHERE code=?', params: ['item-1'],
  }, {}, connection));
  for (const [index, database] of databases.slice(0, 2).entries()) {
    const result = await query('main', database);
    assert.deepEqual(result.rows, [{ code: 'item-1', quantity: index + 7 }]);
    assert.equal(result.databaseEvidence.database, database);
    assert.equal(result.databaseEvidence.principalMatchesConfiguredUser, true);
    assert.equal(result.columns[1].table, 'stock');
    assert.equal(result.columns[1].database, database);
    assert.equal(result.columns[1].column, 'quantity');
  }
  assert.equal((await query('other', databases[1])).rows[0].quantity, 8);
  await assert.rejects(query('main', databases[2]), { code: 'environment_scope' });
});
