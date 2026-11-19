import path from 'node:path';
import { copyFile } from 'node:fs/promises';
import { requirementFeishu, fileToken, readCaseTemplate, RequirementWait, digest } from './requirement-feishu.js';
import { generatorReferences, isAgentDiagnostic, loadSkill, privateDirectory, readJson, readRequirementWithInputs, regressionReferences, sameRequirementContent, sourceBaseline, unavailableRequirementSources, writeJson } from './requirement-files.js';
import { analyzeCaseCoverage, generateCases, generateValidatedCases, indexProvidedCases } from './requirement-generation.js';
import { reviseMaterialCases } from './requirement-material-revision.js';
import { publishCases, readProvidedCases } from './requirement-publication.js';
import { executeCases, requirementResources } from './requirement-execution.js';
import { createRequirementAgent } from './requirement-agent.js';
import { buildRequirementReport } from './requirement-report.js';
import { matchesRequirementTopic, requirementCleanupAfterCancellation, resolveRequirementOptions } from '../shared/requirement-options.js';
import { verifiedMutationCleanup } from './requirement-mutation-measurement.js';
import { sanitized } from './requirement-agent-resources.js';
import { withSnapshotLock } from '../shared/snapshot-lock.js';
import { collectTopicFeedback, archiveExecutionVersion, recoverExecutionVersion } from './requirement-feedback.js';
import { LarkCliFeishuClient } from '../control-plane/lark-cli.js';
import { buildEvidenceBundle } from './requirement-bundle.js';

export async function runRequirementTest(job, config, emit, dependencies = {}) {
  if (job.status === 'cancelled' && !job.requirement?.cleanupOnly) return { outcome: 'blocked', requirementWait: 'requirement_cancelled', finalMessage: '任务已取消；未恢复业务执行。' };
  if (!/^JOB-[A-Za-z0-9-]+$/.test(job.id)) throw new Error('Invalid requirement job');
  const root = await privateDirectory(path.join(config.dataDir, 'requirement-tests', job.id));
  return withSnapshotLock(root, () => runRequirementTestLocked(job, config, emit, dependencies));
}

async function runRequirementTestLocked(job, config, emit, dependencies) {
  if (job.status === 'cancelled' && !job.requirement?.cleanupOnly) return { outcome: 'blocked', requirementWait: 'requirement_cancelled', finalMessage: '任务已取消；未读取或修改执行检查点，未恢复业务执行。' };
  const project = config.projects[job.projectId];
  const configured = project?.requirementTest;
  if (!configured || configured.bot.profile !== job.agentProfile || !configured.allowedChatIds.includes(job.chatId)
    || !configured.requesterOpenIds.includes(job.senderId) || !/^JOB-[A-Za-z0-9-]+$/.test(job.id)
    || !matchesRequirementTopic(project, job)) {
    throw new Error('需求测试 Runner 项目绑定不符');
  }
  const options = job.requirement.options;
  const settings = resolveRequirementOptions(configured, { ...options, localSupplement: undefined });
  let lastSummary;
  const progress = (current, completed = 0, total = 0, summary) => emit({
    type: 'progress', phase: 'tool_activity', activity: { current, completed, total, recent: [],
      ...((summary ?? lastSummary) ? { requirement: (lastSummary = summary ?? lastSummary) } : {}) },
  });
  const workDir = await privateDirectory(path.join(config.dataDir, 'requirement-tests', job.id));
  const journalFile = path.join(workDir, 'journal.json');
  const journal = await readJson(journalFile) ?? {
    version: 1, projectId: job.projectId, url: job.requirement.url, startedAt: new Date().toISOString(),
    environment: settings.environment?.name,
    ...(settings.requestedEnvironment ? { requestedEnvironment: settings.requestedEnvironment } : {}),
  };
  if (journal.version !== 1 || journal.projectId !== job.projectId || journal.url !== job.requirement.url
    || journal.environment !== settings.environment?.name) throw new Error('需求测试检查点与本轮绑定不符');
  let pendingSave = Promise.resolve();
  const save = () => {
    const snapshot = structuredClone(journal);
    const result = pendingSave.then(() => writeJson(journalFile, snapshot));
    pendingSave = result.catch(() => {});
    return result;
  };
  const sourceFile = path.join(workDir, 'requirement.json');
  if (!job.requirement.cleanupOnly) await recoverExecutionVersion(journal, workDir, save);
  const templateFile = path.join(workDir, 'template.json');
  const casesFile = path.join(workDir, 'cases.json');
  const indexFile = path.join(workDir, 'case-index.json');
  const client = dependencies.client ?? requirementFeishu(settings.document, workDir);
  const request = settings.request;
  const reserved = new Set(Object.values(config.projects).flatMap(candidate =>
    candidate.requirementTest?.topicBindings?.map(binding => binding.documentUrl) ?? []));
  const checkDocument = url => {
    if (reserved.has(url) && (!job.requirement.topicBinding || url !== job.requirement.url)) {
      throw new RequirementWait('requirement_source', '此文档只允许在已绑定的独立验收话题内使用。');
    }
  };
  const readSource = async url => {
    const source = await readRequirementWithInputs(client, url, settings.inputDirectories, workDir, { ...settings, checkDocument });
    if (settings.feedback?.enabled) {
      const resources = await requirementResources(settings.environment, { allowUnavailable: true, dataDir: config.dataDir });
      source.feedback = await collectTopicFeedback(dependencies.feedbackClient ?? new LarkCliFeishuClient({ dataDir: config.dataDir }), job, settings, workDir, resources.checkOutput);
      const acceptance = source.feedback.records.filter(record => record.kind === 'acceptance_confirmation');
      if (acceptance.length) source.hash = digest([source.hash, acceptance]);
    }
    return source;
  };
  let requestedSources, synchronizedThisRun;
  const captureRepositories = () => request.branch
    ? (requestedSources ??= sourceBaseline(project, request.branch).then(repositories => (synchronizedThisRun = repositories)))
    : sourceBaseline(project);
  let stage = '需求读取';
  try {
    if (options?.localSupplement && !job.requirement.cleanupOnly) {
      try { settings.localSupplement = resolveRequirementOptions(configured, options).localSupplement; }
      catch (error) { throw new RequirementWait('requirement_source', error.message); }
    }
    if (job.requirement.topicBinding) {
      if (request.supplementDocuments?.length || request.caseSource || settings.localSupplement) {
        throw new RequirementWait('requirement_source', '该隔离话题只允许读取已绑定的输入材料。');
      }
      // Resolve the same resource contract used by execution before invoking any model.
      const resources = await requirementResources(settings.environment, { allowUnavailable: true, dataDir: config.dataDir });
      journal.topicResources = Object.fromEntries(resources.names.map(name => [name, resources.identity(name)]));
      journal.repositories ??= await captureRepositories();
    }
    delete journal.waitCode;
    if (job.requirement.cleanupOnly && !job.requirement.url && !journal.resolvedUrl) {
      throw new RequirementWait('cleanup_pending', '此任务尚未解析主需求，没有进入业务操作。');
    }
    if (!job.requirement.cleanupOnly) await client.verify();
    const url = new URL(job.requirement.url ?? journal.resolvedUrl
      ?? (await client.resolveInput(request.documentTitle, 'document')).url);
    if (url.protocol !== 'https:' || url.hostname !== settings.document.domain || !/^\/(?:docx|wiki)\/[A-Za-z0-9]+$/.test(url.pathname)) {
      throw new RequirementWait('requirement_source', '需求链接不在已绑定的飞书租户内。');
    }
    checkDocument(url.href);
    if (!job.requirement.url) journal.resolvedUrl = url.href;
    const generator = await loadSkill(settings.skills?.generator, 'lark-testcase-by-prd-order-generator', generatorReferences);
    const regression = await loadSkill(settings.skills?.regression, 'run-full-requirement-regression', regressionReferences);
    const versions = { generator: generator.sha256, regression: regression.sha256 };
    if (journal.skills && digest(journal.skills) !== digest(versions)) throw new RequirementWait('skill_version', '本轮已固定 Skill 版本，请恢复原版本后继续。');
    journal.skills = versions;
    journal.phase = stage;
    await save();
    await progress(stage);
    let source = await readJson(sourceFile);
    let revision;
    if (job.requirement.cleanupOnly && journal.revisionHash) {
      revision = await readJson(path.join(workDir, 'material-revision.json'));
      if (revision?.hash !== journal.revisionHash) throw new RequirementWait('publication_version', '缺少当前执行版本的图示修订。');
      source = revision.source;
    }
    if (!job.requirement.cleanupOnly) {
      const current = await readSource(url.href);
      if (source && !source.materials && current.legacyHash === source.hash) {
        if (journal.casesHash) {
          if (journal.publication && !journal.publication.verified) {
            throw new RequirementWait('publication_receipt', '原用例仍有未完成的发布回执，请核对后再创建图示修订。');
          }
          const cases = await readJson(casesFile);
          const caseIndex = await readJson(indexFile);
          if (digest(cases) !== journal.casesHash || digest(caseIndex) !== journal.caseIndexHash) {
            throw new RequirementWait('publication_version', '现有用例无法校验，不能补录图示映射。');
          }
          if (request.caseSource) throw new RequirementWait('requirement_version', '指定用例的需求图示已变化，请核对原用例后重新发起。');
          revision = await reviseMaterialCases({ source: current, base: { manifest: cases, index: caseIndex,
            requirements: journal.originalRequirements ?? journal.requirements }, journal, job, settings, skill: generator,
            workDir, codexBin: config.codexBin, model: dependencies.materialModel });
          if (revision) journal.materialCoverage = revision.coverage;
          await save();
        }
        source = current;
        if (!revision) await writeJson(sourceFile, source);
      }
      if (source && !sameRequirementContent(source, current)) {
        await archiveExecutionVersion({ journal, source, current, job, workDir, save });
        source = current;
      }
      if (!source) {
        source = current;
        await writeJson(sourceFile, source);
      }
      if (current.feedback) { source.feedback = current.feedback; journal.feedback = current.feedback; }
    }
    if (!source) throw new RequirementWait('cleanup_pending', '此任务没有已读取的需求或已执行数据，未进入业务操作。');
    journal.source = { id: source.id, revision: source.revision, hash: source.hash, embedded: source.embedded.length,
      ...(source.documents?.length ? { documents: source.documents.map(({ url, revision, hash, comments }) => ({
        url, revision, hash, commentsHash: digest(comments),
      })) } : {}),
      ...(source.materials?.length ? { materials: source.materials.map(({ anchor, type, sha256 }) => ({ anchor, type, sha256 })) } : {}) };
    const projectName = settings.projectName ?? project.displayName;
    if (!job.requirement.cleanupOnly && !job.requirement.confirmedProject
      && settings.otherProjects?.some(name => source.title.toLowerCase().includes(name.toLowerCase())) && !source.title.includes(projectName)) {
      throw new RequirementWait('project_confirmation', '需求标题与机器人绑定项目不一致。仅能在 ' + projectName + ' 执行。如确属该项目，请在本话题回复确认项目。');
    }
    if (!job.requirement.cleanupOnly) {
      stage = request.caseSource ? '建立原表执行索引' : '提炼可验证项';
      journal.phase = stage;
      await save();
      await progress(stage);
      if (!settings.templateUrl || (!request.caseSource && !settings.projectFolderUrl)) {
        throw new RequirementWait('project_defaults', '尚未配置此项目的用例模板或发布目录。');
      }
      const token = fileToken(settings.templateUrl, settings.document.domain, 'sheets');
      let template = await readJson(templateFile);
      if (!template) {
        template = await readCaseTemplate(client, token);
        await writeJson(templateFile, template);
      }
      if (template.token !== token) throw new RequirementWait('publication_version', '本轮已固定用例模板，配置变更需要重新发起。');
      const provided = request.caseSource && await readProvidedCases(client, request.caseSource, template.headers);
      if (provided && journal.publication && (journal.publication.fileToken !== provided.receipt.fileToken
        || journal.publication.sheetId !== provided.receipt.sheetId || journal.publication.version !== provided.receipt.version)) {
        const current = { ...source, approvalHash: digest([source.hash, provided.receipt.version]) };
        const previous = await readJson(sourceFile);
        await archiveExecutionVersion({ journal, source: previous, current, job, workDir, save });
        source = current;
      }
      if (!journal.casesHash) {
        if (Object.keys(journal.results ?? {}).length || journal.mutations?.length || journal.inFlight
          || Object.keys(journal.executionCases ?? {}).length) {
          throw new RequirementWait('publication_version', '已有执行台账，但缺少已绑定的用例清单。保留原结果及恢复记录，请核对检查点。');
        }
        const candidate = provided ? indexProvidedCases(source, template, provided.rows, settings) : null;
        if (candidate) {
          const prior = await readJson(casesFile);
          if (prior && (digest(prior.headers) !== digest(candidate.manifest.headers) || digest(prior.rows) !== digest(candidate.manifest.rows))) {
            throw new RequirementWait('publication_version', '原表的定义与已保存版本不同。已保留原检查点，请按新版本另行发起。');
          }
          if (!prior) await writeJson(casesFile, candidate.manifest);
          journal.requirements = [];
          journal.casesHash = digest(prior ?? candidate.manifest);
          journal.caseIndexHash = digest(candidate.index);
          journal.publication = provided.receipt;
          await writeJson(indexFile, candidate.index);
          await save();
        } else {
          const { draft, index: cases, coverage } = await generateValidatedCases({ source, template: { tabs: template.tabs, headers: template.headers,
            samples: template.values.slice(1).filter(row => row.some(cell => cell !== '')) },
            advisoryCoverage: true, skill: generator, expectedProject: projectName, otherProjects: settings.otherProjects ?? [],
            codexBin: config.codexBin, cwd: workDir }, settings, casesFile, {
            generate: dependencies.generate,
            checkProject(draft) {
              if (draft?.projectMatch === 'conflict' && !job.requirement.confirmedProject) {
                throw new RequirementWait('project_confirmation', '需求内容与绑定项目可能冲突。仅能在 ' + projectName + ' 执行；如确属该项目，请回复确认项目。');
              }
              if (!['match', 'conflict'].includes(draft?.projectMatch)) {
                throw new RequirementWait('requirement_clarification', '需求范围或口径尚不明确。请补全飞书需求原文，再为修订后的版本发起新话题。');
              }
            },
          });
          journal.requirements = draft.requirements;
          journal.casesHash = digest(draft.manifest);
          journal.caseIndexHash = digest(cases);
          journal.caseCoverage = coverage;
          journal.caseCoverageKey = digest([source.hash, journal.caseIndexHash]);
          await writeJson(indexFile, cases);
          await save();
        }
      }
      stage = provided ? '指定用例回读' : '飞书用例发布与回读';
      journal.phase = stage;
      await save();
      await progress(stage);
      const manifest = revision?.manifest ?? await readJson(casesFile);
      if (!revision && digest(manifest) !== journal.casesHash) throw new RequirementWait('publication_version', '本轮本地用例校验摘要不符。');
      if (!sameRequirementContent(source, await readSource(url.href))) {
        throw new RequirementWait('requirement_version', '用例准备期间需求版本发生变化，请按新版本重新发起。');
      }
      if (provided) {
        const { receipt } = await readProvidedCases(client, request.caseSource, template.headers);
        if (receipt.fileToken !== provided.receipt.fileToken || receipt.sheetId !== provided.receipt.sheetId
          || receipt.version !== journal.publication?.version) {
          throw new RequirementWait('publication_version', '建立索引期间指定用例表定义发生变化，请核对后重新发起。');
        }
        journal.publication.lastVerifiedRevision = receipt.revision;
        await save();
      } else if (revision) {
        const state = { startedAt: journal.startedAt, publication: journal.revisionPublication };
        await publishCases({ client, settings, source, template, manifest, journal: state, revisionTag: revision.tag, async save() {
          journal.revisionPublication = state.publication;
          await save();
        } });
        if (!journal.revisionHash) {
          if (journal.publication?.verified) journal.publicationHistory = [...(journal.publicationHistory ?? []), journal.publication];
          if (journal.deployment) {
            journal.deploymentHistory = [...(journal.deploymentHistory ?? []), journal.deployment];
            delete journal.deployment;
          }
          journal.originalRequirements = journal.requirements;
          journal.requirements = revision.requirements;
          journal.revisionHash = revision.hash;
        }
        if (journal.revisionHash !== revision.hash) throw new RequirementWait('publication_version', '当前发布回执与图示修订摘要不一致。');
        journal.publication = state.publication;
        await save();
      } else {
        await publishCases({ client, settings, source, template, manifest, journal, save });
      }
    }

    const index = revision?.index ?? await readJson(indexFile);
    const manifest = revision?.manifest ?? await readJson(casesFile);
    const validCases = revision ? digest([manifest, index, revision.requirements]) === journal.revisionHash
      : digest(index) === journal.caseIndexHash && digest(manifest) === journal.casesHash;
    if (!journal.publication?.verified || !validCases) {
      throw new RequirementWait('publication_version', '飞书用例或追踪索引未通过本轮验证。');
    }
    stage = '保存用例及发布凭证';
    journal.phase = stage;
    await save();
    await progress(stage);
    if (request.browser === 'codex_sidebar' && (!settings.execution?.sidebar?.publicKey || settings.execution?.mode !== 'agent')) {
      const file = path.join(workDir, 'sidebar-task.json');
      await writeJson(file, { version: 1, mode: 'codex_sidebar', integration: 'not_verified', jobId: job.id,
        executionVersion: journal.executionVersion ?? 1, projectId: job.projectId, environment: settings.environment.name,
        source: journal.source, publication: journal.publication, index, manifest, samples: journal.samples ?? {},
        results: journal.results ?? {}, next: '配置 execution.mode=agent 及 sidebar 可信宿主公钥、来源类型；在原话题继续。后续逐节点请求位于 sidebar-handoff。' });
      throw new RequirementWait('sidebar_handoff', 'Codex 侧边栏浏览器待交接；已保存用例、样本和原节点。后台宿主集成尚未验证。交接文件：' + file);
    }
    const reports = await privateDirectory(settings.reportDirectory);
    const reportDir = await privateDirectory(path.join(reports, job.id, ...((journal.executionVersion ?? 1) > 1 ? ['execution-' + journal.executionVersion] : [])));
    if (journal.reuseCandidates) {
      const old = journal.reuseCandidates;
      journal.results ??= {}; journal.executionCases ??= {}; journal.sourceAttempts ??= {};
      const preserve = async value => {
        if (!value || typeof value !== 'object') return;
        // Agent diagnostics stay in this Job's work directory across execution versions.
        if (value.sanitized === true && value.path && !isAgentDiagnostic(value.type)) {
          if (path.basename(value.path) !== value.path || !old.reportDirectory) throw new RequirementWait('report_evidence', '复用结果缺少原证据目录。');
          const prior = value.path;
          value.path = 'reuse-v' + old.fromVersion + '-' + prior;
          await copyFile(path.join(old.reportDirectory, prior), path.join(reportDir, value.path));
        }
        for (const child of Object.values(value)) await preserve(child);
      };
      for (const item of index) {
        const row = manifest.rows[item.row - 2];
        const version = digest([item.caseId, item.requirementIds, row, ...(item.assertions ? [item.assertions] : [])]);
        if (!old.affectedCaseIds.includes(item.caseId) && old.cases[item.caseId]?.caseVersion === version && old.results[item.caseId]) {
          const result = structuredClone(old.results[item.caseId]); await preserve(result);
          journal.results[item.caseId] = { ...result, reusedFromVersion: old.fromVersion, reuseScope: '确认未受影响且用例定义一致' };
          journal.executionCases[item.caseId] = old.cases[item.caseId];
          if (result.sourceAttempt) journal.sourceAttempts[result.sourceAttempt] = old.sourceAttempts[result.sourceAttempt];
        }
      }
      delete journal.reuseCandidates;
    }
    journal.reportDirectory = reportDir; await save();
    await writeJson(path.join(reportDir, 'case-index.json'), index);
    await writeJson(path.join(reportDir, 'publication.json'), {
      jobId: job.id, requestedEnvironment: settings.requestedEnvironment ?? settings.environment.name,
      resourceEnvironment: settings.environment.name, source: journal.source, requirements: journal.requirements,
      caseCount: index.length, folder: settings.projectFolderUrl, workbook: journal.publication,
      ...(journal.materialCoverage ? { materialCoverage: journal.materialCoverage } : {}),
    });
    stage = '测试环境执行与恢复';
    journal.phase = stage;
    await save();
    if (!journal.repositories || request.branch && !job.requirement.cleanupOnly) {
      if (request.branch && !job.requirement.cleanupOnly) await progress('同步指定分支 ' + request.branch);
      journal.repositories = await captureRepositories();
      delete journal.repositorySync;
      await save();
    }
    await progress(stage);
    await executeCases({ job, settings, journal, source, index, manifest, regression, workDir, reportDir, dataDir: config.dataDir, save, progress, codexBin: config.codexBin,
      plan: dependencies.plan, project, agentModel: dependencies.agentModel, review: dependencies.review,
      captureRepositories });

    const coverageKey = digest([source.hash, digest(index)]);
    if (!job.requirement.cleanupOnly && request.caseSource && journal.caseCoverageKey !== coverageKey) {
      stage = '报告覆盖分析';
      journal.phase = stage;
      await progress(stage);
      let draft;
      let analysis = 'reviewed';
      try {
        draft = sanitized(await (dependencies.generate ?? generateCases)({ source, existingCases: manifest.rows,
          template: { headers: manifest.headers }, skill: generator, expectedProject: projectName,
          otherProjects: settings.otherProjects ?? [], codexBin: config.codexBin, cwd: workDir }));
        if (!Array.isArray(draft?.requirements) || !Array.isArray(draft?.caseRequirements)) analysis = 'unavailable';
      } catch {
        // Coverage analysis is advisory. An unavailable model must leave a reportable gap, not invalidate runtime results.
        analysis = 'unavailable';
      }
      if (analysis === 'unavailable' && journal.requirements?.length) {
        const links = new Map(index.map(item => [item.row, item.requirementIds]));
        draft = { requirements: journal.requirements, caseRequirements: manifest.rows.map((_, position) => links.get(position + 2) ?? []) };
      }
      journal.caseCoverage = analyzeCaseCoverage(draft, source, index, manifest.rows.length, analysis);
      journal.caseCoverageKey = coverageKey;
      await save();
    }
    const coverage = journal.caseCoverageKey === coverageKey ? journal.caseCoverage : undefined;

    if (!settings.adapter && settings.execution?.mode === 'agent' && Object.values(journal.results ?? {}).some(result => result.checkCoverage?.processTotal)) {
      const resources = await requirementResources(settings.environment, { allowUnavailable: true, dataDir: config.dataDir });
      const agent = createRequirementAgent(settings.execution, { workDir, codexBin: config.codexBin, review: dependencies.review });
      const prior = journal.processFinalization;
      journal.processFinalization = await agent.supplementProcesses({ index, jobId: job.id, projectId: job.projectId,
        environment: settings.environment.name, reports: reportDir, checkOutput: resources.checkOutput, resourceCatalog: resources.catalog }, journal, manifest);
      if (prior && Object.entries(prior).some(([caseId, entry]) => entry.resultHash !== journal.processFinalization[caseId]?.resultHash)) {
        (journal.processFinalizationHistory ??= []).push(prior);
      }
      await save();
    }

    stage = '测试报告验证';
    journal.phase = stage;
    await save();
    await progress(stage);
    const { summary, artifact } = await buildRequirementReport({
      job, journal, source, index, manifest, coverage, regression, workDir, reportDir, dataDir: config.dataDir, save,
      codexBin: config.codexBin, timeZone: settings.timeZone, visualModel: dependencies.visualModel,
    });
    const processChecks = Object.values(journal.processFinalization ?? {}).flatMap(entry => Object.values(entry.checks));
    for (const check of processChecks) if (check.kind === 'report' && check.disposition === 'deferred'
      && artifact.complete === true && journal.visualReview?.count === 15) {
      Object.assign(check, { disposition: 'proven', at: new Date().toISOString(), report: { id: artifact.id, sha256: artifact.sha256,
        verificationHash: artifact.verificationHash, visualSheets: journal.visualReview.count } });
    }
    const processProven = processChecks.filter(check => check.disposition === 'proven').length;
    const externalPending = processChecks.filter(check => check.kind === 'external_cleanup' && check.disposition !== 'proven').length;
    const incompleteFailures = Object.values(journal.results ?? {}).filter(result => result.status === '失败'
      && result.checkCoverage && (result.blocker || result.checkCoverage.compared < result.checkCoverage.total)).length;
    journal.phase = job.requirement.cleanupOnly ? '清理与报告完成'
      : summary.notExecuted || summary.blocked || incompleteFailures ? '报告生成；业务验收未完成'
        : externalPending ? '业务比较及报告完成；外部过程待回执' : '业务测试及报告完成';
    journal.artifact = artifact;
    await save();
    const retained = journal.cleanup?.retainedData?.length ?? 0;
    const cleanup = retained ? '已清理可释放数据；保留 ' + retained + ' 个有继续条件的样本' : journal.cleanup?.verified === true ? '已核验恢复' : '待恢复';
    const acceptance = request.resultFormat === 'binary' ? (summary.pass > 0 && !summary.fail && !summary.blocked
      && !summary.notExecuted && !externalPending && !retained && !Object.values(journal.results ?? {}).some(result => result.validationScope === 'controlled') && journal.cleanup?.verified ? '通过' : '不通过') : null;
    const finalMessage = [
      ...(acceptance ? ['整体验收：' + acceptance] : []),
      '执行版本：' + (journal.executionVersion ?? 1) + '。' + (Object.values(journal.results ?? {}).some(result => result.validationScope === 'controlled') ? '包含受控验证，不能作为真实 UAT 通过凭证。' : ''),
      '用例表：' + journal.publication.url,
      unavailableRequirementSources(journal.repositories),
      ...(job.requirement.cleanupOnly ? [requirementCleanupAfterCancellation(job)
        ? '本轮已恢复清理，未完成的业务用例保留为未执行。' : '本轮已恢复清理并保留已有业务判定。'] : []),
      '执行统计：' + summary.total + ' 条，' + summary.pass + ' 通过，' + summary.fail + ' 失败，' + summary.blocked + ' 阻断，'
        + summary.notExecuted + ' 未执行，' + summary.notApplicable + ' 不适用。',
      ...(incompleteFailures ? ['其中 ' + incompleteFailures + ' 条已证明失败仍有未完成检查或执行缺口，分别见缺陷和阻断记录。'] : []),
      ...(coverage ? [coverage.analysis === 'unavailable' ? '覆盖分析未完成，实测记录已保留。'
        : '覆盖：' + (coverage.rows.length - coverage.unmatchedRows.length) + '/' + coverage.rows.length
          + ' 条用例关联到条款，' + coverage.uncoveredRequirements.length + ' 项已提炼条款未找到对应验证项。'] : []),
      '登记 ' + summary.issues + ' 项问题，详情见测试报告。',
      '清理：' + cleanup + '。报告已通过结构与文件校验并生成逐表预览。',
      ...(externalPending ? ['另有 ' + externalPending + ' 项外部回收待核验。业务比较结论已保存，整体验收待外部回执。'] : []),
      ...(processChecks.length ? ['当前过程证明 ' + processProven + '/' + processChecks.length
        + '，其中恢复后补证 ' + processChecks.filter(check => check.phase === 'post_cleanup' && check.disposition === 'proven').length
        + '，报告阶段 ' + processChecks.filter(check => check.phase === 'report_verification' && check.disposition === 'proven').length
        + '。原尝试的过程记录保留。'] : []),
    ].filter(Boolean).join('\n');
    const resources = await requirementResources(settings.environment, { allowUnavailable: true, dataDir: config.dataDir });
    const bundle = await buildEvidenceBundle({ job, journal, reportDir, workDir, dataDir: config.dataDir, checkOutput: resources.checkOutput });
    journal.artifact = artifact; journal.evidenceBundle = bundle; await save();
    return { outcome: 'ready', finalMessage, requirementReport: artifact,
      requirementDelivery: { version: journal.executionVersion ?? 1, text: finalMessage, artifacts: [artifact, bundle] },
      requirementSummary: { ...summary, cleanup, caseUrl: journal.publication.url, ...(acceptance ? { acceptance } : {}),
        retainedSamples: retained,
        ...(incompleteFailures ? { incompleteFailures } : {}),
        ...(externalPending ? { externalPending } : {}),
        ...(processChecks.length ? { process: { total: processChecks.length, proven: processProven } } : {}) } };
  } catch (error) {
    const known = error instanceof RequirementWait;
    journal.phase = stage;
    journal.waitCode = known ? error.code : 'runner_error';
    if (known && error.repositorySync) journal.repositorySync = error.repositorySync;
    await save();
    const restored = journal.mutations?.length && journal.mutations.every(verifiedMutationCleanup);
    const cleanup = journal.cleanup?.retainedData?.length ? '有依据保留样本，见继续条件' : restored || journal.cleanup?.verified ? '已核验恢复' : journal.mutations?.length ? '待核对清理台账' : '尚未记录业务变更';
    if (lastSummary) await progress(stage + '暂挂；清理' + cleanup, undefined, undefined, { ...lastSummary,
      phase: 'execution_interrupted', pendingMutations: (journal.mutations ?? []).filter(item => !verifiedMutationCleanup(item)).length,
      cleanupVerified: Boolean(restored || journal.cleanup?.verified), interruption: journal.waitCode });
    const finalMessage = [request.resultFormat === 'binary' ? '整体验收：不通过（验收未完成）。' : '',
      stage + '暂挂。' + (known ? error.message : '后台执行中断，请管理员检查本轮检查点。'),
      unavailableRequirementSources(synchronizedThisRun),
      journal.publication?.verified ? (journal.publication.external ? '已回读指定用例：' : '已发布并回读用例：') + journal.publication.url
        : journal.providedCases?.verified ? '已读取指定用例表，共 ' + journal.providedCases.count + ' 条。' : '',
      '已记录 ' + Object.keys(journal.results ?? {}).length + ' 条用例结果。清理状态：' + cleanup + '。'].filter(Boolean).join('\n');
    return { outcome: 'needs_clarification', finalMessage, requirementWait: journal.waitCode,
      ...(known && error.questions ? { requirementQuestions: error.questions.map(item => item.id) } : {}) };
  }
}
