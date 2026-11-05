import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createServer } from 'node:http';
import { createRequirementAdapter } from '../src/runner/requirement-adapter.js';
import { bindCaseAssertions } from '../src/runner/requirement-assertions.js';
import { digest } from '../src/runner/requirement-feishu.js';
import { generateValidatedCases } from '../src/runner/requirement-generation.js';
import { generatorReferences, loadSkill, regressionReferences, writeJson } from '../src/runner/requirement-files.js';
import { buildRequirementReport } from '../src/runner/requirement-report.js';

const balance = { id: 'balance', label: '预算余额', type: 'number', unit: '元', field: ['balance'] };
const check = (field, expected, operator = 'equals', assertion = 1) => ({ field, expected, operator, assertion });
const dimensions = {
  account: { labels: ['经销商'], pattern: '[A-Z]' },
  period: { labels: ['期间'], pattern: '\\d{4}' },
  key: { labels: ['业务键'], pattern: 'K[0-9]+' },
};
const subject = Object.fromEntries(Object.keys(dimensions).map(key => [key, { input: key, output: [key] }]));
const baseline = process.env.AGENTOS_BINDING_REPRO === 'before';
const requested = [];
const operations = {
  balance: { kind: 'http', resource: 'platform', path: '/balance', inputs: ['account', 'period', 'key'], subject,
    outputs: { balance: ['balance'], account: ['account'], period: ['period'], key: ['key'] }, observations: [balance] },
  query: { kind: 'http', resource: 'platform', path: '/query', method: 'POST', readOnly: true, inputs: ['region'] },
  page: { kind: 'browser', resource: 'platform', path: '/page', authenticated: false, inputs: ['region'],
    queries: { query: { input: { region: 'region' } } },
    actions: [{ kind: 'click', selector: '#load', query: 'query' }],
    selectors: { result: { selector: '#result', read: 'text' },
      before: { selector: '#before', read: 'text' }, state: { selector: '#state', read: 'text' } },
    observations: [{ id: 'result', label: '读取结果', type: 'text', field: ['values', 'result'] },
      { id: 'previous', label: '初始状态', type: 'text', field: ['values', 'before'] },
      { id: 'state', label: '页面状态', type: 'text', field: ['values', 'state'], previous: 'previous' }] },
};

test('subject, browser query and natural assertion boundary', async t => {
  const directory = await mkdtemp(path.join(tmpdir(), 'agentos-binding-'));
  let amount = 0;
  let occupied = 60;
  let replyAccount;
  let pageMode = 'normal';
  const server = createServer(async (req, res) => {
    const url = new URL(req.url, 'http://localhost');
    const data = Object.fromEntries(url.searchParams);
    let body = '';
    for await (const chunk of req) body += chunk;
    requested.push({ method: req.method, path: url.pathname, data, ...(body && url.pathname !== '/auth' ? { body: JSON.parse(body) } : {}) });
    if (url.pathname === '/balance') return res.end(JSON.stringify({ ...data, account: replyAccount ?? data.account,
      balance: data.account === 'A' ? amount : 100, total: 160, occupied, invalid: false }));
    if (url.pathname === '/lookup') return res.end(JSON.stringify({ ...data, id: 'id-' + data.account, alternate: 'id-B' }));
    if (url.pathname === '/by-id') return res.end(JSON.stringify({ ...data, balance: 100 }));
    if (url.pathname === '/query') {
      if (pageMode === 'network-error') return req.socket.destroy();
      res.statusCode = pageMode === 'bad-response' ? 422 : 200;
      return res.end(pageMode === 'bad-response' ? '服务拒绝' : '读取成功');
    }
    if (url.pathname === '/auth') return res.end(JSON.stringify({ token: 'local-fixture-session' }));
    res.setHeader('content-type', 'text/html; charset=utf-8');
    if (url.pathname === '/sign-in') return res.end(`<input placeholder="请输入用户名"><input type="password"><button onclick="fetch('/auth',{method:'POST'})">登录</button>`);
    res.end(`<button id="load">加载</button><p id="result">读取失败</p><p id="before"></p><p id="state">待审</p><script>
      document.querySelector('#load').onclick = async () => { try {
        const response = await fetch('${pageMode === 'blocked' ? '/write' : '/query'}',{method:'POST',headers:{'Content-Type':'application/json'},body:'{"region":"${pageMode === 'wrong-params' ? 'other' : 'local'}"}'});
        document.querySelector('#result').textContent = await response.text();
        document.querySelector('#before').textContent = document.querySelector('#state').textContent;
        if (response.ok) document.querySelector('#state').textContent = '已审';
      } catch {} };</script>`);
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const saved = [];
  t.after(async () => {
    await new Promise(resolve => server.close(resolve));
    if (process.env.AGENTOS_BINDING_EVIDENCE) await writeFile(process.env.AGENTOS_BINDING_EVIDENCE, JSON.stringify({ requested, saved, listenerClosed: !server.listening }, null, 2));
    await rm(directory, { recursive: true, force: true });
  });
  const base_url = 'http://127.0.0.1:' + server.address().port;
  async function run(operation, input, checks, expected, context = '', steps = [{ operation, input, checks }]) {
    const adapter = createRequirementAdapter({ operations, dimensions, login: { path: '/auth', tokenField: ['token'] } },
      { plan: async () => ({ steps, missing: [] }) });
    const scope = { item: { caseId: 'CASE-test' }, headers: ['前置条件', '操作步骤', '预期结果'], row: [context, context, expected],
      reports: directory, runPrefix: 'LOCAL', useRead: (_, fn) => fn({ base_url: base_url + '/sign-in', account: 'local', password: 'fixture-only' }),
      checkOutput: value => value, repositories: [] };
    const preparation = await adapter.prepare(scope);
    const result = await adapter.execute({ ...scope, preparation });
    saved.push({ operation, input, result, evidence: await Promise.all(result.evidence.map(item => readFile(path.join(directory, item.path), 'utf8').then(JSON.parse))) });
    return result;
  }
  const context = '查询经销商 A，期间 2026，业务键 K1';
  const values = { account: 'A', period: '2026', key: 'K1' };
  const runBalance = (input, expected = '1. 预算余额100元', rule = check(['balance'], 100)) => run('balance', input, [rule], expected, context);
  const wrong = await runBalance({ ...values, account: 'B' });
  assert.equal(wrong.status, baseline ? '通过' : '阻断');
  const browser = () => run('page', { region: 'local' }, [check(['values', 'result'], '读取成功')], '1. 读取结果为读取成功');
  const rendered = await browser();
  assert.equal(rendered.status, baseline ? '失败' : '通过');
  assert.equal(requested.filter(item => item.path === '/query').length, baseline ? 0 : 1);
  const natural = bindCaseAssertions('1. 页面显示预算余额为100元', [{ operation: 'balance', checks: [check(['balance'], 100)] }], operations);
  assert.equal(natural.missing.length, baseline ? 1 : 0);
  saved.push({ natural, original: '1. 页面显示预算余额为100元' });
  if (baseline) for (const expected of ['1. 预算余额100元且不含无效占用', '1. 预算余额＝总额－有效占用', '1. 预算余额大于99元']) {
    saved.push({ original: expected, compiled: bindCaseAssertions(expected, [{ operation: 'balance', checks: [check(['balance'], 100)] }], operations) });
  }
  if (baseline) return;
  assert.equal(requested.some(item => item.data.account === 'B'), false);
  for (const changed of [{ period: '2025' }, { key: 'K2' }]) assert.equal((await runBalance({ ...values, ...changed })).status, '阻断');
  assert.equal((await runBalance(values)).status, '失败');
  amount = 100;
  assert.equal((await runBalance(values)).status, '通过');
  replyAccount = 'B';
  assert.equal((await runBalance(values)).status, '阻断');
  replyAccount = undefined;
  Object.assign(operations.balance.outputs, { total: ['total'], occupied: ['occupied'], invalid: ['invalid'] });
  operations.balance.observations.push(
    { id: 'total', label: '总额', type: 'number', unit: '元', field: ['total'] },
    { id: 'occupied', label: '有效占用', type: 'number', unit: '元', field: ['occupied'] },
    { id: 'invalid', label: '无效占用', type: 'boolean', field: ['invalid'] });
  const formula = '1. 页面显示预算余额＝总额－有效占用，且不含无效占用';
  const formulaChecks = [{ field: ['balance'], assertion: 1 }, check(['invalid'], false, 'equals', 2)];
  const evaluate = (expected, checks) => run('balance', values, checks, expected, context);
  assert.equal((await evaluate(formula, formulaChecks.slice(0, 1))).status, '未执行');
  const relation = await evaluate(formula, formulaChecks);
  assert.equal(relation.status, '通过');
  assert.deepEqual(relation.assertions[0].inputs.map(item => item.value), [160, 60]);
  occupied = 59;
  assert.equal((await evaluate(formula, formulaChecks)).status, '失败');
  occupied = undefined;
  assert.equal((await evaluate(formula, formulaChecks)).status, '阻断');
  for (const [expected, operator, limit, status] of [
    ['在页面上可见预算余额等于100元', 'equals', 100, '通过'],
    ['页面显示预算余额高于99元', 'gt', 99, '通过'],
    ['预算余额大于100元', 'gt', 100, '失败'],
    ['预算余额小于101元', 'lt', 101, '通过'],
    ['预算余额低于100元', 'lt', 100, '失败'],
  ]) assert.equal((await runBalance(values, '1. ' + expected, check(['balance'], limit, operator))).status, status);
  assert.equal((await evaluate('1. 预算余额为100元，同时旧响应不覆盖', [check(['balance'], 100)])).status, '未执行');
  operations.lookup = { kind: 'http', resource: 'platform', path: '/lookup', inputs: ['account'],
    outputs: { account: ['account'], id: ['id'], alternate: ['alternate'] }, subject: { account: subject.account } };
  operations.byId = { ...operations.balance, path: '/by-id', inputs: ['id', 'period', 'key'],
    subject: { ...subject, account: { input: 'id', verify: 'query', derived: true, derivedFrom: { operation: 'lookup', field: ['id'] } } } };
  const lookup = { operation: 'lookup', input: { account: 'A' }, checks: [] };
  const derived = field => ({ operation: 'byId', input: { id: { from: 0, field: [field] }, period: '2026', key: 'K1' }, checks: [check(['balance'], 100)] });
  const follow = field => run('byId', {}, [], '1. 预算余额为100元', context, [lookup, derived(field)]);
  assert.equal((await follow('alternate')).status, '阻断');
  assert.equal((await follow('id')).status, '通过');
  assert.deepEqual(requested.filter(item => item.path === '/by-id').map(item => item.data.id), ['id-A']);
  pageMode = 'blocked';
  const blocked = await browser();
  assert.equal(blocked.status, '阻断');
  assert.equal(blocked.issue, undefined);
  assert.equal(requested.some(item => item.path === '/write'), false);
  pageMode = 'wrong-params';
  assert.equal((await browser()).status, '阻断');
  assert.equal(requested.filter(item => item.path === '/query').length, 1);
  pageMode = 'network-error';
  assert.equal((await browser()).status, '阻断');
  assert.equal(saved.at(-1).evidence.at(-1).network.at(-1).state, 'network_error');
  pageMode = 'bad-response';
  assert.equal((await browser()).status, '失败');
  pageMode = 'normal';
  const state = await run('page', { region: 'local' }, [
    check(['values', 'before'], '待审'), check(['values', 'state'], '已审', 'equals', 2),
  ], '1. 页面状态从待审转为已审');
  assert.equal(state.status, '通过');
  assert.deepEqual(state.assertions.map(item => item.observed), ['待审', '已审']);
  operations.securePage = { ...operations.page, authenticated: true };
  const signed = await run('securePage', { region: 'local' }, [check(['values', 'result'], '读取成功')], '1. 读取结果为读取成功');
  assert.equal(signed.status, '通过');
  assert.equal(requested.filter(item => item.path === '/auth').length, 1);
});

const skillsRoot = process.env.AGENTOS_REQUIREMENT_SKILLS_ROOT;
test('generated natural-language cases keep their contract and evidence through the isolation workbook',
  { skip: !skillsRoot && 'Set AGENTOS_REQUIREMENT_SKILLS_ROOT' }, async t => {
  const evidenceRoot = process.env.AGENTOS_BINDING_WORKBOOK;
  const root = await realpath(await mkdtemp(path.join(evidenceRoot ?? tmpdir(), 'natural-workbook-')));
  t.diagnostic(root);
  if (!evidenceRoot) t.after(() => rm(root, { recursive: true, force: true }));
  const realModel = process.env.AGENTOS_BINDING_REAL_MODEL === '1';
  const source = { id: 'FictionalContract', title: '隔离平台预算验收', url: 'https://fixture.invalid/docx/FictionalContract',
    revision: 1, embedded: [], xml: '<h1 id="module">预算展示</h1><p id="contract">虚构验收仅一个场景。组织代码为 A。'
      + '在组织 A 的预算页读取本次余额、总额、有效占用及无效占用是否计入。验收口径原文如下，逐项保留，不额外推导或引入其他条件。'
      + '（一）在页面上可以看到预算余额等于总额减有效占用。（二）不含无效占用。</p>' };
  const headers = ['系统', '页面', '用例类型', '前置条件', '模块', '测试场景', '操作步骤', '预期结果',
    '测试数据', '测试结果', '备注说明', '测试截图', '用户问题', '对接BP', '测试用户', '测试截至日期'];
  const resources = [];
  const server = createServer((request, response) => {
    const url = new URL(request.url, 'http://localhost');
    resources.push({ method: request.method, path: url.pathname, parameters: Object.fromEntries(url.searchParams) });
    response.end(JSON.stringify({ org: url.searchParams.get('org'), balance: 100, total: 160, used: 60, invalid: false }));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => {
    await new Promise(resolve => server.close(resolve));
    if (evidenceRoot) await writeJson(path.join(root, 'requests.json'), { resources, closed: !server.listening, realModel });
  });
  const catalog = { readBudget: { kind: 'http', resource: 'platform', path: '/budget', inputs: ['org'],
    outputs: { org: ['org'], balance: ['balance'], total: ['total'], used: ['used'], invalid: ['invalid'] },
    subject: { organization: { input: 'org', output: ['org'] } }, observations: [
      balance, { id: 'total', label: '总额', aliases: ['预算总额'], type: 'number', unit: '元', field: ['total'] },
      { id: 'used', label: '有效占用', aliases: ['有效占用金额'], type: 'number', unit: '元', field: ['used'] },
      { id: 'invalid', label: '无效占用', type: 'boolean', field: ['invalid'] },
    ] } };
  const execution = { operations: catalog, dimensions: { organization: { labels: ['组织代码', '组织'], pattern: '[A-Z]', required: true } } };
  const localSkill = async (name, refs) => {
    const folder = path.join(skillsRoot, name);
    const hash = createHash('sha256');
    for (const file of ['SKILL.md', ...refs]) hash.update(file).update('\0').update(await readFile(path.join(folder, file))).update('\0');
    return loadSkill({ path: folder, sha256: hash.digest('hex') }, name, refs);
  };
  const generator = await localSkill('lark-testcase-by-prd-order-generator', generatorReferences);
  const regression = await localSkill('run-full-requirement-regression', regressionReferences);
  const validationCli = path.join(root, 'offline-only.cmd');
  await writeFile(validationCli, '@exit /b 94\r\n');
  const settings = { powerShell: 'pwsh', validationCli, execution,
    templateUrl: 'https://fixture.invalid/sheets/Template', projectFolderUrl: 'https://fixture.invalid/drive/folder/Local' };
  const generated = await generateValidatedCases({ source, template: { headers, tabs: ['测试场景'], samples: [] },
    skill: generator, cwd: root, expectedProject: '隔离平台', otherProjects: [] },
  settings, path.join(root, 'cases.json'), realModel ? {} : {
    generate: async () => ({ projectMatch: 'match',
      requirements: [{ id: 'R1', anchor: 'contract', rule: '组织 A 的余额等于总额减有效占用且不含无效占用。' }],
      caseRequirements: [['R1']], manifest: { headers, module_order: ['预算展示'], required_texts: [],
        rows: [['隔离平台', '预算页面', 'S1--主流程', '1. 组织代码为 A。', '预算展示', '查看余额及占用',
          '1. 打开组织 A 的预算页面。', '1. 页面显示预算余额等于总额减有效占用，且不含无效占用。', ...Array(8).fill('')]] } }),
  });
  const { draft, index } = generated;
  await writeJson(path.join(root, 'case-index.json'), index);
  assert.ok(index.some(item => item.requirementAnchors.includes('contract')));
  const reportDir = await realpath(await mkdir(path.join(root, 'report'), { recursive: true }));
  const journal = { environment: 'SIT', startedAt: new Date().toISOString(), requirements: draft.requirements,
    publication: { title: '模拟发布用例', url: 'https://fixture.invalid/sheets/Published', version: digest(draft.manifest) },
    results: {}, preparations: {}, mutations: [], repositories: [] };
  const base_url = 'http://127.0.0.1:' + server.address().port;
  const runScope = { source, requirements: draft.requirements, headers, reports: reportDir, runPrefix: 'AOS_FICTIONAL',
    useRead: (_, action) => action({ base_url }), checkOutput: value => value, repositories: [] };
  const adapter = createRequirementAdapter(execution, { async plan(prompt) {
    const { compiled, subject } = JSON.parse(prompt.split('\n\n').at(-1));
    return { steps: [{ operation: 'readBudget', input: { org: subject.values.organization?.value ?? 'unknown' },
      checks: compiled.clauses.flatMap(({ assertion, predicate }) => {
        const match = catalog.readBudget.observations.find(item => item.id === predicate?.observation);
        return match ? [{ assertion, field: match.field }] : [];
      }) }], missing: [] };
  } });
  for (const item of index) {
    const scope = { ...runScope, item, row: draft.manifest.rows[item.row - 2] };
    const preparation = await adapter.prepare(scope);
    journal.preparations[item.caseId] = preparation;
    journal.results[item.caseId] = { ...await adapter.execute({ ...scope, preparation }), at: new Date().toISOString() };
  }
  journal.cleanup = await adapter.cleanup({ ...runScope, mutations: [] });
  const { artifact, summary } = await buildRequirementReport({
    job: { id: 'JOB-isolated-natural', agentProfile: 'local-only' }, journal, index, manifest: draft.manifest, regression, source,
    workDir: root, reportDir, dataDir: root, save: () => writeJson(path.join(root, 'journal.json'), journal),
    visualModel: async (_, { images }) => ({ sheets: images.map(image => ({ filename: path.basename(image), usable: true, issues: [] })) }),
  });
  await writeJson(path.join(root, 'result.json'), { realModel, artifact, summary, cases: index.length });
  assert.ok(Object.values(journal.results).some(result => result.status === '通过'
    && result.assertions.some(item => item.inputs?.length === 2)
    && result.assertions.some(item => item.expected === false && item.observed === false)), JSON.stringify(journal.results));
  assert.equal(journal.visualReview.count, 15);
});
