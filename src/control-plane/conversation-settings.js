import { readFile } from 'node:fs/promises';
export async function loadConversationSettings(file) {
  let value;
  try { value = JSON.parse(await readFile(file, 'utf8')); }
  catch (error) { if (error.code === 'ENOENT') return { groupSessions: false, questionCards: false }; throw error; }
  if (typeof value.groupSessions !== 'boolean' || typeof value.questionCards !== 'boolean') throw new Error('Invalid conversation configuration');
  const concurrency = Object.hasOwn(value, 'concurrency') ? { concurrency: value.concurrency } : {};
  const watch=value.editedMentions;
  if(watch && (typeof watch.enabled!=='boolean' || !Array.isArray(watch.profiles) || watch.profiles.some(x=>typeof x!=='string')
    || !Number.isInteger(watch.intervalMs) || watch.intervalMs<15000 || watch.intervalMs>300000
    || !Number.isInteger(watch.lookbackMinutes) || watch.lookbackMinutes<1 || watch.lookbackMinutes>1440)) throw new Error('Invalid edited mentions configuration');
  return { groupSessions: value.groupSessions, questionCards: value.questionCards, ...concurrency, ...(watch?{editedMentions:watch}:{}) };
}

export function resolveConversationConcurrency(override, configured, environment = process.env.AGENTOS_CONVERSATION_CONCURRENCY) {
  const source = override !== undefined ? 'override' : environment !== undefined ? 'environment' : configured !== undefined ? 'file' : 'default';
  const value = { override, environment, file: configured, default: 3 }[source];
  const concurrency = source === 'environment' && /^\d+$/.test(value) ? Number(value) : value;
  if (!Number.isSafeInteger(concurrency) || concurrency < 1) {
    throw new Error('Invalid conversation concurrency from ' + source + ': expected a positive safe integer'
      + (source === 'environment' ? ' in AGENTOS_CONVERSATION_CONCURRENCY' : ' in concurrency'));
  }
  return { concurrency, source };
}
