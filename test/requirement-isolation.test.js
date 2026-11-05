import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { chromium } from 'playwright';
import { JsonStore } from '../src/shared/store.js';
import { ReportDelivery } from '../src/control-plane/report-delivery.js';
import { handleRequirementMessage, validateRequirementRoutes } from '../src/control-plane/requirement-testing.js';
import { createRequirementAdapter } from '../src/runner/requirement-adapter.js';
import { digest, RequirementWait } from '../src/runner/requirement-feishu.js';
import { command, generatorReferences, readJson, regressionReferences, writeJson } from '../src/runner/requirement-files.js';
import { caseReleaseRequirement, matchesCaseRelease, verifyRequirementRelease } from '../src/runner/requirement-release.js';
import { versionNames } from '../src/runner/requirement-publication.js';
import { runRequirementTest } from '../src/runner/requirement-test.js';

const sha = value => createHash('sha256').update(value).digest('hex');
const check = (field, expected, assertion = 1) => ({ field, expected, assertion, operator: 'equals' });
const budget = { id: 'budget', label: '预算余额', type: 'number', unit: '元', unitField: ['currency'], field: ['balance'] };
const budgetOutputs = { balance: ['data', 'balance'], currency: ['data', 'currency'], unrelated: ['data', 'unrelated'] };

async function localServer(t, handler) {
  const server = createServer(handler);
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  return 'http://127.0.0.1:' + server.address().port;
}

test('business value, unit and evidence are required independently of the plan assertion number', async t => {
  const dir = await mkdtemp(path.join(tmpdir(), 'agentos-assertion-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  let response = { balance: 0, currency: '元', unrelated: 100 };
  let calls = 0;
  let httpStatus = 200;
  const url = await localServer(t, (req, res) => {
    calls++;
    res.statusCode = httpStatus;
    res.end(JSON.stringify({ data: response }));
  });
  const operations = { budget: { kind: 'http', resource: 'platform', path: '/balance', outputs: budgetOutputs, observations: [budget] } };
  const scope = { item: { caseId: 'CASE-budget' }, row: ['1. 预算余额100元'], headers: ['预期结果'], reports: dir,
    useRead: (_, run) => run({ base_url: url }), checkOutput: value => value, repositories: [] };
  const execute = async (checks, overrides = {}) => {
    const adapter = createRequirementAdapter({ operations }, { plan: async () => ({
      missing: [], steps: [{ operation: 'budget', input: {}, checks }],
    }) });
    const input = { ...scope, ...overrides };
    return adapter.execute({ ...input, preparation: await adapter.prepare(input) });
  };
  for (const bad of [check(['status'], 200), check(['unrelated'], 100), check(['balance'], 0)]) {
    const result = await execute([bad]);
    assert.equal(result.status, '未执行');
    assert.equal(result.issue, undefined);
  }
  assert.equal(calls, 0);
  const failed = await execute([check(['balance'], 100)]);
  assert.equal(failed.status, '失败');
  assert.equal(failed.assertions[0].observed, 0);
  assert.equal((await readJson(path.join(dir, failed.assertions[0].evidence.path))).checks[0].observed, 0);
  response = { balance: 100 };
  assert.equal((await execute([check(['balance'], 100)])).status, '阻断');
  response = { currency: '元' };
  const missing = await execute([check(['balance'], 100)]);
  assert.equal(missing.status, '阻断');
  assert.equal(missing.issue, undefined);
  response = { balance: 100, currency: '分' };
  assert.equal((await execute([check(['balance'], 100)])).status, '失败');
  response.currency = '元';
  assert.equal((await execute([check(['balance'], 100)])).status, '通过');
  httpStatus = 503;
  assert.equal((await execute([check(['balance'], 100)])).status, '阻断');
  httpStatus = 200;
  assert.equal((await execute([check(['balance'], 100)], { row: ['1. 预算余额100元\n2. 记录状态为已登记'] })).status, '未执行');
  await assert.rejects(execute([check(['balance'], 100)], { reports: path.join(dir, 'missing') }), { code: 'ENOENT' });
});

test('release proof requires all pinned components, exact requirement binding and validity', async t => {
  const dir = await mkdtemp(path.join(tmpdir(), 'agentos-release-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'release.json');
  const commit = 'a'.repeat(40);
  const components = Object.fromEntries(['web', 'api'].map(name => [name, { repository: 'repo', resource: 'platform', path: '/' + name }]));
  const config = { releaseManifest: { path: file, components } };
  const scope = { projectId: 'alpha', environment: 'SIT', source: { id: 'Doc', revision: 4, hash: sha('requirements') },
    repositories: [{ name: 'repo', commit }] };
  const release = { revision: 4, sourceHash: scope.source.hash, validUntil: '2099-01-01T00:00:00Z',
    components: Object.fromEntries(Object.keys(components).map(name => [name, { commit, sha256: sha(name) }])) };
  const observe = (change = {}) => verifyRequirementRelease(config, scope, async item => Buffer.from(change[item.name] ?? item.name));
  const save = async (fields, projectId = 'alpha') => writeJson(file, { version: 1, projectId, environment: 'SIT', releases: { Doc: { ...release, ...fields } } });
  assert.equal((await observe()).verified, false);
  for (const fields of [{ revision: 3 }, { sourceHash: sha('old') }, { validUntil: '2000-01-01T00:00:00Z' },
    { components: { web: release.components.web } },
    { components: { ...release.components, api: { ...release.components.api, commit: 'b'.repeat(40) } } }]) {
    await save(fields);
    assert.equal((await observe()).verified, false);
  }
  await save({}, 'beta');
  assert.equal((await observe()).verified, false);
  await save({});
  const valid = await observe();
  assert.equal(valid.verified, true);
  const partial = await observe({ api: 'new deployment' });
  assert.equal(partial.verified, false);
  const required = (name, version) => caseReleaseRequirement({ caseId: 'CASE-pinned' },
    ['发布版本前置：' + name + ' sha256=' + sha(version)], ['前置条件']);
  assert.equal(matchesCaseRelease(required('web', 'web'), partial), true);
  assert.equal(matchesCaseRelease(required('web', 'different'), partial), false);
  assert.equal(matchesCaseRelease(required('api', 'api'), partial), false);
  await save({ validUntil: '2098-01-01T00:00:00Z' });
  assert.equal((await observe()).fingerprint, valid.fingerprint);
});

const headers = ['系统', '页面', '用例类型', '前置条件', '模块', '测试场景', '操作步骤', '预期结果', '测试数据', '测试结果',
  '备注说明', '测试截图', '用户问题', '对接BP', '测试用户', '测试截至日期'];
const tenant = 'fixture.invalid';
const doc = 'https://' + tenant + '/docx/LocalDoc';
const sampleRow = (name, expected) => ['隔离平台', '预算台账', 'S1--主流程', '1. 使用隔离候选对象，初始金额已设定。',
  '预算', name, '1. 打开隔离预算台账并读取金额。', expected, ...Array(8).fill('')];

function mockPublisher() {
  const copies = new Map();
  const grid = size => ({ sheet_id: 'cases', title: '测试场景', grid_properties: { row_count: size, column_count: 16 } });
  return { copies, client: {
    verify: async () => {},
    listFolder: async token => token === 'Root' ? [{ type: 'folder', name: '2026年11月版本', token: 'Month' }] : [...copies.values()],
    createFolder: async () => 'Month',
    workbook: async token => ({ sheets: [grid(copies.get(token)?.matrix.length ?? 1)], revision: copies.get(token)?.revision ?? 1 }),
    readGrid: async token => structuredClone(copies.get(token)?.matrix ?? [headers]),
    async copyWorkbook(template, folder, name) {
      const token = 'Copy' + (copies.size + 1);
      const file = { token, name, type: 'sheet', url: 'https://' + tenant + '/sheets/' + token, matrix: [headers], revision: 1 };
      copies.set(token, file);
      return file;
    },
    async writeWorkbook(token, sheet, values) {
      const file = copies.get(token);
      file.matrix = structuredClone(values);
      file.revision++;
    },
  } };
}

async function skillFingerprint(root, name, references) {
  const folder = path.join(root, name);
  const hash = createHash('sha256');
  for (const file of ['SKILL.md', ...references]) hash.update(file).update('\0').update(await readFile(path.join(folder, file))).update('\0');
  return { path: folder, sha256: hash.digest('hex') };
}

const skillsRoot = process.env.AGENTOS_REQUIREMENT_SKILLS_ROOT;
test('an original Feishu job resumes past its legacy release wait and records HTTP 403 without authorizing an ambiguous write',
  { skip: !skillsRoot && 'Set AGENTOS_REQUIREMENT_SKILLS_ROOT to the installed QA Skills' }, async t => {
  const root = await realpath(await mkdtemp(path.join(tmpdir(), 'agentos-release-resume-')));
  t.after(() => rm(root, { recursive: true, force: true }));
  const dataDir = path.join(root, 'data');
  const repo = path.join(root, 'repo');
  await mkdir(dataDir);
  await command('git', ['init', '-b', 'main', repo]);
  await command('git', ['-C', repo, '-c', 'user.name=Local Fixture', '-c', 'user.email=fixture@example.invalid',
    'commit', '--allow-empty', '-m', 'Local fixture']);
  const iniPath = path.join(root, 'uat.ini');
  const fakeCli = path.join(root, 'no-cli.cmd');
  await writeFile(fakeCli, '@exit /b 94\r\n');
  const requests = [];
  const url = await localServer(t, async (req, res) => {
    const request = new URL(req.url, 'http://localhost');
    requests.push(req.method + ' ' + request.pathname);
    res.setHeader('Content-Type', 'application/json');
    if (request.pathname === '/releases') {
      res.writeHead(403).end('{"message":"denied"}');
    } else if (request.pathname === '/runtime-version') {
      res.end('runtime-bundle');
    } else if (request.pathname === '/refresh-fixture') {
      await writeFile(iniPath, resources('unknown'));
      res.end('{}');
    } else if (request.pathname === '/fixture' && req.method === 'GET') {
      res.end(JSON.stringify({ exists: false, key: request.searchParams.get('code') }));
    } else {
      res.end('{"data":{"balance":100,"currency":"元"}}');
    }
  });
  const resources = tier => ['[Sample.Uat.Platform]\nstatus=configured\nai_access=allowed\nai_operation_mode=read_only\nenvironment=Uat',
    '[Sample.Uat.Fixture]\nstatus=configured\nai_access=allowed\nai_operation_mode=full_crud\nenvironment=' + tier]
    .map(section => section + '\nbase_url=' + url + '\n').join('\n');
  await writeFile(iniPath, resources('Uat'));
  const readBudget = { resource: 'platform', kind: 'http', path: '/budget', outputs: budgetOutputs, observations: [budget] };
  const settings = {
    bot: { profile: 'local-qa', appId: 'cli_local', openId: 'ou_bot' }, requesterOpenIds: ['ou_requester'], allowedChatIds: ['oc_local'],
    document: { domain: tenant, profile: 'local-docs', appId: 'cli_docs', openId: 'ou_document' },
    templateUrl: 'https://' + tenant + '/sheets/Template', projectFolderUrl: 'https://' + tenant + '/drive/folder/Root',
    lockDirectory: path.join(root, 'locks'), reportDirectory: path.join(root, 'reports'), timeZone: 'Asia/Shanghai',
    powerShell: process.env.AGENTOS_REQUIREMENT_POWERSHELL ?? 'pwsh', validationCli: fakeCli,
    skills: { generator: await skillFingerprint(skillsRoot, 'lark-testcase-by-prd-order-generator', generatorReferences),
      regression: await skillFingerprint(skillsRoot, 'run-full-requirement-regression', regressionReferences) },
    environment: { name: 'UAT', platform: 'Sample', lockKey: 'test', iniPath, resources: {
      platform: { section: 'Sample.Uat.Platform', scope: 'read' }, fixture: { section: 'Sample.Uat.Fixture', scope: 'full_crud' },
    } },
    execution: {
      releaseManifest: { resource: 'platform', path: '/releases', components: {
        web: { resource: 'platform', path: '/runtime-version', repository: 'repo' },
      } },
      operations: { budget: readBudget, pinned: { ...readBudget, path: '/pinned-budget' },
        refresh: { resource: 'platform', kind: 'http', path: '/refresh-fixture', outputs: {} },
        fixture: { resource: 'fixture', kind: 'fixture', key: 'code',
          lookup: { kind: 'http', path: '/fixture', outputs: { exists: ['exists'], key: ['key'] } },
          create: { kind: 'http', method: 'POST', path: '/fixture' }, remove: { kind: 'http', method: 'DELETE', path: '/fixture' } } },
    },
  };
  const projects = { projects: { alpha: { displayName: '隔离项目', repoPath: repo, baseBranch: 'main', requirementTest: settings } },
    chatProjectMap: { oc_local: 'alpha' }, topicChatIds: ['oc_local'] };
  const store = new JsonStore(path.join(dataDir, 'agentos.json'));
  const replies = [];
  const config = { projects: projects.projects, dataDir };
  const context = { config, store, requirementRoutes: validateRequirementRoutes(projects, { agents: { qa: settings.bot } }),
    feishu: { reply: async (_message, body) => replies.push(body) } };
  const message = (id, content) => handleRequirementMessage(context, {
    agent_profile: settings.bot.profile, receiving_app_id: settings.bot.appId, receiving_bot_id: settings.bot.openId,
    chat_id: 'oc_local', chat_type: 'group', sender_id: 'ou_requester', message_id: 'om_' + id, thread_id: 'omt_local',
    content, mentions: [{ id: { open_id: settings.bot.openId } }],
  });
  const { jobId } = await message('start', doc);
  const workDir = path.join(dataDir, 'requirement-tests', jobId);
  const { copies, client } = mockPublisher();
  client.listFolder = async token => token === 'Root' ? [{ type: 'folder', token: 'Month',
    name: versionNames('发布取证', new Date(), settings.timeZone).folderName }] : [...copies.values()];
  const source = { id: 'LocalDoc', revision: 4, title: '发布取证', url: doc, xml: '<h1 id="A1">预算</h1>', embedded: [] };
  client.readRequirement = async () => ({ ...source, hash: digest(source) });
  const rows = ['环境变化时拒绝写入', '指定版本场景', '普通预算读取'].map(name => sampleRow(name, '1. 预算余额100元'));
  rows[1][headers.indexOf('前置条件')] = '1. 发布版本前置：web imageTag=uat-123';
  let generationCount = 0;
  const dependencies = { client, async generate() {
    generationCount++;
    return { projectMatch: 'match', requirements: [{ id: 'R1', anchor: 'A1', rule: '预算余额可以核对。' }],
      caseRequirements: rows.map(() => ['R1']), manifest: { module_order: ['预算'], headers, required_texts: [], rows } };
  }, async plan(prompt) {
    const read = { operation: 'budget', input: {}, checks: [check(['balance'], 100)] };
    if (prompt.includes('环境变化时拒绝写入')) return { missing: [], steps: [
      { operation: 'refresh', input: {}, checks: [] }, { operation: 'fixture', input: {}, checks: [] }, read,
    ] };
    if (prompt.includes('指定版本场景')) return { missing: [], steps: [{ ...read, operation: 'pinned' }] };
    return { missing: [], steps: [read] };
  }, async visualModel(_prompt, { images }) {
    return { sheets: images.map(file => ({ filename: path.basename(file), usable: true, issues: [] })) };
  } };
  const run = async ({ legacy = false } = {}) => {
    const job = await store.leaseNext('release-runner', ['requirement_test']);
    assert.equal(job.id, jobId);
    const lease = { runnerId: 'release-runner', leaseId: job.lease.id };
    const result = await runRequirementTest(job, config, async event => {
      await store.appendEvent(jobId, { ...event, ...lease });
      if (legacy && event.activity?.current === '测试环境执行与恢复') {
        throw new RequirementWait('deployment_baseline', '历史任务等待发布指纹。');
      }
    }, dependencies);
    await store.appendEvent(jobId, { ...lease, type: 'completed', result });
    return result;
  };
  assert.equal((await run({ legacy: true })).requirementWait, 'deployment_baseline');
  assert.equal((await store.getJob(jobId)).status, 'awaiting_clarification');
  const journalPath = path.join(workDir, 'journal.json');
  const old = await readJson(journalPath);
  assert.equal(old.waitCode, 'deployment_baseline');
  assert.equal(old.publication.verified, true);
  const cases = await readFile(path.join(workDir, 'cases.json'));
  const index = await readFile(path.join(workDir, 'case-index.json'));
  await message('status', '当前阻塞');
  assert.match(replies.at(-1), /继续测试.*发布证据缺口/);
  assert.equal((await message('continue', '继续测试')).jobId, jobId);
  const completed = await run();
  assert.equal(completed.outcome, 'ready', completed.finalMessage);
  assert.equal(completed.requirementSummary.pass, 1);
  assert.equal(completed.requirementSummary.blocked, 2);
  const current = await readJson(journalPath);
  assert.deepEqual(current.publication, old.publication);
  assert.deepEqual(await readFile(path.join(workDir, 'cases.json')), cases);
  assert.deepEqual(await readFile(path.join(workDir, 'case-index.json')), index);
  assert.equal(generationCount, 1);
  assert.equal(copies.size, 1);
  assert.equal(current.mutations.length, 0);
  assert.equal(current.cleanup.verified, true);
  assert.equal(current.deploymentLastCheck.sourceStatus, 403);
  assert.equal(current.deploymentLastCheck.proof[0].observed, sha('runtime-bundle'));
  assert.deepEqual(requests, ['GET /releases', 'GET /runtime-version', 'GET /refresh-fixture', 'GET /fixture',
    'GET /releases', 'GET /runtime-version', 'GET /budget']);
  const report = await readJson(path.join(workDir, 'normalized-report.json'));
  assert.ok(report.meta.method_notes.some(note => /HTTP 403.*缺少构建号.*缺少镜像标识/.test(note)));
  assert.ok(report.evidence_index.some(entry => entry.type === '发布版本核验'));
  assert.deepEqual(report.blockers.map(item => item.dependency), ['已授权的非生产资源', '指定发布版本前置']);
});

test('isolated requirement revision runs real Chromium, HTTP, recovery, workbook and original-topic delivery',
  { skip: !skillsRoot && 'Set AGENTOS_REQUIREMENT_SKILLS_ROOT to the installed QA Skills' }, async t => {
  const parent = process.env.AGENTOS_REQUIREMENT_EVIDENCE_DIR ?? tmpdir();
  await mkdir(parent, { recursive: true });
  const root = await realpath(await mkdtemp(path.join(parent, 'agentos-isolated-')));
  t.diagnostic('Isolation evidence: ' + root);
  if (!process.env.AGENTOS_REQUIREMENT_EVIDENCE_DIR) t.after(() => rm(root, { recursive: true, force: true }));
  const dataDir = path.join(root, 'data');
  const reportDirectory = path.join(root, 'reports');
  await mkdir(dataDir);
  const repo = path.join(root, 'sample-repo');
  await mkdir(repo);
  await command('git', ['init', '-b', 'main', repo]);
  await command('git', ['-C', repo, '-c', 'user.name=Local Fixture', '-c', 'user.email=fixture@example.invalid',
    'commit', '--allow-empty', '-m', 'Local fixture']);
  const fakeCli = path.join(root, 'no-cli.cmd');
  await writeFile(fakeCli, '@exit /b 94\r\n');
  const events = [];
  const owned = new Map();
  let createCount = 0;
  let deleteCount = 0;
  const url = await localServer(t, async (req, res) => {
    const parsed = new URL(req.url, 'http://localhost');
    const code = parsed.searchParams.get('code');
    const send = (body, status = 200) => { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(body)); };
    events.push([req.method, parsed.pathname]);
    if (parsed.pathname === '/candidate') return send({ data: { id: 'LOCAL-42', ready: true } });
    if (parsed.pathname === '/zero') return send({ data: { balance: 0, currency: '元' } });
    if (parsed.pathname === '/fixture' && req.method === 'POST') {
      let body = '';
      for await (const chunk of req) body += chunk;
      const item = JSON.parse(body);
      createCount++;
      if (!item.code.startsWith('AOS_') || item.candidate !== 'LOCAL-42' || item.mode !== 'approved' || owned.has(item.code)) return send({}, 409);
      owned.set(item.code, { ...item, balance: 100, currency: '元' });
      return send({}, 503); // Effect happened but the submitter received no valid acknowledgement.
    }
    if (parsed.pathname === '/fixture' && req.method === 'DELETE') {
      if (++deleteCount === 1) return send({}, 503);
      owned.delete(code);
      return send({});
    }
    if (parsed.pathname === '/fixture') return send({ exists: owned.has(code), key: code, data: owned.get(code) });
    if (parsed.pathname === '/form') {
      res.setHeader('Content-Type', 'text/html; charset=utf-8');
      return res.end(`<!doctype html><button id="open">Open form</button><form hidden id="form">
        <input name="code"><input name="candidate"><select name="mode"><option>default</option><option>approved</option></select>
        <button id="submit">Submit</button></form><script>
        document.querySelector('#open').onclick=()=>{document.querySelector('#form').hidden=false};
        document.querySelector('#form').onsubmit=async e=>{e.preventDefault();await fetch('/fixture',{method:'POST',headers:{'Content-Type':'application/json'},
          body:JSON.stringify(Object.fromEntries(new FormData(e.target)))});};</script>`);
    }
    if (parsed.pathname === '/details') {
      res.setHeader('Content-Type', 'text/html; charset=utf-8');
      return res.end('<!doctype html><p id="status">' + (owned.has(code) ? '已登记' : '未登记') + '</p>');
    }
    res.writeHead(404).end();
  });
  const iniPath = path.join(root, 'test.ini');
  await writeFile(iniPath, '[Sample.Sit.Platform]\nstatus=configured\nai_access=allowed\nai_operation_mode=full_crud\nenvironment=Sit\nbase_url=' + url + '\n');
  const lookup = { kind: 'http', path: '/fixture', outputs: { ...budgetOutputs, key: ['key'], exists: ['exists'] } };
  const settings = {
    bot: { profile: 'local-qa', appId: 'cli_local', openId: 'ou_bot' }, requesterOpenIds: ['ou_requester'], allowedChatIds: ['oc_local'],
    document: { domain: tenant, profile: 'local-docs', appId: 'cli_docs', openId: 'ou_document' },
    templateUrl: 'https://' + tenant + '/sheets/Template', projectFolderUrl: 'https://' + tenant + '/drive/folder/Root',
    lockDirectory: path.join(root, 'locks'), reportDirectory, powerShell: process.env.AGENTOS_REQUIREMENT_POWERSHELL ?? 'pwsh', validationCli: fakeCli,
    timeZone: 'Asia/Shanghai',
    skills: { generator: await skillFingerprint(skillsRoot, 'lark-testcase-by-prd-order-generator', generatorReferences),
      regression: await skillFingerprint(skillsRoot, 'run-full-requirement-regression', regressionReferences) },
    environment: { name: 'SIT', platform: 'Sample', lockKey: 'fixture', iniPath, resources: { platform: { section: 'Sample.Sit.Platform', scope: 'full_crud' } } },
    execution: {
      operations: {
        candidate: { resource: 'platform', kind: 'http', path: '/candidate', precondition: true,
          outputs: { id: ['data', 'id'], ready: ['data', 'ready'] } },
        fixture: { resource: 'platform', kind: 'fixture', key: 'code', object: '预算专属记录', inputs: ['candidate'], lookup,
          create: { kind: 'browser', authenticated: false, path: '/form', effect: { path: '/fixture', method: 'POST', keyField: ['code'] }, actions: [
            { kind: 'click', selector: '#open' }, { kind: 'fill', selector: '[name=code]', input: 'code' },
            { kind: 'fill', selector: '[name=candidate]', input: 'candidate' }, { kind: 'select', selector: '[name=mode]', value: 'approved' },
            { kind: 'submit', selector: '#submit' },
          ] }, remove: { kind: 'http', method: 'DELETE', path: '/fixture' } },
        balance: { ...lookup, resource: 'platform', inputs: ['code'], observations: [budget] },
        details: { resource: 'platform', kind: 'browser', authenticated: false, inputs: ['code'],
          actions: [{ kind: 'navigate', path: '/details', query: { code: 'code' } }], selectors: { state: { selector: '#status', read: 'text' } },
          observations: [{ id: 'state', label: '记录状态', type: 'text', field: ['values', 'state'] }] },
        zero: { resource: 'platform', kind: 'http', path: '/zero', outputs: budgetOutputs, observations: [budget] },
      },
    },
  };
  const project = { displayName: '隔离项目', repoPath: repo, baseBranch: 'main', requirementTest: settings };
  const projects = { projects: { alpha: project }, chatProjectMap: { oc_local: 'alpha' }, topicChatIds: ['oc_local'] };
  const config = { projects: projects.projects, dataDir };
  const store = new JsonStore(path.join(dataDir, 'agentos.json'));
  const deliveries = [];
  const context = { config, store, requirementRoutes: validateRequirementRoutes(projects, { agents: { qa: settings.bot } }),
    feishu: { reply: async () => {}, async replyFile(id, file, destination) {
      deliveries.push({ id, file, thread: destination.replyInThread, profile: destination.profile, sha256: sha(await readFile(file)) });
      return { message_id: 'om_local_report' };
    } } };
  const message = (id, content, overrides = {}) => handleRequirementMessage(context, {
    agent_profile: settings.bot.profile, receiving_app_id: settings.bot.appId, receiving_bot_id: settings.bot.openId, chat_id: 'oc_local',
    chat_type: 'group', sender_id: 'ou_requester', message_id: 'om_' + id, thread_id: 'omt_local', content,
    mentions: [{ id: { open_id: settings.bot.openId } }], ...overrides,
  });
  const started = await message('start', doc);
  assert.ok(started.jobId);
  const jobId = started.jobId;
  assert.deepEqual(await message('start', doc), { duplicate: true });
  const workDir = path.join(dataDir, 'requirement-tests', jobId);
  const journalFile = path.join(workDir, 'journal.json');
  const base = { id: 'LocalDoc', revision: 7, title: '隔离预算', url: doc, xml: '<h1 id="A1">预算</h1>', embedded: [] };
  const legacy = { ...base, hash: digest(base) };
  const png = path.join(root, 'diagram.png');
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage({ viewport: { width: 780, height: 180 } });
    await page.setContent('<main style="font:28px sans-serif">图示规则：预算台账余额100元<br>小数位需确认，示例不作为规则</main>');
    await page.screenshot({ path: png });
  } finally { await browser.close(); }
  const image = { type: 'img', anchor: 'ImageRule', filename: 'diagram.png', sha256: sha(await readFile(png)) };
  const source = { ...base, legacyHash: legacy.hash, materials: [image], hash: digest([base, [image]]) };
  let rich = false;
  const { copies, client } = mockPublisher();
  client.listFolder = async token => token === 'Root' ? [{ type: 'folder', token: 'Month',
    name: versionNames(base.title, new Date(), settings.timeZone).folderName }]
    : [...copies.values()];
  client.readRequirement = async () => {
    if (!rich) return legacy;
    await writeFile(path.join(workDir, image.filename), await readFile(png));
    return source;
  };
  let generated = 0;
  let revisions = 0;
  const dependencies = { client, generate: async () => {
    generated++;
    return { projectMatch: 'match', requirements: [{ id: 'R1', anchor: 'A1', rule: '预算和记录状态可核对。' }],
      caseRequirements: [['R1']], manifest: { module_order: ['预算'], headers, required_texts: [],
        rows: [sampleRow('构造并核验预算记录', '1. 预算余额100元\n2. 记录状态为已登记')] } };
  }, async materialModel(prompt, { images }) {
    assert.equal(sha(await readFile(images[0])), image.sha256);
    if (prompt.startsWith('比较')) return { materials: [{ anchor: image.anchor, rules: [],
      uncovered: [{ rule: '图示明确要求对照场景预算余额100元。' }],
      questions: prompt.includes('不要求固定小数位') ? [] : [{ question: '是否要求固定小数位？' }] }] };
    revisions++;
    const id = prompt.match(/"id":"(IMG-[a-f0-9]{12})"/)[1];
    return { rows: [sampleRow('图示预算对照', '1. 预算余额100元')], caseRequirements: [[id]], required_texts: [] };
  }, async plan(prompt) {
    if (prompt.includes('图示预算对照')) return { missing: [], steps: [{ operation: 'zero', input: {}, checks: [check(['balance'], 100)] }] };
    const ref = (from, ...field) => ({ from, field });
    return { missing: [], steps: [
      { operation: 'candidate', input: {}, checks: [] },
      { operation: 'fixture', input: { candidate: ref(0, 'id') }, when: { ref: ref(0, 'ready'), equals: true }, checks: [] },
      { operation: 'balance', input: { code: ref(1, 'key') }, checks: [check(['balance'], 100)] },
      { operation: 'details', input: { code: ref(1, 'key') }, checks: [check(['values', 'state'], '已登记', 2)] },
    ] };
  }, async visualModel(_prompt, { images }) {
    const sheets = [];
    for (const file of images) {
      const png = await readFile(file);
      assert.equal(png.toString('hex', 0, 8), '89504e470d0a1a0a');
      assert.ok(png.readUInt32BE(16) > 300 && png.readUInt32BE(20) > 120);
      sheets.push({ filename: path.basename(file), usable: true, issues: [] });
    }
    return { sheets };
  } };
  let oldGate = true;
  const run = async () => {
    const job = await store.leaseNext('isolation-runner', ['requirement_test']);
    assert.equal(job.id, jobId);
    const event = { runnerId: 'isolation-runner', leaseId: job.lease.id };
    const result = await runRequirementTest(job, config, async entry => {
      await store.appendEvent(jobId, { ...entry, ...event });
      if (oldGate && entry.activity?.current === '测试环境执行与恢复') {
        oldGate = false;
        throw new RequirementWait('deployment_baseline', '历史任务等待发布指纹。');
      }
    }, dependencies);
    await store.appendEvent(jobId, { ...event, type: 'completed', result });
    return result;
  };
  assert.equal((await run()).requirementWait, 'deployment_baseline');
  const original = structuredClone(copies.get('Copy1'));
  const originalCases = await readFile(path.join(workDir, 'cases.json'));
  rich = true;
  assert.equal((await message('read_image', '继续测试')).jobId, jobId);
  const question = await run();
  assert.equal(question.requirementWait, 'material_clarification');
  assert.match(question.finalMessage, /是否要求固定小数位/);
  assert.equal((await message('wrong_sender', '确认图示 ' + question.requirementQuestions[0] + ' 不要求固定小数位', { sender_id: 'ou_other' })).ignored, true);
  assert.equal((await store.getJob(jobId)).status, 'awaiting_clarification');
  assert.equal((await message('confirm', '确认图示 ' + question.requirementQuestions[0] + ' 不要求固定小数位')).jobId, jobId);
  assert.equal((await run()).outcome, 'needs_clarification');
  assert.equal(createCount, 1);
  assert.equal((await readJson(journalFile)).mutations[0].phase, 'prepared');
  assert.equal(copies.size, 2);
  assert.deepEqual(copies.get('Copy1'), original);
  assert.deepEqual(await readFile(path.join(workDir, 'cases.json')), originalCases);
  assert.equal((await readJson(journalFile)).publicationHistory[0].fileToken, 'Copy1');
  await message('pause', '暂停测试');
  assert.equal((await store.getJob(jobId)).status, 'paused');
  assert.equal((await message('lost_receipt', '继续测试')).jobId, jobId);
  assert.deepEqual(await message('lost_receipt', '继续测试'), { duplicate: true });
  assert.equal((await run()).requirementWait, 'cleanup_pending');
  assert.equal(owned.size, 1);
  assert.equal((await readJson(journalFile)).mutations[0].reconciled, true);
  assert.equal((await message('cleanup', '恢复清理')).jobId, jobId);
  const completed = await run();
  assert.equal(completed.outcome, 'ready', completed.finalMessage);
  assert.equal(createCount, 1);
  assert.equal(deleteCount, 2);
  assert.equal(owned.size, 0);
  assert.equal(generated, 1);
  assert.equal(revisions, 1);
  assert.equal(copies.size, 2);
  assert.deepEqual(copies.get('Copy1'), original);
  assert.equal(completed.requirementSummary.pass, 1);
  assert.equal(completed.requirementSummary.fail, 1);
  const report = await readJson(path.join(workDir, 'normalized-report.json'));
  assert.ok(report.meta.method_notes.some(note => note.includes('未配置发布记录来源')));
  const journal = await readJson(journalFile);
  const bundle = await readJson(path.join(workDir, 'material-revision.json'));
  const originalIndex = await readJson(path.join(workDir, 'case-index.json'));
  assert.equal(bundle.index[0].caseId, originalIndex[0].caseId);
  assert.equal(bundle.requirements.find(item => item.id === bundle.index[1].requirementIds[0]).anchor, image.anchor);
  assert.equal(journal.executionCases[bundle.index[0].caseId].publicationVersion, journal.publication.version);
  assert.equal(report.prerequisites.length, 2);
  assert.equal(report.mutation_ledger.length, 1);
  assert.equal(report.cleanup_records.length, 1);
  assert.equal(report.mutation_ledger[0].primary_business_key, journal.mutations[0].intent.businessKey);
  assert.equal(report.mutation_ledger[0].target, '预算专属记录');
  assert.match(report.mutation_ledger[0].action, /create/);
  assert.equal(report.mutation_ledger[0].cleanup_result, '已清理');
  assert.equal(report.mutation_ledger[0].evidence_ids.length, 4);
  assert.equal(journal.results[bundle.index[0].caseId].assertions.length, 2);
  assert.equal(new Set(journal.results[bundle.index[0].caseId].assertions.map(item => item.evidence.path)).size, 2);
  const artifact = completed.requirementReport;
  const receipt = await readJson(path.join(dataDir, 'exports', jobId, artifact.id + '.verification.json'));
  assert.deepEqual(receipt.workbookDataCounts, { prerequisites: 2, mutation_ledger: 1, cleanup_records: 1 });
  assert.equal(receipt.sheetCount, 15);
  const delivery = new ReportDelivery(context);
  const finished = await store.getJob(jobId);
  await delivery.enqueue(finished);
  await delivery.enqueue(finished);
  await delivery.close();
  assert.equal(deliveries.length, 1);
  assert.deepEqual({ id: deliveries[0].id, thread: deliveries[0].thread, profile: deliveries[0].profile, sha256: deliveries[0].sha256 },
    { id: 'om_start', thread: true, profile: settings.bot.profile, sha256: artifact.sha256 });
  await writeJson(path.join(root, 'isolation-result.json'), { jobId, createCount, deleteCount, remaining: owned.size,
    report: artifact, summary: completed.requirementSummary, deliveries, events, publicationVersions: report.meta.test_case_sources });
});
