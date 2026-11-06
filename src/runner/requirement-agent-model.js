import { CodexAppServer } from '../shared/codex-app-server.js';
import { resolveCodexBinary, codexEnvironment, loadCodexRuntimeSettings } from '../shared/codex-runtime.js';

// The same app-server transport as conversations, with explicitly scoped host tools.
// No shell, arbitrary network, apps or inherited MCP tools can bypass the ledger.
export async function requirementAgentModel({ cwd, codexBin, instructions, tools, call, progress = async () => {}, onThread = async () => {}, onDiagnostic = async () => {} }) {
  const runtime = await loadCodexRuntimeSettings({ file: process.env.AGENTOS_CODEX_RUNTIME_FILE });
  let threadId;
  let turnAbort, fatalError;
  let calls = Promise.resolve();
  let diagnostics = Promise.resolve();
  const appOptions = { codexBin: await resolveCodexBinary(codexBin), cwd, env: await codexEnvironment(),
    args: ['app-server', '--stdio',
      '-c', 'mcp_servers={}',
      '-c', 'features.shell_tool=false', '-c', 'features.apps=false', '-c', 'features.plugins=false',
      '-c', 'features.multi_agent=false', '-c', 'features.browser_use=false', '-c', 'features.computer_use=false',
      '-c', 'features.image_generation=false', '-c', 'features.js_repl=false', '-c', 'features.skip_host_skill_discovery=true',
      '-c', 'web_search="disabled"'],
    onToolCall(params) {
      const run = async () => {
        if (fatalError) return { success: false, contentItems: [{ type: 'inputText', text: JSON.stringify({ error: fatalError.code, message: fatalError.safeMessage }) }] };
        if (params.threadId !== threadId || !tools.some(tool => tool.name === params.tool)) throw new Error('Tool identity mismatch');
        await progress('工具：' + params.tool);
        try {
          const value = await call(params.tool, params.arguments, params.callId);
          return { success: true, contentItems: [{ type: 'inputText', text: JSON.stringify(value) }] };
        } catch (error) {
          if (error.code === 'agent_no_progress') { fatalError = error; turnAbort?.abort(); }
          return { success: false, contentItems: [{ type: 'inputText', text: JSON.stringify({ error: error.code ?? error.name,
            message: error.safeMessage ?? '工具调用未完成，查看已保存的诊断并核对副作用后修正参数。', gap: error.gap }) }] };
        }
      };
      // A native tool can expose an intentional concurrent operation as one ledgered batch.
      const response = calls.then(run);
      calls = response.catch(() => {});
      return response;
    },
  };
  let app = new CodexAppServer(appOptions);
  try {
    await app.start();
    // TOML config overlays merge tables: mcp_servers={} does NOT remove inherited
    // servers. Disable each effective server explicitly before creating a thread.
    const configured = await app.request('config/read', { cwd, includeLayers: false });
    const inherited = Object.keys(configured.config.mcp_servers ?? {});
    if (inherited.length) {
      await app.close();
      const disabled = 'mcp_servers={' + inherited.map(name => JSON.stringify(name) + '={enabled=false}').join(',') + '}';
      app = new CodexAppServer({ ...appOptions, args: [...appOptions.args, '-c', disabled] });
      await app.start();
    }
    const effective = await app.request('config/read', { cwd, includeLayers: false });
    const servers = Object.entries(effective.config.mcp_servers ?? {});
    if (servers.some(([, server]) => server.enabled !== false)) throw new Error('Inherited MCP tools could bypass the requirement ledger');
    await onDiagnostic({ method: 'capability_boundary', disabledMcpServers: servers.map(([name]) => name),
      shell: effective.config.features?.shell_tool, apps: effective.config.features?.apps, plugins: effective.config.features?.plugins });
    const started = await app.request('thread/start', { cwd, approvalPolicy: 'never', sandbox: 'read-only',
      model: runtime.model, ephemeral: true, dynamicTools: tools.map(tool => ({ type: 'function', ...tool })),
      config: { ...(runtime.reasoningEffort ? { model_reasoning_effort: runtime.reasoningEffort } : {}) },
      baseInstructions: instructions });
    threadId = started.thread.id;
    await onThread({ threadId, model: runtime.model, reasoningEffort: runtime.reasoningEffort });
    return {
      async turn(text) {
        turnAbort = new AbortController();
        const result = await app.turn({ threadId, effort: runtime.reasoningEffort ?? 'high', input: [{ type: 'text', text }] }, {
          signal: turnAbort.signal,
          onEvent: (method, details) => {
            if (method === 'item/started') progress('模型正在调查或执行');
            if (['item/started', 'item/completed', 'error', 'turn/completed'].includes(method)) {
              diagnostics = diagnostics.then(() => onDiagnostic({ method, ...details }));
            }
          },
        }).catch(error => { throw fatalError ?? error; });
        await calls;
        await diagnostics;
        return result;
      },
      async close() { await calls; await diagnostics; await app.close(); },
      threadId,
    };
  } catch (error) { await app.close(); throw error; }
}
