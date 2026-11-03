import {cleanWebsiteText} from '../shared/website-policy.js';
import {mongoInputDiagnostic} from './mongo-input-diagnostic.js';
import {createTctTools} from './tct-tools.js';
import {createMongoBackend,mongoToolSpec} from './mongo-tools.js';
import {sshMysqlConnection} from './ssh-mysql.js';
import {inspectReport,ReportInspectionError} from '../shared/report-inspection.js';
import {DatasetCapacityError} from './task-dataset-store.js';
import { ReportDatasets, ReportInputError } from './report-datasets.js';
import { createHash } from 'node:crypto';
import { safeExecutionError } from '../shared/failure-diagnostic.js';
import { createNacosBrowser } from './environment-browser.js';
import { boundedFetch, checkAccountGrants } from './environment-connector.js';
import { databaseEndpoints, schedulerConfiguration } from './config-endpoints.js';
const secretName = /password|passwd|secret|token|credential|private.?key|身份证|手机号|银行卡/i;
const ident = x => typeof x === 'string' && /^[A-Za-z_][A-Za-z0-9_]{0,63}$/.test(x);
const numericTypes = new Set(['tinyint','smallint','mediumint','int','integer','bigint','decimal','numeric','float','double','real']);
function safeStructured(value,depth=0,seen=new WeakSet()){
 if(value===null||value===undefined)return null;
 if(['string','number','boolean'].includes(typeof value))return value;
 if(typeof value==='bigint')return String(value);
 if(value instanceof Date)return value.toISOString();
 if(Buffer.isBuffer(value))return `[二进制 ${value.length} 字节]`;
 if(typeof value!=='object')return String(value);
 if(seen.has(value))return '[循环引用]';

 seen.add(value);
 if(Array.isArray(value))return value.map(item=>safeStructured(item,depth+1,seen));
 return Object.fromEntries(Object.entries(value)
  .filter(([key])=>!secretName.test(key)).map(([key,item])=>[key,safeStructured(item,depth+1,seen)]));
}
const bounded = (x, secrets = []) => {
 if(x===null||x===undefined)return null;
 let s=typeof x==='object'&&x!==null?JSON.stringify(safeStructured(x)):String(x??'');
 for(const v of secrets.filter(Boolean))s=s.split(v).join('[已隐藏]');
 return s;
};
export class QueryInputError extends Error {
  constructor(code, message) { super(`[${code}] ${message}`); this.code = code; }
}
function tableColumns(tables, table, q) {
  const known = tables.get(table);
  if (!ident(table) || !(q.tables.includes('*') || q.tables.includes(table))) throw new Error('查询表超出范围');
  if (!known) throw new QueryInputError('SCHEMA_REQUIRED', '目标表尚未读取结构；先调用schema并指定table，再选择实际返回的字段。');
  return known;
}
function checkedColumn(tables, table, column, q) {
  const known = tableColumns(tables, table, q);
  if (!ident(column) || secretName.test(column)) throw new Error('查询列超出范围');
  if (!known.includes(column)) throw new QueryInputError('SCHEMA_FIELDS', '字段未在已读取结构中；重新读取目标表schema或继续分页，仅使用返回的字段。');
  return column;
}
function filterClause(filters=[], tables, table, q, valueSets = new Map(), alias = '', maxFilters = 8) {
  const known = tableColumns(tables, table, q);
  if (!Array.isArray(filters)) throw new QueryInputError('QUERY_INPUT', 'filters必须为数组；空数组表示当前已授权表的完整范围，不能编造无意义条件。');
  if(!filters.length)return {where:'1=1',params:[]};
  const params = [], prefix = alias ? `\`${alias}\`.` : '';
  const where = filters.map(f => {
    if (!f || !ident(f.column) || secretName.test(f.column)) throw new Error('查询筛选列超出范围');
    if (!known.includes(f.column)) throw new QueryInputError('SCHEMA_FIELDS', '筛选字段未在已读取结构中；先读取目标表schema并使用实际字段。');
    if (['is_null','is_not_null'].includes(f.op)) {
      if(f.value!==undefined&&f.value!==null)throw new QueryInputError('QUERY_INPUT','空值筛选不接受非空value或SQL');
      return `${prefix}\`${f.column}\` IS ${f.op==='is_not_null'?'NOT ':''}NULL`;
    }
    if (f.op === 'contains') {
      if (typeof f.value !== 'string' || !f.value) throw new QueryInputError('QUERY_INPUT', 'contains需要非空字符串。');
      params.push(f.value); return `LOCATE(?, ${prefix}\`${f.column}\`) > 0`;
    }
    if (f.op === 'in_set') {
      const set = valueSets.get(f.value);
      if (!set || set.truncated || !set.values.length) throw new QueryInputError('VALUE_SET', 'in_set必须引用本轮collect_values返回的完整非空setRef。');
      params.push(...set.values); return `${prefix}\`${f.column}\` IN (${set.values.map(() => '?').join(', ')})`;
    }
    if (f.op === 'in') {
      if (!Array.isArray(f.value) || !f.value.length
        || f.value.some(v => !['string','number'].includes(typeof v) || (typeof v === 'number' && !Number.isFinite(v)))) {
        throw new QueryInputError('QUERY_INPUT', 'in需要非空字符串或有限数字列表。');
      }
      params.push(...f.value); return `${prefix}\`${f.column}\` IN (${f.value.map(() => '?').join(', ')})`;
    }
    if (!['=','>','>=','<','<='].includes(f.op) || !['string','number'].includes(typeof f.value) || (typeof f.value === 'number' && !Number.isFinite(f.value))) throw new QueryInputError('QUERY_INPUT', '筛选仅支持=、>、>=、<、<=、contains、in、is_null、is_not_null；标量value为字符串或有限数字。');
    params.push(f.value); return `${prefix}\`${f.column}\` ${f.op} ?`;
  }).join(' AND ');
  return { where, params };
}
export function selectStatement(args, tables, q, valueSets=new Map()) {
  const { table, columns, filters } = args;
  const known = tableColumns(tables, table, q);
  if (!Array.isArray(columns) || !columns.length) throw new QueryInputError('QUERY_INPUT', 'columns必须是非空字段数组。');
  if (columns.some(c => typeof c === 'string' && secretName.test(c))) throw new Error('查询列超出范围');
  if (columns.some(c => !ident(c))) throw new QueryInputError('QUERY_INPUT', 'columns仅接受schema返回的普通字段名，不能使用*、函数或表达式。');
  if (columns.some(c => !known.includes(c))) throw new QueryInputError('SCHEMA_FIELDS', '字段未在已读取结构中；重新读取目标表schema或继续分页，仅使用返回的字段。');
  const {where,params}=filterClause(filters,tables,table,q,valueSets,'',6);
  return { sql: `SELECT ${columns.map(c => `\`${c}\``).join(', ')} FROM \`${table}\` WHERE ${where} LIMIT ${q.maxRows + 1}`, params, columns };
}
// Count only validated base-table fields and filters; no model-provided SQL.
export function countStatement(args, tables, q, valueSets=new Map()) {
  const distinct = args.distinctColumns ?? [];
  if (!Array.isArray(distinct)) throw new QueryInputError('QUERY_INPUT', 'distinctColumns应为实际字段数组。');
  const columns = distinct.length ? distinct : (tables.get(args.table) ?? []).slice(0, 1);
  const base = selectStatement({ table: args.table, columns, filters: args.filters }, tables, q,valueSets);
  const from = base.sql.slice(base.sql.indexOf(' FROM ')).replace(/ LIMIT \d+$/, '');
  return { sql: `SELECT COUNT(${distinct.length ? 'DISTINCT ' + distinct.map(c => '`' + c + '`').join(', ') : '*'}) AS total${from}`, params: base.params };
}

export function groupCountStatement(args,tables,q,valueSets=new Map()){
  const groupColumns=args.groupColumns??[],minCount=args.minCount??2;
  if(!Array.isArray(groupColumns)||!groupColumns.length)throw new QueryInputError('QUERY_INPUT','groupColumns必须是实际字段的非空列表。');
  if(!Number.isSafeInteger(minCount)||minCount<2)throw new QueryInputError('QUERY_INPUT','minCount必须是大于等于2的安全整数。');
  const base=selectStatement({table:args.table,columns:groupColumns,filters:args.filters},tables,q,valueSets);
  const from=base.sql.slice(base.sql.indexOf(' FROM ')).replace(/ LIMIT \d+$/,'');
  const quoted=groupColumns.map(column=>`\`${column}\``).join(', ');
  return {sql:`SELECT ${quoted}, COUNT(*) AS duplicate_count${from} GROUP BY ${quoted} HAVING COUNT(*) >= ? ORDER BY duplicate_count DESC LIMIT ${q.maxRows+1}`,
    params:[...base.params,minCount],groupColumns};
}

const aggregateExpression = (item, tables, types, q, aliases = new Map()) => {
  if (!item || !['sum','avg','min','max','count','count_distinct'].includes(item.op)) throw new QueryInputError('QUERY_INPUT','aggregate op仅支持sum、avg、min、max、count、count_distinct。');
  const table = item.table;
  const alias = aliases.get(table) ?? '';
  if (item.op === 'count' && item.column == null) return 'COUNT(*)';
  const column = checkedColumn(tables,table,item.column,q);
  if (['sum','avg'].includes(item.op) && !numericTypes.has(types.get(table)?.get(column))) throw new QueryInputError('NUMERIC_FIELD','sum/avg只能使用schema确认的数值字段。');
  const target=`${alias ? `\`${alias}\`.` : ''}\`${column}\``;
  return item.op==='count_distinct'?`COUNT(DISTINCT ${target})`:`${item.op.toUpperCase()}(${target})`;
};
function checkedAggregates(aggregates,tables,types,q,aliases){
  if(!Array.isArray(aggregates)||!aggregates.length)throw new QueryInputError('QUERY_INPUT','aggregates须为非空数组，例如[{op:"count",as:"record_count"}]。读取完整原始行时按实际唯一主键及所需列分组并带count；不要传空数组，也不要用预览代替完整读取。');
  return aggregates.map((item,index)=>{
    const name=item.as??`metric_${index+1}`;
    if(!ident(name)||secretName.test(name))throw new QueryInputError('QUERY_INPUT','aggregate as必须是普通非敏感字段名。');
    return {name,expression:aggregateExpression(item,tables,types,q,aliases)};
  });
}
export function aggregateStatement(args,tables,types,q,valueSets=new Map()){
  tableColumns(tables,args.table,q);
  if(!Array.isArray(args.aggregates))throw new QueryInputError('QUERY_INPUT','aggregates须为非空数组，例如[{op:"count",as:"record_count"}]。读取完整原始行时按实际唯一主键及所需列分组并带count；不要传空数组，也不要用预览代替完整读取。');
  const metrics=checkedAggregates((args.aggregates??[]).map(x=>({...x,table:args.table})),tables,types,q,new Map());
  const filter=filterClause(args.filters,tables,args.table,q,valueSets);
  return {sql:`SELECT ${metrics.map(x=>`${x.expression} AS \`${x.name}\``).join(', ')} FROM \`${args.table}\` WHERE ${filter.where}`,params:filter.params,columns:metrics.map(x=>x.name)};
}
export function collectValuesStatement(args,tables,q,valueSets=new Map()){
  const columns=args.columns??[];
  if(!Array.isArray(columns)||!columns.length)throw new QueryInputError('QUERY_INPUT','columns必须是实际字段的非空列表。');
  for(const column of columns)checkedColumn(tables,args.table,column,q);
  const filter=filterClause(args.filters,tables,args.table,q,valueSets);
  return {sql:`SELECT DISTINCT ${columns.map(c=>`\`${c}\``).join(', ')} FROM \`${args.table}\` WHERE ${filter.where}`,params:filter.params,columns};
}
export function linkedAggregateStatement(args,tables,types,q,valueSets=new Map()){
  const left=args.leftTable,right=args.rightTable;
  if(left===right)throw new QueryInputError('QUERY_INPUT','关联汇总必须使用两个不同基础表。');
  tableColumns(tables,left,q);tableColumns(tables,right,q);
  const leftJoin=checkedColumn(tables,left,args.join?.leftColumn,q),rightJoin=checkedColumn(tables,right,args.join?.rightColumn,q);
  const aliases=new Map([[left,'l'],[right,'r']]);
  if(!Array.isArray(args.aggregates))throw new QueryInputError('QUERY_INPUT','aggregates须为非空数组，例如[{op:"count",as:"record_count"}]。读取完整原始行时按实际唯一主键及所需列分组并带count；不要传空数组，也不要用预览代替完整读取。');
  if((args.aggregates??[]).some(item=>!item||![left,right].includes(item.table)))throw new QueryInputError('QUERY_INPUT','每项aggregate必须指定leftTable或rightTable。');
  const metrics=checkedAggregates(args.aggregates,tables,types,q,aliases);
  const filters=args.filters??[];
  if(!Array.isArray(filters))throw new QueryInputError('QUERY_INPUT','filters必须为明确筛选条件数组。');
  const joinType=args.join?.type??'inner';
  if(!['inner','left'].includes(joinType))throw new QueryInputError('QUERY_INPUT','join.type仅支持inner或left；不能猜测关联方式。');
  const clauses=[],whereParams=[],onClauses=[],onParams=[];
  for(const table of [left,right]){
    const current=filters.filter(f=>f?.table===table).map(({table:_,...f})=>f);
    if(!current.length)continue;
    const part=filterClause(current,tables,table,q,valueSets,aliases.get(table),10);
    // Right-side eligibility belongs in ON for LEFT JOIN; WHERE would discard unmatched masters.
    if(joinType==='left'&&table===right){onClauses.push(part.where);onParams.push(...part.params);}
    else{clauses.push(part.where);whereParams.push(...part.params);}
  }
  if(filters.some(f=>!f||![left,right].includes(f.table)))throw new QueryInputError('QUERY_INPUT','每个关联筛选必须指定leftTable或rightTable。');
  if(!clauses.length)clauses.push('1=1');
  return {sql:`SELECT ${metrics.map(x=>`${x.expression} AS \`${x.name}\``).join(', ')} FROM \`${left}\` \`l\` ${joinType==='left'?'LEFT JOIN':'JOIN'} \`${right}\` \`r\` ON \`l\`.\`${leftJoin}\` = \`r\`.\`${rightJoin}\`${onClauses.length?' AND '+onClauses.join(' AND '):''} WHERE ${clauses.join(' AND ')}`,params:[...onParams,...whereParams],columns:metrics.map(x=>x.name)};
}

// Grouped datasets have a deterministic key order inside one repeatable-read snapshot.
export function groupedDatasetStatement(args,tables,types,q,valueSets=new Map(),primaryKeys=new Map()){
 const linked=args.leftTable!==undefined;
 const groups=args.groupColumns;
 if(!Array.isArray(groups)||!groups.length)throw new QueryInputError('QUERY_INPUT','groupColumns必须包含实际分组字段的非空列表。');
 const groupNames=groups.map(g=>linked?g?.column:g);
 if(new Set(groupNames).size!==groupNames.length)throw new QueryInputError('QUERY_INPUT','分组输出字段不能重名');
 const quoted=groups.map(g=>{
  const table=linked?g?.table:args.table,column=linked?g?.column:g;
  if(linked&&![args.leftTable,args.rightTable].includes(table))throw new QueryInputError('QUERY_INPUT','分组字段必须指定已关联的左表或右表');
  checkedColumn(tables,table,column,q);return `${linked?(table===args.leftTable?'`l`.':'`r`.'):''}\`${column}\``;
 });
 const base=linked?linkedAggregateStatement(args,tables,types,q,valueSets):aggregateStatement(args,tables,types,q,valueSets);
 if(base.columns.some(c=>groupNames.includes(c))||new Set(base.columns).size!==base.columns.length)throw new QueryInputError('QUERY_INPUT','分组字段与指标别名不能重复');
 if(args.rowKey!==undefined&&(!ident(args.rowKey)||['__proto__','constructor','prototype'].includes(args.rowKey)||secretName.test(args.rowKey)||[...groupNames,...base.columns].includes(args.rowKey)))throw new QueryInputError('QUERY_INPUT','rowKey必须是不与输出列重名的非敏感普通字段名。');
 let cursor;
 const owner=linked?groups[0]?.table:args.table,pk=primaryKeys.get(owner);
 if(pk?.length===1&&groupNames.includes(pk[0])&&(!linked||groups.every(g=>g.table===owner))){
  const alias=linked?(owner===args.leftTable?'`l`.':'`r`.'):'';
  let keys=[pk[0]];
  if(linked&&owner===args.rightTable){
   const leftPk=primaryKeys.get(args.leftTable);
   if((args.join?.type??'inner')==='inner'&&leftPk?.length===1&&leftPk[0]===args.join.leftColumn&&groupNames.includes(args.join.rightColumn))keys=[args.join.rightColumn,...keys.filter(k=>k!==args.join.rightColumn)];
   else if((args.join?.type??'inner')==='left')keys=[];
  }
  if(keys.length)cursor={columns:keys,expressions:keys.map(k=>alias+'`'+k+'`')};
 }
 const singleton=cursor&&(!linked||(owner===args.rightTable&&(args.join?.type??'inner')==='inner'&&primaryKeys.get(args.leftTable)?.length===1&&primaryKeys.get(args.leftTable)[0]===args.join.leftColumn));
 const rawProjection=singleton&&args.aggregates.every(a=>a.op==='count'&&(a.column==null||a.column===pk[0]&&(!linked||a.table===owner)));
 const projected=rawProjection?base.sql.replace(/^SELECT .*? FROM /,`SELECT ${quoted.join(', ')}, ${base.columns.map(name=>'1 AS `'+name+'`').join(', ')} FROM `):null;
 // A verified unique cursor already totally orders these rows/groups. Extra
 // projected fields defeat index ordering on MySQL and repeat a wide filesort per page.
 const order=cursor?cursor.expressions:quoted;
 return {...base,...(cursor?{cursor,batchSize:50}:groupNames.length>12?{batchSize:Math.max(5,Math.floor(1000/(groupNames.length+base.columns.length)))}:{}),sql:projected?projected+` ORDER BY ${order.join(', ')}`:base.sql.replace(/^SELECT /,`SELECT ${quoted.join(', ')}, `)+` GROUP BY ${quoted.join(', ')} ORDER BY ${order.join(', ')}`,columns:[...groupNames,...base.columns],...(args.rowKey?{rowKey:{column:args.rowKey,fields:groupNames}}:{}),numericColumns:args.aggregates.filter(a=>['sum','avg','count','count_distinct'].includes(a.op)||numericTypes.has(types.get(a.table??args.table)?.get(a.column))).map(a=>a.as)};
}

export async function createEnvironmentTools(e, q, cred, adapters = {}) {
  if(e.kind==='tct')return createTctTools(e,q,cred,adapters);
  const secrets = [cred.username, cred.password]; let conn, token, active = true;
  const configs = new Map(), tables = new Map(), columnTypes = new Map(), tableEngines=new Map(), primaryKeys=new Map(), valueSets = new Map();
  const datasets=new ReportDatasets({deploymentScope:{projectId:adapters.reportJob?.projectId,environment:adapters.reportJob?.sourceEnvironment??e.tier},reuseQueries:true,dataBudgetBytes:q.exportDataBudgetBytes??Number.MAX_SAFE_INTEGER,snapshotWindowMs:q.exportSnapshotWindowMs??null,originalQuestion:adapters.originalQuestion,datasetScopes:adapters.datasetScopes,scope:createHash('sha256').update(JSON.stringify(e)).digest('hex'),secrets,maxRows:q.exportMaxRows,previewRows:q.maxRows,directory:adapters.exportDirectory,authorize:adapters.authorize,active:()=>active,onProgress:adapters.onProgress});
  const mongo=e.kind==='mongodb'?createMongoBackend(e,q,cred,{...adapters,datasets,valueSets}):null;
  const request = adapters.fetch ?? boundedFetch;
  const readCache = new Map(); let readCacheBytes = 0;
  // Only one live MySQL readonly transaction. Never import results from another task or snapshot.
  async function read(connection, statement, parameters) {
    const key=JSON.stringify([statement.sql,parameters]);
    if(readCache.has(key))return structuredClone(readCache.get(key));
    const value=await connection.execute(statement,parameters);
    const bytes=Buffer.byteLength(JSON.stringify(value[0],(_,v)=>typeof v==='bigint'?String(v):v));
    if(bytes<=256000&&readCacheBytes+bytes<=2000000&&readCache.size<64){
      // mysql FieldPacket objects are not part of business evidence; cache just rows.
      readCache.set(key,[structuredClone(value[0])]);readCacheBytes+=bytes;
    }
    return value;
  }

  async function nacos(api, params = {}, login = false) {
    if (!active) throw new Error('工具执行已结束');
    const url = new URL(e.baseUrl.replace(/\/$/, '') + api);
    let options = { signal: AbortSignal.timeout(q.timeoutMs) };
    if (login) options = { ...options, method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ username: cred.username, password: cred.password }) };
    else { if (!token) throw new Error('先执行 connection 工具登录'); url.search = new URLSearchParams({ ...params, accessToken: token }).toString(); }
    return request(url, options);
  }
  async function mysql() {
    if (!conn) {
      const driver = adapters.mysql ?? await import('mysql2/promise');
      conn = e.transport ? await sshMysqlConnection(e,q,cred,adapters) : await driver.createConnection({ host: e.host, port: e.port, database: e.database, user: cred.username, password: cred.password, connectTimeout: q.timeoutMs, multipleStatements: false, enableCleartextPlugin: false,
        // Business IDs frequently exceed Number.MAX_SAFE_INTEGER. Keep BIGINT/DECIMAL values lossless so a value returned by one read can be used by the next read unchanged.
        supportBigNumbers: true, bigNumberStrings: true, dateStrings: true,
        ...(e.tls ? { ssl: { rejectUnauthorized: true } } : {}) });
      if (!active) { conn.destroy(); conn = null; throw new Error('连接已超时'); }
      try { const [g] = await conn.query({sql:'SHOW GRANTS FOR CURRENT_USER',timeout:q.timeoutMs}); checkAccountGrants(e, g); await conn.query({sql:`SET SESSION MAX_EXECUTION_TIME=${q.timeoutMs}`,timeout:q.timeoutMs}); await conn.query({sql:'SET TRANSACTION ISOLATION LEVEL REPEATABLE READ',timeout:q.timeoutMs}); await conn.query({sql:'START TRANSACTION READ ONLY',timeout:q.timeoutMs}); }
      catch (error) { conn.destroy(); conn = null; throw error; }
    }
    return conn;
  }
  const spec = e.kind === 'nacos' ? [
    { tool: 'connection', args: {}, description: '测试固定 Nacos 入口的 HTTP 登录，凭据留在本机' },
    { tool: 'discover', args: {}, description: '列出批准的命名空间内最多100条配置的引用和名称，不返回正文' },
    { tool: 'read_runtime_config', args: { ref: '从discover返回的ref' }, description: '读取已发现配置中的XXL-JOB管理台地址、启用开关和执行器名称；不返回正文或凭据。定时任务排查使用此工具，发现入口后由原问题继续网页调查。' },
    { tool: 'read_config', args: { ref: '从discover返回的ref' }, description: '读取一个已发现配置并解析同文件变量，仅返回数据库端点与解析状态' }
  ] : e.kind==='mongodb'?mongoToolSpec(q):[
    { tool: 'connection', args: {}, description: '测试数据库连接、只读账号授权与只读事务' },
    { tool: 'database_clock', args: {}, description: '读取固定SQL返回的数据库会话时间、UTC时间、UTC偏移与时区设置，核对过去一周等日期窗口；不接受SQL或参数，不读业务表。数据库会话时区不等于DATETIME字段业务时区，仍需结合字段类型及源码。' },
    { tool: 'tables', args: {cursor:'可选：nextCursor，默认0'}, description:'分页列出允许的基础表名称，先定位目标表再用schema读取列' },
    { tool: 'schema', args: { table: '可选：限定基础表名', columns: ['可选：要定向发现的准确字段名，最多20个；使用时必须提供table'], search:'可选：在已授权表的表名、表注释、字段名及字段注释中按非空字面文本检索；不是SQL或正则', cursor: '可选：上次返回的nextCursor，默认0' }, description: '返回当前数据库真实库名、普通字段、SQL类型/长度精度/可空性及注释；tables兼容旧字段名结构，columnMetadata给出物理元数据。先用table定向；业务标签没有映射时用search查注释，按nextCursor读完，未匹配不是业务不存在。不读业务数据，不跨库。' },
    { tool: 'count', args: { table: 'schema返回的表', distinctColumns: '可选：去重字段数组；空数组统计行数，非空按这些字段组合去重（不计含NULL的组合）', filters: '与select相同的明确筛选条件' }, description: '统计批准基础表筛选范围内的完整行数或指定字段组合去重数，不用样本行数代替总数，不支持任意SQL或联表' },
    { tool: 'group_count', args: { table: 'schema返回的表', groupColumns: ['用于判断重复的实际字段的非空列表'], minCount: '最小重复数，默认2', filters: '与select相同的明确筛选条件' }, description: `按业务字段组合分组统计重复记录，返回重复最多的${q.maxRows}组；仅单表参数化查询。总行数大于业务去重数、疑似重复批次或重复提交时优先使用` },
    { tool: 'aggregate', args: {table:'schema返回的表',aggregates:[{op:'sum|avg|min|max|count|count_distinct',column:'count可省略，其余使用schema字段',as:'结果名'}],filters:'与select相同；可用本轮setRef作为in_set'},description:'在一个基础表内执行最多6项受控汇总；sum/avg仅允许schema确认的数值字段，不接受SQL表达式' },
    { tool: 'collect_values', args: {table:'schema返回的表',columns:['合并收集值的实际字段的非空列表'],filters:'与select相同'},description:'从一个表的多列完整收集去重值，返回本轮setRef和少量样本；后续aggregate或linked_aggregate可用in_set引用完整集合，适合组织层级等中间集合' },
    { tool: 'linked_aggregate', args: {leftTable:'左表',rightTable:'右表',join:{leftColumn:'左表关联字段',rightColumn:'右表关联字段'},aggregates:[{op:'sum|avg|min|max|count|count_distinct',table:'左表或右表',column:'字段',as:'结果名'}],filters:[{table:'左表或右表',column:'字段',op:'=|>|>=|<|<=|contains|in|in_set',value:'值或setRef'}]},description:'仅允许两个已读取基础表按一个等值字段关联并做受控汇总；所有表、列、数值类型和筛选均由程序校验，不接受任意SQL' },
    { tool: 'select', filterOperators:['=','>','>=','<','<=','contains','in','in_set','is_null','is_not_null'], args: { table: 'schema返回的表', columns: ['字段'], filters: [{ column: '字段', op: '=|>|>=|<|<=|contains|in', value: '标量；in使用数组' }] }, description: `按明确条件读取最多${q.maxRows}行；columns使用实际已读取字段，filters为明确条件数组，空数组表示已授权表完整范围；contains执行参数化子串匹配，in使用参数化绑定值；仅基础表，不允许任意SQL、联表或写入` }
  ];
  if(['mysql','mongodb'].includes(e.kind)&&q.exportMaxRows){
    spec.push({tool:'collect_dataset_values',args:{datasetRef:'complete task dataset',columns:['existing cohort key'],nulls:'exclude/error'},description:'Collect ALL unique keys from a saved complete authorized dataset without re-querying or sampling. Returns an in_set setRef valid in this worker; recreate locally after reconnect. Use for full cross-source populations; never infer zero activity from an empty set.'},{tool:'enrich_dataset',args:{datasetRef:'完整主对象数据集',keyColumn:'主对象唯一编码列',lookups:[{name:'area',datasetRef:'完整维度数据集',sourceColumn:'主对象已有列或上一步输出列',targetColumn:'维度唯一键',fields:[{column:'维度列',as:'新的输出列名'}],missing:'empty或error，必须明确',fallbackKey:'可选，源码已证实的默认配置关联键，须在同一完整维度数据中实际存在'}]},description:'同一任务内按实际关联键左连接维度，按实际依赖逐步关联；可以沿显式parent键多级查名称。不执行SQL，不接受路径/表达式，不丢主对象。专属配置缺失且源码明确规定沿用通用配置时，可传fallbackKey（实际存在的默认行键），把生效值写入每行并标记沿用默认配置；不能猜默认键或常量。重复维度键拒绝猜选；missing=empty保留未匹配并写入name_status，返回未匹配数量。保留原取数时间，仍需最终核验。'}, {tool:'inspect_dataset',args:{offset:'Optional 0-based row offset',limit:'Optional 1..100 rows, default20; continue nextOffset',columns:['Optional actual columns for narrow row preview'],datasetRef:'任务内数据集引用'},description:'查看已有数据集实际SQL、筛选参数、取数时间，或草稿列公式和来源；列表预览截断时使用。结果limited仍为true时不能猜测未展示条件。'}, {tool:'finalize_report',args:{datasetRef:'compose_report草稿引用',requirement:'原问题的交付要求，不缩减范围',expectedColumns:['按用户要求的完整列标题，顺序一致'],scopeEvidence:'完整对象范围的源码/文档依据及期间条件',populationRef:'独立原始范围数据集',populationKey:'业务主键',columnRules:[{label:'逐列标题',definition:'业务定义和公式',evidence:'源码或文档位置及实际规则'}],checks:[{source:'s1',column:'amount',referenceRef:'不同原始查询的完整分量合计基准集',referenceColumn:'amount',evidence:'与该分量同期间/状态/费用范围的独立汇总依据'}]},description:'草稿最终核验：missing=empty的原始金额保留为空，仅核对已知金额并登记缺失数；不能当0或参与加减。列顺序完全一致、完整业务对象集合相等、计算/total的所有来源分量与不同原始查询的基准集精确合计一致、取数窗口按管理员的exportSnapshotWindowMs配置（默认不以跨轮时长拒绝），返回实际起止时间；不等于同一事务。不能以草稿或同一查询自证；业务依据仍须源码核实。只有此工具返回exportFile，compose_report只产出draftFile。'}, {tool:'compare_datasets',args:{leftRef:'左数据集引用',rightRef:'右数据集引用',leftKey:'左主键列',rightKey:'右主键列'},description:'在任务内精确比较两个完整数据集的业务主键；返回各自数量、匹配数、左右缺失数量和有限缺失行预览，不重新查询数据库。不接受任意文件路径。'}, {tool:'list_datasets',args:{kind:'Optional query/derived/report_draft',columns:['Optional required columns; filters catalog before pagination'],offset:'可选非负整数，默认0',limit:'可选1至20，默认20；按nextOffset继续'},description:'列出当前任务在同项目同环境、经当前只读策略授权的各业务库已完整读取并持久保存的数据集、字段、取数时间和摘要。新一轮先查看已有成果，compose_report可直接引用这些datasetRef，不要重复查询已取得的金额。跨轮引用需核对取数时点；不能把旧数据当实时状态。'}, {tool:'group_dataset',args:{table:'已读取结构的表',groupColumns:['对象主键等分组字段'],rowKey:'可选，生成分组组合行键的输出列名，如row_key',aggregates:[{op:'sum',column:'数值字段',as:'amount'}],filters:'与aggregate相同'},description:`按实际分组字段汇总并由程序连续分页取完，${q.exportMaxRows==='all'?'不预设总行数，直到实际分页结束':'最多'+q.exportMaxRows+'组'}；返回datasetRef、完整性和少量预览。不是前${q.maxRows}行样本；可用于客户、项目、仓库、组织等完整对象报表。`},
    {tool:'linked_group_dataset',args:{leftTable:'左表',rightTable:'右表',join:{leftColumn:'字段',rightColumn:'字段',type:'可选inner或left，默认inner'},groupColumns:[{table:'左表或右表',column:'对象主键'}],rowKey:'可选，如row_key，为所有分组字段生成稳定组合行键',aggregates:'与linked_aggregate相同',filters:'与linked_aggregate相同'},description:'两表受控等值关联后分组汇总并完整分页；schema核验唯一主键后，同一表原始字段记录自动用游标读取；每明细只关联一个主对象且仅计数时自动等价消除多余分组，不需要手工按天切片或改成样本；一对多按实际明细粒度分组，须保留没有明细的主对象时指定join.type=left。left模式左表范围按显式filters确定，空数组表示已授权完整左表；右表filters在ON中筛选匹配明细，未匹配右字段为null，不能当0。需要导出一对象多行时指定rowKey，compose_report用返回的组合行键，独立范围查询也按相同分组生成rowKey核对；该键不是业务编号。不能重复累计左侧金额；enrich_dataset仅用于唯一维度查找，不能用于展开一对多。'},
    {tool:'deployment_evidence',args:{recordOffset:'可选非负整数，按nextOffset续读',limit:'展示页1至20条，默认10；没有总条数限制',datasetRef:'complete scoped release dataset',application:'verified application identifier',columns:{system:'system column',environment:'environment column',application:'application column',deployedAt:'actual deployment time column',status:'release status column',commit:'commit column or build',build:'build column'},successValues:['verified success status'],evidence:'release source and field evidence',offset:'optional explicit Z or +08:00',timezoneEvidence:'timezone interpretation evidence',timestampUnit:'seconds or milliseconds for numeric timestamps'},description:'Read already-authorized complete release records: bind trusted task system/environment, application, successful status, commit/build and actual deployment time. No network request, new integration or permission is created. Git commit, branch and file times never prove deployment. Use existing authorized readers first; report missing release endpoint/access explicitly.'},
    {tool:'summarize_dataset',args:{datasetRef:'complete task dataset',groupColumns:['actual grouping column'],rowKey:'group_key',aggregates:[{op:'count/count_distinct/sum',column:'actual column except count',as:'result',nulls:'error/empty/zero for sum'}]},description:'Group an existing complete dataset without SQL. Exact decimal sum, count rows or non-null distinct values; preserves read times and replayable recipe. Use after cross-source lookup/filter. Never silently drop duplicates. compose_report supports constant decimal operands inside formulas and divide with two args, precision and explicit zeroDenominator; also supports percentage with two args, precision 0..12 and explicit zeroDenominator=empty/zero/error; finalization still checks independent numeric inputs.'},
    {tool:'indexes',args:{table:'已读取结构的实际表'},description:'读取真实索引元数据，超时后先核对可用索引。'},
    {tool:'explain_query',args:{tool:'select/aggregate/group_dataset',arguments:'对应工具的结构化参数对象'},description:'EXPLAIN固定受控只读语句，不接收SQL；查询超时先看计划、调整筛选及分页，不把超时当无数据。'},
    {tool:'transform_dataset',args:{datasetRef:'本任务完整来源',keyColumn:'唯一稳定主键',scopeEvidence:'源码或原问题范围依据',filters:[{column:'实际列',op:'eq/ne/in/not_in/is_null/is_not_null/gt/gte/lt/lte',type:'date=ISO timestamp with timezone; civil_day=calendar day, civil_month=calendar month; decimal/string' ,nulls:'范围比较默认error，可明确exclude真实null；格式错误不排除',value:'单值',values:['in/not_in使用数组']}],hierarchy:{parentColumn:'父键',rootIds:['实际根ID'],includeRoots:false,nodeFilters:[],pathColumns:[{column:'名称列',as:'完整路径'}],separator:' / '}},description:'无需SQL转换权限，在已有完整数据集上精确筛选及遍历任意深度后代，不重复取数。hierarchy可省略仅筛选。filters最终选输出；nodeFilters控制可见节点及其后代是否可达，不跳过无效父节点。根可多个但不能相互包含，路径从指定根开始。保留原始字段、null、文本编码及取数时点；重复主键/循环/缺根报错，范围外断链计数不冒充全局完整。派生配方可恢复、重放、刷新并在定稿重算；不允许模型提供代码或任意文件路径。完整范围仍需源码及原始数据依据，不能自称独立金额核验。'},
    {tool:'window_dataset',args:{populationRef:'完整主对象数据集',populationKeys:['主对象唯一复合键'],groupColumns:['实际分组字段'],timeType:'instant/civil_day/civil_month，明确来源和边界语义',windows:[{start:'左闭边界，instant须ISO含时区',end:'右开边界，同类型',countColumn:'去重对象数输出列',percentageColumn:'可选占比列',precision:2,zeroDenominator:'empty'}],sources:[{datasetRef:'完整合格事件来源',populationKeys:['与主对象键逐项对应的事件字段'],timeColumn:'实际时间字段',outsidePopulation:'error或明确exclude',outsideEvidence:'仅exclude时给真实范围依据'}],populationDuplicates:'默认error；确需deduplicate必须duplicateEvidence说明且归属一致',denominatorColumn:'默认population_count',rowKey:'默认group_key'},description:'一次计算所有显式时间窗口的主对象去重数量及占比，无需逐窗口transform/summarize/enrich。保留零发生组，完整主对象集合做分母；多来源同一对象跨记录去重，错误日期/空时间不能按范围外排除补零。instant要求明确时区，civil_day/月按明确民用日期处理，不猜BSON类型或时区。来源必须完整且已按真实状态过滤。结果含配方、范围外/重复计数和各来源时间，可恢复刷新。计算成功不代表独立核验或任务完成；文件需不同原始查询形成同分组窗口基准逐对象核验。'},
    {tool:'period_dataset',args:{populationRef:'完整主对象数据集',keyColumns:['实际对象键'],period:{unit:'month或day或values',start:'2026-01',end:'2026-12',column:'period',values:'仅values时提供有序期间数组'},rowKey:'period_key',sources:[{datasetRef:'完整金额数据集',keyColumns:['对应对象键'],periodColumn:'月份列（YYYYMM/数值YYYYMM/YYYY-MM/YYYY-M）或日期列（YYYYMMDD/YYYY-MM-DD）',periodUnit:'Optional explicit day/month source grain; day to month supported, never timestamp guessing',yearColumn:'可选，仅分开的年/月列',duplicates:'error或明确sum',outside:'error或exclude',outsideEvidence:'exclude时说明排除依据',metrics:[{op:'sum (default), count rows, or count_distinct; cumulativeAs for distinct is set union since period.start, NOT sum of monthly counts',column:'真实金额字段',as:'当期金额',cumulativeAs:'可选累计金额输出列',statusAs:'可选状态列known/unknown/no_occurrence',missing:'zero/empty/error，无发生记录',nulls:'zero/empty/error，实际金额为空'}]}]},description:'自动将六位年月、标准年月及分开的年/月统一为YYYY-MM；八位日期统一为YYYY-MM-DD，不做时区转换。非法日期明确报错，不能按outside=exclude吞掉后补零。无需额外SQL转换权限。按完整主对象×指定月/日/有序期间生成全部组合，保留无发生对象和空月份；多来源按对象复合键及期间对齐，精确十进制累计，支持跨年，累计从指定起点零开始。含期初余额的报表须另取期初来源并在compose_report显式相加，不把月度流量当余额。sources=[]生成独立覆盖范围；金额源必须同对象期间唯一，确需合并重复时明确sum。默认不猜缺失/空值；empty会让其后的累计保持未知。数据集保留派生配方与排除/缺失计数，可恢复/refresh重放。finalize每个期间金额列需要独立原始查询产生的另一个period_dataset作逐行基准，不能用同一查询自证或拿全年合计替代累计列；inspect_dataset查看实际列与来源。'},
    {tool:'compose_report',args:{sources:[{name:'s1',datasetRef:'本轮完整datasetRef',keyColumn:'对象主键'}],columns:[{label:'dealer_id',displayName:'经销商编号',value:{op:'key'}},{label:'余额',total:true,value:{op:'subtract',args:[{op:'field',source:'s1',column:'amount',missing:'zero'},{op:'field',source:'s2',column:'used',missing:'zero'}]}}]},description:'按业务主键全外连接本任务完整数据集（可选population:{datasetRef,keyColumn}限定完整主对象集合），生成CSV草稿并返回行数、校验和、列合计与预览；完整原始记录可按实际唯一主键及所有要导出字段分组，不因预览select的12字段限制删列。sources[].name必须使用不重复的s1、s2等（s加正整数）；field.source引用同名来源，不能改为业务名称。固定计算key/field/add/subtract/min，后3项使用args数组；field指定source、column及可选missing=zero或empty，缺失默认报错。数字精确十进制计算。数值列应标记total:true。中文业务导出默认中文（英文字段）双语表头：label保留原字段，displayName填已核实中文名称，工具生成双语标题；也接受完整中文label。中文含义依据源码注解/字段说明并在finalize columnRules登记，未知含义先核实，不猜译。除用户明确要求原始或英文表头，不接受纯英文字段名；改表头复用已有数据集，不重新取数。只返回draftFile；之后finalize_report通过才可交付。必须先核实各来源口径、关联基数及覆盖范围，不得用样本或不完整数据集导出完整报表。'});
  }
  if(['mysql','mongodb'].includes(e.kind))spec.push({tool:'read_dataset',args:{datasetRef:'已有datasetRef或evidenceRef',offset:'0开始的实际行位置',column:'实际列名',textOffset:'默认0，按nextTextOffset继续',limit:'每次1至4000字符，默认1024'},description:'不重查数据库，按任务/系统/环境范围读取已保存数据集或长字段证据；保留原取数时间、null和原查询完整性。行样本不能当完整主对象集合。字段超过当前分段时继续读取，不把可见前缀当完整规则。'});
  for(const item of spec){
    if(item.tool==='inspect_dataset'){item.args.sections=['Optional preview/queryDefinition/derivation/dependencies/reportDraft; request omittedSections individually'];item.description+=' Batch saved-row preview supports offset/limit/columns and nextOffset; use this instead of read_dataset per cell for short tables. dependencies shows immediate lineage. For drafts, populationPlans supplies the sources=[] coverage recipe; it does not prove business scope or replace independent numeric checks. Large overview explicitly names omittedSections; request sections individually instead of assuming omitted content is empty.';}
    if(item.tool==='list_datasets')item.description+=' Filter kind=report_draft first on resume. Catalog puts drafts first and sorts by createdAt; readAt remains original source acquisition. Old artifacts without createdAt retain readAt and can be located by kind/columns.';
    if(item.tool==='period_dataset')item.description+=' calendar-v3: one call accepts multiple sum/count/count_distinct metrics, zero periods and cumulative distinct UNION within the selected range, per object. Explicit periodUnit=day converts valid civil day to output month; do not expand daily grids then filter month ends. Distinct identity nulls require a policy; nulls=zero excludes missing identity, empty propagates unknown. duplicates=sum explicitly aggregates fact rows; count counts rows, not weighted counts. Pre-start history requires a separate explicit range, never call window cumulative all-time.';
  }
  let browser;
  if (q.browser === true && e.kind === 'nacos') { browser = await (adapters.browser ?? createNacosBrowser)(e,q,cred,adapters); spec.push(...browser.spec); }
  if(['mysql','mongodb'].includes(e.kind)&&q.exportMaxRows){const final=spec.find(x=>x.tool==='finalize_report');spec.push({...final,tool:'refresh_report',description:'参数与finalize_report相同。仅当当前口径变更或取数时点超窗需要重算时使用：预检已有来源recipe及派生依赖，在一个新只读事务里集中刷新完整来源、独立基准、维度和对象范围，再重做草稿并核验。不能执行保存SQL；旧数据无recipe或含临时in_set须先补齐。历史快照差异本身不要求重算。返回新文件供原问题审阅，不自动发群。'});}
  if(['mysql','mongodb'].includes(e.kind)&&q.exportMaxRows)spec.push({tool:'inspect_report',args:{fileId:'本任务已登记的report-ID',section:'可选summary/columns/sources/checks/scope，默认summary',offset:'可选非负整数',limit:'可选1至4'},description:'只读查看与某份已登记CSV摘要和核验记录绑定的实际表头、完整公式、来源、预览、主键范围对照及全文件逐行重算校验；不查数据库，不执行路径，不用另一个数据集冒充该文件。默认摘要，长文本用section分页。新文件审阅优先使用，不重新compose或让用户上传已有CSV。'});
  const run = async (tool, args = {}) => {
    if (!active) throw new Error('工具执行已结束');
    if (!spec.some(x => x.tool === tool) || !args || typeof args !== 'object' || Array.isArray(args)) throw new Error('不支持的工具或参数');
    if (tool.startsWith('browser_')) { if (!browser) throw new Error('当前范围未启用浏览器'); return browser.run(tool,args); }
    // A single operation cannot keep a connection alive beyond its declared timeout.
    try {
      return await (async () => {
        if (e.kind === 'nacos') {
          if (tool === 'connection') { const v = JSON.parse(await nacos('/v1/auth/login', {}, true)); if (typeof v.accessToken !== 'string' || !v.accessToken) throw new Error('Nacos 认证未成功'); token = v.accessToken; return { stage: 'Nacos 网络与登录成功', databaseConnection: '尚未测试，需要独立只读数据库入口' }; }
          if (tool === 'discover') {
            configs.clear(); let truncated = false;
            for (const namespace of q.namespaces) {
              const v = JSON.parse(await nacos('/v2/cs/history/configs', { namespaceId: namespace }));
              if (v.code !== 0 || !Array.isArray(v.data)) throw new Error('配置发现接口不支持或无权限');
              for (const x of v.data) { if (configs.size >= 100) { truncated = true; break; } if (typeof x.dataId !== 'string' || typeof x.group !== 'string') continue;
                configs.set(`config-${configs.size + 1}`, { namespace, dataId: x.dataId, group: x.group }); }
            }
            return { configs: [...configs].map(([ref, x]) => ({ ref, namespace: bounded(x.namespace, secrets), dataId: bounded(x.dataId, secrets), group: bounded(x.group, secrets) })), truncated };
          }
          const x = configs.get(args.ref); if (!x) throw new Error('仅可读取本次发现的配置引用');
          const content = await nacos('/v1/cs/configs', { tenant: x.namespace, group: x.group, dataId: x.dataId });
          if (tool === 'read_runtime_config') {
            const runtime = schedulerConfiguration(content);
            const source = { ...x, contentHash: createHash('sha256').update(content).digest('hex') };
            return { config: args.ref, runtimeDiscovery: { ...runtime, source },
              partial: true, stage: runtime.websites.length ? '已发现XXL-JOB管理台入口，尚未访问或验证调度' : '未解析出XXL-JOB管理台入口；不能据此断言未启用',
              nextStep: '入口仅为配置证据，不代表已登录或任务已运行。交由原问题的websiteQuery继续查看Cron、启停状态与执行记录；多个入口时结合当前环境证据选择，不猜测。' };
          }
          const found = databaseEndpoints(content);
          return { config: args.ref, rows: found.slice(0, q.maxRows).map(row=>({...row,connectionSource:{...x,contentHash:createHash('sha256').update(content).digest('hex')}})), truncated: found.length > q.maxRows, partial: found.unresolved || !found.length, stage: found.length ? '配置已读取，数据库地址已解析' : '配置已读取，未解析出数据库地址', databaseConnection: '未测试；管理员确认后可在本机提取凭据并通过受控只读模式验证' };
        }
        if(tool==='collect_dataset_values'){
          await datasets.check();const d=await datasets.restore(args.datasetRef);
          if(!d?.complete||!Array.isArray(args.columns)||!args.columns.length||args.columns.some(c=>!d.columns.includes(c))||!['exclude','error'].includes(args.nulls))throw new QueryInputError('VALUE_SET','A complete dataset, existing columns and explicit nulls=exclude/error are required.');
          const values=new Set();let excluded=0;for(const row of d.rows)for(const column of args.columns){const value=row[column];if(value===null||value===undefined||value===''){if(args.nulls==='error')throw new QueryInputError('VALUE_SET','Null cohort key requires an explicit decision.');excluded++;continue;}values.add(String(value));}
          const setRef=`set-${valueSets.size+1}`;valueSets.set(setRef,{values:[...values],truncated:false});return {setRef,count:values.size,excluded,truncated:false,sourceReadAt:d.readAt,sample:[...values].slice(0,q.maxRows)};
        }
        if(tool==='compare_datasets')return datasets.compare(args);
        if(tool==='list_datasets')return datasets.list(args);
        if(tool==='read_dataset')return datasets.readDataset(args);
        if(tool==='deployment_evidence')return datasets.deployment(args);
        if(tool==='window_dataset')return datasets.window(args);
        if(tool==='period_dataset')return datasets.period(args);
        if(tool==='compose_report')return datasets.compose(args);
        if(tool==='enrich_dataset')return datasets.enrich(args);
        if(tool==='inspect_report'){await adapters.authorize?.();return inspectReport(adapters.dataDir,adapters.reportJob??{id:'none',reportFiles:[]},args);}
        if(tool==='summarize_dataset')return datasets.summarize(args);
        if(tool==='transform_dataset')return datasets.transform(args);
        if(tool==='inspect_dataset')return datasets.inspect(args);
        if(tool==='finalize_report')return datasets.finalize(args);
        if(tool==='refresh_report')return datasets.refresh(args,{
         begin:async()=>{if(mongo){mongo.close();return;}const c=await mysql();await adapters.authorize?.();await c.rollback();readCache.clear();readCacheBytes=0;await c.query('START TRANSACTION READ ONLY');},
         reload:async(recipe,source)=>{if(source.scope&&source.scope!==createHash('sha256').update(JSON.stringify(e)).digest('hex')){if(!adapters.reloadDataset)throw new ReportInputError('跨来源刷新需要当前授权路由，不能在错误数据库重放');return adapters.reloadDataset(recipe,source);}if(recipe.tool==='mongo_dataset'){if(!mongo)throw new ReportInputError('Mongo来源必须由其授权入口刷新');return mongo.reload(recipe.args);}for(const table of [recipe.args.table,recipe.args.leftTable,recipe.args.rightTable].filter(Boolean)){let cursor;do{const page=await run('schema',{table,...(cursor!==undefined?{cursor}:{})});cursor=page.nextCursor;}while(cursor!==null&&cursor!==undefined);}return run(recipe.tool,structuredClone(recipe.args));}
        });
        if(mongo)return mongo.run(tool,args);
        if(tool==='indexes'){tableColumns(tables,args.table,q);const c=await mysql();const [rows]=await c.execute({sql:'SHOW INDEX FROM `'+args.table+'`',timeout:q.timeoutMs},[]);return {rows,stage:'只读索引元数据；用于选择查询条件，不证明业务结果'};}
        if(tool==='explain_query'){
          const builders={select:a=>selectStatement(a,tables,q,valueSets),aggregate:a=>aggregateStatement(a,tables,columnTypes,q,valueSets),group_dataset:a=>groupedDatasetStatement(a,tables,columnTypes,q,valueSets,primaryKeys)};
          if(!builders[args.tool])throw new QueryInputError('QUERY_INPUT','执行计划仅支持select/aggregate/group_dataset的固定参数');
          const statement=builders[args.tool](args.arguments),c=await mysql();const [rows]=await c.execute({sql:'EXPLAIN '+statement.sql,timeout:q.timeoutMs},statement.params);return {rows,stage:'只读执行计划；不是业务数据，不执行ANALYZE或模型SQL'};
        }
        const c = await mysql();
        if(tool==='group_dataset'||tool==='linked_group_dataset'){for(const name of [args.table,args.leftTable,args.rightTable].filter(Boolean))if(tableEngines.get(name)!=='innodb')throw new QueryInputError('SNAPSHOT_REQUIRED','完整分页要求已读取schema且目标表使用InnoDB；未知或非事务引擎不能声称一致快照。');const statement=groupedDatasetStatement(args,tables,columnTypes,q,valueSets,primaryKeys);return datasets.collect({...statement,recipe:{tool,args:structuredClone(args)}},(s,p)=>c.execute({...s,timeout:q.timeoutMs},p));}
        if (tool === 'connection') return { stage: '数据库连接、账号策略和只读事务已验证' };
        if(tool==='database_clock'){
          if(Object.keys(args).length)throw new QueryInputError('QUERY_INPUT','database_clock不接受参数或SQL');
          const [rows]=await c.execute({sql:"SELECT DATABASE() AS database_name, DATE_FORMAT(CURRENT_TIMESTAMP(6), '%Y-%m-%d %H:%i:%s.%f') AS database_time, DATE_FORMAT(UTC_TIMESTAMP(6), '%Y-%m-%d %H:%i:%s.%f') AS `utc_time`, TIMESTAMPDIFF(MINUTE, UTC_TIMESTAMP(), CURRENT_TIMESTAMP()) AS utc_offset_minutes, @@session.time_zone AS session_time_zone, @@system_time_zone AS system_time_zone",timeout:q.timeoutMs},[]);
          const columns=['database_name','database_time','utc_time','utc_offset_minutes','session_time_zone','system_time_zone'];
          return {clock:Object.fromEntries(columns.map(k=>[k,bounded(rows[0]?.[k],secrets)])),observedAtUtc:new Date().toISOString(),stage:'已读取当前数据库会话时间与时区；业务字段时区仍按源码和字段类型核对'};
        }
        if (tool === 'tables') {
          const offset=args.cursor===undefined?0:Number(args.cursor);
          if(!Number.isInteger(offset)||offset<0||offset>100000)throw new Error('结构分页参数无效');
          const [rows]=await read(c,{sql:`SELECT TABLE_NAME AS table_name FROM information_schema.TABLES WHERE TABLE_SCHEMA=? AND TABLE_TYPE='BASE TABLE' ORDER BY TABLE_NAME LIMIT 101 OFFSET ${offset}`,timeout:q.timeoutMs},[e.database]);
          return {tableNames:rows.slice(0,100).map(r=>r.table_name).filter(t=>ident(t)&&(q.tables.includes('*')||q.tables.includes(t))),truncated:rows.length>100,nextCursor:rows.length>100?offset+100:null};
        }
        if (tool === 'schema') {
          if(args.table !== undefined && (!ident(args.table) || !(q.tables.includes('*') || q.tables.includes(args.table)))) throw new Error('查询表超出范围');
          const requestedColumns = args.columns;
          if (requestedColumns !== undefined && (!args.table || !Array.isArray(requestedColumns) || !requestedColumns.length || requestedColumns.length > 20
            || requestedColumns.some(column => !ident(column) || secretName.test(column)))) throw new QueryInputError('QUERY_INPUT', '定向字段发现需要table和1至20个普通字段名。');
          const offset = args.cursor === undefined ? 0 : Number(args.cursor);
          if(!Number.isInteger(offset) || offset<0 || offset>100000) throw new Error('结构分页参数无效');
          if(args.search!==undefined&&(typeof args.search!=='string'||!args.search.trim()||/[\x00-\x1f\x7f]/.test(args.search)))throw new QueryInputError('QUERY_INPUT','schema search须为非空单行字面文本；不是SQL或正则。');
          const searchClause=args.search!==undefined?' AND (LOCATE(?,c.COLUMN_NAME)>0 OR LOCATE(?,c.COLUMN_COMMENT)>0 OR LOCATE(?,c.TABLE_NAME)>0 OR LOCATE(?,t.TABLE_COMMENT)>0)':'';
          const scopeClause=q.tables.includes('*')?'':` AND c.TABLE_NAME IN (${q.tables.map(()=>'?').join(',')})`;
          const columnClause = requestedColumns ? ` AND c.COLUMN_NAME IN (${requestedColumns.map(() => '?').join(', ')})` : '';
          const [rows] = await read(c,{ sql: "SELECT c.TABLE_SCHEMA AS database_name,c.TABLE_NAME AS table_name,c.COLUMN_NAME AS column_name,c.DATA_TYPE AS data_type,c.COLUMN_TYPE AS column_type,c.IS_NULLABLE AS is_nullable,c.CHARACTER_MAXIMUM_LENGTH AS character_maximum_length,c.NUMERIC_PRECISION AS numeric_precision,c.NUMERIC_SCALE AS numeric_scale,c.COLUMN_COMMENT AS column_comment,t.TABLE_COMMENT AS table_comment,t.ENGINE AS engine,c.COLUMN_KEY AS column_key,(SELECT COUNT(*) FROM information_schema.KEY_COLUMN_USAGE k WHERE k.TABLE_SCHEMA=c.TABLE_SCHEMA AND k.TABLE_NAME=c.TABLE_NAME AND k.CONSTRAINT_NAME='PRIMARY') AS primary_key_count FROM information_schema.COLUMNS c JOIN information_schema.TABLES t ON t.TABLE_SCHEMA=c.TABLE_SCHEMA AND t.TABLE_NAME=c.TABLE_NAME WHERE c.TABLE_SCHEMA=? AND t.TABLE_TYPE='BASE TABLE' AND c.EXTRA NOT LIKE '%GENERATED%'" + (args.table ? " AND c.TABLE_NAME=?" : "") + columnClause + scopeClause + searchClause + ` ORDER BY c.TABLE_NAME,c.ORDINAL_POSITION LIMIT 101 OFFSET ${requestedColumns ? 0 : offset}`, timeout: q.timeoutMs }, [e.database, ...(args.table ? [args.table] : []), ...(requestedColumns ?? []),...(q.tables.includes('*')?[]:q.tables),...(args.search!==undefined?[args.search,args.search,args.search,args.search]:[])]);
          const visible = new Map(),columnMetadata=[];
          for (const r of rows.slice(0,100)) if (ident(r.table_name) && ident(r.column_name) && !secretName.test(r.column_name) && (q.tables.includes('*') || q.tables.includes(r.table_name))) {
            const metadata={};for(const key of ['database_name','table_name','column_name','data_type','column_type','is_nullable','character_maximum_length','numeric_precision','numeric_scale','column_comment','table_comment'])if(r[key]!==undefined)metadata[key]=r[key]===null?null:cleanWebsiteText(bounded(r[key],secrets));columnMetadata.push(metadata);
            if(r.column_key==='PRI'&&Number(r.primary_key_count)===1)primaryKeys.set(r.table_name,[r.column_name]);
            if(typeof r.engine==='string')tableEngines.set(r.table_name,r.engine.toLowerCase());
            visible.set(r.table_name,[...(visible.get(r.table_name)??[]),r.column_name]);
            tables.set(r.table_name,[...new Set([...(tables.get(r.table_name)??[]),r.column_name])]);
            if(typeof r.data_type==='string'){const known=columnTypes.get(r.table_name)??new Map();known.set(r.column_name,r.data_type.toLowerCase());columnTypes.set(r.table_name,known);}
          }
          const result = {tables:Object.fromEntries(visible),columnMetadata,metadataOnly:true,searchApplied:args.search!==undefined,truncated:requestedColumns ? false : rows.length>100,nextCursor:!requestedColumns && rows.length>100?offset+100:null};
          if(result.truncated) result.note='仅当前页表结构；可用schema的nextCursor继续，或指定table读取目标表。';
          return result;
        }
        if (tool === 'count') {
          const statement = countStatement(args, tables, q,valueSets);
          const [rows] = await read(c,{ sql: statement.sql, timeout: q.timeoutMs }, statement.params);
          return { table: args.table, rows: [{ total: String(rows[0].total), countMode: args.distinctColumns?.length ? 'distinct' : 'rows', distinctColumns: (args.distinctColumns ?? []).join(',') }], truncated: false };
        }
        if(tool==='group_count'){
          const statement=groupCountStatement(args,tables,q,valueSets);
          const [rows]=await read(c,{sql:statement.sql,timeout:q.timeoutMs},statement.params);
          const result={table:args.table,rows:rows.slice(0,q.maxRows).map(row=>Object.fromEntries([...statement.groupColumns,'duplicate_count'].map(key=>[key,bounded(row[key],secrets)]))),truncated:rows.length>q.maxRows,groupColumns:statement.groupColumns};
          if(Buffer.byteLength(JSON.stringify(result))>12000)return {table:args.table,...await datasets.captureRows(result.rows,[...statement.groupColumns,'duplicate_count'],{complete:!result.truncated,queryDefinition:{sql:statement.sql,params:statement.params}}),truncated:result.truncated};
          return result;
        }
        if(tool==='collect_values'){
          const statement=collectValuesStatement(args,tables,q,valueSets);const [rows]=await read(c,{sql:statement.sql,timeout:q.timeoutMs},statement.params);
          const values=[...new Set(rows.flatMap(row=>statement.columns.map(column=>row[column])).filter(value=>value!==null&&value!==undefined&&['string','number','bigint'].includes(typeof value)).map(String))];
          const setRef=`set-${valueSets.size+1}`;valueSets.set(setRef,{values,truncated:false});
          return {table:args.table,setRef,valueCount:values.length,sample:values.slice(0,Math.min(q.maxRows,20)),truncated:false,stage:`已收集 ${values.length} 个去重值供本轮关联汇总`};
        }
        if(tool==='aggregate'||tool==='linked_aggregate'){
          const statement=tool==='aggregate'?aggregateStatement(args,tables,columnTypes,q,valueSets):linkedAggregateStatement(args,tables,columnTypes,q,valueSets);
          const [rows]=await read(c,{sql:statement.sql,timeout:q.timeoutMs},statement.params);
          return {rows:rows.slice(0,1).map(row=>Object.fromEntries(statement.columns.map(key=>[key,bounded(row[key],secrets)]))),truncated:false,stage:tool==='aggregate'?'已完成单表汇总':'已完成受控关联汇总'};
        }
        const statement = selectStatement(args, tables, q,valueSets);
        const [rows] = await read(c,{ sql: statement.sql, timeout: q.timeoutMs }, statement.params);
        const result={ table: args.table, rows: rows.slice(0,q.maxRows).map(r=>Object.fromEntries(statement.columns.map(k=>[k,bounded(r[k],secrets)]))),truncated:rows.length>q.maxRows };
        if(Buffer.byteLength(JSON.stringify(result))>12000)return {table:args.table,...await datasets.captureRows(result.rows,statement.columns,{complete:!result.truncated,queryDefinition:{sql:statement.sql,params:statement.params}}),truncated:result.truncated};
        return result;
      })();
    } catch (error) {
      if(['MONGO_AMOUNT_TYPE','MONGO_NULL_AMOUNT'].includes(error.code)){const repaired=new QueryInputError(error.code,error.code==='MONGO_AMOUNT_TYPE'?'Mongo金额聚合遇到非数值BSON类型（可能为数字字符串）；不是网络或权限故障。保留已有完整明细，用summarize_dataset的精确十进制汇总；独立数据库核对可按对象及原始金额字段分组计数后精确合成，不能直接sum字符串或把它算成0。先核对实际类型和所有原值，无效值不得跳过。':'Mongo金额聚合范围存在真实空值或缺失字段，不能默认补零。用已存明细核对缺失范围；可用is_null/is_missing专项只读检查及原值分组核验。只有明确业务含义后才能处理，保留已有效证据。');repaired.executed=true;throw repaired;}
      if(/^MONGO_(?:VALUE_TYPE|FILTERS|FIELDS|ARGUMENTS|AGGREGATE|DISTINCT_COMBINATION)$/.test(error.code??''))throw new QueryInputError('REPORT_INPUT',mongoInputDiagnostic(args,error.code)); if(error instanceof ReportInspectionError)throw new QueryInputError(error.code,error.message); if(error instanceof DatasetCapacityError)throw new QueryInputError(error.code,error.message); if(error instanceof ReportInputError||error?.code==='REPORT_INPUT')throw new QueryInputError('REPORT_INPUT',error.message); if (error instanceof QueryInputError) throw error; throw safeExecutionError(error); }

  };
  const visibleSpec=mongo?spec.filter((item,index)=>item.tool!=='linked_group_dataset'&&spec.findIndex(x=>x.tool===item.tool)===index):spec;
  return { spec:visibleSpec, run, close: async ({ abort = false } = {}) => { active = false; mongo?.close(); token = null; readCache.clear(); datasets.clear(); await browser?.close(); if (conn) { try { if (!abort) await conn.rollback(); } catch { /* Readonly teardown: a disconnected session cannot rollback; destroy still releases it. */ } finally { conn.destroy(); conn = null; } } } };
}
