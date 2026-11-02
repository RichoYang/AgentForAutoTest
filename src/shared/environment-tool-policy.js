import {validateWebsiteNavigationSelectors} from './website-controls.js';
import {validateTctQuery} from './tct-policy.js';
import {validateWebsiteReadEndpoints} from './website-policy.js';
const ident = x => typeof x === 'string' && /^[A-Za-z_][A-Za-z0-9_]{0,63}$/.test(x);
export function validateToolQuery(e, q) {
  if(q.readNavigationSelectors!==undefined){if(e.kind!=='website'||q.mode!=='investigate'||q.reviewed!==true)throw Error('导航适配仅限审核后的网站只读调查');validateWebsiteNavigationSelectors(q.readNavigationSelectors);}
  if(q.readEndpoints!==undefined){if(e.kind!=='website'||q.mode!=='investigate'||q.reviewed!==true)throw new Error('固定只读接口仅支持审核后的网站排查');validateWebsiteReadEndpoints(q.readEndpoints);}
  if (q.browser !== undefined && (typeof q.browser !== 'boolean' || !['nacos','website'].includes(e.kind) || q.mode !== 'investigate')) throw new Error('浏览器只支持已授权的Nacos工具排查');
  if(q.exportMaxRows!==undefined&&(!['mysql','mongodb'].includes(e.kind)||q.mode!=='investigate'||(q.exportMaxRows!=='all'&&(!Number.isSafeInteger(q.exportMaxRows)||q.exportMaxRows<1))))throw new Error('完整报表行数须为MySQL排查的all或正安全整数，由管理员配置');
  if(q.exportTimeoutMs!==undefined&&(!q.exportMaxRows||!Number.isInteger(q.exportTimeoutMs)||q.exportTimeoutMs<1000))throw new Error('兼容exportTimeoutMs字段须为至少1000毫秒；完整查询不再按整批时限截停');
  if(q.exportDataBudgetBytes!==undefined&&(!q.exportMaxRows||!Number.isSafeInteger(q.exportDataBudgetBytes)||q.exportDataBudgetBytes<1))throw new Error('任务数据预算须为正安全整数字节，仅由管理员配置');
  if(q.exportSnapshotWindowMs!==undefined&&(!q.exportMaxRows||!Number.isInteger(q.exportSnapshotWindowMs)||q.exportSnapshotWindowMs<60000))throw new Error('显式报表取数窗口须为至少60000毫秒，仅由管理员按数据变化频率配置');
  if(e.kind==='tct')validateTctQuery(q);
  if (q.mode !== 'investigate') return false;
  if (q.parameters.length !== 1 || q.parameters[0].name !== 'purpose' || q.parameters[0].type !== 'string') throw new Error('排查必须绑定本次目的');
  // Legacy maxCalls is accepted for compatibility, but no longer controls investigation.
  if (q.maxCalls !== undefined && (!Number.isInteger(q.maxCalls) || q.maxCalls < 1)) throw new Error('排查工具次数无效');
  if (e.kind === 'nacos' && (!Array.isArray(q.namespaces) || !q.namespaces.length || q.namespaces.length > 20 || q.namespaces.some(x => typeof x !== 'string' || x.length > 128))) throw new Error('需明确 Nacos 命名空间范围');
  if (e.kind === 'mysql' && (!Array.isArray(q.tables) || !q.tables.length || q.tables.some(x => x !== '*' && !ident(x)))) throw new Error('需明确数据库表范围');
  if(e.kind==='mongodb'&&(!Array.isArray(q.collections)||!q.collections.length||q.collections.some(c=>typeof c!=='string'||! /^[\p{L}\p{N}_][\p{L}\p{N}_.-]*\*?$/u.test(c)||c.startsWith('system.'))))throw new Error('需明确MongoDB集合名或前缀范围');
  return true;
}
