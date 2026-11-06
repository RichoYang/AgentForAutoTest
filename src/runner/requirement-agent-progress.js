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
  const target = gapTarget(tool, args);
  // A new bundle of review errors does not erase a still unresolved field gap.
  const groups = allFindings.length ? allFindings.map(finding => [finding]) : [[]];
  const updated = groups.map(findings => {
  const codes = findings.length ? findings.map(item => item.code || item.field).sort()
    : [error.code ?? 'tool_error', ...(error.fields ?? [error.safeMessage ?? error.message]).map(field => field.replace(/agent-[a-f0-9]+/g, '#'))];
  const id = digest([tool, target, findings.length ? findings.map(item => item.field) : codes]);
  const previous = current.gaps[id];
  const repeated = previous && !previous.resolved;
  const gap = { id, tool, target, codes, operation: args.operation, businessKey: args.businessKey, disposition: error.review?.disposition ?? 'invalid_contract',
    evidenceVersion, evidenceChanges: (previous?.evidenceChanges ?? 0) + Number(Boolean(previous && previous.evidenceVersion !== evidenceVersion)),
    attempts: (previous?.attempts ?? 0) + 1, unchanged: repeated ? previous.unchanged + 1 : 0,
    firstAt: previous?.firstAt ?? new Date().toISOString(), lastAt: new Date().toISOString(),
    missing: findings.length ? findings.map(item => ({ field: item.field, reason: item.reason, next: item.next })) : error.fields ?? [error.safeMessage ?? error.message],
    confirmed: { coverage: checkCoverage(current), aliases: Object.keys(current.aliases ?? {}), preflightChecks: Object.keys(current.preflights ?? {}) },
    next: '补查对应源码/Schema/原始完整性证据，或采用不同调查入口；不能只改回答、SQL写法或添加无关观测。无法证明基线时先恢复再重执行。', resolved: false };
  current.gaps[id] = gap;
  return gap;
  });
  return updated.sort((a, b) => b.unchanged - a.unchanged)[0];
}

export function resolveGaps(current, tool, args) {
  const target = gapTarget(tool, args);
  for (const gap of Object.values(current.gaps ?? {})) if (gap.tool === tool && (gap.target === target
    || tool === 'test_mutate' && args.businessKey && gap.businessKey === args.businessKey && gap.operation === args.operation)) {
    gap.resolved = true; gap.resolvedAt = new Date().toISOString();
    if (gap.target !== target) gap.supersededBy = target;
  }
}
