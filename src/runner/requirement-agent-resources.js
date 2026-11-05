import { readFile, realpath, stat } from 'node:fs/promises';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import mysql from 'mysql2/promise';
import { chromium } from 'playwright';
import { observationAt } from './requirement-assertions.js';
import { waitBusinessReady } from './requirement-adapter.js';
import { digest } from './requirement-feishu.js';

const exec = promisify(execFile);
export const agentError = message => Object.assign(new Error(message), { safeMessage: message });
const identifier = value => {
  if (!/^[a-zA-Z0-9_]+$/.test(value ?? '')) throw agentError('Invalid database identifier');
  return '`' + value + '`';
};
export function resolveInput(value, input) {
  if (Array.isArray(value)) return value.map(item => resolveInput(item, input));
  if (value && typeof value === 'object') {
    if (Object.keys(value).length === 1 && typeof value.$input === 'string') {
      if (!Object.hasOwn(input, value.$input)) throw agentError('Missing input: ' + value.$input);
      return input[value.$input];
    }
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, resolveInput(item, input)]));
  }
  return value;
}

export function validateRouteTemplate(value, field = 'path') {
  if (value && typeof value === 'object' && Object.keys(value).length === 1 && typeof value.$input === 'string') return;
  if (typeof value !== 'string') throw agentError(field + ' must be a path string or {$input:"parameter"} object');
  if (/[{}]/.test(value.replace(/\{[A-Za-z][A-Za-z0-9_]*\}/g, ''))) {
    throw agentError(field + ' uses {parameter} placeholders, e.g. /page?key={key}; do not embed {$input:...} inside a string');
  }
}

function resolveRoute(value, input) {
  validateRouteTemplate(value);
  const route = resolveInput(value, input);
  if (typeof route !== 'string') throw agentError('Request path must resolve to a string');
  return route.replace(/\{([A-Za-z][A-Za-z0-9_]*)\}/g, (_, key) => {
    if (!Object.hasOwn(input, key)) throw agentError('Missing path input: ' + key);
    return encodeURIComponent(String(input[key]));
  });
}

export async function readSource(root, args) {
  const actualRoot = await realpath(root);
  const target = await realpath(path.resolve(root, args.path ?? '.'));
  const relative = path.relative(actualRoot, target);
  if (relative.startsWith('..') || path.isAbsolute(relative)) throw agentError('Source path is outside this project');
  const sensitivePath = /(?:^|[\\/])(?:\.git|\.env[^\\/]*|\.npmrc|settings\.xml|[^\\/]+\.ini|[^\\/]+\.local\.[^\\/]+)(?:[\\/]|$)/i;
  if (sensitivePath.test(relative) || sensitivePath.test(args.file ?? '')) throw agentError('Credentials and repository internals are not source-tool output');
  if (['refs', 'history', 'show'].includes(args.action)) {
    if (args.ref && (!/^[a-zA-Z0-9_./-]+$/.test(args.ref) || args.ref.startsWith('-'))) throw agentError('Invalid Git ref');
    if (args.file && (args.file.startsWith('/') || args.file.includes('..') || args.file.includes(':'))) throw agentError('Invalid repository file');
    const argv = args.action === 'refs' ? ['for-each-ref', '--format=%(refname) %(objectname)', 'refs/heads', 'refs/remotes']
      : args.action === 'history' ? ['log', '--format=%H %ad %s', '--date=iso-strict', args.ref ?? 'HEAD', '--', args.file ?? '.']
        : ['show', (args.ref ?? 'HEAD') + ':' + args.file];
    const { stdout } = await exec('git', ['-C', target, ...argv], { windowsHide: true, maxBuffer: 32 * 1024 * 1024 });
    const lines = stdout.split(/\r?\n/), start = args.start ?? 1, end = args.end ?? start + 199;
    return { path: relative, ref: args.ref ?? 'HEAD', file: args.file, sha256: digest(stdout), start, total: lines.length,
      text: lines.slice(start - 1, end).map((line, i) => `${start + i}: ${line}`).join('\n') };
  }
  if (args.action === 'search' || args.action === 'files') {
    // Workspace VCS rules often ignore independently versioned business repos.
    const flags = ['--no-ignore-vcs', '--glob', '!**/node_modules/**', '--glob', '!**/.git/**', '--glob', '!*.local.*', '--glob', '!settings.xml',
      '--glob', '!*.ini', '--glob', '!*.env*', '--glob', '!.npmrc'];
    // execFile keeps stdin as a pipe. An explicit path makes rg search the source
    // tree instead of waiting forever for input from that still-open pipe.
    const directory = (await stat(target)).isDirectory();
    const searchPath = directory ? '.' : path.basename(target);
    const command = args.action === 'files' ? ['--files', ...flags, searchPath] : ['-n', ...flags, '--', String(args.pattern), searchPath];
    const result = await exec('rg', command, { cwd: directory ? target : path.dirname(target), windowsHide: true, maxBuffer: 32 * 1024 * 1024 })
      .catch(error => error.code === 1 ? { stdout: '' } : Promise.reject(error));
    const lines = result.stdout.split(/\r?\n/).filter(Boolean);
    const offset = args.offset ?? 0, limit = args.limit ?? 100;
    return { path: relative, lines: lines.slice(offset, offset + limit), total: lines.length,
      nextOffset: offset + limit < lines.length ? offset + limit : null };
  }
  if (/(?:^|[\\/])(?:\.env[^\\/]*|\.npmrc|settings\.xml|[^\\/]+\.ini|[^\\/]+\.local\.[^\\/]+)$/.test(target)) {
    throw agentError('Credentials are resolved by resource connectors, not source tools');
  }
  const text = await readFile(target, 'utf8');
  const lines = text.split(/\r?\n/);
  const start = args.start ?? 1, end = args.end ?? Math.min(start + 199, lines.length);
  return { path: relative, sha256: digest(text), start, end: Math.min(end, lines.length), total: lines.length,
    text: lines.slice(start - 1, end).map((line, i) => `${start + i}: ${line}`).join('\n') };
}

export function resourceURL(resource, relative) {
  const base = new URL(resource.base_url ?? resource.management_url);
  const url = new URL(relative, base);
  if (!['http:', 'https:'].includes(base.protocol) || base.username || base.password || url.origin !== base.origin
    || url.username || url.password || !relative.startsWith('/') || relative.startsWith('//') || relative.includes('\\')) {
    throw agentError('Endpoint does not belong to the bound resource');
  }
  return url;
}

export function sanitized(value) {
  if (value instanceof Date) return value.toJSON();
  if (Array.isArray(value)) return value.map(sanitized);
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, entry]) =>
    [key, /password|(?:^|_)pwd|token|authorization|cookie|secret|connection_string/i.test(key) ? '[REDACTED]' : sanitized(entry)]));
  if (typeof value === 'string') return value.replace(/((?:password|pwd|access_token|refresh_token|app_secret|client_secret|authorization)\s*["']?\s*[:=]\s*)[^\r\n,;]+/gi, '$1[REDACTED]');
  return value;
}

export function createAgentResources(config, scope) {
  const sessions = new Map();
  const authentication = new Map();
  const schemas = new Map();
  const operations = () => scope.state.operations;
  async function connect(resource, database) {
    if (resource.resource_type !== 'mysql') throw agentError('Resource is not MySQL');
    return mysql.createConnection({ host: resource.host, port: Number(resource.port) || 3306, user: resource.username,
      password: resource.password, database: database || (resource.database_name === 'not_specified' ? undefined : resource.database_name),
      supportBigNumbers: true, bigNumberStrings: true, decimalNumbers: false, dateStrings: true,
      multipleStatements: false, connectTimeout: 10000 });
  }
  async function database(spec, input, resource) {
    const connection = await connect(resource, spec.database);
    try {
      if (spec.access === 'read') {
        if (!/^\s*(?:SELECT|SHOW|DESCRIBE|EXPLAIN|WITH)\b/i.test(spec.sql) || /\b(?:INTO\s+(?:OUTFILE|DUMPFILE)|FOR\s+UPDATE|GET_LOCK|RELEASE_LOCK|SLEEP|BENCHMARK)\b/i.test(spec.sql)) {
          throw agentError('Use a read-only SQL query without locks or file output');
        }
        await connection.query('SET TRANSACTION READ ONLY');
        await connection.beginTransaction();
        const [rows] = await connection.execute({ sql: spec.sql, timeout: 30000 }, resolveInput(spec.params ?? [], input));
        await connection.rollback();
        return { rows: sanitized(rows), count: rows.length };
      }
      const schema = schemas.get(spec.resource + ':' + spec.database + ':' + spec.table)
        ?? scope.state.schemas?.[spec.resource + ':' + spec.database + ':' + spec.table];
      if (!schema) throw agentError('Inspect table schema before database mutation');
      const values = resolveInput(spec.values ?? {}, input);
      const where = resolveInput(spec.where ?? {}, input);
      const known = new Set(schema.columns.map(column => column.Field));
      if ([...Object.keys(values), ...Object.keys(where)].some(key => !known.has(key))) throw agentError('Unknown column');
      const uniqueIndexes = new Map();
      for (const index of schema.indexes.filter(index => Number(index.Non_unique) === 0)) {
        const columns = uniqueIndexes.get(index.Key_name) ?? [];
        columns.push(index.Column_name); uniqueIndexes.set(index.Key_name, columns);
      }
      if (spec.access !== 'create' && ![...uniqueIndexes.values()].some(columns => columns.length && columns.every(column => Object.hasOwn(where, column)))) {
        throw agentError('Database writes require a verified unique or primary key filter');
      }
      const table = identifier(spec.table), keys = Object.keys(values);
      const condition = Object.keys(where).map(key => identifier(key) + ' <=> ?').join(' AND ');
      let sql, args;
      if (spec.access === 'create') {
        if (!keys.length) throw agentError('Insert needs explicit values');
        sql = `INSERT INTO ${table} (${keys.map(identifier).join(',')}) VALUES (${keys.map(() => '?').join(',')})`;
        args = Object.values(values);
      } else if (spec.access === 'update') {
        if (!keys.length) throw agentError('Update needs explicit values');
        sql = `UPDATE ${table} SET ${keys.map(key => identifier(key) + '=?').join(',')} WHERE ${condition}`;
        args = [...Object.values(values), ...Object.values(where)];
      } else if (spec.access === 'delete') { sql = `DELETE FROM ${table} WHERE ${condition}`; args = Object.values(where); }
      else throw agentError('Unsupported database operation');
      await connection.beginTransaction();
      const [result] = await connection.execute({ sql, timeout: 30000 }, args);
      if (!Number.isInteger(spec.expectedRows) || spec.expectedRows < 1 || result.affectedRows !== spec.expectedRows) {
        await connection.rollback(); throw agentError('Affected row count differs from the planned mutation; rolled back');
      }
      await connection.commit();
      return { affectedRows: result.affectedRows, insertId: String(result.insertId) };
    } finally { await connection.end(); }
  }

  async function browserSession(resourceName, resource) {
    if (sessions.has(resourceName)) return sessions.get(resourceName);
    const browser = await chromium.launch({ headless: true });
    const context = await browser.newContext({ serviceWorkers: 'block' });
    const page = await context.newPage();
    const state = { browser, context, page, token: null, network: [], effect: null, login: false, ready: null, fault: null };
    sessions.set(resourceName, state);
    await context.route('**/*', async route => {
      const request = route.request();
      try {
        const url = new URL(request.url());
        const origin = resourceURL(resource, '/').origin;
        if (url.origin !== origin) throw agentError('Browser request is outside the bound resource');
        const method = request.method();
        const fault = state.fault;
        if (fault && fault.path === url.pathname && fault.method === method) {
          state.network.push({ path: url.pathname, method, fault: { ...fault, simulated: true } });
          if (fault.delayMs) await new Promise(resolve => setTimeout(resolve, fault.delayMs));
          if (fault.abort) return route.abort('failed');
          if (fault.status) return route.fulfill({ status: fault.status, contentType: 'application/json', body: JSON.stringify(fault.body ?? {}) });
        }
        if (!['GET', 'HEAD', 'OPTIONS'].includes(method)) {
          const isLogin = state.login && config.login && url.pathname === config.login.path && method === 'POST';
          const read = Object.values(operations()).find(op => op.resource === resourceName && op.kind === 'http'
            && op.access === 'read' && op.method === method && op.path === url.pathname);
          const effect = state.effect && state.effect.path === url.pathname && state.effect.method === method;
          if (!isLogin && !read && !effect) throw agentError('Browser request needs a verified read contract, or test_mutate with a registered browser goto/click operation and matching effect: '
            + method + ' ' + url.pathname + '. Registering an HTTP write alone does not authorize browser writes.');
          if (effect) {
            const payload = request.postDataJSON();
            if (digest(payload ?? null) !== digest(state.effect.body ?? null)) throw agentError('Browser submit payload differs from the ledger intent: '
              + JSON.stringify({ expected: sanitized(state.effect.body ?? null), received: sanitized(payload ?? null) }) + '. Omit effect.body for a request with no body.');
            state.effect = null;
          }
        }
        const response = await route.fetch({ maxRedirects: 0, maxRetries: 0 });
        if (response.status() >= 300 && response.status() < 400) throw agentError('Redirect requires a separately verified endpoint');
        if (['xhr', 'fetch'].includes(request.resourceType())) {
          let body;
          try { body = await response.json(); } catch { body = null; }
          state.network.push({ path: url.pathname, method, status: response.status(), body: sanitized(body) });
        }
        await route.fulfill({ response });
      } catch (error) {
        state.network.push({ path: new URL(request.url()).pathname, method: request.method(), error: error.safeMessage ?? 'Browser network request failed' });
        await route.abort().catch(() => {});
      }
    });
    if (config.login && resourceName === (config.login.resource ?? 'platform')) {
      state.login = true;
      try {
        await page.goto(resource.base_url, { waitUntil: 'domcontentloaded' });
        await page.locator(config.login.accountSelector ?? 'input[placeholder="请输入用户名"]').fill(resource.account ?? resource.username);
        await page.locator(config.login.passwordSelector ?? 'input[type="password"]').fill(resource.password);
        const [response] = await Promise.all([
          page.waitForResponse(response => new URL(response.url()).pathname === config.login.path && response.request().method() === 'POST'),
          config.login.submitSelector ? page.locator(config.login.submitSelector).click() : page.getByRole('button', { name: /^登\s*录$/ }).click(),
        ]);
        const body = await response.json();
        state.token = (config.login.tokenFields ?? [config.login.tokenField]).map(field => observationAt(body, field)).find(Boolean);
        if (!response.ok() || !state.token) throw agentError('Configured login did not establish a session');
        const identity = {};
        for (const [key, field] of Object.entries(config.login.identityFields ?? {})) {
          if (!Array.isArray(field) || !field.length) throw agentError('Configured login identity field must be a nonempty path: ' + key);
          const value = observationAt(body, field);
          if (/password|token|secret|cookie|authorization/i.test(key + ' ' + field.at(-1))
            || !['string', 'number'].includes(typeof value) || value === '' || value === state.token) {
            throw agentError('Configured login identity field is missing or is not a public identity: ' + key);
          }
          identity[key] = String(value);
        }
        state.authentication = { resource: resourceName, at: new Date().toISOString(), path: config.login.path,
          authenticated: true, identity, response: sanitized(body) };
      } catch (error) {
        sessions.delete(resourceName);
        await browser.close();
        throw error;
      } finally { state.login = false; }
    }
    return state;
  }

  async function http(spec, input, resource) {
    const route = resolveRoute(spec.path, input);
    const url = resourceURL(resource, route);
    const query = resolveInput(spec.query ?? {}, input);
    for (const [key, value] of Object.entries(query)) url.searchParams.set(key, String(value));
    const headers = { accept: 'application/json' };
    const auth = config.resourceAuth?.[spec.resource];
    if (auth && spec.authenticated !== false) {
      if (auth.kind !== 'form') throw agentError('Unsupported configured authentication type');
      if (!authentication.has(spec.resource)) {
        const fields = new URLSearchParams();
        for (const [field, credential] of Object.entries(auth.fields ?? {})) {
          if (!['account', 'username', 'password'].includes(credential) || !resource[credential]) throw agentError('Configured authentication credential is unavailable');
          fields.set(field, resource[credential]);
        }
        const response = await fetch(resourceURL(resource, auth.path), { method: 'POST', body: fields, redirect: 'manual', signal: AbortSignal.timeout(30000) });
        const cookies = response.headers.getSetCookie().map(value => value.split(';')[0]).join('; ');
        if (response.status >= 400 || !cookies) throw agentError('Configured resource authentication did not establish a session');
        authentication.set(spec.resource, cookies);
      }
      headers.cookie = authentication.get(spec.resource);
    }
    if (spec.authenticated !== false && config.login && spec.resource === (config.login.resource ?? 'platform')) {
      const session = await browserSession(spec.resource, resource);
      headers[config.login.header] = session.token;
    }
    if (resource.resource_type === 'rabbitmq') headers.authorization = 'Basic ' + Buffer.from(resource.username + ':' + resource.password).toString('base64');
    const body = resolveInput(spec.body, input);
    const response = await fetch(url, { method: spec.method ?? 'GET', headers: { ...headers, ...(body !== undefined ? { 'content-type': 'application/json' } : {}) },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}), redirect: 'manual', signal: AbortSignal.timeout(spec.timeoutMs ?? 30000) });
    const text = await response.text();
    let data; try { data = JSON.parse(text); } catch { data = text; }
    return { status: response.status, body: sanitized(data), path: url.pathname, method: spec.method ?? 'GET',
      request: { query: sanitized(Object.fromEntries(url.searchParams)), ...(body !== undefined ? { body: sanitized(body) } : {}) } };
  }

  async function performSpec(spec, input, resource) {
    if (spec.kind === 'database') return database(spec, input, resource);
    if (spec.kind === 'http') return http(spec, input, resource);
    if (spec.kind === 'browser') {
      const session = await browserSession(spec.resource, resource);
      const effectPath = resolveRoute(spec.effect.path, input);
      session.effect = { ...spec.effect, path: effectPath, body: resolveInput(spec.effect.body, input) };
      try {
        const [response] = await Promise.all([
          session.page.waitForResponse(response => new URL(response.url()).pathname === effectPath && response.request().method() === spec.effect.method),
          spec.action === 'goto'
            ? session.page.goto(resourceURL(resource, resolveRoute(spec.path, input)).href, { waitUntil: 'domcontentloaded' })
            : session.page.locator(spec.selector).click(),
        ]);
        return { status: response.status(), body: sanitized(await response.json().catch(() => null)) };
      } catch (error) {
        const rejected = session.network.findLast(entry => entry.path === effectPath && entry.error);
        if (rejected) throw agentError(rejected.error);
        throw error;
      } finally { session.effect = null; }
    }
    throw agentError('Unsupported operation kind');
  }
  return {
    async authenticationEvidence(resourceName, resource) {
      if (!config.login || resourceName !== (config.login.resource ?? 'platform')) return null;
      return (await browserSession(resourceName, resource)).authentication;
    },
    async verifyAuthentication(resourceName, resource, expected) {
      if (!expected || !Object.keys(expected.identity ?? {}).length) return;
      const actual = await this.authenticationEvidence(resourceName, resource);
      if (!actual || digest(actual.identity) !== digest(expected.identity)) throw agentError('Authenticated identity changed; reconcile the original target before writing or restoring');
    },
    performSpec,
    async schema(args) {
      return scope.useRead(args.resource, async resource => {
        const connection = await connect(resource, args.database);
        try {
          if (!args.database) { const [rows] = await connection.query('SHOW DATABASES'); return { rows }; }
          if (!args.table) { const [rows] = await connection.query('SHOW TABLES'); return { rows }; }
          const [columns] = await connection.query('SHOW FULL COLUMNS FROM ' + identifier(args.table));
          const [indexes] = await connection.query('SHOW INDEX FROM ' + identifier(args.table));
          const [create] = await connection.query('SHOW CREATE TABLE ' + identifier(args.table));
          const schema = { resource: args.resource, database: args.database, table: args.table, columns, indexes, create };
          schemas.set(args.resource + ':' + args.database + ':' + args.table, schema);
          scope.state.schemas ??= {};
          scope.state.schemas[args.resource + ':' + args.database + ':' + args.table] = schema;
          await scope.saveState();
          return schema;
        } finally { await connection.end(); }
      });
    },
    async perform(name, input, resource) {
      const spec = operations()[name];
      if (!spec) throw agentError('Unknown operation: ' + name);
      return performSpec(spec, input, resource);
    },
    async browser(args) {
      return scope.useRead(args.resource, async resource => {
        const session = await browserSession(args.resource, resource);
        const { page, network } = session;
        if (args.action === 'fault') {
          const operation = operations()[args.operation];
          if (!operation || operation.resource !== args.resource || operation.kind !== 'http' || operation.access !== 'read') throw agentError('Browser fault injection requires a verified read operation on this resource');
          if (args.delayMs !== undefined && (!Number.isFinite(args.delayMs) || args.delayMs < 0)) throw agentError('Invalid fault delay');
          session.fault = { path: operation.path, method: operation.method ?? 'GET', delayMs: args.delayMs, abort: args.abort === true, status: args.status, body: args.body };
          return { fault: session.fault, simulated: true, restore: 'clear_fault or browser session close' };
        }
        if (args.action === 'clear_fault') { session.fault = null; return { restored: true }; }
        if (['goto', 'fill', 'click', 'select', 'check'].includes(args.action)) session.ready = null;
        if (args.action === 'goto') await page.goto(resourceURL(resource, args.path).href, { waitUntil: 'domcontentloaded' });
        else if (args.action === 'fill') await page.locator(args.selector).fill(String(args.value));
        else if (args.action === 'click') await page.locator(args.selector).click();
        else if (args.action === 'select') await page.locator(args.selector).selectOption(String(args.value));
        else if (args.action === 'check') await page.locator(args.selector).setChecked(args.value);
        else if (args.action === 'wait') await waitBusinessReady(page, args.ready);
        else if (!['inspect', 'observe'].includes(args.action)) throw agentError('Unknown browser action');
        if (args.ready) { await waitBusinessReady(page, args.ready); session.ready = { condition: args.ready, at: new Date().toISOString() }; }
        const data = { url: page.url(), network: network.splice(0), ...(session.fault ? { activeFault: session.fault, simulatedFault: true } : {}) };
        if (args.action === 'inspect') data.dom = await page.locator('body').ariaSnapshot();
        if (args.action === 'observe') {
          if (!session.ready) throw agentError('Use a business-ready condition before page observation (loading hidden, busy=false, completed revision); not the expected amount');
          data.ready = session.ready;
          data.values = {};
          data.measurements = {};
          data.dom = await page.locator('body').ariaSnapshot();
          for (const [key, binding] of Object.entries(args.fields ?? {})) {
            const node = page.locator(binding.selector);
            const matches = await node.count();
            data.measurements[key] = { ...binding, matches };
            data.values[key] = binding.read === 'visible' ? await node.isVisible() : binding.read === 'count' ? matches
              : !matches ? (binding.read === 'input' || binding.read === 'attribute' ? null : [])
                : binding.read === 'input' ? await node.inputValue() : binding.read === 'attribute' ? await node.getAttribute(binding.attribute) : await node.allTextContents();
          }
          const filename = `page-${digest([scope.item.caseId, scope.attempt, Date.now()]).slice(0, 24)}.png`;
          await page.screenshot({ path: path.join(scope.reports, filename), fullPage: true });
          data.screenshot = { path: filename, type: '页面实际截图', sanitized: true };
        }
        return data;
      });
    },
    async close() {
      const faults = [];
      for (const [resource, session] of sessions) {
        if (session.fault) faults.push({ resource, fault: session.fault, restored: true, method: 'isolated_browser_closed' });
        await session.browser.close();
      }
      sessions.clear(); authentication.clear(); return faults;
    },
  };
}
