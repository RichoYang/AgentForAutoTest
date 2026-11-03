import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { JsonStore } from '../src/shared/store.js';
import { ExecutionActivity, commandLabel } from '../src/shared/execution-activity.js';
import { LiveCards } from '../src/control-plane/live-cards.js';
import { conversationCard, cumulativeToolCalls, jobCard, publicText, resultParts } from '../src/control-plane/message-cards.js';
import { createControlPlane, handleLarkCliEvent, notifyJobEvent } from '../src/control-plane/server.js';

const destination = { replyTo: 'om_question', profile: 'owner' };
const deferred = () => { let resolve; const promise = new Promise((r) => { resolve = r; }); return { promise, resolve }; };
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function setup(t, overrides = {}) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'agentos-cards-test-'));
  const store = new JsonStore(path.join(directory, 'state.json'));
  const calls = [];
  const client = {
    replyCard: async (id, card, options) => { calls.push({ type: 'send', id, card, options }); return { ok: true, data: { message_id: 'om_card' } }; },
    sendCard: async (id, card, options) => { calls.push({ type: 'send', id, card, options }); return { data: { message_id: 'om_job_card' } }; },
    updateCard: async (id, card, options) => { calls.push({ type: 'patch', id, card, options }); return { ok: true }; },
    reply: async (id, text, options) => { calls.push({ type: 'text', id, text, options }); return { data: { message_id: 'om_more' } }; }, ...overrides,
  };
  const cards = new LiveCards(store, client, { intervalMs: 0 });
  t.after(async () => { await cards.stop(); await rm(directory, { recursive: true, force: true }); });
  return { directory, store, client, calls, cards };
}
const chat = (fields = {}) => ({ id: 'chat1', role: 'owner_intake', status: 'thinking', createdAt: new Date().toISOString(), ...fields });

test('only real tool events count once; no reasoning, outputs or arguments are exposed', () => {
  const activity = new ExecutionActivity();
  assert.equal(activity.accept({ type: 'item.completed', item: { id: 'r', type: 'reasoning', text: 'PRIVATE' } }), null);
  const item = { id: 'c', type: 'command_execution', command: 'curl -H "Authorization: Bearer supersecret" https://private', aggregated_output: 'PRIVATE' };
  assert.equal(activity.accept({ type: 'item.started', item }).total, 1);
  assert.equal(activity.accept({ type: 'item.started', item }).total, 1);
  const result = activity.accept({ type: 'item.completed', item: { ...item, exit_code: 1 } });
  assert.equal(result.completed, 1); assert.equal(result.recent[0].failed, true);
  assert.equal(activity.accept({ type: 'item.completed', item }), null);
  assert.doesNotMatch(JSON.stringify(result), /supersecret|PRIVATE|private|curl/);
  assert.equal(commandLabel('git diff --stat'), 'git diff --stat');
  assert.notEqual(commandLabel('git diff --stat; echo secret'), 'git diff --stat; echo secret');
});

test('cards have responsive groups, semantic failure and bounded details without a fake stop button', () => {
  const job = { id: 'job', stage: 'developer', projectName: 'demo', status: 'failed', events: [],
    createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), result: { error: 'supersecret' } };
  const card = jobCard(job);
  assert.equal(card.schema, '2.0'); assert.equal(card.config.update_multi, true);
  assert.equal(card.header.template, 'red'); assert.ok(card.body.elements.length <= 5);
  assert.doesNotMatch(JSON.stringify(card), /停止任务|supersecret|stretch/);
  const text = '中文<&😀'.repeat(4000);
  const parts = resultParts(text);
  assert.equal(parts.primary + parts.overflow, publicText(text));
  assert.ok(Buffer.byteLength(JSON.stringify(conversationCard(chat({ status: 'ready', response: text })))) < 28_000);
  assert.doesNotMatch(publicText('api_key="secret-value" Authorization=Bearer-TOKEN <at id=all></at>'), /secret-value|Bearer-TOKEN|<at/);
});

test('job card displays total question time across later execution jobs', () => {
  const job = { id: 'job-total', stage: 'developer', projectName: 'demo', status: 'blocked', events: [
    { type: 'started', at: '2026-09-22T03:36:59.000Z' },
  ], createdAt: '2026-09-22T03:36:59.000Z', updatedAt: '2026-09-22T03:37:05.000Z',
  result: { finalMessage: '未完成', summary: '未完成' } };
  const rendered = JSON.stringify(jobCard(job, Date.parse(job.updatedAt), { startAt: '2026-09-22T03:25:00.000Z' }));
  assert.match(rendered, /12 分 5 秒/);
  assert.match(rendered, /总耗时/);
  assert.doesNotMatch(rendered, /本阶段耗时/);
});
test('job card reports cumulative tool calls across source and environment turns',()=>{
 const events=[
  {type:'started'},
  {type:'codex_event',event:{type:'turn.started'}},{phase:'tool_activity',activity:{total:1}},{phase:'tool_activity',activity:{total:3}},
  {type:'continuous_environment_started'},{phase:'tool_activity',activity:{total:1}},{phase:'tool_activity',activity:{total:4}},
  {type:'continuous_environment_completed'},{type:'codex_event',event:{type:'turn.started'}},{phase:'tool_activity',activity:{total:2}},
 ].map((event,index)=>({...event,at:new Date(Date.parse('2026-09-22T03:36:59.000Z')+index).toISOString()}));
 assert.equal(cumulativeToolCalls(events),9);
 const job={id:'job-tools',stage:'developer',status:'running',events,createdAt:'2026-09-22T03:36:59.000Z',updatedAt:'2026-09-22T03:37:05.000Z'};
 const rendered=JSON.stringify(jobCard(job,Date.parse(job.updatedAt)));
 assert.match(rendered,/9 次/);assert.match(rendered,/累计实际工具调用/);
});

test('receipt and result update ONE message with a stable sender; terminal cannot regress', async (t) => {
  const { cards, calls, store } = await setup(t);
  await cards.upsert('chat:1', conversationCard(chat()), destination, { immediate: true });
  await cards.upsert('chat:1', conversationCard(chat({ status: 'ready', response: '你好，真实结果' })), destination, { immediate: true, terminal: true });
  await cards.upsert('chat:1', conversationCard(chat()), destination, { immediate: true });
  assert.deepEqual(calls.map((c) => c.type), ['send', 'patch']);
  assert.equal(calls[1].id, 'om_card'); assert.equal(calls[1].options.profile, 'owner');
  assert.equal((await store.read()).cardMessages['chat:1'].terminal, true);
  await assert.rejects(cards.upsert('chat:1', conversationCard(chat()), { ...destination, profile: 'qa' }, { terminal: true }), /identity/);
});

test('cancelling a waiting-login card replaces its prompt, removes buttons and publishes the final state',async t=>{
  const {cards,calls,store}=await setup(t);const waiting={id:'job-login',stage:'developer',status:'awaiting_clarification',events:[],createdAt:new Date().toISOString(),updatedAt:new Date().toISOString(),result:{browserLoginRequired:true,finalMessage:'等待登录'}};
  const destination={chatId:'group',profile:'owner'};
  await cards.upsert('job:login:first',jobCard(waiting),destination,{terminal:true,immediate:true,terminalMention:{kind:'browser_login',replyTo:'root',profile:'owner',text:'请登录'}});
  const cancelled={...waiting,status:'cancelled',updatedAt:new Date().toISOString()};
  await cards.upsert('job:login:first',jobCard(cancelled),destination,{terminal:true,immediate:true,terminalMention:{replyTo:'root',profile:'owner',text:'任务已取消。'}});
  const entry=(await store.read()).cardMessages['job:login:first'];
  assert.equal(entry.terminalMention.text,'任务已取消。');assert.equal(entry.mentionDelivered,true);
  assert.match(entry.card.header.title.content,/已取消/);assert.match(JSON.stringify(entry.card),/任务已取消，已停止继续执行/);
  assert.doesNotMatch(entry.card.header.title.content,/等待本机登录/);
  assert.doesNotMatch(JSON.stringify(entry.card),/取消任务|刷新状态|"action":"cancel"/);
  assert.deepEqual(calls.map(x=>x.type),['send','text','patch','text']);
});

test('in-flight progress coalesces, then terminal wins without concurrent PATCH calls', async (t) => {
  const gate = deferred(), entered = deferred(); let concurrent = 0, max = 0;
  const patches = [];
  const { cards } = await setup(t, { updateCard: async (id, card) => {
    concurrent++; max = Math.max(max, concurrent); patches.push(card.header.title.content);
    if (patches.length === 1) { entered.resolve(); await gate.promise; } concurrent--;
  } });
  await cards.upsert('x', conversationCard(chat()), destination, { immediate: true });
  const running = cards.upsert('x', conversationCard(chat()), destination, { immediate: true });
  await entered.promise;
  const final = cards.upsert('x', conversationCard(chat({ status: 'ready', response: '完成' })), destination, { terminal: true, immediate: true });
  gate.resolve(); await Promise.all([running, final]);
  assert.equal(max, 1); assert.match(patches.at(-1), /已回复/);
});

test('failed card update survives reconstruction; legacy overflow is never sent', async (t) => {
  let fail = true;
  const { cards, store, client, calls } = await setup(t, { updateCard: async () => { if (fail) throw new Error('offline'); } });
  await cards.upsert('x', conversationCard(chat()), destination, { immediate: true });
  await assert.rejects(cards.upsert('x', conversationCard(chat({ status: 'ready', response: '完成' })), destination,
    { immediate: true, terminal: true, resultText: '完整详情'.repeat(1000) }), /offline/);
  assert.equal((await store.read()).cardMessages.x.messageId, 'om_card');
  await store.transact((state) => { state.cardMessages.x.overflow = ['旧版待发续文']; });
  fail = false;
  const restored = new LiveCards(store, client, { intervalMs: 0 });
  await restored.flush('x', true); await restored.stop();
  assert.equal(calls.filter((c) => c.type === 'send').length, 1);
  assert.equal(calls.filter((c) => c.type === 'text').length, 0);
  assert.ok((await store.read()).cardMessages.x.detailPages.length > 1);
});

test('a withdrawn historical card stops retrying after Feishu reports message 230011', async (t) => {
  const { cards, store } = await setup(t, { updateCard: async () => { throw new Error('lark-cli exited 1: code 230011 The message was withdrawn.'); } });
  await cards.upsert('withdrawn', conversationCard(chat()), destination, { immediate: true });
  await cards.upsert('withdrawn', conversationCard(chat({ status: 'ready', response: '完成' })), destination, { terminal: true, immediate: true });
  const entry = (await store.read()).cardMessages.withdrawn;
  assert.equal(entry.deliveredRevision, entry.revision);
  assert.equal(entry.retryAt, 0);
  assert.equal(entry.failures, 0);
  assert.equal(entry.error, '原消息已撤回，停止更新');
});

test('uncertain initial send retries the same idempotency key', async (t) => {
  const keys = []; let fail = true;
  const { cards } = await setup(t, { replyCard: async (id, card, options) => {
    keys.push(options.idempotencyKey); if (fail) throw new Error('timeout'); return { message_id: 'om_existing' };
  } });
  await assert.rejects(cards.upsert('x', conversationCard(chat()), destination, { immediate: true }));
  fail = false; await cards.flush('x', true);
  assert.equal(keys[0], keys[1]);
});

test('a failed requester mention retries without resending or updating the delivered card', async (t) => {
  let fail = true;
  const mentionKeys = [];
  const { cards, calls, store } = await setup(t, { reply: async (id, text, options) => {
    calls.push({ type: 'text', id, text, options }); mentionKeys.push(options.idempotencyKey);
    if (fail) throw new Error('offline');
    return { data: { message_id: 'om_mention' } };
  } });
  const mention = { replyTo: 'om_question', profile: 'owner', text: '<at user_id="ou_human1"></at> 完成' };
  await assert.rejects(cards.upsert('mention-retry', conversationCard(chat({ status: 'ready', response: '完成' })), destination,
    { immediate: true, terminal: true, terminalMention: mention }));
  fail = false;
  await store.transact((state) => { state.cardMessages['mention-retry'].retryAt = 0; });
  await cards.flush('mention-retry', true);
  assert.deepEqual(calls.map((call) => call.type), ['send', 'text', 'text']);
  assert.equal(mentionKeys[0], mentionKeys[1]);
  assert.equal((await store.read()).cardMessages['mention-retry'].mentionDelivered, true);
});

test('full group conversation updates receipt, preserves AI output and ends with one requester mention', async (t) => {
  const { directory, client, calls } = await setup(t);
  let aiCalls = 0;
  const app = await createControlPlane({ dataDir: directory, storeFile: path.join(directory, 'app.json'),
    projects: { projects: { demo: { displayName: 'demo' } }, chatProjectMap: { group: 'demo' } },
    agents: { agents: { owner_intake: { profile: 'owner', openId: 'bot' } } }, feishuClient: client,
    conversationOptions: { feedbackMs: 5 }, conversationResponder: async () => {
      aiCalls++; await pause(50); return { reply: 'AI 的真实回答', action: 'reply', intent: 'none', instruction: '', jobId: '', projectId: '', attachmentIds: [] };
    } });
  t.after(async () => { await app.conversations.stop(); await app.cards.stop(); });
  const event = { type: 'im.message.receive_v1', message_id: 'm1', chat_id: 'group', sender_id: 'ou_human1', chat_type: 'group', sender_type: 'user',
    agent_role: 'owner_intake', agent_profile: 'owner', mentions: [{ id: 'bot' }], content: '你好' };
  const context = app.conversations.context;
  await handleLarkCliEvent(context, event); await app.conversations.idle();
  assert.equal(aiCalls, 1); assert.deepEqual(calls.map((c) => c.type), ['send', 'patch', 'text']);
  assert.match(JSON.stringify(calls[1].card), /AI 的真实回答/);
  assert.equal(calls[2].id, 'm1'); assert.equal(calls[2].options.profile, 'owner');
  assert.equal(calls[2].text, '<at user_id="ou_human1"></at> 本次回复已完成，请查看上方结果。');
  assert.equal((await app.store.read()).jobs.length, 0);
  await handleLarkCliEvent(context, { ...event, message_id: 'm2', reply_to: 'om_card', content: '继续' });
  await app.conversations.idle(); assert.equal(aiCalls, 2);
});

test('terminal job card mentions the original requester through the origin profile exactly once', async (t) => {
  const { store, cards, client, calls } = await setup(t);
  const { job } = await store.createJob({ projectId: 'demo', projectName: 'demo', chatId: 'group', stage: 'developer',
    agentProfile: 'dev', originProfile: 'owner', originChatType: 'group', senderId: 'ou_requester1',
    replyToMessageId: 'om_origin', instruction: '只测试', workflow: 'single_developer', status: 'running' });
  const context = { store, cards, feishu: client };
  const final = await store.appendEvent(job.id, { type: 'completed', result: { outcome: 'blocked', finalMessage: '测试未通过' } });
  await notifyJobEvent(context, final);
  await notifyJobEvent(context, final);
  const mentions = calls.filter((call) => call.type === 'text');
  assert.equal(mentions.length, 1);
  assert.equal(mentions[0].id, 'om_origin');
  assert.equal(mentions[0].options.profile, 'owner');
  assert.equal(mentions[0].text, '<at user_id="ou_requester1"></at> 本次排查受阻，请查看上方原因和下一步。');
  assert.equal(calls.find((call) => call.type === 'send').options.profile, 'dev');
});

test('real job notifications share an execution card, and stale progress renders final state', async (t) => {
  const { store, cards, client, calls } = await setup(t);
  const { job } = await store.createJob({ projectId: 'demo', projectName: 'demo', chatId: 'group', stage: 'developer',
    agentProfile: 'dev', instruction: '只测试', workflow: 'single_developer', status: 'running' });
  const context = { store, cards, feishu: client };
  const began = await store.appendEvent(job.id, { type: 'started' });
  await notifyJobEvent(context, began);
  const key = `job:${job.id}:${began.event.id}`; await cards.flush(key, true);
  const progress = await store.appendEvent(job.id, { type: 'progress', phase: 'tool_activity', activity: {
    total: 1, completed: 1, current: '正在处理后续步骤', recent: [{ label: 'git diff --stat', done: true, failed: false }] } });
  await notifyJobEvent(context, progress); await cards.flush(key, true);
  const final = await store.appendEvent(job.id, { type: 'completed', result: { outcome: 'blocked', finalMessage: '测试未通过' } });
  await notifyJobEvent(context, final); await notifyJobEvent(context, progress);
  assert.equal(calls.filter((c) => c.type === 'send').length, 1);
  assert.equal(calls.at(-1).card.header.template, 'red');
  assert.match(JSON.stringify(calls.at(-1).card), /测试未通过|git diff --stat/);
});

test('source sync escalation retries the same requester/admin mention without rerunning jobs', async (t) => {
  let attempts = 0;
  const deliveries = [];
  const { store, cards, client } = await setup(t, { reply: async (id, text, options) => {
    deliveries.push({ id, text, options });
    if (++attempts === 1) throw new Error('offline');
    return { message_id: 'om_notice' };
  } });
  const { job } = await store.createJob({ projectId: 'demo', chatId: 'group', stage: 'developer',
    taskIntent: 'analysis', agentProfile: 'dev', originProfile: 'owner', originChatType: 'group',
    senderId: 'ou_member', replyToMessageId: 'om_origin', instruction: 'inspect', workflow: 'single_developer' });
  const context = { store, cards, feishu: client, projects: { ownerOpenIdsByProfile: { owner: ['ou_admin'] } } };
  const final = await store.appendEvent(job.id, { type: 'completed', result: { outcome: 'blocked', sourceSyncBlocked: true, finalMessage: 'source unavailable' } });
  await assert.rejects(notifyJobEvent(context, final), /offline/);
  const before = (await store.read()).jobs;
  context.projects.ownerOpenIdsByProfile.owner = ['ou_changed'];
  await notifyJobEvent(context, final);
  await notifyJobEvent(context, final);
  assert.equal(deliveries.length, 2);
  assert.deepEqual(deliveries[0], deliveries[1]);
  assert.equal(deliveries[1].options.profile, 'owner');
  assert.match(deliveries[1].text, /ou_member/); assert.match(deliveries[1].text, /ou_admin/);
  assert.doesNotMatch(deliveries[1].text, /ou_changed/);
  const after = (await store.read()).jobs;
  assert.equal(after.length, before.length);
  assert.equal(after[0].status, 'blocked');
  assert.deepEqual(after[0].result, before[0].result);
});

test('analysis receipt stays silent until the continuous developer investigation finishes', async (t) => {
  const { directory, client, calls } = await setup(t);
  const app = await createControlPlane({ dataDir: directory, storeFile: path.join(directory, 'chain.json'),
    projects: { projects: { demo: { displayName: 'demo' } }, chatProjectMap: { group: 'demo' } },
    agents: { agents: { owner_intake: { profile: 'owner', openId: 'bot' }, developer: { profile: 'dev', openId: 'devbot' } } },
    feishuClient: client, conversationResponder: async () => ({ reply: '已交给开发调查', action: 'create_task', intent: 'analysis',
      instruction: '只读调查', jobId: '', projectId: '', attachmentIds: [] }) });
  t.after(async () => { await app.conversations.stop(); await app.cards.stop(); });
  const context = app.conversations.context;
  await handleLarkCliEvent(context, { type: 'im.message.receive_v1', message_id: 'origin', chat_id: 'group',
    sender_id: 'ou_requester', chat_type: 'group', sender_type: 'user', agent_role: 'owner_intake', agent_profile: 'owner',
    mentions: [{ id: 'bot' }], content: '查源码' });
  await app.conversations.idle();
  assert.equal(calls.filter(c => c.type === 'text').length, 0);
  const developer = await app.store.leaseNext('runner');
  const complete = (job) => ({ type: 'completed', runnerId: 'runner', leaseId: job.lease.id,
    result: { outcome: 'ready', finalMessage: '调查证据' } });
  assert.equal(developer.workflow, 'continuous_analysis');
  assert.equal(developer.continuousInvestigation, true);
  const final = await app.store.appendEvent(developer.id, complete(developer));
  assert.equal(final.nextJob, null);
  await notifyJobEvent(context, final); await notifyJobEvent(context, final);
  const notices = calls.filter(c => c.type === 'text');
  assert.equal(notices.length, 1);
  assert.equal(notices[0].id, 'origin');
  assert.equal(notices[0].options.profile, 'owner');
  assert.match(notices[0].text, /ou_requester/);
});

 test('automatic login progress withdraws an obsolete pending manual notice without sending text',async t=>{
 const {cards,calls,store}=await setup(t),dest={chatId:'group',profile:'owner'},job={id:'login',stage:'developer',status:'awaiting_clarification',events:[],result:{browserLoginRequired:true}};
 await cards.upsert('job:login',jobCard(job),dest,{terminal:true,terminalMention:{kind:'browser_login',replyTo:'root',profile:'owner',text:'Old manual notice'}});
 await cards.upsert('job:login',jobCard(job),dest,{terminal:true,terminalMention:null,immediate:true});
 const saved=(await store.read()).cardMessages['job:login'];assert.equal(saved.terminalMention,null);assert.equal(calls.filter(x=>x.type==='text').length,0);
 await cards.upsert('job:login',jobCard({...job,status:'completed',result:{outcome:'ready'}}),dest,{terminal:true,immediate:true,terminalMention:{replyTo:'root',profile:'owner',text:'Actual completion'}});
 assert.equal(calls.filter(x=>x.type==='text').length,1);assert.equal(calls.find(x=>x.type==='text').text,'Actual completion');
 });
