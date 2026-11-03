import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { jobCard, conversationCard } from '../src/control-plane/message-cards.js';
import { resultPages, readableMarkdown, publicText, detailVersion, withResultPage, analysisPrimaryResult, PRIMARY_ANALYSIS_LIMIT } from '../src/control-plane/result-presentation.js';
import { handleCardAction } from '../src/control-plane/card-actions.js';
import { JsonStore } from '../src/shared/store.js';
import { LiveCards } from '../src/control-plane/live-cards.js';
import { buildPrompt } from '../src/runner/codex-executor.js';

test('all roles lead with a readable answer and keep full technical evidence folded', async () => {
  for (const stage of ['owner_intake', 'pm', 'developer', 'qa', 'owner_audit', 'owner_report']) {
    const job = { id: 'J', stage, projectName: '测试', status: 'completed', result: {
      summary: '已找到登录校验入口；只查了源码，没有改代码。线上配置尚未验证。',
      finalMessage: '# 详细证据\n' + '具体实现与文件行号。\n'.repeat(2000),
    }, events: [] };
    const card = jobCard(job);
    assert.match(card.body.elements[0].columns[0].elements[1].content, /线上配置尚未验证/);
    assert.ok(card.body.elements[0].columns[0].elements[1].content.length < 1200);
    assert.equal(card.body.elements.find((e) => e.tag === 'collapsible_panel').expanded, false);
    assert.ok(Buffer.byteLength(JSON.stringify(card)) < 28000);
    assert.doesNotMatch(JSON.stringify(card), /结论续文|D:\\|^###/);
    assert.match(await buildPrompt(job, {}), /通常 300–900 字，最多 1200 字/);
    assert.match(await buildPrompt(job, {}), /字段含义、记录差异、金额、状态、前后版本或方案需要横向比较时/);
    assert.match(await buildPrompt(job, {}), /不要机械套用“系统怎样处理\/这次数据说明什么\/影响与建议”/);
    assert.match(await buildPrompt(job, {}), /禁止用表名、字段名、类名、方法名、主键范围或 commit 开头/);
  }
});

test('analysis cards show the detailed conclusion on the first screen and keep the full evidence folded', () => {
  const finalMessage = '**结论：比例校验被跳过。**\n\n**关键依据：**下级金额为零，因此没有进入比例比较。\n\n**影响与建议：**若上限应始终生效，需要补充零下级金额场景的校验。';
  const card = jobCard({ id: 'analysis-result', stage: 'developer', projectName: '预算', taskIntent: 'analysis', status: 'completed',
    result: { summary: '比例校验被跳过。', finalMessage }, events: [] });
  const first = card.body.elements[0].columns[0].elements.map((item) => item.content).join('\n');
  assert.doesNotMatch(first, /^结论与业务说明/m);
  assert.match(first, /关键依据/);
  assert.match(first, /影响与建议/);
  assert.doesNotMatch(first, /比例校验被跳过。\n比例校验被跳过。/);
  const detail = card.body.elements.find((item) => item.tag === 'collapsible_panel');
  assert.equal(detail.expanded, false);
  assert.match(detail.header.title.content, /完整技术详情与证据/);
});

test('analysis cards preserve comparison tables as native Card 2.0 tables', () => {
  const finalMessage = '这两个字段代表的客户范围不同，所以金额会不同。\n\n| 字段 | 大白话含义 |\n| --- | --- |\n| `order_owner` | 订单归在哪个主经销商名下 |\n| `sold_to_code` | 这笔销售对应的售达客户是谁 |\n\n| 主经销商 | 售达方 | 含税销售额 |\n| --- | --- | ---: |\n| 100017 | 100017 | 367,679.30 元 |\n| 100017 | 200176 | 45,651.00 元 |\n\n所以当前口径筛选售达方 100017。\n\n**技术依据**\n表 `exec_result_sell_in`。';
  const card = jobCard({ id: 'analysis-table', stage: 'developer', projectName: '费比', taskIntent: 'analysis', status: 'completed',
    result: { summary: '字段范围不同。', finalMessage }, events: [] });
  const tables = card.body.elements.filter((element) => element.tag === 'table');
  assert.equal(tables.length, 2);
  assert.deepEqual(tables[0].columns.map((column) => column.display_name), ['字段', '大白话含义']);
  assert.equal(tables[1].rows[1].column_3, '45,651.00 元');
  assert.match(JSON.stringify(card.body.elements.slice(0, -2)), /所以当前口径筛选售达方 100017/);
  assert.doesNotMatch(JSON.stringify(card.body.elements.slice(0, -2)), /exec_result_sell_in/);
});

test('ordinary Codex-style chat replies also keep native comparison tables', () => {
  const response = '两个环境的状态如下：\n\n| 环境 | 状态 |\n| --- | --- |\n| UAT | 已验证 |\n| PRD | 待核实 |\n\n因此目前只能确认 UAT。';
  const card = conversationCard({ id: 'chat-table', role: 'owner_intake', status: 'sent', response });
  const table = card.body.elements.find((element) => element.tag === 'table');
  assert.ok(table);
  assert.equal(table.rows[1].column_2, '待核实');
  assert.match(JSON.stringify(card), /因此目前只能确认 UAT/);
});

test('analysis first screen keeps the business explanation and folds the technical appendix', () => {
  const finalMessage = '**结论**\n这个费比按真实客户的业绩计算。\n\n**系统怎样处理**\n1. 先找到活动截止月以前最近一个有实际财务数据的月份。\n2. 再汇总年初到该月月末的含税销售额，排除不参加计算的产品。\n\n**这次数据说明什么**\n194 是数据库明细行，不是 194 张订单；同一订单的多个商品会占多行。\n\n**技术依据**\n表 `exec_result_sell_in`，字段 `gsv_with_tax`，源码 `src/example.java:12-30`。';
  const primary = analysisPrimaryResult(finalMessage);
  assert.match(primary, /这个费比按真实客户的业绩计算/);
  assert.match(primary, /194 是数据库明细行，不是 194 张订单/);
  assert.doesNotMatch(primary, /exec_result_sell_in|src\/example\.java/);
  assert.match(primary, /源码位置、表字段、版本与查询证据见下方完整详情/);
  assert.match(resultPages(finalMessage).join('\n'), /exec_result_sell_in/);
});

test('analysis first screen is bounded while the folded result remains complete', () => {
  const finalMessage = `**结论：已定位。**\n\n${'关键证据与影响说明。'.repeat(800)}`;
  const card = jobCard({ id: 'long-analysis', stage: 'developer', projectName: '预算', taskIntent: 'analysis', status: 'completed',
    result: { summary: '已定位。', finalMessage }, events: [] });
  const first = card.body.elements[0].columns[0].elements.map((item) => item.content).join('\n');
  assert.ok(Array.from(first).length <= PRIMARY_ANALYSIS_LIMIT + 80);
  assert.match(first, /完整技术详情与证据见下方/);
  assert.match(card.body.elements.find((item) => item.tag === 'collapsible_panel').elements[0].content, /关键证据与影响说明/);
  assert.ok(Buffer.byteLength(JSON.stringify(card)) < 30000);
});

test('legacy HTML is escaped once, file links become readable labels and fences balance per page', () => {
  const source = '### 调查结论\n[Result.java:17](/D:/work/project/src/Result.java:17)\n'
    + '```json\n' + '  {"示例": "&#60;用户ID&#62;"},\n'.repeat(400) + '```\n结尾证据';
  const clean = readableMarkdown(source);
  assert.match(clean, /\*\*调查结论\*\*/);
  assert.doesNotMatch(clean, /D:\/work|&amp;#60/);
  const pages = resultPages(source);
  assert.ok(pages.length > 2);
  for (const page of pages) {
    assert.equal((page.match(/^```/gm) ?? []).length % 2, 0);
    assert.ok(Buffer.byteLength(page) < 12000);
  }
  assert.match(pages.at(-1), /结尾证据/);
  assert.doesNotMatch(publicText('api_key="secret" &lt;at id=all&gt;'), /secret|<at/);
  assert.equal(publicText(publicText('<user> & text')), publicText('<user> & text'));
});

test('chat and job pagination updates same card, survives retries, rejects wrong scope and never mutates jobs', async (t) => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'agentos-result-pages-'));
  const store = new JsonStore(path.join(dir, 'state.json'));
  let sends = 0, texts = 0, fail = false;
  const client = { sendCard: async () => ({ message_id: `om_${++sends}` }), replyCard: async () => ({ message_id: `om_${++sends}` }),
    updateCard: async () => { if (fail) throw new Error('offline'); }, reply: async () => { texts++; } };
  const cards = new LiveCards(store, client, { intervalMs: 0 });
  t.after(async () => { await cards.stop(); await rm(dir, { recursive: true, force: true }); });
  const context = { store, cards, feishu: client, projects: { ownerOpenIdsByProfile: { owner: ['admin'] } },
    agents: { agents: { owner_intake: { profile: 'owner' }, developer: { profile: 'dev' } } } };
  const text = '详情段落和风险。\n'.repeat(600);
  const { job } = await store.createJob({ instruction: '只读', projectId: 'p', chatId: 'group', stage: 'owner_intake',
    agentProfile: 'owner', originProfile: 'owner', senderId: 'creator', status: 'completed' });
  const turn = { id: 'c', status: 'sent', role: 'owner_intake', chatId: 'group', profile: 'owner', senderId: 'creator', response: text };
  await store.transact((state) => { state.conversations = [turn]; });
  for (const [key, card] of [[`job:${job.id}:first`, jobCard({ ...job, result: { summary: '概要；风险待验证。', finalMessage: text } })], ['chat:c', conversationCard(turn)]]) {
    const id = await cards.upsert(key, card, { chatId: 'group', profile: 'owner' }, { terminal: true, immediate: true, resultText: text });
    const beforeJobs = JSON.stringify((await store.read()).jobs);
    const event = { type: 'card.action.trigger', event_id: `${key}:page`, operator_id: 'creator', agent_profile: 'owner',
      chat_id: 'group', message_id: id, card_content: JSON.stringify(card), action_value: { action: 'result_page', page: 1, version: detailVersion(resultPages(text)) } };
    for (const extra of [{ operator_id: 'other' }, { chat_id: 'other' }, { agent_profile: 'dev' }, { action_value: { ...event.action_value, page: 999 } }]) {
      assert.notEqual((await handleCardAction(context, { ...event, ...extra })).ok, true);
    }
    fail = true;
    assert.equal((await handleCardAction(context, event)).ok, false);
    fail = false;
    assert.equal((await handleCardAction(context, event)).ok, true);
    const saved = (await store.read()).cardMessages[key];
    assert.equal(saved.messageId, id);
    assert.equal(saved.card.body.elements.at(-1).expanded, true);
    assert.match(saved.card.body.elements.at(-1).header.title.content, /2\//);
    assert.equal(JSON.stringify((await store.read()).jobs), beforeJobs);
    assert.equal(saved.revision, saved.deliveredRevision);
  }
  assert.equal(sends, 2); assert.equal(texts, 0);
});


test('paging an old table card rebuilds only presentation from original evidence', async (t) => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'agentos-legacy-table-'));
  const store = new JsonStore(path.join(dir, 'state.json'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const source = '| Date | Evidence |\n| --- | --- |\n| day-one | original proof |';
  const oldPages = ['| Date | Evidence |\n| --- | --- |', '| day-one | original proof |'];
  const turn = { id: 'old-chat', status: 'sent', profile: 'owner', chatId: 'group', senderId: 'creator', response: source };
  const card = withResultPage(conversationCard(turn), oldPages);
  await store.transact((state) => {
    state.conversations = [turn];
    state.cardMessages = { 'chat:old-chat': { messageId: 'old-message', destination: { profile: 'owner' }, terminal: true,
      detailPages: oldPages, card, revision: 1 } };
  });
  let flushed = 0;
  const context = { store, projects: {}, agents: { agents: { owner_intake: { profile: 'owner' } } }, cards: { flush: async () => { flushed++; } } };
  const before = await store.read();
  const event = { type: 'card.action.trigger', event_id: 'new-page-event', operator_id: 'creator', agent_profile: 'owner',
    chat_id: 'group', message_id: 'old-message', card_content: JSON.stringify(card),
    action_value: { action: 'result_page', page: 1, version: detailVersion(oldPages) } };
  assert.equal((await handleCardAction(context, event)).ok, true);
  const after = await store.read();
  assert.deepEqual(after.jobs, before.jobs);
  assert.deepEqual(after.conversations, before.conversations);
  assert.deepEqual(after.cardMessages['chat:old-chat'].detailPages, resultPages(source));
  assert.match(JSON.stringify(after.cardMessages['chat:old-chat'].card), /original proof/);
  assert.equal(after.cardMessages['chat:old-chat'].messageId, 'old-message');
  assert.equal(flushed, 1);
});

test('answer tables under a generic technical heading remain on the primary card with complete rows',()=>{
 const rows=Array.from({length:25},(_,i)=>`| 字段${i} | \`db.table.COLUMN_${i}\` | ${i===24?'未定位，不能用相近列替代':'varchar(64)，已核实'} |`).join('\n');
 const text=`已按模板整理字段。以下候选不是已部署绑定。\n\n### 技术依据\n\n实际库表来自元数据。\n\n| 字段 | 数据库字段 | 状态 |\n| --- | --- | --- |\n${rows}\n\n**源码复核位置**\ninternal-source.java:123\n`;
 const job={id:'mapping',stage:'developer',taskIntent:'analysis',status:'completed',result:{outcome:'ready',finalMessage:text},events:[]},card=jobCard(job),tables=card.body.elements.filter(x=>x.tag==='table');assert.equal(tables.length,1);assert.equal(tables[0].rows.length,25);assert.match(tables[0].rows[24].column_3,/未定位/);assert.doesNotMatch(JSON.stringify(card.body.elements.filter(x=>x.element_id!=='result_details')),/internal-source.java/);assert.match(resultPages(text).join('\n'),/internal-source.java/);
});

test('a long answer table is never character-clipped into an invalid partial table',()=>{
 const rows=Array.from({length:35},(_,i)=>`| ${i} | ${'明确来源和未核实条件'.repeat(16)} |`).join('\n'),text=`已取得字段对照。\n\n| 序号 | 说明 |\n| --- | --- |\n${rows}`;
 const card=jobCard({id:'long-table',stage:'developer',taskIntent:'analysis',status:'completed',result:{outcome:'partial',finalMessage:text},events:[]}),table=card.body.elements.find(x=>x.tag==='table');assert.equal(table.rows.length,35);assert.equal(table.rows.at(-1).column_1,'34');assert.match(card.header.title.content,/部分分析完成/);
});
import {fitResultCard}from '../src/control-plane/result-presentation.js';
test('existing delivery byte envelope pages oversized tables without changing canonical results or controls',()=>{
 const rows=Array.from({length:50},(_,i)=>`| ${i} | ${'完整条件说明'.repeat(100)} |`).join('\n'),text=`候选信息不能冒充已确认。\n\n| 序号 | 说明 |\n| --- | --- |\n${rows}`;
 const card=jobCard({id:'large-table',stage:'developer',taskIntent:'analysis',status:'completed',result:{outcome:'partial',finalMessage:text},events:[]}),before=JSON.stringify(card),fitted=fitResultCard(card);assert.ok(Buffer.byteLength(JSON.stringify(fitted))<=28000);assert.equal(JSON.stringify(card),before);assert.match(JSON.stringify(fitted),/主卡表格展示 \d+\/50 行/);assert.deepEqual(fitted.body.elements.find(x=>x.element_id==='result_details'),card.body.elements.find(x=>x.element_id==='result_details'));assert.equal(resultPages(text).join('\n').includes('49'),true);assert.match(fitted.header.title.content,/部分分析完成/);
});
