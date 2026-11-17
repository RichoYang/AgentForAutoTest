import path from 'node:path';
import { readFile, writeFile, realpath } from 'node:fs/promises';
import { sign, verify, createPublicKey, createHash } from 'node:crypto';

// Run in the trusted host after capturing the requested browser action. This
// signs transport evidence only; it cannot operate a browser or decide a case.
const [requestPath, capturePath, keyPath, reportsPath] = process.argv.slice(2);
if (!requestPath || !capturePath || !keyPath || !reportsPath) throw new Error('Usage: node scripts/requirement-sidebar-receipt.mjs REQUEST CAPTURE PRIVATE_KEY REPORT_DIRECTORY');
const request = JSON.parse(await readFile(requestPath, 'utf8'));
const payload = JSON.parse(await readFile(capturePath, 'utf8'));
if (request.mode !== 'codex_sidebar' || payload.requestId !== request.id || payload.fingerprint !== request.fingerprint
  || payload.mode !== request.mode || !['real', 'controlled'].includes(payload.provenance)
  || !payload.hostSessionId || !payload.resourceSessionId || !payload.role || !payload.identity || !Object.keys(payload.identity).length
  || !(Date.parse(payload.observedAt) >= Date.parse(request.createdAt)) || !payload.files?.length) throw new Error('Capture does not match request');
const root = await realpath(reportsPath);
for (const file of payload.files) {
  if (path.basename(file.path ?? '') !== file.path || file.sanitized !== true) throw new Error('Capture requires sanitized report files');
  const target = await realpath(path.join(root, file.path));
  if (path.relative(root, target) !== file.path) throw new Error('Evidence outside report directory');
  if (createHash('sha256').update(await readFile(target)).digest('hex') !== file.sha256) throw new Error('Evidence bytes changed');
}
const privateKey = await readFile(keyPath);
const bytes = Buffer.from(JSON.stringify(payload)), signature = sign(null, bytes, privateKey).toString('base64');
if (!verify(null, bytes, createPublicKey(privateKey), Buffer.from(signature, 'base64'))) throw new Error('Signature verification failed');
const output = path.join(path.dirname(requestPath), request.id + '.receipt.json');
await writeFile(output, JSON.stringify({ payload, signature }) + '\n', { flag: 'wx', mode: 0o600 });
process.stdout.write(JSON.stringify({ receipt: output, requestId: request.id, provenance: payload.provenance }) + '\n');
