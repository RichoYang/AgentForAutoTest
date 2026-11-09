import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createControlPlane } from '../src/control-plane/server.js';

async function config(t, env, concurrency) {
  const previous = process.env.AGENTOS_CONVERSATION_CONCURRENCY;
  if (env === undefined) delete process.env.AGENTOS_CONVERSATION_CONCURRENCY;
  else process.env.AGENTOS_CONVERSATION_CONCURRENCY = env;
  t.after(() => {
    if (previous === undefined) delete process.env.AGENTOS_CONVERSATION_CONCURRENCY;
    else process.env.AGENTOS_CONVERSATION_CONCURRENCY = previous;
  });
  const dataDir = await mkdtemp(path.join(os.tmpdir(), 'agentos-conversation-concurrency-'));
  const conversationFile = path.join(dataDir, 'conversation.json');
  await writeFile(conversationFile, JSON.stringify({ groupSessions: false, questionCards: false, concurrency }));
  return { dataDir, conversationFile, projects: { projects: {}, chatProjectMap: {} }, agents: { agents: {} },
    feishuClient: { reply: async () => ({ message_id: 'fixture-reply' }) } };
}

for (const { env, file, override, expected, source } of [
  { env: '1', file: 2, expected: 1, source: 'environment' },
  { env: '1', file: 3, override: 2, expected: 2, source: 'override' },
  { file: 2, expected: 2, source: 'file' },
  { expected: 3, source: 'default' },
]) test('conversation concurrency uses ' + source + ' and holds that many actual workers', { timeout: 15000 }, async t => {
  const options = await config(t, env, file);
  let active = 0, peak = 0;
  const reached = Promise.withResolvers();
  const unblock = Promise.withResolvers();
  const app = await createControlPlane({ ...options, conversationOptions: { concurrency: override }, conversationResponder: async () => {
    peak = Math.max(peak, ++active);
    if (active === expected) reached.resolve();
    await unblock.promise;
    active--;
    return { action: 'reply', intent: 'none', reply: 'done', instruction: '', projectId: '', jobId: '', attachmentIds: [] };
  } });
  try {
    await new Promise(resolve => app.server.listen(0, '127.0.0.1', resolve));
    const health = await (await fetch(`http://127.0.0.1:${app.server.address().port}/health`)).json();
    assert.equal(health.conversationConcurrency, expected);
    assert.equal(health.conversationConcurrencySource, source);
    assert.equal(health.runnerConcurrency, Number(process.env.AGENTOS_RUNNER_CONCURRENCY ?? 3));
    await app.conversations.idle();
    const wake = app.conversations.wake;
    app.conversations.wake = () => {};
    try {
      for (let i = 0; i < 4; i++) await app.conversations.enqueue({ message_id: 'msg-' + i,
        chat_id: 'chat', chat_type: 'group', sender_id: 'sender-' + i, content: 'Isolated question' });
    } finally { app.conversations.wake = wake; }
    app.conversations.wake();
    await reached.promise;
    assert.equal(app.conversations.workers.size, expected);
    const state = await app.store.read();
    assert.equal(state.conversations.filter(turn => turn.status === 'thinking').length, expected);
    assert.equal(state.conversations.filter(turn => turn.status === 'queued').length, 4 - expected);
    unblock.resolve();
    await app.conversations.idle();
    assert.equal(peak, expected);
    assert.equal((await app.store.read()).conversations.filter(turn => turn.status === 'sent').length, 4);
  } finally {
    unblock.resolve();
    if (app.server.listening) await new Promise(resolve => app.server.close(resolve));
    await app.conversations.stop();
    await app.cards.stop();
    await rm(options.dataDir, { recursive: true, force: true });
  }
});

test('invalid conversation concurrency fails before startup with the winning source', async t => {
  const options = await config(t, '0', 3);
  t.after(() => rm(options.dataDir, { recursive: true, force: true }));
  await assert.rejects(createControlPlane(options), /Invalid conversation concurrency from environment.*AGENTOS_CONVERSATION_CONCURRENCY/);
  await assert.rejects(createControlPlane({ ...options, conversationOptions: { concurrency: 1.5 } }), /Invalid conversation concurrency from override/);
  delete process.env.AGENTOS_CONVERSATION_CONCURRENCY;
  await writeFile(options.conversationFile, JSON.stringify({ groupSessions: false, questionCards: false, concurrency: '2' }));
  await assert.rejects(createControlPlane(options), /Invalid conversation concurrency from file/);
});
