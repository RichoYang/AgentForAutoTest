import path from 'node:path';
import { readFile, realpath, stat } from 'node:fs/promises';
import { createHash } from 'node:crypto';

export async function uploadFile(descriptor, roots, checkOutput = value => value) {
  if (!descriptor || !path.isAbsolute(descriptor.path ?? '') || !/^[a-f0-9]{64}$/.test(descriptor.sha256 ?? '')) {
    throw new Error('Upload requires an absolute file and SHA-256');
  }
  const target = await realpath(descriptor.path);
  const allowed = await Promise.all(roots.map(root => realpath(root).catch(() => null)));
  if (!allowed.some(root => root && !path.relative(root, target).startsWith('..') && !path.isAbsolute(path.relative(root, target)))
    || !(await stat(target)).isFile()) throw new Error('Upload file is outside configured input directories');
  const bytes = await readFile(target);
  if (createHash('sha256').update(bytes).digest('hex') !== descriptor.sha256) throw new Error('Upload content changed');
  checkOutput(bytes.toString('utf8'));
  const name = descriptor.name ?? path.basename(target);
  if (path.basename(name) !== name || /[\r\n]/.test(name)) throw new Error('Invalid upload filename');
  return { bytes, name, sha256: descriptor.sha256, type: descriptor.type ?? 'application/octet-stream' };
}

export async function multipartBody(spec, roots, checkOutput) {
  const form = new FormData(), files = [];
  for (const [key, value] of Object.entries(spec.fields ?? {})) {
    if (!['string', 'number', 'boolean'].includes(typeof value)) throw new Error('Multipart fields must be scalars');
    checkOutput?.({ [key]: value }); form.append(key, String(value));
  }
  for (const descriptor of spec.files ?? []) {
    if (!descriptor.field) throw new Error('Multipart file field is required');
    const file = await uploadFile(descriptor, roots, checkOutput);
    form.append(descriptor.field, new Blob([file.bytes], { type: file.type }), file.name);
    files.push({ field: descriptor.field, name: file.name, sha256: file.sha256, bytes: file.bytes.length });
  }
  if (!files.length) throw new Error('Multipart requires file evidence');
  return { form, evidence: { fields: spec.fields ?? {}, files } };
}

export async function verifyMultipartRequest(body, contentType, spec, roots, checkOutput) {
  const actual = await new Response(body, { headers: { 'content-type': contentType } }).formData();
  const expected = await multipartBody(spec, roots, checkOutput);
  const entries = [...actual.entries()], expectedEntries = [...expected.form.entries()];
  if (entries.length !== expectedEntries.length) throw new Error('Multipart parameter count differs from intent');
  for (const [index, [key, value]] of entries.entries()) {
    const [expectedKey, expectedValue] = expectedEntries[index];
    if (key !== expectedKey || typeof value !== typeof expectedValue) throw new Error('Multipart fields differ from intent');
    if (typeof value === 'string') {
      if (value !== expectedValue) throw new Error('Multipart field value differs from intent');
    } else if (value.name !== expectedValue.name || value.type !== expectedValue.type
      || createHash('sha256').update(Buffer.from(await value.arrayBuffer())).digest('hex')
        !== createHash('sha256').update(Buffer.from(await expectedValue.arrayBuffer())).digest('hex')) throw new Error('Multipart file differs from intent');
  }
  return expected.evidence;
}
