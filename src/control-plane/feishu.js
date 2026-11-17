import {inputFileMetadata} from '../shared/input-files.js';
import {Readable} from 'node:stream';
import {pipeline} from 'node:stream/promises';
import {createWriteStream} from 'node:fs';
import {openAsBlob} from 'node:fs';
import {stat} from 'node:fs/promises';
import { mkdir, writeFile, readFile } from 'node:fs/promises';
import path from 'node:path';
import { createId } from '../shared/protocol.js';

const OPEN_API = 'https://open.feishu.cn/open-apis';

export class FeishuClient {
  constructor({ appId, appSecret, dataDir }) {
    this.appId = appId;
    this.appSecret = appSecret;
    this.dataDir = dataDir;
    this.token = null;
    this.tokenExpiresAt = 0;
  }

  get enabled() {
    return Boolean(this.appId && this.appSecret);
  }

  async tenantToken() {
    if (this.token && Date.now() < this.tokenExpiresAt) return this.token;
    const response = await fetch(`${OPEN_API}/auth/v3/tenant_access_token/internal`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ app_id: this.appId, app_secret: this.appSecret }),
    });
    const body = await response.json();
    if (!response.ok || body.code !== 0) throw new Error(`Feishu token request failed: ${body.msg ?? response.status}`);
    this.token = body.tenant_access_token;
    this.tokenExpiresAt = Date.now() + Math.max(60, Number(body.expire ?? 7200) - 120) * 1000;
    return this.token;
  }

  async reply(messageId, text, options = {}) {
    if (!this.enabled || !messageId) return;
    const token = await this.tenantToken();
    const response = await fetch(`${OPEN_API}/im/v1/messages/${encodeURIComponent(messageId)}/reply`, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ msg_type: 'text', content: JSON.stringify({ text }), uuid: options.idempotencyKey, ...(options.replyInThread ? { reply_in_thread: true } : {}) }),
    });
    if (!response.ok) throw new Error(`Feishu reply failed: HTTP ${response.status}`);
    const result = await response.json();
    if (result.code !== 0) throw new Error(`Feishu reply failed: ${result.code}`);
    return result;
  }

  async contactRequest(route,params){
    if(route!=='/open-apis/application/v6/scopes'&&!/^\/open-apis\/contact\/v3\/(?:scopes|users\/find_by_department|users\/[^/]+|departments\/[^/]+(?:\/children)?)$/.test(route))throw new Error('Invalid contact route');
    const response=await fetch('https://open.feishu.cn'+route+'?'+new URLSearchParams(params),{headers:{authorization:`Bearer ${await this.tenantToken()}`},signal:AbortSignal.timeout(30000)});
    const result=await response.json();if(!response.ok||result.code!==0)throw new Error('Contact API failed');return result.data??{};
  }
  async replyImage(messageId,file,options={}){
    const form=new FormData();form.set('image_type','message');form.set('image',new Blob([await readFile(file)],{type:'image/png'}),path.basename(file));
    const response=await fetch(`${OPEN_API}/im/v1/images`,{method:'POST',headers:{authorization:`Bearer ${await this.tenantToken()}`},body:form,signal:AbortSignal.timeout(30000)});
    const uploaded=await response.json();if(!response.ok||uploaded.code!==0||!uploaded.data?.image_key)throw new Error('Image upload failed');
    const sent=await fetch((options.privateRecipient?`${OPEN_API}/im/v1/messages?receive_id_type=open_id`:`${OPEN_API}/im/v1/messages/${encodeURIComponent(messageId)}/reply`),{method:'POST',headers:{authorization:`Bearer ${await this.tenantToken()}`,'content-type':'application/json'},body:JSON.stringify({...(options.privateRecipient?{receive_id:options.privateRecipient}:{}),msg_type:'image',content:JSON.stringify({image_key:uploaded.data.image_key}),uuid:options.idempotencyKey,...(!options.privateRecipient&&options.replyInThread?{reply_in_thread:true}:{})}),signal:AbortSignal.timeout(30000)});
    const result=await sent.json();if(!sent.ok||result.code!==0)throw new Error('Image reply failed');return result;
  }

  async replyFile(messageId,file,options={}){
    const form=new FormData();form.set('file_type','stream');form.set('file_name',path.basename(file));form.set('file',await openAsBlob(file),path.basename(file));
    const response=await fetch(`${OPEN_API}/im/v1/files`,{method:'POST',headers:{authorization:`Bearer ${await this.tenantToken()}`},body:form,signal:AbortSignal.timeout(30000+Math.ceil((await stat(file)).size/64000)*1000)});
    const result=await response.json();if(!response.ok||result.code!==0||!result.data?.file_key)throw new Error('Feishu report upload failed');
    return this.cardRequest('POST',options.privateRecipient?'/im/v1/messages?receive_id_type=open_id':`/im/v1/messages/${encodeURIComponent(messageId)}/reply`,{...(options.privateRecipient?{receive_id:options.privateRecipient}:{}),msg_type:'file',content:JSON.stringify({file_key:result.data.file_key}),uuid:options.idempotencyKey,...(!options.privateRecipient&&options.replyInThread?{reply_in_thread:true}:{})});
  }

  async chatInfo(chatId){const response=await fetch(`${OPEN_API}/im/v1/chats/${encodeURIComponent(chatId)}?user_id_type=open_id`,{headers:{authorization:`Bearer ${await this.tenantToken()}`},signal:AbortSignal.timeout(15000)});const r=await response.json();if(!response.ok||r.code!==0)throw new Error('Chat information unavailable');return r.data;}
  async uploadImage(file){const form=new FormData();form.set('image_type','message');form.set('image',new Blob([await readFile(file)],{type:'image/png'}),path.basename(file));const response=await fetch(`${OPEN_API}/im/v1/images`,{method:'POST',headers:{authorization:`Bearer ${await this.tenantToken()}`},body:form,signal:AbortSignal.timeout(30000)});const r=await response.json();if(!response.ok||r.code!==0)throw new Error('Image upload failed');return r;}
  async sendPrivateCard(chatId, openId, card, options={}) {
    if(!chatId||!/^ou_[A-Za-z0-9]+$/.test(openId??''))throw new Error('Private card recipient missing');
    try{return await this.cardRequest('POST','/ephemeral/v1/send',{chat_id:chatId,open_id:openId,msg_type:'interactive',card});}
    catch(error){if(options.strictGroup||error.feishuCode!==18053||!/chat can not be thread/.test(error.feishuMessage??''))throw error;
      const result=await this.cardRequest('POST','/im/v1/messages?receive_id_type=open_id',{receive_id:openId,msg_type:'interactive',content:JSON.stringify(card)});return {...result,private_delivery_kind:'dm'};}
  }
  async deletePrivateCard(messageId){try{return await this.cardRequest('POST','/ephemeral/v1/delete',{message_id:messageId});}catch(e){if(!/18051/.test(e.message))throw e;}}
  async replyCard(messageId, card, options = {}) {
    return this.cardRequest('POST', `/im/v1/messages/${encodeURIComponent(messageId)}/reply`,
      { msg_type: 'interactive', content: JSON.stringify(card), uuid: options.idempotencyKey, ...(options.replyInThread ? { reply_in_thread: true } : {}) });
  }
  async sendCard(chatId, card, options = {}) {
    return this.cardRequest('POST', '/im/v1/messages?receive_id_type=chat_id',
      { receive_id: chatId, msg_type: 'interactive', content: JSON.stringify(card), uuid: options.idempotencyKey });
  }
  async updateCard(messageId, card) {
    return this.cardRequest('PATCH', `/im/v1/messages/${encodeURIComponent(messageId)}`, { content: JSON.stringify(card) });
  }
  async cardRequest(method, route, body) {
    const token = await this.tenantToken();
    const response = await fetch(`${OPEN_API}${route}`, { method,
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify(body), signal: AbortSignal.timeout(15_000) });
    const result = await response.json();
    if (!response.ok || result.code !== 0) {const error=new Error(`Feishu card failed: ${result.code ?? response.status}`);error.feishuCode=result.code;error.feishuMessage=result.msg;throw error;}
    return result;
  }

  async downloadMessageResource(jobId, messageId, resourceKey, type = 'image') {
    if (!this.enabled) return null;
    const token = await this.tenantToken();
    const url = `${OPEN_API}/im/v1/messages/${encodeURIComponent(messageId)}/resources/${encodeURIComponent(resourceKey)}?type=${encodeURIComponent(type)}`;
    const response = await fetch(url, { headers: { authorization: `Bearer ${token}` } });
    if (!response.ok) throw new Error(`Feishu resource download failed: HTTP ${response.status}`);
    const contentType = response.headers.get('content-type') ?? 'application/octet-stream';
    const extension = extensionFor(contentType, type);
    const directory = path.join(this.dataDir, 'attachments', jobId);
    await mkdir(directory, { recursive: true });
    const id = createId('ATT');
    const file = path.join(directory, `${id}${extension}`);
    await pipeline(Readable.fromWeb(response.body),createWriteStream(file,{mode:0o600}));
    return {...await inputFileMetadata(file,{id,type}),contentType,originalResourceKey:resourceKey};
  }
}

export function parseFeishuMessage(message) {
  const raw = safeJson(message.content);
  const mentions = message.mentions ?? [];
  let text = '';
  const resources = [];

  if (message.message_type === 'text') text = raw.text ?? '';
  if (message.message_type === 'image' && raw.image_key) resources.push({ key: raw.image_key, type: 'image' });
  if (message.message_type === 'file' && raw.file_key) resources.push({ key: raw.file_key, type: 'file', ...(raw.file_name?{name:raw.file_name}:{}) });
  if (message.message_type === 'post') {
    for (const locale of Object.values(raw)) {
      if (!locale || typeof locale !== 'object') continue;
      if (locale.title) text += `${locale.title}\n`;
      for (const paragraph of locale.content ?? []) {
        for (const item of paragraph) {
          if (item.tag === 'text' || item.tag === 'a') text += `${item.text ?? ''} ${item.tag==='a'&&item.href&&item.href!==item.text?item.href:''} `;
          if (item.tag === 'img' && item.image_key) resources.push({ key: item.image_key, type: 'image' });
        }
        text += '\n';
      }
    }
  }
  for (const mention of mentions) {
    if (mention.key) text = text.replaceAll(mention.key, '');
  }
  return { text: text.replace(/\s+/g, ' ').trim(), structuredText: text.trim(), resources };
}

function safeJson(value) {
  try { return typeof value === 'string' ? JSON.parse(value) : (value ?? {}); }
  catch { return {}; }
}

function extensionFor(contentType, type) {
  if (contentType.includes('png')) return '.png';
  if (contentType.includes('jpeg') || contentType.includes('jpg')) return '.jpg';
  if (contentType.includes('webp')) return '.webp';
  return type === 'image' ? '.img' : '.bin';
}
