import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { createControlPlane, notifyJobEvent, repairStaleTerminalQuestionCards } from '../src/control-plane/server.js';
import { publishQuestion, questionJob, questionView } from '../src/control-plane/questions.js';
import { handleCardAction } from '../src/control-plane/card-actions.js';
import { jobActionVersion, jobCard } from '../src/control-plane/message-cards.js';
import { CodexConversationEngine } from '../src/control-plane/codex-conversation.js';
import { loadConversationSettings } from '../src/control-plane/conversation-settings.js';
import { saveCodexRuntimeSettings } from '../src/shared/codex-runtime.js';
const decision = (extra = {}) => ({ action: 'reply', intent: 'none', reply: '收到', instruction: '', projectId: '', jobId: '', attachmentIds: [], ...extra });
async function setup(t, decide = () => decision()) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'agentos-questions-'));
  const calls = [], inputs = [];
  const feishu = {
    replyCard: async (id, card, options) => { calls.push({ type: 'send', id, card, options }); return { message_id: `card-${calls.length}` }; },
    updateCard: async (id, card, options) => { calls.push({ type: 'patch', id, card, options }); },
    reply: async (id, text, options) => { calls.push({ type: 'mention', id, text, options }); return { message_id: 'notice' }; },
  };
  const app = await createControlPlane({ dataDir: directory, storeFile: path.join(directory, 'state.json'),
    projectsFile: path.join(directory, 'projects.json'), conversationFile: path.join(directory, 'conversation.json'),
    projects: { chatProjectMap: { group: 'demo' }, projects: { demo: { displayName: 'Demo' } }, ownerOpenIdsByProfile: { owner: ['ou_admin'] } },
    agents: { agents: { owner_intake: { profile: 'owner' }, developer: { profile: 'dev' }, pm: { profile: 'pm' } } },
    feishuClient: feishu, conversationOptions: { groupSessions: true, questionCards: true, feedbackMs: 0 },
    conversationResponder: async (input) => { inputs.push(input); return decide(input); } });
  const context = { ...app, feishu };
  const send = async (id, sender = 'ou_asker', extra = {}) => {
    await app.conversations.enqueue({ message_id: id, chat_id: 'group', sender_id: sender, chat_type: 'group',
      agent_profile: 'owner', agent_role: 'owner_intake', content: `question-${id}`, ...extra });
    await app.conversations.idle();
  };
  t.after(async () => { await app.conversations.stop(); await app.cards.stop(); await rm(directory, { recursive: true, force: true }); });
  return { app, context, send, calls, inputs, directory };
}
test('five senders have five durable question cards, isolated intake context, current actor authority', async (t) => {
  const { app, send, calls, inputs } = await setup(t);
  await Promise.all(Array.from({ length: 5 }, (_, i) => send(`m${i}`, i ? `ou_person${i}` : 'ou_admin')));
  const state = await app.store.read();
  assert.equal(Object.keys(state.questions).length, 5);
  assert.equal(Object.keys(state.cardMessages).length, 5);
  assert.equal(calls.filter((c) => c.type === 'send').length, 5);
  assert.equal(new Set(calls.filter((c) => c.type === 'send').map((c) => c.id)).size, 5);
  assert.equal(inputs.find(input=>input.currentActor.senderId==='ou_admin').administrator, true);
  assert.ok(inputs.filter(input=>input.currentActor.senderId!=='ou_admin').every(input=>input.administrator===false));
  assert.equal(inputs[4].history.length, 0); assert.equal(inputs[4].nativeSession, true);
  assert.equal(new Set(state.conversations.map((c) => app.conversations.key(c))).size, 5);
});
test('question card stays owned by intake bot across developer/report, mentions only final original asker', async (t) => {
  const { app, context, send, calls } = await setup(t, () => decision({ action: 'create_task', intent: 'analysis', instruction: '只读检查' }));
  await send('m');
  let state = await app.store.read(); const job = state.jobs[0], qid = job.questionId;
  assert.ok(qid); assert.equal(calls.filter((c) => c.type === 'mention').length, 0);
  await notifyJobEvent(context, { job, event: { type: 'started' } });
  await app.store.transact((s) => {
    const first = s.jobs[0]; first.status = 'completed'; first.nextJobId = 'JOB-report';
    s.jobs.push({ ...structuredClone(first), id: 'JOB-report', nextJobId: null, stage: 'owner_report', agentProfile: 'owner', status: 'running' });
  });
  await notifyJobEvent(context, { job, event: { type: 'completed' } });
  assert.equal(calls.filter((c) => c.type === 'mention').length, 0);
  assert.match(JSON.stringify(calls.at(-1).card), /项目负责人.*执行中/);
  await app.store.transact((s) => { s.jobs[1].status = 'completed'; s.jobs[1].result = { finalMessage: '完整结论' }; });
  await notifyJobEvent(context, { job, event: { type: 'progress', phase: 'tool_activity' } });
  await publishQuestion(context, qid);
  assert.equal(calls.filter((c) => c.type === 'send').length, 1);
  assert.equal(calls.filter((c) => c.type === 'mention').length, 1);
  assert.ok(calls.every((c) => c.options.profile === 'owner'));
  assert.match(calls.find((c) => c.type === 'mention').text, /ou_asker/);
  assert.equal((await app.store.read()).cardMessages[`question:${qid}`].terminal, true);
});
test('completed answer survives followup; new card retains parent association', async (t) => {
  const { app, send, calls } = await setup(t);
  await send('m'); const s = await app.store.read(), key = Object.keys(s.cardMessages)[0], card = s.cardMessages[key];
  await send('follow', 'ou_asker', { reply_to: card.messageId });
  let state = await app.store.read(); assert.equal(Object.keys(state.questions).length, 2);
  assert.equal(state.cardMessages[key].messageId, card.messageId);
  assert.deepEqual(state.cardMessages[key].card, card.card);
  assert.equal(state.questions[state.conversations[1].questionId].parentQuestionId, state.conversations[0].questionId);
  assert.equal(state.cardMessages[key].generation, 1);
  assert.equal(calls.filter((c) => c.type === 'mention').length, 2);
  assert.equal(new Set(calls.filter((c) => c.type === 'mention').map((c) => c.options.idempotencyKey)).size, 2);
  await send('stranger', 'ou_other', { reply_to: card.messageId });
  await send('new', 'ou_asker');
  assert.equal(Object.keys((await app.store.read()).questions).length, 4);
  await app.cards.upsert(key, card.card, card.destination, { generation: 1, terminal: true, immediate: true });
  assert.equal((await app.store.read()).cardMessages[key].generation, 1);
});
test('a followup cannot duplicate a running question task or borrow administrator authority', async (t) => {
  const { app, send } = await setup(t, (input) => decision({ action: 'create_task', intent: input.message.includes('write') ? 'implementation' : 'analysis', instruction: '检查' }));
  await send('m'); let state = await app.store.read(); const card = Object.values(state.cardMessages)[0];
  await send('follow', 'ou_asker', { reply_to: card.messageId });
  assert.equal((await app.store.read()).jobs.length, 1);
  await send('write', 'ou_person');
  state = await app.store.read(); assert.equal(state.jobs.length, 1); assert.match(state.conversations.at(-1).actionError, /管理员/);
});
test('question callback resolves current stage on original bot; creator can cancel analysis, stranger cannot', async (t) => {
  const { app, context, send } = await setup(t, () => decision({ action: 'create_task', intent: 'analysis', instruction: '检查' }));
  await send('m'); const state = await app.store.read(), job = state.jobs[0], card = Object.values(state.cardMessages)[0];
  const event = { type: 'card.action.trigger', event_id: 'denied', operator_id: 'ou_other', agent_profile: 'owner',
    message_id: card.messageId, chat_id: 'group', card_content: JSON.stringify(card.card), action_value: { action: 'cancel', version: jobActionVersion(job) } };
  assert.equal((await handleCardAction(context, event)).ok, false);
  assert.equal((await app.store.getJob(job.id)).status, 'queued');
  assert.equal((await handleCardAction(context, { ...event, event_id: 'accepted', operator_id: 'ou_asker' })).ok, true);
  assert.equal((await app.store.getJob(job.id)).status, 'cancelled');
  assert.equal(Object.keys((await app.store.read()).cardMessages).length, 1);
});
test('startup repairs a terminal question card left with stale cancel and refresh buttons',async t=>{
  const {app,context,send,calls}=await setup(t,()=>decision({action:'create_task',intent:'analysis',instruction:'检查'}));
  await send('m');let state=await app.store.read();const job=state.jobs[0],key=`question:${job.questionId}`;
  const waiting={...job,status:'awaiting_clarification',result:{browserLoginRequired:true,finalMessage:'等待登录'}};
  await app.store.transact(s=>{const current=s.jobs[0];current.status='cancelled';current.result=waiting.result;const saved=s.cardMessages[key];saved.card=jobCard(waiting);saved.card.body.elements=saved.card.body.elements.filter(element=>!JSON.stringify(element).includes('"action":"cancel"'));saved.terminal=true;saved.terminalMention={replyTo:'root',profile:'owner',text:'旧版结束提醒'};saved.mentionDelivered=true;saved.deliveredRevision=saved.revision;});
  assert.doesNotMatch(JSON.stringify((await app.store.read()).cardMessages[key].card),/"action":"(?:cancel|refresh)"/);
  assert.match((await app.store.read()).cardMessages[key].card.header.title.content,/恢复网页登录/);
  assert.equal(await repairStaleTerminalQuestionCards(context),1);state=await app.store.read();
  assert.doesNotMatch(JSON.stringify(state.cardMessages[key].card),/"action":"(?:cancel|refresh)"/);
  assert.match(state.cardMessages[key].card.header.subtitle.content,/已取消/);
  assert.equal(state.cardMessages[key].terminalMention.text,'旧版结束提醒');
  assert.equal(state.jobs[0].status,'cancelled');assert.ok(calls.some(call=>call.type==='patch'));
});
test('card refresh failure is recorded without replaying an accepted business callback', async (t) => {
  const { app, context, send } = await setup(t, () => decision({ action: 'create_task', intent: 'analysis', instruction: '检查' }));
  await send('m'); const state = await app.store.read(), job = state.jobs[0], card = Object.values(state.cardMessages)[0];
  context.cards.upsert = async () => { throw new Error('Requester mention identity cannot change'); };
  const result = await handleCardAction(context, { type: 'card.action.trigger', event_id: 'refresh-once', operator_id: 'ou_asker', agent_profile: 'owner',
    message_id: card.messageId, chat_id: 'group', card_content: JSON.stringify(card.card),
    action_value: { action: 'refresh', version: jobActionVersion(job) } });
  assert.equal(result.ok, true);
  const updated = await app.store.read();
  assert.equal(updated.cardCallbackAudit.at(-1).outcome, 'accepted');
  assert.equal(updated.cardActionPresentationFailures.at(-1).reason, 'card_refresh_failed');
});
test('old question-stage button cannot operate a successor with same empty event history', async (t) => {
  const { app, context, send } = await setup(t, () => decision({ action: 'create_task', intent: 'analysis', instruction: '检查' }));
  await send('m'); const state = await app.store.read(), job = state.jobs[0], card = Object.values(state.cardMessages)[0];
  await app.store.transact((s) => { s.jobs[0].status = 'completed'; s.jobs[0].nextJobId = 'NEXT'; s.jobs.push({ ...s.jobs[0], id: 'NEXT', nextJobId: null, status: 'queued', stage: 'owner_report', agentProfile: 'owner' }); });
  await publishQuestion(context, job.questionId);
  const result = await handleCardAction(context, { type: 'card.action.trigger', event_id: 'old', operator_id: 'ou_admin', agent_profile: 'owner',
    message_id: card.messageId, chat_id: 'group', card_content: JSON.stringify(card.card), action_value: { action: 'cancel', version: jobActionVersion(job) } });
  assert.equal(result.ok, false); assert.equal((await app.store.getJob('NEXT')).status, 'queued');
});
test('persistent session resumes across engine restart, caches decisions, and keeps private registry', async (t) => {
  const { directory } = await setup(t); const calls = [];
  function engine() {
    const e = new CodexConversationEngine({ dataDir: directory }); e.cwd = directory; e.rules = 'rules'; e.schema = {};
    e.start = async () => {}; e.app = { generation: 1, start: async () => {}, close: async () => {},
      request: async (name, args) => { calls.push({ name, args }); return { thread: { id: args.threadId ?? 'persistent-id' } }; },
      turn: async (args) => { calls.push({ name: 'turn', args }); return { text: JSON.stringify(decision()), timing: {} }; } };
    return e;
  }
  const input = { nativeSession: true, requestId: 'one', role: 'owner_intake', history: [{ user: 'bootstrap' }], attachments: [] };
  const first = engine(); await first.decide(input, { sessionKey: 'group-a' }); await first.close();
  const second = engine(); await second.decide(input, { sessionKey: 'group-a' });
  assert.equal(calls.filter((c) => c.name === 'turn').length, 1);
  await second.decide({ ...input, requestId: 'two' }, { sessionKey: 'group-a' }); await second.close();
  assert.equal(calls.filter((c) => c.name === 'thread/start').length, 1);
  assert.equal(calls.filter((c) => c.name === 'thread/resume').length, 1);
  assert.equal(calls.find((c) => c.name === 'thread/start').args.ephemeral, false);
  assert.match(calls.filter((c) => c.name === 'turn')[1].args.input[0].text, /"history":\[\]/);
  assert.equal((await stat(path.join(directory, 'codex-conversations.json'))).mode & 0o777, 0o600);
});
test('changing the console model starts a new conversation thread without reusing the old model', async (t) => {
  const { directory } = await setup(t); const file = path.join(directory, 'codex-runtime.json'); const calls = [];
  await saveCodexRuntimeSettings({ model: 'gpt-5.6-sol', reasoningEffort: 'high' }, { file });
  const e = new CodexConversationEngine({ dataDir: directory, file }); e.cwd = directory; e.rules = 'rules'; e.schema = {};
  e.start = async () => {}; e.app = { generation: 1, start: async () => {}, close: async () => {},
    request: async (name, args) => { calls.push({ name, args }); return { thread: { id: `thread-${calls.filter((item) => item.name === 'thread/start').length}`, model: args.model } }; },
    turn: async (args) => { calls.push({ name: 'turn', args }); return { threadId: args.threadId, text: JSON.stringify(decision()), timing: {} }; } };
  const input = { role: 'owner_intake', attachments: [] };
  await e.decide(input, { sessionKey: 'group' });
  await saveCodexRuntimeSettings({ model: 'gpt-6-astra', reasoningEffort: 'xhigh' }, { file });
  await e.decide(input, { sessionKey: 'group' });
  assert.deepEqual(calls.filter((item) => item.name === 'thread/start').map((item) => item.args.model), ['gpt-5.6-sol', 'gpt-6-astra']);
  assert.deepEqual(calls.filter((item) => item.name === 'turn').map((item) => item.args.effort), ['high', 'xhigh']);
  await e.close();
});
test('invalid opt-in settings or corrupt registry fail closed without overwriting saved sessions', async (t) => {
  const { directory } = await setup(t); const f = path.join(directory, 'settings.json');
  assert.deepEqual(await loadConversationSettings(f), { groupSessions: false, questionCards: false });
  await writeFile(f, JSON.stringify({ groupSessions: 'yes', questionCards: true }));
  await assert.rejects(loadConversationSettings(f));
  const e = new CodexConversationEngine({ dataDir: directory });
  await writeFile(e.registry.file, '{broken');
  await assert.rejects(e.registry.set('x', {}));
});
test('question clarification reopens same card and owner-profile approval creates one successor', async (t) => {
  const { app, context, send, calls } = await setup(t, () => decision({ action: 'create_task', intent: 'implementation', instruction: '实施' }));
  await send('m', 'ou_admin'); let s = await app.store.read(); const first = s.jobs[0], key = `question:${first.questionId}`;
  await app.store.transact((state) => { state.jobs[0].status = 'awaiting_clarification'; });
  await publishQuestion(context, first.questionId);
  s = await app.store.read(); const job = s.jobs[0], card = s.cardMessages[key];
  const callback = { type: 'card.action.trigger', event_id: 'clarify', operator_id: 'ou_admin', agent_profile: 'owner',
    message_id: card.messageId, chat_id: 'group', card_content: JSON.stringify(card.card),
    action_name: `clarify_${jobActionVersion(job)}`, form_value: { clarification: '确认范围' } };
  assert.equal((await handleCardAction(context, callback)).ok, true);
  s = await app.store.read(); assert.equal(s.jobs[0].status, 'queued'); assert.equal(s.cardMessages[key].terminal, false);
  await app.store.transact((state) => { state.jobs[0].status = 'awaiting_approval'; state.jobs[0].result = { finalMessage: '规划结果', outcome: 'ready' }; });
  await publishQuestion(context, first.questionId); s = await app.store.read();
  const approve = { ...callback, event_id: 'approve', action_name: '', action_value: { action: 'approve', version: jobActionVersion(s.jobs[0]) }, card_content: JSON.stringify(s.cardMessages[key].card) };
  assert.equal((await handleCardAction(context, approve)).ok, true);
  s = await app.store.read(); assert.equal(s.jobs.length, 2); assert.equal(s.jobs[1].questionId, first.questionId);
  assert.equal(s.cardMessages[key].terminal, false); assert.equal(calls.filter((c) => c.type === 'send').length, 1);
  assert.equal(calls.filter((c) => c.type === 'mention').length, 0);
});
test('question pagination is display-only and source-sync blocking mentions asker and administrator once', async (t) => {
  const { app, context, send, calls } = await setup(t, () => decision({ action: 'create_task', intent: 'analysis', instruction: '检查' }));
  await send('m'); let state = await app.store.read(); const job = state.jobs[0];
  await app.store.transact((s) => { s.jobs[0].status = 'blocked'; s.jobs[0].result = { sourceSyncBlocked: true, finalMessage: '需要解决仓库冲突。\n'.repeat(800) }; });
  await publishQuestion(context, job.questionId); state = await app.store.read(); const card = Object.values(state.cardMessages)[0];
  const find = (node) => { if (!node || typeof node !== 'object') return null; if (node.value?.action === 'result_page' && node.value.page === 1) return node.value; for (const v of Object.values(node)) { const x = find(v); if (x) return x; } return null; };
  const value = find(card.card); assert.ok(value);
  const result = await handleCardAction(context, { type: 'card.action.trigger', event_id: 'page', operator_id: 'ou_asker', agent_profile: 'owner',
    message_id: card.messageId, chat_id: 'group', card_content: JSON.stringify(card.card), action_value: value });
  assert.equal(result.ok, true); assert.deepEqual((await app.store.read()).jobs, state.jobs);
  const mentions = calls.filter((c) => c.type === 'mention'); assert.equal(mentions.length, 1);
  assert.match(mentions[0].text, /ou_asker/); assert.match(mentions[0].text, /ou_admin/);
});
test('persistent pending turn starts fresh and a resume transport error does not silently fork', async (t) => {
  const { directory } = await setup(t); const e = new CodexConversationEngine({ dataDir: directory });
  e.start = async () => {}; e.rules = 'rules'; e.cwd = directory; e.schema = {};
  const calls = [];
  e.app = { generation: 1, start: async () => {}, request: async (name) => { calls.push(name); if (name === 'thread/resume') throw new Error('transport'); return { thread: { id: 'new' } }; },
    turn: async () => ({ text: JSON.stringify(decision()), timing: {} }) };
  await e.registry.set('g', { threadId: 'uncertain', pending: 'previous' });
  const input = { nativeSession: true, requestId: 'now', role: 'owner_intake', attachments: [], history: [] };
  await e.decide(input, { sessionKey: 'g' }); assert.ok(calls.includes('thread/start')); assert.ok(!calls.includes('thread/resume'));
  e.sessions.clear(); calls.length = 0;
  await assert.rejects(e.decide({ ...input, requestId: 'later' }, { sessionKey: 'g' }), /transport/);
  assert.deepEqual(calls, ['thread/resume']);
});

test('question details retain completed predecessor results after a later stage fails',()=>{
 const state={questions:{q:{id:'q',title:'Investigate',latestTurnId:'t2',rootTurnId:'t1',profile:'owner',senderId:'ou_user',messageId:'m'}},conversations:[{id:'t1',questionId:'q',status:'sent',chatType:'group',response:'Earlier approval',outcome:{}},{id:'t2',questionId:'q',status:'sent',response:'Latest',outcome:{jobId:'j2'}}],jobs:[{id:'j1',questionId:'q',status:'completed',stage:'developer',events:[],result:{finalMessage:'Earlier database endpoint evidence',summary:'Earlier'}},{id:'j2',questionId:'q',status:'blocked',stage:'developer',events:[],result:{finalMessage:'Current failure details',summary:'Failed'}}]};
 const view=questionView(state,'q',{}),card=JSON.stringify(view.card);assert.match(view.resultText,/Earlier database endpoint evidence/);assert.match(view.resultText,/Current failure details/);assert.match(view.resultText,/Earlier approval/);assert.match(card,/此前.*保留/);assert.match(card,/流程：开发/);assert.doesNotMatch(card,/开发.*→.*开发/);assert.deepEqual(state.jobs[0].result.summary,'Earlier');
});

test('question titles remove rich-text markers while preserving literal underscores',async()=>{
 const {questionTitle}=await import('../src/control-plane/questions.js');
 assert.equal(questionTitle('**帮我查看** **EP-20260814-0001**'),'帮我查看 EP-20260814-0001');
 assert.equal(questionTitle('[查看](https://example.invalid) `activity_code`'),'查看 activity_code');
});

test('two simultaneous topics cannot borrow the other asker task, attachment or history',async(t)=>{
 const {app,send,inputs}=await setup(t,()=>decision({action:'create_task',intent:'analysis',instruction:'topic-specific'}));
 await send('gift','ou_admin',{content:'搭赠揉价',attachments:[{id:'gift-file'}]});
 await send('warehouse','ou_person',{content:'仓管核销'});
 const input=inputs.at(-1);assert.equal(input.history.length,0);assert.equal(input.jobs.length,0);assert.equal(input.attachments.length,0);
 assert.doesNotMatch(JSON.stringify(input),/搭赠揉价|gift-file/);
 const state=await app.store.read();assert.notEqual(app.conversations.key(state.conversations[0]),app.conversations.key(state.conversations[1]));
});
test('explicit followup receives only its own ancestry and a new native session',async(t)=>{
 const {app,send,inputs}=await setup(t);
 await send('first','ou_asker',{content:'仓管核销'});let state=await app.store.read();const first=state.conversations[0],card=state.cardMessages['question:'+first.questionId];
 await send('unrelated','ou_asker',{content:'搭赠揉价'});
 await send('follow','ou_asker',{reply_to:card.messageId,content:'前面是PRD吗'});
 const input=inputs.at(-1);assert.deepEqual(input.history.map(x=>x.user),['仓管核销']);assert.doesNotMatch(JSON.stringify(input),/搭赠揉价/);
 state=await app.store.read();assert.notEqual(app.conversations.key(first),app.conversations.key(state.conversations.at(-1)));
});
test('supplement on running question reuses its own session and excludes unrelated jobs',async(t)=>{
 const {app,send,inputs}=await setup(t,input=>input.message==='补充'?decision():decision({action:'create_task',intent:'analysis',instruction:input.message}));
 await send('a','ou_asker',{content:'问题A'});let state=await app.store.read();const first=state.conversations[0],card=state.cardMessages['question:'+first.questionId];
 await send('b','ou_other',{content:'问题B'});
 await send('supplement','ou_asker',{reply_to:card.messageId,content:'补充'});
 state=await app.store.read();assert.equal(app.conversations.key(first),app.conversations.key(state.conversations.at(-1)));
 assert.equal(inputs.at(-1).jobs.length,1);assert.equal(inputs.at(-1).jobs[0].instruction,'问题A');assert.doesNotMatch(JSON.stringify(inputs.at(-1)),/问题B/);
});

test('enrollment wait retains question metrics and exposes scoped refresh/cancel; stranger and stale callbacks cannot stop it',async t=>{
 const {app,context,send,directory}=await setup(t);
 await send('enrollment-root');const before=await app.store.read(),qid=Object.keys(before.questions)[0];
 await app.store.transact(s=>{s.environmentEnrollments={enr:{id:'enr',questionId:qid,projectId:'demo',chatId:'group',profile:'owner',kind:'nacos',tier:'prd',url:'http://fixture.test/nacos',status:'login_required',createdAt:new Date().toISOString()}};});
 await publishQuestion(context,qid);let s=await app.store.read();let card=s.cardMessages[`question:${qid}`];
 assert.match(JSON.stringify(card.card),/问题已持续|累计实际工具调用/);assert.match(JSON.stringify(card.card),/enrollment_cancel/);assert.doesNotMatch(JSON.stringify(card.card),/不要在群里发送密码/);
 const {enrollmentVersion}=await import('../src/control-plane/enrollment-cards.js');const value={action:'enrollment_cancel',enrollmentId:'enr',version:enrollmentVersion(s.environmentEnrollments.enr)};
 const event={type:'card.action.trigger',event_id:'enrollment-stop',operator_id:'ou_asker',agent_profile:'owner',chat_id:'group',message_id:card.messageId,action_value:value};
 assert.equal((await handleCardAction(context,{...event,event_id:'stranger',operator_id:'stranger'})).ok,false);
 assert.equal((await handleCardAction(context,{...event,event_id:'stale',action_value:{...value,version:'old'}})).ok,false);
 assert.equal((await handleCardAction(context,event)).ok,true);
 assert.equal((await handleCardAction(context,event)).ok,true);
 s=await app.store.read();assert.equal(s.environmentEnrollments.enr.status,'cancelled');
 await stat(path.join(directory,'environment-enrollments/enr/cancelled.json'));
 assert.match(JSON.stringify(questionView(s,qid).card),/已停止接入/);
});

test('stopped partial investigation mentions the original asker despite a dangling setup flag, once',async t=>{
 const {app,context,send,calls}=await setup(t,()=>decision({action:'create_task',intent:'analysis',instruction:'read'}));
 await send('stopped');
 const state=await app.store.read(),j=state.jobs[0],qid=j.questionId;
 await app.store.transact(s=>{
  s.jobs[0].status='completed';s.jobs[0].result={outcome:'partial',finalMessage:'仍需接入数据库',investigation:{status:'wait'}};
  s.conversations.find(x=>x.id===s.questions[qid].latestTurnId).setupPending=true;
 });
 await publishQuestion(context,qid);await publishQuestion(context,qid);
 const mentions=calls.filter(c=>c.type==='mention');assert.equal(mentions.length,1);
 assert.match(mentions[0].text,/ou_asker/);assert.match(mentions[0].text,/尚未完成/);
 assert.doesNotMatch(mentions[0].text,/已结束|已完成/);
});

test('pending enrollment delivers an actionable owner reminder without declaring completion, once',async t=>{
 const {app,context,send,calls}=await setup(t,()=>decision({action:'create_task',intent:'analysis',instruction:'read'}));
 await send('needs-approval');const state=await app.store.read(),qid=state.jobs[0].questionId;
 await app.store.transact(s=>{s.jobs[0].status='completed';s.jobs[0].result={outcome:'partial',finalMessage:'等待接入'};s.questions[qid].generation++;
  s.environmentEnrollments={pending:{id:'pending',questionId:qid,projectId:'demo',chatId:'group',profile:'owner',kind:'mysql',tier:'prd',url:'mysql://fixture.test/db',status:'requested',createdAt:new Date().toISOString()}};});
 await publishQuestion(context,qid);await publishQuestion(context,qid);
 const mentions=calls.filter(c=>c.type==='mention');assert.equal(mentions.length,1);assert.match(mentions[0].text,/ou_admin/);assert.match(mentions[0].text,/请确认/);
 assert.equal((await app.store.read()).cardMessages['question:'+qid].terminal,false);
});

test('a final job produced after a supplementary acknowledgement replaces its stale running text',async t=>{
 const {app,context,send}=await setup(t,()=>decision({action:'create_task',intent:'analysis',instruction:'export'}));await send('export-root');
 const s=await app.store.read(),qid=s.jobs[0].questionId;
 await app.store.transact(s=>{const q=s.questions[qid],prior=s.conversations[0];s.conversations.push({...prior,id:'ack',createdAt:'2026-01-01T00:00:00Z',status:'sent',response:'file not generated',outcome:{}});q.latestTurnId='ack';q.generation++;Object.assign(s.jobs[0],{status:'completed',updatedAt:'2026-01-01T00:01:00Z',result:{outcome:'ready',finalMessage:'verified export complete'}});});
 const v=questionView(await app.store.read(),qid,app.projects);assert.ok(v.job);assert.match(JSON.stringify(v.card),/verified export complete/);assert.match(v.mention.text,/任务已结束/);
});

test('setup blocked before enrollment shows actionable wait and mentions asker and owner once',async t=>{
 const {app,context,send,calls}=await setup(t,()=>decision({action:'create_task',intent:'analysis',instruction:'export'}));await send('missing-source');
 const s=await app.store.read(),qid=s.jobs[0].questionId;
 await app.store.transact(s=>{const prior=s.conversations[0],q=s.questions[qid];s.conversations.push({...prior,id:'setup-turn',status:'sent',createdAt:'2026-01-01T00:01:00Z',setupPending:true,decision:decision({action:'request_environment_setup',environmentSetup:{kind:'mysql',tier:'prd',url:''}}),response:'PRD source missing; no file generated',outcome:{}});q.latestTurnId='setup-turn';q.generation++;Object.assign(s.jobs[0],{status:'completed',updatedAt:'2026-01-01T00:01:00Z',setupTurnId:'setup-turn',result:{outcome:'needs_clarification',finalMessage:'analysis finished; requires database'}});});
 await publishQuestion(context,qid);await publishQuestion(context,qid);
 const v=questionView(await app.store.read(),qid,app.projects);assert.equal(v.job,null);assert.equal(v.terminal,false);assert.match(JSON.stringify(v.card),/PRD source missing/);assert.doesNotMatch(JSON.stringify(v.card),/当前阶段已完成/);
 const reminders=calls.filter(c=>c.type==='mention');assert.equal(reminders.length,1);assert.match(reminders[0].text,/ou_asker/);assert.match(reminders[0].text,/ou_admin/);assert.match(reminders[0].text,/尚未完成/);
});

test('another member follows public topic context and PRD but cannot take over its waiting task',async t=>{
 const {app,send,inputs}=await setup(t,input=>input.message==='ask-fields'?decision({action:'create_task',intent:'analysis',instruction:'explain fields',sourceEnvironment:''}):decision());
 app.projects.projects.demo={displayName:'Demo',repoPath:'/project',analysisSourceMode:'isolated',analysisEnvironments:{prd:{repositories:[]},sit:{repositories:[]}}};
 await send('root','ou_first',{content:'PRD original collection'});let s=await app.store.read();const root=s.conversations[0].questionId;
 await app.store.transact(s=>s.jobs.push({id:'historical-prd',questionId:root,chatId:'group',projectId:'demo',originProfile:'owner',senderId:'ou_first',instruction:'PRD original collection',taskIntent:'analysis',workflow:'continuous_analysis',sourceEnvironment:'prd',stage:'developer',status:'awaiting_clarification',updatedAt:new Date().toISOString(),events:[],context:[],result:{workspace:'/snapshots/a/workspace',sourceSync:{policy:'isolated-environment-source-v1',sourceRoot:'/project',environment:'prd',repositories:[]},finalMessage:'The collection has full nested configuration fields'}}));
 const original=structuredClone((await app.store.read()).jobs[0]);
 await send('follow','ou_second',{content:'ask-fields',reply_to:'root',root_id:'root',thread_id:'topic'});s=await app.store.read();const child=s.conversations.at(-1).questionId;
 assert.notEqual(child,root);assert.equal(s.questions[child].parentQuestionId,root);assert.equal(inputs.at(-1).questionSourceContext.id,'prd');assert.match(inputs.at(-1).questionOriginalRequest,/PRD original collection/);
 assert.match(inputs.at(-1).jobs[0].finalMessage,/full nested/);assert.equal(inputs.at(-1).jobs[0].sourceEnvironment,'prd');
 assert.equal(s.jobs.at(-1).sourceEnvironment,'prd');assert.equal(s.jobs.at(-1).senderId,'ou_second');assert.deepEqual(s.jobs[0],original);
 assert.equal(inputs.at(-1).questionSourceContext.environmentAccess,undefined);
});
test('explicit SIT selection overrides inherited PRD in a new task without mutating the original',async t=>{
 const {app,send,inputs}=await setup(t,input=>decision(input.message==='switch'?{action:'create_task',intent:'analysis',instruction:'read SIT structure',sourceEnvironment:'sit'}:{}));
 app.projects.projects.demo={displayName:'Demo',repoPath:'/project',analysisSourceMode:'isolated',analysisEnvironments:{prd:{repositories:[]},sit:{repositories:[]}}};
 await send('root','ou_first',{content:'PRD'});const root=(await app.store.read()).conversations[0].questionId;
 await app.store.transact(s=>s.conversations[0].decision.sourceEnvironment='prd');
 await send('switch','ou_second',{content:'switch',reply_to:'root',root_id:'root'});const s=await app.store.read();assert.equal(inputs.at(-1).questionSourceContext.id,'prd');assert.equal(s.jobs[0].sourceEnvironment,'sit');assert.equal(s.questions[s.jobs[0].questionId].parentQuestionId,root);
});
test('topic context never crosses a private requester, system profile, project or group',async()=>{
 const {attachQuestion,questionSourceContext}=await import('../src/control-plane/questions.js');
 const prior={id:'old',chatId:'group',profile:'a',projectId:'one',senderId:'first',messageId:'root',threadRootId:'root',latestTurnId:'old-turn'};
 const project={analysisEnvironments:{prd:{repositories:[]}}};
 for(const change of [{visibility:'requester'},{profile:'b'},{projectId:'two'},{chatId:'other'}]){
  const s={questions:{old:{...prior,...change}},conversations:[],jobs:[{id:'j',questionId:'old',chatId:'group',projectId:'one',originProfile:'a',sourceEnvironment:'prd'}]};
  const turn={id:'new',chatId:'group',profile:'a',projectId:'one',senderId:'second',messageId:'new-message',content:'fields',createdAt:new Date().toISOString()};attachQuestion(s,turn,{root_id:'root',reply_to:'root'},{});
  assert.equal(s.questions[turn.questionId].parentQuestionId,undefined);assert.equal(questionSourceContext(s,turn,project),null);
 }
});
test('public context linkage cannot authorize clarification or cancellation of another member task',async t=>{
 const {app,send}=await setup(t,input=>input.message==='try-control'?decision({action:'clarify',jobId:'other-job',instruction:'continue'}):decision());
 await send('root','ou_first');let s=await app.store.read();const root=s.conversations[0].questionId;
 await app.store.transact(s=>s.jobs.push({id:'other-job',questionId:root,chatId:'group',projectId:'demo',originProfile:'owner',senderId:'ou_first',instruction:'read source',taskIntent:'analysis',stage:'developer',status:'awaiting_clarification',events:[],context:[],result:{}}));
 await send('new','ou_second',{content:'try-control',reply_to:'root',root_id:'root'});s=await app.store.read();assert.equal(s.jobs[0].status,'awaiting_clarification');assert.equal(s.jobs[0].events.length,0);assert.match(s.conversations.at(-1).response,/不能在一个问题里推进另一个问题/);
});

test('a public follow-up by another member does not displace the original creator active continuation',async()=>{
 const {attachQuestion}=await import('../src/control-plane/questions.js');
 const root={id:'root-q',chatId:'group',profile:'bot',projectId:'p',senderId:'owner',messageId:'root',threadRootId:'root',latestTurnId:'t1'};
 const child={...root,id:'child-q',senderId:'second',messageId:'child',latestTurnId:'t2',parentQuestionId:'root-q'};
 const s={questions:{'root-q':root,'child-q':child},conversations:[{id:'t1',status:'sent'},{id:'t2',status:'sent'}],jobs:[{id:'j',questionId:'root-q',status:'awaiting_clarification'}]};
 const turn={id:'new',chatId:'group',profile:'bot',projectId:'p',senderId:'owner',content:'resume',messageId:'new'};
 attachQuestion(s,turn,{reply_to:'root',root_id:'root'},{});assert.equal(turn.questionId,'root-q');assert.equal(s.questions['child-q'].latestTurnId,'t2');
 const explicit={...turn,id:'another',messageId:'later'};attachQuestion(s,explicit,{reply_to:'child',root_id:'root'},{});assert.notEqual(explicit.questionId,'root-q');assert.equal(s.questions[explicit.questionId].parentQuestionId,'child-q');
});
