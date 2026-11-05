import path from 'node:path';
import { digest, RequirementWait } from './requirement-feishu.js';
import { writeJson } from './requirement-files.js';

export function planErrors(plan, operations) {
  const errors = [];
  if (!plan || typeof plan !== 'object' || Array.isArray(plan)) return ['$ must be an object'];
  if (!Array.isArray(plan.steps)) errors.push('$.steps must be an array');
  if (!Array.isArray(plan.missing)) errors.push('$.missing must be an array of strings');
  else plan.missing.forEach((item, i) => { if (typeof item !== 'string') errors.push(`$.missing[${i}] must be a string`); });
  for (const [i, step] of (Array.isArray(plan.steps) ? plan.steps : []).entries()) {
    const at = `$.steps[${i}]`;
    if (!step || !Object.hasOwn(operations, step.operation)) errors.push(at + '.operation is not registered');
    if (!step?.input || typeof step.input !== 'object' || Array.isArray(step.input)) errors.push(at + '.input must be an object');
    if (!Array.isArray(step?.checks)) errors.push(at + '.checks must be an array');
    else step.checks.forEach((check, j) => {
      if (!Array.isArray(check?.field) || !check.field.length) errors.push(`${at}.checks[${j}].field must be a non-empty path array`);
      if (!Number.isInteger(check?.assertion) || check.assertion < 1) errors.push(`${at}.checks[${j}].assertion must be a positive integer`);
    });
  }
  return errors;
}

// A repeated identical failed candidate is lack of progress, not an arbitrary retry budget.
export async function repairPlan({ generate, prompt, options, operations, scope, normalize }) {
  const failed = new Set();
  let correction;
  let attempt = 0;
  for (;;) {
    let candidate, parseError;
    try { candidate = await generate(prompt + (correction ? '\n修正上次输出：\n' + JSON.stringify(correction) : ''), { ...options,
      async onOutput(raw) {
        if (options.workDir) await writeJson(path.join(options.workDir, `plan-raw-${digest(scope.item.caseId).slice(0, 16)}-${Date.now()}.json`),
          { caseId: scope.item.caseId, output: scope.checkOutput(raw) });
      } }); } catch (error) {
      if (typeof error.rawOutput !== 'string') throw error;
      candidate = scope.checkOutput(error.rawOutput); parseError = '$ must be valid JSON: ' + error.message;
    }
    const errors = parseError ? [parseError] : planErrors(candidate, operations);
    let steps;
    if (!errors.length) {
      try { steps = normalize(candidate, operations); }
      catch (error) { if (!(error instanceof RequirementWait)) throw error; errors.push(error.message); }
    }
    const safe = scope.checkOutput(candidate);
    const evidence = { attempt: ++attempt, caseId: scope.item.caseId, candidate: safe, errors, corrected: Boolean(correction) && !errors.length };
    if (options.workDir) await writeJson(path.join(options.workDir, `plan-${digest(scope.item.caseId).slice(0, 16)}-${Date.now()}-${attempt}.json`), evidence);
    if (!errors.length) return { plan: candidate, steps };
    const signature = digest([candidate, errors]);
    if (failed.has(signature)) {
      const error = new RequirementWait('execution_plan', '执行计划重复未修正：' + errors.join('；'));
      error.validationDetails = errors;
      throw error;
    }
    failed.add(signature);
    correction = { previous: safe, errors, instruction: '保留用例全部业务要求，仅修正结构和已登记操作引用。missing 为字符串数组，steps 必须为数组。' };
  }
}
