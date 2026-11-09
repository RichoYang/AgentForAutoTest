import {stateView} from '../shared/state-view.js';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { resultPages } from './result-presentation.js';
import { jobTerminalMention } from './requester-mention.js';

const chatIdOf=value=>{if(!value||typeof value!=='object')return null;if(typeof value.chat_id==='string')return value.chat_id;for(const child of Object.values(value)){const id=chatIdOf(child);if(id)return id;}return null;};

export function messageIdOf(value) {
  if (!value || typeof value !== 'object') return null;
  if (typeof value.message_id === 'string') return value.message_id;
  for (const child of Object.values(value)) { const id = messageIdOf(child); if (id) return id; }
  return null;
}

function blocksTerminalMention(job, mention) {
  if (job.status === 'awaiting_clarification') {
    if (mention?.kind === 'browser_login') return false;
    const waiting = job.workflow === 'requirement_test' && jobTerminalMention(job);
    return !waiting || waiting.text !== mention?.text || waiting.replyTo !== mention?.replyTo || waiting.profile !== mention?.profile;
  }
  if (job.status === 'awaiting_environment_approval') return mention?.kind !== 'environment_approval';
  return ['queued', 'running', 'cancelling', 'awaiting_approval'].includes(job.status);
}

// Durable delivery outbox: a failed update NEVER reruns Codex or creates another task.
export class LiveCards {
  constructor(store, feishu, { intervalMs = 3000, authorizeDestination } = {}) {
    this.authorizeDestination=authorizeDestination;
    this.store = store; this.feishu = feishu; this.intervalMs = intervalMs;
    this.workers = new Map(); this.closed = false;
    this.enabled = typeof feishu.replyCard === 'function' && typeof feishu.updateCard === 'function' && feishu.enabled !== false;
  }
  start() {
    if (!this.enabled || this.timer) return;
    this.timer = setInterval(() => this.retry().catch(() => {}), 1000); this.timer.unref();
  }
  async stop() { this.closed = true; clearInterval(this.timer); await Promise.allSettled(this.workers.values()); }
  async upsert(key, card, destination, { terminal = false, immediate = false, resultText = '', terminalMention = null, generation = 0, guard, publicCompletionMention = false, deliveryToken } = {}) {
    if(destination.visibility==='requester'&&(!destination.chatId||!/^ou_[A-Za-z0-9]+$/.test(destination.openId??'')))throw new Error('Private card destination invalid');
    if(publicCompletionMention&&!(terminal&&terminalMention?.kind==='directory_completion'&&destination.visibility==='requester'&&destination.strictGroup&&destination.contactChannel&&destination.openId===destination.contactChannel.requesterId))throw new Error('Public completion reminder requires the dedicated requester result');
    if(destination.visibility==='requester'&&card.body?.elements){
      card=structuredClone(card);
      card.body.elements.push({tag:'markdown',text_size:'notation',content:destination.contactChannel?'查人专用群：结果仅提问者和当前群主可见，群内原提问仍可见。':'私有交付：普通群仅你可见；话题群转机器人私聊。附件若有将通过私聊发送。你发在群里的原提问仍是群消息。'});
      const rewrite=node=>{if(!node||typeof node!=='object')return;for(const [k,v] of Object.entries(node)){if(typeof v==='string')node[k]=v.replace('结果将在本群卡片显示','结果仅向提问者交付');else rewrite(v);}};rewrite(card);
    }
    if (Buffer.byteLength(JSON.stringify(card)) > 28_000) throw new Error('Card exceeds safe message limit');
    await this.store.transact((state) => {
      guard?.(state);
      state.cardMessages ??= {};
      const existing = state.cardMessages[key];
      if (generation && (!key.startsWith('question:') || !Number.isSafeInteger(generation) || generation < 1)) throw new Error('Invalid card generation');
      if ((existing?.generation ?? 0) > generation) return;
      if (existing && JSON.stringify(existing.destination) !== JSON.stringify(destination)) throw new Error('Card identity cannot change');
      const reopening = generation > (existing?.generation ?? 0);
      if (deliveryToken && existing?.deliveryToken === deliveryToken && existing.terminal && terminal && !reopening) return;
      if (existing?.terminal && !terminal && !reopening) return; // Late progress cannot overwrite a conclusion.
      const replacingWaitingMention = !reopening && terminal && ['browser_login', 'environment_approval'].includes(existing?.terminalMention?.kind)
        && terminalMention && !terminalMention.kind;
      if (!reopening && !replacingWaitingMention && existing?.terminalMention && terminalMention
        && JSON.stringify(existing.terminalMention) !== JSON.stringify(terminalMention)) throw new Error('Requester mention identity cannot change');
      state.cardMessages[key] = { ...existing, destination, card, terminal, generation, overflow: [],
        deliveryToken: deliveryToken ?? (!reopening ? existing?.deliveryToken : undefined),
        mentionDelivered: reopening || replacingWaitingMention ? false : existing?.mentionDelivered,
        publicCompletionMention: publicCompletionMention || (!reopening && existing?.publicCompletionMention) || false,
        terminalMention: destination.visibility==='requester'&&!publicCompletionMention?null:replacingWaitingMention ? terminalMention : (reopening ? null : existing?.terminalMention) ?? (terminal ? terminalMention : null),
        detailPages: resultPages(resultText),
        revision: (existing?.revision ?? 0) + 1, updatedAt: new Date().toISOString() };
    });
    if (immediate) return this.flush(key, true);
    this.flush(key).catch(() => {});
  }
  async retry() {
    if (this.closed) return;
    if(this.retrying)return this.retrying;
    const work=(async()=>{
      const keys=await stateView(this.store,s=>Object.entries(s.cardMessages??{}).filter(([,v])=>(v.retiredMessageIds?.length||v.revision!==v.deliveredRevision||(v.terminalMention&&!v.mentionDelivered))&&Date.now()>=(v.retryAt??0)).map(([key])=>key));
      if(this.afterRetry)this.afterRetry().catch(()=>{});
      for(const key of keys)this.flush(key).catch(()=>{});
    })();this.retrying=work;try{await work;}finally{this.retrying=null;}
  }
  async flush(key, force = false) {
    if (this.closed) return;
    if (this.workers.has(key)) {
      await this.workers.get(key);
      return force ? this.flush(key, true) : undefined;
    }
    const worker = this.deliver(key, force);
    this.workers.set(key, worker);
    try { return await worker; } finally { if (this.workers.get(key) === worker) this.workers.delete(key); }
  }
  async cleanupPrivate(key){
    const entry=await stateView(this.store,s=>s.cardMessages?.[key]);
    if(entry?.destination.visibility!=='requester')return;
    for(const id of entry.retiredMessageIds??[]){
      try{await this.feishu.deletePrivateCard(id,{profile:entry.destination.profile});
        await this.store.transact(s=>{const e=s.cardMessages[key];e.retiredMessageIds=(e.retiredMessageIds??[]).filter(x=>x!==id);});
      }catch{return;} // Retain cleanup outbox. Never publish or rerun the business task.
    }
  }
  async deliver(key, force) {
    await this.cleanupPrivate(key);
    const entry = await stateView(this.store,s=>s.cardMessages?.[key]);
    if (!entry || (entry.revision === entry.deliveredRevision && (!entry.terminalMention || entry.mentionDelivered))) return entry?.messageId;
    // A local maintenance hold prevents external edits while operator approval is pending.
    if (entry.messageId) {
      try {
        const heldIds = JSON.parse(await readFile(path.join(path.dirname(this.store.file), 'card-updates.paused'), 'utf8'));
        if (heldIds.includes(entry.messageId)) return entry.messageId;
      }
      catch (error) { if (error.code !== 'ENOENT') throw error; }
    }
    if (!force && (Date.now() < (entry.retryAt ?? 0) || (!entry.terminal && Date.now() - (entry.sentAt ?? 0) < this.intervalMs))) return;
    try {
      await this.authorizeDestination?.(entry.destination,entry);
      const options = { strictGroup:entry.destination.strictGroup, replyInThread: entry.destination.replyInThread, profile: entry.destination.profile, idempotencyKey: `aos-card-${createHash('sha256').update(key).digest('hex').slice(0, 32)}` };
      let messageId = entry.messageId;
      const privateCard=entry.destination.visibility==='requester';
      let privateDeliveryKind=entry.privateDeliveryKind,privateDeliveryChatId=entry.privateDeliveryChatId;
      if(privateCard){
       if(entry.revision!==entry.deliveredRevision){
        if(typeof this.feishu.sendPrivateCard!=='function'||typeof this.feishu.deletePrivateCard!=='function')throw new Error('Private card transport unavailable');
        if(privateDeliveryKind==='dm'&&messageId){await this.feishu.updateCard(messageId,entry.card,options);}
        else {const result=await this.feishu.sendPrivateCard(entry.destination.chatId,entry.destination.openId,entry.card,options);
          messageId=messageIdOf(result);if(!messageId)throw new Error('Private card returned no message ID');privateDeliveryKind=result.private_delivery_kind??'ephemeral';privateDeliveryChatId=privateDeliveryKind==='dm'?chatIdOf(result):null;}
       }
      }
      else if (messageId) {
        if (entry.revision !== entry.deliveredRevision) await this.feishu.updateCard(messageId, entry.card, options);
      }
      else {
        const result = entry.destination.replyTo
          ? await this.feishu.replyCard(entry.destination.replyTo, entry.card, options)
          : await this.feishu.sendCard(entry.destination.chatId, entry.card, options);
        messageId = messageIdOf(result);
        if (!messageId) throw new Error('Card send returned no message ID');
      }
      await this.store.transact((state) => {
        if(privateCard&&entry.messageId&&entry.messageId!==messageId){state.cardMessages[key].retiredMessageIds=[...new Set([...(state.cardMessages[key].retiredMessageIds??[]),entry.messageId])];}
        Object.assign(state.cardMessages[key], { messageId, ...(privateCard?{privateDeliveryKind,privateDeliveryChatId}:{}), deliveredRevision: entry.revision,
          sentAt: Date.now(), failures: 0, retryAt: 0 });
      });
      if(privateCard)await this.cleanupPrivate(key);
      const {latest,questionReady}=await stateView(this.store,fresh=>{
       const question=key.startsWith('question:')?fresh.questions?.[key.slice(9)]:null;
       return {latest:fresh.cardMessages[key],questionReady:!question||(question.generation<=entry.generation
        &&!fresh.conversations.some(t=>t.questionId===question.id&&['queued','thinking','decided'].includes(t.status))
        &&!fresh.jobs.some(j=>j.questionId===question.id&&blocksTerminalMention(j,entry.terminalMention)))};
      });
      if ((!privateCard || entry.publicCompletionMention) && entry.terminalMention && !entry.mentionDelivered && latest.revision === entry.revision && questionReady) {
        if(entry.publicCompletionMention)await this.authorizeDestination?.(entry.destination,entry);
        await this.feishu.reply(entry.terminalMention.replyTo, entry.terminalMention.text, {
          profile: entry.terminalMention.profile, replyInThread: entry.terminalMention.replyInThread ?? entry.destination.replyInThread,
          idempotencyKey: `aos-mention-${createHash('sha256').update(entry.generation ? `${key}:${entry.generation}` : key).digest('hex').slice(0, 32)}`,
        });
        await this.store.transact((state) => {
          if (state.cardMessages[key].generation === entry.generation) Object.assign(state.cardMessages[key], { mentionDelivered: true, failures: 0, retryAt: 0 });
        });
      }
      // Long reports stay in the same card. Never resume legacy plaintext overflow on restart.
      return messageId;
    } catch (error) {
      const withdrawn = /(?:\b230011\b|message was withdrawn)/i.test(String(error?.message ?? error));
      await this.store.transact((state) => {
        const current = state.cardMessages[key];
        if (withdrawn) Object.assign(current, { deliveredRevision: current.revision, failures: 0, retryAt: 0, error: '原消息已撤回，停止更新' });
        else {
          current.failures = (current.failures ?? 0) + 1;
          current.retryAt = Date.now() + Math.min(60_000, current.failures * 5000);
          current.error = '消息投递失败，等待重试'; // Never persist raw CLI credentials in public status.
        }
      });
      if (withdrawn) return entry.messageId;
      throw error;
    }
  }
}
