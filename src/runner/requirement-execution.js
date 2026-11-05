import { lstat, readFile, unlink } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { hashFile } from '../shared/file-digest.js';
import { RequirementWait, digest } from './requirement-feishu.js';
import { privateDirectory, readJson, writeJson } from './requirement-files.js';
import { createRequirementAdapter } from './requirement-adapter.js';
import { caseReleaseRequirement, matchesCaseRelease } from './requirement-release.js';

const writeOperations = ['create', 'update', 'delete', 'trigger'];
const credentialField = /password|token|secret|cookie|connection_string/i;

function iniResources(text) {
  const entries = new Map();
  let current;
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || /^[;#]/.test(line)) continue;
    if (line.startsWith('[') && line.endsWith(']')) {
      const name = line.slice(1, -1);
      if (entries.has(name)) throw new RequirementWait('environment_config', '测试资源 INI 含重复配置节。');
      current = Object.create(null);
      entries.set(name, current);
    } else if (current && line.includes('=')) {
      const index = line.indexOf('=');
      const name = line.slice(0, index).trim();
      if (Object.hasOwn(current, name)) throw new RequirementWait('environment_config', '测试资源 INI 含重复字段。');
      current[name] = line.slice(index + 1).trim();
    }
  }
  return entries;
}

export async function requirementResources(environment, { allowUnavailable = false } = {}) {
  const name = environment?.name;
  if (!/^(SIT|UAT)$/.test(name) || !/^[a-zA-Z0-9]+$/.test(environment.platform ?? '')
    || !path.isAbsolute(environment.iniPath) || !Object.keys(environment.resources ?? {}).length) {
    throw new RequirementWait('environment_config', '测试必须绑定有明确资源范围的 SIT 或 UAT 环境。');
  }
  const prefix = environment.platform.toLowerCase() + '.' + name.toLowerCase() + '.';
  const ini = await readFile(environment.iniPath, 'utf8').catch(() => {
    throw new RequirementWait('environment_config', '无法读取本项目的非生产资源配置。');
  });
  const entries = iniResources(ini);
  const permitted = new Map();
  const secrets = new Set();
  const valid = (section, binding) => binding?.section?.toLowerCase().startsWith(prefix) && section
    && section.environment?.toUpperCase() === name
    && section.status === 'configured' && section.ai_access === 'allowed'
    && ['read', 'full_crud'].includes(binding.scope)
    && ['full_crud', 'read_only', 'query_only', 'create_update_read'].includes(section.ai_operation_mode)
    && (binding.scope !== 'full_crud' || section.ai_operation_mode === 'full_crud');
  for (const [key, binding] of Object.entries(environment.resources)) {
    const section = entries.get(binding?.section);
    if (!valid(section, binding)) {
      if (allowUnavailable) continue;
      throw new RequirementWait('environment_config', '资源权限与已绑定测试环境不符：' + key);
    }
    permitted.set(key, { section, binding });
    for (const [field, value] of Object.entries(section)) {
      if (credentialField.test(field) && value.length >= 4) secrets.add(value);
    }
  }
  if (!permitted.size) throw new RequirementWait('environment_config', '没有归属和权限明确的非生产测试资源。');
  const denied = key => new RequirementWait('environment_scope', '资源归属或操作权限未通过非生产环境校验：' + key);
  const assertWrite = async (key, operation) => {
    const item = permitted.get(key);
    if (!item || item.binding.scope !== 'full_crud' || !writeOperations.includes(operation)) throw denied(key);
    let current;
    try { current = iniResources(await readFile(environment.iniPath, 'utf8')).get(item.binding.section); }
    catch { throw denied(key); }
    if (!valid(current, item.binding) || digest(current) !== digest(item.section)) throw denied(key);
  };
  return {
    names: [...permitted.keys()],
    assertWrite,
    identity(key) {
      const item = permitted.get(key);
      if (!item) return null;
      const { section, binding } = item;
      return digest([binding.section, Object.entries(section).filter(([field]) => !credentialField.test(field)).sort()]);
    },
    checkOutput(value) {
      const encoded = JSON.stringify(value);
      if (encoded && [...secrets].some(secret => encoded.includes(JSON.stringify(secret).slice(1, -1)))) {
        throw new RequirementWait('execution_evidence', '适配器回执含未脱敏凭据，结果未登记。');
      }
      return value;
    },
    async use(key, operation, fn) {
      const item = permitted.get(key);
      if (!item) throw denied(key);
      if (operation !== 'read') await assertWrite(key, operation);
      // Only the locally pinned, trusted adapter receives the selected resource. Never serialize it.
      return fn({ ...item.section });
    },
  };
}

export async function loadAdapter(spec) {
  if (!spec || !path.isAbsolute(spec.path) || !/^[a-f0-9]{64}$/.test(spec.sha256)) {
    throw new RequirementWait('execution_adapter', '已到测试执行入口，需配置本项目经过审核的业务执行适配器。');
  }
  if (await hashFile(spec.path) !== spec.sha256) throw new RequirementWait('execution_adapter', '本机执行适配器版本与配置不一致。');
  const adapter = await import(pathToFileURL(spec.path).href);
  for (const name of ['prepare', 'execute', 'reconcile', 'cleanup']) {
    if (typeof adapter[name] !== 'function') throw new RequirementWait('execution_adapter', '执行适配器缺少 ' + name + '。');
  }
  return adapter;
}

export async function executeCases({ job, settings, journal, source, index, manifest, regression, workDir, reportDir, save, progress, codexBin, plan }) {
  const environment = settings.environment;
  const resources = await requirementResources(environment, { allowUnavailable: true });
  const adapter = settings.adapter ? await loadAdapter(settings.adapter) : settings.execution
    ? createRequirementAdapter(settings.execution, { workDir, codexBin, plan }) : await loadAdapter();
  const adapterBinding = settings.adapter ?? [settings.execution, await Promise.all(['adapter', 'assertions', 'release', 'subject']
    .map(name => hashFile(fileURLToPath(new URL('./requirement-' + name + '.js', import.meta.url)))))];
  const binding = digest([adapterBinding, environment.name, environment.platform, environment.resources, environment.lockKey]);
  if (journal.executionBinding && binding !== journal.executionBinding) {
    throw new RequirementWait('environment_version', '运行时权限或适配器版本已变化，需恢复原绑定后再处理已构造的数据。');
  }
  if (!/^[a-z0-9_-]+$/.test(environment.lockKey ?? '')) throw new RequirementWait('environment_config', '缺少共享资源锁分组。');
  const lockRoot = await privateDirectory(settings.lockDirectory);
  const lockFile = path.join(lockRoot, environment.lockKey + '.json');
  let lock = await readJson(lockFile);
  if (journal.cleanup?.verified === true) {
    if (lock?.jobId === job.id && lock.binding === binding) await unlink(lockFile);
    return;
  }
  if (!lock) {
    const { link } = await import('node:fs/promises');
    const ticket = path.join(workDir, 'environment-lock-ticket.json');
    await writeJson(ticket, { jobId: job.id, binding });
    await link(ticket, lockFile).catch(error => { if (error.code !== 'EEXIST') throw error; });
    lock = await readJson(lockFile);
  }
  if (lock?.jobId !== job.id || lock.binding !== binding) {
    throw new RequirementWait('environment_busy', 'SIT 资源正被另一个任务占用或等待清理，释放后可在本话题回复继续。');
  }
  journal.executionBinding = binding;
  await save();
  const checkResourceIdentity = key => {
    const identity = resources.identity(key);
    const saved = journal.executionResourceBindings?.[key];
    if (saved && saved !== identity) {
      throw new RequirementWait('environment_scope', '本轮已绑定的非生产资源发生变化：' + key);
    }
    return identity;
  };
  const useRead = async (key, fn) => {
    checkResourceIdentity(key);
    return resources.use(key, 'read', fn);
  };
  const standards = regression.files['references/execution-standard.md'];
  const scope = { source, index, manifest, reports: reportDir, standards, useRead, checkOutput: resources.checkOutput,
    runPrefix: 'AOS_' + job.id.replaceAll('-', '_'), projectId: job.projectId, environment: environment.name,
    requirements: journal.requirements, repositories: journal.repositories, casesUrl: journal.publication.url };
  journal.results ??= {};
  journal.mutations ??= [];
  journal.preparations ??= {};
  journal.executionSteps ??= {};
  journal.executionCases ??= {};
  journal.cleanup ??= null;
  const confirmWriteTarget = async (key, operation) => {
    await resources.assertWrite(key, operation);
    const identity = checkResourceIdentity(key);
    journal.executionResourceBindings ??= {};
    if (!Object.hasOwn(journal.executionResourceBindings, key)) {
      journal.executionResourceBindings[key] = identity;
      await save();
    }
  };
  const collectRelease = async () => {
    let release;
    try {
      release = resources.checkOutput(await adapter.verifyDeployment?.(scope));
    } catch (error) {
      const sourceStatus = error?.status ?? error?.statusCode;
      release = Number.isInteger(sourceStatus) && sourceStatus >= 400 && sourceStatus < 600
        ? { verified: false, sourceStatus, reason: '发布记录读取返回 HTTP ' + sourceStatus + '。' }
        : { verified: false, reason: '发布证据读取失败或无法安全登记。' };
    }
    release ??= { verified: false, reason: '未配置发布证据来源。' };
    const releaseSummary = { ...release };
    delete releaseSummary.evidence;
    const releaseFile = 'release-evidence-' + digest(releaseSummary).slice(0, 24) + '.json';
    await writeJson(path.join(reportDir, releaseFile), releaseSummary);
    const releaseEvidence = { path: releaseFile, type: '发布版本核验', sanitized: true };
    const evidence = [releaseEvidence];
    for (const entry of Array.isArray(release.evidence) ? release.evidence : []) {
      if (entry?.sanitized === true && typeof entry.path === 'string' && path.basename(entry.path) === entry.path
        && !evidence.some(item => item.path === entry.path)
        && (await lstat(path.join(reportDir, entry.path)).catch(() => null))?.isFile()) evidence.push(entry);
    }
    journal.deploymentLastCheck = { ...releaseSummary, evidence };
    journal.deploymentChecks ??= [];
    if (!journal.deploymentChecks.some(check => check.evidence[0].path === releaseFile)) {
      journal.deploymentChecks.push(journal.deploymentLastCheck);
    }
    await save();
    return { release, releaseEvidence };
  };
  if (!job.requirement.cleanupOnly && !journal.cleanup) {
    await collectRelease();
    for (const item of index) {
      const row = manifest.rows[item.row - 2];
      const caseVersion = digest([item.caseId, item.requirementIds, row, ...(item.assertions ? [item.assertions] : [])]);
      const checkpoint = journal.executionCases[item.caseId];
      if (checkpoint && checkpoint.caseVersion !== caseVersion) {
        throw new RequirementWait('publication_version', '用例内容与已执行检查点不一致。');
      }
      if (journal.results[item.caseId]) continue;
      journal.executionCases[item.caseId] ??= { caseVersion, publicationVersion: journal.publication.version };
      const caseInput = { ...scope, item, row, headers: manifest.headers };
      await progress('执行用例 ' + item.caseId, Object.keys(journal.results).length, index.length);
      const version = caseReleaseRequirement(item, row, manifest.headers, settings.execution?.caseReleases);
      if (version) {
        const { release, releaseEvidence } = await collectRelease();
        if (!matchesCaseRelease(version, release)) {
          const expected = Object.entries(version.fields).map(([field, value]) => field + '=' + value).join('，');
          const actual = '无法确认用例要求的发布版本' + (version.component ? '（' + version.component + ' ' + expected + '）' : '') + '。';
          journal.results[item.caseId] = { status: '阻断', actual, evidence: [releaseEvidence],
            blocker: { dependency: '指定发布版本前置', required_action: '核对该用例要求的组件和版本，并补充对应的运行证据。' },
            at: new Date().toISOString() };
          if (journal.inFlight === item.caseId) journal.inFlight = null;
          await save();
          continue;
        }
      }
      if (!journal.preparations[item.caseId]) {
        const preparation = resources.checkOutput(await adapter.prepare(caseInput));
        if (!preparation || !Array.isArray(preparation.prerequisites)) {
          throw new RequirementWait('execution_plan', '执行适配器未返回本轮前置数据构造矩阵。');
        }
        journal.preparations[item.caseId] = preparation;
        await save();
      }
      const invoke = async (intent, apply) => {
        const shared = intent?.shared === true && environment.resources[intent.resource]?.sharedTargets?.includes(intent.target);
        if (!intent?.id || !intent.target || !intent.beforeHash || !intent.cleanupAction || !writeOperations.includes(intent.operation)
          || (!String(intent.businessKey ?? '').includes(scope.runPrefix) && !shared)) {
          throw new RequirementWait('mutation_scope', '测试变更缺少唯一归属、前置快照或可验证的恢复动作。');
        }
        const key = item.caseId + ':' + intent.id;
        const prior = journal.mutations.find(record => record.key === key);
        if (prior) {
          if (digest(prior.intent) !== digest(intent)) throw new RequirementWait('mutation_scope', '恢复时操作范围与已保存的变更不一致。');
          if (prior.phase === 'applied') return prior.receipt;
          const observed = resources.checkOutput(await adapter.reconcile({ ...caseInput, intent, key }));
          if (observed?.status === 'applied' && observed.receipt?.evidence?.length) {
            prior.phase = 'applied';
            prior.receipt = observed.receipt;
            prior.reconciled = true;
            await save();
            return prior.receipt;
          }
          if (observed?.status !== 'not_applied' || !observed.evidence?.length) {
            throw new RequirementWait('mutation_uncertain', '上次变更结果无法确认，需核对外部状态后继续或恢复清理。');
          }
        }
        await confirmWriteTarget(intent.resource, intent.operation);
        const record = prior ?? { key, caseId: item.caseId, intent: resources.checkOutput(intent), phase: 'prepared', at: new Date().toISOString() };
        if (!prior) journal.mutations.push(record);
        await save();
        const receipt = resources.checkOutput(await resources.use(intent.resource, intent.operation, resource => apply(resource, key)));
        if (!receipt?.evidence?.length) throw new RequirementWait('mutation_uncertain', '外部操作未返回可验证回执。');
        record.phase = 'applied';
        record.receipt = receipt;
        await save();
        return receipt;
      };
      const previous = journal.inFlight;
      journal.inFlight = item.caseId;
      await save();
      const completedSteps = journal.executionSteps[item.caseId] ??= {};
      let result;
      try {
        result = resources.checkOutput(await adapter.execute({ ...caseInput, preparation: journal.preparations[item.caseId], invoke,
          ...(!settings.adapter ? { completedSteps, async saveStep(index, step) {
            completedSteps[index] = resources.checkOutput(step);
            await save();
          } } : {}),
          resumed: previous === item.caseId, mutations: journal.mutations.filter(record => record.caseId === item.caseId) }));
      } catch (error) {
        if (!(error instanceof RequirementWait) || error.code !== 'environment_scope') throw error;
        const file = 'resource-blocked-' + digest(item.caseId).slice(0, 24) + '.json';
        await writeJson(path.join(reportDir, file), { caseId: item.caseId, reason: error.message });
        result = { status: '阻断', actual: error.message, evidence: [{ path: file, type: '环境权限核验', sanitized: true }],
          blocker: { dependency: '已授权的非生产资源', required_action: '核对受影响资源的环境归属和操作权限。' } };
      }
      if (!['通过', '失败', '阻断', '未执行', '不适用'].includes(result?.status) || !result.actual
        || !result.evidence?.length || (result.status === '失败' && !result.issue?.expected_result)
        || (result.status === '阻断' && !result.blocker?.required_action)) {
        throw new RequirementWait('execution_evidence', '用例结果没有足够的本轮证据或缺陷／阻断记录。');
      }
      if (!settings.adapter) {
        for (const entry of result.evidence) {
          if (entry.sanitized !== true || !entry.path || path.basename(entry.path) !== entry.path
            || !(await lstat(path.join(reportDir, entry.path)).catch(() => null))?.isFile()) {
            throw new RequirementWait('execution_evidence', '用例观测证据缺失或未落盘，结果未登记。');
          }
        }
      }
      journal.results[item.caseId] = { ...result, at: new Date().toISOString() };
      journal.inFlight = null;
      await save();
    }
  }

  if (journal.cleanup?.verified !== true) {
    await progress('清理测试数据并核验环境恢复');
    const prior = journal.cleanup;
    journal.cleanup = { verified: false, pending: journal.mutations.map(item => item.key) };
    await save();
    const restore = async (key, operation, apply) => {
      const mutation = journal.mutations.find(item => item.key === key);
      if (!mutation) throw new RequirementWait('mutation_scope', '清理操作缺少本轮变更记录。');
      if (operation === 'read') return useRead(mutation.intent.resource, resource => apply(resource, mutation));
      await confirmWriteTarget(mutation.intent.resource, operation);
      return resources.use(mutation.intent.resource, operation, resource => apply(resource, mutation));
    };
    const cleanup = resources.checkOutput(await adapter.cleanup({ ...scope, mutations: journal.mutations, prior, restore,
      async saveCleanup(key, observation) {
        const mutation = journal.mutations.find(item => item.key === key);
        mutation.cleanup = { ...mutation.cleanup, ...resources.checkOutput(observation) };
        await save();
      },
    }));
    journal.cleanup = cleanup;
    await save();
    if (cleanup?.verified !== true || !cleanup.evidence?.length || cleanup.pending?.length) {
      throw new RequirementWait('cleanup_pending', '测试数据或配置尚未恢复。已保留清理台账，完成核对后在本话题回复恢复清理。');
    }
  }
  await unlink(lockFile);
}
