// Native acceptance. Only transport/source fixtures are supplied: generation,
// investigation, plan, semantic review, tool calls and report QA use real models.
import { mkdir, readFile, writeFile, readdir, cp, lstat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import mysql from 'mysql2/promise';
import { createChainService } from '../test-support/requirement-chain-service.mjs';
import { createAccessService } from '../test-support/requirement-access-service.mjs';
import { createPublicationService } from '../test-support/requirement-publication-service.mjs';
import { createCouponService } from '../test-support/requirement-coupon-service.mjs';
import { createArchiveService } from '../test-support/requirement-archive-service.mjs';
import { runRequirementTest } from '../src/runner/requirement-test.js';
import { digest } from '../src/runner/requirement-feishu.js';
import { generatorReferences, regressionReferences, command, writeJson } from '../src/runner/requirement-files.js';

const root = path.resolve(process.argv[2]);
const mode = process.argv[3] ?? 'inventory';
const cleanupOnly = process.argv.includes('--cleanup');
const retry = process.argv.includes('--retry-unexecuted');
const reportOnly = process.argv.includes('--report-only');
const previous = cleanupOnly || retry || reportOnly ? JSON.parse(await readFile(path.join(root, 'acceptance-input.json'))) : null;
if ([cleanupOnly, retry, reportOnly].filter(Boolean).length > 1) throw new Error('Choose one recovery action');
if (reportOnly) {
  const journal = JSON.parse(await readFile(path.join(root, 'data/requirement-tests', previous.job.id, 'journal.json')));
  if (journal.mutations?.some(m => !m.cleanup?.verified) || !Object.values(journal.results ?? {}).length
    || Object.values(journal.results).some(r => !['通过', '失败', '不适用'].includes(r.status))) throw new Error('Report-only recovery requires completed cases and verified cleanup');
}
if (retry || reportOnly) {
  const archive = path.join(root, (reportOnly ? 'before-report-only-' : 'before-retry-') + Date.now()); await mkdir(archive);
  for (const name of ['data', 'reports', 'result.json', 'executor-source.json', 'report-source.json', 'report-only-result.json']) {
    const exists = await lstat(path.join(root, name)).catch(error => { if (error.code === 'ENOENT') return null; throw error; });
    if (exists) await cp(path.join(root, name), path.join(archive, name), { recursive: true });
  }
}
if (!['inventory', 'inventory-lost-receipt', 'approval', 'approval-wrong-page', 'access-heldout', 'publication-heldout', 'coupon-heldout', 'archive-heldout'].includes(mode)) throw new Error('Unknown isolated mode');
const port = Number(process.env.AGENTOS_TEST_MYSQL_PORT);
if (!Number.isInteger(port) || port <= 1024 || port === 3306) throw new Error('Dedicated loopback MySQL port required');
await mkdir(root, { recursive: true });
async function sourceHashes(directory, prefix = '') {
  const values = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const relative = prefix + entry.name;
    if (entry.isDirectory()) values.push(...await sourceHashes(path.join(directory, entry.name), relative + '/'));
    else values.push({ path: relative, sha256: createHash('sha256').update(await readFile(path.join(directory, entry.name))).digest('hex') });
  }
  return values.sort((a, b) => a.path.localeCompare(b.path));
}
const executorSource = { at: new Date().toISOString(), files: await sourceHashes(fileURLToPath(new URL('../src/', import.meta.url))),
  version: JSON.parse(await readFile(new URL('../package.json', import.meta.url))).version };
executorSource.sha256 = digest(executorSource.files);
await writeJson(path.join(root, reportOnly ? 'report-source.json' : cleanupOnly ? 'cleanup-executor-source.json' : retry ? 'retry-executor-source.json' : 'executor-source.json'), executorSource);
const database = previous?.database ?? 'aos_chain_' + Date.now();
const connection = await mysql.createConnection({ host: '127.0.0.1', port, user: 'root', password: '',
  supportBigNumbers: true, bigNumberStrings: true, dateStrings: true, flags: ['-CLIENT_QUERY_ATTRIBUTES'] });
const [databases] = await connection.execute('SELECT SCHEMA_NAME FROM information_schema.SCHEMATA WHERE SCHEMA_NAME=?', [database]);
if ((retry || reportOnly) && databases.length) throw new Error('Fixture still exists; reconcile cleanup before re-provisioning');
if (!previous || retry || reportOnly) await connection.query('CREATE DATABASE ' + database);
const serviceFactory = mode === 'archive-heldout' ? createArchiveService : mode === 'coupon-heldout' ? createCouponService : mode === 'publication-heldout' ? createPublicationService : mode === 'access-heldout' ? createAccessService : createChainService;
const service = await serviceFactory(connection, database, mode, { initialize: !previous || retry || reportOnly, port: previous ? Number(new URL(previous.serviceUrl).port) : 0 });
const repo = path.join(root, 'source'); await mkdir(repo, { recursive: true });
if (!previous) {
const serviceFile = mode === 'archive-heldout' ? 'archive' : mode === 'coupon-heldout' ? 'coupon' : mode === 'publication-heldout' ? 'publication' : mode === 'access-heldout' ? 'access' : 'chain';
await writeFile(path.join(repo, 'service.mjs'), await readFile(new URL('../test-support/requirement-' + serviceFile + '-service.mjs', import.meta.url)));
await writeFile(path.join(repo, 'AGENTS.md'), '# Isolated acceptance service\nOnly the bound loopback resources belong to this run. Read service.mjs for actual routes, schemas, lifecycle and reversible restoration. Do not modify source. All sample business keys and reservation codes must use runPrefix.\n');
await writeFile(path.join(repo, 'runtime.json'), JSON.stringify({ mode, database, mysqlResource: 'mysql', apiResource: 'platform' }));
await command('git', ['init', '-b', 'main', repo]);
await command('git', ['-C', repo, 'add', '.']);
await command('git', ['-C', repo, '-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-m', 'Independent acceptance service']);
}
const inventory = mode.startsWith('inventory');
const title = mode === 'archive-heldout' ? '条目归档搜索与恢复留出链路' : mode === 'coupon-heldout' ? '兑换券幂等核销留出链路' : mode === 'publication-heldout' ? '内容预览发布与回退留出链路' : mode === 'access-heldout' ? '文档访问撤权留出链路' : inventory ? '库存预留隔离链路' : '订单审批隔离链路';
const requirement = mode === 'archive-heldout'
  ? '在一个完整用例内验收条目软归档、搜索可见性及取消归档链。准备本轮专属A（workspace=ALPHA，title=Guide，content=Memo）、B（workspace=BETA，title=Other，content=Keep），均archived=0、revision=1、note=null，key使用runPrefix。先归档A：直接API仍返回A、ALPHA、Guide、Memo、archived=1、revision=2；ALPHA搜索API完整entries为空；加载完成的实际搜索页面workspace为ALPHA、NO_RESULTS提示可见且keys和titles均为空。再取消归档A：直接API为archived=0、revision=3且标题和正文不变；ALPHA搜索API恰好只有A且title=Guide；重新加载的实际页面workspace为ALPHA、keys为A、titles为Guide且NO_RESULTS提示不可见。BETA的entries全字段集合须与全部准备完成后、场景前完整基线相同。预期源于本需求，不根据实测改变。模型自主调查源码和入口、准备、核验测量/基线、实际执行、分渠道独立判定，再逆序恢复原状态并删除本轮A/B，回查entries零残留，完成标准报告。只以busy消失证明页面就绪，不等待期望内容。'
  : mode === 'coupon-heldout'
  ? '验收一条兑换券幂等核销链。前置：本轮专属兑换券A归用户ALICE，B归用户BOB，均state=ISSUED、remaining_uses=1、note=null，无核销回执。券业务键和请求键均使用runPrefix。场景：用唯一请求键R为ALICE核销A，再真正发起第二次相同HTTP核销请求（同R、同A、同ALICE，不能只在客户端省略第二次调用）。独立预期：两次API回读A均为REDEEMED、remaining_uses=0且唯一回执request_key=R；第二次之后A的完整核销回执集合仍只有一条且request_key=R；加载完成后的页面显示A、ALICE、REDEEMED、剩余0及R。B的coupons全字段集合及B对应receipts空集合与准备完成后、场景前的完整基线不变。全程从源码发现入口，通过实际工具准备、验证基线、执行和独立比较；API和页面各自取证，保留真实日期/null，不用目标业务值等待。结束按台账逆序恢复并删除本轮A/B，回查coupons和receipts本轮零残留并生成标准报告。'
  : mode === 'publication-heldout'
  ? '本需求验收一条内容预览、发布和回退完整业务链。前置准备本轮专属文档D，标题Guide；已有两个不可变版本V1正文First、V2正文Second，当前公开版本V1，V2仍为草稿；D/V1/V2的业务键均用runPrefix。业务预期：在发布前，预览V2的API及加载完成页面分别显示Second，公开入口的API及实际页面分别仍显示First；发布V2后，同一公开入口的API和页面分别显示Second且版本为V2；再回退发布指针到V1，公开API和页面分别显示First且版本为V1。整个发布与回退过程不得改写文档D的revisions完整记录集合，应与所有准备完成后、场景动作前的全字段基线相同。预期来自本需求，页面与API分别取证；页面加载标记消失才读取，不以目标正文出现作为等待条件。工程过程须自主调查源码、发现入口、实际准备、验证基线、执行与独立判定，再按台账逆序恢复并删除本轮D及两个版本，回查documents和revisions本轮零残留，写标准报告；这些过程用实际记录证明。'
  : mode === 'access-heldout'
  ? '验收一条完整文档访问撤权链。前置：准备本轮专属文档A（tenant=ALPHA，title=Confidential）和B（tenant=BETA，title=Public）；给本轮用户U建立A的唯一授权G，active=1、expires_at=null；B无授权。所有业务键及U均用runPrefix。先通过API核实U对ALPHA文档A的访问allowed=true、HTTP200，并在加载完成的实际页面核实GRANTED和Confidential。然后撤销G（active改为0）。撤权后的独立预期：同一U访问同一A的API返回HTTP403、allowed=false、reason=DENIED；页面加载标记消失后显示DENIED且标题为空，页面与API分别取证。B的documents全字段集合及BETA的grants空集合与全部准备完成后、撤权前的完整快照一致。工程要求：由源码发现入口并使用真实工具；保留大整数和null原值；预期不得随实测变化；恢复按台账逆序还原G再删除本轮授权及文档，回查两表本轮零残留并写标准报告。过程要求用真实台账/取证证明，不编造成业务boolean。'
  : inventory
  ? '本需求验收一条库存预留业务链。前置：本轮专属库存A的tenant为ALPHA、period为2026-11、quantity为10；B的tenant为BETA、period为2026-12、quantity为17；均reserved=0、note=null，业务键用runPrefix。业务动作：为A创建唯一预留R，数量3。业务预期：①API回读A的reserved=3、available=7，A的完整预留集合只有R一条，quantity=3且tenant=ALPHA；②页面按A→B→A切换，业务加载完成后分别显示对应business_key、tenant、period，可用量为7、17、7；③B的stock全字段集合与BETA的reservations空集合均与准备完成后、动作前的完整快照一致。测试工程约束：独立预期不得随实测改变；从源码发现入口并使用实际工具；保留大整数、null及日期原始值，不额外把连接器实现声明编成业务数值断言；若回执丢失，按台账先核实实际状态，已生效不重发。预检是取值方法样本，场景后须新取证。恢复约束：按实际变更台账逆序恢复R并删除本轮A/B，回查四张表本轮零残留，将真实恢复结果写入标准报告的清理部分。准备、取证与恢复规则属于执行过程，不编造成业务布尔字段或重复业务检查。'
  : '本需求验收一条订单审批业务链。前置：本轮专属订单A的tenant为ALPHA、amount为123.4500元；B的tenant为BETA、amount为20.0000元；均state=DRAFT、revision=1、approval_note=null且无审批记录，业务键用runPrefix。业务动作：提交A，再批准A并等待异步业务处理完成。业务预期：①提交回读A的state=PENDING；②审批完成后API回读A的state=APPROVED、revision=4、approval_note=reviewed、amount=123.4500，完整审批集合恰好一条且decision=APPROVED、tenant=ALPHA；③业务加载完成后页面显示A的business_key、ALPHA、APPROVED和123.4500元，页面与API各自取证；④B的orders全字段集合及BETA的approvals空集合均与准备完成后、动作前的完整快照一致。测试工程约束：源码调查、入口发现、实际工具、独立预期、基线和实际证据均须完成；保留真实大整数、空值和日期，不把连接器实现声明编成业务数值断言；异步就绪须证明已结束PROCESSING或加载标记消失，不等待目标数值掩盖错误。恢复约束：台账逆序恢复订单状态和审批记录，删除本轮A/B，回查四表本轮零残留并记录标准报告清理部分。准备、取证与恢复规则属于执行过程，不编造成业务布尔字段或重复业务检查。';
const sourceBase = { id: 'IsolatedRequirement', url: 'https://fixture.invalid/docx/IsolatedRequirement', revision: 1,
  title, embedded: [], xml: `<h1 id="module">${title}</h1><p id="rules">${requirement}</p>` };
const headers = ['系统', '页面', '用例类型', '前置条件', '模块', '测试场景', '操作步骤', '预期结果', '测试数据', '测试结果', '备注说明', '测试截图', '用户问题', '对接BP', '测试用户', '测试截至日期'];
const copies = new Map(), folders = [];
if (retry || reportOnly) {
  const saved = JSON.parse(await readFile(path.join(root, 'data', 'requirement-tests', previous.job.id, 'cases.json')));
  const { publication } = JSON.parse(await readFile(path.join(root, 'data', 'requirement-tests', previous.job.id, 'journal.json')));
  folders.push({ token: publication.folderToken, type: 'folder', name: publication.folderName });
  copies.set('Published', { token: 'Published', type: 'sheet', name: publication.title, url: publication.url, matrix: [saved.headers, ...saved.rows], revision: 1 });
}
const client = { verify: async () => {}, readRequirement: async () => ({ ...sourceBase, hash: digest(sourceBase) }),
  listFolder: async token => token === 'Root' ? folders : [...copies.values()],
  createFolder: async (_parent, name) => { folders.push({ token: 'Month', type: 'folder', name }); return 'Month'; },
  workbook: async token => ({ sheets: [{ sheet_id: 'cases', title: '测试场景', grid_properties: { row_count: copies.get(token)?.matrix.length ?? 1, column_count: 16 } }], revision: 1 }),
  readGrid: async token => copies.get(token)?.matrix ?? [headers],
  copyWorkbook: async (_template, _folder, name) => { const file = { token: 'Published', type: 'sheet', name, url: 'https://fixture.invalid/sheets/Published', matrix: [headers], revision: 1 }; copies.set(file.token, file); return file; },
  writeWorkbook: async (token, _sheet, values) => { copies.get(token).matrix = values; } };
const iniPath = path.join(root, 'resources.ini');
await writeFile(iniPath, `[Demo.Uat.Platform]\nstatus=configured\nai_access=allowed\nai_operation_mode=full_crud\nenvironment=Uat\nresource_type=website\nbase_url=${service.url}\n\n[Demo.Uat.Mysql]\nstatus=configured\nai_access=allowed\nai_operation_mode=full_crud\nenvironment=Uat\nresource_type=mysql\nhost=127.0.0.1\nport=${port}\nusername=root\npassword=\ndatabase_name=${database}\n`);
async function skill(name, refs) {
  const folder = path.join(process.env.AGENTOS_REQUIREMENT_SKILLS_ROOT, name), hash = createHash('sha256');
  for (const file of ['SKILL.md', ...refs]) hash.update(file).update('\0').update(await readFile(path.join(folder, file))).update('\0');
  return { path: folder, sha256: hash.digest('hex') };
}
const validationCli = path.join(root, 'offline.cmd'); await writeFile(validationCli, '@exit /b 94\r\n');
const settings = { bot: { profile: 'local-qa' }, allowedChatIds: ['oc_local'], requesterOpenIds: ['ou_local'], document: { domain: 'fixture.invalid' },
  projectName: '隔离验收系统', templateUrl: 'https://fixture.invalid/sheets/Template', projectFolderUrl: 'https://fixture.invalid/drive/folder/Root',
  timeZone: 'Asia/Shanghai', reportDirectory: path.join(root, 'reports'), lockDirectory: path.join(root, 'locks'),
  validationCli, powerShell: process.env.AGENTOS_REQUIREMENT_POWERSHELL ?? 'pwsh',
  skills: { generator: await skill('lark-testcase-by-prd-order-generator', generatorReferences), regression: await skill('run-full-requirement-regression', regressionReferences) },
  environment: { name: 'UAT', platform: 'Demo', iniPath, lockKey: 'local', resources: {
    platform: { section: 'Demo.Uat.Platform', scope: 'full_crud' }, mysql: { section: 'Demo.Uat.Mysql', scope: 'full_crud' } } },
  execution: { mode: 'agent', knowledgeFile: path.join(root, 'knowledge.json') } };
const job = previous?.job ?? { id: 'JOB-isolated-chain-' + Date.now(), projectId: 'demo', agentProfile: 'local-qa', chatId: 'oc_local', senderId: 'ou_local', requirement: { url: sourceBase.url } };
if (cleanupOnly) job.requirement = { ...job.requirement, cleanupOnly: true };
if (retry) job.requirement = { ...job.requirement, cleanupOnly: false, retryRequest: 'isolated-unexecuted-' + Date.now() };
const config = { projects: { demo: { displayName: '隔离验收系统', repoPath: repo, baseBranch: 'main', requirementTest: settings } }, dataDir: path.join(root, 'data') };
if (!previous) await writeJson(path.join(root, 'acceptance-input.json'), { job, mode, database, source: sourceBase, serviceUrl: service.url,
  model: 'configured runtime', fixedExecutionPlan: false, sourceTransport: 'isolated Feishu simulation', humanInterventions: [] });
try {
  const result = await runRequirementTest(job, config, async event => console.log(JSON.stringify(event)), { client });
  const remaining = await service.remaining();
  await writeJson(path.join(root, reportOnly ? 'report-only-result.json' : cleanupOnly ? 'cleanup-result.json' : retry ? 'retry-result.json' : 'result.json'), { result, remaining, requests: service.requests });
  console.log(JSON.stringify({ result, remaining: Object.fromEntries(Object.entries(remaining).map(([key, rows]) => [key, rows.length])) }));
  const summary = result.requirementSummary;
  const correct = cleanupOnly || summary && !summary.blocked && !summary.notExecuted && (mode === 'approval-wrong-page' ? summary.fail > 0 : summary.pass === summary.total);
  if (result.outcome !== 'ready' || !correct || Object.values(remaining).some(rows => rows.length)) process.exitCode = 1;
} finally {
  await service.close();
  const remaining = await service.remaining();
  if (!Object.values(remaining).some(rows => rows.length)) await connection.query('DROP DATABASE ' + database);
  else await writeJson(path.join(root, 'retained-database.json'), { database, reason: 'Runner cleanup incomplete; preserve for normal recovery, do not erase evidence' });
  await connection.end();
}
