import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { mkdtemp, mkdir, readFile, writeFile, rm, utimes, chmod } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { CodexAppServer } from '../src/shared/codex-app-server.js';
import { codexEnvironment, discoverMacCodexBinary, discoverWindowsCodexBinary, loadCodexRuntimeSettings, resolveCodexBinary, saveCodexRuntimeSettings } from '../src/shared/codex-runtime.js';

function fakeServer({ hold = [] } = {}) {
  const requests = [], children = [];
  const spawn = () => {
    const child = new EventEmitter();
    Object.assign(child, { stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough(), exitCode: null });
    child.kill = () => { child.exitCode = 0; queueMicrotask(() => child.emit('close', 0)); };
    child.stdin.on('data', (data) => {
      for (const line of data.toString().trim().split('\n')) {
        const msg = JSON.parse(line);
        requests.push(msg);
        if (msg.id && msg.method && !hold.includes(msg.method)) queueMicrotask(() => child.stdout.write(JSON.stringify({ id: msg.id,
          result: msg.method === 'turn/start' ? { turn: { id: `turn-${msg.params.threadId}` } } : {} }) + '\n'));
      }
    });
    children.push(child);
    return child;
  };
  const app = new CodexAppServer({ spawn });
  const notify = (method, params) => children.at(-1).stdout.write(`${JSON.stringify({ method, params })}\n`);
  return { app, children, requests, notify };
}

test('dynamic tool dispatch is opt-in and cannot approve unrelated native tools', async t => {
  const { app, requests } = fakeServer(); t.after(() => app.close()); await app.start();
  app.receive({ id: 900, method: 'item/tool/call', params: { tool: 'test_read' } });
  assert.equal(requests.find(item => item.id === 900).error.code, -32601);
  app.options.onToolCall = async params => ({ success: true, contentItems: [{ type: 'inputText', text: params.tool }] });
  app.receive({ id: 901, method: 'item/tool/call', params: { tool: 'test_read' } });
  await new Promise(setImmediate);
  assert.equal(requests.find(item => item.id === 901).result.contentItems[0].text, 'test_read');
  app.receive({ id: 902, method: 'item/commandExecution/requestApproval', params: {} });
  assert.equal(requests.find(item => item.id === 902).error.code, -32601);
});

test('stdio initialization is shared, answers finish without process exit and thread events stay isolated', async (t) => {
  const { app, children, requests, notify } = fakeServer();
  t.after(() => app.close());
  await Promise.all([app.start(), app.start()]);
  assert.equal(children.length, 1);
  assert.equal(requests.filter((r) => r.method === 'initialize').length, 1);
  const a = app.turn({ threadId: 'a', input: [] });
  const b = app.turn({ threadId: 'b', input: [] });
  await new Promise(setImmediate);
  notify('item/completed', { threadId: 'b', turnId: 'turn-b', item: { type: 'agentMessage', text: 'B' } });
  notify('turn/completed', { threadId: 'b', turn: { id: 'turn-b', status: 'completed', items: [] } });
  assert.equal((await b).text, 'B');
  notify('item/completed', { threadId: 'a', turnId: 'turn-a', item: { type: 'agentMessage', text: 'A' } });
  notify('turn/completed', { threadId: 'a', turn: { id: 'turn-a', status: 'completed', items: [] } });
  assert.equal((await a).text, 'A');
  assert.equal(children[0].exitCode, null);
});

test('timeout interrupts only its turn, rejects result and does not replay it', async (t) => {
  const { app, requests, notify } = fakeServer();
  t.after(() => app.close());
  const result = app.turn({ threadId: 'slow', input: [] }, { timeoutMs: 25 });
  await assert.rejects(result, /超过时限/);
  assert.equal(requests.filter((r) => r.method === 'turn/start').length, 1);
  assert.equal(requests.filter((r) => r.method === 'turn/interrupt').length, 1);
  const next = app.turn({ threadId: 'new', input: [] });
  await new Promise(setImmediate);
  notify('turn/completed', { threadId: 'slow', turn: { id: 'turn-slow', status: 'completed', items: [] } });
  notify('turn/completed', { threadId: 'new', turn: { id: 'turn-new', status: 'completed', items: [{ type: 'agentMessage', text: 'new' }] } });
  assert.equal((await next).text, 'new');
});

test('server-initiated tool approval is rejected, process crash fails active turn and next call reconnects', async (t) => {
  const { app, children, requests } = fakeServer();
  t.after(() => app.close());
  await app.start();
  app.receive({ id: 999, method: 'item/commandExecution/requestApproval', params: {} });
  assert.equal(requests.find((r) => r.id === 999).error.code, -32601);
  const active = app.turn({ threadId: 'old', input: [] });
  await new Promise(setImmediate);
  children[0].kill();
  await assert.rejects(active, /disconnected/);
  await app.start();
  assert.equal(children.length, 2);
});

test('Codex proxy overrides are child-local; embedded credentials are refused', async () => {
  const before = process.env.HTTPS_PROXY;
  const env = await codexEnvironment({ proxyUrl: 'http://127.0.0.1:12000' });
  assert.equal(env.HTTPS_PROXY, 'http://127.0.0.1:12000');
  assert.equal(process.env.HTTPS_PROXY, before);
  await assert.rejects(codexEnvironment({ proxyUrl: 'http://name:secret@localhost:12000' }), /credentials/);
});

test('an explicit empty proxy uses direct networking without mutating the parent environment', async () => {
  const before = { http: process.env.HTTP_PROXY, https: process.env.HTTPS_PROXY, all: process.env.ALL_PROXY };
  process.env.HTTP_PROXY = 'http://127.0.0.1:1';
  process.env.HTTPS_PROXY = 'http://127.0.0.1:1';
  process.env.ALL_PROXY = 'http://127.0.0.1:1';
  try {
    const env = await codexEnvironment({ proxyUrl: '' });
    assert.equal(env.HTTP_PROXY, undefined);
    assert.equal(env.HTTPS_PROXY, undefined);
    assert.equal(env.ALL_PROXY, undefined);
    assert.equal(process.env.HTTP_PROXY, 'http://127.0.0.1:1');
  } finally {
    for (const [key, value] of Object.entries({ HTTP_PROXY: before.http, HTTPS_PROXY: before.https, ALL_PROXY: before.all })) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
  }
});

test('AgentOS runtime settings preserve non-model Codex options and validate effort', async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'agentos-codex-runtime-'));
  const file = path.join(directory, 'runtime.json');
  t.after(() => rm(directory, { recursive: true, force: true }));
  await writeFile(file, JSON.stringify({ proxyUrl: '', codexBin: '/opt/codex' }));
  await saveCodexRuntimeSettings({ model: 'gpt-5.6-sol', reasoningEffort: 'high' }, { file });
  assert.deepEqual(await loadCodexRuntimeSettings({ file }), { model: 'gpt-5.6-sol', reasoningEffort: 'high' });
  assert.deepEqual(JSON.parse(await readFile(file, 'utf8')), {
    proxyUrl: '', codexBin: '/opt/codex', model: 'gpt-5.6-sol', reasoningEffort: 'high',
  });
  await assert.rejects(saveCodexRuntimeSettings({ model: 'gpt-5.6-sol', reasoningEffort: 'impossible' }, { file }), /reasoning effort/);
});

test('desktop Codex discovery selects the newest valid executable directory', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'agentos-codex-bin-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const oldDir = path.join(root, 'old');
  const newDir = path.join(root, 'new');
  await mkdir(oldDir);
  await mkdir(newDir);
  const oldBin = path.join(oldDir, 'codex.exe');
  const newBin = path.join(newDir, 'codex.exe');
  await writeFile(oldBin, 'old');
  await writeFile(newBin, 'new');
  await utimes(oldBin, new Date(1_000), new Date(1_000));
  await utimes(newBin, new Date(2_000), new Date(2_000));
  assert.equal(await discoverWindowsCodexBinary(root), newBin);
});

test('macOS ChatGPT Codex discovery follows the current nested app bundle', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'agentos-mac-codex-bin-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const binary = path.join(root, 'codex-cli', 'CodexCLI.app', 'Contents', 'MacOS', 'codex');
  await mkdir(path.dirname(binary), { recursive: true });
  await writeFile(binary, '#!/bin/sh\n');
  await chmod(binary, 0o755);
  const accessFile=process.platform==='win32'?async(file,mode)=>{assert.equal(file,binary);assert.equal(mode,1);}:undefined;
  assert.equal(await discoverMacCodexBinary(root,{accessFile}), binary);
  assert.equal(await resolveCodexBinary(undefined, { macDiscoveryRoot: root,platform:'darwin',accessFile }), binary);
});

test('macOS ChatGPT Codex discovery ignores a non-executable bundle file', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'agentos-mac-codex-mode-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const binary = path.join(root, 'codex-cli', 'CodexCLI.app', 'Contents', 'MacOS', 'codex');
  await mkdir(path.dirname(binary), { recursive: true });
  await writeFile(binary, 'not executable');
  await chmod(binary, 0o644);
  const accessFile=process.platform==='win32'?async()=>{throw Object.assign(new Error('synthetic POSIX execute denied'),{code:'EACCES'});}:undefined;
  assert.equal(await discoverMacCodexBinary(root,{accessFile}), null);
});

test('the codex sentinel in CODEX_BIN still enables desktop discovery', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'agentos-codex-env-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const versionDir = path.join(root, 'current');
  await mkdir(versionDir);
  const binary = path.join(versionDir, 'codex.exe');
  await writeFile(binary, 'current');
  const before = process.env.CODEX_BIN;
  process.env.CODEX_BIN = 'codex';
  try {
    assert.equal(await resolveCodexBinary(undefined, { discoveryRoot: root }), binary);
  } finally {
    if (before === undefined) delete process.env.CODEX_BIN; else process.env.CODEX_BIN = before;
  }
});


test('default RPC and model wait survive old deadlines; completion and close still settle', async (t) => {
  const { app, children, requests, notify } = fakeServer({hold:['initialize','account/read']});
  t.after(()=>app.close());
  t.mock.timers.enable({apis:['setTimeout']});
  let started=false;
  const startup=app.start().then(()=>{started=true;});
  t.mock.timers.tick(16000);
  await Promise.resolve();
  assert.equal(started,false);
  const init=requests.find(x=>x.method==='initialize');
  app.receive({id:init.id,result:{}});await startup;
  let answered=false;
  const account=app.request('account/read',{}).then(v=>{answered=true;return v;});
  t.mock.timers.tick(120000);await Promise.resolve();assert.equal(answered,false);
  app.receive({id:requests.find(x=>x.method==='account/read').id,result:{account:{type:'chatgpt'}}});
  assert.equal((await account).account.type,'chatgpt');
  const turn=app.turn({threadId:'long'});await new Promise(setImmediate);
  t.mock.timers.tick(600000);await Promise.resolve();
  assert.equal(requests.filter(x=>x.method==='turn/interrupt').length,0);
  notify('turn/completed',{threadId:'long',turn:{id:'turn-long',status:'completed',items:[{type:'agentMessage',text:'done'}]}});
  assert.equal((await turn).text,'done');
  const pending=app.request('account/read',{});const rejected=assert.rejects(pending,/disconnected/);
  children[0].kill();await rejected;assert.equal(app.pending.size,0);
});

test('unbounded model wait remains explicitly cancellable without replay', async(t)=>{
 const {app,requests}=fakeServer();t.after(()=>app.close());
 const controller=new AbortController();const turn=app.turn({threadId:'cancel'},{signal:controller.signal});
 const rejected=assert.rejects(turn,/aborted/);await new Promise(setImmediate);controller.abort();await rejected;
 assert.equal(requests.filter(x=>x.method==='turn/start').length,1);
 assert.equal(requests.filter(x=>x.method==='turn/interrupt').length,1);
});

test('cancellation settles even while shared server initialization is still waiting',async(t)=>{
 const {app,requests}=fakeServer({hold:['initialize']});t.after(()=>app.close());
 const controller=new AbortController();const waiting=app.turn({threadId:'never-started'},{signal:controller.signal});
 const rejected=assert.rejects(waiting,/aborted/);controller.abort();await rejected;
 assert.equal(requests.some(x=>x.method==='turn/start'),false);
});

test('upstream account timeouts retain method and retry safely without a task deadline',async t=>{
 const {app,requests}=fakeServer({hold:['account/read']});t.after(()=>app.close());await app.start();
 const progress=[];const pending=app.readAccount({retryDelayMs:1,onRetry:p=>progress.push(p)});
 for(let i=0;i<3;i++){
  while(requests.filter(r=>r.method==='account/read').length<=i)await new Promise(setImmediate);
  const r=requests.filter(r=>r.method==='account/read')[i];app.receive({id:r.id,error:{code:-32000,message:'request timed out secret=do-not-display'}});
 }
 while(requests.filter(r=>r.method==='account/read').length<4)await new Promise(setImmediate);
 app.receive({id:requests.filter(r=>r.method==='account/read').at(-1).id,result:{account:{type:'chatgpt'}}});
 assert.equal((await pending).account.type,'chatgpt');assert.equal(progress.length,3);assert.ok(progress.every(p=>p.stage==='account/read'));assert.doesNotMatch(JSON.stringify(progress),/secret/);assert.equal(requests.filter(r=>r.method==='turn/start').length,0);
});
test('account recovery stops promptly on close and does not retry permanent errors',async t=>{
 const first=fakeServer({hold:['account/read']});t.after(()=>first.app.close());await first.app.start();
 const pending=first.app.readAccount({retryDelayMs:10000});const rejected=assert.rejects(pending,/stopped|disconnected/);
 first.app.receive({id:first.requests.find(r=>r.method==='account/read').id,error:{message:'timeout'}});await new Promise(setImmediate);await first.app.close();await rejected;
 assert.equal(first.requests.filter(r=>r.method==='account/read').length,1);
 const second=fakeServer({hold:['account/read']});t.after(()=>second.app.close());await second.app.start();const read=second.app.readAccount({retryDelayMs:1});
 second.app.receive({id:second.requests.find(r=>r.method==='account/read').id,error:{code:-32600,message:'Login required'}});
 await assert.rejects(read,e=>e.code==='CODEX_RPC_ERROR'&&e.rpcMethod==='account/read');assert.equal(second.requests.filter(r=>r.method==='account/read').length,1);
});
test('other RPC timeouts are classified but not automatically replayed',async t=>{
 const {app,requests}=fakeServer({hold:['thread/start']});t.after(()=>app.close());await app.start();const p=app.request('thread/start',{});
 app.receive({id:requests.find(r=>r.method==='thread/start').id,error:{message:'timed out'}});
 await assert.rejects(p,e=>e.code==='CODEX_RPC_TIMEOUT'&&e.rpcMethod==='thread/start');assert.equal(requests.filter(r=>r.method==='thread/start').length,1);
});

test('account workspace routing discovery errors recover without replaying any business or model turn',async t=>{
 const {app,requests}=fakeServer({hold:['account/read']});t.after(()=>app.close());await app.start();const progress=[];const result=app.readAccount({retryDelayMs:1,onRetry:p=>progress.push(p)});
 while(!requests.some(r=>r.method==='account/read'))await new Promise(setImmediate);app.receive({id:requests.find(r=>r.method==='account/read').id,error:{code:-32603,message:'workspace routing discovery failed'}});
 while(requests.filter(r=>r.method==='account/read').length<2)await new Promise(setImmediate);app.receive({id:requests.filter(r=>r.method==='account/read').at(-1).id,result:{account:{type:'chatgpt'}}});
 assert.equal((await result).account.type,'chatgpt');assert.equal(progress[0].reason,'workspace_routing');assert.equal(requests.filter(r=>r.method==='turn/start'||r.method==='thread/start').length,0);
});
