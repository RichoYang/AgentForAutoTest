import path from 'node:path';
import { readFile, writeFile, realpath, lstat } from 'node:fs/promises';
import { gzipSync, gunzipSync } from 'node:zlib';
import { randomUUID, createHash } from 'node:crypto';
import { privateDirectory, writeJson, readJson } from './requirement-files.js';
import { hashFile } from '../shared/file-digest.js';

export async function buildEvidenceBundle({ job, journal, reportDir, workDir, dataDir, checkOutput }) {
  const references = new Map();
  const scan = value => {
    if (Array.isArray(value)) return value.forEach(scan);
    if (!value || typeof value !== 'object') return;
    if (value.sanitized === true && value.path) references.set(value.path, value);
    Object.values(value).forEach(scan);
  };
  scan(journal.results); scan(journal.mutations); scan(journal.samples); scan(journal.deploymentChecks);
  scan(journal.cleanup); scan(journal.processFinalization);
  const report = workDir ? await readJson(path.join(workDir, 'normalized-report.json')) : null;
  for (const entry of report?.evidence_index ?? []) scan({ path: entry.relative_path, sanitized: entry.sanitized });
  const files = [];
  for (const [name, reference] of references) {
    if (path.basename(name) !== name) throw new Error('Evidence path is outside report directory');
    const file = path.join(reportDir, name), info = await lstat(file);
    if (!info.isFile() || info.isSymbolicLink() || path.relative(await realpath(reportDir), await realpath(file)) !== name) throw new Error('Invalid evidence file');
    const bytes = await readFile(file);
    if (reference.sha256 && reference.sha256 !== createHash('sha256').update(bytes).digest('hex')) throw new Error('Evidence content changed');
    if (/\.(?:json|txt|log|csv|html|gz)$/i.test(name)) checkOutput(/\.gz$/i.test(name) ? gunzipSync(bytes).toString('utf8') : bytes.toString('utf8'));
    files.push({ name, bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex'), contentBase64: bytes.toString('base64') });
  }
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
      sha256: createHash('sha256').update(JSON.stringify(files.map(({ contentBase64, ...metadata }) => metadata))).digest('hex') } });
  artifact.verificationHash = await hashFile(receipt);
  return artifact;
}
