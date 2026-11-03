import {isPendingEnrollment} from '../shared/enrollment-lifecycle.js';
import { addQuestionProgress, enrollmentNotice } from './enrollment-cards.js';
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
export const activeQuestionJob = (job) => ['queued', 'running', 'cancelling', 'awaiting_approval', 'awaiting_clarification', 'awaiting_environment_approval'].includes(job?.status);

// A reply is an explicit association. Never infer a question from model prose or the latest user in the group.
export function attachQuestion(state, turn, event, projects) {
  state.questions ??= {};
  const candidates = Object.values(state.questions).reverse().filter(item => item.chatId === turn.chatId && item.profile === turn.profile
    && item.projectId === turn.projectId && (item.directoryChannel?.ownerId??null)===(turn.directoryChannel?.ownerId??null) && (item.visibility??'public')===(turn.visibility??'public') && (item.visibility!=='requester'||item.senderId===turn.senderId));
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
  // Select execution continuation from the original authorized set. A newer
  // public follow-up must not displace its creator's still-active task.
  const owned=candidates.filter(item=>isTaskCreator(projects,item,turn)||isAdministrator(projects,turn));
  const ownedExplicit=owned.find(item=>direct(item,event.reply_to));
  const ownedLatest=owned.find(item=>event.root_id&&(item.threadRootId===event.root_id||direct(item,event.root_id)));
  const ownedBroad=Boolean(ownedExplicit&&event.root_id&&event.reply_to===event.root_id
    &&(ownedExplicit.messageId===event.root_id||ownedExplicit.threadRootId===event.root_id));
  const ownedRelated=ownedBroad?(ownedLatest??ownedExplicit):(ownedExplicit??ownedLatest);
  const continuation=(!explicit||broadTopicRoot)?ownedRelated:related;
  const mayContinue=continuation&&(isTaskCreator(projects,continuation,turn)||isAdministrator(projects,turn));
  const pendingSetup=mayContinue&&Object.values(state.environmentEnrollments??{}).some(e=>e.questionId===continuation.id&&isPendingEnrollment(e));
  const relatedTurn=mayContinue&&state.conversations.find(t=>t.id===continuation.latestTurnId);
  const q=mayContinue&&(activeQuestionJob(questionJob(state,continuation.id))||pendingSetup||(relatedTurn&&(pending(relatedTurn)||relatedTurn.setupPending||relatedTurn.outcome?.contactCandidates?.length)))?continuation:null;
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
// Structured environment context follows only this explicit, visibility-checked
// question chain. It carries no environment grant, lease, credentials or task control.
export function questionSourceContext(state, turn, project) {
 const allowed = new Set(Object.keys(project?.analysisEnvironments ?? {})), seen = new Set();
 let q = state.questions?.[turn.questionId];
 while(q && !seen.has(q.id) && q.chatId===turn.chatId && q.profile===turn.profile && q.projectId===turn.projectId
   && (q.visibility??'public')===(turn.visibility??'public') && (q.visibility!=='requester'||q.senderId===turn.senderId)) {
  seen.add(q.id);
  const jobs=(state.jobs??[]).filter(j=>j.questionId===q.id && j.chatId===turn.chatId && j.projectId===turn.projectId
   && (j.originProfile??j.agentProfile??q.profile)===turn.profile);
  for(const job of jobs.reverse()) {
   const id=job.sourceEnvironment??job.result?.sourceSync?.environment;
   if(allowed.has(id))return {id,questionId:q.id,jobId:job.id,policy:'topic_environment_context_not_authorization'};
  }
  const root=state.conversations?.find(t=>t.id===q.rootTurnId),id=root?.decision?.sourceEnvironment;
  if(allowed.has(id))return {id,questionId:q.id,jobId:null,policy:'topic_environment_context_not_authorization'};
  q=state.questions?.[q.parentQuestionId];
 }
 return null;
}
export function questionJob(state, questionId) {
  // Stages are appended in transition order. A completed predecessor never replaces its successor.
  return (state.jobs ?? []).filter((job) => job.questionId === questionId).at(-1) ?? null;
}
export function questionView(state, questionId, projects = {}) {
  const q = state.questions?.[questionId];
  if (!q) throw new Error('Question identity missing');
  const turn = state.conversations.find((item) => item.id === q.latestTurnId);
  const enrollment = Object.values(state.environmentEnrollments ?? {}).find(e => e.questionId === q.id && isPendingEnrollment(e));
  const job = questionJob(state, q.id);
  const outstanding = state.conversations.some((item) => item.questionId === q.id && pending(item));
  const missingSetup = Boolean(turn.setupPending && (turn.decision?.action==='request_environment_setup'||turn.decision?.environmentSetup) && !enrollment && !activeQuestionJob(job));
  const useJob = !missingSetup && job && (activeQuestionJob(job) || turn.outcome?.jobId || turn.outcome?.nextJobId || Date.parse(job.updatedAt)>=Date.parse(turn.createdAt));
  const notice=enrollmentNotice(enrollment);
  const displayTurn={...turn,setupStatus:enrollment?.status,setupLoginIssue:enrollment?.loginIssue,setupHasCredentials:Boolean(enrollment?.credentialReceivedAt),setupPending:Boolean(enrollment)||turn.setupPending,...(notice?{response:notice}: {})};
  const shown = useJob ? job : displayTurn;
  let card = useJob ? jobCard(job, Date.now(), { startAt: q.createdAt }) : conversationCard(displayTurn);
  if (!useJob) card = addQuestionProgress(card, state, q, enrollment);
  const stoppedJob = useJob && ['completed','blocked','failed','cancelled'].includes(job.status) && !job.nextJobId;
  const terminal = !enrollment && (!turn.setupPending || stoppedJob) && !outstanding && (useJob ? !['queued', 'running', 'cancelling'].includes(job.status) : ['ready', 'sent'].includes(turn.status));
  const label = card.header.title.content;
  card.header.title.content = questionTitle(q.title);
  card.header.subtitle.content = `${q.id} · ${label}`;
  card.config.summary.content = `${questionTitle(q.title)} · ${label}`;
  if (useJob) {
    const roles = { developer: '开发', owner_report: '负责人汇总', owner_intake: '负责人', pm: 'PM', qa: '测试', owner_audit: '审计' };
    const stages = state.jobs.filter((item) => item.questionId === q.id).map((item) => item.stage);
    const flow = stages.filter((stage, index) => stage !== stages[index - 1]).slice(-6)
      .map((stage, index, compact) => `${roles[stage] ?? '处理'}${index < compact.length - 1 ? ' ✓' : ''}`).join(' → ');
    const annotations=card.body.elements.find(e=>e.tag==='column_set'&&e.columns?.[0]?.elements)?.columns[0].elements;
    annotations?.push({ tag: 'markdown', text_size: 'notation', content: `流程：${flow}` });
    if (outstanding) annotations?.push({ tag: 'markdown', text_size: 'notation', content: '已收到补充，负责人正在处理；任务进度仍显示在本卡。' });
  }
  const root = state.conversations.find((item) => item.id === q.rootTurnId);

  const adminIds = (projects.ownerOpenIdsByProfile?.[q.profile] ?? []).filter(id => /^ou_[A-Za-z0-9]+$/.test(id));
  let mention = enrollment ? (['requested','awaiting_tls_confirmation'].includes(enrollment.status) && adminIds.length ? { kind:'environment_approval',profile:q.profile,replyTo:q.messageId,text:adminIds.map(id => `<at user_id="${id}"></at>`).join(' ')+(enrollment.status === 'awaiting_tls_confirmation' ? ' 请核对本卡的单目标非TLS例外；明确同意后才继续连接。' : ' 请确认本话题的新环境接入；可在本话题提供凭据，由本机独立窗口自动登录。') } : null) : terminal ? (useJob
    ? jobTerminalMention({ ...job, senderId: q.senderId, originMessageId: q.messageId, originProfile: q.profile }, projects)
    : turn.directoryChannel ? (state.cardMessages?.['question:'+q.id]?.publicCompletionMention && state.cardMessages['question:'+q.id].deliveryToken===turn.id+':directory-result' ? state.cardMessages['question:'+q.id].terminalMention : null) : conversationTerminalMention({ ...turn, senderId: q.senderId, messageId: q.messageId, profile: q.profile, chatType: root.chatType })) : null;
  if (missingSetup && !outstanding) {
    const ids=[...new Set([q.senderId,...adminIds])].filter(id=>/^ou_[A-Za-z0-9]+$/.test(id));
    if(ids.length) mention={kind:'environment_setup_missing',profile:q.profile,replyTo:q.messageId,
      text:ids.map(id=>`<at user_id="${id}"></at>`).join(' ')+' 排查尚未完成：需要补充本话题对应环境的接入信息或选择数据源。请查看卡片中的具体缺口；原需求和已有证据已保留。'};
  }
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
    card.body.elements.push({tag:'markdown',text_size:'notation',content:`此前 ${allHistory.length} 项历史执行记录均已保留在本机；卡片展示最近 ${history.length} 项有效结果。`});
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
    state.conversations.filter((t) => t.questionId === id).map((t) => [t.id, t.status, t.response, t.outcome]),
    Object.values(state.environmentEnrollments??{}).filter(e=>e.questionId===id).map(e=>[e.id,e.status,e.credentialReceivedAt,e.loginIssue])])).digest('hex');
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
