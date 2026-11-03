import {contactProgressText} from './contact-progress.js';
import { failureDiagnostic } from '../shared/failure-diagnostic.js';
import { stageLabel } from '../shared/protocol.js';
import { createHash } from 'node:crypto';
import { publicText, conciseSummary, conversationPrimaryCardElements, analysisPrimaryCardElements, summaryParagraphs, resultPages, resultPanel, PRIMARY_RESPONSE_LIMIT } from './result-presentation.js';
export { publicText } from './result-presentation.js';

export function jobActionVersion(job) {
  return createHash('sha256').update((job.questionId ? `${job.id}|${job.environmentAccess ? `${job.environmentAccess.scopeHash}|` : ''}` : '') + (job.events ?? []).filter((e) => ['started', 'clarification_received', 'environment_renewal_requested'].includes(e.type))
    .map((e) => e.id ?? e.at).join('|')).digest('hex').slice(0, 16);
}

function actionButton(job, action, label, type = 'default') {
  const button = { tag: 'button', type, width: 'fill', text: { tag: 'plain_text', content: label },
    behaviors: [{ type: 'callback', value: { action, version: jobActionVersion(job) } }] };
  if (['cancel', 'approve', 'approve_environment'].includes(action)) button.confirm = {
    title: { tag: 'plain_text', content: label },
    text: { tag: 'plain_text', content: action === 'approve_environment' ? '仅批准卡片展示的环境、模板、参数和限额；结果将在本群卡片显示，不授权任何修改。' : action === 'cancel' ? '停止后保留已有文件修改，不会回滚代码。确定继续？' : '确认当前阶段结论通过，并将任务交给下一角色执行？' },
  };
  return button;
}

export const CARD_TEXT_LIMIT = 3500;
const clip = (text, n) => Array.from(String(text ?? '')).slice(0, n).join('');
const md = (content, small = false) => ({ tag: 'markdown', content, text_size: small ? 'notation' : 'normal', margin: '0px' });
export function cumulativeToolCalls(events=[]){
  let total=0,segmentMax=0;
  for(const event of events){
    if(event.type==='started'||event.type==='continuous_environment_started'||event.type==='continuous_environment_completed'
      ||event.type==='codex_event'&&event.event?.type==='turn.started')segmentMax=0;
    if(event.phase!=='tool_activity')continue;
    const next=Number(event.activity?.total);
    if(!Number.isFinite(next)||next<0)continue;
    if(next<segmentMax)segmentMax=0;
    total+=Math.max(0,next-segmentMax);segmentMax=Math.max(segmentMax,next);
  }
  return total;
}
const block = (elements, color = 'grey') => ({ tag: 'column_set', flex_mode: 'none', columns: [
  { tag: 'column', width: 'weighted', weight: 1, padding: '12px', vertical_spacing: '8px',
    background_style: `${color}-50`, elements },
] });
function card(title, subtitle, color, elements) {
  return { schema: '2.0', config: { update_multi: true, width_mode: 'default', summary: { content: title } },
    header: { title: { tag: 'plain_text', content: title }, subtitle: { tag: 'plain_text', content: clip(subtitle, 100) },
      template: color, icon: { tag: 'standard_icon', token: 'ai-common_colorful' } },
    body: { direction: 'vertical', padding: '12px', vertical_spacing: '12px', elements } };
}
export function resultSummary(text) {
  return conciseSummary(text);
}
export function resultParts(text) {
  // Escape only AFTER slicing: never cut an HTML entity, and keep overflow lossless.
  const points = Array.from(publicText(text));
  // Slice sanitized text so credentials cannot straddle the primary/overflow boundary.
  let cut = Math.min(CARD_TEXT_LIMIT, points.length);
  const start = points.slice(0, cut).join('');
  const amp = start.lastIndexOf('&');
  if (amp > start.lastIndexOf(';') && start.slice(amp).length < 10) cut -= Array.from(start.slice(amp)).length;
  return { primary: points.slice(0, cut).join(''), overflow: points.slice(cut).join('') };
}
export function conversationCard(turn, now = Date.now()) {
  const final = ['ready', 'sent'].includes(turn.status);
  const failed = turn.aiFailed || turn.actionError;
  const state = final ? (failed ? '未执行' : turn.setupCancelled ? '已停止接入' : turn.setupPending ? ({requested:'等待确认接入',scope_required:'登录成功 · 等待范围选择',opening:'正在启动登录',login_required:turn.setupLoginIssue?'登录尚未通过认证':turn.setupHasCredentials?'自动登录中 · 尚未确认成功':'等待提供登录凭据',awaiting_tls_confirmation:'等待确认连接保护'}[turn.setupStatus] ?? '等待补齐接入') : '已回复') : turn.status === 'queued' ? '排队中'
    : turn.connectionWillRetry ? '连接重试中' : '正在处理';
  const color = failed ? 'red' : turn.setupPending ? 'orange' : final ? 'green' : 'blue';
  const content = final ? '' : turn.status === 'queued' ? '等待同一会话前面的消息处理完成。'
    : turn.connectionWillRetry ? '连接暂时异常，Codex 正在重试，尚未得到结果。' : turn.status==='decided'&&turn.decision?.action==='lookup_contact' ? contactProgressText(turn, now) : 'Codex 正在理解你的消息，完成后会更新在这里。';
  const primary = final ? conversationPrimaryCardElements(turn.response) : [];
  const elements = primary.length ? primary.map((element) => element.tag === 'table' ? element : block(summaryParagraphs(element.content).map(part => md(part)), color)) : [block([md(content)], color)];
  if (final && Array.from(turn.response ?? '').length > PRIMARY_RESPONSE_LIMIT) elements.push(resultPanel(resultPages(turn.response)));
  elements.push(md(final ? '补充或追问请在话题中@对应助手；详情翻页只更新展示，不执行任务。'
    : `已等待 ${elapsed(turn.createdAt, now)} · 本卡持续更新`, true));
  return card(`${stageLabel(turn.role)} · ${state}`, 'AgentOS / Codex', color, elements);
}
export function elapsed(start, end = Date.now()) {
  const seconds = Math.max(0, Math.floor((end - Date.parse(start)) / 1000) || 0);
  return seconds < 60 ? `${seconds} 秒` : `${Math.floor(seconds / 60)} 分 ${seconds % 60} 秒`;
}
export function jobCard(job, now = Date.now(), { startAt = job.createdAt } = {}) {
  const expired=job.status==='awaiting_environment_approval' && !(Date.parse(job.environmentAccess?.expiresAt)>now);
  const labels = { running: ['执行中', 'blue'], queued: ['等待执行', 'blue'], completed: ['当前阶段已完成', 'green'],
    awaiting_environment_approval: ['待环境负责人批准查询', 'orange'],
    awaiting_approval: ['待真人确认', 'orange'], awaiting_clarification: ['待补充信息', 'orange'],
    blocked: ['任务受阻 / 未通过', 'red'], failed: ['执行失败', 'red'], cancelled: ['已取消 / 已停止', 'grey'],
    cancelling: ['正在停止', 'orange'], resubmitted: ['补充已提交', 'blue'] };
  const terminalState = ['completed', 'blocked', 'failed', 'cancelled'].includes(job.status);
  const [label, color] = job.status==='completed'&&job.result?.outcome==='needs_clarification' ? ['等待补齐信息 · 尚未完成','orange'] : expired ? ['查询申请已过期 · 可重新申请', 'orange'] : !terminalState && job.result?.browserActionRequired === 'automation' ? ['等待本机浏览器授权 · 放行后自动继续', 'orange'] : !terminalState && job.result?.browserLoginRequired && ['request_blocked','access_check_failed'].includes(job.result.browserLoginState) ? ['登录链路待恢复 · 原任务保留', 'orange'] : !terminalState && job.result?.browserLoginRequired ? ['恢复网页登录 · 登录后自动继续', 'orange'] : job.taskIntent === 'analysis' && job.result?.outcome === 'partial' && ['completed', 'awaiting_approval'].includes(job.status)
    ? ['部分分析完成 · 有待核实', 'orange'] : labels[job.status] ?? ['等待更新', 'grey'];
  const active = ['running', 'queued', 'cancelling'].includes(job.status);
  const events = job.events ?? [];
  const attemptStart = events.filter((e) => e.type === 'started').at(-1)?.at ?? job.createdAt;
  const start = startAt ?? job.createdAt ?? attemptStart;
  const relevant = events.filter((e) => Date.parse(e.at) >= Date.parse(attemptStart));
  const activity = relevant.filter((e) => e.phase === 'tool_activity').at(-1)?.activity;
  const phase = relevant.filter((e) => e.type === 'progress' && e.phase).at(-1)?.phase;
  const operation = job.status === 'cancelling' ? (job.cancellationError ?? (job.cancelReason?.includes('租约过期')?'执行器失联，任务已暂停；需确认原进程退出后收尾，未自动重跑。':null) ?? '已请求停止，等待执行器确认进程退出；已有文件修改将保留。')
    : phase === 'verification' ? '正在运行项目验证命令' : phase === 'connection_retry' ? '连接异常，Codex 正在重试'
      : phase === 'model_capacity_retry' ? '当前模型服务繁忙，正在同一调查会话中自动重试'
    : job.status === 'queued' ? (job.taskIntent === 'analysis' && job.stage === 'developer' ? '开发已接单，等待 Runner 进行只读调查。' : '已接单，等待 Runner 执行。')
    : activity?.current ?? 'Codex 正在准备 / 处理任务';
  const summary = expired ? '本次查询申请已过期，尚未访问环境。点击“重新申请本次查询”后，核对原范围并再次批准；不会自动执行。' : job.status === 'cancelled' ? '任务已取消，已停止继续执行。' : !active && job.result?.finalMessage
    ? job.taskIntent === 'analysis' ? '' : resultSummary(job.result.summary || job.result.finalMessage) : '';
  const analysisElements = !active && job.taskIntent === 'analysis' && job.result?.finalMessage ? analysisPrimaryCardElements(job.result.finalMessage) : [];
  const answerBlocks = analysisElements.length ? analysisElements.map((element) => element.tag === 'table' ? element : block(summaryParagraphs(element.content).map(part => md(part)), color)) : [block([md(`**${active ? '当前操作' : '结论'}**`), ...summaryParagraphs(active ? publicText(clip(operation, 120))
    : summary || (job.status === 'awaiting_approval' ? '请真人管理员查看阶段结论，再点击下方按钮确认进入下一阶段。'
    : job.status === 'awaiting_clarification' ? '需要补充信息，尚未通过当前阶段。'
    : job.status === 'failed' ? failureDiagnostic(job.result?.executionFailure??job.result?.error) : label)).map(part => md(part))], color)];
  if (!answerBlocks.some((element) => element.tag === 'column_set')) answerBlocks.push(block([], color));
  const metadataBlock = [...answerBlocks].reverse().find((element) => element.tag === 'column_set');
  const metadata = metadataBlock?.columns?.[0]?.elements;
  const elements = [...answerBlocks,
    { tag: 'column_set', flex_mode: 'none', horizontal_spacing: '12px', columns: [
      { tag: 'column', width: 'weighted', weight: 1, elements: [md(`**${elapsed(start, active ? now : Date.parse(job.updatedAt))}**`), md('总耗时', true)] },
      { tag: 'column', width: 'weighted', weight: 1, elements: [md(`**${cumulativeToolCalls(relevant)} 次**`), md('累计实际工具调用', true)] },
    ] }];
  if (active && activity?.recent?.length) elements.push(block([md(`**最近完成 · 展示 ${activity.recent.length} / ${Number(activity.completed) || 0} 项**`),
    ...activity.recent.slice(-3).map((item) => md(`${item.failed ? '未通过' : '完成'} · ${publicText(clip(item.label, 120))}`, true))]));
  if (!active && job.result?.finalMessage) elements.push(resultPanel(resultPages(job.result.finalMessage)));
  metadata?.push(md(publicText(job.id), true));
  if (job.taskIntent === 'analysis') metadata?.push(md(job.environmentAccess ? '环境只读查询 · 不修改数据库或配置' : '只读分析 · 不修改代码', true));
  if (job.nextJobId) metadata?.push(md(`已交给项目负责人汇总 · ${publicText(job.nextJobId)}`, true));
  if (job.delegation) metadata?.push(md(`协作：${stageLabel(job.delegation.fromStage)} → ${stageLabel(job.delegation.toStage)}`, true));
  if (job.status === 'awaiting_clarification' && !job.result?.browserLoginRequired) elements.push({ tag: 'form', name: 'clarification_form', elements: [
    { tag: 'input', name: 'clarification', input_type: 'multiline_text', rows: 3, max_length: 1000, required: true,
      width: 'fill', placeholder: { tag: 'plain_text', content: '填写需要补充的范围、路径或验收要求…' } },
    { tag: 'button', name: `clarify_${jobActionVersion(job)}`, form_action_type: 'submit', type: 'primary_filled',
      width: 'fill', text: { tag: 'plain_text', content: '提交补充 · 重新执行当前阶段' } },
  ] });
  if (job.environmentAccess && (active || job.status === 'awaiting_environment_approval')) {
    const p = job.environmentAccess;
    metadata?.push(md(publicText(`环境：${p.environmentId} (${p.tier}) · 模板：${p.queryId}\n范围：${p.description}\n参数：${JSON.stringify(p.parameters)}\n最多 ${p.maxRows} 条 · 超时 ${p.timeoutMs} ms\n授权截止：${p.expiresAt}\n结果在本问题卡片向群内展示；仅本次查询，不授权修改。`), true));
  }
  const buttons = [];
  if (job.status === 'awaiting_environment_approval') buttons.push(actionButton(job, expired ? 'renew_environment' : 'approve_environment', expired ? '重新申请本次查询' : '批准本次只读查询', 'primary_filled'));
  if (job.status === 'awaiting_approval') buttons.push(actionButton(job, 'approve', '确认进入下一阶段', 'primary_filled'));
  if (['running', 'queued', 'awaiting_clarification', 'awaiting_approval', 'awaiting_environment_approval'].includes(job.status)) {
    buttons.push(actionButton(job, 'cancel', job.status === 'running' ? '停止任务' : '取消任务', 'danger'));
  }
  if (['running', 'queued', 'cancelling', 'awaiting_clarification', 'awaiting_approval', 'awaiting_environment_approval'].includes(job.status)) {
    buttons.push(actionButton(job, 'refresh', '刷新状态'));
  }
  if (buttons.length) elements.push({ tag: 'column_set', flex_mode: 'none', horizontal_spacing: '8px',
    columns: buttons.map((button) => ({ tag: 'column', width: 'weighted', weight: 1, elements: [button] })) });
  const role = ({ owner_intake: '项目负责人', owner_report: '项目负责人', developer: '开发', pm: 'PM', qa: '测试', owner_audit: '审计' })[job.stage] ?? stageLabel(job.stage);
  return card(`${role} · ${label}`, `${job.taskIntent === 'analysis' ? '只读分析' : stageLabel(job.stage)} · ${publicText(clip(job.projectName, 70))}`, color, elements);
}
