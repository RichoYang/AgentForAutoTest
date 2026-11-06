import { access, mkdir, readFile, readdir, rename, stat, writeFile } from 'node:fs/promises';
import { constants } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const localFile = fileURLToPath(new URL('../../config/codex-runtime.local.json', import.meta.url));
export const CODEX_MODELS = [
  { id: 'gpt-6-astra', label: 'GPT-6 Astra', description: '复杂排查与高要求交付' },
  { id: 'gpt-5.6-sol', label: 'GPT-5.6 Sol', description: '日常开发与稳定执行' },
  { id: 'gpt-5.6-terra', label: 'GPT-5.6 Terra', description: '速度与能力均衡' },
  { id: 'gpt-5.6-luna', label: 'GPT-5.6 Luna', description: '快速、轻量的日常任务' },
  { id: 'gpt-5.5', label: 'GPT-5.5', description: '上一代稳定模型' },
];
export const CODEX_REASONING_EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max', 'ultra'];

async function readLocal(file = localFile) {
  try { return JSON.parse(await readFile(file, 'utf8')); }
  catch (error) { if (error.code === 'ENOENT') return {}; throw error; }
}

export async function loadCodexRuntimeSettings(options = {}) {
  const local = await readLocal(options.file ?? localFile);
  const model = options.model ?? process.env.AGENTOS_CODEX_MODEL ?? local.model ?? null;
  const reasoningEffort = options.reasoningEffort ?? process.env.AGENTOS_CODEX_REASONING_EFFORT ?? local.reasoningEffort ?? null;
  validateRuntimeSelection({ model, reasoningEffort });
  return { model, reasoningEffort };
}

export async function saveCodexRuntimeSettings(selection, options = {}) {
  const file = options.file ?? localFile;
  const current = await readLocal(file);
  const model = selection.model || null;
  const reasoningEffort = selection.reasoningEffort || null;
  validateRuntimeSelection({ model, reasoningEffort });
  const next = { ...current };
  if (model) next.model = model; else delete next.model;
  if (reasoningEffort) next.reasoningEffort = reasoningEffort; else delete next.reasoningEffort;
  await mkdir(path.dirname(file), { recursive: true });
  const temporary = `${file}.${process.pid}.tmp`;
  await writeFile(temporary, `${JSON.stringify(next, null, 2)}\n`, 'utf8');
  await rename(temporary, file);
  return { model, reasoningEffort };
}

export function codexRuntimeArgs(settings = {}) {
  return [
    ...(settings.model ? ['--model', settings.model] : []),
    ...(settings.reasoningEffort ? ['-c', `model_reasoning_effort=${JSON.stringify(settings.reasoningEffort)}`] : []),
  ];
}

function validateRuntimeSelection({ model, reasoningEffort }) {
  if (model !== null && (typeof model !== 'string' || !/^[a-z0-9][a-z0-9._-]{1,79}$/i.test(model))) {
    throw new Error('Invalid Codex model');
  }
  if (reasoningEffort !== null && !CODEX_REASONING_EFFORTS.includes(reasoningEffort)) {
    throw new Error('Invalid Codex reasoning effort');
  }
}

export async function resolveCodexBinary(explicit, options = {}) {
  if (explicit && explicit !== 'codex') return explicit;
  if (process.env.CODEX_BIN && process.env.CODEX_BIN !== 'codex') return process.env.CODEX_BIN;
  const local = await readLocal(localFile);
  if (local.codexBin && local.codexBin !== 'codex') {
    try { if ((await stat(local.codexBin)).isFile()) return local.codexBin; }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
  const platform=options.platform??process.platform;
  return (platform==='win32'?await discoverWindowsCodexBinary(options.discoveryRoot):null)
    || (platform==='darwin'?await discoverMacCodexBinary(options.macDiscoveryRoot,options):null)
    || 'codex';
}

export async function discoverMacCodexBinary(root = null,{accessFile=access}={}) {
  if (!root && process.platform !== 'darwin') return null;
  const resources = root || '/Applications/ChatGPT.app/Contents/Resources';
  const candidates = [
    path.join(resources, 'codex-cli', 'CodexCLI.app', 'Contents', 'MacOS', 'codex'),
    path.join(resources, 'codex'),
  ];
  for (const candidate of candidates) {
    try {
      if ((await stat(candidate)).isFile()) {
        await accessFile(candidate, constants.X_OK);
        return candidate;
      }
    } catch (error) {
      if (!['ENOENT', 'EACCES'].includes(error.code)) throw error;
    }
  }
  return null;
}

export async function discoverWindowsCodexBinary(root = null) {
  if (!root && process.platform !== 'win32') return null;
  const localAppData = process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local');
  const binRoot = root || path.join(localAppData, 'OpenAI', 'Codex', 'bin');
  let entries;
  try { entries = await readdir(binRoot, { withFileTypes: true }); }
  catch (error) { if (error.code === 'ENOENT') return null; throw error; }
  const candidates = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const candidate = path.join(binRoot, entry.name, 'codex.exe');
    try {
      const details = await stat(candidate);
      if (details.isFile()) candidates.push({ path: candidate, modified: details.mtimeMs });
    } catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
  return candidates.sort((a, b) => b.modified - a.modified)[0]?.path ?? null;
}

// Scoped only to Codex children. Never changes Windows, Feishu, model or auth.
export async function codexEnvironment(options = {}) {
  const local = await readLocal(options.file ?? localFile);
  const proxyConfigured = Object.hasOwn(options, 'proxyUrl')
    || process.env.AGENTOS_CODEX_PROXY_URL !== undefined || Object.hasOwn(local, 'proxyUrl');
  const proxy = options.proxyUrl ?? process.env.AGENTOS_CODEX_PROXY_URL ?? local.proxyUrl;
  const env = { ...process.env };
  if (proxy) {
    const url = new URL(proxy);
    if (!['http:', 'https:', 'socks5h:'].includes(url.protocol) || url.username || url.password) {
      throw new Error('Codex proxy must use http/https/socks5h without embedded credentials');
    }
    env.HTTPS_PROXY = proxy;
    env.HTTP_PROXY = proxy;
    env.ALL_PROXY = proxy;
    env.NO_PROXY = 'localhost,127.0.0.1,::1';
  } else if (proxyConfigured) {
    for (const key of ['HTTPS_PROXY', 'HTTP_PROXY', 'ALL_PROXY', 'https_proxy', 'http_proxy', 'all_proxy']) delete env[key];
  }
  return env;
}

export function conversationServerArgs() {
  return ['app-server', '--stdio',
    '-c', 'features.plugins=false', '-c', 'features.apps=false',
    '-c', 'features.shell_tool=false', '-c', 'features.multi_agent=false',
    '-c', 'features.browser_use=false', '-c', 'features.computer_use=false',
    '-c', 'features.image_generation=false', '-c', 'web_search="disabled"',
    '-c', 'features.unbounded_connection_retries=false'];
}
