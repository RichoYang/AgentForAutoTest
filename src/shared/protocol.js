import { randomUUID } from 'node:crypto';

export const WORKFLOWS = {
  requirement_test: ['requirement_test'],
  analysis_review: ['developer', 'owner_report'],
  continuous_analysis: ['developer'],
  full_delivery: ['owner_intake', 'pm', 'developer', 'qa', 'owner_audit', 'owner_report'],
  pm_delivery: ['pm', 'developer', 'qa', 'owner_audit', 'owner_report'],
  developer_delivery: ['developer', 'qa', 'owner_audit', 'owner_report'],
  qa_audit: ['qa', 'owner_audit', 'owner_report'],
  owner_audit: ['owner_audit', 'owner_report'],
  owner_report: ['owner_report'],
};

// Legacy local /api/v1/dev/messages simulator only. Live Feishu traffic uses AI decisions.
const IMPLEMENTATION_ACTION = /(修改|改一下|改代码|写代码|编码|开发|实现|调整(?:一下)?(?:代码|接口|页面|逻辑)?|重构|补(?:充)?代码|提交代码|修一下|处理.{0,12}(?:报错|缺陷|bug))/i;
const VERIFICATION_ACTION = /(测试|验证|回归|验收|复现|检查|确认).{0,12}(?:修复|修改|改动|结果|功能|接口|页面|代码)/i;

const ROLE_RULES = [
  { stage: 'owner_audit', workflow: 'owner_audit', pattern: /审计|auditor|audit/i },
  { stage: 'owner_intake', workflow: 'full_delivery', pattern: /项目负责人|负责人|owner/i },
  { stage: 'pm', workflow: 'pm_delivery', pattern: /(?:^|[\s：:，,])pm(?:$|[\s：:，,])|产品经理|产品/i },
  { stage: 'developer', workflow: 'developer_delivery', pattern: /开发|研发|developer|dev/i },
  { stage: 'qa', workflow: 'qa_audit', pattern: /测试|tester|qa/i },
];

export function routeInstruction(rawText) {
  const text = String(rawText ?? '').replace(/\s+/g, ' ').trim();
  const matched = ROLE_RULES.find((rule) => rule.pattern.test(text));
  if (!matched) {
    return { matched: false, stage: 'owner_intake', workflow: 'full_delivery', instruction: text };
  }
  const instruction = text
    .replace(matched.pattern, '')
    .replace(/^[\s：:，,、-]+/, '')
    .trim() || text;
  return routeInstructionForStage(instruction, matched.stage);
}

export function workflowForStage(stage) {
  return ({
    owner_intake: 'full_delivery',
    pm: 'pm_delivery',
    developer: 'developer_delivery',
    qa: 'qa_audit',
    owner_audit: 'owner_audit',
    owner_report: 'owner_report',
  })[stage] ?? 'full_delivery';
}

export function routeInstructionForStage(rawText, stage) {
  const text = String(rawText ?? '').replace(/\s+/g, ' ').trim();
  const intent = instructionIntent(text);
  if (['qa', 'owner_audit'].includes(stage) && intent === 'implementation') {
    return {
      matched: true,
      stage: 'owner_intake',
      workflow: 'full_delivery',
      instruction: text,
      requestedStage: stage,
      delegated: true,
      delegationReason: `${stageLabel(stage)}不直接修改业务代码，已转交项目负责人进行范围判断与任务编排`,
    };
  }
  return {
    matched: true,
    stage,
    workflow: workflowForStage(stage),
    instruction: text,
    requestedStage: stage,
    delegated: false,
  };
}

export function instructionIntent(rawText) {
  const text = String(rawText ?? '').replace(/\s+/g, ' ').trim();
  if (VERIFICATION_ACTION.test(text)) return 'verification';
  if (IMPLEMENTATION_ACTION.test(text)) return 'implementation';
  if (/修复/i.test(text)) return 'implementation';
  return 'general';
}

export function createId(prefix) {
  const time = new Date().toISOString().replace(/\D/g, '').slice(0, 14);
  return `${prefix}-${time}-${randomUUID().slice(0, 6)}`;
}

export function sanitizeSegment(value) {
  return String(value).toLowerCase().replace(/[^a-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 80);
}

export function nextStage(workflow, currentStage) {
  const stages = WORKFLOWS[workflow] ?? [currentStage];
  const index = stages.indexOf(currentStage);
  return index >= 0 && index < stages.length - 1 ? stages[index + 1] : null;
}

export function stageLabel(stage) {
  return ({
    requirement_test: '需求测试',
    owner_intake: '项目负责人受理',
    pm: 'PM需求与Spec',
    developer: '开发实现',
    qa: '测试验收',
    owner_audit: '独立审计',
    owner_report: '项目负责人汇报',
  })[stage] ?? stage;
}
