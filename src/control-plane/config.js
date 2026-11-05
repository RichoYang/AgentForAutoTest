import {retentionSettings} from '../shared/retention.js';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { validateHumanIdentities } from './authorization.js';

export function controlConfig(overrides = {}) {
  const dataDir = path.resolve(overrides.dataDir ?? process.env.AGENTOS_DATA_DIR ?? './data');
  return {
    host: overrides.host ?? process.env.AGENTOS_HOST ?? '127.0.0.1',
    port: Number(overrides.port ?? process.env.AGENTOS_PORT ?? 8787),
    dataDir,
    retention:retentionSettings(overrides.retention??{enabled:process.env.AGENTOS_RETENTION_ENABLED!=='false',days:Number(process.env.AGENTOS_RETENTION_DAYS??30),intervalMs:Number(process.env.AGENTOS_RETENTION_INTERVAL_MS??3600000)}),
    conversationFile: overrides.conversationFile ?? process.env.AGENTOS_CONVERSATION_FILE ?? './config/conversation.local.json',
    contactChannelsFile: overrides.contactChannelsFile ?? process.env.AGENTOS_CONTACT_CHANNELS_FILE ?? './config/contact-channels.local.json',
    contactsFile: overrides.contactsFile ?? process.env.AGENTOS_CONTACTS_FILE ?? './config/contacts.local.json',
    knowledgeFile: overrides.knowledgeFile ?? process.env.AGENTOS_KNOWLEDGE_FILE ?? './config/knowledge.local.json',
    memoryFile: overrides.memoryFile ?? process.env.AGENTOS_MEMORY_FILE ?? './config/memory.local.json',
    codexRuntimeFile: overrides.codexRuntimeFile ?? process.env.AGENTOS_CODEX_RUNTIME_FILE ?? './config/codex-runtime.local.json',
    storeFile: overrides.storeFile ?? path.join(dataDir, 'agentos.json'),
    projectsFile: overrides.projectsFile ?? process.env.AGENTOS_PROJECTS_FILE ?? './config/projects.local.json',
    agentsFile: overrides.agentsFile ?? process.env.AGENTOS_AGENTS_FILE ?? './config/agents.local.json',
    adminToken: overrides.adminToken ?? process.env.AGENTOS_ADMIN_TOKEN ?? '',
    runnerToken: overrides.runnerToken ?? process.env.AGENTOS_RUNNER_TOKEN ?? '',
    feishu: {
      transport: overrides.feishu?.transport ?? process.env.FEISHU_TRANSPORT ?? 'openapi',
      appId: overrides.feishu?.appId ?? process.env.FEISHU_APP_ID ?? '',
      appSecret: overrides.feishu?.appSecret ?? process.env.FEISHU_APP_SECRET ?? '',
      verificationToken: overrides.feishu?.verificationToken ?? process.env.FEISHU_VERIFICATION_TOKEN ?? '',
      cliEntry: overrides.feishu?.cliEntry ?? process.env.LARK_CLI_ENTRY ?? '',
    },
  };
}

export async function loadAgents(file) {
  try {
    const parsed = JSON.parse(await readFile(path.resolve(file), 'utf8'));
    return { agents: parsed.agents ?? {} };
  } catch (error) {
    if (error.code === 'ENOENT') return { agents: {} };
    throw error;
  }
}

export async function loadProjects(file) {
  try {
    const parsed = JSON.parse(await readFile(path.resolve(file), 'utf8'));
    return {
      ownerOpenIds: parsed.ownerOpenIds ?? [],
      ownerOpenIdsByProfile: parsed.ownerOpenIdsByProfile ?? {},
      humanIdentities: validateHumanIdentities(parsed.humanIdentities ?? {}),
      chatProjectMap: parsed.chatProjectMap ?? {},
      ...chatDeliverySettings(parsed),
      projects: parsed.projects ?? {},
    };
  } catch (error) {
    if (error.code === 'ENOENT') return { ownerOpenIds: [], ownerOpenIdsByProfile: {}, chatProjectMap: {}, projects: {} };
    throw error;
  }
}

export async function saveProjects(file, projects) {
  const target = path.resolve(file);
  await mkdir(path.dirname(target), { recursive: true });
  const temporary = `${target}.${process.pid}.tmp`;
  await writeFile(temporary, `${JSON.stringify(projects, null, 2)}\n`, 'utf8');
  await rename(temporary, target);
}

function chatDeliverySettings(value) {
  const result = {};
  for (const key of ['topicChatIds', 'retiredChatIds', 'messageExcludedChatIds']) {
    if (value[key] === undefined) continue;
    if (!Array.isArray(value[key]) || value[key].some(id => typeof id !== 'string' || !id.trim())) throw new Error('Invalid chat delivery settings');
    result[key] = [...new Set(value[key])];
  }
  if (result.topicChatIds?.some(id => result.retiredChatIds?.includes(id))) throw new Error('A topic chat cannot also be retired');
  return result;
}
