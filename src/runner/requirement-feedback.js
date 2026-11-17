import path from 'node:path';
import { copyFile, readFile, unlink } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { digest, RequirementWait } from './requirement-feishu.js';
import { privateDirectory, readJson, writeJson } from './requirement-files.js';
import { sanitized } from './requirement-agent-resources.js';
import { verifiedMutationCleanup } from './requirement-mutation-measurement.js';

export async function collectTopicFeedback(client, job, settings, directory, checkOutput = value => value) {
  const root = job.requirement.rootMessageId ?? (job.requirement.root?.startsWith('omt_') ? job.originMessageId : job.requirement.root);
  const messages = await client.readThread(root, job.requirement.threadId, { profile: settings.bot.profile });
  const records = [];
  for (const message of messages) {
    if (message.chat_id !== job.chatId || message.message_id !== root && message.root_id !== root) {
      throw new RequirementWait('feedback_scope', '反馈消息不属于原群及原话题。');
    }
    const author = message.sender?.id;
    const role = settings.feedback.roles?.[author];
    if (!['product', 'developer', 'tester'].includes(role)) continue;
    const content = JSON.parse(message.body?.content ?? '{}');
    const fragments = [], attachments = new Map();
    const inspect = value => {
      if (!value || typeof value !== 'object') return;
      if (typeof value.title === 'string') fragments.push(value.title);
      if (typeof value.text === 'string') fragments.push(value.text);
      for (const [field, type] of [['file_key', 'file'], ['image_key', 'image']]) if (value[field]) {
        attachments.set(value[field], { key: value[field], type, originalName: value.file_name });
      }
      Object.values(value).forEach(inspect);
    };
    inspect(content);
    const text = fragments.join('\n') || JSON.stringify(content);
    // Command/status chatter is not an acceptance change. Product confirmation is explicit.
    if (message.deleted) continue;
    const record = { messageId: message.message_id, requirementUrl: job.requirement.url, author, at: message.update_time ?? message.create_time,
      role, text: checkOutput(sanitized(text)), kind: role === 'product' ? (text.startsWith('验收确认') ? 'acceptance_confirmation' : 'product_statement') : role === 'developer' ? 'developer_statement' : 'test_observation', attachments: [] };
    for (const attachment of attachments.values()) {
      const file = await client.downloadMessageResource(job.id, message.message_id, attachment.key, attachment.type, { profile: settings.bot.profile });
      const bytes = await readFile(file.path), sha256 = createHash('sha256').update(bytes).digest('hex');
      checkOutput(bytes.toString('utf8'));
      const filename = 'feedback-' + sha256;
      await copyFile(file.path, path.join(directory, filename));
      record.attachments.push(checkOutput({ fileKey: attachment.key, type: attachment.type, filename, originalName: attachment.originalName, sha256,
        ...(/\.(?:md|txt|csv|json)$/i.test(attachment.originalName ?? '') ? { text: sanitized(bytes.toString('utf8')) } : { interpretation: 'captured_bytes_requires_content_review' }) }));
    }
    records.push(record);
  }
  records.sort((a, b) => a.messageId.localeCompare(b.messageId));
  const snapshot = checkOutput({ root, records, hash: digest(records) });
  await writeJson(path.join(directory, 'feedback-' + snapshot.hash + '.json'), snapshot);
  return snapshot;
}

export async function archiveExecutionVersion({ journal, source, current, job, workDir, save }) {
  const request = job.requirement.revisionRequest;
  const approvalHash = current.approvalHash ?? current.hash;
  if (!request || request.sourceHash !== approvalHash) throw new RequirementWait('requirement_version',
    '来源已变化；旧结果保留。核对产品确认及受影响用例后，在原话题回复「确认执行版本 ' + approvalHash + ' 用例 CASE-ID,...」。');
  const confirmations = current.feedback?.records.filter(record => record.kind === 'acceptance_confirmation') ?? [];
  const changed = confirmations.filter(record => !source.feedback?.records.some(old => old.messageId === record.messageId && digest(old) === digest(record)));
  if (!request.caseIds?.length || !changed.length || request.caseIds.some(id => !changed.some(record => record.text.includes(id)))) {
    throw new RequirementWait('acceptance_confirmation', '缺本次受影响用例的产品验收确认依据；开发说明只能触发复测，不能改预期。');
  }
  if ((journal.mutations ?? []).some(item => !verifiedMutationCleanup(item))) throw new RequirementWait('cleanup_pending', '变更执行版本前先核对保留样本与未决变更；旧台账不会覆盖。');
  const version = journal.executionVersion ?? 1;
  const directory = await privateDirectory(path.join(workDir, 'versions', String(version)));
  if (!await readJson(path.join(directory, 'journal.json'))) await writeJson(path.join(directory, 'journal.json'), journal);
  if (!await readJson(path.join(directory, 'requirement.json'))) await writeJson(path.join(directory, 'requirement.json'), source);
  for (const file of ['cases.json', 'case-index.json', 'agent-tool-state.json']) {
    await copyFile(path.join(workDir, file), path.join(directory, file), 1).catch(error => { if (!['ENOENT', 'EEXIST'].includes(error.code)) throw error; });
  }
  journal.revisionTransition = { directory, current, request, confirmations: changed.map(record => record.messageId), version };
  await save();
  await recoverExecutionVersion(journal, workDir, save);
}

export async function recoverExecutionVersion(journal, workDir, save) {
  const transition = journal.revisionTransition;
  if (!transition) return;
  const { directory, current, request, confirmations, version } = transition;
  const previous = await readJson(path.join(directory, 'journal.json'));
  const source = await readJson(path.join(directory, 'requirement.json'));
  if (!previous || !source) throw new RequirementWait('requirement_version', '执行版本归档不完整，未覆盖旧材料。');
  // Replay this deterministic transition after a crash; its original inputs are immutable.
  journal.versionHistory = structuredClone(previous.versionHistory ?? []);
  journal.versionHistory ??= [];
  journal.versionHistory.push({ version, sourceHash: source.hash, nextHash: current.hash, request,
    confirmations, report: previous.artifact, evidenceBundle: previous.evidenceBundle, reportDirectory: previous.reportDirectory, results: structuredClone(previous.results ?? {}) });
  journal.reuseCandidates = { results: structuredClone(previous.results ?? {}), cases: structuredClone(previous.executionCases ?? {}),
    sourceAttempts: structuredClone(previous.sourceAttempts ?? {}), reportDirectory: previous.reportDirectory, affectedCaseIds: request.caseIds, fromVersion: version };
  journal.executionVersion = version + 1;
  journal.reportSequence = (previous.reportSequence ?? 0) + 1;
  for (const key of ['casesHash','caseIndexHash','publication','results','executionCases','preparations','executionSteps','inFlight','cleanup',
    'artifact','evidenceBundle','reportId','reportTime','visualReview','visualProgress','caseCoverageKey','deployment','mutations',
    'caseCleanup','samples','caseAttempts','processFinalization','retrySelection','retrySequence','sidebarWaiting']) delete journal[key];
  await writeJson(path.join(workDir, 'requirement.json'), current);
  for (const file of ['cases.json', 'case-index.json', 'agent-tool-state.json']) {
    await unlink(path.join(workDir, file)).catch(error => { if (error.code !== 'ENOENT') throw error; });
  }
  delete journal.revisionTransition;
  await save();
}
