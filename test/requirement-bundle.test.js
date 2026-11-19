import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { link, mkdir, mkdtemp, readFile, realpath, rm, rmdir, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { gunzipSync } from 'node:zlib';
import { buildEvidenceBundle } from '../src/runner/requirement-bundle.js';

const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const job = { id: 'JOB-bundle-fixture' };
const diagnostic = { path: 'proof.json', type: 'process-review', sanitized: true };
const normal = { path: 'report.csv', sanitized: true };
const proof = JSON.stringify({ jobId: job.id, diagnostic: 'fixture only' });

async function fixture(t) {
  const dataDir = await realpath(await mkdtemp(path.join(os.tmpdir(), 'agentos-bundle-test-')));
  t.after(() => rm(dataDir, { recursive: true, force: true }));
  const reportDir = path.join(dataDir, 'reports');
  const workDir = path.join(dataDir, 'requirement-tests', job.id);
  const auditDir = path.join(workDir, 'diagnostics');
  await mkdir(reportDir);
  await mkdir(auditDir, { recursive: true });
  const build = (evidence, extra = {}) => buildEvidenceBundle({
    job, reportDir, workDir, dataDir, checkOutput: value => value,
    journal: { results: { C1: { evidence: [normal], processChecks: { P1: { evidence } } } } }, ...extra,
  });
  await writeFile(path.join(reportDir, normal.path), 'row,amount\n1,20\n');
  return { dataDir, reportDir, workDir, auditDir, build };
}

test('bundle reads legacy Job diagnostics and ordinary report evidence from their owning directories', async t => {
  const f = await fixture(t);
  await writeFile(path.join(f.auditDir, diagnostic.path), proof);
  await writeFile(path.join(f.reportDir, diagnostic.path), '{"different":"not a diagnostic"}');
  const artifact = await f.build({ ...diagnostic, sha256: hash(proof) });
  const root = path.join(f.dataDir, 'exports', job.id);
  const archive = await readFile(path.join(root, artifact.filename));
  assert.equal(hash(archive), artifact.sha256);
  const decoded = JSON.parse(gunzipSync(archive));
  const metadata = decoded.files.map(({ contentBase64, ...entry }) => {
    const bytes = Buffer.from(contentBase64, 'base64');
    assert.equal(bytes.length, entry.bytes);
    assert.equal(hash(bytes), entry.sha256);
    return entry;
  });
  assert.deepEqual(metadata.map(file => file.name), [normal.path, diagnostic.path]);
  assert.equal(metadata[1].sha256, hash(proof));
  assert.equal(metadata[0].sha256, hash(await readFile(path.join(f.reportDir, normal.path))));
  const verification = await readFile(path.join(root, artifact.id + '.verification.json'));
  assert.equal(hash(verification), artifact.verificationHash);
  assert.deepEqual(JSON.parse(verification).files, { count: 2, sha256: hash(JSON.stringify(metadata)) });
});

test('conflicting referenced filenames and overwritten hash declarations are rejected', async t => {
  const f = await fixture(t);
  await writeFile(path.join(f.auditDir, diagnostic.path), proof);
  await writeFile(path.join(f.reportDir, diagnostic.path), 'different bytes');
  const reportIndex = entries => writeFile(path.join(f.workDir, 'normalized-report.json'), JSON.stringify({ evidence_index: entries }));
  await reportIndex([{ relative_path: diagnostic.path, sanitized: true }]);
  await assert.rejects(f.build(diagnostic), /Conflicting evidence filename/);
  await reportIndex([]);
  await assert.rejects(f.build([{ ...diagnostic, sha256: '0'.repeat(64) }, diagnostic]), /Evidence content changed/);
});

test('diagnostics reject missing sources, out-of-scope paths, wrong Job, and unsanitized references or bytes', async t => {
  const f = await fixture(t);
  await writeFile(path.join(f.reportDir, diagnostic.path), proof);
  await assert.rejects(f.build(diagnostic), { code: 'ENOENT' });
  await assert.rejects(f.build({ ...diagnostic, path: '..\\proof.json' }), /Invalid evidence path/);
  await assert.rejects(f.build({ ...diagnostic, path: 'proof.json:alternate' }), /Invalid evidence path/);
  await assert.rejects(f.build({ ...diagnostic, sanitized: false }), /not marked as sanitized/);
  await writeFile(path.join(f.auditDir, diagnostic.path), '{"jobId":"JOB-other"}');
  await assert.rejects(f.build(diagnostic), /different Job/);
  const otherDir = path.join(f.dataDir, 'requirement-tests', 'JOB-other');
  await mkdir(otherDir);
  await assert.rejects(f.build(diagnostic, { workDir: otherDir }), /outside this Job/);
  await writeFile(path.join(f.auditDir, diagnostic.path), proof);
  await assert.rejects(f.build(diagnostic, { checkOutput(value) {
    if (typeof value === 'string' && value.includes('fixture only')) throw new Error('unsafe diagnostic text');
    return value;
  } }), /unsafe diagnostic text/);
});

test('diagnostics reject linked files and linked directories', async t => {
  const f = await fixture(t);
  const other = path.join(f.dataDir, 'other');
  await mkdir(other);
  const file = path.join(other, diagnostic.path);
  await writeFile(file, proof);
  await link(file, path.join(f.auditDir, diagnostic.path));
  await assert.rejects(f.build(diagnostic), /Invalid evidence file/);
  await rm(path.join(f.auditDir, diagnostic.path));
  await rmdir(f.auditDir);
  await symlink(other, f.auditDir, process.platform === 'win32' ? 'junction' : 'dir');
  await assert.rejects(f.build(diagnostic), /Invalid evidence directory/);
});
