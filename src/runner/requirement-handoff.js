import path from 'node:path';
import { readFile, realpath } from 'node:fs/promises';
import { randomUUID, verify, createHash } from 'node:crypto';
import { privateDirectory, readJson, writeJson } from './requirement-files.js';
import { digest, RequirementWait } from './requirement-feishu.js';

// The public key is deployment configuration, never supplied by a receipt/model.
// The trusted host attests transport and captured bytes; normal business assertions
// still run in the existing executor. A signature is not a UAT verdict.
export async function sidebarHandoff(config, scope, action) {
  const directory = await privateDirectory(path.join(scope.workDir, 'sidebar-handoff'));
  const binding = { jobId: scope.jobId, caseId: scope.item?.caseId ?? 'cleanup', attempt: scope.attempt ?? 1,
    executionVersion: scope.executionVersion ?? 1, projectId: scope.projectId, environment: scope.environment,
    resource: action.resource, resourceIdentity: scope.resourceIdentity(action.resource) };
  scope.checkOutput?.(action);
  const fingerprint = digest([binding, action, config?.publicKey ?? null, config?.provenance ?? null]);
  const file = path.join(directory, fingerprint + '.pending.json');
  let pending = await readJson(file);
  if (action.action === 'authentication' && pending?.consumedAt) {
    const verified = await readJson(path.join(directory, pending.id + '.verified.json'));
    if (verified?.receiptHash === pending.receiptHash) return verified.result;
  }
  if (!pending || pending.consumedAt) {
    pending = { version: 1, id: randomUUID(), mode: 'codex_sidebar', binding, fingerprint, action,
      createdAt: new Date().toISOString(), integration: 'handoff',
      context: { runPrefix: scope.runPrefix, row: scope.row, headers: scope.headers,
        samples: scope.samples ?? {}, permissions: scope.resourceCatalog?.[action.resource],
        operationProofs: scope.state?.operationProofs,
        instructions: 'Use the designated in-app browser. Reconcile uncertain writes before repeating. Never return credentials. Capture business state and ledger evidence separately. Browser interactions may only send registered read contracts or the exact ledgered mutation; mask credential fields and sensitive URL parameters before screenshots.' } };
    scope.checkOutput?.(pending);
    await writeJson(file, pending);
    await writeJson(path.join(directory, 'pending.json'), pending);
    await writeJson(path.join(directory, pending.id + '.request.json'), pending);
  }
  const wait = reason => { throw new RequirementWait('sidebar_handoff', reason + ' 交接请求：' + file); };
  if (pending.fingerprint !== fingerprint) wait('须先完成原节点交接；禁止换操作跳过尚未确认的副作用。');
  const receipt = await readJson(path.join(directory, pending.id + '.receipt.json'));
  if (!receipt) wait('待 Codex 侧边栏执行端接收并返回证据。');
  if (!config?.publicKey) wait('执行端尚未配置可信公钥；集成未验证。');
  const payload = receipt.payload;
  if (!payload || !verify(null, Buffer.from(JSON.stringify(payload)), config.publicKey, Buffer.from(receipt.signature ?? '', 'base64'))
    || payload.requestId !== pending.id || payload.fingerprint !== fingerprint || payload.mode !== 'codex_sidebar'
    || !['real', 'controlled'].includes(payload.provenance) || config.provenance !== payload.provenance
    || !payload.hostSessionId || !payload.resourceSessionId || !payload.role || !payload.identity || !Object.keys(payload.identity).length
    || scope.resourceCatalog?.[action.resource]?.account_role && payload.role !== scope.resourceCatalog[action.resource].account_role
    || !(Date.parse(payload.observedAt) >= Date.parse(pending.createdAt)) || !payload.files?.length) {
    wait('交接签名、来源、身份或执行范围核验失败。');
  }
  scope.checkOutput?.(payload);
  const evidence = [];
  for (const entry of payload.files) {
    if (!entry.path || path.basename(entry.path) !== entry.path || entry.sanitized !== true) wait('交接文件路径或脱敏标记无效。');
    const target = path.join(scope.reports, entry.path);
    if (path.relative(await realpath(scope.reports), await realpath(target)) !== entry.path) wait('交接证据越界。');
    const bytes = await readFile(target);
    if (createHash('sha256').update(bytes).digest('hex') !== entry.sha256) wait('交接证据摘要不符。');
    if (/\.(?:json|txt|log|csv|html)$/i.test(entry.path)) scope.checkOutput?.(bytes.toString('utf8'));
    evidence.push(entry);
  }
  if (action.action === 'observe' && (!payload.data?.screenshot
    || !evidence.some(entry => entry.path === payload.data.screenshot.path))) wait('页面观测缺实际截图。');
  const sessionsFile = path.join(directory, 'sessions.json');
  const sessions = await readJson(sessionsFile) ?? {};
  if (Object.entries(sessions).some(([resource, session]) => resource !== action.resource && session === payload.resourceSessionId)) {
    wait('不同系统不能复用同一资源会话。');
  }
  sessions[action.resource] = payload.resourceSessionId;
  await writeJson(sessionsFile, sessions);
  const identitiesFile = path.join(directory, 'identities.json'), identities = await readJson(identitiesFile) ?? {};
  if (identities[action.resource] && digest(identities[action.resource]) !== digest(payload.identity)) wait('系统账号身份已改变；需核对原样本责任及权限，不能继续原动作。');
  identities[action.resource] = payload.identity; await writeJson(identitiesFile, identities);
  const result = { ...payload.data, provenance: payload.provenance, handoff: { requestId: pending.id,
    hostSessionId: payload.hostSessionId, resourceSessionId: payload.resourceSessionId, role: payload.role,
    observedAt: payload.observedAt, evidence } };
  if (action.action === 'authentication') Object.assign(result, { identity: payload.identity, authenticated: true });
  pending.consumedAt = new Date().toISOString();
  pending.receiptHash = digest(payload);
  await writeJson(path.join(directory, pending.id + '.verified.json'), { ...pending, result });
  await writeJson(file, pending);
  return result;
}
