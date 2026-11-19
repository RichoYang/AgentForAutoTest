import path from 'node:path';
import { readFile, writeFile, realpath, lstat } from 'node:fs/promises';
import { gzipSync, gunzipSync } from 'node:zlib';
import { randomUUID, createHash } from 'node:crypto';
import { isAgentDiagnostic, privateDirectory, writeJson } from './requirement-files.js';
import { hashFile } from '../shared/file-digest.js';

const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');

async function evidenceDirectory(directory) {
  const info = await lstat(directory);
  if (!info.isDirectory() || info.isSymbolicLink()) throw new Error('Invalid evidence directory');
  return realpath(directory);
}

async function readEvidence(directory, name) {
  const file = path.join(directory, name);
  const info = await lstat(file);
  if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1 ||
      path.relative(directory, await realpath(file)) !== name) throw new Error('Invalid evidence file');
  return readFile(file);
}

export async function buildEvidenceBundle({ job, journal, reportDir, workDir, dataDir, checkOutput }) {
  if (!/^JOB-[a-z0-9-]+$/i.test(job.id)) throw new Error('Invalid evidence Job');
  const references = [];
  const reference = (value, diagnostic = false) => {
    if (value.sanitized !== true) throw new Error('Evidence is not marked as sanitized');
    const name = value.path;
    if (typeof name !== 'string' || !name || /[<>:"/\\|?*\x00-\x1f]|[. ]$/.test(name) ||
        /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(name)) throw new Error('Invalid evidence path');
    references.push({ name, diagnostic, expectedHash: value.sha256 });
  };
  const scan = value => {
    if (Array.isArray(value)) return value.forEach(scan);
    if (!value || typeof value !== 'object') return;
    if (Object.hasOwn(value, 'sanitized') && Object.hasOwn(value, 'path')) reference(value, isAgentDiagnostic(value.type));
    Object.values(value).forEach(scan);
  };
  scan(journal.results); scan(journal.mutations); scan(journal.samples); scan(journal.deploymentChecks);
  scan(journal.cleanup); scan(journal.processFinalization);
  const task = workDir ? await evidenceDirectory(workDir) : null;
  if (task && path.relative(await realpath(dataDir), task) !== path.join('requirement-tests', job.id)) {
    throw new Error('Evidence work directory is outside this Job');
  }
  const report = task ? await readEvidence(task, 'normalized-report.json').then(bytes => JSON.parse(bytes.toString('utf8')), error => {
    if (error.code === 'ENOENT') return null;
    throw error;
  }) : null;
  for (const entry of report?.evidence_index ?? []) reference({ path: entry.relative_path, sanitized: entry.sanitized, sha256: entry.sha256 });
  const reportRoot = await evidenceDirectory(reportDir);
  let diagnosticRoot;
  const loaded = new Map(), packed = new Map();
  for (const { name, diagnostic, expectedHash } of references) {
    const source = diagnostic ? 'diagnostics/' + name : name;
    let file = loaded.get(source);
    if (!file) {
      if (diagnostic && !task) throw new Error('Evidence diagnostic has no Job work directory');
      const root = diagnostic ? (diagnosticRoot ??= await evidenceDirectory(path.join(task, 'diagnostics'))) : reportRoot;
      const bytes = await readEvidence(root, name);
      if (diagnostic && JSON.parse(bytes.toString('utf8'))?.jobId !== job.id) {
        throw new Error('Evidence diagnostic belongs to a different Job');
      }
      if (/\.(?:json|txt|log|csv|html|gz)$/i.test(name)) checkOutput(/\.gz$/i.test(name) ? gunzipSync(bytes).toString('utf8') : bytes.toString('utf8'));
      file = { name, bytes: bytes.length, sha256: sha256(bytes), contentBase64: bytes.toString('base64') };
      loaded.set(source, file);
    }
    if (expectedHash !== undefined && expectedHash !== file.sha256) throw new Error('Evidence content changed');
    const key = name.toLowerCase();
    const prior = packed.get(key);
    if (prior && (prior.name !== name || prior.sha256 !== file.sha256)) throw new Error('Conflicting evidence filename: ' + name);
    packed.set(key, file);
  }
  const files = [...packed.values()];
  const manifest = checkOutput({ version: 1, jobId: job.id, executionVersion: journal.executionVersion ?? 1,
    evidenceScope: Object.values(journal.results ?? {}).some(result => result.validationScope === 'controlled') ? 'controlled' : 'runtime',
    results: journal.results, samples: journal.samples, source: journal.source, feedback: journal.feedback,
    report, repositories: journal.repositories,
    deploymentChecks: journal.deploymentChecks, versionHistory: journal.versionHistory, sourceAttempts: journal.sourceAttempts });
  const id = 'report-' + randomUUID(), filename = id + '.evidence.json.gz';
  const root = await privateDirectory(path.join(dataDir, 'exports', job.id));
  const bytes = gzipSync(Buffer.from(JSON.stringify({ manifest, files })));
  await writeFile(path.join(root, filename), bytes);
  const artifact = { id, filename, kind: 'requirement-evidence', bytes: bytes.length, sha256: await hashFile(path.join(root, filename)),
    rowCount: Object.keys(journal.results ?? {}).length, complete: true };
  const receipt = path.join(root, id + '.verification.json');
  await writeJson(receipt, { version: 1, status: 'verified', kind: artifact.kind, file: artifact,
    coverage: { rowCount: artifact.rowCount }, files: { count: files.length,
      sha256: sha256(JSON.stringify(files.map(({ contentBase64, ...metadata }) => metadata))) } });
  artifact.verificationHash = await hashFile(receipt);
  return artifact;
}
