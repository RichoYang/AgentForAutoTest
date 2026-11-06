import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, readFile, writeFile, rm, mkdir, copyFile, realpath } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import os from 'node:os';
import { runReportBuilder } from '../src/runner/requirement-report.js';

const available = process.env.AGENTOS_TEST_BLOCKED_XLSX && process.env.AGENTOS_TEST_REPORT_PAYLOAD && process.env.AGENTOS_REQUIREMENT_SKILLS_ROOT;
test('successive actual report builds isolate layout and readback and tolerate builder diagnostics', { skip: !available }, async t => {
  const directory = await realpath(await mkdtemp(path.join(os.tmpdir(), 'agentos-report-roundtrip-')));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const reports = path.join(directory, 'reports'); await mkdir(reports);
  const payload = JSON.parse(await readFile(process.env.AGENTOS_TEST_REPORT_PAYLOAD, 'utf8'));
  const evidenceRoot = path.dirname(process.env.AGENTOS_TEST_BLOCKED_XLSX);
  for (const evidence of payload.evidence_index) {
    const destination = path.resolve(reports, evidence.relative_path);
    assert.ok(destination.startsWith(reports + path.sep)); await mkdir(path.dirname(destination), { recursive: true });
    await copyFile(path.join(evidenceRoot, evidence.relative_path), destination);
  }
  const input = path.join(directory, 'input.json'); await writeFile(input, JSON.stringify(payload));
  const skill = { path: path.join(process.env.AGENTOS_REQUIREMENT_SKILLS_ROOT, 'run-full-requirement-regression') };
  for (const minute of ['10:16', '10:17']) {
    const report = await runReportBuilder(skill, input, directory, reports, '2026-11-06T' + minute);
    assert.equal(report.sheetCount, 15);
    assert.equal(report.workbookCounts['通过'], payload.cases.filter(item => item.status === '通过').length);
    assert.equal(report.workbookReadbackSha256, report.sha256);
    const proof = JSON.parse(await readFile(path.join(directory, 'report-count-verification.json'), 'utf8'));
    assert.ok(Number.isInteger(proof.layoutWorkerPid)); assert.ok(Number.isInteger(proof.readerPid));
    assert.notEqual(proof.layoutWorkerPid, process.pid); assert.notEqual(proof.readerPid, process.pid);
  }
});

test('fresh native reader verifies the saved report and rejects changed case and mutation identities', { skip: !available }, async t => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'agentos-report-reader-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const payload = JSON.parse(await readFile(process.env.AGENTOS_TEST_REPORT_PAYLOAD, 'utf8'));
  const builder = path.join(process.env.AGENTOS_REQUIREMENT_SKILLS_ROOT, 'run-full-requirement-regression/scripts/build-full-regression-report.mjs');
  const verifier = fileURLToPath(new URL('../src/runner/requirement-report-worker.js', import.meta.url));
  async function verify(data, name) {
    const input = path.join(directory, name + '.json'); await writeFile(input, JSON.stringify(data));
    return new Promise((resolve, reject) => {
      const child = spawn(process.execPath, [verifier, 'verify', builder, process.env.AGENTOS_TEST_BLOCKED_XLSX, input], { windowsHide: true });
      let stdout = '', stderr = '';
      child.stdout.on('data', chunk => { stdout += chunk; }); child.stderr.on('data', chunk => { stderr += chunk; });
      child.on('error', reject); child.on('close', status => resolve({ status, stdout, stderr, pid: child.pid }));
    });
  }
  const good = await verify(payload, 'original'); assert.equal(good.status, 0, good.stderr);
  const counts = JSON.parse(good.stdout);
  assert.equal(counts.readerPid, good.pid); assert.notEqual(counts.readerPid, process.pid);
  assert.equal(counts.workbookReadbackSha256, createHash('sha256').update(await readFile(process.env.AGENTOS_TEST_BLOCKED_XLSX)).digest('hex'));
  assert.equal(counts.workbookCounts['通过'], payload.cases.filter(row => row.status === '通过').length);
  const wrongCase = structuredClone(payload); wrongCase.cases[0].case_id += '-different';
  const rejectedCase = await verify(wrongCase, 'wrong-case'); assert.notEqual(rejectedCase.status, 0); assert.match(rejectedCase.stderr, /case ID or status/);
  assert.ok(payload.mutation_ledger.length);
  const wrongMutation = structuredClone(payload); wrongMutation.mutation_ledger[0].mutation_id += '-different';
  const rejectedMutation = await verify(wrongMutation, 'wrong-mutation'); assert.notEqual(rejectedMutation.status, 0); assert.match(rejectedMutation.stderr, /data ledger/);
});
