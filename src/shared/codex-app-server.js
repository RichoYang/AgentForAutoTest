import {retryModelCapacity} from './model-capacity.js';
import { spawn } from 'node:child_process';
import { EventEmitter } from 'node:events';

// One local stdio connection, not a public listener. No credentials are copied.
export class CodexAppServer extends EventEmitter {
  constructor(options = {}) {
    super();
    this.options = options;
    this.pending = new Map();
    this.sequence = 0;
    this.generation = 0;
  }

  async start() {
    if (this.starting) return this.starting;
    this.starting = this.initialize().catch((error) => { this.close(); throw error; });
    return this.starting;
  }

  async initialize() {
    const child = (this.options.spawn ?? spawn)(this.options.codexBin ?? process.env.CODEX_BIN ?? 'codex',
      this.options.args ?? ['app-server', '--stdio'],
      { cwd: this.options.cwd, env: this.options.env, windowsHide: true, shell: false });
    this.child = child;
    this.generation++;
    let buffer = '';
    child.stdin.on('error', () => {});
    child.stdout.on('data', (chunk) => {
      buffer += chunk;
      const lines = buffer.split(/\r?\n/);
      buffer = lines.pop() ?? '';
      for (const line of lines) {
        if (!line.trim()) continue;
        try { this.receive(JSON.parse(line)); } catch { /* Never forward raw diagnostics or secrets. */ }
      }
    });
    child.stderr.on('data', () => {});
    const fail = (cause = null) => {
      if (this.child !== child) return;
      this.child = null;
      this.starting = null;
      const failure = cause instanceof Error
        ? new Error(`Codex app-server could not start: ${cause.message}`)
        : new Error('Codex app-server disconnected');
      for (const request of this.pending.values()) request.reject(failure);
      this.pending.clear();
      this.emit('disconnected');
    };
    child.once('error', fail);
    child.once('close', () => fail());
    const result = await this.request('initialize', {
      clientInfo: { name: 'agentos_runner', title: 'AgentOS', version: '0.2.0' },
      capabilities: { experimentalApi: true },
    });
    this.write({ method: 'initialized', params: {} });
    return result;
  }

  write(message) {
    if (!this.child?.stdin.writable) throw new Error('Codex app-server is not connected');
    this.child.stdin.write(`${JSON.stringify(message)}\n`);
  }

  // Local model work has no implicit deadline. Explicit teardown requests may be bounded.
  request(method, params, timeoutMs = 0) {
    const id = ++this.sequence;
    return new Promise((resolve, reject) => {
      const timer = timeoutMs > 0 ? setTimeout(() => {
        this.pending.delete(id);
        reject(Object.assign(new Error(`Codex RPC timed out: ${method}`), { code: "CODEX_RPC_TIMEOUT", rpcMethod: method }));
      }, timeoutMs) : null;
      const finish = (fn) => (value) => { clearTimeout(timer); this.pending.delete(id); fn(value); };
      const entry = { method, resolve: finish(resolve), reject: finish(reject) };
      this.pending.set(id, entry);
      try { this.write({ id, method, params }); } catch (error) { entry.reject(error); }
    });
  }

  // Only account/read is idempotent and has no business action to replay.
  // Upstream may return its own timeout even when our RPC has no deadline.
  async readAccount({onRetry=async()=>{},retryDelayMs=1000}={}) {
    const child=this.child;let failures=0;
    for(;;){
      if(!child||this.child!==child)throw new Error('Codex app-server disconnected');
      try{return await this.request('account/read',{refreshToken:false});}
      catch(error){
        const routing=error.code==='CODEX_RPC_ERROR'&&/workspace routing discovery failed/i.test(String(error.message));
        if(error.rpcMethod!=='account/read'||error.code!=='CODEX_RPC_TIMEOUT'&&!routing)throw error;
        failures++;await onRetry({attempt:failures,stage:'account/read',code:error.code,reason:routing?'workspace_routing':'timeout'});
        await new Promise((resolve,reject)=>{
          const stop=()=>{clearTimeout(timer);this.removeListener('disconnected',stop);reject(new Error('Codex app-server stopped'));};
          const timer=setTimeout(()=>{this.removeListener('disconnected',stop);resolve();},Math.min(retryDelayMs*failures,10000));
          this.once('disconnected',stop);if(this.child!==child)stop();
        });
      }
    }
  }

  receive(message) {
    if (message.id !== undefined && !message.method) {
      const entry = this.pending.get(message.id);
      if (message.error) {
        const text=String(message.error.message??'Codex RPC failed');
        entry?.reject(Object.assign(new Error(text),{code:/timeout|timed out|ETIMEDOUT/i.test(text)?'CODEX_RPC_TIMEOUT':'CODEX_RPC_ERROR',rpcMethod:entry.method,diagnosticStage:entry.method,upstreamCode:message.error.code}));
      }
      else entry?.resolve(message.result);
    } else if (message.id !== undefined) {
      if (message.method === 'item/tool/call' && typeof this.options.onToolCall === 'function') {
        // Opt-in only: ordinary conversations keep their deny-by-default behavior.
        const child = this.child;
        Promise.resolve().then(() => this.options.onToolCall(message.params)).then(result => {
          if (this.child === child) this.write({ id: message.id, result });
        }, () => {
          if (this.child === child) this.write({ id: message.id, result: { success: false,
            contentItems: [{ type: 'inputText', text: 'Tool execution failed; reconcile recorded effects before retrying.' }] } });
        });
        return;
      }
      // Conversation process has no permission to approve tools or perform actions.
      this.write({ id: message.id, error: { code: -32601, message: 'AgentOS conversation does not authorize tool requests' } });
    } else this.emit('notification', message);
  }

  async turn(params, options = {}) {
    // These app-server turns plan decisions only; tools execute outside this call.
    return retryModelCapacity(()=>this.turnOnce(params,options),{signal:options.signal,active:()=>Boolean(this.child),
      onRetry:({attempt})=>options.onEvent?.('error',{willRetry:true,reason:'model_capacity',attempt})});
  }

  async turnOnce(params, { signal, timeoutMs = 0, onEvent } = {}) {
    if (signal?.aborted) throw new Error('Codex turn aborted');
    await waitForStart(this.start(), signal);
    return new Promise((resolve, reject) => {
      let turnId, final = '', done = false;
      const started = Date.now();
      const timing = { retries: 0 };
      const finish = (error, result) => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        this.off('notification', receive);
        this.off('disconnected', disconnected);
        signal?.removeEventListener('abort', abort);
        if (error) { error.timing = { ...timing, totalMs: Date.now() - started }; reject(error); }
        else resolve(result);
      };
      const interrupt = () => {
        if (turnId) this.request('turn/interrupt', { threadId: params.threadId, turnId }, 3000).catch(() => {});
      };
      const abort = () => { interrupt(); finish(new Error('Codex turn aborted')); };
      const disconnected = () => finish(new Error('Codex app-server disconnected'));
      const timer = timeoutMs > 0 ? setTimeout(() => { interrupt(); finish(new Error('Codex 对话超过时限，未执行任务动作')); }, timeoutMs) : null;
      const receive = ({ method, params: event = {} }) => {
        const eventTurnId = event.turnId ?? event.turn?.id;
        if (event.threadId !== params.threadId || (turnId && eventTurnId && eventTurnId !== turnId)) return;
        if (method === 'turn/started') turnId = event.turn.id;
        if (method === 'error') timing.retries += event.willRetry ? 1 : 0;
        if (['item/agentMessage/delta', 'item/reasoning/summaryTextDelta', 'item/reasoning/textDelta'].includes(method)) timing.firstOutputMs ??= Date.now() - started;
        onEvent?.(method, { elapsedMs: Date.now() - started, willRetry: event.willRetry ?? false,
          ...(event.item ? { item: { type: event.item.type, name: event.item.name, tool: event.item.tool,
            status: event.item.status } } : {}) });
        if (method === 'item/completed' && event.item?.type === 'agentMessage') final = event.item.text ?? final;
        if (method === 'turn/completed') {
          if (event.turn.status !== 'completed') return finish(new Error(event.turn.error?.message ?? `Codex turn ${event.turn.status}`));
          const message = event.turn.items?.filter((item) => item.type === 'agentMessage').at(-1);
          finish(null, { text: message?.text ?? final, threadId: params.threadId, turnId: event.turn.id,
            timing: { ...timing, totalMs: Date.now() - started } });
        }
      };
      this.on('notification', receive);
      this.on('disconnected', disconnected);
      signal?.addEventListener('abort', abort, { once: true });
      this.request('turn/start', params).then((result) => {
        turnId = result.turn.id;
        if (done) interrupt();
      }).catch((error) => finish(error));
    });
  }

  close() {
    const child = this.child;
    this.child = null;
    this.starting = null;
    for (const entry of this.pending.values()) entry.reject(new Error('Codex app-server stopped'));
    this.pending.clear();
    this.emit('disconnected');
    if (!child || child.exitCode !== null) return Promise.resolve();
    return new Promise((resolve) => {
      const timer = setTimeout(() => { child.kill(); resolve(); }, 3000);
      child.once('close', () => { clearTimeout(timer); resolve(); });
      child.stdin.end();
      child.kill();
    });
  }
}

function waitForStart(starting, signal) {
  if (!signal) return starting;
  return new Promise((resolve, reject) => {
    const abort = () => { signal.removeEventListener('abort', abort); reject(new Error('Codex turn aborted')); };
    signal.addEventListener('abort', abort, {once:true});
    starting.then(value => {signal.removeEventListener('abort',abort);resolve(value);},error => {signal.removeEventListener('abort',abort);reject(error);});
    if(signal.aborted) abort();
  });
}
