import { test } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { JsonStore } from '../src/shared/store.js';
import { handleRequirementMessage, validateRequirementRoutes } from '../src/control-plane/requirement-testing.js';
import { publishCases, versionNames } from '../src/runner/requirement-publication.js';
import { requirementResources } from '../src/runner/requirement-execution.js';
import { runRequirementTest } from '../src/runner/requirement-test.js';
import { createControlPlane } from '../src/control-plane/server.js';
import { larkEventSourcePlans } from '../src/control-plane/lark-event-source.js';
import { requirementOptions, resolveRequirementOptions } from '../src/shared/requirement-options.js';
import { requirementAnchors, validateCases } from '../src/runner/requirement-generation.js';

const domain = 'example.feishu.cn';

test('one specialist can bind a specific topic and document to a separate requirement project', async t => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'agentos-requirement-topic-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const bot = { profile: 'qa', appId: 'cli_qa', openId: 'ou_qa' };
  const document = { domain, profile: 'doc-user', appId: 'cli_docs', openId: 'ou_document' };
  const base = { bot, document, allowedChatIds: ['oc_group'], requesterOpenIds: ['ou_owner'] };
  const documentUrl = 'https://' + domain + '/docx/Isolated';
  const isolated = { ...base, topicBindings: [{ chatId: 'oc_group', rootId: 'om_isolated', documentUrl }] };
  const projects = { chatProjectMap: { oc_group: 'ordinary' }, topicChatIds: ['oc_group'],
    projects: { ordinary: { requirementTest: base }, isolated: { requirementTest: isolated } } };
  const agents = { agents: { qa: bot } };
  const store = new JsonStore(path.join(directory, 'state.json'));
  const routes = validateRequirementRoutes(projects, agents);
  assert.equal(larkEventSourcePlans({ requirementRoutes: routes }, agents.agents).length, 2);
  const context = { projects, requirementRoutes: routes, store, feishu: { reply: async () => {} } };
  const event = { agent_profile: bot.profile, receiving_app_id: bot.appId, receiving_bot_id: bot.openId,
    chat_type: 'group', chat_id: 'oc_group', sender_id: 'ou_owner', mentions: [{ id: bot.openId }],
    root_id: 'om_isolated', message_id: 'om_request', event_id: 'evt_fixture', content: documentUrl };
  const result = await handleRequirementMessage(context, event);
  const job = await store.getJob(result.jobId);
  assert.equal(job.projectId, 'isolated');
  assert.match(job.requirement.topicBinding, /^[a-f0-9]{64}$/);
  assert.equal(job.requirement.eventId, 'evt_fixture');
  const config = { projects: projects.projects, dataDir: directory };
  await assert.rejects(runRequirementTest({ ...job, projectId: 'ordinary' }, config, async () => {}), /项目绑定不符/);
  await assert.rejects(runRequirementTest({ ...job, requirement: { ...job.requirement, root: 'om_other' } }, config, async () => {}), /项目绑定不符/);
  const changed = { projects: { ...projects.projects, isolated: { ...projects.projects.isolated, repoPath: directory } }, dataDir: directory };
  await assert.rejects(runRequirementTest(job, changed, async () => {}), /项目绑定不符/);
  assert.deepEqual(await handleRequirementMessage(context, event), { duplicate: true });
  await handleRequirementMessage(context, { ...event, message_id: 'om_repeat' });
  assert.equal((await store.read()).jobs.length, 1);
  const denied = await handleRequirementMessage(context, { ...event, root_id: 'om_other', message_id: 'om_wrong_topic' });
  assert.equal(denied.reason, 'requirement_topic_scope');
  assert.equal((await handleRequirementMessage(context, { ...event, content: 'https://' + domain + '/docx/Other', message_id: 'om_wrong_doc' })).reason, 'requirement_topic_scope');
  const ordinary = await handleRequirementMessage(context, { ...event, root_id: 'om_other', message_id: 'om_ordinary', content: 'https://' + domain + '/docx/Ordinary' });
  assert.equal((await store.getJob(ordinary.jobId)).projectId, 'ordinary');
  assert.throws(() => validateRequirementRoutes({ ...projects, projects: { ...projects.projects, other: projects.projects.isolated } }, agents), /Duplicate requirement topic/);
});

test('local startup exposes the verified routes used to stamp the requirement event', async t => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), 'agentos-requirement-startup-'));
  const bot = { profile: 'test-qa', appId: 'cli_test', openId: 'ou_test' };
  const project = { requirementTest: { bot, allowedChatIds: ['oc_group'], requesterOpenIds: ['ou_owner'],
    document: { domain, profile: 'doc-user', appId: 'cli_docs', openId: 'ou_document' } } };
  const projects = { projects: { demo: project }, chatProjectMap: { oc_group: 'demo' }, topicChatIds: ['oc_group'] };
  const agents = { agents: { developer: bot } };
  const app = await createControlPlane({ dataDir, storeFile: path.join(dataDir, 'state.json'),
    projects, agents, feishu: { transport: 'lark-cli' }, feishuClient: {} });
  t.after(async () => {
    await app.conversations.stop();
    await rm(dataDir, { recursive: true, force: true });
  });
  const [messages] = larkEventSourcePlans({ requirementRoutes: app.requirementRoutes }, agents.agents);
  assert.deepEqual(messages.requirementBot, bot);
});

test('message options resolve to approved test aliases and exact project destinations', () => {
  const reportDirectory = path.resolve('report');
  const folder = 'https://' + domain + '/drive/folder/Approved';
  const settings = { document: { domain }, environment: { name: 'SIT', aliases: ['UAT'] },
    allowedProjectFolderUrls: [folder], allowedReportDirectories: [reportDirectory] };
  const parsed = requirementOptions('请在uat环境进行需求测试\n用例存放：' + folder + '\n输出路径：' + reportDirectory);
  assert.deepEqual(parsed, { projectFolderUrl: folder, reportDirectory, requestedEnvironment: 'UAT' });
  const resolved = resolveRequirementOptions(settings, parsed);
  assert.equal(resolved.environment.name, 'SIT');
  assert.equal(resolved.explicitProjectFolder, true);
  assert.equal(resolved.reportDirectory, reportDirectory);
  assert.equal(resolveRequirementOptions(settings, requirementOptions('在测试环境执行')).requestedEnvironment, '测试环境');
  assert.throws(() => resolveRequirementOptions(settings, requirementOptions('在生产环境执行')), /未绑定/);
  assert.throws(() => resolveRequirementOptions(settings, { projectFolderUrl: folder + 'Other' }), /未登记/);
  assert.throws(() => resolveRequirementOptions(settings, { reportDirectory: reportDirectory + '-other' }), /未登记/);
});

test('anchor checks use exact block IDs and report invented anchors before publication', async () => {
  const source = { xml: '<p data-id="not-an-id" id=\'paragraph\'>内容</p>',
    supplements: [{ name: 'supplement.md', sections: [{ anchor: 'local-section', title: '规则' }] }],
    developerFeedback: [{ name: 'handoff.md', body: '# 反馈' }] };
  assert.deepEqual(requirementAnchors(source).map(anchor => anchor.id), ['paragraph', 'local-section']);
  const draft = { manifest: { headers: ['模块'], rows: [['示例']] },
    requirements: [{ id: 'rule', anchor: 'not-an-id', rule: '规则' }], caseRequirements: [['rule']] };
  await assert.rejects(validateCases(draft, source, { headers: ['模块'] }), error =>
    error.code === 'case_quality' && JSON.parse(error.validationDetails).anchorRecognized === false);
});

test('two specialists in one group isolate trusted app, project, duplicate events and followups', async t => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'agentos-requirement-route-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const card = [];
  const create = (projectId, profile, botId, appId) => {
    const project = { displayName: projectId, requirementTest: { bot: { profile, appId, openId: botId },
      allowedChatIds: ['oc_group'], requesterOpenIds: ['ou_requester'],
      document: { domain, profile: 'doc-user', appId: 'cli_docs', openId: 'ou_document' } } };
    const projects = { projects: { [projectId]: project }, chatProjectMap: { oc_group: projectId }, topicChatIds: ['oc_group'] };
    return { projects, requirementRoutes: validateRequirementRoutes(projects, { agents: { qa: { profile, openId: botId } } }),
      store: new JsonStore(path.join(dir, projectId + '.json')), feishu: {
        reply: async (id, text, options) => card.push({ id, text, options }),
      } };
  };
  const ltx = create('ltx', 'ltx-qa', 'ou_ltx', 'cli_ltx');
  const tpm = create('tpm', 'tpm-qa', 'ou_tpm', 'cli_tpm');
  const input = (bot, source, rest = {}) => ({
    agent_profile: bot + '-qa', receiving_app_id: 'cli_' + bot, receiving_bot_id: 'ou_' + bot,
    sender_id: 'ou_requester', chat_id: 'oc_group', chat_type: 'group', message_id: 'om_' + source,
    thread_id: 'omt_' + source, mentions: [{ id: { open_id: 'ou_' + bot } }],
    content: 'https://' + domain + '/docx/Doc' + bot + ' 切换项目', ...rest,
  });
  const a = await handleRequirementMessage(ltx, input('ltx', 'a'));
  const b = await handleRequirementMessage(tpm, input('tpm', 'b'));
  assert.equal((await ltx.store.getJob(a.jobId)).projectId, 'ltx');
  assert.equal((await tpm.store.getJob(b.jobId)).projectId, 'tpm');
  assert.deepEqual(await handleRequirementMessage(ltx, input('ltx', 'a')), { duplicate: true });
  assert.equal((await handleRequirementMessage(ltx, input('ltx', 'wrong', { receiving_app_id: 'cli_tpm' }))).ignored, true);
  assert.equal((await handleRequirementMessage(ltx, input('ltx', 'wrongChat', { chat_id: 'oc_other' }))).ignored, true);
  assert.equal((await handleRequirementMessage(ltx, input('ltx', 'both', { mentions: [{ id: 'ou_ltx' }, { id: 'ou_tpm' }] }))).replied, true);
  assert.equal(card[0].options.replyInThread, true);
  await ltx.store.transact(state => {
    const job = state.jobs[0];
    job.status = 'awaiting_clarification';
    job.result = { requirementWait: 'project_confirmation' };
  });
  await handleRequirementMessage(ltx, input('ltx', 'resumeWrong', { thread_id: 'omt_a', content: '继续', mentions: [] }));
  assert.equal((await ltx.store.getJob(a.jobId)).status, 'awaiting_clarification');
  await handleRequirementMessage(ltx, input('ltx', 'resumeOther', { thread_id: 'omt_a', sender_id: 'ou_other', content: '确认项目', mentions: [] }));
  assert.equal((await ltx.store.getJob(a.jobId)).status, 'awaiting_clarification');
  const resumed = await handleRequirementMessage(ltx, input('ltx', 'resume', { thread_id: 'omt_a', content: '确认项目', mentions: [] }));
  assert.equal(resumed.jobId, a.jobId);
  const state = await ltx.store.read();
  assert.equal(state.jobs.length, 1);
  assert.equal(state.jobs[0].requirement.confirmedProject, true);
  assert.equal(state.questions[state.jobs[0].questionId].messageId, 'om_a');
  assert.equal(state.questions[state.jobs[0].questionId].replyInThread, true);
  const follow = (message, content) => handleRequirementMessage(ltx, input('ltx', message, { thread_id: 'omt_a', content, mentions: [] }));
  await follow('query', '当前进度怎么样');
  assert.match(card.at(-1).text, /等待执行/);
  await handleRequirementMessage(ltx, input('ltx', 'otherProjectStatus', { thread_id: 'omt_b', content: '当前进度怎么样' }));
  assert.match(card.at(-1).text, /本话题未找到可操作的需求测试任务/);
  assert.doesNotMatch(card.at(-1).text, new RegExp(b.jobId));
  await follow('unknown', '随便试试');
  assert.match(card.at(-1).text, /可回复/);
  const leased = await ltx.store.leaseNext('runner', ['requirement_test']);
  await follow('pause', '暂停测试');
  assert.equal((await ltx.store.getJob(a.jobId)).status, 'cancelling');
  await follow('tooEarly', '继续测试');
  assert.match(card.at(-1).text, /当前状态不允许/);
  await ltx.store.appendEvent(a.jobId, { type: 'cancelled', processesExited: true,
    runnerId: 'runner', leaseId: leased.lease.id });
  await follow('paused', '当前阻塞');
  assert.match(card.at(-1).text, /已暂停/);
  assert.equal((await follow('resumeAgain', '继续测试')).jobId, a.jobId);
  assert.deepEqual(await follow('resumeAgain', '继续测试'), { duplicate: true });
  await ltx.store.transact(state => { state.jobs[0].status = 'completed'; state.jobs[0].requirement.cleanupOnly = true; });
  await handleRequirementMessage(ltx, input('ltx', 'retryOther', { thread_id: 'omt_a', sender_id: 'ou_other', content: '重试失败', mentions: [] }));
  assert.equal((await ltx.store.getJob(a.jobId)).status, 'completed');
  assert.equal((await follow('retryFailed', '重试失败用例')).jobId, a.jobId);
  assert.deepEqual((await ltx.store.getJob(a.jobId)).requirement.retryStatuses, ['失败', '未执行']);
  assert.equal((await ltx.store.getJob(a.jobId)).requirement.cleanupOnly, undefined);
  assert.deepEqual(await follow('retryFailed', '重试失败用例'), { duplicate: true });
  await ltx.store.transact(state => { state.jobs[0].status = 'completed'; });
  await follow('retryMissing', '重试未执行');
  assert.deepEqual((await ltx.store.getJob(a.jobId)).requirement.retryStatuses, ['未执行']);
  assert.equal((await ltx.store.read()).jobs.length, 1);
});

test('copy/write restart uses one persisted file, verifies contents, and refuses competing edits', async () => {
  const settings = { timeZone: 'Asia/Shanghai', document: { domain }, projectFolderUrl: 'https://' + domain + '/drive/folder/Root',
    templateUrl: 'https://' + domain + '/sheets/Template' };
  const journal = { startedAt: '2026-10-31T17:00:00Z' };
  const source = { title: '示例需求20261101版本' };
  const manifest = { headers: ['模块'], rows: [['模块A']] };
  const template = { tabs: ['测试场景'], values: [['模块'], ['参考']] };
  let files = [];
  let matrix = template.values;
  let receipt;
  let copies = 0;
  const sheet = { sheet_id: 'test', title: '测试场景', grid_properties: { row_count: 2 } };
  const client = {
    listFolder: async token => token === 'Root' ? [{ type: 'folder', token: 'Version', name: '2026年11月版本' }] : files,
    workbook: async () => ({ sheets: [sheet], revision: 1 }),
    readGrid: async () => matrix,
    copyWorkbook: async (token, parent, name) => {
      copies++;
      files = [{ name, type: 'sheet', token: 'Copy', url: 'https://' + domain + '/sheets/Copy' }];
      return files[0];
    },
    writeWorkbook: async () => { matrix = [manifest.headers, ...manifest.rows]; throw new Error('lost write receipt'); },
  };
  const run = state => publishCases({ client, settings, source, template, manifest, journal: state,
    save: async () => { receipt = structuredClone(state); } });
  await assert.rejects(run(journal), /lost write receipt/);
  assert.equal(receipt.publication.fileToken, 'Copy');
  const confirmed = await run(receipt);
  assert.equal(confirmed.verified, true);
  assert.equal(copies, 1);
  matrix = [['模块'], ['其他编辑']];
  await assert.rejects(run(receipt), { code: 'publication_conflict' });
  assert.deepEqual(versionNames(source.title, journal.startedAt, settings.timeZone), {
    folderName: '2026年11月版本', title: '示例需求20261101版本测试用例',
  });
});

test('resource bindings never route into production or another project', async t => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'agentos-requirement-resource-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const iniPath = path.join(dir, 'config.ini');
  const resource = (section, environment) => '[' + section + ']\nstatus=configured\nai_access=allowed\nai_operation_mode=full_crud\nenvironment=' + environment + '\n';
  await writeFile(iniPath, resource('Ltx.Sit.DB', 'Sit') + resource('Ltx.Prd.DB', 'Prd') + resource('Tpm.Sit.DB', 'Sit'));
  const config = { name: 'SIT', platform: 'Ltx', iniPath, resources: { db: { section: 'Ltx.Sit.DB', scope: 'read' } } };
  const scoped = await requirementResources(config);
  assert.equal(await scoped.use('db', 'read', resource => resource.environment), 'Sit');
  await assert.rejects(scoped.use('db', 'delete', () => assert.fail('write must be fenced')), { code: 'environment_scope' });
  for (const section of ['Ltx.Prd.DB', 'Tpm.Sit.DB']) {
    await assert.rejects(requirementResources({ ...config, resources: { db: { section, scope: 'full_crud' } } }), { code: 'environment_config' });
  }
});

test('a lost mutation receipt is reconciled, a failed case is retained, and cleanup holds the resource fence', async t => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'agentos-requirement-execution-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const { executeCases } = await import('../src/runner/requirement-execution.js');
  const { hashFile } = await import('../src/shared/file-digest.js');
  const iniPath = path.join(dir, 'config.ini');
  await writeFile(iniPath, '[Ltx.Sit.Platform]\nstatus=configured\nai_access=allowed\nai_operation_mode=full_crud\nenvironment=Sit\n');
  const adapter = path.join(dir, 'adapter.mjs');
  await writeFile(adapter, [
    'let applyCount = 0; let cleanupCount = 0;',
    'const evidence = [{ path: "probe.txt", sanitized: true }];',
    'export const verifyDeployment = async () => ({ verified: true, fingerprint: "sit-baseline", evidence });',
    'export const prepare = async () => ({ prerequisites: [] });',
    'export const reconcile = async () => ({ status: "applied", receipt: { evidence } });',
    'export async function execute({item, invoke, runPrefix}) {',
    ' if (item.caseId === "CASE-one") await invoke({id:"write", target:"owned-data", beforeHash:"snapshot", cleanupAction:"delete owned record",',
    ' businessKey:runPrefix, resource:"platform", operation:"create"}, async () => {',
    '  applyCount++; if (applyCount !== 1) throw new Error("unexpected duplicate operation");',
    '  throw new Error("effect applied, receipt lost");',
    ' });',
    ' return { status:item.caseId==="CASE-one"?"失败":"通过", actual:"observed result", evidence,',
    ' ...(item.caseId==="CASE-one"?{issue:{expected_result:"expected result"}}:{}) };',
    '}',
    'export const cleanup = async () => ({ verified: ++cleanupCount > 1, evidence, pending: cleanupCount === 1 ? ["write"] : [] });',
  ].join('\n'));
  const settings = { lockDirectory: path.join(dir, 'locks'), adapter: { path: adapter, sha256: await hashFile(adapter) },
    environment: { name: 'SIT', platform: 'Ltx', iniPath, lockKey: 'site', resources: { platform: { section: 'Ltx.Sit.Platform', scope: 'full_crud' } } } };
  const journal = { publication: { url: 'https://' + domain + '/sheets/Fake' } };
  let saved;
  const run = (state, id = 'JOB-fake') => executeCases({
    job: { id, projectId: 'ltx', requirement: {} }, settings, journal: state, source: {},
    index: [{ caseId: 'CASE-one', row: 2 }, { caseId: 'CASE-two', row: 3 }],
    manifest: { headers: ['模块'], rows: [['A'], ['B']] },
    regression: { files: { 'references/execution-standard.md': 'spec' } },
    workDir: dir, reportDir: dir, save: async () => { saved = structuredClone(state); }, progress: async () => {},
  });
  await assert.rejects(run(journal), /receipt lost/);
  assert.equal(saved.mutations[0].phase, 'prepared');
  await assert.rejects(run(saved), { code: 'cleanup_pending' });
  assert.equal(saved.mutations[0].phase, 'applied');
  assert.equal(saved.results['CASE-one'].status, '失败');
  assert.equal(saved.results['CASE-two'].status, '通过');
  const preserved = saved;
  await assert.rejects(run({ publication: journal.publication }, 'JOB-other'), { code: 'environment_busy' });
  await run(preserved);
  assert.equal(saved.cleanup.verified, true);
});
