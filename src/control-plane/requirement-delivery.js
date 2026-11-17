import { createHash } from 'node:crypto';
import { hashFile } from '../shared/file-digest.js';
import { reportFile } from '../shared/report-files.js';
import { messageIdOf } from './live-cards.js';

// One durable outbox for the conclusion and every artifact. Lost send receipts
// reuse the exact same idempotency key. Known messages are read again, not resent.
export async function deliverRequirementBundle(context, key) {
  const { store, feishu, config } = context;
  let state = await store.read(), entry = state.requirementDeliveries[key];
  if (!entry || entry.superseded) return;
  if (entry.verified) return entry.receipt;
  const eligible = snapshot => !Array.isArray(snapshot.jobs) || snapshot.jobs.some(job => job.id === entry.jobId
    && job.status === 'completed' && job.result?.outcome === 'ready' && job.result.requirementDelivery?.version === entry.version
    && JSON.stringify(job.result.requirementDelivery.artifacts.map(item => item.sha256)) === JSON.stringify(entry.parts.filter(part => part.artifact).map(part => part.artifact.sha256)));
  if (!eligible(state)) { await store.transact(s => { s.requirementDeliveries[key].superseded = true; }); return; }
  const destination = entry.destination;
  const options = { profile: destination.profile, replyInThread: true };
  const root = await feishu.readMessage(destination.rootId, options);
  if (root.chat_id !== destination.chatId || root.message_id !== destination.rootId) throw new Error('Delivery root mismatch');
  for (const [index, part] of entry.parts.entries()) {
    state = await store.read(); entry = state.requirementDeliveries[key];
    if (!eligible(state)) { await store.transact(s => { s.requirementDeliveries[key].superseded = true; }); return; }
    const saved = entry.parts[index];
    if (saved.verified) continue;
    const idempotencyKey = 'aos-chain-' + createHash('sha256').update(key + ':' + index).digest('hex').slice(0, 32);
    let file;
    if (part.artifact) file = (await reportFile(config.dataDir, entry.jobId, part.artifact, { includeContent: false })).file;
    if (!saved.messageId) {
      await store.transact(s => Object.assign(s.requirementDeliveries[key].parts[index], { intentAt: new Date().toISOString(), idempotencyKey }));
      const result = part.text !== undefined
        ? await feishu.reply(destination.rootId, part.text, { ...options, idempotencyKey })
        : await feishu.replyFile(destination.rootId, file, { ...options, idempotencyKey });
      const messageId = messageIdOf(result);
      if (!messageId) throw new Error('Missing send receipt');
      await store.transact(s => Object.assign(s.requirementDeliveries[key].parts[index], { messageId, sentAt: new Date().toISOString() }));
      saved.messageId = messageId;
    }
    const message = await feishu.readMessage(saved.messageId, options);
    if (message.chat_id !== destination.chatId || message.root_id !== destination.rootId || message.deleted
      || root.thread_id && message.thread_id !== root.thread_id
      || message.sender?.sender_type !== 'app' || ![destination.appId, destination.openId].includes(message.sender.id)) throw new Error('Delivery identity/thread mismatch');
    const content = JSON.parse(message.body?.content ?? '{}');
    let readback;
    if (part.text !== undefined) {
      if (content.text !== part.text) throw new Error('Conclusion readback is incomplete');
      readback = { bodyHash: createHash('sha256').update(content.text).digest('hex') };
    } else {
      if (!content.file_key || content.file_name !== part.artifact.filename) throw new Error('Attachment readback mismatch');
      const remote = await feishu.downloadMessageResource(entry.jobId, saved.messageId, content.file_key, 'file', options);
      if (await hashFile(remote.path) !== part.artifact.sha256) throw new Error('Attachment bytes mismatch');
      readback = { fileKey: content.file_key, sha256: part.artifact.sha256 };
    }
    await store.transact(s => Object.assign(s.requirementDeliveries[key].parts[index], { verified: true,
      readback: { ...readback, at: new Date().toISOString(), rootId: message.root_id, threadId: message.thread_id,
        sender: message.sender, messageId: saved.messageId }, link: 'https://applink.feishu.cn/client/message/open?message_id=' + encodeURIComponent(saved.messageId) }));
  }
  return store.transact(s => {
    const e = s.requirementDeliveries[key]; e.verified = e.parts.every(part => part.verified); e.verifiedAt = new Date().toISOString();
    e.receipt = { verified: e.verified, version: e.version, verifiedAt: e.verifiedAt,
      messages: e.parts.map(part => ({ messageId: part.messageId, link: part.link, sha256: part.artifact?.sha256, readback: part.readback })) };
    const job = s.jobs?.find(job => job.id === e.jobId);
    if (job && job.result?.requirementDelivery?.version === e.version) job.requirementDeliveryReceipt = e.receipt;
    return e.receipt;
  });
}

export async function enqueueRequirementBundle(context, job) {
  const bundle = job.result?.requirementDelivery;
  if (!bundle || job.status !== 'completed' || job.result?.outcome !== 'ready') return false;
  const settings = context.projects?.projects?.[job.projectId]?.requirementTest ?? context.config.projects?.[job.projectId]?.requirementTest;
  if (!settings || settings.bot.profile !== job.agentProfile || !settings.allowedChatIds.includes(job.chatId)) throw new Error('Requirement delivery binding mismatch');
  const key = job.id + ':' + bundle.version + ':' + bundle.artifacts.map(item => item.sha256).join(':');
  await context.store.transact(state => {
    state.requirementDeliveries ??= {};
    state.requirementDeliveries[key] ??= { jobId: job.id, version: bundle.version,
      destination: { rootId: job.requirement.rootMessageId ?? (job.requirement.root?.startsWith('omt_') ? job.originMessageId : job.requirement.root), chatId: job.chatId, ...settings.bot },
      parts: [{ text: bundle.text }, ...bundle.artifacts.map(artifact => ({ artifact }))], createdAt: new Date().toISOString() };
  });
  return true;
}
