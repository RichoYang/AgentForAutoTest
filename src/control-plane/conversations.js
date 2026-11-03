import {readBusinessDefinitions,recordBusinessDefinitions} from '../shared/business-definitions.js';
import {sourceEnvironmentForTier} from '../shared/source-environments.js';
import { resolveProjectId, routeAgent, assistantInstructions } from '../shared/project-scope.js';
import {stateView} from '../shared/state-view.js';
import {requestsPrivateCard,cardDestination,privateRecipient,isPrivate} from './private-cards.js';
import { refreshExpiredApprovalCards } from './approval-expiry.js';
import { selectSourceEnvironment, sourceEnvironmentCatalog } from '../shared/source-environments.js';
import { connectionCandidates } from '../shared/connection-endpoints.js';
import { pollWebsiteLogins } from './website-query.js';
import { enrollmentTarget, requestEnrollment, approveEnrollment, pollEnrollments } from './environment-enrollment.js';
import { loadEnvironments, catalog, routingCatalog, planQuery, verifyPlan, isEnvironmentOwner } from '../shared/environment-access.js';
import { attachQuestion, publishQuestion, questionJob, activeQuestionJob, questionSourceContext } from './questions.js';
import { createId, workflowForStage, nextStage, stageLabel } from '../shared/protocol.js';
import { CodexConversationEngine, validateDecision, conversationFailure } from './codex-conversation.js';
import { saveProjects } from './config.js';
import { conversationCard } from './message-cards.js';
import path from 'node:path';
import { MemoryService, fitContext } from './memory.js';
import { canContinueTask, canCreateTask, isAdministrator, isTaskCreator } from './authorization.js';
import { conversationTerminalMention } from './requester-mention.js';
import { PRIMARY_RESPONSE_LIMIT } from './result-presentation.js';
export { isAdministrator } from './authorization.js';

export function sourceEvidence(job, sourceDirectory) {
  const workspace = job.result?.workspace ?? null;
  const normalize = (value) => /^[a-z]:[\\/]/i.test(value) ? path.win32.normalize(value).replace(/[\\/]+$/, '').toLowerCase()
    : path.resolve(value);
  const sameDirectory = Boolean(workspace && sourceDirectory && normalize(job.result?.sourceSync?.sourceRoot ?? workspace) === normalize(sourceDirectory));
  const compatible = sameDirectory && job.taskIntent === 'analysis'
    && (job.result?.sourceSync?.policy === 'isolated-environment-source-v1' || job.workflow === 'analysis_review' || ['single_qa', 'single_owner_audit'].includes(job.workflow));
  return { workspace, sourceEnvironment: job.result?.sourceSync?.environment ?? job.sourceEnvironment ?? null, repositories: job.result?.sourceSync?.repositories ?? [], recordedAt: job.updatedAt ?? job.createdAt ?? null, workflow: job.workflow,
    applicability: compatible ? 'historical_snapshot_not_current_check' : 'not_evidence_for_current_source_directory',
    requiresRecheckForCurrentSource: true };
}

// Scope/visibility filtering is performed before this projection. A stale
// environmentAccess field is not evidence that a completed source-backed answer
// is still an environment subtask. Keep its final delivery available to follow-ups.
export function conversationJobResult(job, sourceDirectory) {
  if (job.environmentAccess && !(job.status === 'completed' && job.result?.sourceSync)) return '环境查询的明细不注入共享记忆；需要当前数据请重新发起受控查询。';
  if (sourceEvidence(job, sourceDirectory).applicability === 'not_evidence_for_current_source_directory' && job.taskIntent === 'analysis') return '旧分析结果不适用于当前源码目录；原结果保留在任务记录中，需要查当前源码时重新调查。';
  const text=job.result?.finalMessage??'';
  return text.length>6000?text.slice(0,6000)+'\n[历史交付较长，此处仅为节选；未展示部分不得推测已读。]':text;
}

// Persistence is shared with jobs. Language decisions come exclusively from AI;
// the switches below enforce the typed action protocol, not keyword matching.
export class ConversationService {
  constructor(context, options = {}) {
    this.context = context;
    this.groupSessions = options.groupSessions === true;
    this.questionCards = options.questionCards === true;
    this.memory = new MemoryService({ dataDir: context.config.dataDir, settings: options.memorySettings });
    this.engine = options.decide ? null : new CodexConversationEngine({ dataDir: context.config.dataDir, file: context.config.codexRuntimeFile });
    this.decide = options.decide ?? ((input, signal, detail) => this.engine.decide(input, { ...detail, signal }));
    this.concurrency = options.concurrency ?? 3;
    this.feedbackMs = options.feedbackMs ?? 3000;
    this.workers = new Map();
    this.feedback = new Map();
    this.stopped = false;
    this.running = null;
    this.timer = null;
    this.abort = new AbortController();
  }

  async start() {
    await this.context.store.transact((state) => {
      for (const turn of state.conversations ?? []) if (turn.status === 'thinking') turn.status = 'queued';
    });
    this.engine?.start().catch(() => console.error('[conversation] Codex prewarm failed; next message will retry initialization'));
    this.wake();
  }

  async stop() {
    this.stopped = true;
    clearTimeout(this.timer);
    this.abort.abort();
    this.reschedule?.();
    for (const entry of this.feedback.values()) { clearTimeout(entry.timer); clearInterval(entry.pulse); }
    await this.engine?.close();
    await this.running;
    await Promise.all([...this.feedback.values()].map((entry) => entry.running));
  }

  async enqueue(event) {
    if (!event.message_id || !event.chat_id || !event.sender_id) throw new Error('Missing message identity');
    const profile = event.agent_profile ?? null;
    const directoryChannel=await this.context.contactChannels?.resolve(event.chat_id,profile,event.sender_id);
    const accepted = await this.context.store.transact((state) => {
      state.conversations ??= [];
      const existing = state.conversations.find((turn) => turn.messageId === event.message_id && turn.profile === profile);
      if (existing) return { conversation: true, turnId: existing.id, duplicate: true };
      const privateReply=event.chat_type==='p2p'&&Object.values(state.cardMessages??{}).find(c=>c.destination.visibility==='requester'&&c.privateDeliveryKind==='dm'&&c.privateDeliveryChatId===event.chat_id&&c.destination.openId===event.sender_id&&c.destination.profile===profile&&c.messageId===event.reply_to);
      const routedChatId=privateReply?.destination?.chatId??event.chat_id;
      const turn = {
        ...(directoryChannel?{directoryChannel,visibility:'requester'}:{}),
        ...(privateReply?{sourceChatId:event.chat_id}:{}),
        id: createId('CHAT'), messageId: event.message_id, chatId: routedChatId,
        senderId: event.sender_id, profile, role: event.agent_role ?? 'owner_intake', chatType: privateReply?'group':event.chat_type ?? null,
        projectId: resolveProjectId(this.context.projects, routedChatId, profile),
        parentId: event.reply_to ?? event.root_id ?? null,
        ...(this.context.projects.topicChatIds?.includes(event.chat_id) || event.thread_id ? { replyInThread: true } : {}),
        content: event.content ?? '', attachments: event.attachments ?? [],
        status: 'queued', createdAt: new Date().toISOString(),
        sessionKey: JSON.stringify([routedChatId, event.sender_id, profile, event.agent_role ?? 'owner_intake',
          resolveProjectId(this.context.projects, routedChatId, profile)]),
      };
      const privateParent=Object.values(state.questions??{}).find(q=>q.visibility==='requester'&&q.chatId===turn.chatId&&q.profile===turn.profile&&q.senderId===turn.senderId&&q.projectId===turn.projectId&&[event.reply_to,event.root_id].filter(Boolean).some(id=>id===q.messageId||id===state.cardMessages?.[`question:${q.id}`]?.messageId||state.conversations.some(t=>t.questionId===q.id&&t.messageId===id)));
      if(turn.chatType==='group'&&(requestsPrivateCard(turn.content)||privateParent))turn.visibility='requester';
      if ((this.questionCards||turn.visibility==='requester') && turn.chatType === 'group' && this.context.cards?.enabled) attachQuestion(state, turn, event, this.context.projects);
      state.conversations.push(turn);
      return { conversation: true, turnId: turn.id, duplicate: false };
    });
    this.wake();
    return accepted;
  }

  wake() {
    if (this.stopped) return;
    this.wakeRequested = true;
    if (this.running) { this.reschedule?.(); return; }
    clearTimeout(this.timer);
    this.running = this.schedule().catch((error) => console.error('[conversation]', error.message)).finally(() => {
      this.running = null;
      if (!this.stopped) {
        this.timer = setTimeout(() => this.wake(), 1000);
        this.timer.unref();
      }
    });
  }

  async idle() {
    if (this.running) await this.running;
    // One fresh pass covers enqueues racing a settling scheduler. Do not loop
    // until all turns finish: a delivery failure may intentionally block a queue.
    if (!this.stopped) { this.wake(); if (this.running) await this.running; }
  }

  key(turn) {
    // Versioned namespace never resumes the legacy group-wide native thread.
    return JSON.stringify(['question-v2', turn.chatId, turn.profile, turn.role,
      resolveProjectId(this.context.projects, turn.chatId, turn.profile),
      turn.questionId ? ['question', turn.questionId] : ['sender', turn.senderId]]);
  }

  async schedule() {
    while (!this.stopped) {
      this.wakeRequested = false;
      await pollEnrollments(this.context);
      void refreshExpiredApprovalCards(this.context).catch(()=>{});
      if(this.context.websiteBrowser)void pollWebsiteLogins(this.context).catch(()=>{});
      const state = await stateView(this.context.store,s=>({conversations:(s.conversations??[]).filter(t=>['queued','thinking','decided','ready'].includes(t.status))}));
      const heads = new Map();
      for (const turn of state.conversations ?? []) {
        if (!['queued', 'thinking', 'decided', 'ready'].includes(turn.status)) continue;
        const key = this.key(turn);
        if (!heads.has(key)) heads.set(key, turn);
        this.scheduleFeedback(turn);
      }
      for (const [key, turn] of heads) {
        if (this.workers.size >= this.concurrency) break;
        if (this.workers.has(key) || (turn.retryAt && Date.parse(turn.retryAt) > Date.now())) continue;
        const worker = this.process(key).catch((error) => console.error('[conversation-worker]', error.message))
          .finally(() => this.workers.delete(key));
        this.workers.set(key, worker);
      }
      if (!this.workers.size) return;
      if (!this.wakeRequested) await Promise.race([...this.workers.values(), new Promise((resolve) => { this.reschedule = resolve; })]);
      this.reschedule = null;
    }
    await Promise.all(this.workers.values());
  }

  scheduleFeedback(turn) {
    if (this.feedback.has(turn.id) || (!this.context.cards?.enabled && turn.feedbackState) || !(['queued','thinking'].includes(turn.status)||turn.status==='decided'&&turn.decision?.action==='lookup_contact')) return;
    const entry = {};
    const publish=()=>{
      if(entry.busy)return;entry.busy=true;
      entry.running=this.sendFeedback(turn.id).catch(()=>{}).finally(()=>{entry.busy=false;});
    };
    entry.timer = setTimeout(() => {
      publish();
      if (this.context.cards?.enabled) {
        entry.pulse = setInterval(publish, 10_000);
        entry.pulse.unref();
      }
    }, Math.max(0, this.feedbackMs - (Date.now() - Date.parse(turn.createdAt))));
    entry.timer.unref();
    this.feedback.set(turn.id, entry);
  }

  async sendFeedback(id) {
    if (this.stopped) return;
    const turn = await stateView(this.context.store,s=>s.conversations.find(item=>item.id===id));
    if (this.context.cards?.enabled) {
      if (!turn || !(['queued','thinking'].includes(turn.status)||turn.status==='decided'&&turn.decision?.action==='lookup_contact')) return;
      const messageId = turn.directoryChannel ? await this.context.contactChannels.progress(turn) : turn.questionId ? await publishQuestion(this.context, turn.questionId) : await this.context.cards.upsert(`chat:${id}`, conversationCard(turn),
        cardDestination(turn), { immediate: true });
      if (messageId) await this.update(id, { feedbackState: 'sent', feedbackAt: new Date().toISOString(), feedbackMessageId: messageId });
      return;
    }
    if (turn?.visibility==='requester')return;
    if (!turn || !(['queued','thinking'].includes(turn.status)||turn.status==='decided'&&turn.decision?.action==='lookup_contact') || turn.feedbackState) return;
    // Best-effort factual receipt, not a semantic/template answer. Persist before send.
    await this.update(id, { feedbackState: 'sending' });
    const text = turn.status==='decided'&&turn.decision?.action==='lookup_contact' ? '正在查询获准的通讯录并准备联系人信息图；较大范围首次查询可能需要一些时间。' : turn.status === 'queued' ? '已收到，正在排队；前面的对话处理完后会继续。'
      : '已收到，Codex 正在理解这条消息，结果会回复在这里。';
    try {
      const result = await this.context.feishu.reply(turn.messageId, text, { profile: turn.profile, replyInThread: turn.replyInThread, timeoutMs: 8000 });
      await this.update(id, { feedbackState: 'sent', feedbackAt: new Date().toISOString(), feedbackMessageId: responseMessageId(result) });
    } catch { await this.update(id, { feedbackState: 'failed' }); }
  }

  async update(id, fields) {
    await this.context.store.transact((state) => Object.assign(state.conversations.find((turn) => turn.id === id), fields));
  }

  async process(key) {
    while (!this.stopped) {
      const state = await this.context.store.read();
      const turn = (state.conversations ?? []).find((item) => this.key(item) === key && ['queued', 'decided', 'ready'].includes(item.status));
      if (!turn || (turn.retryAt && Date.parse(turn.retryAt) > Date.now())) return;
      if (turn.status === 'queued') {
        const aiStarted = Date.now();
        await this.update(turn.id, { status: 'thinking', aiStartedAt: new Date(aiStarted).toISOString(),
          queueMs: aiStarted - Date.parse(turn.createdAt) });
        try {
          const input = await this.buildInput(turn);
          let decision = validateDecision(await this.decide(input, this.abort.signal, { sessionKey: key,
            onEvent: (event, info) => {
              if (event === 'error') this.update(turn.id, { connectionRetryAt: new Date().toISOString(), connectionWillRetry: info.willRetry }).catch(() => {});
            } }));
          if (decision.definitionUpdates?.length) {
            try { decision.definitionReceipts=await recordBusinessDefinitions({dataDir:this.context.config.dataDir,file:this.context.config.knowledgeFile,actor:turn,projectId:input.project?.id,updates:decision.definitionUpdates});
              if(decision.definitionReceipts.length)decision.reply+=`\n已保存团队口径：${decision.definitionReceipts.map(r=>`${r.title}（${r.environment}，第${r.version}版）`).join('、')}。后续同范围提问沿用该版本，实时数据重新查询。`;
            }
            catch { decision.definitionSaveFailed=true;decision.reply+='\n本次口径尚未成功保存为共享版本，不能声称已记住；仍保留原问题继续处理。'; }
          }
          if (this.context.knowledge&&!decision.definitionUpdates?.length) decision = await this.context.knowledge.reuse(turn, input.project?.id, decision, input);
          await this.update(turn.id, { status: 'decided', decision, timing: decision.timing ?? { aiMs: Date.now() - aiStarted },
            attachmentPool: input.attachments, aiCompletedAt: new Date().toISOString() });
        } catch (error) {
          if (this.stopped) { await this.update(turn.id, { status: 'queued' }); return; }
          console.error(`[conversation:${turn.id}] AI failed:`, error.message);
          await this.update(turn.id, { status: 'ready', error: error.message.slice(0, 4000),
            response: conversationFailure(error), ...(error.contextBudget?{contextBudget:error.contextBudget}:{}),
            timing: error.timing ?? { aiMs: Date.now() - aiStarted }, aiFailed: true });
        }
        continue;
      }
      if (turn.status === 'decided') {
        try {
          const outcome = await this.apply(turn);
          await this.update(turn.id, { status: 'ready', outcome, response: [turn.decision.action==='lookup_contact'||turn.directoryChannel?'':turn.decision.reply, outcome.notice].filter(Boolean).join('\n\n') });
        } catch (error) {
          await this.update(turn.id, { status: 'ready', response: `本次操作未执行：${error.message}`, actionError: error.message });
        }
        continue;
      }
      try {
        const feedback = this.feedback.get(turn.id);
        clearTimeout(feedback?.timer);
        clearInterval(feedback?.pulse);
        await feedback?.running;
        this.feedback.delete(turn.id);
        const deliveryStarted = Date.now();
        if(turn.directoryChannel){const responseIds=await this.context.contactChannels.deliver(turn);await this.update(turn.id,{status:'sent',completedAt:new Date().toISOString(),responseIds,contactImageMessageId:turn.outcome?.contactImage?responseIds[0]:null});continue;}
        const responseIds = [...(turn.responseIds ?? [])];
        let parts;
        if (this.context.cards?.enabled) {
          const cardId = turn.questionId ? await publishQuestion(this.context, turn.questionId) : await this.context.cards.upsert(`chat:${turn.id}`, conversationCard(turn),
            cardDestination(turn), { terminal: true, immediate: true,
              resultText: Array.from(turn.response ?? '').length > PRIMARY_RESPONSE_LIMIT ? turn.response : '', terminalMention: conversationTerminalMention(turn) });
          if (cardId && !responseIds.includes(cardId)) responseIds.push(cardId);
          parts = [];
        } else {
          if(turn.visibility==='requester')throw new Error('私有卡片投递不可用，未回退公开消息');
          parts = splitReply(turn.response);
          const mention = conversationTerminalMention(turn);
          if (mention && parts.length) parts[parts.length - 1] = `${parts.at(-1)}\n\n${mention.text}`;
        }
        for (let i = turn.sentParts ?? 0; i < parts.length; i++) {
          const result = await this.context.feishu.reply(turn.messageId, parts[i], { profile: turn.profile, replyInThread: turn.replyInThread });
          const id = responseMessageId(result);
          if (id) responseIds.push(id);
          await this.update(turn.id, { sentParts: i + 1, responseIds });
        }
        if(turn.outcome?.contactImage&&!turn.contactImageMessageId){
          let file;
          try{file=await this.context.contacts.validateImage(turn,turn.outcome.contactImage);}
          catch{await this.update(turn.id,{outcome:{...turn.outcome,contactImage:null},response:'联系人资料、授权或图片检查未通过，本次没有发送图片，请重新查询。',sentParts:0,contactImageError:'资料、授权或图片检查未通过，未发送；请重新查询。'});continue;}
          if(typeof this.context.feishu.replyImage!=='function')throw new Error('Image transport unavailable');
          const result=await this.context.feishu.replyImage(turn.messageId,file,{profile:turn.profile,replyInThread:turn.replyInThread,privateRecipient:privateRecipient(await this.context.store.read(),turn),idempotencyKey:'aos-contact-'+turn.id+'-'+turn.outcome.contactImage.sha256.slice(0,32)});
          const imageId=responseMessageId(result);if(!imageId)throw new Error('Image delivery has no message ID');
          responseIds.push(imageId);await this.update(turn.id,{contactImageMessageId:imageId,responseIds});
        }
        const timing = { ...turn.timing, queueMs: turn.queueMs, deliveryMs: Date.now() - deliveryStarted, totalMs: Date.now() - Date.parse(turn.createdAt) };
        await this.update(turn.id, { status: 'sent', completedAt: new Date().toISOString(), responseIds, timing });
        console.log(`[conversation-timing] ${JSON.stringify({ id: turn.id, role: turn.role, ...timing })}`);
      } catch (error) {
        const failures = (turn.deliveryFailures ?? 0) + 1;
        // Persist the outbox; retry delivery without calling AI or applying actions again.
        await this.update(turn.id, { deliveryFailures: failures, deliveryError: error.message.slice(0, 2000),
          retryAt: new Date(Date.now() + Math.min(60_000, failures * 5000)).toISOString() });
        console.error(`[conversation:${turn.id}] reply delivery failed`);
      }
    }
  }

  async buildInput(turn) {
    const { projects, store } = this.context;
    const state = await store.read();
    const projectId = resolveProjectId(projects, turn.chatId, turn.profile);
    const scoped = Boolean(turn.questionId);
    const sourceContext=questionSourceContext(state,{...turn,projectId},projects.projects[projectId]);
    const questionIds = new Set();
    let q = state.questions?.[turn.questionId];
    while (q && !questionIds.has(q.id) && q.chatId === turn.chatId && q.profile === turn.profile && q.projectId === projectId && (q.visibility!=='requester'||turn.visibility==='requester'&&q.senderId===turn.senderId)) {
      questionIds.add(q.id); q = state.questions?.[q.parentQuestionId];
    }
    if (scoped) questionIds.add(turn.questionId);
    const preceding = (state.conversations ?? []).filter((item) => item.id !== turn.id && item.chatId === turn.chatId
      && item.profile === turn.profile && (item.visibility!=='requester'||turn.visibility==='requester'&&item.senderId===turn.senderId) && (scoped ? questionIds.has(item.questionId) : item.senderId === turn.senderId) && item.status === 'sent'
      && conversationProject(item) === projectId);
    const memory = scoped ? { enabled: false, available: true, policy: 'question-scoped-native-v2' } : await this.memory.retrieve(state, turn, projectId);
    const suppressed = new Set(memory.suppressedRefs ?? []);
    const suppressedMessages = new Set(preceding.filter((item) => suppressed.has(`conversation:${item.id}`)).map((item) => item.messageId));
    const availableHistory = memory.available === false ? [] : preceding.filter((item) => !suppressed.has(`conversation:${item.id}`));
    const history = availableHistory.slice(-this.memory.settings.recentTurns);
    const parent = availableHistory.find((item) => item.messageId === turn.parentId || item.feedbackMessageId === turn.parentId || item.responseIds?.includes(turn.parentId));
    if (parent && !history.includes(parent)) history.unshift(parent);
    const attachments = [...new Map([...history.flatMap((item) => item.attachments ?? []), ...turn.attachments]
      .map((item) => [item.id, item])).values()].slice(-20);
    const relatedMessages = new Set(preceding.flatMap(item => [item.id,item.messageId]).filter(Boolean));
    relatedMessages.add(turn.id); relatedMessages.add(turn.messageId);
    if(turn.directoryChannel)return {requestId:turn.id,questionId:turn.questionId,role:turn.role,nativeSession:true,currentActor:{senderId:turn.senderId,profile:turn.profile},project:{id:projectId},message:turn.content,history:history.map(t=>({user:t.content,assistant:t.response})),attachments:[],currentAttachmentIds:[],contactDirectory:await this.context.contacts.catalog(turn),delivery:{visibility:'requester_and_owner'},channel:{kind:'contacts_only',allowedActions:['lookup_contact','reply'],rule:'只根据姓名或完整工号调用lookup_contact查询；联系人事实必须来自工具结果。需要补充姓名/工号时用reply，不得编造资料，不得创建开发、数据库或环境任务。结果在群内私有卡片中展示，仅提问者和群主可见。'}};
    const explicitJob = job => !scoped && isAdministrator(projects,turn) && String(turn.content).split(/[^A-Za-z0-9_-]+/).includes(job.id);
    const jobs = (memory.available === false ? [] : state.jobs).filter((job) => job.chatId === turn.chatId && job.projectId === projectId && (!isPrivate(state,job)||turn.visibility==='requester'&&job.senderId===turn.senderId)
      && (explicitJob(job) || (job.originProfile ?? job.agentProfile ?? null) === (turn.profile ?? null))
      && (scoped ? questionIds.has(job.questionId) : relatedMessages.has(job.originMessageId) || relatedMessages.has(job.sourceMessageId) || explicitJob(job))
      && !suppressed.has(`job:${job.id}`) && !suppressed.has(`conversation:${job.sourceMessageId}`) && !suppressedMessages.has(job.originMessageId)).slice(-20).map((job) => ({
      id: job.id, projectId: job.projectId, stage: job.stage, status: job.status, sourceEnvironment:job.sourceEnvironment??job.result?.sourceSync?.environment??null,
      instruction: job.instruction.slice(0, 4000),
      evidence: sourceEvidence(job, projects.projects[projectId]?.repoPath),
      finalMessage: conversationJobResult(job, projects.projects[projectId]?.repoPath),
      environmentAccess: job.environmentAccess ? { environmentId: job.environmentAccess.environmentId, queryId: job.environmentAccess.queryId, scopeHash: job.environmentAccess.scopeHash, expiresAt: job.environmentAccess.expiresAt, description: job.environmentAccess.description } : null,
      canApprove: isAdministrator(projects, turn) && job.status === 'awaiting_approval',
    }));
    delete memory.suppressedRefs;
    const input=fitContext({
      ...(projects.projects[projectId]?.assistantInstructionsFile ? { assistantScope: {
        instructions: await assistantInstructions(projects.projects[projectId]),
        assistants: Object.values(this.context.agents?.agents ?? {}).filter(a => a.systemAssistant).map(a => ({ name: a.displayName, projectId: a.projectId })),
        rule: '仅处理当前系统。明确属于其它系统时用 reply 提示重新 @ 对应助手发起新问题，不转交、不查其它系统。' } } : {}),
      delivery:{visibility:turn.visibility??'public',rule:turn.visibility==='requester'?'只向提问者投递临时卡片；附件通过同一机器人私聊，不得公开。':'普通公开回复'},
      contactDirectory: this.context.contacts ? await this.context.contacts.catalog(turn) : {enabled:false,pending:[]},
      businessDefinitions: await readBusinessDefinitions({dataDir:this.context.config.dataDir,file:this.context.config.knowledgeFile,actor:turn,projectId}).catch(()=>[{unavailable:true,rule:'共享口径暂不可读，不能声称此前没有确认或已保存；保留任务并报告读取缺口。'}]),
      teamKnowledge: this.context.knowledge ? await this.context.knowledge.candidates(turn, projectId) : { enabled: false, candidates: [] },
      memory, nativeSession: scoped, contextIsolation: { policy: 'question-v2', questionIds: [...questionIds], rule: '只回答当前问题；关联问题历史不是其他任务的授权。不得引入无关话题。' }, requestId: turn.id, questionId: turn.questionId ?? null,
      environmentConnectionCandidates: connectionCandidates(state, turn, projectId),
      environmentEnrollment: Object.values(state.environmentEnrollments ?? {}).filter(e => e.questionId === turn.questionId).map(e => ({status:e.status,kind:e.kind,tier:e.tier,url:e.url})),
      questionSourceContext: sourceContext,
      questionResult: jobs.filter(job=>job.status==='completed'&&job.finalMessage&&job.evidence?.applicability==='historical_snapshot_not_current_check').slice(-1).map(job=>({jobId:job.id,sourceEnvironment:job.sourceEnvironment,recordedAt:job.evidence.recordedAt,finalMessage:job.finalMessage,policy:'已完成任务的历史交付，只可用于同话题解释或改写；不是新查询、实时状态或操作授权。'})),
      questionTask: turn.questionId ? questionJob(state, turn.questionId)?.id ?? null : null,
      questionOriginalRequest: turn.questionId ? questionRequest(state, turn.questionId) : null,
      currentActor: { senderId: turn.senderId, profile: turn.profile },
      environmentCatalog: routingCatalog(catalog(await loadEnvironments(), projectId)),
      role: turn.role, administrator: isAdministrator(projects, turn),
      sourcePolicy: { version: 'folder-evidence-v1', checkedNow: false,
        rule: '聊天未检查当前磁盘。历史回答、清单、旧工作区结果不代表当前文件存在或缺失。用户要求查看当前文件或实现时 requiresSourceInspection=true，创建新的只读调查；不要让用户补齐旧工作区没有带入的源码。' },
      project: projectId ? { id: projectId, name: projects.projects[projectId]?.displayName ?? projectId,
        sourceDirectory: projects.projects[projectId]?.repoPath ?? null,
        sourceEnvironments: sourceEnvironmentCatalog(projects.projects[projectId]),
        sourceEnvironmentRule: 'sourceEnvironments.id 是源码环境名，runtimeTier 是运行分级；例如 sit 对应 uat（测试），二者不能直接当成同一个ID。源码任务必须选择 sourceEnvironments 中匹配本问题的 id，不能从其它问题借用环境。本问题链questionSourceContext已有环境时直接沿用，不重复询问；用户明确切换时选择新环境的新调查。没有当前或关联问题的明确环境且未配置默认值时才询问用户；不能将 PRD 当 UAT，也不能用历史快照证明当前源码。',
        analysisWorkspace: 'Runner 先同步 analysisRepositories 各仓 origin 分支，再只读分析；缺配置或同步失败则阻塞',
        implementationWorkspace: 'Runner 创建的隔离 Git worktree；不自动包含独立子仓' } : null,
      knownProjects: isAdministrator(projects, turn) ? Object.entries(projects.projects).map(([id, item]) => ({ id, name: item.displayName ?? id })) : [],
      history: history.map((item) => ({ senderId: item.senderId, user: item.content, assistant: item.response, recordedAt: item.completedAt ?? item.createdAt,
        evidenceScope: 'conversation_history_not_current_filesystem', attachments: item.attachments?.map((a) => a.id) })),
      jobs, attachments, message: turn.content, currentAttachmentIds: turn.attachments.map((item) => item.id),
    }, this.memory.settings);
    return input;
  }

  async apply(turn) {
    if(turn.directoryChannel&&!['lookup_contact','reply'].includes(turn.decision.action))throw new Error('本群仅支持按姓名或工号查人，不执行开发、环境或数据库任务');
    const { store, projects } = this.context;
    let decision = turn.decision;
    const projectId = resolveProjectId(projects, turn.chatId, turn.profile);
    if(turn.directoryChannel){if(decision.action==='lookup_contact'){const result=await this.context.contacts.lookup(turn,decision.contactLookup);return result.contactImage?{...result,notice:'已核实联系人资料，图片结果仅本次提问者和群主可见。'}:result;}return {notice:'本群专用于查人，请提供同事姓名或完整工号；不执行开发、数据库或环境排查。'};}
    if (decision.knowledgeReceipt && this.context.knowledge) {
      const teamKnowledge = await this.context.knowledge.candidates(turn, projectId);
      decision = await this.context.knowledge.reuse(turn, projectId, decision, {teamKnowledge,jobs:[]});
      turn.decision = decision;
      await this.update(turn.id, {decision});
    }
    const attachmentIds = new Set(decision.attachmentIds);
    const attachments = (turn.attachmentPool ?? []).filter((item) => attachmentIds.has(item.id));
    if (attachments.length !== attachmentIds.size) throw new Error('AI 引用了不存在的附件，请重新说明。');
    if (decision.action === 'request_environment_setup') {
      if(decision.environmentSetup?.url)decision.environmentSetup=enrollmentTarget(decision.environmentSetup);
      // A bare endpoint cannot authorize local credential extraction: discover its source first.
      if(decision.environmentSetup?.kind==='mysql'&&decision.environmentSetup.url){
        const setup=decision.environmentSetup,u=new URL(setup.url),cfg=await loadEnvironments();
        const known=Object.values(cfg.environments).some(e=>e.projectId===projectId&&e.tier===setup.tier&&e.kind==='mysql'
          &&e.host===u.hostname&&e.port===Number(u.port||3306)&&e.database===u.pathname.slice(1)&&e.queries?.investigate?.mode==='investigate');
        const proven=connectionCandidates(await store.read(),turn,projectId).some(c=>c.url===setup.url&&c.tier===setup.tier&&c.connectionSource);
        if(!known&&!proven){turn.setupTargetUrl=setup.url;await this.update(turn.id,{setupTargetUrl:setup.url});setup.url='';}
      }

      if (decision.environmentSetup?.kind === 'mysql' && !decision.environmentSetup.url) {
        const candidates = connectionCandidates(await store.read(), turn, projectId).filter(e=>e.tier===decision.environmentSetup.tier && e.connectionSource && (!turn.setupTargetUrl||e.url===turn.setupTargetUrl));
        if (candidates.length === 1) decision.environmentSetup.url = candidates[0].url;
        else if (candidates.length > 1) return { notice: '发现多个数据库入口，请选择目标库名：' + candidates.map(e=>`${e.host}:${e.port}/${e.database}`).join('；') + '。无需提供密码。' };
        else {
          const sources = catalog(await loadEnvironments(), projectId).filter(e=>e.kind==='nacos' && e.tier===decision.environmentSetup.tier && e.queries.some(q=>q.queryId==='investigate'));
          const predecessor=(await store.read()).jobs?.find(j=>j.id===turn.setupSourceJobId && j.questionId===turn.questionId && j.projectId===projectId && j.chatId===turn.chatId && j.originProfile===turn.profile);
          const tier=decision.environmentSetup.tier;
          let sourceId;
          try{sourceId=sourceEnvironmentForTier(projects.projects[projectId],tier,decision.sourceEnvironment);}catch(error){return {notice:error.message};}
          const canInspect=projects.projects[projectId]?.analysisSourceMode==='isolated' && Object.hasOwn(projects.projects[projectId]?.analysisEnvironments??{},sourceId);
          if(sources.length===0 && canInspect && predecessor?.connectionSourceDiscovery?.tier!==tier){
            turn.connectionSourceDiscovery={tier,sourceEnvironment:sourceId};
            decision.action='create_task';decision.intent='analysis';decision.requiresSourceInspection=true;
            decision.sourceEnvironment=sourceId;decision.environmentSetup=null;decision.environmentQuery=null;
            decision.reply='先自动核查对应环境源码、部署脚本和配置注入链，寻找数据源与登录入口；不需要用户先找地址。';
            decision.instruction+='\n\n接入来源自主发现：当前系统本环境尚无登记数据源。请在指定环境分支检查相关微服务的bootstrap/application、构建profile、部署脚本、配置注入/环境变量和规范文档，追溯实际配置平台及订单等所需业务对象的数据源。不能默认是Nacos；区分配置中心、注册中心、网关和数据库。输出脱敏候选、来源仓库/文件/行/提交号、是否注释或占位，以及还需什么运行态证据；注释地址或其它服务配置只能作为线索，不能当作当前运行事实。不输出用户名密码令牌，不从源码用shell联网查库。若能确认受支持的配置中心入口，按受控接入流程申请；需要平台登录或范围确认时明确说明具体入口、平台与用途。仅在本次查找确实无法补齐时说明已查范围和剩余缺口，不重复让用户猜数据库地址，不放弃原查询和导出目标。';
          }else if (sources.length !== 1) return { notice: sources.length===0
            ? `${projects.projects[projectId]?.displayName??projectId} 的 ${tier.toUpperCase()} 数据源尚未接入，尚未查询数据或生成文件。`+(predecessor?.connectionSourceDiscovery?.tier===tier?'已自动检查对应环境源码与部署配置，具体发现和未核实线索见此前调查结果；还需对应平台登录或运行态配置才能验证，不能把历史注释当成有效连接。':'请确认该项目的源码环境配置，以便助手自行查找接入来源。')
            : '当前环境存在多个配置来源，请选择本次使用的入口：'+sources.map(e=>e.environmentId).join('、')+'。尚未查询数据库，原需求与证据保留。' };
          else {
            decision.action = 'create_task'; decision.intent = 'analysis';
            decision.environmentQuery = {environmentId:sources[0].environmentId,queryId:'investigate',parameters:[`使用discover和read_config获取${turn.setupTargetUrl??'公共数据库'}配置的地址及来源，用于管理员确认后本机接续凭据；不连接数据库、不返回账号密码。`.slice(0,200)]};
          }
        }
      }
      if(decision.action==='request_environment_setup'&&decision.environmentSetup?.url){
        const setup=decision.environmentSetup,u=new URL(setup.url),config=await loadEnvironments();
        const known=Object.entries(config.environments).find(([,e])=>e.projectId===projectId&&e.tier===setup.tier&&e.kind===setup.kind
          &&e.queries?.investigate?.mode==='investigate'&&(e.kind==='mysql'?e.host===u.hostname&&e.port===Number(u.port||3306)&&e.database===u.pathname.slice(1):e.baseUrl.replace(/\/$/,'')===setup.url.replace(/\/$/,'')));
        if(known){decision.action='create_task';decision.intent='analysis';decision.environmentQuery={environmentId:known[0],queryId:'investigate',parameters:[decision.instruction.slice(0,200)]};decision.environmentSetup=null;}
      }
      if (decision.action === 'request_environment_setup') return requestEnrollment(this.context, turn);
    }
    if (['approve_environment_setup','approve_environment_without_tls'].includes(decision.action)) return approveEnrollment(this.context, turn);
    if (decision.action === 'lookup_contact') {
      if(!this.context.contacts)throw new Error('联系人功能尚未配置。');
      return this.context.contacts.lookup(turn,decision.contactLookup);
    }
    if (decision.action === 'reply') return {};
    if (decision.action === 'bind_project') {
      if (Object.hasOwn(projects.chatProfileProjectMap ?? {}, turn.chatId)) throw new Error('系统助手的项目绑定只能在本机配置中修改。');
      if (!isAdministrator(projects, turn)) throw new Error('只有真人管理员可以绑定项目，项目负责人机器人不是管理员。');
      if (!Object.hasOwn(projects.projects, decision.projectId)) throw new Error('项目不存在。');
      if (projectId && projectId !== decision.projectId) throw new Error('本群已绑定项目，变更绑定需在本地配置中确认。');
      projects.chatProjectMap[turn.chatId] = decision.projectId;
      await saveProjects(this.context.config.projectsFile, projects);
      return { notice: `已绑定：${projects.projects[decision.projectId].displayName ?? decision.projectId}` };
    }
    if (!projectId || !projects.projects[projectId]) throw new Error('本群尚未绑定有效代码项目，可以先继续讨论。');
    if (decision.projectId && decision.projectId !== projectId) throw new Error('不能操作本群绑定范围外的项目。');
    if (decision.action === 'create_task') {
      if (!canCreateTask(projects, turn, decision.intent)) {
        throw new Error('只有真人管理员可以创建会执行修改、规划、测试或审计的任务；普通成员可以继续提问，或发起只读源码排查。');
      }
      if (turn.questionId) {
        const current = questionJob(await store.read(), turn.questionId);
        if (current && activeQuestionJob(current)) throw new Error('这个问题已有未结束任务；请补充当前任务，或重新 @ 发起一个独立问题。');
      }
      let environmentAccess;
      if (decision.environmentQuery) {
        if (!turn.questionId) throw new Error('环境查询需要开启问题主卡片并在群里发起');
        environmentAccess = planQuery(await loadEnvironments(), decision.environmentQuery, projectId, turn);
      }
      let sourceEnvironment;
      if (decision.intent === 'analysis') {
        // Environment-first investigations still return to the same source worker.
        // Preserve an explicit source choice, otherwise use the verified runtime
        // tier through this project's explicit/standard mapping, never as a branch ID.
        try { sourceEnvironment = environmentAccess
          ? sourceEnvironmentForTier(projects.projects[projectId],environmentAccess.tier,decision.sourceEnvironment)
          : selectSourceEnvironment(projects.projects[projectId],decision.sourceEnvironment || questionSourceContext(await store.read(),{...turn,projectId},projects.projects[projectId])?.id);  }
        catch (error) { return { notice: error.message }; }
      }
      // Every newly created analysis uses the same persistent developer job,
      // including questions whose first useful step is an environment query.
      // Legacy single_developer/analysis_review jobs remain readable in the
      // store, but must not be created by new intake.
      const route = decision.intent === 'analysis'
        ? { stage: 'developer', workflow: 'continuous_analysis' }
        : routeDecision(turn.role, decision.intent);
      const routing = agentRouting(this.context, route.stage, turn.profile);
      if (route.workflow === 'continuous_analysis' && !routing.agentProfile) throw new Error('代码分析需要配置开发机器人 profile；本次未创建任务。');
      await store.transact(s => { const t = (s.conversations ?? []).find(x=>x.id===turn.id); if(t) t.decision=structuredClone(decision); });
      const created = await store.createJob({
        projectId, projectName: projects.projects[projectId].displayName ?? projectId,
        ...(turn.setupSourceJobId?{context:turn.investigationContext??[],missionId:turn.resumeMissionId}:{}),
        chatId: turn.chatId, senderId: turn.senderId, originProfile: turn.profile,
        originChatType: turn.chatType, visibility:turn.visibility, questionId: turn.questionId, environmentAccess, sourceEnvironment,
        connectionSourceDiscovery:turn.connectionSourceDiscovery,
        connectionEnrollmentPending: decision.environmentSetup?.kind === 'mysql' && !decision.environmentSetup.url,
        ...(environmentAccess?.approvalRequired ? { status: 'awaiting_environment_approval' } : {}),
        sourceMessageId: turn.environmentResumeKey ? `${turn.id}:enrollment:${turn.environmentResumeKey}` : turn.id, replyToMessageId: turn.messageId,
        requestedAgentRole: turn.role, requestedAgentProfile: turn.profile,
        ...routing, ...route, continuousInvestigation: route.workflow === 'continuous_analysis', taskIntent: decision.intent, instruction: decision.instruction,
        tabularDelivery:decision.requiresTabularDelivery===true,
        currentQuestion:turn.questionId?questionObjective(await store.read(),turn.questionId):turn.content,
        originalQuestion: turn.questionId ? questionRequest(await store.read(), turn.questionId) : turn.content,
        attachments: [...(turn.resumeAttachments??[]),...attachments],
        delegation: route.stage !== turn.role ? { fromStage: turn.role, toStage: route.stage,
          reason: route.workflow === 'continuous_analysis' ? '交给开发在同一会话内完成只读调查和最终回答' : '按角色边界转交负责人协调' } : null,
      });
      if(turn.setupPending && !decision.environmentSetup)await this.update(turn.id,{setupPending:false});
      return { jobId: created.job.id, notice: `已创建任务 ${created.job.id}\n项目：${created.job.projectName}\n交给：${stageLabel(created.job.stage)}\n${route.workflow === 'continuous_analysis' ? '执行：同一开发会话持续完成源码与环境只读调查\n' : ''}状态：${created.job.status === 'awaiting_environment_approval' ? '等待环境负责人批准本次查询' : '等待执行'}` };
    }
    const job = await store.getJob(decision.jobId);
    if (!job || job.chatId !== turn.chatId || job.projectId !== projectId) throw new Error('本群没有这个任务，不能跨群操作。');
    if(isPrivate(await store.read(),job)&&(turn.visibility!=='requester'||job.senderId!==turn.senderId))throw new Error('请在原私有问题中操作，不能公开其他私有结果');
    if (turn.questionId && job.questionId !== turn.questionId) throw new Error('请回复对应问题的主卡片操作任务，不能在一个问题里推进另一个问题。');
    if (decision.action === 'approve_environment') {
      const e = verifyPlan(await loadEnvironments(), job.environmentAccess ?? {});
      if (!isEnvironmentOwner(e, turn)) throw new Error('只有本环境指定负责人可以批准查询');
      const updated = await store.approveEnvironment(job.id, turn.senderId, job.environmentAccess.scopeHash, turn.id);
      return { jobId: updated.id, notice: '已批准本次固定范围只读查询；该批准不能用于其他查询或修改操作。' };
    }
    const admin = isAdministrator(projects, turn);
    if (decision.action === 'approve') {
      if (!admin) throw new Error('只有真人管理员可以放行。请使用已配置管理员身份 @项目负责人 确认；机器人角色不等于管理员。');
      const approved = await store.approve(job.id, turn.senderId, agentRouting(this.context, nextStage(job.workflow, job.stage), job.originProfile), turn.id);
      return { jobId: job.id, nextJobId: approved.nextJob.id, notice: `已放行 ${job.id}\n下一阶段：${stageLabel(approved.nextJob.stage)}（${approved.nextJob.id}）` };
    }
    if (!admin && !isTaskCreator(projects, job, turn)) throw new Error('只有任务发起人或真人管理员可以补充/取消该任务；转交后需配置跨应用真人身份映射。');
    if (decision.action === 'clarify') {
      if (!canContinueTask(projects, job, turn)) {
        throw new Error('只有真人管理员可以补充并继续非只读任务；普通成员只能继续自己的只读源码排查。');
      }
      const resumed = await store.resumeClarification(job.id, {
        instruction: decision.instruction, sourceMessageId: turn.environmentResumeKey ? `${turn.id}:enrollment:${turn.environmentResumeKey}` : turn.id, replyToMessageId: turn.messageId,
        senderId: turn.senderId, attachments,
      }, turn.id);
      return { jobId: job.id, notice: `${resumed.id} 已收到补充，将重新执行当前阶段。` };
    }
    if (decision.action === 'cancel') {
      const cancelled = await store.cancel(job.id, turn.senderId, turn.id);
      await this.context.notifyJobEvent?.({ job: cancelled, event: { type: cancelled.status === 'cancelling' ? 'cancel_requested' : 'cancelled' } });
      return { jobId: job.id, notice: `${job.id} ${cancelled.status === 'cancelling' ? '已请求停止，等待执行器确认退出' : '已取消'}。` };
    }
    throw new Error('不支持的操作。');
  }
}

export function routeDecision(role, intent) {
  if (intent === 'analysis' && ['owner_intake', 'owner_report', 'pm', 'developer'].includes(role)) {
    return { stage: 'developer', workflow: 'continuous_analysis' };
  }
  if (intent === 'implementation') {
    const stage = ['qa', 'owner_audit', 'owner_report'].includes(role) ? 'owner_intake' : role;
    return { stage, workflow: workflowForStage(stage) };
  }
  // Read/plan/test requests are single-stage, never silently escalated to coding.
  return { stage: role, workflow: `single_${role}` };
}

export function questionRequest(state, questionId) {
  const turns = [];
  const seen = new Set();
  let question = state.questions?.[questionId];
  while (question && !seen.has(question.id)) {
    seen.add(question.id);
    const turn = state.conversations?.find(item => item.id === question.rootTurnId);
    if (turn?.content?.trim()) turns.push(turn.content.trim());
    question = state.questions?.[question.parentQuestionId];
  }
  return turns.reverse().filter((text, index, all) => index === 0 || text !== all[index - 1])
    .map((text, index) => index === 0 ? text : `后续补充：${text}`).join('\n\n') || null;
}

export function questionObjective(state,questionId){
 const question=state.questions?.[questionId],text=state.conversations?.find(t=>t.id===question?.rootTurnId)?.content?.trim();
 if(!text)return questionRequest(state,questionId);
 const residue=text.replace(/!\[[^\]]*\]\([^)]*\)|@\S+/g,'').replace(/(?:prd|uat|sit|测试|生产|环境|的|在|中|是|这个|那个|继续|接着|再|一下|[\s，,。.!！?？])/gi,'');
 return residue?text:questionRequest(state,questionId);
}

function agentRouting(context, role, profile) {
  return routeAgent(context.agents.agents, role, profile);
}

export function splitReply(text, size = 2500) {
  const parts = [];
  const points = Array.from(String(text));
  for (let i = 0; i < points.length; i += size) parts.push(points.slice(i, i + size).join(''));
  return parts;
}

export function responseMessageId(value) {
  if (!value || typeof value !== 'object') return null;
  if (typeof value.message_id === 'string') return value.message_id;
  for (const child of Object.values(value)) {
    if (child && typeof child === 'object') { const found = responseMessageId(child); if (found) return found; }
  }
  return null;
}

export function conversationProject(turn) {
  if (Object.hasOwn(turn, 'projectId')) return turn.projectId;
  try {
    const key = JSON.parse(turn.sessionKey);
    return Array.isArray(key) && key.length === 5 ? key[4] : undefined;
  } catch { return undefined; }
}
