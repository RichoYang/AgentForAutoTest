import { chromium } from 'playwright';
import mysql from 'mysql2/promise';
import path from 'node:path';
import { requirementResources } from './requirement-execution.js';
import { requirementFeishu, fileToken, readCaseTemplate, RequirementWait } from './requirement-feishu.js';
import { privateDirectory, regressionReferences, loadSkill, generatorReferences, readJson, writeJson } from './requirement-files.js';
import { runReportBuilder } from './requirement-report.js';
import { generateValidatedCases, validateCases } from './requirement-generation.js';
import { publishCases } from './requirement-publication.js';
import { createRequirementAdapter } from './requirement-adapter.js';

export async function probeRequirementRuntime(project, dataDir, options = {}) {
  const settings = project.requirementTest;
  const folder = await privateDirectory(dataDir);
  const client = requirementFeishu(settings.document, folder);
  const resources = await requirementResources(settings.environment);
  const output = {};
  if (options.executionOnly && settings.execution) {
    return createRequirementAdapter(settings.execution, { workDir: folder }).probe({
      useRead: (key, run) => resources.use(key, 'read', run), checkOutput: resources.checkOutput,
    });
  }
  const check = async (name, run) => {
    try { output[name] = { ok: true, ...await run() }; }
    catch (error) { output[name] = { ok: false, code: error.code ?? error.name ?? 'failed',
      ...(error instanceof RequirementWait ? { reason: error.message } : {}) }; }
  };
  let source;
  let template;
  await check('document', async () => {
    await client.verify();
    source = await client.readRequirement(options.documentUrl);
    return { revision: source.revision, embeddedSheets: source.embedded.length, contentRead: Boolean(source.xml) };
  });
  await check('template', async () => {
    const token = fileToken(settings.templateUrl, settings.document.domain, 'sheets');
    template = await readCaseTemplate(client, token);
    const root = await client.listFolder(fileToken(settings.projectFolderUrl, settings.document.domain, 'drive/folder'));
    return { tabs: template.tabs.length, columns: template.headers.filter(Boolean).length, releaseFolders: root.filter(file => file.type === 'folder').length };
  });
  await Promise.all(resources.names.map(key => check(key, () => resources.use(key, 'read', async resource => {
    if (resource.resource_type === 'mysql') {
      const db = await mysql.createConnection({
        host: resource.host, port: Number(resource.port) || 3306, user: resource.username, password: resource.password,
        ...(resource.database_name ? { database: resource.database_name } : {}), connectTimeout: 8000,
      });
      try {
        const [rows] = await db.query({ sql: 'SELECT 1 AS ready', timeout: 8000 });
        if (rows[0]?.ready !== 1) throw new Error('database_probe');
        return { operation: 'SELECT 1' };
      } finally { await db.end(); }
    }
    if (resource.resource_type === 'web_platform' || resource.resource_type === 'xxl_job') {
      const url = new URL(resource.base_url);
      const response = await fetch(url, { redirect: 'manual', signal: AbortSignal.timeout(12000) });
      const code = response.status;
      await response.body?.cancel();
      if (code < 200 || code >= 400) throw new Error('http_status_' + code);
      if (resource.resource_type === 'xxl_job') return { operation: 'GET', status: code };
      const browser = await chromium.launch({ headless: true });
      try {
        const context = await browser.newContext();
        const origin = url.origin;
        const pathSuffix = settings.environment.platform === 'Ltx' ? '/ltx-authcomponent/web/auth/login' : '/sys/api/sysLogin/login';
        const isLogin = request => {
          const target = new URL(request.url());
          return target.origin === origin && target.pathname.endsWith(pathSuffix) && request.method() === 'POST';
        };
        let allowLogin = false;
        await context.route('**/*', async route => {
          const target = new URL(route.request().url());
          if (allowLogin && isLogin(route.request())) {
            allowLogin = false;
            return route.continue();
          }
          if (target.origin !== origin || route.request().method() !== 'GET') return route.abort();
          return route.continue();
        });
        const page = await context.newPage();
        const navigation = await page.goto(url.href, { waitUntil: 'domcontentloaded', timeout: 15000 });
        if (!navigation || navigation.status() >= 400 || new URL(page.url()).origin !== origin) throw new Error('browser_navigation');
        if (options.login === true) {
          const password = page.locator('input[type=password]');
          await password.waitFor({ timeout: 15000 });
          if (new URL(page.url()).origin !== origin || !resource.account || !resource.password) throw new Error('login_scope');
          await page.getByPlaceholder('请输入用户名', { exact: true }).fill(resource.account);
          await password.fill(resource.password);
          allowLogin = true;
          const [login] = await Promise.all([
            page.waitForResponse(response => isLogin(response.request()), { timeout: 12000 }),
            page.getByRole('button', { name: /^登\s*录$/ }).click(),
          ]);
          const payload = await login.json().catch(() => ({}));
          const data = payload.RESPONSE?.RETURN_DATA ?? payload.data ?? payload.result ?? {};
          const token = settings.environment.platform === 'Ltx' ? data.token ?? data.accessToken : data.token?.token;
          return { operation: 'Chromium login', status: login.status(), loginVerified: Boolean(login.ok() && token),
            passwordChangeRequired: Boolean(data.forceChangePassword || data.checkPasswordRule) };
        }
        return { operation: 'GET + Chromium navigation', status: code, loginVerified: false,
          passwordField: await page.locator('input[type=password]').count() };
      } finally { await browser.close(); }
    }
    if (resource.resource_type === 'rabbitmq') {
      const url = new URL(resource.management_url);
      url.pathname = url.pathname.replace(/\/$/, '') + '/api/overview';
      const response = await fetch(url, { redirect: 'manual', signal: AbortSignal.timeout(12000),
        headers: { authorization: 'Basic ' + Buffer.from(resource.username + ':' + resource.password).toString('base64') } });
      await response.body?.cancel();
      if (!response.ok) throw new Error('rabbitmq_http_' + response.status);
      return { operation: 'GET management overview', status: response.status };
    }
    return { ok: false, code: 'runtime_adapter_missing' };
  }))));
  if (options.sampleInput && options.sampleEvidenceDirectory) {
    await check('report', async () => {
      const regression = await loadSkill(settings.skills.regression, 'run-full-requirement-regression', regressionReferences);
      const report = await runReportBuilder(regression, options.sampleInput, folder, options.sampleEvidenceDirectory, new Date().toISOString());
      return { output: report.output, sheetCount: report.sheetCount, summary: report.summary, sha256: report.sha256 };
    });
  }
  if (options.generate === true && source && template) {
    await check('generation', async () => {
      const skill = await loadSkill(settings.skills.generator, 'lark-testcase-by-prd-order-generator', generatorReferences);
      const cases = path.join(folder, 'read-only-generation.json');
      const { draft, index } = await generateValidatedCases({ source, template: { headers: template.headers, tabs: template.tabs },
        skill, expectedProject: settings.projectName, otherProjects: settings.otherProjects, cwd: folder }, settings, cases);
      return { projectMatch: draft.projectMatch, cases: index.length, requirements: draft.requirements.length };
    });
  }
  if (options.publishFixture === true && source && template) {
    await check('publication', async () => {
      const skill = await loadSkill(settings.skills.generator, 'lark-testcase-by-prd-order-generator', generatorReferences);
      const title = 'AgentOS联调样例需求2026年11月版本';
      const fixture = { ...source, title, xml: '<h2 id="fixture">用例发布联调</h2>', id: 'AgentOSPublicationFixture' };
      const cells = { 系统: 'AgentOS 联调', 页面: '飞书测试场景', 用例类型: 'S1--主流程',
        前置条件: '1. 使用本轮联调样例需求，项目版本目录已存在。',
        模块: '用例发布联调', 测试场景: '核对样例用例发布与回读',
        操作步骤: '1. 读取本轮用例文件的测试场景页。',
        预期结果: '1. 测试场景页包含本轮唯一的联调用例，表头与模板一致。' };
      const manifest = { source: { title, url: source.url, revision: source.revision }, module_order: [cells.模块],
        headers: template.headers, required_texts: [], rows: [template.headers.map(header => cells[header] ?? '')] };
      const draft = { manifest, requirements: [{ id: 'fixture', anchor: 'fixture', rule: '回读本轮样例用例。' }], caseRequirements: [['fixture']] };
      const cases = path.join(folder, 'publication-fixture.json');
      await writeJson(cases, manifest);
      await validateCases(draft, fixture, template, skill, settings, cases);
      const file = path.join(folder, 'publication-fixture-receipt.json');
      const journal = await readJson(file) ?? { startedAt: new Date().toISOString() };
      const publish = () => publishCases({ client, settings, source: fixture, template, manifest, journal, save: () => writeJson(file, journal) });
      const first = await publish();
      const second = await publish();
      return { url: first.url, readback: second.verified, sameFile: first.fileToken === second.fileToken, caseCount: manifest.rows.length };
    });
  }
  return output;
}
