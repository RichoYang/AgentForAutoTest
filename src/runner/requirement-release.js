import { createHash } from 'node:crypto';
import path from 'node:path';
import { readJson } from './requirement-files.js';
import { digest } from './requirement-feishu.js';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { realpath } from 'node:fs/promises';

export async function commitContains(repository, required, deployed, sourceRoot) {
  if (!commit.test(required ?? '') || !commit.test(deployed ?? '') || !repository?.path_or_url || !sourceRoot) return false;
  try {
    const root = await realpath(sourceRoot), folder = await realpath(repository.path_or_url);
    const relative = path.relative(root, folder);
    if (relative.startsWith('..') || path.isAbsolute(relative)) return false;
    const git = promisify(execFile);
    await git('git', ['-C', folder, 'merge-base', '--is-ancestor', required, deployed], { windowsHide: true });
    return true;
  } catch { return false; }
}

const hash = /^[a-f0-9]{64}$/;
const commit = /^[a-f0-9]{40,64}$/;
const identifier = /^[\w][\w.:/@+-]{0,199}$/;
const versionFields = ['commit', 'sha256', 'buildId', 'imageTag', 'imageDigest'];

export async function verifyRequirementRelease(config, scope, inspectArtifact, readManifest = async settings => ({ manifest: await readJson(settings.path) })) {
  const settings = config.releaseManifest;
  const components = Object.entries(settings?.components ?? {});
  const gaps = [];
  let release;
  let sourceStatus;
  if (settings && (settings.resource || path.isAbsolute(settings.path ?? ''))) {
    try {
      const { manifest, httpStatus } = await readManifest(settings);
      sourceStatus = httpStatus;
      const candidate = Object.hasOwn(manifest?.releases ?? {}, scope.source.id) ? manifest.releases[scope.source.id] : null;
      if (httpStatus >= 400) gaps.push('发布记录读取返回 HTTP ' + httpStatus + '。');
      else if (!manifest) gaps.push('未取得发布记录。');
      else if (manifest.version !== 1 || manifest.projectId !== scope.projectId || manifest.environment !== scope.environment) {
        gaps.push('发布记录未绑定本项目测试环境。');
      } else if (!candidate || candidate.revision !== scope.source.revision || candidate.sourceHash !== scope.source.hash) {
        gaps.push('发布记录未匹配本需求修订号和内容摘要。');
      } else if (!(Date.parse(candidate.validUntil) > Date.now())) {
        gaps.push('发布记录过期或未提供有效期。');
      } else release = candidate;
    } catch {
      gaps.push('发布记录无法读取或解析。');
    }
  } else gaps.push('未配置发布记录来源。');
  if (!components.length) gaps.push('未配置运行产物观测。');
  const proof = [];
  for (const [name, binding] of components) {
    const component = Object.hasOwn(release?.components ?? {}, name) ? release.components[name] : null;
    const item = { name, resource: binding.resource, path: binding.path, observed: null, verified: false };
    if (commit.test(component?.commit)) item.commit = component.commit;
    if (hash.test(component?.sha256)) item.expected = component.sha256;
    for (const field of versionFields.slice(2)) {
      if (typeof component?.[field] === 'string' && identifier.test(component[field])) item[field] = component[field];
    }
    try {
      const result = await inspectArtifact(item);
      const bytes = Buffer.isBuffer(result) ? result : result?.bytes;
      if (result?.httpStatus) item.httpStatus = result.httpStatus;
      if (bytes) item.observed = createHash('sha256').update(bytes).digest('hex');
    } catch {
      // The source may be unavailable even when the project test resources are authorized.
    }
    const repository = scope.repositories?.find(repo => repo.name === binding.repository);
    const head = repository?.requested?.commit ?? repository?.commit;
    const sourceMatches = item.commit && repository && (head === item.commit
      || await commitContains(repository, item.commit, head, scope.sourceRoot));
    item.source = repository ? { branch: repository.requested?.branch ?? repository.branch, commit: head, repository: repository.name } : null;
    const required = [...new Set([...(binding.requiredCommits ?? []), ...Object.values(config.caseReleases ?? {})
      .filter(rule => rule.component === name).flatMap(rule => rule.requiredCommits ?? [])])];
    item.commitProofs = await Promise.all(required.map(async requiredCommit => ({ requiredCommit, deployedCommit: item.commit,
      included: await commitContains(repository, requiredCommit, item.commit, scope.sourceRoot), method: 'git merge-base --is-ancestor' })));
    item.verified = Boolean(sourceMatches && item.observed && item.observed === item.expected
      && (binding.requiredCommits ?? []).every(requiredCommit => item.commitProofs.some(proof => proof.requiredCommit === requiredCommit && proof.included)));
    if (!sourceMatches) gaps.push(name + ' 缺少匹配的发布提交。');
    if (!item.observed) gaps.push(name + ' 运行产物未取得' + (item.httpStatus ? '，HTTP ' + item.httpStatus : '') + '。');
    else if (!item.expected) gaps.push(name + ' 缺少登记的产物摘要。');
    else if (item.observed !== item.expected) gaps.push(name + ' 运行产物与发布摘要不一致。');
    if (!item.buildId) gaps.push(name + ' 缺少构建号。');
    if (!item.imageTag && !item.imageDigest) gaps.push(name + ' 缺少镜像标识。');
    proof.push(item);
  }
  const verified = proof.length > 0 && proof.every(item => item.verified);
  return { verified, reason: gaps.join(' ') || null, gaps, proof, ...(sourceStatus ? { sourceStatus } : {}),
    fingerprint: verified ? digest([scope.projectId, scope.environment, scope.source.id, release.revision, release.sourceHash, proof]) : null };
}

// A release dependency must come from a fixed case, never from the execution model.
export function caseReleaseRequirement(item, row, headers, configured) {
  const fixed = Object.hasOwn(configured ?? {}, item.caseId) ? configured[item.caseId] : null;
  const text = String(row[headers.indexOf('前置条件')] ?? '');
  const marker = /(?:^|\n)\s*(?:\d+[.、]\s*)?发布版本前置[：:]\s*([^\r\n]*)/.exec(text);
  const explicit = /(?:必须(?:在|使用|部署|运行)?|仅限|仅支持)(?:指定|固定|特定)(?:发布)?版本/.test(text)
    || /(?:必须|仅限).{0,16}(?:部署|运行|发布).{0,8}(?:版本(?:号)?|构建号|镜像\s*(?:tag|digest)|commit)\s*[：:=]?\s*(?:v?\d[\w.-]*|[a-f0-9]{7,64})/i.test(text);
  if (!fixed && !marker && !explicit) return null;
  const named = marker && /^(\w[\w.-]*)\s+(commit|sha256|buildId|imageTag|imageDigest)\s*=\s*(\S+)\s*$/.exec(marker[1]);
  const requirement = fixed ?? (named ? { component: named[1], [named[2]]: named[3] } : {});
  const fields = versionFields.filter(field => Object.hasOwn(requirement, field));
  return { component: typeof requirement.component === 'string' ? requirement.component : null,
    requiredCommits: requirement.requiredCommits ?? [], fields: Object.fromEntries(fields.map(field => [field, requirement[field]])) };
}

export function matchesCaseRelease(requirement, receipt) {
  const component = Array.isArray(receipt.proof) && receipt.proof.find(item => item?.name === requirement.component && item.verified === true);
  const fields = Object.entries(requirement.fields);
  const required = requirement.requiredCommits ?? [];
  return Boolean(component && (fields.length || required.length) && fields.every(([field, value]) =>
    typeof value === 'string' && identifier.test(value) && (field === 'sha256' ? component.observed : component[field]) === value)
    && required.every(requiredCommit => commit.test(requiredCommit) && component.commitProofs?.some(proof =>
      proof.requiredCommit === requiredCommit && proof.deployedCommit === component.commit && proof.included === true)));
}
