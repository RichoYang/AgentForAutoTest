import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, copyFile }  from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import {stat} from 'node:fs/promises';

export function resolveLarkCliEntry(explicit = '', executable = process.execPath, platform = process.platform) {
  if (explicit) return path.resolve(explicit);
  const relative = path.join('@larksuite', 'cli', 'scripts', 'run.js');
  const directory = path.dirname(executable);
  const candidates = platform === 'win32'
    ? [path.join(directory, 'node_modules', relative)]
    : [path.join(path.dirname(directory), 'lib', 'node_modules', relative), path.join(directory, 'node_modules', relative)];
  return path.resolve(candidates.find(existsSync) ?? candidates[0]);
}

export function spawnLarkCli(args, options = {}) {
  const entry = resolveLarkCliEntry(options.cliEntry);
  const profileArgs = options.profile ? ['--profile', options.profile] : [];
  return spawn(process.execPath, [entry, ...profileArgs, ...args], {
    cwd: options.cwd,
    env: {
      ...process.env,
      ...(options.configDir ? { LARKSUITE_CLI_CONFIG_DIR: options.configDir } : {}),
      LARKSUITE_CLI_NO_UPDATE_NOTIFIER: '1',
      LARKSUITE_CLI_NO_SKILLS_NOTIFIER: '1',
    },
    windowsHide: true,
    ...(options.signal?{signal:options.signal}:{}),
    stdio: options.stdio ?? [options.input ? 'pipe' : 'ignore', 'pipe', 'pipe'],
  });
}

export function runLarkCli(args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawnLarkCli(args, options);
    if (options.input) { child.stdin.on('error', () => {}); child.stdin.end(options.input); }
    let stdout = '';
    let stderr = '';
    child.stdout?.setEncoding('utf8');
    child.stderr?.setEncoding('utf8');
    const timer = options.timeoutMs===false?null:setTimeout(() => { child.kill(); reject(new Error('lark-cli request timed out')); }, options.timeoutMs ?? 30_000);
    child.stdout?.on('data', (chunk) => { stdout += chunk; });
    child.stderr?.on('data', (chunk) => { stderr += chunk; });
    child.once('error', (error) => { clearTimeout(timer); reject(error); });
    child.once('close', (code) => {
      clearTimeout(timer);
      if (code !== 0) {let detail;try{detail=JSON.parse(stderr||stdout).error;}catch{}return reject(Object.assign(new Error(`lark-cli exited ${code}: ${stderr || stdout}`),{cliError:detail}));}
      try {
        const result = stdout.trim() ? JSON.parse(stdout) : {};
        if (result.ok === false || (typeof result.code === 'number' && result.code !== 0)) return reject(Object.assign(new Error('lark-cli API request rejected'),{cliError:result.error}));
        resolve(result);
      } catch {
        resolve({ raw: stdout.trim() });
      }
    });
  });
}

// Preserve existing valid keys; hash longer business effect IDs deterministically.
export function larkIdempotencyKey(value) {
  if (typeof value !== 'string' || value.length <= 50) return value;
  return `agentos-${createHash('sha256').update(value).digest('hex').slice(0, 40)}`;
}

export class LarkCliFeishuClient {
  constructor(config = {}) {
    this.cliEntry = config.cliEntry;
    this.cwd = path.resolve(config.dataDir ?? './data', 'lark-cli');
  }

  async reply(messageId, text, options = {}) {
    await mkdir(this.cwd, { recursive: true });
    const digest = createHash('sha256').update(`${messageId}\n${text}`).digest('hex').slice(0, 20);
    return runLarkCli([
      'im', '+messages-reply', '--as', 'bot', '--message-id', messageId,
      ...(options.replyInThread ? ['--reply-in-thread'] : []),
      '--text', text, '--idempotency-key', larkIdempotencyKey(options.idempotencyKey ?? `agentos-${digest}`), '--json',
    ], { cwd: this.cwd, cliEntry: this.cliEntry, profile: options.profile, timeoutMs: options.timeoutMs });
  }

  async send(chatId, text, options = {}) {
    await mkdir(this.cwd, { recursive: true });
    const digest = createHash('sha256').update(`${chatId}\n${text}`).digest('hex').slice(0, 20);
    return runLarkCli([
      'im', '+messages-send', '--as', 'bot', '--chat-id', chatId,
      '--text', text, '--idempotency-key', `agentos-${digest}`, '--json',
    ], { cwd: this.cwd, cliEntry: this.cliEntry, profile: options.profile });
  }

  async replyFile(messageId,file,options={}){
    await mkdir(path.join(this.cwd,'reports'),{recursive:true,mode:0o700});
    const relative=path.join('reports',path.basename(file));
    await copyFile(file,path.join(this.cwd,relative));
    return runLarkCli(['im',options.privateRecipient?'+messages-send':'+messages-reply','--as','bot',...(options.privateRecipient?['--user-id',options.privateRecipient]:['--message-id',messageId]),'--file',relative,
      ...(!options.privateRecipient&&options.replyInThread?['--reply-in-thread']:[]),'--idempotency-key',larkIdempotencyKey(options.idempotencyKey),'--json'],
      {cwd:this.cwd,cliEntry:this.cliEntry,profile:options.profile,timeoutMs:30000+Math.ceil((await stat(file)).size/64000)*1000});
  }

  async contactRequest(route,params,options={}){
    await mkdir(this.cwd,{recursive:true,mode:0o700});
    if(route!=='/open-apis/application/v6/scopes'&&!/^\/open-apis\/contact\/v3\/(?:scopes|users\/find_by_department|users\/[^/]+|departments\/[^/]+(?:\/children)?)$/.test(route))throw new Error('Invalid contact route');
    const result=await runLarkCli(['api','GET',route,'--as','bot','--params',JSON.stringify(params),'--json'],{cwd:this.cwd,cliEntry:this.cliEntry,profile:options.profile});
    if(!result.data||typeof result.data!=='object')throw new Error('Invalid contact response');
    return result.data;
  }
  async replyImage(messageId,file,options={}){
    await mkdir(path.join(this.cwd,'images'),{recursive:true,mode:0o700});
    const relative=path.join('images',path.basename(file));await copyFile(file,path.join(this.cwd,relative));
    return runLarkCli(['im',options.privateRecipient?'+messages-send':'+messages-reply','--as','bot',...(options.privateRecipient?['--user-id',options.privateRecipient]:['--message-id',messageId]),'--image',relative,
      ...(!options.privateRecipient&&options.replyInThread?['--reply-in-thread']:[]),'--idempotency-key',larkIdempotencyKey(options.idempotencyKey),'--json'],
      {cwd:this.cwd,cliEntry:this.cliEntry,profile:options.profile});
  }

  async chatInfo(chatId,options={}){await mkdir(this.cwd,{recursive:true});const r=await runLarkCli(['api','GET','/open-apis/im/v1/chats/'+encodeURIComponent(chatId),'--as','bot','--params',JSON.stringify({user_id_type:'open_id'}),'--json'],{cwd:this.cwd,cliEntry:this.cliEntry,profile:options.profile});if(!r.data)throw new Error('Chat information unavailable');return r.data;}
  async uploadImage(file,options={}){await mkdir(path.join(this.cwd,'images'),{recursive:true,mode:0o700});const relative=path.join('images',path.basename(file));await copyFile(file,path.join(this.cwd,relative));return runLarkCli(['im','images','create','--as','bot','--data',JSON.stringify({image_type:'message'}),'--file',relative,'--json'],{cwd:this.cwd,cliEntry:this.cliEntry,profile:options.profile,timeoutMs:30000});}
  async sendPrivateCard(chatId,openId,card,options={}){
    if(!chatId||!/^ou_[A-Za-z0-9]+$/.test(openId??''))throw new Error('Private card recipient missing');
    try{return await this.cardRequest('POST','/open-apis/ephemeral/v1/send',{chat_id:chatId,open_id:openId,msg_type:'interactive',card},options);}
    catch(error){if(options.strictGroup||!/18053/.test(error.message)||!/chat can not be thread/.test(error.message))throw error;
      const result=await this.cardRequest('POST','/open-apis/im/v1/messages',{receive_id:openId,msg_type:'interactive',content:JSON.stringify(card)},{...options,params:{receive_id_type:'open_id'}});return {...result,private_delivery_kind:'dm'};}
  }
  async deletePrivateCard(messageId,options={}){try{return await this.cardRequest('POST','/open-apis/ephemeral/v1/delete',{message_id:messageId},options);}catch(e){if(!/18051/.test(e.message))throw e;}}
  async replyCard(messageId, card, options = {}) {
    await mkdir(this.cwd, { recursive: true });
    return runLarkCli(['im', '+messages-reply', '--as', 'bot', '--message-id', messageId,
      ...(options.replyInThread ? ['--reply-in-thread'] : []),
      '--msg-type', 'interactive', '--content', JSON.stringify(card), '--idempotency-key', larkIdempotencyKey(options.idempotencyKey), '--json'],
    { cwd: this.cwd, cliEntry: this.cliEntry, profile: options.profile, timeoutMs: 15_000 });
  }

  async sendCard(chatId, card, options = {}) {
    await mkdir(this.cwd, { recursive: true });
    return runLarkCli(['im', '+messages-send', '--as', 'bot', '--chat-id', chatId,
      '--msg-type', 'interactive', '--content', JSON.stringify(card), '--idempotency-key', larkIdempotencyKey(options.idempotencyKey), '--json'],
    { cwd: this.cwd, cliEntry: this.cliEntry, profile: options.profile, timeoutMs: 15_000 });
  }

  async updateCard(messageId, card, options = {}) {
    return this.cardRequest('PATCH', `/open-apis/im/v1/messages/${encodeURIComponent(messageId)}`,
      { content: JSON.stringify(card) }, options);
  }

  async cardRequest(method, route, body, options) {
    await mkdir(this.cwd, { recursive: true });
    // stdin avoids Windows command-line limits and keeps message contents out of process arguments.
    return runLarkCli(['api', method, route, '--as', 'bot', '--data', '-', '--json',
      ...(options.params ? ['--params', JSON.stringify(options.params)] : [])],
    { cwd: this.cwd, cliEntry: this.cliEntry, profile: options.profile, input: JSON.stringify(body), timeoutMs: 15_000 });
  }

  async downloadMessageResource(jobId, messageId, fileKey, type, options = {}) {
    await mkdir(this.cwd, { recursive: true });
    const relative = path.join('resources', jobId, fileKey);
    const result = await runLarkCli([
      'im', '+messages-resources-download', '--as', 'bot', '--message-id', messageId,
      '--file-key', fileKey, '--type', type, '--output', relative, '--json',
    ], { cwd: this.cwd, cliEntry: this.cliEntry, profile: options.profile });
    const output = findPath(result) ?? relative;
    return {
      id: fileKey,
      path: path.resolve(this.cwd, output),
      type,
      contentType: type === 'image' ? 'image/*' : 'application/octet-stream',
    };
  }
}

function findPath(value) {
  if (typeof value === 'string' && /[\\/]/.test(value)) return value;
  if (Array.isArray(value)) {
    for (const item of value) {
      const found = findPath(item);
      if (found) return found;
    }
  }
  if (value && typeof value === 'object') {
    for (const [key, item] of Object.entries(value)) {
      if (/path|output|file/i.test(key) && typeof item === 'string') return item;
      const found = findPath(item);
      if (found) return found;
    }
  }
  return null;
}
