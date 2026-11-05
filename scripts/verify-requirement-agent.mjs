// Explicit local-only acceptance: real planning/review models, real Chromium/HTTP,
// normal requirement Runner; Feishu transport and supplied source material are fixtures.
import { createServer } from 'node:http';
import { mkdir, readFile, writeFile, realpath, lstat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { runRequirementTest } from '../src/runner/requirement-test.js';
import { digest } from '../src/runner/requirement-feishu.js';
import { generatorReferences, regressionReferences, command, writeJson } from '../src/runner/requirement-files.js';

const base = fileURLToPath(new URL('../', import.meta.url));
const root = path.resolve(process.argv[2] ?? path.join(base, '.local/requirement-agent-acceptance'));
await mkdir(root, { recursive: true });
const repo = path.join(root, 'source'); await mkdir(repo, { recursive: true });
const objects = new Map(), requests = [];
const preferences = { key: 'fixture-operator', language: 'en' };
const mode = process.env.AGENTOS_ACCEPTANCE_MODE ?? 'positive';
const navigation = ['navigation-state', 'authenticated-navigation'].includes(mode);
const cleanupFailures = new Set(), receiptFailures = new Set();
const handler = async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  let text = ''; for await (const chunk of req) text += chunk;
  const input = text ? JSON.parse(text) : {};
  const key = url.searchParams.get('key') ?? input.key;
  requests.push({ method: req.method, path: url.pathname, key, input, at: new Date().toISOString() });
  res.setHeader('content-type', 'application/json');
  if (url.pathname === '/login' && req.method === 'POST') {
    res.setHeader('set-cookie', 'session=fixture-token; HttpOnly; SameSite=Strict');
    return res.end(JSON.stringify({ userId: preferences.key, token: 'fixture-token' }));
  }
  if (url.pathname === '/' && mode === 'authenticated-navigation') {
    res.setHeader('content-type', 'text/html');
    return res.end('<input id="account"><input id="password" type="password"><button id="login" onclick="fetch(\'/login\',{method:\'POST\',body:JSON.stringify({account:document.querySelector(\'#account\').value,password:document.querySelector(\'#password\').value})})">login</button>');
  }
  if (url.pathname === '/preferences' && mode === 'authenticated-navigation') {
    // The implicit target is the authenticated user, not a user-supplied key.
    const authenticatedUserId = req.headers.token === 'fixture-token' || req.headers.cookie === 'session=fixture-token' ? 'fixture-operator' : null;
    if (authenticatedUserId !== preferences.key) { res.statusCode = 401; return res.end('{"error":"unauthenticated"}'); }
  }
  if (url.pathname === '/preferences' && req.method === 'GET') return res.end(JSON.stringify(preferences));
  if (url.pathname === '/preferences' && req.method === 'POST') {
    preferences.language = input.language ?? 'zh'; return res.end(JSON.stringify(preferences));
  }
  if (url.pathname === '/objects' && req.method === 'POST') {
    if (objects.has(key)) { res.statusCode = 409; return res.end(JSON.stringify({ error: 'duplicate' })); }
    objects.set(key, { key, amount: input.amount, period: input.period,
      ...(['derived-api', 'misleading-api'].includes(mode) ? { appliedAmount: input.appliedAmount ?? 20 } : {}) });
    if (mode === 'lost-receipt' && !receiptFailures.has(key)) { receiptFailures.add(key); return res.destroy(); }
    return res.end(JSON.stringify({ created: true, key }));
  }
  if (url.pathname === '/objects' && req.method === 'DELETE') {
    if (mode === 'cleanup-retry' && objects.has(key) && !cleanupFailures.has(key)) { cleanupFailures.add(key); res.statusCode = 503; return res.end('{"error":"temporary cleanup failure"}'); }
    objects.delete(key); cleanupFailures.delete(key); receiptFailures.delete(key); return res.end('{"deleted":true}');
  }
  if (url.pathname === '/objects' && req.method === 'GET') {
    const object = objects.get(key);
    // These fixture-only modes exercise semantic binding. diagnosticAmount is
    // unrelated telemetry even when it happens to equal a requirement's value.
    // Accounting response contract for this isolated service: allocatedAmount
    // is the account's total allocation; appliedAmount is its effective used
    // allocation (no pending or cancelled applications exist in this fixture).
    // Available allocation is allocatedAmount minus appliedAmount. A returned
    // remainingAmount is the service's reported available allocation.
    const accounting = object && ['derived-api', 'misleading-api'].includes(mode)
      ? { allocatedAmount: object.amount, appliedAmount: object.appliedAmount, diagnosticAmount: 80,
        ...(mode === 'misleading-api' ? { remainingAmount: 0 } : {}) } : {};
    return res.end(JSON.stringify(object ? { exists: true, ...object, ...accounting } : { exists: false }));
  }
  if (url.pathname === '/page') {
    res.setHeader('content-type', 'text/html; charset=utf-8');
    return res.end(`<label>对象<input id="key" value="${String(key ?? '').replaceAll('&', '&amp;').replaceAll('"', '&quot;').replaceAll('<', '&lt;')}"></label><input id="amount" readonly value="-1"><div id="busy">加载中</div>
      <script>${navigation ? "fetch('/preferences',{method:'POST'}).then(r=>{if(!r.ok)throw Error('preference update failed');return r.json()}).then(()=>" : ''}fetch('/objects?key='+encodeURIComponent(document.querySelector('#key').value))${navigation ? ')' : ''}.then(r=>r.json()).then(d=>setTimeout(()=>{
      document.querySelector('#amount').value=${mode === 'wrong-page' ? '0' : 'd.amount'};
      document.querySelector('#busy').remove();},350));</script>`);
  }
  res.statusCode = 404; res.end('{"error":"not found"}');
};
const serviceDirectory = mode === 'ignored-sources' ? path.join(repo, 'business-service') : repo;
await mkdir(serviceDirectory, { recursive: true });
if (mode === 'ignored-sources') await writeFile(path.join(repo, '.gitignore'), 'business-service/\n');
await writeFile(path.join(serviceDirectory, 'service.mjs'), '// Isolated local service contract and actual handler. Business GET is read-only.\n'
  + 'const objects = new Map(), requests = [];\nconst preferences={key:"fixture-operator",language:"en"};\nconst mode = ' + JSON.stringify(mode) + '; const navigation=' + navigation + '; const cleanupFailures=new Set(), receiptFailures=new Set();\nconst handler = ' + handler.toString()
  + ';\n// The Runner resource catalog binds platform to createServer(handler), listening only on 127.0.0.1. requests is in-memory audit only.\n');
await writeFile(path.join(repo, 'AGENTS.md'), '# 本地隔离测试服务\n仅本机回环资源。搜索项目源码发现接口与实现。对象必须使用当前任务前缀，不改源码。\n');
try { await lstat(path.join(repo, '.git')); await command('git', ['-C', repo, 'rev-parse', 'HEAD']); }
catch { await command('git', ['init', '-b', 'main', repo]); await command('git', ['-C', repo, 'add', '.']);
  await command('git', ['-C', repo, '-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-m', 'Isolated runtime contract']); }
const server = createServer(handler); await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const url = 'http://127.0.0.1:' + server.address().port;
const iniPath = path.join(root, 'resources.ini');
await writeFile(iniPath, '[Demo.Uat.Platform]\nstatus=configured\nai_access=allowed\nai_operation_mode=full_crud\nenvironment=Uat\nresource_type=website\nbase_url=' + url + '\nusername=fixture\npassword=fixture-local-only\n');
const skillsRoot = process.env.AGENTOS_REQUIREMENT_SKILLS_ROOT;
if (!skillsRoot) throw new Error('Set AGENTOS_REQUIREMENT_SKILLS_ROOT');
async function skill(name, refs) {
  const folder = path.join(skillsRoot, name), hash = createHash('sha256');
  for (const file of ['SKILL.md', ...refs]) hash.update(file).update('\0').update(await readFile(path.join(folder, file))).update('\0');
  return { path: folder, sha256: hash.digest('hex') };
}
const headers = ['系统', '页面', '用例类型', '前置条件', '模块', '测试场景', '操作步骤', '预期结果', '测试数据', '测试结果', '备注说明', '测试截图', '用户问题', '对接BP', '测试用户', '测试截至日期'];
const expected = ['derived-api', 'misleading-api'].includes(mode)
  ? (mode === 'derived-api' ? '1. API返回已分配100元、已用20元，按已分配减已用核算剩余80元。'
    : '1. API返回的剩余金额为80元，来自已分配100元减已用20元；分配、已用和诊断金额不能替代剩余金额。')
    + '\n2. 页面账户编号与A一致，业务加载完成后页面金额为100元。'
  : mode === 'multi-object'
  ? '1. 账户A在2026-11的接口金额为100元，账户B在2026-12的接口金额为250元。\n2. 页面在A、B、A之间切换，每次完成加载后账户编号正确、金额分别为100元、250元、100元，两个账户保持独立。'
  : '1. 账户A的接口金额为100元。\n2. 页面账户编号与A一致，业务加载完成后页面金额为100元。';
const row = ['隔离系统', '/page', 'S1--主流程', '1. 在本机隔离环境创建本轮专属账户A，金额100元，期间2026-11；账户业务键必须使用本轮runPrefix。',
  '金额展示', '自主创建并核对接口和页面', '1. 读取源码并创建专属账户A。\n2. 从接口读取A。\n3. 打开A的页面并等待业务加载完成。\n4. 核对页面与接口金额和对象。', expected, ...Array(8).fill('')];
if (['derived-api', 'misleading-api'].includes(mode)) row[3] += '\n2. 专属账户已分配100元、已用20元；独立期望剩余80元。';
if (mode === 'multi-object') {
  row[3] += '\n2. 创建独立账户B，金额250元、期间2026-12，使用另一个本轮专属业务键。';
  row[6] += '\n5. 按A、B、A顺序切换页面，并回查两个对象没有互相覆盖。';
}
const sourceBase = { id: 'LocalRequirement', url: 'https://fixture.invalid/docx/LocalRequirement', revision: 1, title: '隔离测试智能体', embedded: [],
  xml: '<h1 id="module">金额展示</h1><p id="rules">' + expected + '测试结束删除专属账户并回查不存在。</p>' };
const copies = new Map(), folders = [];
const client = { verify: async () => {}, readRequirement: async () => ({ ...sourceBase, hash: digest(sourceBase) }),
  listFolder: async token => token === 'Root' ? folders : [...copies.values()],
  createFolder: async (_parent, name) => { folders.push({ token: 'Month', type: 'folder', name }); return 'Month'; },
  workbook: async token => ({ sheets: [{ sheet_id: 'cases', title: '测试场景', grid_properties: { row_count: copies.get(token)?.matrix.length ?? 1, column_count: 16 } }], revision: 1 }),
  readGrid: async token => copies.get(token)?.matrix ?? [headers],
  copyWorkbook: async (_template, _folder, name) => { const file = { token: 'Published', type: 'sheet', name, url: 'https://fixture.invalid/sheets/Published', matrix: [headers], revision: 1 }; copies.set(file.token, file); return file; },
  writeWorkbook: async (token, _sheet, values) => { copies.get(token).matrix = values; },
};
const validationCli = path.join(root, 'offline.cmd'); await writeFile(validationCli, '@exit /b 94\r\n');
const settings = { bot: { profile: 'local-qa' }, allowedChatIds: ['oc_local'], requesterOpenIds: ['ou_local'], document: { domain: 'fixture.invalid' },
  projectName: '隔离系统', templateUrl: 'https://fixture.invalid/sheets/Template', projectFolderUrl: 'https://fixture.invalid/drive/folder/Root',
  timeZone: 'Asia/Shanghai', reportDirectory: path.join(root, 'reports'), lockDirectory: path.join(root, 'locks'),
  validationCli, powerShell: process.env.AGENTOS_REQUIREMENT_POWERSHELL ?? 'pwsh',
  skills: { generator: await skill('lark-testcase-by-prd-order-generator', generatorReferences), regression: await skill('run-full-requirement-regression', regressionReferences) },
  environment: { name: 'UAT', platform: 'Demo', iniPath, lockKey: 'local', resources: { platform: { section: 'Demo.Uat.Platform', scope: 'full_crud', reversibleSharedWrites: navigation } } },
  execution: { mode: 'agent' } };
if (mode === 'authenticated-navigation') settings.execution.login = { resource: 'platform', path: '/login',
  tokenField: ['token'], header: 'token', identityFields: { userId: ['userId'] }, accountSelector: '#account', passwordSelector: '#password', submitSelector: '#login' };
const job = { id: 'JOB-isolated-agent-' + Date.now(), projectId: 'demo', agentProfile: 'local-qa', chatId: 'oc_local', senderId: 'ou_local',
  requirement: { url: sourceBase.url } };
const config = { projects: { demo: { displayName: '隔离系统', repoPath: repo, baseBranch: 'main', requirementTest: settings } }, dataDir: path.join(root, 'data') };
await writeJson(path.join(root, 'acceptance-input.json'), { job, mode, url });
try {
  const dependencies = { client,
    generate: async () => ({ projectMatch: 'match', requirements: [{ id: 'R1', anchor: 'rules', rule: ['derived-api', 'misleading-api'].includes(mode) ? expected : '接口与页面均显示100元并对应正确账户。' }],
      caseRequirements: [['R1']], manifest: { headers, module_order: ['金额展示'], required_texts: [], rows: [row] } }) };
  const emit = async event => console.log(JSON.stringify(event));
  if (mode === 'retry-native') {
    settings.execution = { operations: {} };
    const first = await runRequirementTest(job, config, emit, dependencies);
    await writeJson(path.join(root, 'first-attempt-result.json'), first);
    settings.execution = { mode: 'agent' };
    job.requirement.retryRequest = 'local-fixture-retry-command';
  }
  const result = await runRequirementTest(job, config, emit, dependencies);
  await writeJson(path.join(root, 'result.json'), { result, remaining: [...objects.values()], preferences, requests });
  console.log(JSON.stringify({ result, remaining: objects.size }));
  const wanted = ['wrong-page', 'misleading-api'].includes(mode) ? result.requirementSummary?.fail === 1 : result.requirementSummary?.pass === 1;
  if (result.outcome !== 'ready' || !wanted || objects.size || preferences.language !== 'en') process.exitCode = 1;
} finally { await new Promise(resolve => server.close(resolve)); }
