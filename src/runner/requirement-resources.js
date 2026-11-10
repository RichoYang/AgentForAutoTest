import { createHash, createHmac, randomBytes, randomUUID } from 'node:crypto';
import { link, lstat, readFile, unlink } from 'node:fs/promises';
import path from 'node:path';
import { privateDirectory, privatePathProof, writePrivateFile } from '../shared/private-files.js';
import { RequirementWait, digest } from './requirement-feishu.js';

const operations = ['read', 'create', 'update', 'delete', 'trigger'];
const modes = new Map([
  ['read', ['read']], ['read_only', ['read']], ['query_only', ['read']],
  ['create_update_read', ['read', 'create', 'update']], ['full_crud', operations],
]);
const connectors = new Map([['website', 'http_browser'], ['web_platform', 'http_browser'],
  ['interface_management_platform', 'http_browser'], ['mysql', 'mysql'], ['rabbitmq', 'rabbitmq_management_http'], ['xxl_job', 'scheduler_http']]);
export const credentialField = /password|(?:^|_)pwd(?:$|_)|passphrase|token|secret|cookie|authorization|connection[_-]?string|(?:^|[_-])(?:admin|api|private|access)[_-]?key(?:$|[_-])/i;

export function managementReadAllowed(resource, method, pathname) {
  if (resource.resource_type === 'rabbitmq') return ['GET', 'HEAD', 'OPTIONS'].includes(method);
  if (resource.resource_type !== 'xxl_job') return true;
  if (!['GET', 'HEAD', 'OPTIONS', 'POST'].includes(method)) return false;
  try {
    return !/\/(?:trigger|start|stop|remove|delete|add|update|clearLog|logKill)(?:[\/;]|$)/i.test(decodeURIComponent(pathname));
  } catch { return false; }
}

export function scopedDatabase(resource, requested) {
  const bound = resource.database_name === 'not_specified' ? undefined : resource.database_name;
  if (bound && requested && requested !== bound) throw new RequirementWait('environment_scope', '数据库与资源已绑定的库名不一致。');
  return bound || requested;
}

function parse(text) {
  const sections = new Map();
  let current;
  for (const [index, raw] of text.split(/\r?\n/).entries()) {
    const line = raw.trim();
    if (!line || /^[;#]/.test(line)) continue;
    const header = /^\[([^\[\]]+)\](?:\s+[;#].*)?$/.exec(line);
    if (header) {
      const name = header[1].trim();
      const key = name.toLowerCase();
      current = sections.get(key);
      if (current) current.issues.push(`第 ${index + 1} 行重复配置节`);
      else sections.set(key, current = { name, fields: Object.create(null), issues: [] });
      continue;
    }
    if (!current) continue;
    const assignment = /^([a-zA-Z0-9_.-]+)\s*=\s*(.*)$/.exec(line);
    if (!assignment) { current.issues.push(`第 ${index + 1} 行配置格式无效`); if (line.startsWith('[')) current = undefined; continue; }
    const field = assignment[1].toLowerCase();
    if (Object.hasOwn(current.fields, field)) current.issues.push(`第 ${index + 1} 行重复字段 ${field}`);
    else current.fields[field] = assignment[2];
  }
  return sections;
}

const runtimeKey = randomBytes(32);

// Keep credential-dependent fingerprints opaque across worker processes.
// This key signs resource identities only. It never contains business secrets.
export async function resourceBindingKey(dataDir) {
  if (!dataDir) return runtimeKey;
  const folder = path.join(dataDir, 'requirement-resource-bindings');
  await privateDirectory(folder);
  const file = path.join(folder, 'identity-key.json');
  if (!await lstat(file).catch(error => { if (error.code !== 'ENOENT') throw error; })) {
    const temporary = path.join(folder, randomUUID() + '.json');
    try {
      await writePrivateFile(temporary, JSON.stringify(randomBytes(32).toString('hex')));
      await link(temporary, file).catch(error => { if (error.code !== 'EEXIST') throw error; });
    } finally { await unlink(temporary).catch(error => { if (error.code !== 'ENOENT') throw error; }); }
  }
  if (!(await lstat(file)).isFile() || !(await privatePathProof(file)).private) throw new RequirementWait('environment_config', '资源指纹密钥权限校验失败。');
  const value = JSON.parse(await readFile(file, 'utf8'));
  if (!/^[a-f0-9]{64}$/.test(value)) throw new RequirementWait('environment_config', '资源指纹密钥格式无效。');
  return Buffer.from(value, 'hex');
}

function inspectBinding(environment, binding, sections) {
  const blocked = (code, detail) => ({ code, detail });
  const parts = typeof binding?.section === 'string' ? binding.section.toLowerCase().split('.') : [];
  const tier = environment.name.toLowerCase();
  const aliases = (environment.aliases ?? []).filter(alias => ['SIT', 'UAT'].includes(alias)).map(alias => alias.toLowerCase());
  if (parts[0] !== environment.platform.toLowerCase() || ![tier, ...aliases].includes(parts[1])) {
    return blocked('binding_mismatch', '配置节不属于已绑定项目与 SIT/UAT');
  }
  const entry = sections.get(binding.section.toLowerCase());
  if (!entry) return blocked('section_missing', '找不到显式绑定的配置节');
  if (entry.issues.length) return blocked('invalid_ini', entry.issues.join('、'));
  const section = entry.fields;
  if (section.environment?.toLowerCase() !== parts[1] || section.platform && section.platform.toLowerCase() !== parts[0]) {
    return blocked('binding_mismatch', '节名与 platform/environment 声明不一致');
  }
  const policy = sections.get('aipolicy');
  if (policy?.issues.length) return blocked('invalid_ini', 'AiPolicy ' + policy.issues.join('、'));
  const global = policy?.fields;
  if (global && global.sit_access !== 'allowed') return blocked('global_policy', 'AiPolicy.sit_access 未明确允许');
  if (section.status !== 'configured') return blocked('not_configured', 'status 未声明 configured');
  if (!['allowed', 'allowed_for_query'].includes(section.ai_access)) return blocked('resource_access', 'ai_access 未授予当前资源访问');
  if (!modes.has(binding.scope) || !modes.has(section.ai_operation_mode)) return blocked('unknown_policy', 'scope 或 ai_operation_mode 未识别');
  const explicit = section.allowed_operations?.split(',').map(value => value.trim()).map(value => value === 'query' ? 'read' : value);
  if (explicit?.some(operation => !operations.includes(operation))
    || [section.delete_access, section.write_access].some(access => access !== undefined && !['allowed', 'forbidden'].includes(access))) {
    return blocked('unknown_policy', 'allowed_operations、write_access 或 delete_access 含未知值');
  }
  const databasePolicy = global?.destructive_database_operations;
  if (section.resource_type === 'mysql' && databasePolicy !== undefined && databasePolicy !== 'explicit_authorization_required') {
    return blocked('unknown_policy', 'AiPolicy.destructive_database_operations 未识别');
  }
  const allowed = modes.get(binding.scope).filter(operation => modes.get(section.ai_operation_mode).includes(operation)
    && (!explicit || explicit.includes(operation)) && (operation === 'read' || section.ai_access !== 'allowed_for_query'
      && section.write_access !== 'forbidden' && (operation !== 'delete' || section.delete_access !== 'forbidden')
      && !(section.resource_type === 'mysql' && databasePolicy === 'explicit_authorization_required')));
  if (!allowed.includes('read')) return blocked('policy_conflict', '项目与配置节未共同允许回读');

  const resource = { ...section };
  if (binding.fields !== undefined) {
    const names = ['account', 'username', 'password'];
    if (!binding.fields || typeof binding.fields !== 'object' || Array.isArray(binding.fields)
      || Object.entries(binding.fields).some(([target, field]) => !names.includes(target)
        || typeof field !== 'string' || !/^[a-z][a-z0-9_]*$/.test(field) || !section[field])) {
      return blocked('credential_mapping', 'fields 只能显式映射同节非空 account、username、password');
    }
    for (const [target, field] of Object.entries(binding.fields)) resource[target] = section[field];
  }
  if (binding.database !== undefined) {
    const declared = scopedDatabase(section);
    if (typeof binding.database !== 'string' || !binding.database.trim() || binding.database === 'not_specified'
      || declared && declared !== binding.database) {
      return blocked('database_scope', '显式数据库绑定无效或与 INI 不一致');
    }
    resource.database_name = binding.database;
  }
  if (section.ssh_required === 'true' || section.direct_local_connection_allowed === 'false'
    || section.connection_mode && !['direct', 'direct_tcp'].includes(section.connection_mode)) {
    return blocked('connection_unsupported', '配置要求当前连接器不支持的接入方式');
  }
  const connector = connectors.get(section.resource_type);
  if (section.resource_type && !connector) return blocked('connector_unsupported', '该资源类型无内置需求连接器');
  if (connector === 'mysql' && (!resource.host || !resource.username || !Object.hasOwn(resource, 'password')
    || !/^\d+$/.test(resource.port ?? '') || Number(resource.port) < 1 || Number(resource.port) > 65535)) {
    return blocked('connection_fields', 'MySQL 缺有效 host、port、username 或 password');
  }
  let endpoint;
  const address = resource.base_url ?? resource.management_url;
  if (address || connector && connector !== 'mysql') {
    try {
      const url = new URL(address);
      if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password
        || [...url.searchParams.keys()].some(field => credentialField.test(field))) throw new Error();
      endpoint = url.origin + url.pathname;
      if (resource.routing_mode === 'hash' && resource.entry_route) {
        url.hash = resource.entry_route;
        resource.entry_url = url.href;
      }
    } catch { return blocked('connection_fields', '缺少有效 HTTP 入口，或入口含嵌入凭据'); }
  }
  if (connector === 'rabbitmq_management_http' && (!resource.username || !resource.password)) {
    return blocked('connection_fields', 'RabbitMQ 管理接口缺认证字段');
  }
  return { section, resource, global, allowed, connector, endpoint };
}

export async function requirementResources(environment, { allowUnavailable = false, dataDir } = {}) {
  const { name, platform, iniPath } = environment ?? {};
  if (!/^(SIT|UAT)$/.test(name) || !/^[a-zA-Z0-9]+$/.test(platform ?? '') || typeof iniPath !== 'string'
    || !path.isAbsolute(iniPath) || !Object.keys(environment.resources ?? {}).length) {
    throw new RequirementWait('environment_config', '测试必须绑定有明确资源范围的 SIT 或 UAT 环境。');
  }
  const read = async () => {
    const ini = await readFile(iniPath, 'utf8').catch(() => { throw new RequirementWait('environment_config', '无法读取本项目的非生产资源配置。'); });
    if (environment.iniSha256 !== undefined && createHash('sha256').update(ini).digest('hex') !== environment.iniSha256) {
      throw new RequirementWait('environment_config', '已固定的非生产资源配置摘要不符。');
    }
    return parse(ini);
  };
  const sections = await read(), keyMaterial = await resourceBindingKey(dataDir);
  const permitted = new Map(), unavailable = Object.create(null), secrets = new Set();
  const snapshot = item => [item.section, item.global];
  const rememberSecret = value => {
    if (typeof value !== 'string' || !value) return;
    secrets.add(value);
    if (value.length >= 4) secrets.add(encodeURIComponent(value));
  };
  for (const [key, binding] of Object.entries(environment.resources)) {
    const item = inspectBinding(environment, binding, sections);
    if (item.code) {
      unavailable[key] = { status: 'unavailable', code: item.code, detail: item.detail };
      if (!allowUnavailable) throw new RequirementWait('environment_config', '资源权限与已绑定测试环境不符：' + key + ' · ' + item.detail);
      continue;
    }
    permitted.set(key, { ...item, binding });
    const { resource } = item;
    for (const [field, value] of Object.entries(resource)) if (credentialField.test(field)) rememberSecret(value);
    if (resource.username && resource.password) rememberSecret(Buffer.from(resource.username + ':' + resource.password).toString('base64'));
  }
  if (!permitted.size) throw new RequirementWait('environment_config', '没有归属和权限明确的非生产测试资源。' + Object.entries(unavailable)
    .map(([key, value]) => key + ' · ' + value.detail).join('；'));
  const authorize = async (key, operation) => {
    const item = permitted.get(key);
    const denied = detail => new RequirementWait('environment_scope', '资源归属或操作权限未通过非生产环境校验：' + key + ' · ' + detail);
    if (!item?.allowed.includes(operation)) throw denied(unavailable[key]?.detail ?? '当前绑定未授予 ' + operation);
    let current;
    try { current = inspectBinding(environment, item.binding, await read()); }
    catch (error) { throw denied(error instanceof RequirementWait ? error.message : '无法重读配置'); }
    if (current.code) throw denied(current.detail);
    if (digest(snapshot(current)) !== digest(snapshot(item))) throw denied('绑定节、身份或策略已变化，需要重新核验');
    return item.resource;
  };
  const checkOutput = value => {
    const encoded = JSON.stringify(value);
    if (encoded && [...secrets].some(secret => {
      const literal = JSON.stringify(secret);
      return encoded.includes(secret.length >= 4 ? literal.slice(1, -1) : literal);
    })) throw new RequirementWait('execution_evidence', '适配器回执含未脱敏凭据，结果未登记。');
    return value;
  };
  return {
    names: [...permitted.keys()],
    catalog: checkOutput({ ...unavailable, ...Object.fromEntries([...permitted].map(([key, item]) => [key, {
      section: item.binding.section, scope: item.binding.scope, environment: item.section.environment, resource_type: item.section.resource_type,
      ...(item.endpoint ? { [item.connector === 'rabbitmq_management_http' ? 'management_url' : 'base_url']: item.endpoint } : {}),
      database_name: item.resource.database_name, account_role: item.section.account_role, status: item.section.status, connector: item.connector,
      ai_access: item.section.ai_access, ai_operation_mode: item.section.ai_operation_mode, allowedOperations: item.allowed,
      databaseWriteAuthorizationRequired: item.section.resource_type === 'mysql' && item.global?.destructive_database_operations === 'explicit_authorization_required',
      reversibleSharedWrites: item.binding.reversibleSharedWrites === true && item.allowed.includes('update'), sharedTargets: item.binding.sharedTargets ?? [],
    }])) }),
    async assertWrite(key, operation) {
      if (operation === 'read') throw new RequirementWait('environment_scope', '写入接口不接受只读权限。');
      await authorize(key, operation);
    },
    async assertRead(key) { await authorize(key, 'read'); },
    identity(key) {
      const item = permitted.get(key);
      return item ? 'v2:' + createHmac('sha256', keyMaterial).update(digest([iniPath, item.binding, snapshot(item)])).digest('hex') : null;
    },
    checkOutput, rememberSecret,
    async use(key, operation, fn) { return fn({ ...await authorize(key, operation) }); },
  };
}
