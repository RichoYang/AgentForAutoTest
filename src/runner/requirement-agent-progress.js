import { digest } from './requirement-feishu.js';

const gapTarget = (tool, args) => tool === 'test_mutate' && args.operation && args.businessKey
  ? args.operation + ':' + args.businessKey
  : args.checkId ?? args.id ?? args.alias ?? args.operation ?? args.name ?? args.table
    ?? (tool === 'test_evidence' ? args.evidenceRef ?? args.observationId : undefined) ?? tool;

export function checkCoverage(current) {
  const checks = current.plan?.checks ?? [];
  const status = checks.map(check => {
    const attempts = current.assertions?.[check.id] ?? [];
    const latest = attempts.findLast(item => item.compared);
    return { checkId: check.id, attempts: attempts.length, current: latest ? latest.passed ? 'passed' : 'failed' : 'unmeasured',
      historicalFailure: attempts.some(item => item.compared && !item.passed) };
  });
  return { total: checks.length, compared: status.filter(item => item.current !== 'unmeasured').length,
    passed: status.filter(item => item.current === 'passed').length, failed: status.filter(item => item.current === 'failed').length,
    processTotal: current.plan?.processChecks?.length ?? 0,
    processProven: (current.plan?.processChecks ?? []).filter(check => current.processProofs?.[check.id]?.proven).length,
    historicalAttempts: status.reduce((sum, item) => sum + item.attempts, 0), checks: status };
}

// Successful unrelated observations and differently worded answers do not close
// a gap. Only a successful operation for that target closes it. Even changed
// evidence is not progress if the review still identifies the same missing field.
export function recordGap(current, { tool, args, error, evidenceVersion }) {
  current.gaps ??= {};
  const allFindings = error.review?.findings ?? [];
  const target = error.gapTarget??gapTarget(tool, args);
  // A new bundle of review errors does not erase a still unresolved field gap.
  const groups = allFindings.length ? allFindings.map(finding => [finding]) : [[]];
  const updated = groups.map(findings => {
  const codes = findings.length ? findings.map(item => item.code || item.field).sort()
    : [error.code ?? 'tool_error', ...(error.fields ?? [error.safeMessage ?? error.message]).map(field => field.replace(/agent-[a-f0-9]+/g, '#'))];
  const id = digest([tool, target, findings.length ? findings.map(item => item.field) : codes]);
  const previous = current.gaps[id];
  const repeated = previous && !previous.resolved;
  // One model batch may submit sibling checks before receiving any rejection.
  // Group the shared diagnosis, but keep the pre-existing per-target repeat
  // threshold rather than making the third sibling's first call fatal.
  const member = gapTarget(tool, args);
  const resolvedTargets = (previous?.resolvedTargets ?? []).filter(item => item !== member);
  const targetAttempts = error.gapTarget ? { ...(repeated ? previous.targetAttempts : {}),
    [member]: (repeated && !previous.resolvedTargets?.includes(member) ? previous.targetAttempts?.[member] ?? 0 : 0) + 1 } : undefined;
  const gap = { id, tool, target, codes, operation: args.operation, businessKey: args.businessKey, disposition: error.review?.disposition ?? 'invalid_contract',
    evidenceVersion, evidenceChanges: (previous?.evidenceChanges ?? 0) + Number(Boolean(previous && previous.evidenceVersion !== evidenceVersion)),
    attempts: (previous?.attempts ?? 0) + 1, ...(targetAttempts?{targetAttempts}:{}),
    unchanged:targetAttempts?targetAttempts[member]-1:repeated?previous.unchanged+1:0,
    firstAt: previous?.firstAt ?? new Date().toISOString(), lastAt: new Date().toISOString(),
    missing: findings.length ? findings.map(item => ({ field: item.field, reason: item.reason, next: item.next })) : error.fields ?? [error.safeMessage ?? error.message],
    confirmed: { coverage: checkCoverage(current), aliases: Object.keys(current.aliases ?? {}), preflightChecks: Object.keys(current.preflights ?? {}),...(error.stageEvidence?{pageStage:error.stageEvidence}:{}) },
    next: '补查对应源码/Schema/原始完整性证据，或采用不同调查入口；不能只改回答、SQL写法或添加无关观测。无法证明基线时先恢复再重执行。', resolved: false,
    ...(error.gapScope === 'shared_observation' ? { scope: error.gapScope, resolvedTargets, details: error.gapDetails,
      next: '按关联检查重新读取冻结后对应阶段的独立业务观测，再逐项断言。若前态已改变，只能使用原始合格观测或恢复重做。' } : {}),
    ...(error.code === 'action_baseline_missing' ? { disposition: 'missing_evidence', details: error.gapDetails,
      next: '先在对应渠道回读并比较所列前态检查，再重试该动作。' } : {}) };
  current.gaps[id] = gap;
  return gap;
  });
  return updated.sort((a, b) => b.unchanged - a.unchanged)[0];
}

export function resolveGaps(current, tool, args) {
  const target = gapTarget(tool, args);
  const stage=current.plan?.checks.find(check=>check.id===args.checkId)?.pageStage;
  for (const gap of Object.values(current.gaps ?? {})) {
    if (gap.tool !== tool || gap.resolved) continue;
    if (gap.scope === 'shared_observation') {
      if (!Object.hasOwn(gap.targetAttempts, target)) continue;
      gap.resolvedTargets = [...new Set([...gap.resolvedTargets, target])];
      if (Object.keys(gap.targetAttempts).some(member => !gap.resolvedTargets.includes(member))) continue;
    } else if (!(gap.target === target
    || stage&&gap.target==='page_stage:'+stage
    || tool === 'test_mutate' && args.businessKey && gap.businessKey === args.businessKey && gap.operation === args.operation)) continue;
    gap.resolved = true; gap.resolvedAt = new Date().toISOString();
    if (gap.target !== target) gap.supersededBy = target;
  }
}
