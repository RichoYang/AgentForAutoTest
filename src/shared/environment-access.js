import {validateTct} from './tct-policy.js';
import { validateSshTransport } from './ssh-transport-policy.js';
import { canonicalWebsite, validateWebsiteAliases } from './website-aliases.js';
import { websiteUrl,websiteNavigationTarget } from './website-policy.js';
import { validateAccountPolicy } from './database-account-policy.js';
import { validateToolQuery } from './environment-tool-policy.js';
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';
export const environmentFile = () => path.resolve(process.env.AGENTOS_ENVIRONMENTS_FILE ?? './config/environments.local.json');
const id = (s) => typeof s === 'string' && /^[a-zA-Z][a-zA-Z0-9_-]{0,63}$/.test(s);
const sensitive = /password|passwd|secret|token|credential|private.?key|身份证|手机号|银行卡/i;
export const fingerprint = (value) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
export function queryTimeout(config,e,q){return q.mode==='investigate'&&['mysql','mongodb'].includes(e.kind) ? (e.kind==='mongodb'?config.executionPolicy?.mongodbQueryTimeoutMs:config.executionPolicy?.mysqlQueryTimeoutMs)??q.timeoutMs : q.timeoutMs;}
export async function loadEnvironments(file = environmentFile()) {
  let v;
  try { v = JSON.parse(await readFile(file, 'utf8')); }
  catch (e) { if (e.code === 'ENOENT') return { version: 1, environments: {} }; throw new Error('环境配置无法读取或解析；未执行查询'); }
  if (v.version !== 1 || !v.environments || typeof v.environments !== 'object' || Array.isArray(v.environments)) throw new Error('环境配置版本错误');
  if(v.executionPolicy?.mysqlQueryTimeoutMs!==undefined&&(!Number.isSafeInteger(v.executionPolicy.mysqlQueryTimeoutMs)||v.executionPolicy.mysqlQueryTimeoutMs<100))throw new Error('查询执行时限须为有效毫秒数');
  if(v.executionPolicy?.mongodbQueryTimeoutMs!==undefined&&(!Number.isSafeInteger(v.executionPolicy.mongodbQueryTimeoutMs)||v.executionPolicy.mongodbQueryTimeoutMs<100))throw new Error('MongoDB单次查询时限须为有效毫秒数');
  validateWebsiteAliases(v);
  for (const [key, e] of Object.entries(v.environments)) {
    if (Object.keys(e).some((k) => !['projectId','tier','kind','credentialRef','ownerOpenIdsByProfile','membersRead','queries','host','port','database','tls','baseUrl','accountPolicy','businessAccountAuthorization','transport','applicationRoot','authSource','readConcern','tct'].includes(k)) || !id(key) || !id(e.projectId) || !['uat', 'prd'].includes(e.tier) || !['mysql', 'mongodb', 'nacos', 'website','tct'].includes(e.kind)
      || !id(e.credentialRef) || typeof e.membersRead !== 'boolean' || !e.ownerOpenIdsByProfile || !e.queries) throw new Error('环境配置字段无效');
    if(e.applicationRoot!==undefined&&(e.kind!=='website'||typeof e.applicationRoot!=='boolean'))throw new Error('applicationRoot仅能用于网站应用入口且必须为布尔值');
    if(e.readConcern!==undefined&&(e.kind!=='mongodb'||!['local','majority'].includes(e.readConcern)))throw new Error('readConcern仅支持MongoDB的local/majority');
    if(e.kind==='tct')validateTct(e);else if(e.tct!==undefined)throw Error('tct仅用于调度环境');
    validateAccountPolicy(e);
    if(e.transport){if(!['mysql','mongodb'].includes(e.kind))throw new Error('SSH传输仅支持已登记数据库');validateSshTransport(e.transport);}
    if(e.kind==='website')websiteUrl(e.baseUrl);
    if (Object.values(e.ownerOpenIdsByProfile).some((ids) => !Array.isArray(ids) || ids.some((x) => !/^ou_[A-Za-z0-9]+$/.test(x)))) throw new Error('环境审批人配置无效');
    if(e.kind==='mongodb'&&(!e.transport||!/^[a-zA-Z0-9.:-]+$/.test(e.host)||!Number.isInteger(e.port)||e.port<1||e.port>65535||!/^[A-Za-z][A-Za-z0-9_-]{0,63}$/.test(e.database)||!/^[A-Za-z][A-Za-z0-9_-]{0,63}$/.test(e.authSource??e.database)))throw new Error('MongoDB必须指定固定数据库、认证库及SSH远程执行，不支持本机连接');
    if (e.kind === 'mysql' && (!/^[a-zA-Z0-9.:-]+$/.test(e.host) || !Number.isInteger(e.port) || e.port < 1 || e.port > 65535 || !id(e.database))) throw new Error('数据库目标配置无效');
    if (e.kind === 'nacos') { const u = new URL(e.baseUrl); if (!['http:', 'https:'].includes(u.protocol) || u.username || u.password || u.search || u.hash || u.pathname.replace(/\/$/, '') !== '/nacos') throw new Error('Nacos 地址必须是固定 /nacos 根路径'); }
    for (const [qid, q] of Object.entries(e.queries)) {
      if (!id(qid) || q.reviewed !== true || typeof q.description !== 'string' || !q.description.trim() || q.description.length > 200
        || !Number.isInteger(q.maxRows) || q.maxRows < 1 || q.maxRows > 200 || !Number.isInteger(q.timeoutMs) || q.timeoutMs < 100 || q.timeoutMs > 10000 || !Array.isArray(q.parameters)) throw new Error('查询模板尚未审核或限制无效');
      if (q.parameters.some((p) => !id(p.name) || sensitive.test(p.name) || !['string', 'integer'].includes(p.type))) throw new Error('查询参数定义无效');
      if (validateToolQuery(e, q)) continue;
      if (e.kind === 'mysql') {
        if (typeof q.sql !== 'string' || !/^SELECT\s/i.test(q.sql.trim()) || /;|--|\/\*|\b(INTO|OUTFILE|DUMPFILE|FOR\s+UPDATE|LOCK|SLEEP|BENCHMARK|LOAD_FILE|GET_LOCK)\b/i.test(q.sql)
          || (q.sql.match(/\?/g) ?? []).length !== q.parameters.length || !Array.isArray(q.outputColumns) || !q.outputColumns.length || q.outputColumns.length > 12
          || q.outputColumns.some((x) => !id(x) || sensitive.test(x))) throw new Error('只允许审核后的单条 SELECT、绑定参数和非敏感输出列');
      } else if (typeof q.dataId !== 'string' || !q.dataId || typeof q.group !== 'string' || typeof q.namespace !== 'string' || q.parameters.length) throw new Error('Nacos 必须固定 namespace/group/dataId，不能由模型指定 URL');
    }
  }
  return v;
}
export function isEnvironmentOwner(e, actor) { return (e.ownerOpenIdsByProfile?.[actor.profile] ?? []).includes(actor.senderId); }
export function catalog(config, projectId) {
  return Object.entries(config.environments).filter(([, e]) => e.projectId === projectId && (e.kind !== 'website' || canonicalWebsite(config, projectId, e.tier, e.baseUrl) === websiteUrl(e.baseUrl))).map(([environmentId, e]) => ({ environmentId, tier: e.tier, kind: e.kind,
    queries: Object.entries(e.queries).map(([queryId, q]) => ({ queryId, description: q.description, ...(e.kind==='mysql'&&q.mode==='investigate'?{capabilities:['database_clock：固定只读查询核对数据库会话时间、UTC、偏移和时区，业务字段时区另按源码核实','filters支持is_null/is_not_null固定空值判断，value省略或null，仍须真实schema字段','group_dataset与linked_group_dataset支持实际分组字段，按实际唯一主键和全部所需字段分组可保留完整原始记录；compose_report支持实际所需列，宽表自动小页读取，不删列' ]}:{}), ...(e.kind==='tct'?{capabilities:['TCT分组、任务时间规则/状态与执行批次；固定只读接口和分组隔离；完整分页，不暴露任务参数、日志或凭据；不能触发/停止/修改任务，也不能把调度更新时间视为应用部署时间']}:{}), ...(e.kind==='mongodb'?{capabilities:['MongoDB fixed read tools via SSH; collections/schema/indexes, typed date/string/int64/objectId filters; complete group_dataset across explicitly named month collections; same-job datasets and independent verification; no raw pipelines or writes']}:{ }), ...(e.kind === 'nacos' && q.mode === 'investigate' ? { capabilities: ['数据库端点解析', 'XXL-JOB非敏感管理入口、启用开关和执行器名称发现；不读取原始配置或凭据'] } : {}), ...(q.exportMaxRows?{exportMaxRows:q.exportMaxRows,exportTimeoutMs:q.exportTimeoutMs??30000,exportSnapshotWindowMs:q.exportSnapshotWindowMs??null,exportDataBudgetBytes:q.exportDataBudgetBytes??null}:{}), parameters: q.parameters, maxRows: q.maxRows, ...(q.mode === 'investigate' ? { mode: q.mode, browser: q.browser === true, progressPolicy: 'evidence-driven', scope: e.kind === 'website' ? {origin:new URL(e.baseUrl).origin,entryUrl:e.baseUrl} : e.kind === 'mysql' ? { tables: q.tables } : e.kind==='mongodb'?{collections:q.collections}:e.kind==='tct'?{groupIds:q.groupIds}:{ namespaces: q.namespaces } } : {}) })) }));
}
// Repeated capability contracts are shared, while every authorized endpoint stays visible.
export function compactCatalog(entries) {
 const profiles={},indices=new Map();
 const environments=entries.map(e=>({...e,queries:e.queries.map(q=>{
  const {queryId,description,...contract}=q,key=JSON.stringify(contract);
  let profileId=indices.get(key);
  if(!profileId){profileId='query_'+indices.size;indices.set(key,profileId);profiles[profileId]=contract;}
  return {queryId,profileId,description};
 })}));
 return {environments,queryProfiles:profiles,rule:'每个queries项用profileId引用queryProfiles中的完整参数、范围及导出能力；environmentId和queryId保持原值，不能跨环境借用。'};
}
export function routingCatalog(entries){
 const profiles={},sets={},contracts=new Map(),bindings=new Map();
 const environments=entries.map(e=>{
  const queries=e.queries.map(q=>{
   const contract={parameters:q.parameters,mode:q.mode??'template',...(q.mode==='investigate'?{purpose:'目标环境内受控只读调查',...(q.exportMaxRows?{completeExport:true}:{})}:{description:q.description})},key=JSON.stringify(contract);
   let profileId=contracts.get(key);if(!profileId){profileId='route_'+contracts.size;contracts.set(key,profileId);profiles[profileId]=contract;}
   return {queryId:q.queryId,profileId};
  });
  const key=JSON.stringify(queries);let querySetId=bindings.get(key);if(!querySetId){querySetId='set_'+bindings.size;bindings.set(key,querySetId);sets[querySetId]=queries;}
  return {environmentId:e.environmentId,tier:e.tier,kind:e.kind,querySetId};
 });
 return {environments,querySets:sets,queryProfiles:profiles,phase:'routing',rule:'environment.querySetId引用querySets的queryId/profileId列表；profileId引用参数模板。这里仅用于选择环境与参数；详细查询能力和完整范围在执行阶段按选中环境重新读取，授权不由目录决定。环境ID全部保留，禁止跨环境借用。'};
}
export function planQuery(config, request, projectId, actor, now = Date.now()) {
  const original = config.environments[request?.environmentId];
  if(original?.projectId===projectId && original.kind==='website'){
    const url=canonicalWebsite(config,projectId,original.tier,original.baseUrl);
    if(url!==websiteUrl(original.baseUrl)){
      const target=Object.entries(config.environments).find(([,e])=>e.projectId===projectId&&e.tier===original.tier&&e.kind==='website'&&websiteUrl(e.baseUrl)===url);
      if(!target)throw new Error('正确业务域名尚未登记；需发现并登记更正后的入口');
      request={...request,environmentId:target[0]};
    }
  }
  const e = config.environments[request?.environmentId], q = e?.queries?.[request?.queryId];
  if (!e || e.projectId !== projectId || !q) throw new Error('环境或查询模板未配置；请管理员在本机配置');
  if (!Array.isArray(request.parameters) || request.parameters.length !== q.parameters.length) throw Object.assign(new Error('查询参数不完整'), {queryDiagnostic:{code:'PARAMETER_COUNT',expected:q.parameters.length,actual:Array.isArray(request.parameters)?request.parameters.length:null}});
  const parameters = q.parameters.map((p, i) => {
    const v = request.parameters[i];
    if (p.type === 'integer') { if (!/^-?\d+$/.test(String(v)) || !Number.isSafeInteger(Number(v)) || Number(v) < (p.min ?? 0) || Number(v) > (p.max ?? 1000000000)) throw Object.assign(new Error('查询数值参数超出范围'),{queryDiagnostic:{code:'INTEGER_PARAMETER',index:i,min:p.min??0,max:p.max??1000000000}}); return Number(v); }
    const maxLength=q.mode==='investigate'&&p.name==='purpose'?Infinity:Math.min(p.maxLength??100,200);
    if (typeof v !== 'string' || !v.length || v.length > maxLength || /[\x00-\x1f\x7f]/.test(v)) throw Object.assign(new Error('查询文本参数无效'),{queryDiagnostic:{code:'TEXT_PARAMETER',index:i,maxLength:Number.isFinite(maxLength)?maxLength:null,length:typeof v==='string'?v.length:null,reason:typeof v!=='string'?'type':!v.length?'empty':/[\x00-\x1f\x7f]/.test(v)?'control_characters':'length'}});
    return v;
  });
  if(request.websiteTarget!==undefined&&e.kind!=='website')throw new Error('网页目标不能用于其他环境类型');
  const websiteTarget=request.websiteTarget!==undefined?websiteNavigationTarget(request.websiteTarget,e.baseUrl):undefined;
  const scope = { expiresAt: new Date(now + 15 * 60000).toISOString(), approvalProfile: actor.profile, environmentId: request.environmentId, queryId: request.queryId, projectId, parameters, configHash: fingerprint(e), maxRows: q.maxRows, timeoutMs: queryTimeout(config,e,q) };
  if(websiteTarget)scope.websiteTarget=websiteTarget;
  const approvalRequired = false;
  return { ...scope, description: q.description + (q.mode === 'investigate' ? `；范围：${e.kind === 'website' ? new URL(e.baseUrl).origin : e.kind === 'nacos' ? q.namespaces.map(x => x || 'public').join(', ') : (e.kind==='tct'?q.groupIds:e.kind==='mongodb'?q.collections:q.tables).join(', ')}；按证据推进，无固定调用次数上限；失败按具体原因调整工具与查询，不按固定轮次截停` : ''), tier: e.tier, kind: e.kind, scopeHash: fingerprint(scope),
    approvalRequired, approvalOwnerIds: [...(e.ownerOpenIdsByProfile[actor.profile] ?? [])], approvedBy: 'policy:read-only', approvedAt: new Date(now).toISOString() };
}
export function verifyPlan(config, plan, now = Date.now()) {
  if (!Number.isFinite(Date.parse(plan.expiresAt)) || Date.parse(plan.expiresAt) <= now) throw new Error('查询授权已过期或配置已变更，请重新申请');
  const e = verifyPlanIntegrity(config, plan);
  return e;
}

function verifyPlanIntegrity(config, plan) {
  const e = config.environments[plan.environmentId];
  if (!e || fingerprint(e) !== plan.configHash || !Number.isFinite(Date.parse(plan.expiresAt))) throw new Error('查询授权已过期或配置已变更，请重新申请');
  const scope = Object.fromEntries(['expiresAt','approvalProfile','environmentId','queryId','projectId','parameters','configHash','maxRows','timeoutMs'].map((k) => [k, plan[k]]));
  if(plan.websiteTarget!==undefined){if(e.kind!=='website'||websiteNavigationTarget(plan.websiteTarget,e.baseUrl)!==plan.websiteTarget)throw new Error('网页目标与批准内容不一致');scope.websiteTarget=plan.websiteTarget;}
  if (fingerprint(scope) !== plan.scopeHash || e.projectId !== plan.projectId) throw new Error('查询范围与批准内容不一致');
  return e;
}

function verifyApproval(e, plan) {
  const owner = (e.ownerOpenIdsByProfile[plan.approvalProfile] ?? []).includes(plan.approvedBy);
  const policy = plan.approvedBy === 'policy:read-only' && !plan.approvalRequired;
  const legacyPolicy = plan.approvedBy === 'policy:uat-read' && e.tier === 'uat' && e.membersRead && !plan.approvalRequired;
  if (!owner && !policy && !legacyPolicy) throw new Error('查询尚未批准或批准人不属于当前环境负责人');
  return e;
}

export function verifyApprovedPlan(config, plan, now = Date.now()) {
  return verifyApproval(verifyPlan(config, plan, now), plan);
}

// Expiry closes the environment tools immediately. A result that was gathered while
// the grant was live may still need a short, bounded interval for model synthesis and
// transport back to the control plane. This accepts that result without extending the
// tool grant or permitting another read.
export function verifyCompletedPlan(config, plan, evidence, now = Date.now(), graceMs = 10 * 60000) {
  const e = verifyApproval(verifyPlanIntegrity(config, plan), plan);
  const expiresAt = Date.parse(plan.expiresAt);
  if (now <= expiresAt) return e;
  const startedAt = Date.parse(plan.startedAt);
  const lastAuthorizedAt = Date.parse(evidence?.lastAuthorizedAt);
  if (!Number.isFinite(startedAt) || !Number.isFinite(lastAuthorizedAt)
    || lastAuthorizedAt < startedAt || lastAuthorizedAt > expiresAt
    || now > expiresAt + graceMs) throw new Error('[RESULT_GRACE_EXPIRED] 查询授权已关闭，且结果不符合授权期内取证后的收尾条件');
  return e;
}
