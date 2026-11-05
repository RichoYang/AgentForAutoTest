import {inputFileMetadata,messageResources} from '../shared/input-files.js';
import {realpath} from 'node:fs/promises';
import { EditedMentionWatcher } from './edited-mentions.js';
import { copyFile, mkdir, readdir, stat, readFile, writeFile, rename, unlink } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import { sanitizeSegment } from '../shared/protocol.js';
import { runLarkCli, spawnLarkCli } from './lark-cli.js';

export class LarkEventSource {
  constructor(config) {
    this.config = config;
    this.stopped = false;
    this.child = null;
    this.pendingEvents = Promise.resolve();
    this.retryDelayMs = 3000;
    this.callbackRetries = new Map();
  }

  async start() {
    if (this.config.eventKey === 'card.action.trigger') {
      await mkdir(this.callbackDirectory, { recursive: true });
      for (const name of await readdir(this.callbackDirectory)) {
        if (!name.endsWith('.json')) continue;
        this.pendingEvents = this.pendingEvents.then(() => this.deliverCallback(path.join(this.callbackDirectory, name)))
          .catch(() => console.error(this.logPrefix, '卡片回调重放失败，已保留本地记录'));
      }
    }
    while (!this.stopped) {
      try {
        await this.consumeOnce();
      } catch (error) {
        if (!this.stopped) console.error(this.logPrefix, error.message);
      }
      if (!this.stopped) await delay(this.retryDelayMs);
    }
  }

  stop() {
    this.stopped = true;
    this.child?.stdin.end();
    this.editedWatcher?.stop();
    for (const timer of this.callbackRetries.values()) clearTimeout(timer);
    this.callbackRetries.clear();
  }

  get logPrefix() {
    return `[lark-event:${this.config.role ?? 'default'}:${this.config.profile ?? 'default'}:${this.config.eventKey ?? 'im.message.receive_v1'}]`;
  }

  get callbackDirectory() { return path.join(this.config.cwd, 'pending-card-actions'); }

  consumeOnce() {
    return new Promise((resolve, reject) => {
      let pending = '';
      this.child = spawnLarkCli([
        'event', 'consume', this.config.eventKey ?? 'im.message.receive_v1', '--as', 'bot',
      ], {
        cliEntry: this.config.cliEntry,
        cwd: this.config.cwd,
        profile: this.config.profile,
        configDir: this.config.configDir,
        stdio: ['pipe', 'pipe', 'pipe'],
      });
      this.child.stdout.setEncoding('utf8');
      this.child.stdout.on('data', (chunk) => {
        pending += chunk.toString();
        const lines = pending.split(/\r?\n/);
        pending = lines.pop() ?? '';
        for (const line of lines) {
          if (!line.trim()) continue;
          this.pendingEvents = this.pendingEvents.then(() => this.handleLine(line))
            .catch((error) => console.error(this.logPrefix, error.message));
        }
      });
      this.child.stderr.on('data', (chunk) => {
        const message = chunk.toString().trim();
        if (/failed_precondition|not subscribed in console/.test(message)) this.retryDelayMs = 30_000;
        if (/\[event\] ready/.test(message)) this.retryDelayMs = 3000;
        if (message) console.error(this.logPrefix, message);
      });
      this.child.once('error', reject);
      this.child.once('close', (code) => {
        this.child = null;
        if (this.stopped || code === 0) resolve();
        else reject(new Error(`event consumer exited with code ${code}`));
      });
    });
  }

  async handleLine(line) {
    const event = JSON.parse(line);
    if (this.config.eventKey === 'card.action.trigger') {
      if (event.type !== 'card.action.trigger' || !event.event_id) return;
      // Persist before HTTP forwarding: failures/restarts retry the same business effect, not a new one.
      const payload = Object.fromEntries(['type', 'event_id', 'operator_id', 'message_id', 'chat_id', 'action_tag',
        'action_value', 'action_name', 'form_value', 'card_content'].map((field) => [field, event[field]]));
      payload.agent_profile = this.config.profile ?? null;
      payload.agent_role = this.config.role ?? null;
      await mkdir(this.callbackDirectory, { recursive: true });
      const file = path.join(this.callbackDirectory, `${createHash('sha256').update(event.event_id).digest('hex')}.json`);
      await writeFile(`${file}.tmp`, JSON.stringify(payload), 'utf8');
      await rename(`${file}.tmp`, file);
      return this.deliverCallback(file);
    }
    if (event.type !== 'im.message.receive_v1' || event.sender_type === 'bot' || this.config.excludedMessageChats?.includes(event.chat_id)) return;
    if (!isForThisBot(event, this.config.botOpenId)) return;
    if (this.config.requirementBot) {
      if (event.app_id && event.app_id !== this.config.requirementBot.appId) return;
      event.receiving_app_id = this.config.requirementBot.appId;
      event.receiving_bot_id = this.config.requirementBot.openId;
    }
    event.agent_profile = this.config.profile ?? null;
    event.agent_role = this.config.role ?? null;
    event.attachments = await this.downloadAttachments(event);
    const parent=event.reply_to??event.parent_id;
    const explicitlyAddressed=event.chat_type==='p2p'||(event.mentions??[]).some(m=>[m.id?.open_id??m.id,m.open_id,m.user_id].includes(this.config.botOpenId));
    if(parent&&explicitlyAddressed){
      try{const referenced={...event,message_type:'file',message_id:parent,attachmentErrors:[]};event.attachments=[...new Map([...event.attachments,...await this.downloadAttachments(referenced,event.chat_id)].map(a=>[a.id,a])).values()];event.attachmentErrors=[...(event.attachmentErrors??[]),...referenced.attachmentErrors];}
      catch{event.attachmentErrors=[...(event.attachmentErrors??[]),'原回复消息的附件未能下载；保留当前提问，请核对机器人对原文件的读取权限或重新上传。'];}
    }
    if (event.attachments.length > 0 && isAttachmentPlaceholder(event.content, event.message_type)) {
      event.content = '';
    }
    const response = await fetch(`${this.config.serverUrl}/api/v1/events/lark-cli`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${this.config.adminToken}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify(event),
    });
    if (!response.ok) {
      const body = await response.text();
      throw new Error(`control plane rejected ${event.message_id}: ${response.status} ${body}`);
    }
  }

  async deliverCallback(file) {
    let payload;
    try { payload = await readFile(file, 'utf8'); } catch (error) { if (error.code === 'ENOENT') return; throw error; }
    if (this.stopped) return;
    try {
      const response = await fetch(`${this.config.serverUrl}/api/v1/events/card-action`, {
        method: 'POST', signal: AbortSignal.timeout(10_000),
        headers: { authorization: `Bearer ${this.config.adminToken}`, 'content-type': 'application/json' }, body: payload,
      });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      await unlink(file).catch(() => {});
      clearTimeout(this.callbackRetries.get(file));
      this.callbackRetries.delete(file);
    } catch {
      console.warn(this.logPrefix, '卡片回调尚未送达，保留记录并稍后重试；继续处理其他按钮');
      if (!this.stopped && !this.callbackRetries.has(file)) {
        const timer = setTimeout(() => {
          this.callbackRetries.delete(file);
          this.pendingEvents = this.pendingEvents.then(() => this.deliverCallback(file))
            .catch(() => console.error(this.logPrefix, '卡片回调重试失败，已保留本地记录'));
        }, this.config.callbackRetryMs ?? 3000);
        timer.unref?.();
        this.callbackRetries.set(file, timer);
      }
    }
  }

  async downloadAttachments(event,expectedChatId=event.chat_id) {
    if (!['image', 'file', 'audio', 'media', 'post'].includes(event.message_type)) return [];
    const messageId = event.message_id ?? event.id;
    if (!messageId) return [];
    const directory = path.join(this.config.cwd, 'messages', sanitizeSegment(messageId));
    await mkdir(directory, { recursive: true });
    const result=await (this.config.runLarkCli??runLarkCli)([
      'im', '+messages-mget', '--as', 'bot', '--message-ids', messageId,
      '--download-resources', '--no-reactions', '--json',
    ], {
      cliEntry: this.config.cliEntry,
      cwd: directory,
      profile: this.config.profile,
      configDir: this.config.configDir,
    });
    const resources=messageResources(result),attachments=[];
    for(const resource of resources){
      if(resource.message_id&&resource.message_id!==messageId)continue;
      if(expectedChatId&&resource.chatId&&resource.chatId!==expectedChatId)throw new Error('原文件不属于当前群聊');
      if(resource.error||!resource.local_path){event.attachmentErrors=[...(event.attachmentErrors??[]),'附件资源下载失败，不能当作文件内容为空'];continue;}
      const file=await realpath(path.resolve(directory,resource.local_path));const root=await realpath(directory);const rel=path.relative(root,file);
      if(rel.startsWith('..')||path.isAbsolute(rel))throw new Error('附件下载路径离开本消息资源目录');
      const id=`${sanitizeSegment(messageId)}-${createHash('sha256').update(resource.key??file).digest('hex').slice(0,16)}`;
      attachments.push(await inputFileMetadata(file,{id,name:resource.name,type:resource.type,sourceMessageId:messageId}));
    }
    return [...new Map(attachments.map(a=>[a.id,a])).values()];
  }
}

export async function startLarkEventSource(config) {
  const cwd = path.resolve(config.dataDir ?? './data', 'lark-cli-events', sanitizeSegment(config.profile ?? 'default'));
  const configDir = path.resolve(config.dataDir ?? './data', 'lark-cli-config', sanitizeSegment(config.profile ?? 'default'));
  await mkdir(cwd, { recursive: true });
  if (!config.reuseIsolatedConfig) await prepareIsolatedConfig(configDir, config.larkConfigFile);
  const source = new LarkEventSource({ ...config, cwd, configDir });
  if (config.requirementBot && config.eventKey !== 'card.action.trigger') {
    const options = { cliEntry: config.cliEntry, profile: config.profile, configDir };
    const identity = await runLarkCli(['auth', 'status', '--verify', '--json'], options);
    if (identity.appId !== config.requirementBot.appId || identity.identities?.bot?.openId !== config.requirementBot.openId
      || identity.identities.bot.verified !== true) throw new Error('Feishu requirement robot identity verification failed');
  }
  console.log(`[lark-event] starting ${config.role ?? 'default'} via profile ${config.profile ?? 'default'} in ${configDir}`);
  const running = source.start();
  if(config.eventKey!=='card.action.trigger' && config.editedMentions?.enabled && config.editedMentions.profiles.includes(config.profile) && config.botOpenId) {
    source.editedWatcher=new EditedMentionWatcher(source,config.watchedChatIds ?? [],config.editedMentions);
    source.editedWatcher.start();
  }
  return { source, running };
}

async function prepareIsolatedConfig(configDir, explicitSource) {
  const source = path.resolve(explicitSource ?? path.join(os.homedir(), '.lark-cli', 'config.json'));
  await mkdir(configDir, { recursive: true });
  await copyFile(source, path.join(configDir, 'config.json'));
}

export async function startLarkEventSources(config, agents = {}) {
  const sources = [];
  for (const plan of larkEventSourcePlans(config, agents)) {
    sources.push(await startLarkEventSource(plan));
    if (plan.eventKey !== 'card.action.trigger') await delay(1_000);
  }
  return sources;
}

export function larkEventSourcePlans(config, agents = {}) {
  const entries = Object.keys(agents).length ? Object.entries(agents) : [[config.role ?? 'owner_intake', { profile: config.profile }]];
  const plans = [];
  for (const [role, agent] of entries) {
    const scoped = {
      ...config,
      role: agent.routeFromText ? null : role,
      profile: agent.profile || null,
      botOpenId: agent.openId,
      requirementBot: config.requirementRoutes?.get(agent.profile)?.test.bot,
    };
    plans.push(scoped);
    // Both subscriptions share this bot's bus and isolated auth, never another bot's profile.
    // A route-only legacy identity has no app/profile and cannot own card callbacks.
    if (scoped.profile) plans.push({ ...scoped, eventKey: 'card.action.trigger', reuseIsolatedConfig: true });
  }
  return plans;
}

export function isForThisBot(event, botOpenId) {
  if (!Array.isArray(event.mentions) || event.mentions.length === 0) return true;
  if (!botOpenId) return event.chat_type === 'p2p';
  return event.mentions.some((mention) => [mention.id?.open_id ?? mention.id, mention.open_id, mention.user_id]
    .filter(Boolean).includes(botOpenId));
}

function isAttachmentPlaceholder(content, messageType) {
  const text = String(content ?? '').trim();
  return messageType !== 'post' && (!text || /^\[(image|file|audio|media)\]$/i.test(text));
}

function delay(ms) { return new Promise((resolve) => setTimeout(resolve, ms)); }
