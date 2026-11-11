import { randomUUID } from 'node:crypto';
import { link, lstat, realpath, unlink } from 'node:fs/promises';
import path from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { matchesRequirementTopic, resolveRequirementOptions } from '../shared/requirement-options.js';
import { privateDirectory, writePrivateFile } from '../shared/private-files.js';
import { reportFile } from '../shared/report-files.js';
import { createAgentResources, readSource, agentError } from './requirement-agent-resources.js';
import { externalCleanupReceipt } from './requirement-agent-request-proof.js';
import { digest } from './requirement-feishu.js';
import { readJson } from './requirement-files.js';
import { requirementResources } from './requirement-resources.js';
import { verifiedMutationCleanup } from './requirement-mutation-measurement.js';

async function appendReceipt(directory, key, record) {
  await privateDirectory(directory);
  const file = path.join(directory, key + '.json');
  const temporary = path.join(directory, randomUUID() + '.tmp');
  await writePrivateFile(temporary, JSON.stringify(record, null, 2) + '\n');
  try {
    await link(temporary, file);
    return { record, duplicate: false };
  } catch (error) {
    if (error.code !== 'EEXIST') throw error;
    const saved = await readJson(file);
    const { recordedAt: ignored, ...expected } = record;
    const { recordedAt, ...actual } = saved ?? {};
    if (!isDeepStrictEqual(actual, expected)) throw agentError('The saved external receipt conflicts with this response');
    return { record: saved, duplicate: true };
  } finally {
    await unlink(temporary);
  }
}

export async function verifyExternalCleanupAfterJob(job, project, dataDir) {
  const terminal = job.events?.findLast(event => event.type === 'completed')?.at;
  if (job.status !== 'completed' || !terminal || !/^JOB-[A-Za-z0-9-]+$/.test(job.id)
    || !matchesRequirementTopic(project, job)) throw agentError('A completed Job in this bound topic is required');
  const root = path.join(dataDir, 'requirement-tests', job.id);
  if (!(await lstat(root)).isDirectory() || await realpath(root) !== path.join(await realpath(dataDir), 'requirement-tests', job.id)) {
    throw agentError('External receipt Job path differs from the bound task');
  }
  const [journal, state] = await Promise.all(['journal.json', 'agent-tool-state.json'].map(file => readJson(path.join(root, file))));
  const artifact = job.result?.requirementReport;
  const settings = resolveRequirementOptions(project.requirementTest, job.requirement.options);
  if (journal?.projectId !== job.projectId || journal.url !== job.requirement.url || journal.environment !== settings.environment?.name
    || !artifact || journal.artifact?.id !== artifact.id || journal.artifact?.sha256 !== artifact.sha256
    || journal.cleanup?.verified !== true || (journal.mutations ?? []).some(item => !verifiedMutationCleanup(item))) {
    throw agentError('The original report and Runner cleanup must be verified before collecting an external receipt');
  }
  const candidates = Object.entries(journal.results ?? {}).flatMap(([caseId, result]) => {
    const attempt = journal.caseAttempts?.[caseId] ?? 1;
    const current = state?.cases?.[caseId + '@' + attempt];
    return (result.externalPending ?? []).filter(item => item.after === 'job_end' && item.operation).map(item => ({
      item, current, binding: { jobId: job.id, caseId, attempt, epoch: current?.epoch ?? 0 },
    }));
  });
  if (!candidates.length) return { receipts: [], pending: [] };
  await reportFile(dataDir, job.id, artifact, { includeContent: false });
  const report = { id: artifact.id, sha256: artifact.sha256 };
  const receipts = [], pending = [], groups = new Map();
  for (const { item, current, binding } of candidates) {
    const { checkId, ...contract } = item;
    const check = current?.plan?.processChecks?.find(check => check.id === checkId);
    const preflight = current?.externalPreflights?.[checkId];
    if (!isDeepStrictEqual(check?.externalReceipt, contract) || !binding.caseId || !preflight?.evidence
      || Object.entries(binding).some(([field, value]) => preflight[field] !== value)) {
      pending.push({ ...binding, checkId, reason: 'The Job has no matching source-verified receipt capability preflight' });
      continue;
    }
    const key = digest([binding, contract.operation, contract.actor, contract.correlation, contract.after,
      preflight.boundary, preflight.source, report.id]);
    if (!groups.has(key)) groups.set(key, { contract, binding, preflight, checkIds: new Set() });
    groups.get(key).checkIds.add(checkId);
  }
  if (!groups.size) return { receipts, pending };
  const resources = await requirementResources(settings.environment, { dataDir });
  const useRead = (name, fn) => resources.use(name, 'read', fn);
  const runtime = createAgentResources(settings.execution, { state, useRead, assertRead: resources.assertRead,
    checkOutput: resources.checkOutput, rememberSecret: resources.rememberSecret });
  const directory = path.join(root, 'external-receipts');
  try {
    for (const [key, { contract, binding, preflight, checkIds: checks }] of groups) {
      const checkIds = [...checks].sort();
      try {
        const input = { ...binding, mode: 'collect', correlation: contract.correlation, after: terminal };
        const saved = await readJson(path.join(directory, key + '.json'));
        if (saved) {
          if (!isDeepStrictEqual(saved.report, report) || Object.entries(binding).some(([field, value]) => saved[field] !== value)
            || !isDeepStrictEqual(saved.checkIds, checkIds) || !isDeepStrictEqual(saved.contract, contract) || saved.after !== terminal) {
            throw agentError('Saved receipt does not match this report and attempt');
          }
          externalCleanupReceipt({ status: 200, body: saved.receipt }, contract, input, preflight.source);
          receipts.push({ record: saved, duplicate: true });
          continue;
        }
        const spec = state.operations?.[contract.operation], proof = state.operationProofs?.[contract.operation];
        if (spec?.kind !== 'http' || spec.access !== 'read' || (spec.method ?? 'GET') !== 'GET'
          || !proof?.sourceRefs?.length || digest(proof.boundary) !== preflight.boundary
          || resources.identity(spec.resource) !== proof.boundary.resource || project.repoPath !== proof.boundary.sourceRoot) {
          throw agentError('The registered receipt resource or operation boundary has changed');
        }
        for (const ref of proof.sourceRefs) {
          const previous = state.sources?.[ref];
          if (!previous?.text) throw agentError('Missing registered receipt source proof');
          const fresh = await readSource(project.repoPath, { action: previous.file ? 'show' : 'read', path: previous.path || '.',
            ...(previous.file ? { file: previous.file, ref: previous.ref } : {}), start: previous.start, end: previous.end ?? previous.start + 199 });
          if (fresh.sha256 !== previous.sha256 || previous.contentSha256 && fresh.contentSha256 !== previous.contentSha256
            || previous.origin && (fresh.origin?.repository !== previous.origin.repository || fresh.origin?.file !== previous.origin.file)) {
            throw agentError('Registered receipt source has changed');
          }
        }
        const response = await useRead(spec.resource, async resource => {
          if (spec.authenticated !== false) {
            const authentication = await runtime.authenticationEvidence(spec.resource, resource);
            if (!isDeepStrictEqual(authentication?.identity ?? null, proof.boundary.identity)) {
              throw agentError('Registered receipt source identity has changed');
            }
          }
          return runtime.performSpec(spec, input, resource);
        });
        const receipt = resources.checkOutput(externalCleanupReceipt(response, contract, input, preflight.source));
        receipts.push(await appendReceipt(directory, key, { ...binding, checkIds, contract, after: terminal, report, receipt,
          recordedAt: new Date().toISOString() }));
      } catch (error) {
        for (const checkId of checkIds) pending.push({ ...binding, checkId, reason: error.safeMessage ?? 'Registered receipt source is unavailable' });
      }
    }
  } finally {
    await runtime.close();
  }
  return { receipts, pending };
}
