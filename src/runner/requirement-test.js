import path from 'node:path';
import { requirementFeishu, fileToken, readCaseTemplate, RequirementWait, digest } from './requirement-feishu.js';
import { generatorReferences, loadSkill, privateDirectory, readJson, readRequirementWithInputs, regressionReferences, sourceBaseline, writeJson } from './requirement-files.js';
import { analyzeCaseCoverage, generateCases, generateValidatedCases, indexProvidedCases } from './requirement-generation.js';
import { reviseMaterialCases } from './requirement-material-revision.js';
import { publishCases, readProvidedCases } from './requirement-publication.js';
import { executeCases, requirementResources } from './requirement-execution.js';
import { createRequirementAgent } from './requirement-agent.js';
import { buildRequirementReport } from './requirement-report.js';
import { matchesRequirementTopic, requirementCleanupAfterCancellation, resolveRequirementOptions } from '../shared/requirement-options.js';
import { verifiedMutationCleanup } from './requirement-mutation-measurement.js';
import { sanitized } from './requirement-agent-resources.js';

export async function runRequirementTest(job, config, emit, dependencies = {}) {
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
  const readSource = url => readRequirementWithInputs(client, url, settings.inputDirectories, workDir, { ...settings, checkDocument });
  const captureRepositories = () => sourceBaseline(project, request.branch);
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
      if (source && current.hash !== source.hash) {
        throw new RequirementWait('requirement_version', '需求正文或嵌入表已变化（原版本 ' + source.revision + '，当前版本 ' + current.revision + '）。已保留原用例和证据。请确认受影响范围后为新版本发起独立话题；如有待清理数据，可在原话题回复恢复清理。');
      }
      if (!source) {
        source = current;
        await writeJson(sourceFile, source);
      }
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
        throw new RequirementWait('publication_version', '指定用例表的定义已变化，原用例和执行证据已经保留。请按新版本另行发起。');
      }
      if (request.browser === 'codex_sidebar') {
        if (provided && !journal.casesHash) journal.providedCases = { ...provided.receipt, count: provided.rows.length };
        throw new RequirementWait('browser_unavailable', '任务要求仅使用 Codex 侧边栏浏览器。飞书后台 Runner 无法连接该会话的浏览器，当前尚未开始业务执行。请在可使用该浏览器的 Codex 会话中执行。');
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
      if ((await readSource(url.href)).hash !== source.hash) {
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
    const reports = await privateDirectory(settings.reportDirectory);
    const reportDir = await privateDirectory(path.join(reports, job.id));
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
    await progress(stage);
    if (!journal.repositories) {
      journal.repositories = await captureRepositories();
      await save();
    }
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
    const cleanup = journal.cleanup?.verified === true ? '已核验恢复' : '待恢复';
    const acceptance = request.resultFormat === 'binary' ? (summary.pass > 0 && !summary.fail && !summary.blocked
      && !summary.notExecuted && !externalPending && journal.cleanup?.verified ? '通过' : '不通过') : null;
    const finalMessage = [
      ...(acceptance ? ['整体验收：' + acceptance] : []),
      '用例表：' + journal.publication.url,
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
    ].join('\n');
    return { outcome: 'ready', finalMessage, requirementReport: artifact,
      requirementSummary: { ...summary, cleanup, caseUrl: journal.publication.url, ...(acceptance ? { acceptance } : {}),
        ...(incompleteFailures ? { incompleteFailures } : {}),
        ...(externalPending ? { externalPending } : {}),
        ...(processChecks.length ? { process: { total: processChecks.length, proven: processProven } } : {}) } };
  } catch (error) {
    const known = error instanceof RequirementWait;
    journal.phase = stage;
    journal.waitCode = known ? error.code : 'runner_error';
    await save();
    const restored = journal.mutations?.length && journal.mutations.every(verifiedMutationCleanup);
    const cleanup = restored || journal.cleanup?.verified ? '已核验恢复' : journal.mutations?.length ? '待核对清理台账' : '尚未记录业务变更';
    if (lastSummary) await progress(stage + '暂挂；清理' + cleanup, undefined, undefined, { ...lastSummary,
      phase: 'execution_interrupted', pendingMutations: (journal.mutations ?? []).filter(item => !verifiedMutationCleanup(item)).length,
      cleanupVerified: Boolean(restored || journal.cleanup?.verified), interruption: journal.waitCode });
    const finalMessage = [request.resultFormat === 'binary' ? '整体验收：不通过（验收未完成）。' : '',
      stage + '暂挂。' + (known ? error.message : '后台执行中断，请管理员检查本轮检查点。'),
      journal.publication?.verified ? (journal.publication.external ? '已回读指定用例：' : '已发布并回读用例：') + journal.publication.url
        : journal.providedCases?.verified ? '已读取指定用例表，共 ' + journal.providedCases.count + ' 条。' : '',
      '已记录 ' + Object.keys(journal.results ?? {}).length + ' 条用例结果。清理状态：' + cleanup + '。'].filter(Boolean).join('\n');
    return { outcome: 'needs_clarification', finalMessage, requirementWait: journal.waitCode,
      ...(known && error.questions ? { requirementQuestions: error.questions.map(item => item.id) } : {}) };
  }
}
