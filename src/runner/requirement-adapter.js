import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import mysql from 'mysql2/promise';
import { chromium } from 'playwright';
import { managementReadAllowed, scopedDatabase } from './requirement-resources.js';
import { askNoTools } from './requirement-generation.js';
import { digest, RequirementWait } from './requirement-feishu.js';
import { readJson, writeJson } from './requirement-files.js';
import { bindCaseAssertions, compileCaseAssertions, evaluateCaseAssertion, observationAt as field } from './requirement-assertions.js';
import { bindSubjectInput, caseSubject, verifySubjectOutput } from './requirement-subject.js';
import { verifyRequirementRelease } from './requirement-release.js';
import { repairPlan } from './requirement-plan.js';

function target(resource, relative, base = resource.base_url ?? resource.management_url) {
  const origin = new URL(base);
  if (!['https:', 'http:'].includes(origin.protocol) || origin.username || origin.password
    || typeof relative !== 'string' || !relative.startsWith('/') || relative.startsWith('//') || relative.includes('\\')) throw new Error('无效的项目资源入口');
  const url = new URL(relative, origin);
  if (url.origin !== origin.origin || url.username || url.password) throw new Error('禁止跨项目网络请求');
  return url;
}

async function record(scope, id, data) {
  const filename = 'runtime-' + digest(id).slice(0, 24) + '.json';
  await writeJson(path.join(scope.reports, filename), scope.checkOutput(data));
  return { path: filename, type: '本轮运行证据', sanitized: true };
}

async function executionBlocked(scope, id, evidence, actual, details) {
  const entry = await record(scope, id, { actual, ...details });
  return { status: '阻断', actual, evidence: [...evidence, entry],
    blocker: { dependency: '执行对象、参数来源或浏览器网络控制', required_action: '核对用例维度和项目操作契约后重试。' } };
}

async function session(resource, login, run, effect, queries = new Map()) {
  const origin = target(resource, '/');
  const endpoint = login && target(resource, login.path);
  const browser = await chromium.launch({ headless: true });
  let allowLogin = false;
  let allowEffect = false;
  const network = [];
  let rejectNetwork;
  const failed = new Promise((_, reject) => { rejectNetwork = reject; });
  failed.catch(() => {});
  const block = (route, reason, query, state = 'blocked') => {
    const request = route.request();
    if (request.method() !== 'GET' || ['xhr', 'fetch', 'document'].includes(request.resourceType())) {
      const address = new URL(request.url());
      network.push({ state, method: request.method(), reason, sameOrigin: address.origin === origin.origin,
        ...(query ? { query: query.name, path: query.url.pathname } : { pathHash: digest(address.pathname) }) });
      rejectNetwork(Object.assign(new Error(reason), { code: state === 'blocked' ? 'BROWSER_QUERY_BLOCKED' : 'BROWSER_NETWORK_ERROR' }));
    }
    return route.abort();
  };
  const isLogin = request => endpoint && request.method() === 'POST' && request.url() === endpoint.href;
  const guardedRequest = async (route, query) => {
    try {
      const response = await route.fetch({ maxRedirects: 0, maxRetries: 0 });
      if (response.status() >= 300 && response.status() < 400) return block(route, '上游重定向未登记', query);
      if (query) network.push({ state: 'response', query: query.name, path: query.url.pathname, method: 'POST',
        params: query.params, status: response.status() });
      return route.fulfill({ response });
    } catch { return block(route, '浏览器网络请求未获得响应', query, 'network_error'); }
  };
  try {
    const context = await browser.newContext({ serviceWorkers: 'block' });
    await context.route('**/*', route => {
      const request = route.request();
      if (allowLogin && isLogin(request)) {
        allowLogin = false;
        if (!managementReadAllowed(resource, 'POST', endpoint.pathname)) return block(route, '管理接口登录路径未通过只读校验');
        return guardedRequest(route);
      }
      const requestUrl = new URL(request.url());
      if (requestUrl.origin !== origin.origin) return block(route, '请求超出浏览器绑定来源');
      if (allowEffect && request.url() === target(resource, effect.path).href && request.method() === effect.method) {
        let payload;
        try { payload = request.postDataJSON(); } catch { return block(route, '提交请求无法核验业务键'); }
        if (field(payload, effect.keyField) !== effect.key) return block(route, '提交请求业务键与意图不一致');
        allowEffect = false;
        return guardedRequest(route);
      }
      if (!managementReadAllowed(resource, request.method(), requestUrl.pathname)) return block(route, '管理接口请求未通过只读校验');
      const matches = [...queries.values()].filter(item => request.method() === 'POST' && request.url() === item.url.href);
      if (matches.length) {
        let payload;
        try { payload = request.postDataJSON(); } catch { return block(route, '只读查询请求无法解析', matches[0]); }
        const query = payload && !Array.isArray(payload) && typeof payload === 'object' && matches.find(item =>
          Object.keys(payload).length === Object.keys(item.params).length
          && Object.entries(item.params).every(([key, value]) => Object.hasOwn(payload, key) && payload[key] === value));
        if (!query) return block(route, '只读查询请求参数与已绑定输入不一致', matches[0]);
        return guardedRequest(route, query);
      }
      return request.method() === 'GET' ? guardedRequest(route) : block(route, '请求不在已登记的只读查询或写入意图内');
    });
    const page = await context.newPage();
    const submit = async locator => {
      if (!effect || !['POST', 'PUT', 'PATCH'].includes(effect.method)) throw new Error('页面提交未绑定已登记变更');
      allowEffect = true;
      try {
        const [response] = await Promise.all([
          page.waitForResponse(response => response.url() === target(resource, effect.path).href
            && response.request().method() === effect.method),
          locator.click(),
        ]);
        if (!response.ok() || allowEffect) throw new Error('页面提交未取得响应');
      } finally { allowEffect = false; }
    };
    const observe = async (name, act) => {
      const query = queries.get(name);
      if (!query) throw new Error('浏览器动作引用未登记的查询');
      await Promise.race([failed, Promise.all([
        page.waitForResponse(response => response.url() === query.url.href && response.request().method() === 'POST'
          && Object.entries(query.params).every(([key, value]) => {
            try { return digest(response.request().postDataJSON()?.[key]) === digest(value); } catch { return false; }
          }))
          .then(response => response.finished()),
        act(),
      ])]);
    };
    const perform = async token => {
      const result = await run({ page, token, submit, observe });
      return queries.size || network.length ? { ...result, network: [...network] } : result;
    };
    if (!endpoint) return await perform();
    await page.goto(resource.base_url, { waitUntil: 'domcontentloaded' });
    await page.getByPlaceholder('请输入用户名', { exact: true }).fill(resource.account);
    await page.locator('input[type=password]').fill(resource.password);
    allowLogin = true;
    const [response] = await Promise.all([
      page.waitForResponse(response => isLogin(response.request())),
      page.getByRole('button', { name: /^登\s*录$/ }).click(),
    ]);
    const payload = await response.json();
    const token = (login.tokenFields ?? [login.tokenField]).map(keys => field(payload, keys))
      .find(value => typeof value === 'string' && value);
    if (!response.ok() || !token) {
      const value = payload.RESPONSE?.RETURN_CODE ?? payload.errorCode ?? payload.code;
      const code = /^-?\d+$/.test(String(value)) ? String(value) : null;
      throw Object.assign(new Error('项目登录未获得可验证会话'), {
        code: 'LOGIN_UNVERIFIED', loginStatus: response.status(), serviceCode: code,
      });
    }
    return await perform(token);
  } catch (error) {
    if (network.length) error.network = [...network];
    throw error;
  } finally {
    await browser.close();
  }
}

function params(spec, input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)
    || Object.keys(input).some(key => !(spec.inputs ?? []).includes(key))
    || Object.values(input).some(value => !['string', 'number', 'boolean'].includes(typeof value) && value !== null)) {
    throw new Error('操作参数不符合已绑定项目接口');
  }
  return input;
}

async function request(resource, spec, input, login, token, readOnly) {
  const url = target(resource, spec.path);
  const headers = { accept: 'application/json' };
  if (token) headers[login.header] = token;
  if (resource.resource_type === 'rabbitmq') {
    headers.authorization = 'Basic ' + Buffer.from(resource.username + ':' + resource.password).toString('base64');
  }
  const method = spec.method ?? 'GET';
  if (readOnly && !managementReadAllowed(resource, method, url.pathname)) {
    throw new RequirementWait('environment_scope', '管理接口请求未通过只读校验');
  }
  if (method === 'GET' || method === 'DELETE') {
    for (const [key, value] of Object.entries(input)) url.searchParams.set(key, String(value));
  }
  const response = await fetch(url, { method, headers, redirect: 'manual',
    ...(['POST', 'PUT', 'PATCH'].includes(method) ? { body: JSON.stringify(input), headers: { ...headers, 'content-type': 'application/json' } } : {}),
    signal: AbortSignal.timeout(15000) });
  if (spec.kind === 'csv') {
    if (!response.ok || !/csv|octet-stream/i.test(response.headers.get('content-type') ?? '')) throw new Error('服务未返回登记的 CSV 导出');
    return { status: response.status, csv: await response.text() };
  }
  const body = await response.json().catch(() => null);
  const values = Object.fromEntries(Object.entries(spec.outputs ?? {}).map(([key, keys]) => [key, field(body, keys)]));
  return { ...values, status: response.status };
}

function sqlIdentifier(value) {
  if (!/^[a-zA-Z0-9_]+$/.test(value ?? '')) throw new Error('数据库标识未明确登记');
  return '\u0060' + value + '\u0060';
}

async function mysqlRead(resource, spec, input) {
  if (resource.resource_type !== 'mysql') throw new Error('数据库资源类型不符');
  const connection = await mysql.createConnection({ host: resource.host, port: Number(resource.port) || 3306,
    user: resource.username, password: resource.password,
    database: scopedDatabase(resource, spec.database),
    connectTimeout: 8000 });
  try {
    if (spec.healthOnly) {
      const [rows] = await connection.query({ sql: 'SELECT 1 AS ready', timeout: 8000 });
      return { ready: rows[0]?.ready === 1 };
    }
    if (!Object.keys(input).length) throw new Error('业务数据库查询必须限定键');
    const filters = Object.keys(input).map(key => sqlIdentifier(spec.columnsByInput?.[key]) + ' = ?');
    const sql = 'SELECT ' + spec.columns.map(sqlIdentifier).join(', ') + ' FROM ' + sqlIdentifier(spec.table)
      + ' WHERE ' + filters.join(' AND ');
    const [rows] = await connection.execute({ sql, timeout: 12000 }, Object.values(input));
    return { rows, count: rows.length };
  } finally {
    await connection.end();
  }
}

async function callResource(resource, spec, input, login, effect, operations = {}, readOnly = true) {
  if (spec.kind === 'mysql') return mysqlRead(resource, spec, input);
  if (spec.kind === 'http' || spec.kind === 'csv') {
    const invoke = ({ token } = {}) => request(resource, spec, input, login, token, readOnly);
    return spec.authenticated ? session(resource, login, invoke) : invoke();
  }
  if (spec.kind === 'browser') return session(resource, spec.authenticated === false ? null : login, async ({ page, submit, observe }) => {
    if (spec.path) {
      await page.goto(target(resource, spec.path).href, { waitUntil: 'domcontentloaded' });
    }
    for (const action of spec.actions ?? []) {
      const value = action.input === undefined ? action.value : input[action.input];
      if (action.kind === 'navigate') {
        const url = target(resource, action.path);
        for (const [parameter, key] of Object.entries(action.query ?? {})) {
          if (!Object.hasOwn(input, key)) throw new Error('页面导航缺少已登记参数');
          url.searchParams.set(parameter, String(input[key]));
        }
        await page.goto(url.href, { waitUntil: 'domcontentloaded' });
        continue;
      }
      const locator = page.locator(action.selector);
      if (action.kind === 'click') {
        if (action.query) await observe(action.query, () => locator.click());
        else await locator.click();
      }
      else if (action.kind === 'submit') await submit(locator);
      else if (action.kind === 'fill' && value != null) await locator.fill(String(value));
      else if (action.kind === 'select' && value != null) await locator.selectOption(String(value));
      else if (action.kind === 'check' && typeof value === 'boolean') await locator.setChecked(value);
      else throw new Error('页面操作或输入未登记');
      if (action.waitFor) await page.locator(action.waitFor).waitFor();
      if (action.ready) await waitBusinessReady(page, action.ready);
    }
    if (spec.ready) await waitBusinessReady(page, spec.ready);
    const values = {};
    for (const [name, selector] of Object.entries(spec.selectors ?? {})) {
      const locator = page.locator(typeof selector === 'string' ? selector : selector.selector);
      if (typeof selector === 'string') values[name] = await locator.allTextContents();
      else if (selector.read === 'text') values[name] = (await locator.innerText()).trim();
      else if (selector.read === 'input') values[name] = await locator.inputValue();
      else if (selector.read === 'visible') values[name] = await locator.isVisible();
      else throw new Error('页面观察方式未登记');
    }
    return { authenticated: true, values };
  }, effect, browserQueries(resource, spec, input, operations));
  throw new Error('未登记的执行操作');
}

export async function waitBusinessReady(page, ready) {
  const rules = Array.isArray(ready) ? ready : [ready];
  for (const rule of rules) {
    if (!rule?.selector) throw new Error('业务就绪条件缺少 selector');
    if (rule.state) await page.locator(rule.selector).waitFor({ state: rule.state, timeout: rule.timeoutMs ?? 30000 });
    else if (Object.hasOwn(rule, 'text') || rule.attribute) {
      await page.waitForFunction(({ selector, text, attribute, value }) => {
        const node = document.querySelector(selector);
        return Boolean(node) && (attribute ? node.getAttribute(attribute) === value : node.textContent.trim() === text);
      }, rule, { timeout: rule.timeoutMs ?? 30000 });
    } else throw new Error('业务就绪条件需要 state、text 或 attribute/value');
  }
}

function browserQueries(resource, spec, input, operations) {
  const queries = new Map();
  for (const [name, binding] of Object.entries(spec.queries ?? {})) {
    const query = Object.hasOwn(operations, name) && operations[name];
    if (query?.kind !== 'http' || query.resource !== spec.resource || query.method !== 'POST' || query.readOnly !== true) {
      throw new Error('浏览器查询必须引用同资源、已登记的只读 POST');
    }
    const mapped = Object.fromEntries(Object.entries(binding.input ?? {}).map(([key, source]) => [key, input[source]]));
    const expected = params(query, { ...binding.fixed, ...mapped });
    if ((query.inputs ?? []).some(key => !Object.hasOwn(expected, key))) throw new Error('浏览器查询缺少登记参数');
    const url = target(resource, query.path);
    queries.set(name, { name, url, params: expected });
  }
  return queries;
}

const mode = (operation, login, resource, input, operations) => callResource(resource, operation, params(operation, input), login, undefined, operations);

function reference(value, index) {
  return value && typeof value === 'object' && Object.keys(value).length === 2
    && Number.isInteger(value.from) && value.from >= 0 && value.from < index
    && Array.isArray(value.field) && value.field.length && value.field.every(key => ['string', 'number'].includes(typeof key));
}

function normalizedSteps(plan, operations) {
  return plan.steps.map((step, index) => {
    const spec = step && Object.hasOwn(operations, step.operation) && operations[step.operation];
    if (!spec || !Array.isArray(step.checks) || !step.input || typeof step.input !== 'object' || Array.isArray(step.input)
      || Object.keys(step.input).some(key => !(spec.inputs ?? []).includes(key) || (spec.kind === 'fixture' && key === spec.key))
      || Object.values(step.input).some(value => value !== null && typeof value === 'object' && !reference(value, index))
      || step.when && (!reference(step.when.ref, index) || !Object.hasOwn(step.when, 'equals')
        || !['string', 'boolean', 'number'].includes(typeof step.when.equals))
      || step.checks.some(check => !check || !Array.isArray(check.field)
        || !Number.isInteger(check.assertion))) {
      throw new RequirementWait('execution_plan', '计划引用未登记操作、观测字段或前置步骤。');
    }
    return { operation: step.operation, input: step.input, checks: step.checks,
      ...(step.subject ? { subject: step.subject } : {}), ...(step.when ? { when: step.when } : {}) };
  });
}

function csvTable(text) {
  const records = [];
  let row = [], cell = '', quoted = false;
  const input = text.replace(/^\uFEFF/, '');
  for (let i = 0; i < input.length; i++) {
    const char = input[i];
    if (char === '"') {
      if (quoted && input[i + 1] === '"') { cell += '"'; i++; }
      else quoted = !quoted;
    } else if (!quoted && char === ',') {
      row.push(cell); cell = '';
    } else if (!quoted && (char === '\n' || char === '\r')) {
      if (char === '\r' && input[i + 1] === '\n') i++;
      records.push([...row, cell]); row = []; cell = '';
    } else cell += char;
  }
  if (quoted) throw new Error('CSV 引号不完整');
  if (row.length || cell) records.push([...row, cell]);
  const [headers, ...rows] = records;
  if (!headers?.length || rows.some(item => item.length !== headers.length)) throw new Error('CSV 行列无法对齐');
  return { headers, rows, rowCount: rows.length };
}

export function createRequirementAdapter(config, options) {
  const operations = config.operations ?? {};
  const login = config.login;

  function fixtureInputs(spec, key, params) {
    if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(spec.key ?? '')) throw new Error('夹具归属键未登记');
    return { ...params, [spec.key]: key };
  }
  async function lookup(spec, key, resource) {
    const data = await callResource(resource, spec.lookup, fixtureInputs(spec, key), login);
    if (data.status !== 200 || typeof data.exists !== 'boolean' || data.exists && data.key !== key) {
      throw new Error('无法确认夹具归属');
    }
    return data;
  }

  function fixtureKey(scope, index, operation) {
    return scope.runPrefix + '_' + digest([scope.item.caseId, index, operation]).slice(0, 12);
  }

  return {
    async probe(scope) {
      const result = {};
      for (const [name, spec] of Object.entries(operations).filter(([, spec]) => spec.probe === true && spec.kind !== 'fixture')) {
        try {
          result[name] = scope.checkOutput(await scope.useRead(spec.resource, resource => mode(spec, login, resource, spec.probeInput ?? {}, operations)));
        } catch (error) {
          result[name] = { error: error.code ?? error.name, loginStatus: error.loginStatus, serviceCode: error.serviceCode };
        }
      }
      return result;
    },
    async verifyDeployment(scope) {
      const fetchRelease = (binding, accept, read) => scope.useRead(binding.resource, async resource => {
        const headers = { accept };
        if (binding.bearer === true && resource.token) headers.authorization = 'Bearer ' + resource.token;
        const response = await fetch(target(resource, binding.path), {
          headers, redirect: 'error', cache: 'no-store', signal: AbortSignal.timeout(15000),
        });
        return { httpStatus: response.status, ...(response.ok ? await read(response) : {}) };
      });
      return verifyRequirementRelease(config, scope,
        artifact => fetchRelease(artifact, 'application/octet-stream', async response => ({ bytes: Buffer.from(await response.arrayBuffer()) })),
        settings => settings.resource
        ? fetchRelease(settings, 'application/json', async response => ({ manifest: await response.json() }))
        : readJson(settings.path).then(manifest => ({ manifest })));
    },

    async prepare(scope) {
      const expected = scope.row[scope.headers.indexOf('预期结果')];
      const compiled = compileCaseAssertions(expected, operations);
      if (scope.item.assertions && digest(scope.item.assertions) !== digest(compiled)) {
        throw new RequirementWait('execution_plan', '发布用例的断言契约与当前操作目录不一致，请核对同版本的业务观测定义。');
      }
      const subject = caseSubject(scope, config.dimensions);
      const { plan, steps: normalized } = await repairPlan({ generate: options.plan ?? askNoTools, scope, operations,
        normalize: normalizedSteps, options: { cwd: options.workDir, workDir: options.workDir, codexBin: options.codexBin }, prompt: [
        '根据回归 Skill 与本轮用例选择已登记操作。仅输出 JSON {steps:[{operation,input,checks:[{field,operator,expected,assertion}]}],missing:[]}',
        '输入可引用前序观测 {from:从0开始的步骤编号,field:[路径]}。条件步骤可用 when:{ref:{from,field},equals:值}。条件跳过后缺少的断言会标记验证不足。',
        '每项断言使用 {assertion,field}；assertion 是 compiled.clauses 中的编号，field 绑定登记的观测。程序负责运算和期望值。计划应使用 subject 中的确定对象和维度；不能猜测或用其他对象替代。缺少前置或无法执行时写入 missing。',
        '存在多个合法主体时，每个步骤用 subject:{维度名:候选value} 明确选择候选，分别绑定各次切换的输入、观测和断言。',
        scope.standards,
        JSON.stringify({ headers: scope.headers, row: scope.row, compiled, subject, operations: Object.fromEntries(Object.entries(operations)
          .map(([name, spec]) => [name, { kind: spec.kind, description: spec.description, inputs: spec.inputs ?? [],
            outputs: Object.keys(spec.outputs ?? spec.lookup?.outputs ?? spec.selectors ?? {}), observations: spec.observations, subject: spec.subject }])) }),
      ].join('\n\n') });
      const bound = bindCaseAssertions(expected, normalized, operations, compiled);
      const prerequisites = bound.steps.flatMap((step, index) => {
        const spec = Object.hasOwn(operations, step.operation) && operations[step.operation];
        if (spec.kind !== 'fixture' && spec.precondition !== true) return [];
        const owned = spec.kind === 'fixture';
        return [{ prerequisite_id: 'PRE-' + digest([scope.item.caseId, index]).slice(0, 16),
          case_ids: [scope.item.caseId], requirement_ref: scope.item.requirementIds,
          objects: spec.object ?? step.operation, target_state: spec.targetState ?? (owned ? '创建可回读的本轮专属对象' : '查询本轮前置条件'),
          construction_entry: step.operation, unique_identifier: owned ? fixtureKey(scope, index, step.operation) : scope.runPrefix + '_lookup_' + index,
          verification_method: owned ? '用同一业务键回读对象及归属' : '登记字段的本轮观测',
          cleanup_method: owned ? '按原业务键删除并回读前置状态' : '只读查询，无需清理' }];
      });
      return { plan: { ...bound, subject: subject.values, missing: [...plan.missing, ...bound.missing, ...subject.gaps] }, prerequisites };
    },

    async execute(scope) {
      const { steps, missing: gaps, expectedCount, subject = {} } = scope.preparation.plan;
      const missing = [...gaps];
      const evidence = [];
      const observed = [];
      const outputs = [];
      const lineage = [];
      const codeChains = [];
      const exportValidations = [];
      const fixVerifications = [];
      let ran = false;
      for (const [index, step] of steps.entries()) {
        if (gaps.length) break;
        const spec = operations[step.operation];
        const id = [scope.item.caseId, index, step.operation];
        const key = fixtureKey(scope, index, step.operation);
        if (step.when) {
          const value = field(outputs[step.when.ref.from], step.when.ref.field);
          if (value === undefined) missing.push('步骤 ' + (index + 1) + ' 缺少可判断的分支条件。');
          if (value !== step.when.equals) continue;
        }
        const input = Object.fromEntries(Object.entries(step.input).map(([name, value]) =>
          [name, reference(value, index) ? field(outputs[value.from], value.field) : value]));
        if (Object.values(input).some(value => value === undefined)) {
          missing.push('步骤 ' + (index + 1) + ' 缺少前序业务数据。');
          continue;
        }
        if (spec.kind === 'fixture' && missing.length) continue;
        const binding = bindSubjectInput({ spec, step, input, expected: subject, lineage, index });
        if (binding.error) return executionBlocked(scope, id, evidence, binding.error, { binding });
        let data;
        try {
          const checkpoint = scope.completedSteps?.[index];
          if (checkpoint) {
            if (checkpoint.inputHash !== digest(input)) throw new RequirementWait('execution_plan', '已执行步骤的输入与检查点不一致。');
            await scope.assertRead?.(spec.resource);
            data = checkpoint.data;
            if (checkpoint.mutationEvidence) evidence.push(...checkpoint.mutationEvidence);
          } else if (spec.kind === 'fixture') {
            await scope.assertWrite?.(spec.resource, 'delete');
            params(spec, input);
            const old = scope.mutations.find(record => record.intent.id === String(index));
            const snapshot = old?.intent.snapshot ?? await scope.useRead(spec.resource, resource => lookup(spec, key, resource));
            if (!old && snapshot.exists) throw new RequirementWait('mutation_scope', '运行夹具键已被占用。');
            const receipt = await scope.invoke({ id: String(index), target: step.operation, object: spec.object ?? step.operation,
              resource: spec.resource, operation: 'create', businessKey: key, beforeHash: old?.intent.beforeHash ?? digest(snapshot), snapshot,
              inputHash: digest(input), cleanupAction: '删除唯一运行夹具并回读' }, async resource => {
              const effect = spec.create.kind === 'browser' ? { ...spec.create.effect, key } : undefined;
              await callResource(resource, { resource: spec.resource, ...spec.create }, fixtureInputs(spec, key, input), login, effect, operations, false);
              const after = await lookup(spec, key, resource);
              if (!after.exists) throw new Error('创建回执缺少运行夹具');
              return { observed: after, evidence: [await record(scope, [...id, 'mutation'], after)] };
            });
            data = receipt.observed;
            evidence.push(...receipt.evidence);
            await scope.saveStep?.(index, { inputHash: digest(input), data, mutationEvidence: receipt.evidence });
          } else {
            if (['http', 'csv'].includes(spec.kind) && !['GET', 'HEAD'].includes(spec.method ?? 'GET') && spec.readOnly !== true) {
              throw new RequirementWait('mutation_scope', '非读取方法须明确登记为查询或纳入带恢复台账的变更。');
            }
            data = await scope.useRead(spec.resource, resource => mode(spec, login, resource, input, operations));
            if (spec.kind === 'http' && !(spec.observeStatuses
              ? spec.observeStatuses.includes(data.status) : data.status >= 200 && data.status < 300)) {
              ran = true;
              throw new Error('响应未达到登记的业务观测条件');
            }
            if (spec.kind !== 'csv') await scope.saveStep?.(index, { inputHash: digest(input), data });
          }
        } catch (error) {
          if (error instanceof RequirementWait && error.code === 'environment_scope') {
            const entry = await record(scope, id, { reason: error.message, resource: spec.resource });
            return { status: '阻断', actual: error.message, evidence: [...evidence, entry],
              blocker: { dependency: '已授权的非生产资源', required_action: '核对受影响资源的环境归属和操作权限。' } };
          }
          if (error instanceof RequirementWait || spec.kind === 'fixture') throw error;
          if (error.network?.length) {
            const actual = error.network.some(item => item.state !== 'response') ? '浏览器请求被拦截或未收到响应。'
              : '服务已经响应，登记的页面观测未完成。';
            return executionBlocked(scope, id, evidence, actual, { network: error.network, errorClass: error.code ?? error.name });
          }
          const actual = '已尝试 ' + step.operation + '，运行环境未返回可核验证据。';
          evidence.push(await record(scope, id, { actual, errorClass: error.code ?? error.name }));
          return { status: ran ? '阻断' : '未执行', actual, evidence,
            blocker: { dependency: step.operation, required_action: '核对后台工具及对应测试资源。' } };
        }
        if (data.network?.some(item => item.state !== 'response')) {
          return executionBlocked(scope, id, evidence, '浏览器请求被拦截或未收到响应。', { network: data.network });
        }
        let exported;
        if (spec.kind === 'csv') {
          const filename = 'runtime-' + digest(id).slice(0, 24) + '.csv';
          const csv = scope.checkOutput(data.csv);
          const parsed = csvTable(csv);
          await writeFile(path.join(scope.reports, filename), csv, { encoding: 'utf8', mode: 0o600 });
          data = { ...parsed, status: data.status };
          exported = { path: filename, type: '本轮下载并重开的 CSV', sanitized: true };
          evidence.push(exported);
        }
        outputs[index] = data;
        ran = true;
        const identity = verifySubjectOutput(data, binding.entries, spec);
        if (identity.error) return executionBlocked(scope, id, evidence, identity.error, { binding, identity });
        const checks = step.checks.map(rule => evaluateCaseAssertion(data, rule));
        const observation = await record(scope, id, { operation: step.operation, subject: identity.verified, observed: data, checks });
        lineage[index] = { operation: step.operation, subject: identity.verified, data, evidence: observation.path };
        evidence.push(observation);
        observed.push(...checks.map(check => ({ ...check, evidence: observation })));
        const comparable = checks.length && checks.every(check => check.compared);
        if (exported) exportValidations.push({
          export_id: 'EXPORT-' + digest(id).slice(0, 16), file_path: exported.path, opens: '已重开并解析',
          row_count: String(data.rowCount), filters: JSON.stringify(input), headers_check: data.headers,
          status: comparable ? checks.every(check => check.passed) ? '通过' : '失败' : '阻断', evidence: [exported, observation],
        });
        if (spec.fixVerification && comparable) fixVerifications.push({ ...spec.fixVerification,
          outcome: checks.every(check => check.passed) ? '已修复' : '未修复', evidence: [observation],
          current_result: checks.every(check => check.passed) ? '本轮复测断言通过' : '本轮复测观察到与预期不符的结果' });
        if (spec.codeChain) {
          const repositories = scope.repositories.filter(repo => spec.codeChain.repositories?.includes(repo.name));
          if (repositories.length) codeChains.push({
            chain_id: 'CHAIN-' + digest(id).slice(0, 16), entry: spec.path ?? spec.table,
            output: '本轮执行：' + step.operation + '。对应观测见用例证据。',
            repository_commit: repositories.map(repo => repo.name + ' ' + repo.commit),
            files_symbols: spec.codeChain.files, risk_notes: '接口入口已实测，内部调用来源为已登记源码定位。',
          });
        }
      }
      const specialty = { code_chains: codeChains, export_validations: exportValidations, fix_verifications: fixVerifications };
      const covered = new Set(observed.filter(check => check.compared && check.evidence?.path).map(check => check.assertion));
      if (missing.length || covered.size !== expectedCount || observed.some(check => !check.compared)) {
        const unavailable = observed.filter(check => !check.compared)
          .map(check => '预期 ' + check.assertion + ' 缺少可比的值、单位或计算输入：' + check.fragment);
        const details = [...new Set([...missing, ...unavailable])];
        const actual = '已取得 ' + covered.size + '/' + expectedCount + ' 项可比观测。'
          + (details.length ? details.join('。') + '。' : '未执行的条件步骤缺少本轮观测。');
        evidence.push(await record(scope, [scope.item.caseId, 'plan'], { missing, expectedCount, covered: [...covered] }));
        return { status: ran ? '阻断' : '未执行', actual, evidence, specialty,
          assertions: observed, blocker: { dependency: details.length ? details.join('。') : '条件步骤未返回本轮观测',
            required_action: '按缺项核对项目观测字段、测试条件或确认原始业务口径。' } };
      }
      const failures = observed.filter(check => !check.passed);
      const actual = observed.map(check => '预期 ' + check.assertion + ' 实测 ' + String(check.exactObserved ?? check.observed)
        + (check.unit ?? '') + '，预期 ' + String(check.exactExpected ?? check.expected) + (check.expectedUnit ?? '')).join('。');
      return { status: failures.length ? '失败' : '通过', actual, evidence, specialty, assertions: observed, ...(failures.length ? {
        issue: { severity: '一般', classification: '证据质量', problem_business_impact: '观测值与用例预期不一致，具体归因待核对。',
          expected_result: scope.row[scope.headers.indexOf('预期结果')] },
      } : {}) };
    },

    async reconcile(scope) {
      const spec = operations[scope.intent.target];
      const observed = await scope.useRead(spec.resource, resource => lookup(spec, scope.intent.businessKey, resource));
      const evidence = [await record(scope, [scope.key, 'reconcile'], observed)];
      return observed.exists ? { status: 'applied', receipt: { observed, evidence } }
        : digest(observed) === scope.intent.beforeHash ? { status: 'not_applied', evidence } : { status: 'uncertain', evidence };
    },

    async cleanup(scope) {
      const pending = [];
      const records = [];
      const evidence = [];
      for (const mutation of [...scope.mutations].reverse()) {
        const { intent } = mutation;
        const spec = operations[intent.target];
        try {
          const restored = await scope.restore(mutation.key, 'delete', async resource => {
            const before = await lookup(spec, intent.businessKey, resource);
            if (!mutation.cleanup?.before) {
              const observation = await record(scope, [mutation.key, 'before-cleanup'], before);
              await scope.saveCleanup?.(mutation.key, { before, beforeEvidence: [observation] });
            }
            if (before.exists) await callResource(resource, spec.remove, fixtureInputs(spec, intent.businessKey), login, undefined, {}, false);
            const after = await lookup(spec, intent.businessKey, resource);
            if (after.exists || digest(after) !== intent.beforeHash) throw new Error('清理回读与前置快照不同');
            return after;
          });
          const restoredEvidence = await record(scope, [mutation.key, 'cleanup'], restored);
          await scope.saveCleanup?.(mutation.key, { verified: true, after: restored, evidence: [restoredEvidence] });
          evidence.push(restoredEvidence);
          records.push({ cleanup_id: 'CLEAN-' + digest(mutation.key).slice(0, 16), case_ids: [mutation.caseId],
            target: intent.target, identifier: intent.businessKey, expected_state: '恢复至夹具创建前',
            cleanup_action: intent.cleanupAction, actual_state: '已核验夹具不存在，前后观测摘要一致', status: '已清理',
            mutationKey: mutation.key, evidence: [restoredEvidence] });
        } catch (error) {
          pending.push(mutation.key);
          const attempt = (mutation.cleanup?.attempts?.length ?? 0) + 1;
          const entry = await record(scope, [mutation.key, 'cleanup-pending', attempt], {
            key: intent.businessKey, attempt, verified: false, errorClass: error.code ?? error.name,
          });
          await scope.saveCleanup?.(mutation.key, { attempts: [...(mutation.cleanup?.attempts ?? []), entry] });
          evidence.push(entry);
        }
      }
      if (!scope.mutations.length) evidence.push(await record(scope, [scope.runPrefix, 'cleanup'], { mutations: 0 }));
      return { verified: !pending.length, pending, records, evidence };
    },
  };
}
