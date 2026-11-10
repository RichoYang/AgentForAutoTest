import path from 'node:path';
import { requirementFeishu, fileToken, readCaseTemplate, RequirementWait, digest } from './requirement-feishu.js';
import { generatorReferences, loadSkill, privateDirectory, readJson, readRequirementWithInputs, regressionReferences, sourceBaseline, writeJson } from './requirement-files.js';
import { generateValidatedCases } from './requirement-generation.js';
import { reviseMaterialCases } from './requirement-material-revision.js';
import { publishCases } from './requirement-publication.js';
import { executeCases, requirementResources } from './requirement-execution.js';
import { createRequirementAgent } from './requirement-agent.js';
import { buildRequirementReport } from './requirement-report.js';
import { matchesRequirementTopic, requirementCleanupAfterCancellation, resolveRequirementOptions } from '../shared/requirement-options.js';
import { verifiedMutationCleanup } from './requirement-mutation-measurement.js';

export async function runRequirementTest(job, config, emit, dependencies = {}) {
  if (job.status === 'cancelled' && !job.requirement?.cleanupOnly) return { outcome: 'blocked', requirementWait: 'requirement_cancelled', finalMessage: '任务已取消；未读取或修改执行检查点，未恢复业务执行。' };
  const project = config.projects[job.projectId];
  const configured = project?.requirementTest;
  if (!configured || configured.bot.profile !== job.agentProfile || !configured.allowedChatIds.includes(job.chatId)
    || !configured.requesterOpenIds.includes(job.senderId) || !/^JOB-[A-Za-z0-9-]+$/.test(job.id)
    || !matchesRequirementTopic(project, job)) {
    throw new Error('需求测试 Runner 项目绑定不符');
  }
  const settings = resolveRequirementOptions(configured, job.requirement.options);
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
  const readSource = url => readRequirementWithInputs(client, url, settings.inputDirectories, workDir);
  let stage = '需求读取';
  try {
    if (job.requirement.topicBinding) {
      // Resolve the same resource contract used by execution before invoking any model.
      const resources = await requirementResources(settings.environment, { allowUnavailable: true, dataDir: config.dataDir });
      journal.topicResources = Object.fromEntries(resources.names.map(name => [name, resources.identity(name)]));
      journal.repositories ??= await sourceBaseline(project);
    }
    delete journal.waitCode;
    const url = new URL(job.requirement.url);
    if (url.protocol !== 'https:' || url.hostname !== settings.document.domain || !/^\/(?:docx|wiki)\/[A-Za-z0-9]+$/.test(url.pathname)) {
      throw new RequirementWait('requirement_source', '需求链接不在已绑定的飞书租户内。');
    }
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
      await client.verify();
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
      ...(source.materials?.length ? { materials: source.materials.map(({ anchor, type, sha256 }) => ({ anchor, type, sha256 })) } : {}) };
    const projectName = settings.projectName ?? project.displayName;
    if (!job.requirement.cleanupOnly && !job.requirement.confirmedProject
      && settings.otherProjects?.some(name => source.title.toLowerCase().includes(name.toLowerCase())) && !source.title.includes(projectName)) {
      throw new RequirementWait('project_confirmation', '需求标题与机器人绑定项目不一致。仅能在 ' + projectName + ' 执行。如确属该项目，请在本话题回复确认项目。');
    }
    if (!job.requirement.cleanupOnly) {
      stage = '用例生成和覆盖检查';
      journal.phase = stage;
      await save();
      await progress(stage);
      if (!settings.templateUrl || !settings.projectFolderUrl) throw new RequirementWait('project_defaults', '尚未配置此项目的用例模板或发布目录。');
      const token = fileToken(settings.templateUrl, settings.document.domain, 'sheets');
      let template = await readJson(templateFile);
      if (!template) {
        template = await readCaseTemplate(client, token);
        await writeJson(templateFile, template);
      }
      if (template.token !== token) throw new RequirementWait('publication_version', '本轮已固定用例模板，配置变更需要重新发起。');
      if (!journal.casesHash) {
        const { draft, index: cases } = await generateValidatedCases({ source, template: { tabs: template.tabs, headers: template.headers,
          samples: template.values.slice(1).filter(row => row.some(cell => cell !== '')) },
          skill: generator, expectedProject: projectName, otherProjects: settings.otherProjects ?? [],
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
        await writeJson(indexFile, cases);
        await save();
      }
      stage = '飞书用例发布与回读';
      journal.phase = stage;
      await save();
      await progress(stage);
      const manifest = revision?.manifest ?? await readJson(casesFile);
      if (!revision && digest(manifest) !== journal.casesHash) throw new RequirementWait('publication_version', '本轮本地用例校验摘要不符。');
      if ((await readSource(url.href)).hash !== source.hash) {
        throw new RequirementWait('requirement_version', '用例准备期间需求版本发生变化，请按新版本重新发起。');
      }
      if (revision) {
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
      journal.repositories = await sourceBaseline(project);
      await save();
    }
    await executeCases({ job, settings, journal, source, index, manifest, regression, workDir, reportDir, dataDir: config.dataDir, save, progress, codexBin: config.codexBin,
      plan: dependencies.plan, project, agentModel: dependencies.agentModel, review: dependencies.review });

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
      job, journal, source, index, manifest, regression, workDir, reportDir, dataDir: config.dataDir, save,
      codexBin: config.codexBin, timeZone: settings.timeZone, visualModel: dependencies.visualModel,
    });
    const processChecks = Object.values(journal.processFinalization ?? {}).flatMap(entry => Object.values(entry.checks));
    for (const check of processChecks) if (check.kind === 'report' && check.disposition === 'deferred'
      && artifact.complete === true && journal.visualReview?.count === 15) {
      Object.assign(check, { disposition: 'proven', at: new Date().toISOString(), report: { id: artifact.id, sha256: artifact.sha256,
        verificationHash: artifact.verificationHash, visualSheets: journal.visualReview.count } });
    }
    const processProven = processChecks.filter(check => check.disposition === 'proven').length;
    journal.phase = job.requirement.cleanupOnly ? '清理与报告完成'
      : summary.notExecuted || summary.blocked ? '报告生成；业务验收未完成' : '业务测试及报告完成';
    journal.artifact = artifact;
    await save();
    const cleanup = journal.cleanup?.verified === true ? '已核验恢复' : '待恢复';
    const finalMessage = [
      '用例表：' + journal.publication.url,
      ...(job.requirement.cleanupOnly ? [requirementCleanupAfterCancellation(job)
        ? '本轮已恢复清理，未完成的业务用例保留为未执行。' : '本轮已恢复清理并保留已有业务判定。'] : []),
      '执行统计：' + summary.total + ' 条，' + summary.pass + ' 通过，' + summary.fail + ' 失败，' + summary.blocked + ' 阻断，'
        + summary.notExecuted + ' 未执行，' + summary.notApplicable + ' 不适用。',
      '覆盖：' + journal.requirements.length + ' 项已抽取条款都有用例映射。登记 ' + summary.issues + ' 项问题，详情见测试报告。',
      '清理：' + cleanup + '。报告已通过结构与文件校验并生成逐表预览。',
      ...(processChecks.length ? ['当前过程证明 ' + processProven + '/' + processChecks.length
        + '，其中恢复后补证 ' + processChecks.filter(check => check.phase === 'post_cleanup' && check.disposition === 'proven').length
        + '，报告阶段 ' + processChecks.filter(check => check.phase === 'report_verification' && check.disposition === 'proven').length
        + '。原尝试的过程记录保留。'] : []),
    ].join('\n');
    return { outcome: 'ready', finalMessage, requirementReport: artifact,
      requirementSummary: { ...summary, cleanup, caseUrl: journal.publication.url,
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
    const finalMessage = [stage + '暂挂。' + (known ? error.message : '后台执行中断，请管理员检查本轮检查点。'),
      journal.publication?.verified ? '已发布并回读用例：' + journal.publication.url : '',
      '已记录 ' + Object.keys(journal.results ?? {}).length + ' 条用例结果。清理状态：' + cleanup + '。'].filter(Boolean).join('\n');
    return { outcome: 'needs_clarification', finalMessage, requirementWait: journal.waitCode,
      ...(known && error.questions ? { requirementQuestions: error.questions.map(item => item.id) } : {}) };
  }
}
