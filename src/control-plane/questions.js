import {stateView} from '../shared/state-view.js';
import {cardDestination} from './private-cards.js';
import { resultPages, withResultPage } from './result-presentation.js';
import { createHash } from 'node:crypto';
import { createId } from '../shared/protocol.js';
import { conversationCard, jobCard, publicText } from './message-cards.js';
import { conversationTerminalMention, jobTerminalMention } from './requester-mention.js';
import { isAdministrator, isTaskCreator } from './authorization.js';
export const questionTitle = text => publicText(text).replace(/\[([^\]]+)\]\([^)]+\)/g, '$1').replace(/\*\*|__|~~|`/g, '').replace(/\s+/g, ' ').trim().slice(0,60) || '附件问题';
const pending = (turn) => ['queued', 'thinking', 'decided'].includes(turn.status);
export const activeQuestionJob = (job) => ['queued', 'running', 'cancelling', 'paused', 'awaiting_approval', 'awaiting_clarification', 'awaiting_environment_approval'].includes(job?.status);

// A reply is an explicit association. Never infer a question from model prose or the latest user in the group.
export function attachQuestion(state, turn, event, projects) {
  state.questions ??= {};
  const candidates = Object.values(state.questions).reverse().filter(item => item.chatId === turn.chatId && item.profile === turn.profile
    && item.projectId === turn.projectId && (item.directoryChannel?.ownerId??null)===(turn.directoryChannel?.ownerId??null) && (item.visibility??'public')===(turn.visibility??'public') && (item.visibility!=='requester'||item.senderId===turn.senderId) && (isTaskCreator(projects, item, turn) || isAdministrator(projects, turn)));
  const direct = (item, id) => Boolean(id && (item.messageId === id || state.cardMessages?.[`question:${item.id}`]?.messageId === id
    || state.conversations.some(other => other.questionId === item.id && other.messageId === id)));
  const explicit = candidates.find(item => direct(item, event.reply_to));
  const threadLatest = candidates.find(item => event.root_id && (item.threadRootId === event.root_id || direct(item, event.root_id)));
  // Feishu replies inside one topic commonly keep reply_to pinned to the first
  // message. Treat that value as a thread anchor and attach the reply to the
  // newest descendant. A reply to a later card/message remains explicit.
  const broadTopicRoot = Boolean(explicit && event.root_id && event.reply_to === event.root_id
    && (explicit.messageId === event.root_id || explicit.threadRootId === event.root_id));
  const related = broadTopicRoot ? (threadLatest ?? explicit) : (explicit ?? threadLatest);
  const pendingSetup = related && Object.values(state.environmentEnrollments ?? {}).some(e => e.questionId === related.id && ['requested','opening','login_required','awaiting_tls_confirmation'].includes(e.status));
  const relatedTurn = related && state.conversations.find(t => t.id === related.latestTurnId);
  const q = related && (activeQuestionJob(questionJob(state, related.id)) || pendingSetup || (relatedTurn && (pending(relatedTurn)||relatedTurn.setupPending||relatedTurn.cloudInputPending||relatedTurn.outcome?.contactCandidates?.length))) ? related : null;
  const question = q ?? { id: createId('QST'), rootTurnId: turn.id, messageId: turn.messageId, chatId: turn.chatId,
    ...(turn.directoryChannel?{directoryChannel:structuredClone(turn.directoryChannel)}:{}), ...(turn.visibility?{visibility:turn.visibility}:{}), threadRootId: event.root_id ?? turn.messageId, projectId: turn.projectId, profile: turn.profile, senderId: turn.senderId, createdAt: turn.createdAt,
    ...(turn.replyInThread ? { replyInThread: true } : {}),
    ...(related ? { parentQuestionId: related.id } : {}),
    title: questionTitle(turn.content), generation: 1 };
  if (q) question.generation = Math.max(question.generation, question.cardGeneration ?? 1) + 1;
  question.latestTurnId = turn.id;
  state.questions[question.id] = question;
  turn.questionId = question.id;
}
export function questionJob(state, questionId) {
  // Stages are appended in transition order. A completed predecessor never replaces its successor.
  return (state.jobs ?? []).filter((job) => job.questionId === questionId).at(-1) ?? null;
}
export function questionView(state, questionId, projects = {}) {
  const q = state.questions?.[questionId];
  if (!q) throw new Error('Question identity missing');
  const turn = state.conversations.find((item) => item.id === q.latestTurnId);
  const enrollment = Object.values(state.environmentEnrollments ?? {}).find(e => e.questionId === q.id && ['requested','opening','login_required','awaiting_tls_confirmation'].includes(e.status));
  const job = questionJob(state, q.id);
  const outstanding = state.conversations.some((item) => item.questionId === q.id && pending(item));
  const useJob = job && (activeQuestionJob(job) || turn.outcome?.jobId || turn.outcome?.nextJobId);
  const shown = useJob ? job : turn;
  let card = useJob ? jobCard(job, Date.now(), { startAt: q.createdAt }) : conversationCard({...turn,setupPending:Boolean(enrollment)||turn.setupPending});
  const terminal = !enrollment && !turn.cloudInputPending && !turn.setupPending && !outstanding && (useJob ? !['queued', 'running', 'cancelling'].includes(job.status) : ['ready', 'sent'].includes(turn.status));
  const label = card.header.title.content;
  card.header.title.content = questionTitle(q.title);
  card.header.subtitle.content = `${q.id} · ${label}`;
  card.config.summary.content = `${questionTitle(q.title)} · ${label}`;
  if (useJob) {
    const roles = { requirement_test: '需求测试', developer: '开发', owner_report: '负责人汇总', owner_intake: '负责人', pm: 'PM', qa: '测试', owner_audit: '审计' };
    const stages = state.jobs.filter((item) => item.questionId === q.id).map((item) => item.stage);
    const flow = stages.filter((stage, index) => stage !== stages[index - 1]).slice(-6)
      .map((stage, index, compact) => `${roles[stage] ?? '处理'}${index < compact.length - 1 ? ' ✓' : ''}`).join(' → ');
    card.body.elements[0].columns[0].elements.push({ tag: 'markdown', text_size: 'notation', content: `流程：${flow}` });
    if (outstanding) card.body.elements[0].columns[0].elements.push({ tag: 'markdown', text_size: 'notation', content: '已收到补充，负责人正在处理；任务进度仍显示在本卡。' });
  }
  const root = state.conversations.find((item) => item.id === q.rootTurnId);

  const adminIds = (projects.ownerOpenIdsByProfile?.[q.profile] ?? []).filter(id => /^ou_[A-Za-z0-9]+$/.test(id));
  const mention = enrollment ? (['requested','awaiting_tls_confirmation'].includes(enrollment.status) && adminIds.length ? { profile:q.profile,replyTo:q.messageId,text:adminIds.map(id => `<at user_id="${id}"></at>`).join(' ')+(enrollment.status === 'awaiting_tls_confirmation' ? ' 请核对本卡的单目标非TLS例外；明确同意后才继续连接。' : ' 请确认本话题的新环境接入；登录仅在运行AgentOS的电脑完成。') } : null) : terminal ? (useJob
    ? jobTerminalMention({ ...job, senderId: q.senderId, originMessageId: q.messageId, originProfile: q.profile }, projects)
    : turn.directoryChannel ? (state.cardMessages?.['question:'+q.id]?.publicCompletionMention && state.cardMessages['question:'+q.id].deliveryToken===turn.id+':directory-result' ? state.cardMessages['question:'+q.id].terminalMention : null) : conversationTerminalMention({ ...turn, senderId: q.senderId, messageId: q.messageId, profile: q.profile, chatType: root.chatType })) : null;
  if (mention && q.replyInThread) mention.replyInThread = true;
  const currentResult=useJob ? shown.result?.finalMessage ?? '' : shown.response ?? '';
  const priorJobs=state.jobs.filter(j=>j.questionId===q.id && j.id!== (useJob?job.id:null) && j.result?.finalMessage);
  const priorTurns=state.conversations.filter(t=>t.questionId===q.id && t.id!==turn.id && t.status==='sent' && t.response && !t.outcome?.jobId && !t.outcome?.nextJobId);
  const allHistory=[...priorJobs.map(j=>`已完成阶段 · ${j.id}\n${j.result.finalMessage}`),...priorTurns.map(t=>`此前回复 · ${t.createdAt ?? ''}\n${t.response}`)];
  const seenHistory=new Set();
  const history=allHistory.filter(item=>{const body=item.split('\n').slice(1).join('\n');if(seenHistory.has(body))return false;seenHistory.add(body);return true;}).slice(-6);
  const omitted=Math.max(0,allHistory.length-history.length);
  const resultText=[currentResult,...history.length?['—— 最近结果与回复 ——',...history]:[],...(omitted?[`另有 ${omitted} 项历史执行记录保存在本机审计数据中。`]:[])].join('\n\n');
  if(allHistory.length) {
    card=withResultPage(card,resultPages(resultText));
    card.body.elements.push({tag:'markdown',text_size:'notation',content:`此前 ${allHistory.length} 项历史执行记录当前保留在本机；卡片展示最近 ${history.length} 项有效结果。`});
  }
  return { question: q, job: useJob ? job : null, card, terminal, mention,
    resultText,
    destination: cardDestination(q) };
}
// Fence a snapshot against incoming replies, transitions and result changes between read and publish.
function sourceVersion(state, id) {
  const q = state.questions[id];
  return createHash('sha256').update(JSON.stringify([q.generation, q.latestTurnId,
    state.jobs.filter((j) => j.questionId === id).map((j) => [j.id, j.status, j.updatedAt, j.events.length, j.nextJobId, j.result]),
    state.conversations.filter((t) => t.questionId === id).map((t) => [t.id, t.status, t.response, t.outcome,t.cloudFileProgress,t.cloudInputPending])])).digest('hex');
}
const locks = new WeakMap();
export function publishQuestion(context, id) {
  let queue = locks.get(context.store); if (!queue) { queue = new Map(); locks.set(context.store, queue); }
  const work = (queue.get(id) ?? Promise.resolve()).catch(() => {}).then(async () => {
    const snapshot = await stateView(context.store,s=>({questions:{[id]:s.questions[id]},jobs:(s.jobs??[]).filter(j=>j.questionId===id),conversations:(s.conversations??[]).filter(t=>t.questionId===id||t.id===s.questions[id]?.rootTurnId||t.id===s.questions[id]?.latestTurnId),environmentEnrollments:Object.fromEntries(Object.entries(s.environmentEnrollments??{}).filter(([,e])=>e.questionId===id)),cardMessages:{['question:'+id]:s.cardMessages?.['question:'+id]}}));
    const version = sourceVersion(snapshot, id);
    const view = questionView(snapshot, id, context.projects);
    const key = `question:${id}`;
    // Reopening a round/attempt retains the message, but resets terminal notification delivery.
    let generation;
    await context.store.transact((state) => {
      const q = state.questions[id]; const old = state.cardMessages?.[key];
      q.cardGeneration = Math.max(q.generation, q.cardGeneration ?? 1);
      if (old?.terminal && !view.terminal && q.cardGeneration <= (old.generation ?? 1)) q.cardGeneration = old.generation + 1;
      generation = q.cardGeneration;
    });
    return context.cards.upsert(key, view.card, view.destination, { terminal: view.terminal, immediate: true,
      resultText: view.resultText, terminalMention: view.mention, publicCompletionMention: view.mention?.kind==='directory_completion', generation,
      guard: (state) => { if (sourceVersion(state, id) !== version) throw new Error('Question changed during presentation; retry'); } });
  });
  queue.set(id, work); work.finally(() => { if (queue.get(id) === work) queue.delete(id); }).catch(() => {});
  return work;
}
