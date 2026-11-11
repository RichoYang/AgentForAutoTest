import { readFile, realpath, stat } from 'node:fs/promises';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { isDeepStrictEqual, promisify } from 'node:util';
import { createHash, randomUUID } from 'node:crypto';
import mysql from 'mysql2/promise';
import { chromium } from 'playwright';
import { observationAt } from './requirement-assertions.js';
import { waitBusinessReady } from './requirement-adapter.js';
import { digest } from './requirement-feishu.js';
import { buildRecordSnapshot } from './requirement-snapshot.js';
import { credentialField, managementReadAllowed, scopedDatabase } from './requirement-resources.js';

const exec = promisify(execFile);
// Executed as one synchronous DOM read. No caller-provided code runs in the page.
function captureDomRecord({ layout, rows: selector, fields, match }) {
  const names = Object.keys(fields);
  if (!names.length || !Object.keys(match).length || Object.entries(match).some(([key, value]) =>
    !Object.hasOwn(fields, key) || typeof value !== 'string' || !value.trim())) return { error: 'DOM record requires exact nonempty string keys declared in fields' };
  if ((layout === 'rows') !== Boolean(selector)) return { error: 'Only rows layout requires a row selector' };
  const visible = node => node.getClientRects().length > 0 && getComputedStyle(node).visibility === 'visible';
  const nodes = (root, css) => [...root.querySelectorAll(css)].filter(visible);
  const read = (node, field) => field.read === 'attribute' ? node.getAttribute(field.attribute) : node.innerText;
  const fromColumns = columns => columns[0].map((_, index) => Object.fromEntries(names.map((name, col) => [name, columns[col][index]])));
  let rows, rawColumns;
  if (layout === 'rows') {
    rows = nodes(document, selector).map(row => Object.fromEntries(names.map(name => {
      const field = fields[name], matches = nodes(row, field.selector);
      return [name, matches.length === 1 ? read(matches[0], field) : null];
    })));
  } else {
    rawColumns = names.map(name => nodes(document, fields[name].selector).map(node => read(node, fields[name])));
    let columns = rawColumns;
    if (layout === 'json_parallel') {
      try { columns = rawColumns.map(column => column.length === 1 ? JSON.parse(column[0]) : null); }
      catch { return { error: 'Encoded DOM columns must be JSON arrays, not ambiguous delimiter-joined text' }; }
      if (columns.some(column => !Array.isArray(column))) return { error: 'Each encoded DOM column needs one visible JSON array' };
    }
    if (columns.some(column => column.length !== columns[0].length)) return { error: 'Parallel DOM columns have different lengths' };
    rows = fromColumns(columns);
  }
  if (rows.some(row => Object.values(row).some(value => typeof value !== 'string'))) return { error: 'DOM row fields require one visible value per field and row' };
  const matches = rows.filter(row => Object.entries(match).every(([name, value]) => row[name] === value));
  if (matches.length > 1) return { error: 'DOM record identity matched multiple visible rows' };
  return { selected: matches[0] ?? null, matched: matches.length, rows, ...(rawColumns ? { rawColumns } : {}) };
}

export const agentError = message => Object.assign(new Error(message), { safeMessage: message });
// mysql2 decoding under connect()'s exact-number/date settings; JSON/binary and
// unknown wire types deliberately have no inferred scalar representation.
export function mysqlResultColumns(fields=[]) {
  return fields.map(field => ({name:field.name,columnType:field.columnType,flags:field.flags,characterSet:field.characterSet,
    representation:[0,8,246,7,10,11,12,14].includes(field.columnType)?'string'
      :[1,2,3,4,5,9,13].includes(field.columnType)?'number'
      :[15,253,254].includes(field.columnType)&&Number.isInteger(field.characterSet)&&field.characterSet!==63?'string':null}));
}
// mysql2 sends JavaScript numbers as DOUBLE. Older MySQL 8.0 servers can
// reprepare the entire statement and lose a neighbouring BIGINT string bind.
// Decimal text lets the server apply the type derived from each SQL expression.
export function mysqlParameters(values) {
  return values.map((value, index) => {
    if (typeof value === 'number') {
      if (!Number.isFinite(value) || Number.isInteger(value) && !Number.isSafeInteger(value)) {
        throw agentError(`SQL parameter ${index + 1} is not an exact finite number; pass the original decimal or integer as a string`);
      }
      return String(value);
    }
    return typeof value === 'boolean' ? (value ? '1' : '0') : value;
  });
}
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
  const sensitivePath = /(?:^|[\\/])(?:\.git|\.env[^\\/]*|\.npmrc|settings\.xml|requirement-resource-bindings|[^\\/]+\.ini|[^\\/]+\.local\.[^\\/]+)(?:[\\/]|$)/i;
  if (sensitivePath.test(relative) || sensitivePath.test(args.file ?? '')) throw agentError('Credentials and repository internals are not source-tool output');
  const git = async (folder, argv, encoding = 'utf8') => (await exec('git', ['-C', folder, ...argv],
    { encoding, windowsHide: true, maxBuffer: 32 * 1024 * 1024 })).stdout;
  const readGitRoot = async folder => {
    const top = await git(folder, ['rev-parse', '--show-toplevel']).catch(() => '');
    if (!top) return null;
    const gitRoot = await realpath(top.trim());
    const repoPath = path.relative(actualRoot, gitRoot);
    return repoPath.startsWith('..') || path.isAbsolute(repoPath) ? null : gitRoot;
  };
  const contentSha256 = bytes => createHash('sha256').update(bytes).digest('hex');
  const head = async folder => (await git(folder, ['rev-parse', '--verify', 'HEAD^{commit}'])).trim();
  const listing = (bytes, origin) => {
    const text = bytes.toString('utf8');
    const lines = text.split(/\r?\n/), start = args.start ?? 1, end = args.end ?? start + 199;
    return { sha256: digest(text), contentSha256: contentSha256(bytes), origin, start, end: Math.min(end, lines.length),
      total: lines.length, text: lines.slice(start - 1, end).map((line, i) => `${start + i}: ${line}`).join('\n') };
  };
  if (['refs', 'history', 'show'].includes(args.action)) {
    if (args.ref && (!/^[a-zA-Z0-9_./-]+$/.test(args.ref) || args.ref.startsWith('-'))) throw agentError('Invalid Git ref');
    if (args.file && (args.file.startsWith('/') || args.file.includes('..') || args.file.includes(':'))) throw agentError('Invalid repository file');
    const repo = await readGitRoot(target);
    if (!repo) throw agentError('Git source reference needs a repository inside this project');
    const ref = args.ref ?? 'HEAD';
    const commit = args.action === 'refs' ? null : (await git(repo, ['rev-parse', '--verify', '--end-of-options', ref + '^{commit}'])).trim();
    const origin = { kind: 'git', repository: path.relative(actualRoot, repo) || '.', ref, commit, file: args.file };
    if (args.action === 'show') {
      if (!args.file) throw agentError('Git source show requires a file path');
      return { path: relative, ref, file: args.file, ...listing(await git(repo, ['cat-file', 'blob', commit + ':' + args.file], 'buffer'), origin) };
    }
    const argv = args.action === 'refs' ? ['for-each-ref', '--format=%(refname) %(objectname)', 'refs/heads', 'refs/remotes']
      : ['log', '--format=%H %ad %s', '--date=iso-strict', commit, '--', args.file ?? '.'];
    const stdout = await git(repo, argv);
    const lines = stdout.split(/\r?\n/), start = args.start ?? 1, end = args.end ?? start + 199;
    return { path: relative, ref, file: args.file, origin, sha256: digest(stdout), start, total: lines.length,
      text: lines.slice(start - 1, end).map((line, i) => `${start + i}: ${line}`).join('\n') };
  }
  if (args.action === 'search' || args.action === 'files') {
    // Workspace VCS rules often ignore independently versioned business repos.
    const flags = ['--no-ignore-vcs', '--glob', '!**/node_modules/**', '--glob', '!**/.git/**', '--iglob', '!*.local.*', '--iglob', '!settings.xml',
      '--iglob', '!*.ini', '--iglob', '!.env*', '--iglob', '!.npmrc', '--iglob', '!**/requirement-resource-bindings/**'];
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
  const repo = await readGitRoot(path.dirname(target));
  const commit = repo ? await head(repo).catch(() => null) : null;
  const file = repo ? path.relative(repo, target) : relative;
  const bytes = await readFile(target);
  let status = 'unverified';
  if (repo) {
    const changes = await git(repo, ['status', '--porcelain', '--untracked-files=all', '--', file]);
    status = changes ? changes.slice(0, 2) : await git(repo, ['ls-files', '--error-unmatch', '--', file])
      .then(() => 'clean', () => 'untracked or ignored');
  }
  if (repo && await head(repo).catch(() => null) !== commit) throw agentError('Source HEAD changed while reading; read the file again');
  return { path: relative, ...listing(bytes, { kind: 'worktree', repository: repo ? path.relative(actualRoot, repo) || '.' : null, file, commit, status }) };
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
    [key, credentialField.test(key) ? '[REDACTED]' : sanitized(entry)]));
  if (typeof value === 'string') return value.replace(/((?:[a-z_]*(?:password|token|secret|cookie)|pwd|authorization|(?:admin|private|api|access)[_-]?key|connection[_-]?string)\s*["']?\s*[:=]\s*)[^\r\n,;]+/gi, '$1[REDACTED]');
  return value;
}

export function createAgentResources(config, scope) {
  const sessions = new Map();
  const authentication = new Map();
  const schemas = new Map();
  const responseIds = new WeakMap();
  const operations = () => scope.state.operations;
  const loginFor = resource => config.logins?.[resource] ?? (resource === (config.login?.resource ?? 'platform') ? config.login : undefined);
  const identityFrom = (body, fields, token) => Object.fromEntries(Object.entries(fields ?? {}).map(([key, field]) => {
    if (!Array.isArray(field) || !field.length) throw agentError('Configured login identity field must be a nonempty path: ' + key);
    const value = observationAt(body, field);
    if (credentialField.test(key) || credentialField.test(field.at(-1)) || !['string', 'number'].includes(typeof value) || value === '' || value === token) {
      throw agentError('Configured login identity field is missing or is not a public identity: ' + key);
    }
    scope.checkOutput?.(String(value));
    return [key, String(value)];
  }));
  function queryEvidence(url, names = [], input = {}) {
    const query = {}, queryInput = {};
    let recorded = 0;
    for (const name of new Set(names)) {
      if (credentialField.test(name)) continue;
      const values = url.searchParams.getAll(name);
      try {
        const field = { values, input: input[name] };
        if (!isDeepStrictEqual(field, sanitized(field))) continue;
        scope.checkOutput?.({ [name]: field });
        Object.defineProperty(query, name, { value: values, enumerable: true });
        if (Object.hasOwn(input, name) && input[name] !== undefined) {
          Object.defineProperty(queryInput, name, { value: input[name], enumerable: true });
        }
        recorded += values.length;
      } catch { /* Credential-bearing values are omitted and cannot prove a constraint. */ }
    }
    return { query, queryInput, unrecordedQuery: [...url.searchParams].length - recorded };
  }
  async function send(resource, method, url, transport, dispatch, options = {}) {
    const { fields, input, correlation, operation } = options;
    const detail = fields?.length ? queryEvidence(url, fields, input) : undefined;
    const correlated = correlation === true && Boolean(scope.startRequest);
    const complete = await scope.startRequest?.({ resource, method, path: url.pathname, transport,
      ...detail, ...(operation ? { operation } : {}), ...(correlated ? { correlationSent: true } : {}) });
    let response;
    try { response = await dispatch(correlated ? complete?.id : undefined); }
    catch (error) { await complete?.({ outcome: 'no_response' }); throw error; }
    if (complete?.id) responseIds.set(response, complete.id);
    await complete?.({ outcome: 'response', status: transport === 'browser' ? response.status() : response.status });
    return response;
  }
  async function connect(resource, database, name) {
    if (resource.resource_type !== 'mysql') throw agentError('Resource is not MySQL');
    return send(name, 'CONNECT', { pathname: '/' }, 'database', () => mysql.createConnection({ host: resource.host, port: Number(resource.port) || 3306, user: resource.username,
      password: resource.password, database: scopedDatabase(resource, database),
      supportBigNumbers: true, bigNumberStrings: true, decimalNumbers: false, dateStrings: true,
      // We do not use query attributes; early 8.0 implementations interpret
      // the execute attribute flag as a server cursor and never send its rows.
      flags: ['-CLIENT_QUERY_ATTRIBUTES'],
      multipleStatements: false, connectTimeout: 10000 }));
  }
  async function database(spec, input, resource) {
    const connection = await connect(resource, spec.database, spec.resource);
    try {
      if (spec.access === 'read') {
        if (!/^\s*(?:SELECT|SHOW|DESCRIBE|EXPLAIN|WITH)\b/i.test(spec.sql) || /\b(?:INTO\s+(?:OUTFILE|DUMPFILE)|FOR\s+UPDATE|GET_LOCK|RELEASE_LOCK|SLEEP|BENCHMARK)\b/i.test(spec.sql)) {
          throw agentError('Use a read-only SQL query without locks or file output');
        }
        await connection.query('SET TRANSACTION READ ONLY');
        await connection.beginTransaction();
        const [rows, fields] = await connection.execute({ sql: spec.sql, timeout: 30000 }, mysqlParameters(resolveInput(spec.params ?? [], input)));
        await connection.rollback();
        return { rows: sanitized(rows), count: rows.length, columns:mysqlResultColumns(fields) };
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
      const [result] = await connection.execute({ sql, timeout: 30000 }, mysqlParameters(args));
      if (!Number.isInteger(spec.expectedRows) || spec.expectedRows < 1 || result.affectedRows !== spec.expectedRows) {
        await connection.rollback(); throw agentError(`Affected row count differs from the planned mutation: expected ${spec.expectedRows}, actual ${result.affectedRows}; rolled back`);
      }
      await connection.commit();
      return { affectedRows: result.affectedRows, insertId: String(result.insertId) };
    } finally { await connection.end(); }
  }

  async function browserSession(resourceName, resource) {
    if (sessions.has(resourceName)) return sessions.get(resourceName);
    const login = loginFor(resourceName);
    const browser = await chromium.launch({ headless: true });
    const context = await browser.newContext({ serviceWorkers: 'block' });
    const page = await context.newPage();
    const state = { browser, context, page, token: null, network: [], effect: null, login: false, ready: null, fault: null };
    const entryPath = new URL(resource.entry_url ?? resource.base_url ?? resource.management_url).pathname;
    sessions.set(resourceName, state);
    await context.route('**/*', async route => {
      const request = route.request();
      try {
        const url = new URL(request.url());
        const origin = resourceURL(resource, '/').origin;
        if (url.origin !== origin) throw agentError('Browser request is outside the bound resource');
        await scope.assertRead?.(resourceName);
        const method = request.method();
        const isLogin = state.login && login && url.pathname === login.path && method === 'POST';
        const effect = state.effect && state.effect.path === url.pathname && state.effect.method === method;
        if (!effect && !managementReadAllowed(resource, method, url.pathname)) {
          throw agentError('This management request cannot be registered as read-only');
        }
        if (scope.connectionProbeOnly) {
          const loginRequest = state.login && !state.loginSent && method === 'POST' && url.pathname === login?.path;
          const entry = method === 'GET' && request.resourceType() === 'document' && !state.loginSent && url.pathname === entryPath;
          const asset = method === 'GET' && ['stylesheet', 'script', 'font', 'image'].includes(request.resourceType())
            && /\.(?:css|js|mjs|woff2?|ttf|ico|svg|png|jpe?g|webp)$/i.test(url.pathname);
          if (!loginRequest && !entry && !asset) return route.abort();
          if (loginRequest) state.loginSent = true;
        }
        const fault = state.fault;
        if (fault && fault.path === url.pathname && fault.method === method) {
          state.network.push({ path: url.pathname, method, fault: { ...fault, simulated: true } });
          if (fault.delayMs) await new Promise(resolve => setTimeout(resolve, fault.delayMs));
          if (fault.abort) return route.abort('failed');
          if (fault.status) return route.fulfill({ status: fault.status, contentType: 'application/json', body: JSON.stringify(fault.body ?? {}) });
        }
        if (!['GET', 'HEAD', 'OPTIONS'].includes(method)) {
          const read = Object.values(operations()).find(op => op.resource === resourceName && op.kind === 'http'
            && op.access === 'read' && op.method === method && op.path === url.pathname);
          if (!isLogin && !read && !effect) throw agentError('Browser request needs a verified read contract, or test_mutate with a registered browser goto/click operation and matching effect: '
            + method + ' ' + url.pathname + '. Registering an HTTP write alone does not authorize browser writes.');
          if (effect) {
            const payload = request.postDataJSON();
            if (digest(payload ?? null) !== digest(state.effect.body ?? null)) throw agentError('Browser submit payload differs from the ledger intent: '
              + JSON.stringify({ expected: sanitized(state.effect.body ?? null), received: sanitized(payload ?? null) }) + '. Omit effect.body for a request with no body.');
            state.effect = null;
          }
        }
        const contracts = Object.entries(operations()).filter(([, op]) => op.kind === 'http' && op.access === 'read'
          && op.resource === resourceName && (op.method ?? 'GET') === method && op.path === url.pathname);
        const [operation, single] = contracts.length === 1 ? contracts[0] : [];
        const fields = contracts.flatMap(([, op]) => op.queryEvidence ?? []);
        const response = await send(resourceName, method, url, 'browser', id => route.fetch({ maxRedirects: 0, maxRetries: 0,
          ...(id ? { headers: { ...request.headers(), 'x-agentos-request-id': id } } : {}),
        }), { fields, operation, correlation: single?.requestCorrelation });
        if (response.status() >= 300 && response.status() < 400) throw agentError('Redirect requires a separately verified endpoint');
        if (['xhr', 'fetch'].includes(request.resourceType()) && !(state.login && url.pathname === login?.path)) {
          let body;
          try { body = await response.json(); } catch { body = null; }
          state.network.push({ path: url.pathname, method, status: response.status(), body: sanitized(body),
            ...(responseIds.has(response) ? { requestId: responseIds.get(response) } : {}) });
        }
        await route.fulfill({ response });
      } catch (error) {
        state.network.push({ path: new URL(request.url()).pathname, method: request.method(), error: error.safeMessage ?? 'Browser network request failed' });
        await route.abort().catch(() => {});
      }
    });
    if (login) {
      state.login = true;
      try {
        await page.goto(resource.entry_url ?? resource.base_url, { waitUntil: 'domcontentloaded' });
        await page.locator(login.accountSelector ?? 'input[placeholder="请输入用户名"]').fill(resource.account ?? resource.username);
        await page.locator(login.passwordSelector ?? 'input[type="password"]').fill(resource.password);
        const [response] = await Promise.all([
          page.waitForResponse(response => new URL(response.url()).pathname === login.path && response.request().method() === 'POST'),
          login.submitSelector ? page.locator(login.submitSelector).click() : page.getByRole('button', { name: /^登\s*录$/ }).click(),
        ]);
        const body = await response.json();
        state.token = (login.tokenFields ?? [login.tokenField]).map(field => observationAt(body, field)).find(Boolean);
        if (!response.ok() || !state.token) throw agentError('Configured login did not establish a session');
        scope.rememberSecret?.(state.token);
        const identity = identityFrom(body, login.identityFields, state.token);
        state.authentication = { resource: resourceName, at: new Date().toISOString(), path: login.path,
          authenticated: true, identity };
        const publicResponse = sanitized(body);
        try {
          scope.checkOutput?.(publicResponse);
          if (!JSON.stringify(publicResponse).includes(state.token)) state.authentication.response = publicResponse;
        } catch { /* Keep the selected public identity even if the upstream body echoes a secret. */ }
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
    for (const [key, value] of Object.entries(query)) {
      if (!spec.queryEvidence?.includes(key)) { url.searchParams.set(key, String(value)); continue; }
      const values = Array.isArray(value) ? value : value === undefined ? [] : [value];
      if (values.some(item => !['string', 'boolean', 'number'].includes(typeof item) && item !== null
        || typeof item === 'number' && (!Number.isFinite(item) || Number.isInteger(item) && !Number.isSafeInteger(item)))) {
        throw agentError('Evidence query input needs scalars or an array of scalars. Use decimal text for large integers.');
      }
      url.searchParams.delete(key);
      for (const item of values) url.searchParams.append(key, String(item));
    }
    const headers = { accept: 'application/json' };
    const method = (spec.method ?? 'GET').toUpperCase();
    if (spec.access === 'read' && (!['GET', 'HEAD', 'OPTIONS', 'POST'].includes(method)
      || !managementReadAllowed(resource, method, url.pathname))) {
      throw agentError('This management request cannot be registered as read-only');
    }
    const auth = config.resourceAuth?.[spec.resource];
    if (auth && spec.authenticated !== false) {
      if (auth.kind !== 'form') throw agentError('Unsupported configured authentication type');
      if (!authentication.has(spec.resource)) {
        const fields = new URLSearchParams();
        for (const [field, credential] of Object.entries(auth.fields ?? {})) {
          if (!['account', 'username', 'password'].includes(credential) || !resource[credential]) throw agentError('Configured authentication credential is unavailable');
          fields.set(field, resource[credential]);
        }
        const authUrl = resourceURL(resource, auth.path);
        if (!managementReadAllowed(resource, 'POST', authUrl.pathname)) throw agentError('Configured authentication path is not read-safe');
        const response = await send(spec.resource, 'POST', authUrl, 'http', () => fetch(authUrl, {
          method: 'POST', body: fields, redirect: 'manual', signal: AbortSignal.timeout(30000) }));
        const cookiePairs = response.headers.getSetCookie().map(value => value.split(';')[0]);
        for (const pair of cookiePairs) scope.rememberSecret?.(pair.slice(pair.indexOf('=') + 1));
        const cookies = cookiePairs.join('; ');
        if (response.status >= 400 || !cookies) throw agentError('Configured resource authentication did not establish a session');
        authentication.set(spec.resource, cookies);
      }
      headers.cookie = authentication.get(spec.resource);
    }
    const login = loginFor(spec.resource);
    if (spec.authenticated !== false && login) {
      const session = await browserSession(spec.resource, resource);
      headers[login.header] = session.token;
    }
    if (resource.resource_type === 'rabbitmq') headers.authorization = 'Basic ' + Buffer.from(resource.username + ':' + resource.password).toString('base64');
    const body = resolveInput(spec.body, input);
    const operation = Object.keys(operations()).find(name => operations()[name] === spec);
    const response = await send(spec.resource, method, url, 'http', id => fetch(url, {
      method, headers: { ...headers, ...(id ? { 'x-agentos-request-id': id } : {}), ...(body !== undefined ? { 'content-type': 'application/json' } : {}) },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}), redirect: 'manual', signal: AbortSignal.timeout(spec.timeoutMs ?? 30000) }),
    { fields: spec.queryEvidence, input: query, correlation: spec.requestCorrelation, operation });
    for (const value of response.headers.getSetCookie()) scope.rememberSecret?.(value.split(';')[0].split('=').slice(1).join('='));
    const text = await response.text();
    let data; try { data = JSON.parse(text); } catch { data = text; }
    const detail = spec.queryEvidence ? queryEvidence(url, spec.queryEvidence, query) : undefined;
    const publicQuery = detail ? Object.fromEntries([...url.searchParams].filter(([key]) => Object.hasOwn(detail.query, key))) : Object.fromEntries(url.searchParams);
    const result = { status: response.status, body: sanitized(data), path: url.pathname, method,
      request: { query: sanitized(publicQuery), ...(detail ? { queryEvidence: detail } : {}),
        ...(body !== undefined ? { body: sanitized(body) } : {}) } };
    if (responseIds.has(response)) Object.defineProperty(result, 'requestId', { value: responseIds.get(response) });
    return result;
  }

  async function performSpec(spec, input, resource) {
    if (spec.kind === 'database') return database(spec, input, resource);
    if (spec.kind === 'http') return http(spec, input, resource);
    if (spec.kind === 'browser') {
      const session = await browserSession(spec.resource, resource);
      session.pageAction={id:randomUUID(),startedAt:new Date().toISOString(),action:spec.action,
        ...(spec.action==='goto'?{path:resolveRoute(spec.path,input)}:{selector:spec.selector})};
      session.ready = null;
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
      const login = loginFor(resourceName);
      if (!login) return null;
      const session = await browserSession(resourceName, resource);
      if (!login.identityProbe) return session.authentication;
      const url = resourceURL(resource, login.identityProbe.path);
      const response = await send(resourceName, 'GET', url, 'http', () => fetch(url, { headers: { [login.header]: session.token },
        redirect: 'manual', signal: AbortSignal.timeout(15000) }));
      if (!response.ok) throw agentError('Configured session identity endpoint did not verify the current session');
      return { resource: resourceName, at: new Date().toISOString(), path: url.pathname, authenticated: true,
        identity: identityFrom(await response.json(), login.identityProbe.identityFields, session.token) };
    },
    async verifyAuthentication(resourceName, resource, expected) {
      if (!expected || !Object.keys(expected.identity ?? {}).length) return;
      const actual = await this.authenticationEvidence(resourceName, resource);
      if (!actual || digest(actual.identity) !== digest(expected.identity)) throw agentError('Authenticated identity changed; reconcile the original target before writing or restoring');
    },
    performSpec,
    async inspect(resourceName) {
      return scope.useRead(resourceName, async resource => {
        if (resource.resource_type === 'mysql') {
          const connection = await connect(resource, undefined, resourceName);
          try {
            const [[receipt]] = await connection.query('SELECT 1 AS ready, CURRENT_USER() AS principal, DATABASE() AS databaseName');
            const [grants] = await connection.query('SHOW GRANTS FOR CURRENT_USER');
            const rules = grants.flatMap(row => Object.values(row));
            return { connector: 'mysql', connected: String(receipt.ready) === '1',
              principalMatchesConfiguredUser: receipt.principal.split('@')[0] === resource.username, database: receipt.databaseName,
              globalPrivilege: rules.some(rule => !/^GRANT USAGE ON /i.test(rule) && /\bON \*\.\*/i.test(rule)),
              grantEntries: rules.length };
          } finally { await connection.end(); }
        }
        if (resource.resource_type === 'rabbitmq') {
          const base = new URL(resource.management_url ?? resource.base_url);
          const prefix = base.pathname.replace(/\/$/, '');
          const request = suffix => http({ kind: 'http', access: 'read', resource: resourceName, path: prefix + suffix, authenticated: false }, {}, resource);
          const overview = await request('/api/overview'), who = await request('/api/whoami');
          return { connector: 'rabbitmq_management_http', status: overview.status, identityStatus: who.status,
            principalMatchesConfiguredUser: who.status === 200 && who.body?.name === resource.username,
            tags: Array.isArray(who.body?.tags) ? who.body.tags : typeof who.body?.tags === 'string' ? who.body.tags.split(',') : [] };
        }
        const authentication = await this.authenticationEvidence(resourceName, resource);
        if (authentication) {
          const { response, ...identity } = authentication;
          return { connector: 'http_browser', ...identity };
        }
        const base = new URL(resource.base_url ?? resource.management_url);
        const receipt = await http({ kind: 'http', access: 'read', resource: resourceName, path: base.pathname, authenticated: false }, {}, resource);
        return { connector: resource.resource_type === 'xxl_job' ? 'scheduler_http' : 'http', status: receipt.status,
          authenticated: false, path: receipt.path };
      });
    },
    async snapshot(args) {
      return scope.useRead(args.resource, async resource => {
        const connection = await connect(resource, args.database, args.resource);
        const startedAt = new Date().toISOString();
        try {
          // TIMESTAMP is rendered in the session zone. Fix it before collection
          // so a server default-zone change cannot look like a business change.
          await connection.query("SET time_zone = '+00:00'");
          const table = identifier(args.table);
          const [columns] = await connection.query('SHOW FULL COLUMNS FROM ' + table);
          const [indexes] = await connection.query('SHOW INDEX FROM ' + table);
          const [status] = await connection.execute('SELECT ENGINE FROM information_schema.TABLES WHERE TABLE_SCHEMA=? AND TABLE_NAME=?', [args.database, args.table]);
          if (status[0]?.ENGINE !== 'InnoDB') throw agentError('Consistent snapshots require a transactional InnoDB table; use a source with a proven immutable version for other engines');
          const known = columns.map(column => column.Field);
          const key = indexes.filter(index => index.Key_name === 'PRIMARY').sort((a, b) => a.Seq_in_index - b.Seq_in_index).map(index => index.Column_name);
          if (!key.length) throw agentError('Complete snapshot requires the actual primary key');
          const fields = [...(args.fields ?? known)].sort();
          const filters = args.scope;
          if (!filters || !Object.keys(filters).length || [...Object.keys(filters), ...fields, ...key].some(field => !known.includes(field))) throw agentError('Snapshot needs explicit schema-backed scope and covered key fields');
          if (Object.values(filters).some(value => value === undefined || value !== null && typeof value === 'object')) throw agentError('Snapshot scope values must be exact scalar equalities');
          if ([...key, ...Object.keys(filters)].some(field => !fields.includes(field))) throw agentError('Snapshot fields must include the primary key and scope fields');
          const pageSize = args.pageSize ?? 500;
          if (!Number.isSafeInteger(pageSize) || pageSize < 1) throw agentError('pageSize must be a positive safe integer');
          const where = Object.keys(filters).map(field => identifier(field) + ' <=> ?').join(' AND ');
          const parameters = mysqlParameters(Object.values(filters));
          await connection.query('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ');
          await connection.query('START TRANSACTION WITH CONSISTENT SNAPSHOT, READ ONLY');
          const [counts] = await connection.execute({ sql: 'SELECT COUNT(*) AS count FROM ' + table + ' WHERE ' + where, timeout: 30000 }, parameters);
          const expectedCount = Number(counts[0].count);
          if (!Number.isSafeInteger(expectedCount)) throw agentError('Snapshot count cannot be represented exactly');
          const rows = [], pageCounts = [];
          let offset = 0;
          // A single MVCC snapshot covers the count and every page. A final empty
          // page proves exhaustion even when the count is an exact page multiple.
          for (;;) {
            const [page] = await connection.execute({ sql: 'SELECT ' + fields.map(identifier).join(',') + ' FROM ' + table
              + ' WHERE ' + where + ' ORDER BY ' + key.map(identifier).join(',') + ` LIMIT ${pageSize} OFFSET ${offset}`, timeout: 30000 }, parameters);
            rows.push(...page); pageCounts.push(page.length); offset += page.length;
            if (page.length < pageSize) break;
          }
          const [finalColumns] = await connection.query('SHOW FULL COLUMNS FROM ' + table);
          if (digest(columns) !== digest(finalColumns)) throw agentError('Schema changed during snapshot collection');
          await connection.rollback();
          // Normalize only equality values whose database representation is known
          // from the schema. Do not coerce null or arbitrary strings to zero.
          const normalizedScope = Object.fromEntries(Object.entries(filters).map(([field, value]) => {
            const column = columns.find(column => column.Field === field);
            if (value === null) return [field, null];
            const decimal = column.Type.match(/^(?:decimal|numeric)\(\d+,(\d+)\)/i);
            if (decimal) {
              const match = String(value).match(/^(-?)(\d+)(?:\.(\d+))?$/);
              if (!match || typeof value === 'number' && Number.isInteger(value) && !Number.isSafeInteger(value)) throw agentError('Decimal scope requires an exact value: ' + field);
              const scale = Number(decimal[1]), fraction = match[3] ?? '';
              if (/[^0]/.test(fraction.slice(scale))) throw agentError('Decimal scope would lose precision: ' + field);
              const integer = BigInt(match[2]).toString(), padded = fraction.slice(0, scale).padEnd(scale, '0');
              return [field, (match[1] && (integer !== '0' || /[1-9]/.test(padded)) ? '-' : '') + integer + (scale ? '.' + padded : '')];
            }
            if (/^bigint/i.test(column.Type)) {
              if (!/^-?\d+$/.test(String(value)) || typeof value === 'number' && !Number.isSafeInteger(value)) throw agentError('BIGINT scope requires exact integer text: ' + field);
              return [field, BigInt(value).toString()];
            }
            if (/^(?:tinyint|smallint|mediumint|int|year)\b/i.test(column.Type)) {
              if (!/^-?\d+$/.test(String(value)) || !Number.isSafeInteger(Number(value))) throw agentError('Integer scope is not exact: ' + field);
              return [field, Number(value)];
            }
            return [field, /^(?:date|time|char|varchar|text)/i.test(column.Type) ? String(value) : value];
          }));
          const snapshot = buildRecordSnapshot({ resource: args.resource, database: args.database, table: args.table,
            scope: normalizedScope, key, fields, coverage: args.fields ? 'explicit-fields' : 'all-schema-fields',
            schemaFingerprint: digest([columns, indexes]), timestampTimeZone: '+00:00', dateTimePolicy: 'preserve stored calendar value' }, rows,
          { complete: true, expectedCount, consistency: 'repeatable-read', isolation: 'REPEATABLE READ', engine: 'InnoDB',
            pages: pageCounts.length, pageCounts, pageSize, startedAt, finishedAt: new Date().toISOString() });
          scope.state.schemas ??= {};
          scope.state.schemas[args.resource + ':' + args.database + ':' + args.table] = { resource: args.resource, database: args.database, table: args.table, columns, indexes };
          await scope.saveState();
          // Hashes are calculated before redaction; secrets can affect equality
          // but their plaintext never leaves this connector.
          return sanitized(snapshot);
        } finally { await connection.end(); }
      });
    },
    async schema(args) {
      return scope.useRead(args.resource, async resource => {
        const connection = await connect(resource, args.database, args.resource);
        try {
          if (!args.database) {
            const bound = scopedDatabase(resource);
            if (bound) return { rows: [{ Database: bound }] };
            const [rows] = await connection.query('SHOW DATABASES'); return { rows };
          }
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
        const actionStartedAt = new Date().toISOString();
        if (args.action === 'fault') {
          const operation = operations()[args.operation];
          if (!operation || operation.resource !== args.resource || operation.kind !== 'http' || operation.access !== 'read') throw agentError('Browser fault injection requires a verified read operation on this resource');
          if (args.delayMs !== undefined && (!Number.isFinite(args.delayMs) || args.delayMs < 0)) throw agentError('Invalid fault delay');
          session.fault = { path: operation.path, method: operation.method ?? 'GET', delayMs: args.delayMs, abort: args.abort === true, status: args.status, body: args.body };
          return { fault: session.fault, simulated: true, restore: 'clear_fault or browser session close' };
        }
        if (args.action === 'clear_fault') { session.fault = null; return { restored: true }; }
        if (['goto', 'fill', 'click', 'select', 'check'].includes(args.action)) {
          session.ready = null;session.pageAction={id:randomUUID(),startedAt:actionStartedAt,action:args.action,
            ...(args.path?{path:args.path}:{}),...(args.selector?{selector:args.selector}:{}),...(Object.hasOwn(args,'value')?{value:args.value}:{})};
        }
        if (args.action === 'goto') await page.goto(resourceURL(resource, args.path).href, { waitUntil: 'domcontentloaded' });
        else if (args.action === 'fill') await page.locator(args.selector).fill(String(args.value));
        else if (args.action === 'click') await page.locator(args.selector).click();
        else if (args.action === 'select') await page.locator(args.selector).selectOption(String(args.value));
        else if (args.action === 'check') await page.locator(args.selector).setChecked(args.value);
        else if (args.action === 'wait' && !args.ready) throw agentError('Browser wait requires ready');
        else if (!['inspect', 'observe', 'wait'].includes(args.action)) throw agentError('Unknown browser action');
        if (args.ready) { await waitBusinessReady(page, args.ready); session.ready = { condition: args.ready, at: new Date().toISOString() }; }
        const data = { url: page.url(), network: network.splice(0), lifecycle: { actionStartedAt,pageAction:session.pageAction,
          actionCompletedAt: new Date().toISOString(), observationTimestampMeaning: 'saved after this action and its requested readiness wait' },
          ...(session.fault ? { activeFault: session.fault, simulatedFault: true } : {}) };
        if (args.action === 'inspect') data.dom = await page.locator('body').ariaSnapshot();
        if (args.action === 'observe') {
          if (!session.ready) throw agentError('Use a business-ready condition before page observation (loading hidden, busy=false, completed revision); not the expected amount');
          await waitBusinessReady(page, session.ready.condition);
          data.ready = { ...session.ready, at: new Date().toISOString() };
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
          if (args.record) {
            if (Object.hasOwn(data.values, args.record.name)) throw agentError('DOM record name conflicts with an observed field');
            const capture = await page.evaluate(captureDomRecord, args.record);
            if (capture.error) throw agentError(capture.error);
            data.values[args.record.name] = capture.selected;
            data.measurements[args.record.name] = { record: args.record, count: capture.rows.length, matched: capture.matched };
            data.domRecords = { [args.record.name]: capture };
          }
          const filename = `page-${digest([scope.item.caseId, scope.attempt, Date.now()]).slice(0, 24)}.png`;
          scope.checkOutput?.(data);
          await page.screenshot({ path: path.join(scope.reports, filename), fullPage: true, mask: [page.locator('input[type=password]')] });
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
