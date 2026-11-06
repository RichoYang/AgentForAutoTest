import { readFile, rename, mkdir } from 'node:fs/promises';
import {writePrivateFile} from '../shared/private-files.js';
import path from 'node:path';
import { createHash } from 'node:crypto';

export const MEMORY_DEFAULTS = Object.freeze({ enabled: true, recentTurns: 20, summaryEveryTurns: 10,
  summaryItems: 12, retrievalItems: 8, historyBudgetTokens: 12000, inputBudgetTokens: 24000,
  systemReserveTokens: 6000, outputReserveTokens: 4000 });
export function memorySettings(value = {}) {
  const result = { ...MEMORY_DEFAULTS, ...value };
  if (typeof result.enabled !== 'boolean') throw new Error('Invalid memory.enabled');
  for (const key of Object.keys(MEMORY_DEFAULTS).filter((key) => key !== 'enabled')) {
    if (!Number.isInteger(result[key]) || result[key] < 1 || result[key] > 100000) throw new Error(`Invalid memory.${key}`);
  }
  if (result.recentTurns > 100 || result.summaryItems > 40 || result.retrievalItems > 30
    || result.inputBudgetTokens <= result.systemReserveTokens + result.outputReserveTokens + 1000) throw new Error('Invalid memory budget');
  return result;
}
export async function loadMemorySettings(file) {
  try { return memorySettings(JSON.parse(await readFile(file, 'utf8'))); }
  catch (error) { if (error.code === 'ENOENT') return memorySettings(); throw error; }
}
export const fingerprint = (value) => createHash('sha256').update(typeof value === 'string' ? value : JSON.stringify(value)).digest('hex');
// Deliberately conservative UTF-8 byte budget, NOT the model tokenizer or its context-window size.
export const estimateTokens = (value) => Buffer.byteLength(typeof value === 'string' ? value : JSON.stringify(value), 'utf8');
export const memoryScope = (turn, projectId) => fingerprint([projectId ?? null, turn.chatId, turn.profile ?? null, turn.senderId]);
export function memoryProject(turn) {
  if (Object.hasOwn(turn, 'projectId')) return turn.projectId;
  try { const key = JSON.parse(turn.sessionKey); return Array.isArray(key) && key.length === 5 ? key[4] : undefined; } catch { return undefined; }
}
export const clean = (text) => String(text ?? '').replace(/(?:ou|oc)_[a-z0-9]+/gi, '[private-id]')
  .replace(/\b(?:sk-[a-z0-9_-]{16,}|Bearer\s+[a-z0-9._-]+)\b/gi, '[secret]')
  .replace(/((?:app[_ -]?secret|access[_ -]?token|refresh[_ -]?token|password)\s*["']?\s*[:=]\s*["']?)[^\s,"'}]+/gi, '$1[secret]');
const snippet = (text, size = 500) => clean(text).slice(0, size);
export function terms(text) {
  const normalized = clean(text).normalize('NFKC').toLowerCase();
  const found = normalized.match(/[a-z0-9][a-z0-9_.-]*/g) ?? [];
  for (const run of normalized.match(/[\p{Script=Han}]+/gu) ?? []) {
    if (run.length === 1) found.push(run);
    for (let i = 0; i < run.length - 1; i++) found.push(run.slice(i, i + 2));
  }
  return [...new Set(found)].slice(0, 256);
}

// Filter BEFORE ranking. No implicit cross-person/profile/group/project sharing, including administrators.
export function memorySources(state, turn, projectId, suppressed = new Set()) {
  const conversations = (state.conversations ?? []).filter((item) => item.visibility!=='requester' && item.id !== turn.id && item.status === 'sent'
    && item.chatId === turn.chatId && (item.profile ?? null) === (turn.profile ?? null)
    && item.senderId === turn.senderId && memoryProject(item) === projectId && !suppressed.has(`conversation:${item.id}`));
  const ids = new Set(conversations.flatMap((item) => [item.id, item.messageId]).filter(Boolean));
  const sources = conversations.map((item) => ({ ref: `conversation:${item.id}`, recordedAt: item.completedAt ?? item.createdAt,
    text: `用户陈述：${clean(item.content)}\n当时回复（模型陈述）：${clean(item.response)}`,
    receiptOnly: Boolean(item.outcome?.jobId || item.outcome?.nextJobId),
    evidence: { applicability: 'historical_conversation_not_current_fact', requiresRecheckForCurrentSource: true } }));
  for (const job of state.jobs ?? []) {
    if (job.visibility==='requester' || job.environmentAccess || job.chatId !== turn.chatId || job.projectId !== projectId || (job.originProfile ?? null) !== (turn.profile ?? null)
      || !(ids.has(job.originMessageId) || ids.has(job.sourceMessageId))
      || !['completed', 'cancelled', 'failed', 'blocked'].includes(job.status)) continue;
    sources.push({ ref: `job:${job.id}`, recordedAt: job.updatedAt ?? job.createdAt,
      text: `历史任务：${clean(job.instruction)}\n当时结果：${clean(job.result?.summary)}\n${clean(job.result?.finalMessage)}`,
      evidence: { statusAtRecording: job.status, outcome: job.result?.outcome ?? null,
        risks: (job.result?.handoff?.risks ?? []).map((item) => snippet(item, 300)),
        sourceSync: job.result?.sourceSync ? { checkedAt: job.result.sourceSync.checkedAt,
          repositories: job.result.sourceSync.repositories?.map(({ path, branch, commit }) => ({ path, branch, commit })) } : null,
        applicability: 'historical_snapshot_not_current_check', requiresRecheckForCurrentSource: true } });
  }
  sources.sort((a, b) => String(a.recordedAt ?? '').localeCompare(String(b.recordedAt ?? '')));
  return sources.map((item) => ({ ...item, hash: fingerprint(item) }));
}
const excerpt = (source, queryTerms = []) => {
  const lower = source.text.toLowerCase();
  const match = queryTerms.map((term) => lower.indexOf(term)).filter((index) => index >= 0);
  const start = match.length ? Math.max(0, Math.min(...match) - 100) : 0;
  return { ref: source.ref, sourceHash: source.hash, recordedAt: source.recordedAt,
    excerpt: source.text.slice(start, start + 600), truncated: source.text.length > 600,
    receiptOnly: source.receiptOnly ?? false, evidence: source.evidence };
};

export class MemoryService {
  constructor({ dataDir, settings = {} }) {
    this.settings = memorySettings(settings);
    this.file = path.join(dataDir, 'memory.json');
    this.queue = Promise.resolve();
    this.status = this.settings.enabled ? 'ready' : 'disabled';
  }
  async read() {
    try {
      const value = JSON.parse(await readFile(this.file, 'utf8'));
      if (value.version !== 1 || !value.scopes || !value.tombstones || typeof value.scopes !== 'object'
        || typeof value.tombstones !== 'object') throw new Error('Invalid memory cache');
      return value;
    } catch (error) {
      if (error.code === 'ENOENT') return { version: 1, scopes: {}, tombstones: {} };
      // Never overwrite a damaged cache: it might contain suppression tombstones.
      throw error;
    }
  }
  async write(value) {
    await mkdir(path.dirname(this.file), { recursive: true });
    const tmp = `${this.file}.${process.pid}.tmp`;
    await writePrivateFile(tmp, JSON.stringify(value));
    await rename(tmp, this.file);
  }
  serial(operation) {
    const pending = this.queue.then(operation);
    this.queue = pending.catch(() => {});
    return pending;
  }
  async prune(cutoff, refs) {
    return this.serial(async()=>{try{if((await (await import('node:fs/promises')).lstat(this.file)).isSymbolicLink())throw new Error('Invalid memory file');}catch(e){if(e.code!=='ENOENT')throw e;}const cache=await this.read(),before=JSON.stringify(cache);let removed=0;
      for(const [key,scope] of Object.entries(cache.scopes))if(Date.parse(scope.updatedAt)<cutoff||scope.items?.some(item=>Date.parse(item.recordedAt)<cutoff&&!refs.has(item.ref))){delete cache.scopes[key];removed++;}
      for(const [key,items]of Object.entries(cache.tombstones)){cache.tombstones[key]=items.filter(ref=>refs.has(ref));if(!cache.tombstones[key].length)delete cache.tombstones[key];}
      if(JSON.stringify(cache)!==before)await this.write(cache);return removed;
    });
  }
  async retrieve(state, turn, projectId) {
    if (!this.settings.enabled) return { enabled: false };
    return this.serial(async () => {
      try {
        const cache = await this.read(), key = memoryScope(turn, projectId);
        const suppressed = new Set(cache.tombstones[key] ?? []);
        const sources = memorySources(state, turn, projectId, suppressed).filter((item) => !suppressed.has(item.ref));
        const byRef = new Map(sources.map((item) => [item.ref, item]));
        const old = cache.scopes[key];
        const valid = old?.items?.every((item) => byRef.get(item.ref)?.hash === item.sourceHash);
        const changed = fingerprint(sources.map(({ ref, hash }) => [ref, hash]));
        const pressure = estimateTokens(sources.slice(-this.settings.recentTurns).map(({ text }) => text)) > this.settings.historyBudgetTokens;
        const refresh = !old || !valid || (changed !== old.sourceFingerprint
          && (Math.abs(sources.length - old.sourceCount) >= this.settings.summaryEveryTurns || pressure));
        if (refresh) {
          // Extractive digest: newest bounded source excerpts. No invented facts or model/network call.
          const items = sources.filter((source) => !source.receiptOnly).slice(-this.settings.summaryItems).map((source) => excerpt(source));
          cache.scopes[key] = { kind: 'extractive-digest-v1', updatedAt: new Date().toISOString(),
            sourceCount: sources.length, sourceFingerprint: changed, items };
          await this.write(cache); // Cursor/fingerprint advances only after atomic persistence.
        }
        const queryTerms = terms(turn.content);
        const matches = sources.map((source, index) => ({ source, index,
          score: queryTerms.reduce((score, term) => score + (source.text.toLowerCase().includes(term) || source.ref.toLowerCase().includes(term) ? term.length : 0), 0) }))
          .filter((item) => item.score > 0).sort((a, b) => b.score - a.score || b.index - a.index)
          .slice(0, this.settings.retrievalItems).map(({ source }) => excerpt(source, queryTerms));
        this.status = 'ready';
        return { enabled: true, available: true, policy: 'scoped-extractive-memory-v1',
          trust: 'untrusted_historical_material_not_authorization', summary: cache.scopes[key], matches,
          searchedSources: sources.length, suppressedSources: suppressed.size, suppressedRefs: [...suppressed],
          completeRecall: false, currentSourceRequiresNewAnalysis: true };
      } catch {
        this.status = 'degraded';
        return { enabled: true, available: false, reason: 'memory_unavailable', completeRecall: false };
      }
    });
  }
  async forget(turn, projectId, refs) {
    return this.serial(async () => {
      const cache = await this.read(), key = memoryScope(turn, projectId);
      cache.tombstones[key] = [...new Set([...(cache.tombstones[key] ?? []), ...refs])];
      delete cache.scopes[key];
      await this.write(cache);
    });
  }
}

export function fitContext(input, settings = MEMORY_DEFAULTS) {
  const budget = settings.inputBudgetTokens - settings.systemReserveTokens - settings.outputReserveTokens - 512; // reserve budget metadata
  const derivedSize = () => estimateTokens({ history: input.history, jobs: input.jobs, memory: input.memory });
  let trimmed = false;
  while (estimateTokens(input) > budget || derivedSize() > settings.historyBudgetTokens) {
    if (input.history.length > 1) input.history.shift();
    else if (input.jobs.length) input.jobs.shift();
    else if (input.memory?.summary?.items?.length) input.memory.summary.items.shift();
    else if (input.memory?.matches?.length) input.memory.matches.pop();
    else if (input.teamKnowledge?.candidates?.length) input.teamKnowledge.candidates.pop();
    else if (input.history.length) input.history.shift();
    else throw new Error('Current message and required context exceed configured input budget');
    trimmed = true;
  }
  if (input.memory) input.memory.budget = { estimator: 'utf8-bytes-conservative-v1', trimmed,
    estimatedInputTokens: estimateTokens(input), inputLimit: settings.inputBudgetTokens,
    systemReserve: settings.systemReserveTokens, outputReserve: settings.outputReserveTokens };
  return input;
}
