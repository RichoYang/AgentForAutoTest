import { hashFile } from '../shared/file-digest.js';
import { reportFile } from '../shared/report-files.js';
import { investigationComplete, QUESTION_GOAL_ID } from '../shared/investigation-review.js';
import { readFile, realpath, stat } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const CONFIG = fileURLToPath(new URL('../../config/', import.meta.url));
const roles = ['common', 'owner_intake', 'pm', 'developer', 'qa', 'owner_audit', 'owner_report', 'analysis', 'analysis_report'];
const digest = (value) => createHash('sha256').update(value).digest('hex');
export async function loadHarness(job, directory = CONFIG) {
  const raw = await readFile(path.join(directory, 'harness.json'), 'utf8');
  const manifest = JSON.parse(raw);
  if (!manifest.version || !manifest.standard?.url || !manifest.standard?.version || !Number.isInteger(manifest.standard?.revision)) throw new Error('Invalid Harness manifest');
  const texts = {};
  for (const name of roles) {
    texts[name] = await readFile(path.join(directory, 'roles', `${name}.md`), 'utf8');
    if (!texts[name].trim()) throw new Error(`Empty Harness role: ${name}`);
  }
  const fingerprint = digest(JSON.stringify({ raw, texts }));
  const previous = (job.context ?? []).map((entry) => entry.result?.harness).filter(Boolean);
  if (previous.some((entry) => entry.fingerprint !== fingerprint)) throw new Error('Harness版本在任务链中发生变化；请先由管理员复核，不自动沿用旧批准。');
  const role = job.taskIntent === 'analysis' ? (job.stage === 'owner_report' ? 'analysis_report' : 'analysis') : job.stage;
  if (!texts[role]) throw new Error(`Unknown Harness role: ${role}`);
  return { metadata: { ...manifest, fingerprint, role }, instruction: `${texts.common}\n\n${texts[role]}` };
}

// Keep raw evidence references available without copying each author's entire persuasive report.
export function handoffContext(job) {
  const independent = ['qa', 'owner_audit'].includes(job.stage);
  return (job.context ?? []).slice(-8).map(({ stage, result = {} }) => ({ stage,
    outcome: result.outcome, environmentEvidence: result.environmentEvidence, schemaEvidence:result.schemaEvidence, evidenceRecords: result.evidenceRecords, toolResultCatalog: result.toolResultCatalog, workspace: result.workspace,
    harness: result.harness, investigation: result.investigation, investigationPause: result.investigationPause,
    runtimeDiscoveries: result.runtimeDiscoveries, websiteMismatch: result.websiteMismatch,
    handoff: result.handoff,
    verifiedArtifacts: result.verifiedArtifacts,
    verification: result.verification?.map(({ command, code }) => ({ command, code })),
    ...(independent ? { note: '上游自报checks仅是主张；独立读取工件、diff与原始测试证据。' }
      : { summary: result.summary, finalMessage: result.finalMessage?.slice(0, 6000) }),
  }));
}

const kinds = new Set(['prd', 'spec', 'code', 'test', 'report', 'decision']);
const statuses = new Set(['passed', 'failed', 'not_run', 'not_applicable']);
const owners = new Set(['none', 'owner', 'pm', 'developer', 'qa', 'auditor']);
const nonempty = (s) => typeof s === 'string' && s.trim().length > 0;
const inside = (root, candidate) => { const rel = path.relative(root, candidate); return rel && !rel.startsWith('..') && !path.isAbsolute(rel); };

export async function validateHandoff(job, result, workspace, {dataDir} = {}) {
  const issues = [], verifiedArtifacts = [];
  const h = result.handoff;
  if (!h || !Array.isArray(h.artifacts) || !Array.isArray(h.checks) || !Array.isArray(h.risks) || !owners.has(h.returnTo)) {
    return { issues: ['缺少完整结构化交接材料'], verifiedArtifacts };
  }
  if (h.artifacts.length > 60 || h.checks.length > 60 || h.risks.length > 30) return { issues: ['交接材料超过条目上限'], verifiedArtifacts };
  if (h.risks.some((risk) => !nonempty(risk))) issues.push('风险必须为非空描述');
  const root = await realpath(workspace);
  for (const item of h.artifacts) {
    try {
      if (!kinds.has(item.kind) || !nonempty(item.path) || path.isAbsolute(item.path) || /^[a-z]:/i.test(item.path) || item.path.includes(':')) throw new Error();
      const segments = item.path.replaceAll('\\', '/').split('/');
      if (segments.some((s) => ['..', '.git', 'node_modules'].includes(s) || /^(\.env(?:\..*)?|\.npmrc|settings\.xml|auth\.json|.*\.(?:pem|key|p12))$/i.test(s))) throw new Error();
      const registered = item.kind === 'report' && job.reportFiles?.find(f => item.path === f.filename || item.path === f.id);
      if (registered) {
        if (!dataDir) throw new Error('REPORT_LOCATION');
        if (job.questionGeneration !== undefined && registered.questionGeneration !== undefined && job.questionGeneration !== registered.questionGeneration) throw new Error('REPORT_GENERATION');
        const sourceJobId = registered.sourceJobId ?? job.id;
        await reportFile(dataDir, sourceJobId, registered, {includeContent:false});
        verifiedArtifacts.push({kind:'report',path:registered.filename,namespace:'task-report',fileId:registered.id,sourceJobId,sha256:registered.sha256,bytes:registered.bytes,verificationHash:registered.verificationHash});
        continue;
      }
      if (item.kind === 'report' && /^report-[a-f0-9-]{36}(?:\.csv)?$/.test(item.path)) throw new Error('REPORT_UNREGISTERED');
      const candidate = path.resolve(root, item.path);
      if (!inside(root, candidate)) throw new Error();
      const resolved = await realpath(candidate);
      if (!inside(root, resolved)) throw new Error();
      const info = await stat(resolved);
      if (!info.isFile()) throw new Error();
      verifiedArtifacts.push({ kind: item.kind, path: path.relative(root, resolved).replaceAll('\\', '/'), sha256: await hashFile(resolved), bytes: info.size });
    } catch (error) { issues.push(item?.kind === 'report' && /^report-/.test(item.path ?? '') ? '登记报表的任务归属、文件或核验摘要未通过；请核对任务导出记录，不重新查询数据库' : '源码或文档工件不存在、超出工作区或属于禁止路径；请核对工件清单'); }
  }
  const seen = new Set();
  for (const check of h.checks) {
    if (!check || typeof check !== 'object') { issues.push('验收项格式无效'); continue; }
    if (!nonempty(check.id) || seen.has(check.id) || typeof check.required !== 'boolean' || !statuses.has(check.status) || !nonempty(check.evidence)) issues.push('验收项需唯一编号、明确状态与非空证据');
    seen.add(check.id);
    if (result.outcome === 'ready' && check.required && check.status !== 'passed') issues.push(`必需验收项未通过：${check.id}`);
    if (result.outcome === 'partial' && check.required && check.status === 'failed') issues.push(`必需验收项失败：${check.id}`);
  }
  if (job.taskIntent === 'analysis' && result.outcome === 'ready'
    && result.investigation?.goals?.some(goal => goal.id === QUESTION_GOAL_ID)
    && !h.checks.some(check => check?.id === QUESTION_GOAL_ID && check.required && check.status === 'passed' && nonempty(check.evidence)))
    issues.push('原问题验收项缺少通过依据');
  if (['ready', 'partial'].includes(result.outcome)) {
    if (h.returnTo !== 'none') issues.push('存在退回责任时不能标记ready或partial');
    if (!h.checks.length) issues.push('ready必须给出本阶段检查依据');
    if (job.taskIntent !== 'analysis') {
      if (job.stage === 'pm' && !['prd', 'spec'].every((kind) => verifiedArtifacts.some((a) => a.kind === kind))) issues.push('PM交接缺少实际PRD或Spec');
      if (job.stage === 'developer' && (job.taskIntent ?? 'implementation') === 'implementation' && !verifiedArtifacts.some((a) => a.kind === 'spec')) issues.push('开发交接缺少实际Spec');
      if (['developer', 'qa'].includes(job.stage) && !h.checks.some((c) => c?.status === 'passed' && c.required)) issues.push('开发/测试缺少必需验证的通过依据');
    }
  }
  if (result.outcome === 'partial') {
    if (job.taskIntent !== 'analysis') issues.push('partial只允许只读分析');
    const questionScoped = result.investigation?.goals?.some(goal => goal.id === QUESTION_GOAL_ID);
    if (!verifiedArtifacts.length || !h.checks.some((c) => c?.status === 'passed' && (questionScoped || c.required)) || !h.risks.length)
      issues.push('部分分析必须有可核验工件、已通过的检查及明确证据缺口');
  }
  return { issues: [...new Set(issues)], verifiedArtifacts };
}

export function enforceHandoff(result, gate) {
  if (!gate.issues.length) return { ...result, verifiedArtifacts: gate.verifiedArtifacts, handoffGate: { passed: true } };
  return { ...result, outcome: 'blocked', summary: '本阶段交接检查未通过，尚不能交付。需补齐或修正工件与验收证据，具体原因见详情。',
    finalMessage: `交接检查未通过：\n${gate.issues.map((s) => `- ${s}`).join('\n')}\n\n原阶段报告（不代表已通过）：\n${result.finalMessage}`,
    verifiedArtifacts: gate.verifiedArtifacts, handoffGate: { passed: false, issues: gate.issues } };
}

// Summarizing a partial investigation must not silently erase its known gaps.
export function preserveAnalysisGaps(job, result) {
  if (job.taskIntent !== 'analysis' || job.stage !== 'owner_report' || !['ready', 'partial'].includes(result.outcome)) return result;
  const prior = [...(job.context ?? [])].reverse().find((entry) => entry.result?.outcome === 'partial')?.result;
  if (!prior || !result.handoff) return result;
  if (investigationComplete(job, result)) return result;
  const risks = [...new Set([...(prior.handoff?.risks ?? []), ...(result.handoff.risks ?? [])])];
  return { ...result, outcome: 'partial',
    summary: `部分分析完成，仍有待核实项。${result.summary ?? ''}`.slice(0, 1200),
    finalMessage: `${result.finalMessage}\n\n仍未核实（沿用本轮调查）：\n${risks.map((risk) => `- ${risk}`).join('\n')}`,
    handoff: { ...result.handoff, risks,
      artifacts: result.handoff.artifacts?.length ? result.handoff.artifacts : prior.handoff?.artifacts ?? [] } };
}

// Rows have already been credential-filtered by environment-result-presentation.
// Keep them as structured audit evidence. The answering agent must turn the
// relevant fields into business prose instead of dumping database rows after
// the user-facing conclusion.
export function preserveEnvironmentEvidence(job, result) {
  if (job.taskIntent !== 'analysis' || !['ready', 'partial'].includes(result.outcome)) return result;
  const evidence = [...(job.context ?? [])].reverse().find(entry => entry.result?.evidenceRecords?.length)?.result?.evidenceRecords;
  const schemas=(job.context??[]).flatMap(entry=>entry.result?.schemaEvidence??[]);
  if (!evidence?.length&&!schemas.length) return result;
  return { ...result,...(evidence?.length?{evidenceAppendix:evidence.slice(0,20)}:{}),...(schemas.length?{schemaEvidence:schemas}:{}) };
}
