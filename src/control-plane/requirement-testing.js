import { createHash } from 'node:crypto';
import { notifyJobEvent } from './server.js';
import { requirementOptions, resolveRequirementOptions } from '../shared/requirement-options.js';

export const REQUIREMENT_TEST = 'requirement_test';
const openId = /^ou_[a-zA-Z0-9]+$/;

export function validateRequirementRoutes(projects, agents) {
  const routes = new Map();
  for (const [projectId, project] of Object.entries(projects.projects)) {
    const test = project.requirementTest;
    if (!test) continue;
    const { bot, document, allowedChatIds, requesterOpenIds } = test;
    const matches = Object.values(agents.agents).filter(agent => agent.profile === bot?.profile && agent.openId === bot?.openId);
    if (matches.length !== 1 || !openId.test(bot.openId) || !/^cli_[a-z0-9]+$/.test(bot.appId)
      || routes.has(bot.profile) || !document?.profile || document.profile === bot.profile
      || !openId.test(document.openId) || !/^cli_[a-z0-9]+$/.test(document.appId)
      || !Array.isArray(allowedChatIds) || !allowedChatIds.length
      || allowedChatIds.some(id => projects.chatProjectMap[id] !== projectId || !projects.topicChatIds?.includes(id))
      || !Array.isArray(requesterOpenIds) || !requesterOpenIds.length || requesterOpenIds.some(id => !openId.test(id))) {
      throw new Error('Invalid requirement testing identity or project binding: ' + projectId);
    }
    routes.set(bot.profile, { projectId, project, test });
  }
  return routes;
}

export function requirementLinks(content, domain) {
  const urls = new Set();
  for (const match of String(content ?? '').matchAll(/https:\/\/[a-z0-9.-]+\/(?:docx|wiki)\/[A-Za-z0-9]+/gi)) {
    const url = new URL(match[0]);
    if (url.hostname === domain) urls.add(url.href);
  }
  return [...urls];
}

export async function handleRequirementMessage(context, event) {
  const route = context.requirementRoutes.get(event.agent_profile);
  if (!route) return null;
  const { projectId, project, test } = route;
  const { bot } = test;
  if (event.receiving_app_id !== bot.appId || event.receiving_bot_id !== bot.openId
    || event.chat_type !== 'group' || !test.allowedChatIds.includes(event.chat_id)
    || !test.requesterOpenIds.includes(event.sender_id) || !/^om_[a-zA-Z0-9_-]+$/.test(event.message_id ?? '')) {
    return { ignored: true, reason: 'requirement_identity_scope' };
  }
  const ids = new Set((event.mentions ?? []).map(m => m.id?.open_id ?? m.id ?? m.open_id).filter(Boolean));
  if (ids.size && !ids.has(bot.openId)) return { ignored: true };
  const root = event.root_id ?? event.thread_id ?? event.message_id;
  const text = requirementCommandText(event.content, event.mentions);
  const clarification = text.match(/^确认图示\s+(IMGQ-[a-f0-9]{12})\s+(.+)$/s);
  const command = clarification ? 'material_confirm' : requirementCommand(text);
  if (ids.size > 1) return reply('请在话题中只 @ 一个智能体，再发送需求链接。');
  const links = requirementLinks(event.content, test.document.domain);
  if (links.length > 1) return reply('每个话题只接受一份需求，请在单独话题中发起。');
  let options;
  if (links.length && ids.has(bot.openId)) {
    try {
      options = requirementOptions(event.content);
      resolveRequirementOptions(test, options);
    } catch (error) { return reply(error.message); }
  }
  const input = {
    projectId, projectName: project.displayName, chatId: event.chat_id, originChatType: 'group',
    sourceMessageId: event.message_id, replyToMessageId: event.message_id, senderId: event.sender_id,
    agentRole: REQUIREMENT_TEST, agentProfile: bot.profile, workflow: REQUIREMENT_TEST, stage: REQUIREMENT_TEST,
    taskIntent: REQUIREMENT_TEST, instruction: '需求测试',
    requirement: { root, threadId: event.thread_id ?? null, parent: event.reply_to ?? event.parent_id ?? null, url: links[0] ?? null,
      ...(clarification ? { materialConfirmation: { id: clarification[1], answer: clarification[2].trim() } } : {}),
      ...(options && Object.keys(options).length ? { options } : {}) },
  };
  const result = await context.store.createJob({ ...input, requirementCommand: command, requirementAddressed: ids.has(bot.openId) });
  if (result?.duplicate) return { duplicate: true };
  if (result?.current) {
    if (result.changed) {
      await notifyJobEvent(context, { job: result.current, event: { type: result.current.status === 'cancelling' ? 'cancel_requested' : 'progress', phase: 'tool_activity' } });
    }
    return reply(requirementStatus(result.current, result.reason, test));
  }
  if (result?.job) {
    await notifyJobEvent(context, { job: result.job, event: { type: 'queued' } });
    return { jobId: result.job.id };
  }
  if (result?.reason === 'different_requirement') return reply('本话题已绑定另一份需求，请为新需求发起独立话题。');
  if (result?.reason === 'requirement_requester_mismatch' && ids.has(bot.openId)) return reply('请由原任务发起人在本话题操作。');
  if (ids.has(bot.openId) && command) return reply('本话题未找到可操作的需求测试任务。请回到原任务话题。');
  if (result?.reason === 'missing_requirement' && ids.has(bot.openId)) return reply('请提供一份本租户的飞书需求文档链接。');
  return { ignored: true, reason: result?.reason ?? 'requirement_unaddressed' };

  async function reply(message) {
    const key = createHash('sha256').update(event.message_id + bot.profile).digest('hex').slice(0, 28);
    await context.feishu.reply(event.message_id, message, { profile: bot.profile, replyInThread: true, idempotencyKey: 'qa-' + key });
    return { replied: true };
  }
}

function requirementCommandText(content, mentions = []) {
  let text = String(content ?? '');
  for (const { key, name } of mentions) {
    if (key) text = text.replaceAll(key, ' ');
    if (name) text = text.replaceAll('@' + name, ' ');
  }
  return text.replace(/@_user_\d+/g, '').trim().replace(/[。！!？?]+$/, '');
}

function requirementCommand(text) {
  if (/^(?:请)?重试(?:未执行|未执行用例|未执行的用例)$/.test(text)) return 'retry_unexecuted';
  if (/^(?:请)?重试(?:失败|失败用例|失败的用例)$/.test(text)) return 'retry_failed';
  if (/^(?:请)?(?:继续|恢复)(?:测试|任务|执行|运行)?(?:一下|吧)?$/.test(text)) return 'resume';
  if (/^(?:请)?(?:暂停|取消|停止)(?:测试|任务|执行|运行)?(?:一下|吧)?$/.test(text)) return text.includes('暂停') ? 'pause' : 'cancel';
  if (text === '恢复清理' || text === '继续清理') return 'cleanup';
  if (text === '确认项目') return 'confirm';
  if (/进度|状态|卡在|阻塞|受阻|到哪|为什么.{0,8}(?:停|失败)|还剩/.test(text)) return 'status';
  return null;
}

function requirementStatus(job, reason, settings) {
  const labels = { queued: '等待执行', running: '执行中', cancelling: '等待旧进程退出', paused: '已暂停',
    awaiting_clarification: '待补充或解除阻塞', completed: '已完成', cancelled: '已取消', failed: '执行中断', blocked: '任务受阻' };
  const started = job.events.findLastIndex(event => event.type === 'started');
  const progress = job.events.slice(Math.max(started, 0)).findLast(event => event.type === 'progress' && event.activity)?.activity;
  const instructions = {
    requirement_unknown_command: '可回复「当前进度」「当前阻塞」「继续测试」「暂停测试」「取消测试」「恢复清理」「重试未执行」或「重试失败」。',
    requirement_confirmation_required: '解除阻塞需先回复「确认项目」。',
    requirement_material_confirmation: '请按上面的待确认项回复「确认图示 问题编号 答复」，或回复「恢复清理」。',
    requirement_invalid_transition: '当前状态不允许此操作。暂停或阻塞解除后可回复「继续测试」。已取消的任务有待清理数据时可回复「恢复清理」。',
    requirement_stopping: '已发出停止请求。旧进程退出后可按状态继续或恢复清理。',
  };
  const wait = job.result?.requirementWait;
  const resumeNote = wait === 'deployment_baseline' ? '上次停在发布核验。可回复「继续测试」接续原用例，发布证据缺口随报告记录。'
    : wait === 'execution_adapter' && (settings.execution || settings.adapter) ? '执行入口现已配置，可回复「继续测试」。' : '';
  return [job.id + ' · ' + (labels[job.status] ?? job.status),
    progress?.current ? '最近阶段 ' + progress.current + (progress.total ? '（' + progress.completed + '/' + progress.total + '）' : '') : '',
    resumeNote, job.result?.finalMessage && (resumeNote ? '上次任务回执\n' : '') + job.result.finalMessage,
    instructions[reason]].filter(Boolean).join('\n');
}
