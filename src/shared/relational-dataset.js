import {createHash} from 'node:crypto';
import {normalizeCalendarPeriod} from './period-dataset.js';
const hash=x=>createHash('sha256').update(JSON.stringify(x)).digest('hex');
const safe=k=>typeof k==='string'&&k.length>0&&!['__proto__','prototype','constructor'].includes(k)&&!/[\u0000-\u001f]/.test(k);
export class RelationalInputError extends Error{constructor(message){super(message);this.code='REPORT_INPUT';}}
const fail=m=>{throw new RelationalInputError(m);};
const col=(d,c)=>{if(!safe(c)||!d.columns.includes(c))fail('字段未包含在完整来源中');return c;};
const scalar=v=>{if(v===null||v===undefined)return null;if(typeof v==='string')return v;if(typeof v==='bigint')return String(v);if(typeof v==='boolean')return v?'true':'false';if(typeof v==='number'&&Number.isSafeInteger(v))return String(v);fail('JSON提取值必须是精确标量；对象/数组须继续展开，不截断或猜值');};
const key=(r,cs)=>cs.some(c=>r[c]===null||r[c]===undefined||r[c]==='')?null:JSON.stringify(cs.map(c=>r[c]));
export function transformRefs(tool,args){return tool==='join_dataset'?[args.leftRef,args.rightRef]:tool==='union_dataset'?args.datasetRefs:[args.datasetRef];}
export function remapTransform(tool,args,map){return tool==='join_dataset'?{...args,leftRef:map(args.leftRef),rightRef:map(args.rightRef)}:tool==='union_dataset'?{...args,datasetRefs:args.datasetRefs.map(map)}:{...args,datasetRef:map(args.datasetRef)};}
export function parseExactJson(s){return JSON.parse(s,(k,v,ctx)=>typeof v==='number'?(ctx?.source??(Number.isSafeInteger(v)?String(v):fail('JSON数字精度无法核实'))):v);}
export async function transformDataset(tool,args,load,{check=async()=>{},maxRows=Number.MAX_SAFE_INTEGER}={}){
 const refs=transformRefs(tool,args);if(!refs.length||refs.some(r=>typeof r!=='string'))fail('需要实际数据集引用');
 const inputs=[];for(const ref of refs){await check();const d=await load(ref);if(!d?.complete||!Array.isArray(d.rows))fail('只可使用完整数据集，不能用预览或不完整来源');inputs.push(d);}
 let rows=[],columns=[],numericColumns=[],audit={};
 const add=row=>{if(rows.length>=maxRows)fail('派生数据超过当前管理员明确授权行数，未发布部分结果');rows.push(row);};
 if(tool==='project_dataset'){
  const d=inputs[0],fs=args.fields;if(!Array.isArray(fs)||!fs.length||fs.some(f=>!f||typeof f!=='object')||new Set(fs.map(f=>f.as)).size!==fs.length||fs.some(f=>!safe(f.as)))fail('投影需真实字段及唯一输出别名');fs.forEach(f=>col(d,f.column));
  for(const row of d.rows){await check();add(Object.fromEntries(fs.map(f=>[f.as,row[f.column]])));}columns=fs.map(f=>f.as);numericColumns=fs.filter(f=>d.numericColumns?.includes(f.column)).map(f=>f.as);audit={inputRows:d.rows.length,outputRows:rows.length};
 }else if(tool==='normalize_period_dataset'){
  const d=inputs[0],fs=args.fields;
  if(!Array.isArray(fs)||!fs.length||fs.some(f=>!f||typeof f!=='object')||new Set(fs.map(f=>f.as)).size!==fs.length)fail('期间标准化需要不重复的fields');
  for(const f of fs){col(d,f.column);if(!safe(f.as)||d.columns.includes(f.as)||!['month','day'].includes(f.unit)||!['error','keep'].includes(f.nulls))fail('期间字段需新增as、unit=month/day、nulls=error/keep');if(f.yearColumn){col(d,f.yearColumn);if(f.unit!=='month')fail('分列年/月仅适用于month');}}
  let nullCells=0;for(const row of d.rows){await check();const out={...row};for(const f of fs){let value=row[f.column];if(value===null||value===''){nullCells++;if(f.nulls==='error')fail('来源期间为空；须核实或明确nulls=keep');out[f.as]=value;continue;}
   if(f.yearColumn){const y=String(row[f.yearColumn]),m=String(value);if(!/^\d{4}$/.test(y)||!/^\d{1,2}$/.test(m))fail('分列期间必须为四位年及1至12月');value=y+'-'+m.padStart(2,'0');}out[f.as]=normalizeCalendarPeriod(value,f.unit);
  }add(out);}columns=[...d.columns,...fs.map(f=>f.as)];numericColumns=d.numericColumns??[];audit={inputRows:d.rows.length,outputRows:rows.length,nullCells,normalization:'calendar-v1'};
 }else if(tool==='select_period_dataset'){
  const d=inputs[0],ks=args.keyColumns;col(d,args.periodColumn);
  if(!Array.isArray(ks)||!ks.length||new Set(ks).size!==ks.length||!['first','last'].includes(args.select)||!['all','error'].includes(args.ties)||!['month','day'].includes(args.unit)||!['error','exclude'].includes(args.nulls))fail('首末期间需keyColumns、unit=month/day、select=first/last、ties=all/error及nulls=error/exclude');ks.forEach(c=>col(d,c));
  if(args.nulls==='exclude'&&!(typeof args.nullEvidence==='string'&&args.nullEvidence.trim()))fail('排除空期间需要业务依据，不能静默丢失对象');
  const groups=new Map();let nullRows=0;for(const row of d.rows){await check();const k=key(row,ks);if(k===null)fail('分组键为空，不能猜测对象');const raw=row[args.periodColumn];if(raw===null||raw===''){nullRows++;if(args.nulls==='error')fail('首末期间来源有空值');continue;}const period=normalizeCalendarPeriod(raw,args.unit),prev=groups.get(k),better=!prev||(args.select==='last'?period>prev.period:period<prev.period);
   if(better)groups.set(k,{period,rows:[row]});else if(period===prev.period)prev.rows.push(row);
  }
  let tieGroups=0;for(const g of groups.values()){if(g.rows.length>1){tieGroups++;if(args.ties==='error')fail('选中期间存在并列记录；核实粒度或明确ties=all，不能任意选第一条');}for(const row of g.rows)add({...row});}columns=d.columns;numericColumns=d.numericColumns??[];audit={inputRows:d.rows.length,outputRows:rows.length,groups:groups.size,tieGroups,nullRows,select:args.select};
 }else if(tool==='expand_dataset'){
  const d=inputs[0];col(d,args.column);const fs=args.fields;
  if(!['keep','drop'].includes(args.empty)||!Array.isArray(fs)||!fs.length||fs.some(f=>!safe(f.as)||!Array.isArray(f.path)||f.path.some(k=>!safe(k)))||new Set(fs.map(f=>f.as)).size!==fs.length)fail('展开需fields[{path:字段路径数组,as:输出列}]及empty=keep/drop');
  const rowKey=args.rowKey;if(!safe(rowKey)||[...d.columns,...fs.map(f=>f.as)].includes(rowKey)||fs.some(f=>d.columns.includes(f.as)))fail('展开输出列与行键必须唯一且不能覆盖来源字段');
  const parentKeys=args.keyColumns;if(!Array.isArray(parentKeys)||!parentKeys.length)fail('展开需真实父行唯一键keyColumns');parentKeys.forEach(c=>col(d,c));
  const seen=new Set();let empty=0,items=0;
  for(const r of d.rows){await check();const parent=key(r,parentKeys);if(parent===null||seen.has(parent))fail('JSON父行键为空或重复，须先确定实际行粒度');seen.add(parent);
   let a;try{a=r[args.column]===null||r[args.column]===''?[]:parseExactJson(r[args.column]);}catch(e){if(e instanceof RelationalInputError)throw e;fail('JSON格式无效，未丢弃该行，未发布部分展开结果');}
   if(a===null)a=[];if(!Array.isArray(a))fail('目标JSON不是数组；不能将对象或标量当列表');if(!a.length){empty++;if(args.empty==='keep')add({...r,...Object.fromEntries(fs.map(f=>[f.as,null])),[rowKey]:hash([parent,null])});continue;}
   for(const [i,item] of a.entries()){const out={...r};for(const f of fs){let v=item;for(const k of f.path){if(v===null||typeof v!=='object'||!Object.hasOwn(v,k)){v=null;break;}v=v[k];}out[f.as]=scalar(v);}out[rowKey]=hash([parent,i]);add(out);items++;}
  }
  columns=[...d.columns,...fs.map(f=>f.as),rowKey];numericColumns=d.numericColumns??[];audit={parentRows:d.rows.length,arrayItems:items,emptyParentRows:empty,emptyPolicy:args.empty};
 }else if(tool==='join_dataset'){
  const [l,r]=inputs,left=args.leftKeys,right=args.rightKeys;
  if(!['left','inner'].includes(args.join)||!['one','many'].includes(args.cardinality)||!Array.isArray(left)||!left.length||!Array.isArray(right)||left.length!==right.length)fail('关联需leftKeys/rightKeys、join=left/inner及cardinality=one/many');left.forEach(c=>col(l,c));right.forEach(c=>col(r,c));
  const fs=args.fields;if(!Array.isArray(fs)||!fs.length||fs.some(f=>!safe(f.as)||!r.columns.includes(f.column))||new Set(fs.map(f=>f.as)).size!==fs.length||fs.some(f=>l.columns.includes(f.as)))fail('关联输出字段必须真实、唯一、不覆盖左列');
  const rowKey=args.rowKey;if(!safe(rowKey)||[...l.columns,...fs.map(f=>f.as)].includes(rowKey))fail('关联需不重复的输出rowKey');
  if(args.statusColumn&&(!safe(args.statusColumn)||[...l.columns,...fs.map(f=>f.as),rowKey].includes(args.statusColumn)))fail('匹配状态列不能覆盖已有字段');
  const index=new Map();for(const row of r.rows){const k=key(row,right);if(k===null)continue;const a=index.get(k)??[];a.push(row);if(args.cardinality==='one'&&a.length>1)fail('右表键重复；不能猜测选一条或意外倍增金额，请明确many或修正粒度');index.set(k,a);}
  let unmatched=0;for(const [i,row] of l.rows.entries()){await check();const k=key(row,left),matches=k===null?[]:index.get(k)??[];if(!matches.length)unmatched++;for(const [j,other] of (matches.length?matches:args.join==='left'?[null]:[]).entries())add({...row,...Object.fromEntries(fs.map(f=>[f.as,other?.[f.column]??null])),[rowKey]:hash([i,j]),...(args.statusColumn?{[args.statusColumn]:other?'已匹配':'未匹配'}:{})});}
  columns=[...l.columns,...fs.map(f=>f.as),rowKey,...(args.statusColumn?[args.statusColumn]:[])];numericColumns=[...(l.numericColumns??[]),...fs.filter(f=>r.numericColumns?.includes(f.column)).map(f=>f.as)];audit={leftRows:l.rows.length,rightRows:r.rows.length,unmatchedLeftRows:unmatched,...(unmatched===l.rows.length&&l.rows.length&&r.rows.length?{warning:'整个关联零匹配；核对源码实际左右列、空值和JSON形态，不能猜成全部业务缺失'}:{}),outputRows:rows.length,join:args.join,cardinality:args.cardinality};
 }else if(tool==='union_dataset'){
  const cs=args.columns,ks=args.keyColumns;if(!Array.isArray(cs)||!cs.length||new Set(cs).size!==cs.length||!Array.isArray(ks)||!ks.length||ks.some(k=>!cs.includes(k))||!['error','distinct'].includes(args.duplicates)||typeof args.evidence!=='string'||!args.evidence.trim())fail('合并需实际columns、keyColumns及明确duplicates=error/distinct和业务依据');
  const rowKey=args.rowKey;if(!safe(rowKey)||cs.includes(rowKey))fail('合并需唯一输出rowKey');const seen=new Map();let duplicates=0;
  for(const d of inputs){cs.forEach(c=>col(d,c));for(const r of d.rows){await check();const row=Object.fromEntries(cs.map(c=>[c,r[c]])),k=JSON.stringify(ks.map(c=>row[c]));if(seen.has(k)){duplicates++;if(args.duplicates==='error'||JSON.stringify(seen.get(k))!==JSON.stringify(row))fail('合并键重复或非键字段冲突，未任意丢弃记录');continue;}seen.set(k,row);add({...row,[rowKey]:hash(k)});}}
  columns=[...cs,rowKey];numericColumns=cs.filter(c=>inputs.every(d=>d.numericColumns?.includes(c)));audit={inputRows:inputs.reduce((n,d)=>n+d.rows.length,0),duplicateRows:duplicates,outputRows:rows.length,duplicates:args.duplicates,evidence:args.evidence};
 }else if(tool==='filter_dataset'){
  const d=inputs[0],fs=args.filters;if(!Array.isArray(fs)||!['all','any'].includes(args.match))fail('筛选需filters数组和match=all/any');
  const predicates=fs.map(f=>{col(d,f.column);if(!['=','!=','>','>=','<','<=','in','is_null','not_null'].includes(f.op))fail('仅支持固定比较、in、空值判断');if(!['is_null','not_null'].includes(f.op)&&!['text','date','datetime','decimal'].includes(f.type))fail('比较需明确type=text/date/datetime/decimal');
   const comparable=v=>{if(v===null||!['string','number','boolean','bigint'].includes(typeof v))fail('比较值必须是明确标量，空值使用is_null/not_null');if(typeof v==='number'&&!Number.isSafeInteger(v))fail('比较值需精确字符串，不能使用已丢失精度的数字');if(['date','datetime'].includes(f.type)){if(typeof v!=='string'||!/^\d{4}-\d{2}-\d{2}(?:[ T]\d{2}:\d{2}:\d{2}(?:\.\d+)?)?$/.test(v)||!Number.isFinite(Date.parse(v.replace(' ','T')+(v.length>10?'Z':'')))||new Date(v.slice(0,10)).toISOString().slice(0,10)!==v.slice(0,10))fail('日期须为明确有效的数据库日期字符串，不做本机时区猜测');return f.type==='date'?v.slice(0,10):v.replace('T',' ').padEnd(19,'0').replace(/^(\d{4}-\d{2}-\d{2})0{9}$/,'$1 00:00:00');}
    if(f.type==='decimal'){if(!/^-?\d+(?:\.\d+)?$/.test(String(v)))fail('数值比较必须为精确十进制字符串');const [a,b='']=String(v).replace(/^-/,'').split('.');return {negative:String(v).startsWith('-'),digits:a.replace(/^0+(?=\d)/,''),fraction:b};}return String(v);};
   const cmp=(a,b)=>{if(f.type!=='decimal')return a<b?-1:a>b?1:0;const width=Math.max(a.fraction.length,b.fraction.length),x=BigInt((a.negative?'-':'')+a.digits+a.fraction.padEnd(width,'0')),y=BigInt((b.negative?'-':'')+b.digits+b.fraction.padEnd(width,'0'));return x<y?-1:x>y?1:0;};
   if(f.op==='in'&&!Array.isArray(f.value))fail('in需值数组');const values=['is_null','not_null'].includes(f.op)?[]:(f.op==='in'?f.value:[f.value]).map(comparable);
   return row=>{const v=row[f.column];if(f.op==='is_null')return v===null;if(f.op==='not_null')return v!==null;if(v===null)return false;const a=comparable(v);if(f.op==='in')return values.some(b=>cmp(a,b)===0);const c=cmp(a,values[0]);return f.op==='='?c===0:f.op==='!='?c!==0:f.op==='>'?c>0:f.op==='>='?c>=0:f.op==='<'?c<0:c<=0;};});
  for(const row of d.rows){await check();if(args.match==='all'?predicates.every(p=>p(row)):predicates.some(p=>p(row)))add({...row});}columns=d.columns;numericColumns=d.numericColumns??[];audit={inputRows:d.rows.length,outputRows:rows.length,excludedRows:d.rows.length-rows.length};
 }else fail('不支持的数据转换');
 const readAt=inputs.map(d=>d.readAt).sort()[0],readThroughAt=inputs.map(d=>d.readThroughAt??d.readAt).sort().at(-1),ids=[...new Set(inputs.map(d=>d.snapshotId))].sort();
 return {rows,columns,numericColumns,complete:true,readAt,readThroughAt,snapshotId:ids.length===1?ids[0]:hash(ids),derivation:{kind:'relational_transform',tool,args,inputs:refs,audit}};
}
export async function verifyRelationalDataset(data,load,options={}){
 if(data.derivation?.kind!=='relational_transform')return;
 const next=await transformDataset(data.derivation.tool,data.derivation.args,load,options);
 if(hash([data.rows,data.columns,data.derivation.audit])!==hash([next.rows,next.columns,next.derivation.audit]))fail('派生数据与来源重放不一致，未交付文件');
}

export async function verifyTransformTree(data,load,options={},visiting=new Set()){
 const d=data?.derivation;if(!d)return;const mark=hash(d);if(visiting.has(mark))fail('派生依赖循环');visiting.add(mark);
 const refs=d.kind==='relational_transform'?d.inputs:d.kind==='left_lookup'?[d.datasetRef,...d.lookups.map(l=>l.datasetRef)]:d.kind==='period_grid'?[d.args.populationRef,...d.args.sources.map(x=>x.datasetRef)]:[];
 for(const ref of refs)await verifyTransformTree(await load(ref),load,options,visiting);await verifyRelationalDataset(data,load,options);visiting.delete(mark);
}
