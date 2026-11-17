import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { copyFile, mkdtemp, mkdir, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { chromium } from 'playwright';
import { JsonStore } from '../src/shared/store.js';
import { ReportDelivery } from '../src/control-plane/report-delivery.js';
import { handleRequirementMessage, validateRequirementRoutes } from '../src/control-plane/requirement-testing.js';
import { createRequirementAdapter } from '../src/runner/requirement-adapter.js';
import { digest, RequirementWait } from '../src/runner/requirement-feishu.js';
import { command, generatorReferences, readJson, regressionReferences, sourceBaseline, writeJson } from '../src/runner/requirement-files.js';
import { caseReleaseRequirement, matchesCaseRelease, verifyRequirementRelease } from '../src/runner/requirement-release.js';
import { versionNames } from '../src/runner/requirement-publication.js';
import { runRequirementTest } from '../src/runner/requirement-test.js';
import { readSource } from '../src/runner/requirement-agent-resources.js';

const sha = value => createHash('sha256').update(value).digest('hex');
const check = (field, expected, assertion = 1) => ({ field, expected, assertion, operator: 'equals' });
const budget = { id: 'budget', label: '预算余额', type: 'number', unit: '元', unitField: ['currency'], field: ['balance'] };
const budgetOutputs = { balance: ['data', 'balance'], currency: ['data', 'currency'], unrelated: ['data', 'unrelated'] };

test('requested source errors name the repository and distinguish denied and unavailable origins', async t => {
  const root = await realpath(await mkdtemp(path.join(tmpdir(), 'agentos-required-origin-')));
  t.after(() => rm(root, { recursive: true, force: true }));
  const endpoint = await localServer(t, (req, res) => {
    res.writeHead(req.url.startsWith('/denied/') ? 403 : 503);
    res.end();
  });
  const repo = path.join(root, 'server');
  const git = args => command('git', ['-C', repo, ...args]);
  await command('git', ['init', '-b', 'wl-prd', repo]);
  await git(['-c', 'user.name=Local Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '--allow-empty', '-m', 'Baseline']);
  await git(['branch', 'uat-merge']);
  await git(['remote', 'add', 'origin', endpoint + '/denied']);
  const project = { repoPath: repo, baseBranch: 'wl-prd' };
  for (const [route, status, reason] of [
    ['denied', 'auth_failed', '鉴权失败'],
    ['unavailable', 'network_failed', '网络连接失败'],
  ]) {
    await git(['remote', 'set-url', 'origin', endpoint + '/' + route]);
    await assert.rejects(sourceBaseline(project, 'uat-merge'), error => error.code === 'repository'
      && error.message.includes('server') && error.message.includes(reason)
      && error.repositorySync[0].status === status && error.repositorySync[0].commit === null);
  }
});

test('requested branches probe a shared Git origin in bounded batches', async t => {
  const root = await realpath(await mkdtemp(path.join(tmpdir(), 'agentos-origin-batches-')));
  t.after(() => rm(root, { recursive: true, force: true }));
  let concurrent = 0, peak = 0, requests = 0;
  const endpoint = await localServer(t, async (_req, res) => {
    requests += 1;
    peak = Math.max(peak, ++concurrent);
    await new Promise(resolve => setTimeout(resolve, 1500));
    concurrent -= 1;
    res.writeHead(503).end();
  });
  const git = (cwd, args) => command('git', ['-C', cwd, ...args]);
  await command('git', ['init', '-b', 'wl-prd', root]);
  await git(root, ['-c', 'user.name=Local Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '--allow-empty', '-m', 'Baseline']);
  const paths = ['.', 'a', 'b', 'c', 'd', 'e'];
  await Promise.all(paths.slice(1).map(repo => command('git', ['clone', '--single-branch', '--branch', 'wl-prd', root, path.join(root, repo)])));
  await git(root, ['remote', 'add', 'origin', endpoint + '/root']);
  await Promise.all(paths.slice(1).map(repo => git(path.join(root, repo), ['remote', 'set-url', 'origin', endpoint + '/' + repo])));
  const project = { repoPath: root, analysisRepositories: paths.map(repo => ({ path: repo, branch: 'wl-prd' })) };
  await assert.rejects(sourceBaseline(project, 'uat-merge'), error => error.code === 'repository'
    && error.repositorySync.length === paths.length && error.repositorySync.every(repo => repo.status === 'network_failed'));
  assert.equal(requests, paths.length);
  assert.ok(peak <= 3, 'observed concurrent network probes: ' + peak);
});

test('static mixed outcomes preserve compared failures across later missing data and transport failures', async t => {
  const dir = await mkdtemp(path.join(tmpdir(), 'agentos-static-mixed-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  let balance = 80;
  let mode = 'missing';
  const url = await localServer(t, (req, res) => {
    if (req.url === '/second' && mode === 'network') return req.socket.destroy();
    const data = req.url === '/first' ? { balance, currency: '元' } : mode === 'missing' ? { currency: '元' } : { balance: 50, currency: '元' };
    res.end(JSON.stringify({ data }));
  });
  const second = { ...budget, id: 'limit', label: '计划限额' };
  const operation = (route, rule) => ({ kind: 'http', resource: route, path: '/' + route, outputs: budgetOutputs, observations: [rule] });
  const adapter = createRequirementAdapter({ operations: { first: operation('first', budget), second: operation('second', second) } }, {
    plan: async () => ({ missing: [], steps: [
      { operation: 'first', input: {}, checks: [check(['balance'], 100)] },
      { operation: 'second', input: {}, checks: [check(['balance'], 50, 2)], ...(mode === 'skipped' ? { when: { ref: { from: 0, field: ['balance'] }, equals: 999 } } : {}) },
    ] }),
  });
  const scope = { item: { caseId: 'CASE-mixed' }, row: ['1. 预算余额100元\n2. 计划限额50元'], headers: ['预期结果'], reports: dir,
    useRead: (resource, run) => {
      if (resource === 'second' && mode === 'denied') throw new RequirementWait('environment_scope', 'scope revoked');
      return run({ base_url: url });
    }, checkOutput: value => value, repositories: [] };
  const execute = async () => adapter.execute({ ...scope, preparation: await adapter.prepare(scope) });
  for (mode of ['missing', 'skipped', 'network', 'denied']) {
    const result = await execute();
    assert.equal(result.status, '失败', mode);
    assert.ok(result.issue && result.blocker);
    assert.equal(result.assertions[0].observed, 80);
    assert.equal(result.checkCoverage.compared, 1);
    assert.equal(result.checkCoverage.total, 2);
  }
  mode = 'missing'; balance = 100;
  const partial = await execute();
  assert.equal(partial.status, '阻断');
  assert.equal(partial.issue, undefined);
  assert.equal(partial.checkCoverage.passed, 1);
});

test('source intake distinguishes configured branch, clean non-target HEAD, dirty bytes and explicit ref', async t => {
  const root = await mkdtemp(path.join(tmpdir(), 'agentos-source-attempt-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const git = async (...args) => (await command('git', ['-C', root, '-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', ...args])).trim();
  await git('init', '-b', 'main');
  await writeFile(path.join(root, 'service.js'), 'main\n');
  await git('add', '.'); await git('commit', '-m', 'main');
  const main = await git('rev-parse', 'HEAD');
  await git('switch', '-c', 'other');
  await writeFile(path.join(root, 'service.js'), 'other\n');
  await git('commit', '-am', 'other');
  const head = await git('rev-parse', 'HEAD');
  const [baseline] = await sourceBaseline({ repoPath: root, baseBranch: 'main' });
  assert.equal(baseline.commit, main);
  assert.equal(baseline.worktree_commit, head);
  assert.equal(baseline.worktree_branch, 'other');
  await writeFile(path.join(root, 'service.js'), 'dirty\n');
  const physical = await readSource(root, { action: 'read', path: 'service.js' });
  const pinned = await readSource(root, { action: 'show', path: '.', file: 'service.js', ref: 'main' });
  assert.equal(physical.origin.commit, head);
  assert.equal(physical.origin.kind, 'worktree');
  assert.equal(physical.contentSha256, sha('dirty\n'));
  assert.equal(pinned.origin.commit, main);
  assert.equal(pinned.origin.kind, 'git');
  assert.equal(pinned.contentSha256, sha('main\n'));
  const child = path.join(root, 'component');
  await git('init', '-b', 'main', child);
  await writeFile(path.join(child, 'service.js'), 'child\n');
  await git('-C', child, 'add', '.'); await git('-C', child, 'commit', '-m', 'child');
  const childRead = await readSource(root, { action: 'read', path: 'component/service.js' });
  const repos = await sourceBaseline({ repoPath: root, analysisRepositories: [{ path: '.', branch: 'main' }, { path: 'component', branch: 'main' }] });
  assert.equal(childRead.origin.repository, 'component');
  assert.equal(childRead.origin.commit, repos[1].worktree_commit);
  assert.notEqual(childRead.origin.commit, repos[0].worktree_commit);
});

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
test('an original workbook stuck on legacy coverage resumes the same Job, records mixed results and reports coverage after cleanup',
  { skip: !skillsRoot && 'Set AGENTOS_REQUIREMENT_SKILLS_ROOT to the installed QA Skills' }, async t => {
  const root = await realpath(await mkdtemp(path.join(tmpdir(), 'agentos-coverage-resume-')));
  t.after(() => rm(root, { recursive: true, force: true }));
  const repo = path.join(root, 'repo');
  await command('git', ['init', '-b', 'main', repo]);
  await command('git', ['-C', repo, '-c', 'user.name=Local Fixture', '-c', 'user.email=fixture@example.invalid',
    'commit', '--allow-empty', '-m', 'Coverage fixture']);
  const requests = [];
  const fixtures = new Set();
  const endpoint = await localServer(t, async (req, res) => {
    const url = new URL(req.url, 'http://localhost');
    requests.push(req.method + ' ' + url.pathname);
    res.setHeader('Content-Type', 'application/json');
    if (url.pathname === '/fixture') {
      let key = url.searchParams.get('code');
      if (req.method === 'POST') {
        let raw = ''; for await (const chunk of req) raw += chunk;
        key = JSON.parse(raw).code;
        assert.ok(!fixtures.has(key));
        fixtures.add(key);
      }
      if (req.method === 'DELETE') fixtures.delete(key);
      return res.end(JSON.stringify({ exists: fixtures.has(key), key }));
    }
    res.end(JSON.stringify({ data: { balance: url.pathname === '/defect' ? 80 : 100, currency: '元' } }));
  });
  const iniPath = path.join(root, 'uat.ini');
  await writeFile(iniPath, ['[Sample.Uat.Platform]\nstatus=configured\nai_access=allowed\nai_operation_mode=read_only\nenvironment=Uat',
    '[Sample.Uat.Fixture]\nstatus=configured\nai_access=allowed\nai_operation_mode=full_crud\nenvironment=Uat',
    '[Sample.Uat.Denied]\nstatus=configured\nai_access=denied\nai_operation_mode=read_only\nenvironment=Uat']
    .map(section => section + '\nbase_url=' + endpoint + '\n').join('\n'));
  const bot = { profile: 'coverage-qa', appId: 'cli_coverage', openId: 'ou_coverage' };
  const readBudget = { resource: 'platform', kind: 'http', path: '/budget', outputs: budgetOutputs, observations: [budget] };
  const settings = {
    bot, requesterOpenIds: ['ou_sender'], allowedChatIds: ['oc_coverage'], lockDirectory: path.join(root, 'locks'),
    reportDirectory: path.join(root, 'reports'), timeZone: 'Asia/Shanghai',
    document: { domain: tenant, profile: 'doc-reader', appId: 'cli_docs', openId: 'ou_doc' },
    templateUrl: 'https://' + tenant + '/sheets/Template',
    skills: { generator: await skillFingerprint(skillsRoot, 'lark-testcase-by-prd-order-generator', generatorReferences),
      regression: await skillFingerprint(skillsRoot, 'run-full-requirement-regression', regressionReferences) },
    environment: { name: 'UAT', platform: 'Sample', lockKey: 'coverage', iniPath, resources: {
      platform: { section: 'Sample.Uat.Platform', scope: 'read' }, denied: { section: 'Sample.Uat.Denied', scope: 'read' },
      fixture: { section: 'Sample.Uat.Fixture', scope: 'full_crud' },
    } },
    execution: { operations: { budget: readBudget, denied: { ...readBudget, resource: 'denied' }, defect: { ...readBudget, path: '/defect' },
      fixture: { resource: 'fixture', kind: 'fixture', key: 'code',
        lookup: { kind: 'http', path: '/fixture', outputs: { exists: ['exists'], key: ['key'] } },
        create: { kind: 'http', method: 'POST', path: '/fixture' }, remove: { kind: 'http', method: 'DELETE', path: '/fixture' } },
    } },
  };
  const projects = { projects: { coverage: { displayName: '覆盖隔离项目', repoPath: repo, baseBranch: 'main', requirementTest: settings } },
    chatProjectMap: { oc_coverage: 'coverage' }, topicChatIds: ['oc_coverage'] };
  const store = new JsonStore(path.join(root, 'state.json'));
  const context = { config: { dataDir: root }, store, requirementRoutes: validateRequirementRoutes(projects, { agents: { qa: bot } }),
    feishu: { reply: async () => {} } };
  const message = (id, content) => handleRequirementMessage(context, {
    agent_profile: bot.profile, receiving_app_id: bot.appId, receiving_bot_id: bot.openId, chat_id: 'oc_coverage',
    chat_type: 'group', sender_id: 'ou_sender', thread_id: 'omt_coverage', message_id: 'om_' + id, content, mentions: [{ id: bot.openId }],
  });
  const originalURL = 'https://' + tenant + '/sheets/Original';
  const { jobId } = await message('start_coverage', '需求文档：' + doc + '\n测试用例：' + originalURL);
  const rows = ['权限不足的用例', '隔离夹具预算核对', '隔离产品错误'].map(name => sampleRow(name, '1. 预算余额100元'));
  const { copies, client } = mockPublisher();
  copies.set('Original', { matrix: [headers, ...rows], revision: 0 });
  client.resolveInput = async () => ({ url: originalURL, token: 'Original' });
  const source = { id: 'LocalDoc', revision: 1, title: '隔离覆盖验证', url: doc,
    xml: '<h1 id="A1">预算余额100元</h1><p id="A2">核对独立的导出规则</p>', embedded: [] };
  client.readRequirement = async () => ({ ...source, hash: digest(source) });
  const workDir = path.join(root, 'requirement-tests', jobId);
  const config = { projects: projects.projects, dataDir: root };
  const legacyCandidate = { projectMatch: 'match', requirements: [{ id: 'R1', anchor: 'A1', rule: '预算余额100元。' }],
    caseRequirements: [[], ['INVENTED'], ['R1']] };
  const legacyProgram = process.env.AGENTOS_COVERAGE_LEGACY_PROGRAM;
  const oldRunner = legacyProgram
    ? (await import(pathToFileURL(path.join(legacyProgram, 'src/runner/requirement-test.js')))).runRequirementTest : runRequirementTest;
  const run = async (runner, deps, progress = async () => {}) => {
    const job = await store.leaseNext('coverage-runner', ['requirement_test']);
    assert.equal(job.id, jobId);
    const lease = { runnerId: 'coverage-runner', leaseId: job.lease.id };
    const result = await runner(job, config, async event => { await store.appendEvent(jobId, { ...event, ...lease }); await progress(event); }, deps);
    await store.appendEvent(jobId, { ...lease, type: 'completed', result });
    return result;
  };
  const previous = await run(oldRunner, { client, generate: async () => structuredClone(legacyCandidate) }, async event => {
    if (!legacyProgram && event.activity?.current === '建立原表执行索引') {
      await writeJson(path.join(workDir, 'cases.json'), { headers, rows,
        source: { title: source.title, url: doc, revision: source.revision } });
      throw new RequirementWait('case_quality', '用例缺少有效的需求条款引用。');
    }
  });
  assert.equal(previous.requirementWait, 'case_quality');
  assert.equal((await store.getJob(jobId)).status, 'awaiting_clarification');
  assert.equal((await readJson(path.join(workDir, 'journal.json'))).casesHash, undefined);
  assert.deepEqual(requests, []);
  const savedCases = await readFile(path.join(workDir, 'cases.json'));
  assert.equal((await message('continue_coverage', '继续测试')).jobId, jobId);
  let analyses = 0;
  const dependencies = { client,
    async generate({ existingCases }) {
      analyses++;
      assert.deepEqual(existingCases, rows);
      assert.equal(fixtures.size, 0);
      assert.ok(requests.includes('GET /defect'));
      return { ...legacyCandidate, requirements: [...legacyCandidate.requirements,
        { id: 'R2', anchor: 'A2', rule: '验证导出结构。' }, { id: 'Rbad', anchor: 'INVENTED', rule: '不存在的条款。' }] };
    },
    async plan(prompt) {
      const operation = prompt.includes('权限不足的用例') ? 'denied' : prompt.includes('隔离产品错误') ? 'defect' : 'budget';
      const steps = operation === 'budget' ? [{ operation: 'fixture', input: {}, checks: [] }] : [];
      return { missing: [], steps: [...steps, { operation, input: {}, checks: [check(['balance'], 100)] }] };
    },
    async visualModel(_prompt, { images }) { return { sheets: images.map(file => ({ filename: path.basename(file), usable: true, issues: [] })) }; },
  };
  const interrupted = await run(runRequirementTest, dependencies, async event => {
    if (event.activity?.requirement?.phase === 'case_complete' && event.activity.completed === 2) {
      throw new RequirementWait('test_fixture_interrupt', '隔离夹具在已验证两条后中断。');
    }
  });
  assert.equal(interrupted.requirementWait, 'test_fixture_interrupt', interrupted.finalMessage);
  const savedResults = (await readJson(path.join(workDir, 'journal.json'))).results;
  assert.equal(Object.keys(savedResults).length, 2);
  assert.equal(fixtures.size, 0);
  assert.equal(analyses, 0);
  assert.equal((await message('continue_after_result', '继续测试')).jobId, jobId);
  const result = await run(runRequirementTest, dependencies);
  assert.equal(result.outcome, 'ready', result.finalMessage + '\n' + JSON.stringify(await readJson(path.join(workDir, 'report-build-error.json'))));
  assert.deepEqual([result.requirementSummary.blocked, result.requirementSummary.pass, result.requirementSummary.fail], [1, 1, 1]);
  assert.equal(analyses, 1);
  assert.equal(fixtures.size, 0);
  assert.deepEqual(await readFile(path.join(workDir, 'cases.json')), savedCases);
  assert.equal(copies.size, 1);
  assert.deepEqual(copies.get('Original').matrix, [headers, ...rows]);
  const journal = await readJson(path.join(workDir, 'journal.json'));
  for (const [id, saved] of Object.entries(savedResults)) assert.deepEqual(journal.results[id], saved);
  const index = await readJson(path.join(workDir, 'case-index.json'));
  const report = await readJson(path.join(workDir, 'normalized-report.json'));
  assert.deepEqual(index.map(item => item.row), [2, 3, 4]);
  assert.ok(index.every(item => !item.requirementIds.length));
  assert.deepEqual(report.cases.map(row => row.status), ['阻断', '通过', '失败']);
  assert.deepEqual(report.cases.map(row => row.requirement_ref), [
    ['原用例表第 2 行', '未匹配需求条款'], ['原用例表第 3 行', '未匹配需求条款'], ['原用例表第 4 行', 'R1'],
  ]);
  assert.deepEqual(journal.caseCoverage.unmatchedRows, [2, 3]);
  assert.deepEqual(journal.caseCoverage.uncoveredRequirements.map(item => item.id), ['R2']);
  assert.equal(journal.caseCoverage.rejectedClauses, 1);
  assert.equal(journal.caseCoverage.rows[1].rejectedReferences, 1);
  assert.match(report.meta.execution_scope.join(' '), /R2.*未发现对应验证项/);
  assert.equal(report.cleanup_records[0].status, '已清理');
  assert.ok(journal.cleanup.verified && journal.mutations.every(item => item.cleanup?.verified));
  assert.equal(requests.filter(request => request === 'POST /fixture').length, 1);
  assert.equal(requests.filter(request => request === 'DELETE /fixture').length, 1);
  const requested = process.env.AGENTOS_COVERAGE_EVIDENCE_DIR;
  if (requested) {
    const output = path.join(requested, 'provided');
    await mkdir(output, { recursive: true });
    const filename = result.requirementReport.filename;
    for (const file of ['journal.json', 'case-index.json', 'normalized-report.json']) await copyFile(path.join(workDir, file), path.join(output, file));
    await copyFile(path.join(root, 'exports', jobId, filename), path.join(output, filename));
    await writeJson(path.join(output, 'acceptance.json'), { jobId, originalStatus: previous.requirementWait, legacyProgram: Boolean(legacyProgram),
      requests, priorResultsPreserved: true, summary: result.requirementSummary, workbook: filename, workbookSha256: result.requirementReport.sha256 });
  }
});

test('structured requirement reads named supplements, comments and the designated workbook before enforcing sidebar-only execution',
  { skip: !skillsRoot && 'Set AGENTOS_REQUIREMENT_SKILLS_ROOT to the installed QA Skills' }, async t => {
  const root = await realpath(await mkdtemp(path.join(tmpdir(), 'agentos-structured-intake-')));
  t.after(() => rm(root, { recursive: true, force: true }));
  const handoff = path.join(root, '验收交接.md');
  await writeFile(handoff, '# 环境说明\n仅使用隔离环境。');
  const supplement = 'https://' + tenant + '/wiki/Rules';
  const workbook = 'https://' + tenant + '/sheets/Existing';
  const { client, copies } = mockPublisher();
  const row = sampleRow('读取隔离预算', '1. 预算余额100元');
  row[headers.indexOf('测试结果')] = '旧结果';
  copies.set('Existing', { matrix: [headers, row], revision: 0 });
  const resolved = [];
  client.resolveInput = async (reference, kind) => {
    resolved.push([reference, kind]);
    return reference === '预算主需求' ? { url: doc } : reference === '预算补充说明' ? { url: supplement }
      : { url: workbook, token: 'Existing' };
  };
  client.readRequirement = async url => {
    const source = { id: url === doc ? 'Main' : 'Rules', revision: 3, url, xml: '<h1 id="A1">15.2 预算</h1>',
      title: url === doc ? '预算主需求' : '预算补充说明', embedded: [] };
    return { ...source, hash: digest(source) };
  };
  client.readComments = async url => {
    assert.equal(url, supplement);
    return [{ id: '99', replies: [{ id: '100', content: '确认 15.2 范围' }] }];
  };
  const bot = { profile: 'qa', appId: 'cli_qa', openId: 'ou_bot' };
  const settings = { bot, allowedChatIds: ['oc_local'], requesterOpenIds: ['ou_requester'], allowedInputDirectories: [root],
    document: { domain: tenant, profile: 'docs', appId: 'cli_docs', openId: 'ou_docs' },
    templateUrl: 'https://' + tenant + '/sheets/Template', environment: { name: 'UAT' },
    skills: { generator: await skillFingerprint(skillsRoot, 'lark-testcase-by-prd-order-generator', generatorReferences),
      regression: await skillFingerprint(skillsRoot, 'run-full-requirement-regression', regressionReferences) } };
  const project = { displayName: '隔离项目', requirementTest: settings };
  const projects = { projects: { demo: project }, topicChatIds: ['oc_local'], chatProjectMap: { oc_local: 'demo' } };
  const store = new JsonStore(path.join(root, 'state.json'));
  const context = { projects, store, requirementRoutes: validateRequirementRoutes(projects, { agents: { qa: bot } }),
    feishu: { reply: async () => {} } };
  const { jobId } = await handleRequirementMessage(context, { agent_profile: bot.profile, receiving_app_id: bot.appId,
    receiving_bot_id: bot.openId, chat_type: 'group', chat_id: 'oc_local', sender_id: 'ou_requester', message_id: 'om_structured',
    mentions: [{ id: bot.openId }], content: [
      '需求内容：完成隔离需求测试', '分支名称：uat-merge', '测试用例：预算原用例', '需求文档：预算主需求',
      '补充文档：预算补充说明', '补充说明：15.2，可结合评论区和上下文', '本地补充：' + handoff,
      '准许内容：可以准备合成数据，结果仅接受通过或不通过', '备注内容：仅允许使用Codex的自带侧边栏浏览器',
    ].join('\n') });
  const job = await store.leaseNext('structured-runner', ['requirement_test']);
  assert.equal(job.id, jobId);
  const result = await runRequirementTest(job, { projects: projects.projects, dataDir: root }, async () => {}, { client,
    generate() { assert.fail('A sidebar-only request cannot start background generation or execution'); } });
  assert.equal(result.requirementWait, 'browser_unavailable');
  assert.match(result.finalMessage, /不通过（验收未完成）.*\n.*侧边栏浏览器/);
  const directory = path.join(root, 'requirement-tests', jobId);
  const journal = await readJson(path.join(directory, 'journal.json'));
  const source = await readJson(path.join(directory, 'requirement.json'));
  assert.deepEqual(resolved, [['预算主需求', 'document'], ['预算补充说明', 'document'], ['预算原用例', 'cases']]);
  assert.equal(journal.providedCases.fileToken, 'Existing');
  assert.equal(journal.providedCases.count, 1);
  assert.equal(journal.publication, undefined);
  assert.equal(journal.mutations, undefined);
  assert.equal(copies.get('Existing').matrix[1][headers.indexOf('测试结果')], '旧结果');
  assert.equal(source.request.branch, 'uat-merge');
  assert.equal(source.supplements[0].name, '验收交接.md');
  assert.equal(source.documents[0].comments[0].replies[0].content, '确认 15.2 范围');

  const repo = path.join(root, 'repo');
  const seed = path.join(root, 'seed');
  const origin = path.join(root, 'origin');
  const git = (cwd, args) => command('git', ['-C', cwd, ...args]).then(value => value.trim());
  const commit = (cwd, message) => git(cwd, ['-c', 'user.name=Local Fixture', '-c', 'user.email=fixture@example.invalid',
    'commit', '--allow-empty', '-m', message]);
  await command('git', ['init', '-b', 'wl-prd', seed]);
  await commit(seed, 'Default branch');
  const defaultCommit = await git(seed, ['rev-parse', 'HEAD']);
  await git(seed, ['switch', '-c', 'uat-merge']);
  await writeFile(path.join(seed, 'contract.txt'), 'budget comes from the named branch');
  await git(seed, ['add', '--', 'contract.txt']);
  await commit(seed, 'Add contract');
  const branchCommit = await git(seed, ['rev-parse', 'HEAD']);
  await command('git', ['init', '--bare', origin]);
  await git(seed, ['push', origin, 'wl-prd', 'uat-merge']);
  await command('git', ['clone', '--no-local', '--single-branch', '--branch', 'wl-prd', origin, repo]);
  const otherOrigin = path.join(root, 'other-origin');
  await command('git', ['init', '--bare', otherOrigin]);
  await git(seed, ['push', otherOrigin, 'wl-prd']);
  await command('git', ['clone', '--single-branch', '--branch', 'wl-prd', otherOrigin, path.join(repo, 'component')]);
  await git(seed, ['switch', 'wl-prd']);
  await commit(seed, 'Advance unrelated branch');
  await git(seed, ['tag', 'default-release']);
  await git(seed, ['push', origin, 'wl-prd', 'default-release']);
  const expectedRefspec = '+refs/heads/wl-prd:refs/remotes/origin/wl-prd';
  const requestedRef = 'refs/remotes/origin/uat-merge';
  const fetchHeadFile = path.join(repo, '.git', 'FETCH_HEAD');
  const fetchHeadBefore = await readFile(fetchHeadFile, 'utf8').catch(error => {
    if (error.code === 'ENOENT') return null;
    throw error;
  });
  assert.equal(await git(repo, ['config', '--get', 'remote.origin.fetch']), expectedRefspec);
  await assert.rejects(git(repo, ['rev-parse', '--verify', requestedRef]));
  await git(repo, ['branch', 'uat-merge']); // A stale personal branch is not the remote source.
  await writeFile(path.join(repo, 'contract.txt'), 'untracked personal contents');
  Object.assign(project, { repoPath: repo, baseBranch: 'wl-prd',
    analysisRepositories: [{ path: '.', branch: 'wl-prd' }, { path: 'component', branch: 'wl-prd' }] });

  const requests = [];
  const endpoint = await localServer(t, (req, res) => {
    requests.push(req.method + ' ' + req.url);
    res.setHeader('Content-Type', 'application/json');
    res.end('{"data":{"balance":100,"currency":"元"}}');
  });
  const iniPath = path.join(root, 'uat.ini');
  await writeFile(iniPath, '[Sample.Uat.Platform]\nstatus=configured\nai_access=allowed\nai_operation_mode=read_only\nenvironment=Uat\nbase_url=' + endpoint + '\n');
  Object.assign(settings, { lockDirectory: path.join(root, 'locks'), reportDirectory: path.join(root, 'reports'), timeZone: 'Asia/Shanghai',
    environment: { name: 'UAT', platform: 'Sample', lockKey: 'test', iniPath, resources: { platform: { section: 'Sample.Uat.Platform', scope: 'read' } } },
    execution: { operations: { budget: { kind: 'http', resource: 'platform', path: '/budget', outputs: budgetOutputs, observations: [budget] } } } });
  const { jobId: backgroundId } = await handleRequirementMessage(context, { agent_profile: bot.profile, receiving_app_id: bot.appId,
    receiving_bot_id: bot.openId, chat_type: 'group', chat_id: 'oc_local', sender_id: 'ou_requester', message_id: 'om_background',
    mentions: [{ id: bot.openId }], content: '需求文档：预算主需求\n补充文档：预算补充说明\n补充说明：15.2，以评论为补充\n分支名称：uat-merge\n测试用例：预算原用例\n准许内容：结果仅接受通过或不通过' });
  const background = await store.leaseNext('structured-runner', ['requirement_test']);
  assert.equal(background.id, backgroundId);
  const finished = await runRequirementTest(background, { projects: projects.projects, dataDir: root }, async () => {}, { client,
    async generate({ existingCases }) {
      assert.equal(existingCases[0][headers.indexOf('测试结果')], '');
      throw new RequirementWait('generator', '隔离夹具模拟覆盖分析暂不可用。');
    },
    async plan() { return { missing: [], steps: [{ operation: 'budget', input: {}, checks: [check(['balance'], 100)] }] }; },
    async visualModel(_prompt, { images }) { return { sheets: images.map(file => ({ filename: path.basename(file), usable: true, issues: [] })) }; },
  });
  assert.equal(finished.outcome, 'ready', finished.finalMessage + '\n'
    + JSON.stringify(await readJson(path.join(root, 'requirement-tests', backgroundId, 'report-build-error.json'))));
  assert.equal(finished.requirementSummary.acceptance, '通过');
  assert.equal(finished.requirementSummary.caseUrl, workbook);
  assert.deepEqual(requests, ['GET /budget']);
  assert.equal(copies.size, 1);
  const finishedJournal = await readJson(path.join(root, 'requirement-tests', backgroundId, 'journal.json'));
  const pinned = finishedJournal.repositories;
  assert.deepEqual(pinned[0].requested, { branch: 'uat-merge', ref: requestedRef, commit: branchCommit, status: 'synced', fetched: true });
  assert.equal(pinned[1].requested.status, 'not_found');
  assert.match(finished.finalMessage, /component（origin 无此分支）/);
  assert.equal(Object.values(finishedJournal.sourceAttempts)[0].repositories[0].requested.commit, branchCommit);
  assert.equal(pinned[0].worktree_branch, 'wl-prd');
  assert.equal(await git(repo, ['rev-parse', 'HEAD']), defaultCommit);
  assert.equal(await git(repo, ['rev-parse', 'refs/remotes/origin/wl-prd']), defaultCommit);
  assert.equal(await git(repo, ['tag', '--list']), '');
  assert.equal(await git(repo, ['rev-parse', 'refs/heads/uat-merge']), defaultCommit);
  assert.equal(await git(repo, ['rev-parse', requestedRef]), branchCommit);
  assert.equal(await git(repo, ['config', '--get', 'remote.origin.fetch']), expectedRefspec);
  assert.equal(await readFile(fetchHeadFile, 'utf8').catch(error => {
    if (error.code === 'ENOENT') return null;
    throw error;
  }), fetchHeadBefore);
  assert.equal(await readFile(path.join(repo, 'contract.txt'), 'utf8'), 'untracked personal contents');
  // The saved attempt still reads its commit after a later ref update.
  await git(repo, ['update-ref', requestedRef, defaultCommit]);
  assert.deepEqual((await readSource(repo, { action: 'files' }, pinned)).lines, ['contract.txt']);
  assert.match((await readSource(repo, { action: 'search', pattern: 'named branch' }, pinned)).lines[0], /contract\.txt:1:budget/);
  assert.equal((await readSource(repo, { action: 'read', path: 'contract.txt' }, pinned)).origin.commit, branchCommit);
  assert.equal((await readSource(repo, { action: 'refs' }, pinned)).origin.commit, branchCommit);
  await assert.rejects(readSource(repo, { action: 'search', path: 'component', pattern: 'test' }, pinned), /component.*origin 无此分支/);
  await assert.rejects(readSource(repo, { action: 'show', path: '.', ref: 'HEAD', file: 'contract.txt' }, pinned), /explicitly requested branch/);
  const normalized = await readJson(path.join(root, 'requirement-tests', backgroundId, 'normalized-report.json'));
  assert.equal(normalized.meta.requirement_sources[1].location, supplement);
  assert.equal(normalized.meta.test_case_sources[0].location, workbook);
  assert.match(normalized.meta.method_notes.join(' '), /覆盖分析未完成/);
  assert.equal(normalized.cases[0].status, '通过');
});

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
  const origin = path.join(root, 'origin');
  await command('git', ['init', '--bare', origin]);
  await command('git', ['-C', repo, 'remote', 'add', 'origin', origin]);
  await command('git', ['-C', repo, 'push', 'origin', 'main']);
  const iniPath = path.join(root, 'uat.ini');
  const fakeCli = path.join(root, 'no-cli.cmd');
  await writeFile(fakeCli, '@exit /b 94\r\n');
  const handoff = path.join(root, 'release-handoff.md');
  await writeFile(handoff, '# 账务导出\n保留报表期间，预算余额可独立比较。');
  const requests = [];
  const fixtures = new Set();
  let revoked = true;
  let credential = 'fixture-before-rotation';
  const url = await localServer(t, async (req, res) => {
    const request = new URL(req.url, 'http://localhost');
    requests.push(req.method + ' ' + request.pathname);
    res.setHeader('Content-Type', 'application/json');
    if (request.pathname === '/releases') {
      res.writeHead(403).end('{"message":"denied"}');
    } else if (request.pathname === '/runtime-version') {
      res.end('runtime-bundle');
    } else if (request.pathname === '/refresh-fixture') {
      if (revoked) await writeFile(iniPath, resources('unknown'));
      res.end('{}');
    } else if (request.pathname === '/fixture') {
      let key = request.searchParams.get('code');
      if (req.method === 'POST') {
        let raw = ''; for await (const chunk of req) raw += chunk;
        key = JSON.parse(raw).code;
        assert.ok(!fixtures.has(key), 'new fixture should be dispatched once');
        fixtures.add(key);
      }
      if (req.method === 'DELETE') fixtures.delete(key);
      res.end(JSON.stringify({ exists: fixtures.has(key), key }));
    } else if (request.pathname === '/mismatch') {
      res.end('{"data":{"balance":80,"currency":"元"}}');
    } else if (request.pathname === '/limit') {
      res.writeHead(503).end('{"error":"unavailable"}');
    } else {
      res.end('{"data":{"balance":100,"currency":"元"}}');
    }
  });
  const resources = tier => ['[Sample.Uat.Platform]\nstatus=configured\nai_access=allowed\nai_operation_mode=read_only\nenvironment=Uat',
    '[Sample.Uat.Fixture]\nstatus=configured\nai_access=allowed\nai_operation_mode=full_crud\nenvironment=' + tier]
    .map(section => section + '\nbase_url=' + url + '\npassword=' + credential + '\n').join('\n');
  await writeFile(iniPath, resources('Uat'));
  const readBudget = { resource: 'platform', kind: 'http', path: '/budget', outputs: budgetOutputs, observations: [budget] };
  const settings = {
    bot: { profile: 'local-qa', appId: 'cli_local', openId: 'ou_bot' }, requesterOpenIds: ['ou_requester'], allowedChatIds: ['oc_local'],
    allowedInputDirectories: [root],
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
      operations: { budget: readBudget, pinned: { ...readBudget, path: '/pinned-budget' }, mismatch: { ...readBudget, path: '/mismatch' },
        limit: { ...readBudget, path: '/limit', observations: [{ ...budget, id: 'limit', label: '计划限额' }] },
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
  const { jobId } = await message('start', ['需求文档：' + doc, '本地补充：' + handoff, '执行环境：UAT', '分支名称：main'].join('\n'));
  const workDir = path.join(dataDir, 'requirement-tests', jobId);
  const { copies, client } = mockPublisher();
  client.listFolder = async token => token === 'Root' ? [{ type: 'folder', token: 'Month',
    name: versionNames('发布取证', new Date(), settings.timeZone).folderName }] : [...copies.values()];
  const source = { id: 'LocalDoc', revision: 4, title: '发布取证', url: doc,
    xml: '<h1 id="A1">预算</h1><p id="A2">账务导出需保留期间</p>', embedded: [] };
  client.readRequirement = async () => ({ ...source, hash: digest(source) });
  const rows = ['环境变化时拒绝写入', '指定版本场景', '普通预算读取'].map(name => sampleRow(name, '1. 预算余额100元'));
  rows.push(sampleRow('已证明失败后服务中断', '1. 预算余额100元\n2. 计划限额50元'));
  rows[1][headers.indexOf('前置条件')] = '1. 发布版本前置：web imageTag=uat-123';
  let generationCount = 0;
  const dependencies = { client, async generate({ source: materials, existingCases }) {
    generationCount++;
    assert.equal(existingCases, undefined);
    assert.equal(materials.supplements[0].name, 'release-handoff.md');
    assert.equal(materials.request.branch, 'main');
    return { projectMatch: 'match', requirements: [{ id: 'R1', anchor: 'A1', rule: '预算余额可以核对。' },
      { id: 'R2', anchor: 'A2', rule: '账务导出需保留期间。' }],
      caseRequirements: [[], ['INVENTED'], [], ['R1']], manifest: { module_order: ['预算'], headers, required_texts: [], rows } };
  }, async plan(prompt) {
    const read = { operation: 'budget', input: {}, checks: [check(['balance'], 100)] };
    if (prompt.includes('环境变化时拒绝写入')) return { missing: [], steps: [
      { operation: 'refresh', input: {}, checks: [] }, { operation: 'fixture', input: {}, checks: [] }, read,
    ] };
    if (prompt.includes('指定版本场景')) return { missing: [], steps: [{ ...read, operation: 'pinned' }] };
    if (prompt.includes('已证明失败后服务中断')) return { missing: [], steps: [
      { ...read, operation: 'mismatch' }, { ...read, operation: 'limit', checks: [check(['balance'], 50, 2)] },
    ] };
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
  assert.equal(completed.requirementSummary.fail, 1);
  assert.equal(completed.requirementSummary.incompleteFailures, 1);
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
  // Refresh invalidates the fixture binding, so neither lookup nor mutation is dispatched.
  assert.deepEqual(requests, ['GET /releases', 'GET /runtime-version', 'GET /refresh-fixture',
    'GET /releases', 'GET /runtime-version', 'GET /budget', 'GET /mismatch', 'GET /limit']);
  const report = await readJson(path.join(workDir, 'normalized-report.json'));
  assert.deepEqual(current.caseCoverage.unmatchedRows, [2, 3, 4]);
  assert.match(report.meta.execution_scope.join(' '), /R2.*未发现对应验证项/);
  assert.ok(report.meta.method_notes.some(note => /HTTP 403.*缺少构建号.*缺少镜像标识/.test(note)));
  assert.ok(report.evidence_index.some(entry => entry.type === '发布版本核验'));
  assert.deepEqual(report.blockers.map(item => item.dependency), ['已授权的非生产资源', '指定发布版本前置', 'limit']);
  assert.equal(report.issues.length, 1);
  assert.equal(report.issues[0].case_ids[0], report.blockers.at(-1).case_ids[0]);
  assert.match(report.issues[0].actual_result, /实测 80元.*独立检查 1\/2/);
  const oldArtifact = completed.requirementReport;
  const savedWorkbook = path.join(dataDir, 'exports', jobId, oldArtifact.filename);
  const oldWorkbook = await readFile(savedWorkbook);
  if (process.env.AGENTOS_COVERAGE_EVIDENCE_DIR) {
    const output = path.join(process.env.AGENTOS_COVERAGE_EVIDENCE_DIR, 'derived');
    await mkdir(output, { recursive: true });
    for (const file of ['journal.json', 'case-index.json', 'normalized-report.json']) await copyFile(path.join(workDir, file), path.join(output, file));
    await copyFile(savedWorkbook, path.join(output, oldArtifact.filename));
    await writeJson(path.join(output, 'acceptance.json'), { jobId, generatedFromRequirements: generationCount === 1,
      requests, summary: completed.requirementSummary, workbook: oldArtifact.filename, workbookSha256: oldArtifact.sha256 });
  }
  const blocked = Object.entries(current.results).filter(([, result]) => result.status === '阻断').map(([caseId]) => caseId);
  const passed = Object.entries(current.results).find(([, result]) => result.status === '通过')[0];
  const oldHead = current.sourceAttempts[blocked[0] + '@1'].repositories[0].worktree_commit;
  await command('git', ['-C', repo, 'switch', '-c', 'repair']);
  await command('git', ['-C', repo, '-c', 'user.name=Local Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '--allow-empty', '-m', 'Repair']);
  revoked = false;
  credential = 'fixture-after-rotation';
  await writeFile(iniPath, resources('Uat'));
  assert.equal((await message('retry-blocked', '重试阻断')).jobId, jobId);
  assert.deepEqual(await message('retry-blocked', '重试阻断'), { duplicate: true });
  const resumed = await run();
  assert.equal(resumed.outcome, 'ready', resumed.finalMessage);
  assert.equal(resumed.requirementSummary.pass, 2);
  assert.equal(resumed.requirementSummary.blocked, 1);
  assert.equal(resumed.requirementSummary.fail, 1);
  assert.equal(requests.filter(request => request === 'GET /mismatch').length, 1);
  assert.equal(requests.filter(request => request === 'POST /fixture').length, 1);
  assert.equal(requests.filter(request => request === 'DELETE /fixture').length, 1);
  assert.equal(fixtures.size, 0);
  const newer = await readJson(journalPath);
  assert.equal(newer.executionHistory.at(-1).reason, 'retry_blocked');
  assert.equal(newer.executionHistory.at(-1).results[blocked[0]].status, '阻断');
  assert.notEqual(newer.executionResourceBindings.platform, current.executionResourceBindings.platform);
  assert.deepEqual(newer.results[passed], current.results[passed]);
  assert.equal(newer.sourceAttempts[blocked[0] + '@1'].repositories[0].worktree_commit, oldHead);
  assert.notEqual(newer.sourceAttempts[blocked[0] + '@2'].repositories[0].worktree_commit, oldHead);
  assert.match(resumed.requirementReport.filename, /-重试1\.xlsx$/);
  assert.deepEqual(await readFile(savedWorkbook), oldWorkbook);
  assert.equal(newer.reportHistory[0].artifact.id, oldArtifact.id);
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
  const waitingCleanup = await readJson(journalFile);
  assert.equal(waitingCleanup.mutations[0].reconciled, true);
  assert.equal(Object.keys(waitingCleanup.results).length, 1, 'No later independent case runs before verified cleanup');
  assert.equal((await message('cleanup-and-resume', '继续测试')).jobId, jobId);
  const completed = await run();
  assert.equal(completed.outcome, 'ready', completed.finalMessage);
  assert.match(completed.finalMessage, /已核验恢复/);
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
