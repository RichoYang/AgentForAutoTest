import {reusableReportSources,importReportDataset,inspectReusableReport} from './report-reuse.js';
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
 if(value===null||value===undefined||['string','number','boolean'].includes(typeof value))return value??'';
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
const sanitizedValue = (x, secrets = []) => {
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
function filterClause(filters, tables, table, q, valueSets = new Map(), alias = '', maxFilters = 8) {
  const known = tableColumns(tables, table, q);
  if (!Array.isArray(filters) || filters.length > maxFilters) throw new QueryInputError('QUERY_INPUT', `filters必须是数组，最多${maxFilters}个明确条件；读取已授权表的完整范围时传[]。`);
  if(!filters.length)return {where:'1=1',params:[]};
  const params = [], prefix = alias ? `\`${alias}\`.` : '';
  const where = filters.map(f => {
    if (!f || !ident(f.column) || secretName.test(f.column)) throw new Error('查询筛选列超出范围');
    if (!known.includes(f.column)) throw new QueryInputError('SCHEMA_FIELDS', '筛选字段未在已读取结构中；先读取目标表schema并使用实际字段。');
    if (f.op === 'contains') {
      if (typeof f.value !== 'string' || !f.value || f.value.length > 200) throw new QueryInputError('QUERY_INPUT', 'contains需要1至200字符的非空字符串。');
      params.push(f.value); return `LOCATE(?, ${prefix}\`${f.column}\`) > 0`;
    }
    if (f.op === 'in_set') {
      const set = valueSets.get(f.value);
      if (!set || set.truncated || !set.values.length) throw new QueryInputError('VALUE_SET', 'in_set必须引用本轮collect_values返回的完整非空setRef。');
      params.push(...set.values); return `${prefix}\`${f.column}\` IN (${set.values.map(() => '?').join(', ')})`;
    }
    if (f.op === 'in') {
      if (!Array.isArray(f.value) || !f.value.length || f.value.length > 100
        || f.value.some(v => !['string','number'].includes(typeof v) || (typeof v === 'number' && !Number.isFinite(v)) || String(v).length > 200)) {
        throw new QueryInputError('QUERY_INPUT', 'in需要1至100个不超过200字符的字符串或有限数字。');
      }
      params.push(...f.value); return `${prefix}\`${f.column}\` IN (${f.value.map(() => '?').join(', ')})`;
    }
    if (!['=','>','>=','<','<='].includes(f.op) || !['string','number'].includes(typeof f.value) || (typeof f.value === 'number' && !Number.isFinite(f.value)) || String(f.value).length > 200) throw new QueryInputError('QUERY_INPUT', '筛选仅支持=、>、>=、<、<=、contains、in；标量value为不超过200字符的字符串或有限数字。');
    params.push(f.value); return `${prefix}\`${f.column}\` ${f.op} ?`;
  }).join(' AND ');
  return { where, params };
}
export function selectStatement(args, tables, q) {
  const { table, columns, filters } = args;
  const known = tableColumns(tables, table, q);
  if (!Array.isArray(columns) || !columns.length) throw new QueryInputError('QUERY_INPUT', 'columns必须是非空字段数组。');
  if (columns.length > 12) throw new QueryInputError('COLUMN_LIMIT', '一次最多选择12个字段；只选择与问题相关的字段，必要时分次读取。');
  if (columns.some(c => typeof c === 'string' && secretName.test(c))) throw new Error('查询列超出范围');
  if (columns.some(c => !ident(c))) throw new QueryInputError('QUERY_INPUT', 'columns仅接受schema返回的普通字段名，不能使用*、函数或表达式。');
  if (columns.some(c => !known.includes(c))) throw new QueryInputError('SCHEMA_FIELDS', '字段未在已读取结构中；重新读取目标表schema或继续分页，仅使用返回的字段。');
  const {where,params}=filterClause(filters,tables,table,q,new Map(),'',6);
  return { sql: `SELECT ${columns.map(c => `\`${c}\``).join(', ')} FROM \`${table}\` WHERE ${where} LIMIT ${q.maxRows + 1}`, params, columns };
}
export function rowDatasetStatement(args,tables,types,q){
 const cs=args.columns,order=args.orderBy;if(!Array.isArray(cs)||!cs.length||new Set(cs).size!==cs.length||!Array.isArray(order)||!order.length)throw new QueryInputError('QUERY_INPUT','row_dataset需实际columns和稳定唯一键orderBy；不支持表达式');
 cs.forEach(c=>checkedColumn(tables,args.table,c,q));order.forEach(c=>{checkedColumn(tables,args.table,c,q);if(!cs.includes(c))throw new QueryInputError('QUERY_INPUT','orderBy唯一键必须同时选入columns以核实分页完整性');});
 const f=filterClause(args.filters,tables,args.table,q);
 return {sql:`SELECT ${cs.map(c=>'`'+c+'`').join(', ')} FROM \`${args.table}\` WHERE ${f.where} ORDER BY ${order.map(c=>'`'+c+'`').join(', ')}`,params:f.params,columns:cs,uniqueKeyColumns:order,numericColumns:cs.filter(c=>['decimal','numeric','float','double'].includes(types.get(args.table)?.get(c)))};
}
// Count only validated base-table fields and filters; no model-provided SQL.
export function countStatement(args, tables, q) {
  const distinct = args.distinctColumns ?? [];
  if (!Array.isArray(distinct) || distinct.length > 12) throw new QueryInputError('QUERY_INPUT', 'distinctColumns应为最多12个字段的数组。');
  const columns = distinct.length ? distinct : (tables.get(args.table) ?? []).slice(0, 1);
  const base = selectStatement({ table: args.table, columns, filters: args.filters }, tables, q);
  const from = base.sql.slice(base.sql.indexOf(' FROM ')).replace(/ LIMIT \d+$/, '');
  return { sql: `SELECT COUNT(${distinct.length ? 'DISTINCT ' + distinct.map(c => '`' + c + '`').join(', ') : '*'}) AS total${from}`, params: base.params };
}

export function groupCountStatement(args,tables,q){
  const groupColumns=args.groupColumns??[],minCount=args.minCount??2;
  if(!Array.isArray(groupColumns)||!groupColumns.length||groupColumns.length>8)throw new QueryInputError('QUERY_INPUT','groupColumns必须是1至8个字段。');
  if(!Number.isInteger(minCount)||minCount<2||minCount>100000)throw new QueryInputError('QUERY_INPUT','minCount必须是2至100000的整数。');
  const base=selectStatement({table:args.table,columns:groupColumns,filters:args.filters},tables,q);
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
  if(!Array.isArray(aggregates)||!aggregates.length||aggregates.length>6)throw new QueryInputError('QUERY_INPUT','aggregates必须包含1至6项。');
  return aggregates.map((item,index)=>{
    const name=item.as??`metric_${index+1}`;
    if(!ident(name)||secretName.test(name))throw new QueryInputError('QUERY_INPUT','aggregate as必须是普通非敏感字段名。');
    return {name,expression:aggregateExpression(item,tables,types,q,aliases)};
  });
}
export function aggregateStatement(args,tables,types,q,valueSets=new Map()){
  tableColumns(tables,args.table,q);
  if(!Array.isArray(args.aggregates))throw new QueryInputError('QUERY_INPUT','aggregates必须包含1至6项。');
  const metrics=checkedAggregates((args.aggregates??[]).map(x=>({...x,table:args.table})),tables,types,q,new Map());
  const filter=filterClause(args.filters,tables,args.table,q,valueSets);
  return {sql:`SELECT ${metrics.map(x=>`${x.expression} AS \`${x.name}\``).join(', ')} FROM \`${args.table}\` WHERE ${filter.where}`,params:filter.params,columns:metrics.map(x=>x.name)};
}
export function collectValuesStatement(args,tables,q){
  const columns=args.columns??[];
  if(!Array.isArray(columns)||!columns.length||columns.length>8)throw new QueryInputError('QUERY_INPUT','columns必须是1至8个字段。');
  for(const column of columns)checkedColumn(tables,args.table,column,q);
  const filter=filterClause(args.filters,tables,args.table,q);
  return {sql:`SELECT DISTINCT ${columns.map(c=>`\`${c}\``).join(', ')} FROM \`${args.table}\` WHERE ${filter.where} LIMIT 1001`,params:filter.params,columns};
}
export function linkedAggregateStatement(args,tables,types,q,valueSets=new Map()){
  const left=args.leftTable,right=args.rightTable;
  if(left===right)throw new QueryInputError('QUERY_INPUT','关联汇总必须使用两个不同基础表。');
  tableColumns(tables,left,q);tableColumns(tables,right,q);
  const leftJoin=checkedColumn(tables,left,args.join?.leftColumn,q),rightJoin=checkedColumn(tables,right,args.join?.rightColumn,q);
  const aliases=new Map([[left,'l'],[right,'r']]);
  if(!Array.isArray(args.aggregates))throw new QueryInputError('QUERY_INPUT','aggregates必须包含1至6项。');
  if((args.aggregates??[]).some(item=>!item||![left,right].includes(item.table)))throw new QueryInputError('QUERY_INPUT','每项aggregate必须指定leftTable或rightTable。');
  const metrics=checkedAggregates(args.aggregates,tables,types,q,aliases);
  const filters=args.filters??[];
  if(!Array.isArray(filters)||filters.length>10)throw new QueryInputError('QUERY_INPUT','filters必须是数组且最多10个条件；完整授权范围使用[]。');
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
export function groupedDatasetStatement(args,tables,types,q,valueSets=new Map()){
 const linked=args.leftTable!==undefined;
 const groups=args.groupColumns;
 if(!Array.isArray(groups)||!groups.length||groups.length>8)throw new QueryInputError('QUERY_INPUT','groupColumns必须包含1至8个分组字段。');
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
 return {...base,sql:base.sql.replace(/^SELECT /,`SELECT ${quoted.join(', ')}, `)+` GROUP BY ${quoted.join(', ')} ORDER BY ${quoted.join(', ')}`,columns:[...groupNames,...base.columns],...(args.rowKey?{rowKey:{column:args.rowKey,fields:groupNames}}:{}),numericColumns:args.aggregates.filter(a=>['sum','avg','count','count_distinct'].includes(a.op)||numericTypes.has(types.get(a.table??args.table)?.get(a.column))).map(a=>a.as)};
}

export async function createEnvironmentTools(e, q, cred, adapters = {}) {
  const secrets = [cred.username, cred.password]; let conn, token, active = true;
  const configs = new Map(), tables = new Map(), columnTypes = new Map(), tableEngines=new Map(), valueSets = new Map();
  const datasets=new ReportDatasets({reuseQueries:true,dataBudgetBytes:q.exportDataBudgetBytes??Number.MAX_SAFE_INTEGER,snapshotWindowMs:q.exportSnapshotWindowMs??300000,originalQuestion:adapters.originalQuestion,scope:createHash('sha256').update(JSON.stringify(e)).digest('hex'),secrets,maxRows:q.exportMaxRows,previewRows:q.maxRows,directory:adapters.exportDirectory,authorize:adapters.authorize,active:()=>active});
  if(adapters.schemaState){for(const [table,columns] of adapters.schemaState.tables??[]){if(!ident(table)||!(q.tables.includes('*')||q.tables.includes(table))||columns.some(c=>!ident(c)||secretName.test(c)))throw new Error('历史表结构不在当前授权');tables.set(table,columns);}for(const [table,types] of adapters.schemaState.types??[])columnTypes.set(table,new Map(types));for(const [table,engine] of adapters.schemaState.engines??[])tableEngines.set(table,engine);}
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
      const actual=adapters.loadCredential?await adapters.loadCredential():cred;for(const value of [actual.username,actual.password].filter(Boolean)){if(!secrets.includes(value))secrets.push(value);if(!datasets.secrets.includes(value))datasets.secrets.push(value);}
      conn = await driver.createConnection({ host: e.host, port: e.port, database: e.database, user: actual.username, password: actual.password, connectTimeout: q.timeoutMs, multipleStatements: false, enableCleartextPlugin: false,
        // Business IDs frequently exceed Number.MAX_SAFE_INTEGER. Keep BIGINT/DECIMAL values lossless so a value returned by one read can be used by the next read unchanged.
        supportBigNumbers: true, bigNumberStrings: true, dateStrings: true, jsonStrings: true,
        ...(e.tls ? { ssl: { rejectUnauthorized: true } } : {}) });
      if (!active) { conn.destroy(); conn = null; throw new Error('连接已超时'); }
      try { const [g] = await conn.query('SHOW GRANTS FOR CURRENT_USER'); checkAccountGrants(e, g); await conn.query(`SET SESSION MAX_EXECUTION_TIME=${q.timeoutMs}`); await conn.query('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ'); await conn.query('START TRANSACTION READ ONLY'); }
      catch (error) { conn.destroy(); conn = null; throw error; }
    }
    return conn;
  }
  const spec = e.kind === 'nacos' ? [
    { tool: 'connection', args: {}, description: '测试固定 Nacos 入口的 HTTP 登录，凭据留在本机' },
    { tool: 'discover', args: {}, description: '列出批准的命名空间内最多100条配置的引用和名称，不返回正文' },
    { tool: 'read_runtime_config', args: { ref: '从discover返回的ref' }, description: '读取已发现配置中的XXL-JOB管理台地址、启用开关和执行器名称；不返回正文或凭据。定时任务排查使用此工具，发现入口后由原问题继续网页调查。' },
    { tool: 'read_config', args: { ref: '从discover返回的ref' }, description: '读取一个已发现配置并解析同文件变量，仅返回数据库端点与解析状态' }
  ] : [
    { tool: 'connection', args: {}, description: '测试数据库连接、只读账号授权与只读事务' },
    { tool: 'tables', args: {cursor:'可选：nextCursor，默认0'}, description:'分页列出允许的基础表名称，先定位目标表再用schema读取列' },
    { tool: 'schema', args: { table: '可选：限定基础表名', columns: ['可选：要定向发现的准确字段名，最多20个；使用时必须提供table'], cursor: '可选：上次返回的nextCursor，默认0' }, description: '读取本数据库允许的基础表和普通字段；已知字段名时用table+columns定向发现，避免宽表分页遗漏；不读取业务数据' },
    { tool: 'count', args: { table: 'schema返回的表', distinctColumns: '可选：去重字段数组；空数组统计行数，非空按这些字段组合去重（不计含NULL的组合）', filters: '与select相同的明确筛选条件' }, description: '统计批准基础表筛选范围内的完整行数或指定字段组合去重数，不用样本行数代替总数，不支持任意SQL或联表' },
    { tool: 'group_count', args: { table: 'schema返回的表', groupColumns: ['用于判断重复的1至8个字段'], minCount: '最小重复数，默认2', filters: '与select相同的明确筛选条件' }, description: `按业务字段组合分组统计重复记录，返回重复最多的${q.maxRows}组；仅单表参数化查询。总行数大于业务去重数、疑似重复批次或重复提交时优先使用` },
    { tool: 'aggregate', args: {table:'schema返回的表',aggregates:[{op:'sum|avg|min|max|count|count_distinct',column:'count可省略，其余使用schema字段',as:'结果名'}],filters:'与select相同；可用本轮setRef作为in_set'},description:'在一个基础表内执行最多6项受控汇总；sum/avg仅允许schema确认的数值字段，不接受SQL表达式' },
    { tool: 'collect_values', args: {table:'schema返回的表',columns:['合并收集值的1至8个字段'],filters:'与select相同'},description:'从一个表的多列收集最多1000个去重值，返回本轮setRef和少量样本；后续aggregate或linked_aggregate可用in_set引用完整集合，适合组织层级等中间集合' },
    { tool: 'linked_aggregate', args: {leftTable:'左表',rightTable:'右表',join:{leftColumn:'左表关联字段',rightColumn:'右表关联字段'},aggregates:[{op:'sum|avg|min|max|count|count_distinct',table:'左表或右表',column:'字段',as:'结果名'}],filters:[{table:'左表或右表',column:'字段',op:'=|>|>=|<|<=|contains|in|in_set',value:'值或setRef'}]},description:'仅允许两个已读取基础表按一个等值字段关联并做受控汇总；所有表、列、数值类型和筛选均由程序校验，不接受任意SQL' },
    { tool: 'select', args: { table: 'schema返回的表', columns: ['字段'], filters: [{ column: '字段', op: '=|>|>=|<|<=|contains|in', value: '标量；in使用数组' }] }, description: `按明确条件读取最多${q.maxRows}行；columns最多12个已读取字段，filters最多6个条件；全量范围使用[]，不要伪造筛选条件；contains执行参数化子串匹配，in最多100个绑定值；仅基础表，不允许任意SQL、联表或写入` }
  ];
  if(e.kind==='mysql'&&q.exportMaxRows){
    spec.push({tool:'enrich_dataset',args:{datasetRef:'完整主对象数据集',keyColumn:'主对象唯一编码列',lookups:[{name:'area',datasetRef:'完整维度数据集',sourceColumn:'主对象已有列或上一步输出列',targetColumn:'维度唯一键',fields:[{column:'维度列',as:'新的输出列名'}],missing:'empty或error，必须明确',fallbackKey:'可选，源码已证实的默认配置关联键，须在同一完整维度数据中实际存在'}]},description:'同一任务内按实际关联键左连接维度，最多4步、每步4字段；可以沿显式parent键多级查名称。不执行SQL，不接受路径/表达式，不丢主对象。专属配置缺失且源码明确规定沿用通用配置时，可传fallbackKey（实际存在的默认行键），把生效值写入每行并标记沿用默认配置；不能猜默认键或常量。重复维度键拒绝猜选；missing=empty保留未匹配并写入name_status，返回未匹配数量。保留原取数时间，仍需最终核验。'}, {tool:'inspect_dataset',args:{datasetRef:'任务内数据集引用'},description:'查看已有数据集实际SQL、筛选参数、取数时间，或草稿列公式和来源；列表预览截断时使用。结果limited仍为true时不能猜测未展示条件。'}, {tool:'finalize_report',args:{datasetRef:'compose_report草稿引用',requirement:'原问题的交付要求，不缩减范围',expectedColumns:['按用户要求的完整列标题，顺序一致'],scopeEvidence:'完整对象范围的源码/文档依据及期间条件',populationRef:'独立原始范围数据集',populationKey:'业务主键',columnRules:[{label:'逐列标题',definition:'业务定义和公式',evidence:'源码或文档位置及实际规则'}],checks:[{source:'s1',column:'amount',referenceRef:'不同原始查询的完整分量合计基准集',referenceColumn:'amount',evidence:'与该分量同期间/状态/费用范围的独立汇总依据'}]},description:'草稿最终核验：missing=empty的原始金额保留为空，仅核对已知金额并登记缺失数；不能当0或参与加减。列顺序完全一致、完整业务对象集合相等、计算/total的所有来源分量与不同原始查询的基准集精确合计一致、取数窗口按管理员的exportSnapshotWindowMs配置（默认5分钟），返回实际起止时间；不等于同一事务。不能以草稿或同一查询自证；业务依据仍须源码核实。只有此工具返回exportFile，compose_report只产出draftFile。'}, {tool:'compare_datasets',args:{leftRef:'左数据集引用',rightRef:'右数据集引用',leftKey:'左主键列',rightKey:'右主键列'},description:'在任务内精确比较两个完整数据集的业务主键；返回各自数量、匹配数、左右缺失数量和有限缺失行预览，不重新查询数据库。不接受任意文件路径。'}, {tool:'list_datasets',args:{offset:'可选非负整数，默认0',limit:'可选1至20，默认20；按nextOffset继续'},description:'列出当前任务在本环境已完整读取并持久保存的数据集、字段、取数时间和摘要。新一轮先查看已有成果，compose_report可直接引用这些datasetRef，不要重复查询已取得的金额。跨轮引用需核对取数时点；不能把旧数据当实时状态。'}, {tool:'group_dataset',args:{table:'已读取结构的表',groupColumns:['经销商主键等分组字段'],rowKey:'可选，生成分组组合行键的输出列名，如row_key',aggregates:[{op:'sum',column:'数值字段',as:'amount'}],filters:'与aggregate相同'},description:`按实际分组字段汇总并由程序连续分页取完，${q.exportMaxRows==='all'?'不预设总行数，直到实际分页结束':'最多'+q.exportMaxRows+'组'}；返回datasetRef、完整性和少量预览。不是前${q.maxRows}行样本；可用于完整经销商报表。`},
    {tool:'linked_group_dataset',args:{leftTable:'左表',rightTable:'右表',join:{leftColumn:'字段',rightColumn:'字段',type:'可选inner或left，默认inner'},groupColumns:[{table:'左表或右表',column:'经销商主键'}],rowKey:'可选，如row_key，为所有分组字段生成稳定组合行键',aggregates:'与linked_aggregate相同',filters:'与linked_aggregate相同'},description:'两表受控等值关联后分组汇总并完整分页；一对多按实际明细粒度分组，须保留没有明细的主对象时指定join.type=left。left模式可保留授权内完整左表，右表filters在ON中筛选匹配明细，未匹配右字段为null，不能当0。需要导出一对象多行时指定rowKey，compose_report用返回的组合行键，独立范围查询也按相同分组生成rowKey核对；该键不是业务编号。不能重复累计左侧金额；enrich_dataset仅用于唯一维度查找，不能用于展开一对多。'},
    {tool:'period_dataset',args:{populationRef:'完整主对象数据集',keyColumns:['实际对象键'],period:{unit:'month或day或values',start:'2026-01',end:'2026-12',column:'period',values:'仅values时提供有序期间数组'},rowKey:'period_key',sources:[{datasetRef:'完整金额数据集',keyColumns:['对应对象键'],periodColumn:'月份列（YYYYMM/数值YYYYMM/YYYY-MM/YYYY-M）或日期列（YYYYMMDD/YYYY-MM-DD）',yearColumn:'可选，仅分开的年/月列',duplicates:'error或明确sum',outside:'error或exclude',outsideEvidence:'exclude时说明排除依据',metrics:[{column:'真实金额字段',as:'当期金额',cumulativeAs:'可选累计金额输出列',missing:'zero/empty/error，无发生记录',nulls:'zero/empty/error，实际金额为空'}]}]},description:'自动将六位年月、标准年月及分开的年/月统一为YYYY-MM；八位日期统一为YYYY-MM-DD，不做时区转换。非法日期明确报错，不能按outside=exclude吞掉后补零。无需额外SQL转换权限。按完整主对象×指定月/日/有序期间生成全部组合，保留无发生对象和空月份；多来源按对象复合键及期间对齐，精确十进制累计，支持跨年，累计从指定起点零开始。含期初余额的报表须另取期初来源并在compose_report显式相加，不把月度流量当余额。sources=[]生成独立覆盖范围；金额源必须同对象期间唯一，确需合并重复时明确sum。默认不猜缺失/空值；empty会让其后的累计保持未知。数据集保留派生配方与排除/缺失计数，可恢复/refresh重放。finalize每个期间金额列需要独立原始查询产生的另一个period_dataset作逐行基准，不能用同一查询自证或拿全年合计替代累计列；inspect_dataset查看实际列与来源。'},
    {tool:'compose_report',args:{sources:[{name:'s1',datasetRef:'本轮完整datasetRef',keyColumn:'经销商主键'}],columns:[{label:'经销商',value:{op:'key'}},{label:'余额',total:true,value:{op:'subtract',args:[{op:'field',source:'s1',column:'amount',missing:'zero'},{op:'field',source:'s2',column:'used',missing:'zero'}]}}]},description:'按业务主键全外连接本任务完整数据集（可选population:{datasetRef,keyColumn}限定完整主对象集合），生成CSV草稿并返回行数、校验和、列合计与预览；算术add/subtract/min可显式missing=empty传播未知：任一子项为空时结果留空，不能猜零；默认仍报错。列数按报表要求。sources[].name必须使用不重复的s1、s2等（s加数字）；field.source引用同名来源，不能改为业务名称。固定计算key/field/add/subtract/min，后3项使用args数组；field指定source、column及可选missing=zero或empty，缺失默认报错。数字精确十进制计算。数值列应标记total:true。只返回draftFile；之后finalize_report通过才可交付。必须先核实各来源口径、关联基数及覆盖范围，不得用样本或不完整数据集导出完整报表。'});
  }

  if(e.kind==='mysql'&&q.exportMaxRows)spec.push(
   {tool:'row_dataset',args:{table:'schema表',columns:['完整实际字段'],orderBy:['稳定唯一主键'],filters:[]},description:'读取原始完整行，不分组或去重；按稳定唯一键排序后完整分页保存datasetRef。JSON以完整字符串保留（不截断），随后expand_dataset拆行。全量filters=[]，范围仍按原授权；预览不是完整数据。'},
   {tool:'project_dataset',args:{datasetRef:'完整来源',fields:[{column:'实际来源列',as:'输出别名'}]},description:'保留所有行，仅投影或重命名已有列，不改值、不去重，不生成文件；跨来源统一对象/期间列名后union_dataset，保留取数时间、数值类型和可重放依赖。'},
   {tool:'normalize_period_dataset',args:{datasetRef:'完整来源',fields:[{column:'实际期间列',yearColumn:'可选分列年份',as:'新增统一期间列',unit:'month/day',nulls:'error/keep'}]},description:'在完整数据上新增标准期间列，不改原列。月支持YYYYMM、数值YYYYMM、YYYY-MM、YYYY-M或分列年/月；日支持YYYYMMDD/YYYY-MM-DD。非法日期报错，空值明确保留或报错；保留来源时间及可重放配方。跨来源先用project_dataset统一对象键别名和期间，再union_dataset，不需要任意SQL转换。'},
   {tool:'select_period_dataset',args:{datasetRef:'完整来源',keyColumns:['对象实际复合键'],periodColumn:'期间列',unit:'month/day',select:'first/last',ties:'all/error',nulls:'error/exclude',nullEvidence:'exclude时提供依据'},description:'按对象复合键选最早或最晚有效期间的原始整行，不按金额非零猜发生、不取全表最大日期。自动按日历比较混合期间格式；并列需明确全保留或报错，不任意选首行。可先规范各来源期间并union去重，再为每户选最后有效业务月份；再按对象+标准月份join_dataset到完整period_dataset余额网格，主对象left关联保留无发生对象。金额来源和决定末期的业务来源须分别核实，不默认所有金额来源都决定末期。配方支持恢复、刷新及文件核验，未发生与未知不得混淆。'},
   {tool:'expand_dataset',args:{datasetRef:'完整原始来源',column:'JSON数组列',keyColumns:['父行唯一键'],fields:[{path:['code'],as:'item_code'}],rowKey:'item_key',empty:'keep或drop'},description:'在程序中完整展开JSON数组，path=[]提取标量元素，path数组逐层取对象字段；精确保留数字与前导零。每项一行、空数组按明确keep/drop处理，保留父字段、原取数时间及审计；坏JSON报错不丢数据。'},
   {tool:'join_dataset',args:{leftRef:'完整左集',rightRef:'完整右集',leftKeys:['字段'],rightKeys:['字段'],join:'left或inner',cardinality:'one或many',fields:[{column:'右字段',as:'唯一别名'}],rowKey:'joined_key',statusColumn:'可选，输出匹配状态的唯一列名'},description:'在本任务完整数据上按复合键关联，可一对多展开；one时右键重复报错，many明确保留全部匹配。left保留未匹配左行并留空；返回未匹配数、来源时间及可重放配方。多级组织可反复按parent键关联，不需要数据库任意SQL。'},
   {tool:'union_dataset',args:{datasetRefs:['完整来源1','完整来源2'],columns:['同名投影字段'],keyColumns:['复合业务键'],rowKey:'union_key',duplicates:'error或distinct',evidence:'明确去重业务依据'},description:'跨来源按选定列合并，distinct仅在所有投影字段相同才合并；同键字段冲突拒绝任意丢弃。可用于多处编码集合交叉核对及保留无编码对象。'},
   {tool:'filter_dataset',args:{datasetRef:'已有完整集',match:'all或any',filters:[{column:'实际列',op:'=|!=|>|>=|<|<=|in|is_null|not_null',type:'text/date（自然日）/datetime（本地原值时分秒）/decimal',value:'比较值'}]},description:'按固定比较筛选已有完整数据，不查询数据库、不改变取数时间。年份重叠用开始<=年底并结束>=年初；date只比较自然日，datetime比较无时区原值时分秒。未知值不猜测；保留派生配方，精确小数比较不转浮点。'});
  const reuseSources=()=>reusableReportSources(adapters.dataDir,adapters.reportJob,datasets.storage.scope);
  if(e.kind==='mysql'&&q.exportMaxRows&&adapters.reportJob&&adapters.dataDir&&datasets.storage)spec.push({tool:'list_reusable_datasets',args:{offset:'可选分页起点0',limit:'可选1至20，按nextOffset继续'},description:'列出本任务同身份、同项目、同环境且明确关联问题的历史完整来源；保留原取数时间，不把历史当实时。优先复用后用filter_dataset处理后续追问，明确要求最新时才重新取数。'},{tool:'inspect_reusable_report',args:{sourceJobId:'目录返回的来源任务',fileId:'来源中已审阅通过的文件ID',section:'summary/columns/sources/checks/scope',offset:'可选0',limit:'可选1至4'},description:'按明确父问题和同身份环境读取已交付文件的实际列配方、来源引用与取数时间，分页查看；不能猜其他任务文件。后续筛选先看原文件配方，再导入对应完整来源，不重查SQL或让用户上传文件。'},{tool:'reuse_dataset',args:{sourceJobId:'目录返回的来源任务ID',datasetRef:'目录返回的完整来源ID'},description:'仅导入目录中明确关联的历史数据及完整依赖，重验范围、摘要、时间、派生配方；拒绝无关群/人/环境、过期或路径变化。不会重新执行SQL，也不重新标记为最新数据。'});
  let browser;
  if (q.browser === true && e.kind === 'nacos') { browser = await (adapters.browser ?? createNacosBrowser)(e,q,cred,adapters); spec.push(...browser.spec); }
  if(e.kind==='mysql'&&q.exportMaxRows){const final=spec.find(x=>x.tool==='finalize_report');spec.push({...final,tool:'refresh_report',description:'参数与finalize_report相同。仅当当前口径变更或取数时点超窗需要重算时使用：预检已有来源recipe及派生依赖，在一个新只读事务里集中刷新完整来源、独立基准、维度和对象范围，再重做草稿并核验。不能执行保存SQL；旧数据无recipe或含临时in_set须先补齐。历史快照差异本身不要求重算。返回新文件供原问题审阅，不自动发群。'});}
  if(e.kind==='mysql'&&q.exportMaxRows)spec.push({tool:'inspect_report',args:{fileId:'本任务已登记的report-ID',section:'可选summary/columns/sources/checks/scope，默认summary',offset:'可选非负整数',limit:'可选1至4'},description:'只读查看与某份已登记CSV摘要和核验记录绑定的实际表头、完整公式、来源、预览、主键范围对照及全文件逐行重算校验；不查数据库，不执行路径，不用另一个数据集冒充该文件。默认摘要，长文本用section分页。新文件审阅优先使用，不重新compose或让用户上传已有CSV。'});
  const run = async (tool, args = {}) => {
    if (!active) throw new Error('工具执行已结束');
    if (!spec.some(x => x.tool === tool) || !args || typeof args !== 'object' || Array.isArray(args)) throw new Error('不支持的工具或参数');
    if (tool.startsWith('browser_')) { if (!browser) throw new Error('当前范围未启用浏览器'); return browser.run(tool,args); }
    // Local immutable dataset work has no wall-clock cutoff; checks retain cancellation/auth.
    const localOnly=['inspect_reusable_report','list_reusable_datasets','reuse_dataset','expand_dataset','join_dataset','union_dataset','filter_dataset','normalize_period_dataset','select_period_dataset','project_dataset','period_dataset','compose_report','finalize_report','enrich_dataset','compare_datasets','inspect_report','inspect_dataset','list_datasets'].includes(tool);
    let timer;
    try {
      const operation=(async () => {
        if(tool==='list_reusable_datasets'){const sources=await reuseSources();const all=sources.flatMap(s=>s.datasets.map(d=>({sourceJobId:s.jobId,questionId:s.questionId,...d})));const offset=args.offset??0,limit=args.limit??20;if(!Number.isInteger(offset)||offset<0||!Number.isInteger(limit)||limit<1||limit>20)throw new QueryInputError('QUERY_INPUT','复用目录分页offset>=0，limit为1至20；按nextOffset继续');return {reports:offset===0?sources.flatMap(s=>s.reports.map(r=>({sourceJobId:s.jobId,...r}))):[],datasets:all.slice(offset,offset+limit),totalCount:all.length,nextOffset:offset+limit<all.length?offset+limit:null};}
        if(tool==='inspect_reusable_report'){await adapters.authorize?.();return inspectReusableReport(adapters.dataDir,adapters.reportJob,datasets.storage.scope,args);}
        if(tool==='reuse_dataset'){await adapters.authorize?.();return importReportDataset(datasets,args,await reuseSources(),adapters.dataDir);}
        if(['expand_dataset','join_dataset','union_dataset','filter_dataset','normalize_period_dataset','select_period_dataset','project_dataset'].includes(tool))return datasets.transform(tool,args);
        if(tool==='list_datasets')return datasets.list(args);
        if(tool==='compare_datasets')return datasets.compare(args);
        if(tool==='period_dataset')return datasets.period(args);
        if(tool==='compose_report')return datasets.compose(args);
        if(tool==='enrich_dataset')return datasets.enrich(args);
        if(tool==='finalize_report')return datasets.finalize(args);
        if(tool==='inspect_dataset')return datasets.inspect(args);
        if(tool==='inspect_report'){await adapters.authorize?.();return inspectReport(adapters.dataDir,adapters.reportJob,args);}
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
            return { configs: [...configs].map(([ref, x]) => ({ ref, namespace: sanitizedValue(x.namespace, secrets), dataId: sanitizedValue(x.dataId, secrets), group: sanitizedValue(x.group, secrets) })), truncated };
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
        if(tool==='compare_datasets')return datasets.compare(args);
        if(tool==='list_datasets')return datasets.list(args);
        if(tool==='period_dataset')return datasets.period(args);
        if(tool==='compose_report')return datasets.compose(args);
        if(tool==='enrich_dataset')return datasets.enrich(args);
        if(tool==='inspect_report'){await adapters.authorize?.();return inspectReport(adapters.dataDir,adapters.reportJob??{id:'none',reportFiles:[]},args);}
        if(tool==='inspect_dataset')return datasets.inspect(args);
        if(tool==='finalize_report')return datasets.finalize(args);
        if(tool==='refresh_report')return datasets.refresh(args,{
         begin:async()=>{const c=await mysql();await adapters.authorize?.();await c.rollback();readCache.clear();readCacheBytes=0;await c.query('START TRANSACTION READ ONLY');},
         reload:async recipe=>{for(const table of [recipe.args.table,recipe.args.leftTable,recipe.args.rightTable].filter(Boolean)){let cursor;do{const page=await run('schema',{table,...(cursor!==undefined?{cursor}:{})});cursor=page.nextCursor;}while(cursor!==null&&cursor!==undefined);}return run(recipe.tool,structuredClone(recipe.args));}
        });
        const c = await mysql();
        if(tool==='row_dataset'||tool==='group_dataset'||tool==='linked_group_dataset'){for(const name of [args.table,args.leftTable,args.rightTable].filter(Boolean))if(tableEngines.get(name)!=='innodb')throw new QueryInputError('SNAPSHOT_REQUIRED','完整分页要求已读取schema且目标表使用InnoDB；未知或非事务引擎不能声称一致快照。');const statement=tool==='row_dataset'?rowDatasetStatement(args,tables,columnTypes,q):groupedDatasetStatement(args,tables,columnTypes,q,valueSets);return datasets.collect({...statement,recipe:{tool,args:structuredClone(args)}},(s,p)=>c.execute({...s,timeout:q.timeoutMs},p));}
        if (tool === 'connection') return { stage: '数据库连接、账号策略和只读事务已验证' };
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
          const columnClause = requestedColumns ? ` AND c.COLUMN_NAME IN (${requestedColumns.map(() => '?').join(', ')})` : '';
          const [rows] = await read(c,{ sql: "SELECT c.TABLE_NAME AS table_name,c.COLUMN_NAME AS column_name,c.DATA_TYPE AS data_type,t.ENGINE AS engine FROM information_schema.COLUMNS c JOIN information_schema.TABLES t ON t.TABLE_SCHEMA=c.TABLE_SCHEMA AND t.TABLE_NAME=c.TABLE_NAME WHERE c.TABLE_SCHEMA=? AND t.TABLE_TYPE='BASE TABLE' AND c.EXTRA NOT LIKE '%GENERATED%'" + (args.table ? " AND c.TABLE_NAME=?" : "") + columnClause + ` ORDER BY c.TABLE_NAME,c.ORDINAL_POSITION LIMIT 101 OFFSET ${requestedColumns ? 0 : offset}`, timeout: q.timeoutMs }, [e.database, ...(args.table ? [args.table] : []), ...(requestedColumns ?? [])]);
          const visible = new Map();
          for (const r of rows.slice(0,100)) if (ident(r.table_name) && ident(r.column_name) && !secretName.test(r.column_name) && (q.tables.includes('*') || q.tables.includes(r.table_name))) {
            if(typeof r.engine==='string')tableEngines.set(r.table_name,r.engine.toLowerCase());
            visible.set(r.table_name,[...(visible.get(r.table_name)??[]),r.column_name]);
            tables.set(r.table_name,[...new Set([...(tables.get(r.table_name)??[]),r.column_name])]);
            if(typeof r.data_type==='string'){const known=columnTypes.get(r.table_name)??new Map();known.set(r.column_name,r.data_type.toLowerCase());columnTypes.set(r.table_name,known);}
          }
          const result = {tables:Object.fromEntries(visible),truncated:requestedColumns ? false : rows.length>100,nextCursor:!requestedColumns && rows.length>100?offset+100:null};
          if(result.truncated) result.note='仅当前页表结构；可用schema的nextCursor继续，或指定table读取目标表。';
          return result;
        }
        if (tool === 'count') {
          const statement = countStatement(args, tables, q);
          const [rows] = await read(c,{ sql: statement.sql, timeout: q.timeoutMs }, statement.params);
          return { table: args.table, rows: [{ total: String(rows[0].total), countMode: args.distinctColumns?.length ? 'distinct' : 'rows', distinctColumns: (args.distinctColumns ?? []).join(',') }], truncated: false };
        }
        if(tool==='group_count'){
          const statement=groupCountStatement(args,tables,q);
          const [rows]=await read(c,{sql:statement.sql,timeout:q.timeoutMs},statement.params);
          return {table:args.table,rows:rows.slice(0,q.maxRows).map(row=>Object.fromEntries([...statement.groupColumns,'duplicate_count'].map(key=>[key,sanitizedValue(row[key],secrets)]))),
            truncated:rows.length>q.maxRows,groupColumns:statement.groupColumns,stage:`已按 ${statement.groupColumns.join('、')} 核对重复组合`};
        }
        if(tool==='collect_values'){
          const statement=collectValuesStatement(args,tables,q);const [rows]=await read(c,{sql:statement.sql,timeout:q.timeoutMs},statement.params);
          const values=[...new Set(rows.slice(0,1000).flatMap(row=>statement.columns.map(column=>row[column])).filter(value=>value!==null&&value!==undefined&&['string','number','bigint'].includes(typeof value)).map(String))];
          const setRef=`set-${valueSets.size+1}`;valueSets.set(setRef,{values,truncated:rows.length>1000});
          return {table:args.table,setRef,valueCount:values.length,sample:values.slice(0,Math.min(q.maxRows,20)),truncated:rows.length>1000,stage:`已收集 ${values.length} 个去重值供本轮关联汇总`};
        }
        if(tool==='aggregate'||tool==='linked_aggregate'){
          const statement=tool==='aggregate'?aggregateStatement(args,tables,columnTypes,q,valueSets):linkedAggregateStatement(args,tables,columnTypes,q,valueSets);
          const [rows]=await read(c,{sql:statement.sql,timeout:q.timeoutMs},statement.params);
          return {rows:rows.slice(0,1).map(row=>Object.fromEntries(statement.columns.map(key=>[key,sanitizedValue(row[key],secrets)]))),truncated:false,stage:tool==='aggregate'?'已完成单表汇总':'已完成受控关联汇总'};
        }
        const statement = selectStatement(args, tables, q);
        const [rows] = await read(c,{ sql: statement.sql, timeout: q.timeoutMs }, statement.params);
        return { table: args.table, rows: rows.slice(0, q.maxRows).map(r => Object.fromEntries(statement.columns.map(k => [k, sanitizedValue(r[k], secrets)]))), truncated: rows.length > q.maxRows };
      })();
      if(localOnly)return await operation;
      return await Promise.race([operation,new Promise((_, reject) => { timer = setTimeout(() => { active = false; conn?.destroy(); conn = null; reject(new Error('环境工具超时')); }, ['inspect_reusable_report','list_reusable_datasets','reuse_dataset','row_dataset','expand_dataset','join_dataset','union_dataset','filter_dataset','normalize_period_dataset','select_period_dataset','project_dataset','group_dataset','linked_group_dataset','period_dataset','compose_report','finalize_report','refresh_report','enrich_dataset','compare_datasets','inspect_report','inspect_dataset','list_datasets'].includes(tool)?q.exportTimeoutMs??30000:q.timeoutMs); })]);
    } catch (error) { if(error instanceof ReportInspectionError)throw new QueryInputError(error.code,error.message); if(error instanceof DatasetCapacityError)throw new QueryInputError(error.code,error.message); if(error instanceof ReportInputError||error?.code==='REPORT_INPUT')throw new QueryInputError('REPORT_INPUT',error.message); if (error instanceof QueryInputError) throw error; throw safeExecutionError(error); }
    finally { clearTimeout(timer); }
  };
  return { spec, run, exportSchema:()=>({tables:[...tables],types:[...columnTypes].map(([t,m])=>[t,[...m]]),engines:[...tableEngines]}),resetConnection:async()=>{readCache.clear();readCacheBytes=0;if(conn){try{await conn.rollback();}finally{conn.destroy();conn=null;}}}, close: async ({ abort = false } = {}) => { active = false; token = null; readCache.clear(); datasets.clear(); await browser?.close(); if (conn) { try { if (!abort) await conn.rollback(); } finally { conn.destroy(); conn = null; } } } };
}
