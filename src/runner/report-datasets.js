import {transformDataset,verifyRelationalDataset,transformRefs,remapTransform} from '../shared/relational-dataset.js';
import {buildPeriodDataset,verifyPeriodDataset} from '../shared/period-dataset.js';
import {TaskDatasetStore} from './task-dataset-store.js';
import {randomUUID,createHash} from 'node:crypto';
import {mkdir,writeFile,rename,rm,readFile,lstat} from 'node:fs/promises';
import path from 'node:path';

export class ReportInputError extends Error {constructor(message){super(message);this.code='REPORT_INPUT';}}

// Task-scoped evidence can resume under renewed authorization; never shared as knowledge.
export class ReportDatasets {
 constructor({maxRows,previewRows=20,directory,authorize=async()=>{},active=()=>true,secrets=[],scope,originalQuestion='',cacheBytes=16_000_000,snapshotWindowMs=300000,dataBudgetBytes=Number.MAX_SAFE_INTEGER,reuseQueries=false}){
  this.reuseQueries=reuseQueries;this.cacheBytes=cacheBytes;this.snapshotWindowMs=snapshotWindowMs;this.originalQuestion=originalQuestion;this.snapshotId=randomUUID();this.storage=directory&&scope?new TaskDatasetStore(directory,scope,{maxBytes:dataBudgetBytes}):null;
  this.secrets=secrets.filter(Boolean);this.maxRows=maxRows==='all'?Number.MAX_SAFE_INTEGER:maxRows;this.previewRows=Math.min(previewRows,20);this.directory=directory;this.authorize=authorize;this.active=active;this.collected=new Map();this.datasets=new Map();this.bytes=0;this.files=0;
 }
 async check(){if(!this.active())throw new ReportInputError('报表查询已结束');await this.authorize();if(!this.active())throw new ReportInputError('报表查询已结束');}
 async collect(statement,execute){
  await this.check();
  const queryHash=createHash('sha256').update(JSON.stringify([statement.sql,statement.params])).digest('hex');
  const signature=hash([queryHash,statement.columns,statement.numericColumns??[],statement.rowKey??null]);
  const previous=this.reuseQueries?this.collected.get(signature):null;
  if(previous){const d=await this.restore(previous.datasetRef);if(d?.complete)return {...previous,reused:true,stage:'复用本轮同一只读事务中已完成的相同查询；保留原取数时间'};}
  const rows=[];const batch=500;let complete=false;
  for(let offset=0;offset<=this.maxRows;offset+=batch){
   await this.check();const size=Math.min(batch,this.maxRows-offset+1);
   const [page]=await execute({sql:`${statement.sql} LIMIT ${size} OFFSET ${offset}`},statement.params);
   await this.check();if(!Array.isArray(page)||page.length>size)throw new ReportInputError('报表分页返回异常');
   for(const row of page){
    if(rows.length===this.maxRows)break;
    const clean=Object.fromEntries(statement.columns.map(c=>{const v=row[c];if(v!==null&&!['string','number','bigint'].includes(typeof v))throw new ReportInputError(`报表含不支持的字段值：列${c}，类型${v instanceof Date?'Date':Array.isArray(v)?'array':typeof v}；日期应由驱动dateStrings保留原值，结构化字段须先核实类型，不可猜值或删列`);if(typeof v==='number'&&!Number.isSafeInteger(v))throw new ReportInputError('报表数值未以精确字符串返回，停止导出');return [c,v===null?null:this.secrets.reduce((text,secret)=>text.split(secret).join('[已隐藏]'),String(v))];}));
    if(statement.rowKey)clean[statement.rowKey.column]=hash(statement.rowKey.fields.map(c=>clean[c]));
    rows.push(clean);
   }
   if(page.length<size){complete=true;break;}
   if(page.length>this.maxRows-offset)break;
  }
  if(complete&&statement.uniqueKeyColumns){const seen=new Set();for(const row of rows){const values=statement.uniqueKeyColumns.map(c=>row[c]),key=JSON.stringify(values);if(values.some(v=>v===null||v==='')||seen.has(key))throw new ReportInputError('分页排序键不是非空唯一键，未发布可能重复或遗漏的完整数据');seen.add(key);}}
  // A short final page proves completion; exactly-at-cap requires one look-ahead.
  const ref=`dataset-${randomUUID()}`,data={rows,columns:[...statement.columns,...(statement.rowKey?[statement.rowKey.column]:[])],complete,numericColumns:statement.numericColumns??[],queryHash,queryDefinition:{sql:statement.sql,params:statement.params.map(v=>this.secrets.reduce((text,secret)=>text.split(secret).join('[已隐藏]'),String(v)))}};
  if(statement.recipe){const original=JSON.stringify(statement.recipe),safe=this.secrets.reduce((text,secret)=>text.split(secret).join('[已隐藏]'),original);data.recipe={...JSON.parse(safe),replayable:original===safe};}
  const dataHash=createHash('sha256').update(JSON.stringify(data)).digest('hex');
  let readAt=new Date().toISOString();if(complete&&this.storage){await this.check();const saved=await this.storage.save(ref,data,this.snapshotId);readAt=saved.readAt;await this.check();}
  this.remember(ref,{...data,snapshotId:this.snapshotId,readAt});
  const result={datasetRef:ref,queryHash,dataHash,snapshotId:this.snapshotId,readAt,queryDefinition:queryPreview(data.queryDefinition),rowCount:rows.length,complete,truncated:!complete,partial:!complete,columns:data.columns,preview:preview(rows,this.previewRows),stage:complete?'分组数据已完整读取':'达到报表行数上限；数据不完整，不能合成完整报表'};
  if(complete&&this.reuseQueries)this.collected.set(signature,result);return result;
 }
 async list({offset=0,limit=20}={}){await this.check();if(!Number.isInteger(offset)||offset<0||!Number.isInteger(limit)||limit<1||limit>20)throw new ReportInputError('数据集目录offset须为非负整数，limit为1至20');const all=this.storage?await this.storage.list():[];await this.check();const candidates=all.sort((a,b)=>b.readAt.localeCompare(a.readAt)||a.datasetRef.localeCompare(b.datasetRef)).slice(offset,offset+limit),datasets=[];let bytes=0;for(const item of candidates){const size=Buffer.byteLength(JSON.stringify(item));if(datasets.length&&bytes+size>16000)break;datasets.push(item);bytes+=size;}return {datasets,totalCount:all.length,nextOffset:offset+datasets.length<all.length?offset+datasets.length:null,note:'仅当前任务及经明确关联导入、相同环境配置的完整数据集；沿原任务历史保留策略，不另设24小时失效；目录分页，历史取数不是当前实时状态，多轮快照不是同一个事务。'};}
 async inspect(args){await this.check();const data=await this.restore(args.datasetRef);if(!data)throw new ReportInputError('数据集引用无效');const q=data.queryDefinition;return {datasetRef:args.datasetRef,columns:data.columns,rowCount:data.rows.length,readAt:data.readAt,snapshotId:data.snapshotId,queryHash:data.queryHash,queryDefinition:q?{sql:q.sql.slice(0,6000),params:q.params.slice(0,50),limited:q.sql.length>6000||q.params.length>50}:null,derivation:data.derivation,reportDraft:data.reportDraft?{sources:data.reportDraft.sources,columns:data.reportDraft.columns,finalization:{expectedColumns:data.columns,requiredChecks:requiredChecks(data),snapshotWindowMs:this.snapshotWindowMs,note:'每个requiredChecks项需另一原始查询的完整独立基准；范围population必须为独立原始对象集合。'}}:undefined};}
 async restore(ref){
  if(this.datasets.has(ref)){const data=this.datasets.get(ref);this.datasets.delete(ref);this.datasets.set(ref,data);return data;}
  await this.check();if(!this.storage)return null;
  let saved;try{saved=await this.storage.get(ref);}catch{throw new ReportInputError('数据集范围、有效期、文件或摘要校验失败；先调用list_datasets核对本任务已有成果，必要时重新取数。');}await this.check();const bytes=Buffer.byteLength(JSON.stringify(saved.data));
  if(saved.data.rows.length>this.maxRows)throw new ReportInputError('恢复数据集超过当前授权行数上限');
  const data={...saved.data,readAt:saved.readAt,snapshotId:saved.snapshotId};this.remember(ref,data);return data;
 }
 // Only evict memory copies backed by validated task storage; disk references stay immutable.
 remember(ref,data){
  const size=Buffer.byteLength(JSON.stringify(data));
  if(this.datasets.has(ref)){this.bytes-=Buffer.byteLength(JSON.stringify(this.datasets.get(ref)));this.datasets.delete(ref);}
  if(this.storage){while(this.bytes+size>this.cacheBytes&&this.datasets.size){const oldest=this.datasets.keys().next().value;this.bytes-=Buffer.byteLength(JSON.stringify(this.datasets.get(oldest)));this.datasets.delete(oldest);}if(size>this.cacheBytes)return;}
  else if(this.bytes+size>this.cacheBytes)throw new ReportInputError('无持久存储时数据超过内存预算；请配置任务输出目录后接续');
  this.datasets.set(ref,data);this.bytes+=size;
 }
 async compare(args){
  await this.check();const left=await this.restore(args.leftRef),right=await this.restore(args.rightRef);
  if(!left?.complete||!right?.complete||!left.columns.includes(args.leftKey)||!right.columns.includes(args.rightKey))throw new ReportInputError('差集核对需要两个本任务完整数据集及各自实际主键列');
  const index=(data,key)=>{const map=new Map();for(const row of data.rows){const value=row[key];if(value===null||value===''||map.has(value))throw new ReportInputError('差集核对主键必须非空且唯一');map.set(value,row);}return map;};
  const l=index(left,args.leftKey),r=index(right,args.rightKey),onlyLeft=[...l].filter(([key])=>!r.has(key)).map(([,row])=>row),onlyRight=[...r].filter(([key])=>!l.has(key)).map(([,row])=>row);
  const dataHash=createHash('sha256').update(JSON.stringify({left:[...l.keys()].sort(),right:[...r.keys()].sort(),onlyLeft,onlyRight})).digest('hex');
  await this.check();
  return {leftCount:l.size,rightCount:r.size,matchedCount:l.size-onlyLeft.length,onlyLeftCount:onlyLeft.length,onlyRightCount:onlyRight.length,onlyLeft:preview(onlyLeft,this.previewRows),onlyRight:preview(onlyRight,this.previewRows),dataHash,previewLimited:onlyLeft.length>this.previewRows||onlyRight.length>this.previewRows,note:'差异按真实主键比较；两份数据的业务范围和取数时间仍需核对，不能仅凭行数推断缺少谁。'};
 }
 async period(args){
  await this.check();const data=await buildPeriodDataset(args,ref=>this.restore(ref),{check:()=>this.check(),maxRows:this.maxRows}),ref='dataset-'+randomUUID();
  if(this.storage)await this.storage.save(ref,data,data.snapshotId,data.readAt);await this.check();this.remember(ref,data);
  return {datasetRef:ref,dataHash:hash(data),complete:true,rowCount:data.rows.length,columns:data.columns,numericColumns:data.numericColumns,readAt:data.readAt,snapshotId:data.snapshotId,audit:data.derivation.audit,preview:preview(data.rows,this.previewRows),stage:'完整对象期间表已生成并精确累计；需独立基准核对及原问题审阅后交付'};
 }
 transformOptions(){let ticks=0;return {maxRows:this.maxRows,check:async()=>{if(!this.active())throw new ReportInputError('报表查询已结束');if(++ticks%500===0)await this.check();}};}
 async transform(tool,args){await this.check();let data;try{data=await transformDataset(tool,args,ref=>this.restore(ref),this.transformOptions());}catch(e){if(e.code==='REPORT_INPUT')throw new ReportInputError(e.message);throw e;}await this.check();const ref='dataset-'+randomUUID();if(this.storage)await this.storage.save(ref,data,data.snapshotId,data.readAt);this.remember(ref,data);return {datasetRef:ref,dataHash:hash(data),complete:true,rowCount:data.rows.length,columns:data.columns,readAt:data.readAt,readThroughAt:data.readThroughAt,snapshotId:data.snapshotId,audit:data.derivation.audit,preview:preview(data.rows,this.previewRows),stage:'完整数据转换完成，保留来源时间和派生依据；尚须核验文件及原要求'};}
 async verifyDerived(data,stack=new Set(),verified=new Set(),ref=null){
  if(ref&&verified.has(ref))return;
  if(data.derivation?.kind==='relational_transform'){const mark=hash(data.derivation);if(stack.has(mark))throw new ReportInputError('派生来源循环');stack.add(mark);for(const ref of data.derivation.inputs)await this.verifyDerived(await this.restore(ref),stack,verified,ref);await verifyRelationalDataset(data,ref=>this.restore(ref),this.transformOptions());stack.delete(mark);}
  await verifyPeriodDataset(data,ref=>this.restore(ref),{check:()=>this.check(),maxRows:this.maxRows});
  if(ref)verified.add(ref);
 }
 async rawEvidence(data,column,context={verified:new Set(),evidence:new Map()},ref=null){
  const cacheKey=ref&&JSON.stringify([ref,column]);if(cacheKey&&context.evidence.has(cacheKey))return context.evidence.get(cacheKey);
  await this.verifyDerived(data,new Set(),context.verified,ref);
  let result=null;
  if(data.derivation?.kind==='period_grid'){
   const p=data.derivation.provenance[column]??{datasetRef:data.derivation.args.populationRef,column};
   result=await this.rawEvidence(await this.restore(p.datasetRef),p.column,context,p.datasetRef);
  }else if(data.derivation?.kind==='relational_transform'){
   const hashes=[];for(const input of data.derivation.inputs){const value=await this.rawEvidence(await this.restore(input),column,context,input);if(value)hashes.push(value);}result=hashes.length?hash(hashes):null;
  }else if(data.derivation?.kind==='left_lookup'){
   let found=false;for(const lookup of data.derivation.lookups){const field=lookup.fields.find(f=>f.as===column);if(field){result=await this.rawEvidence(await this.restore(lookup.datasetRef),field.column,context,lookup.datasetRef);found=true;break;}}
   if(!found)result=await this.rawEvidence(await this.restore(data.derivation.datasetRef),column,context,data.derivation.datasetRef);
  }else result=data.queryHash&&data.queryDefinition?data.queryHash:null;
  if(cacheKey)context.evidence.set(cacheKey,result);return result;
 }
 async compose(args){
  await this.check();if(!this.directory)throw new ReportInputError('本次执行未配置报表输出目录');
  if(!Array.isArray(args.sources)||!args.sources.length||!Array.isArray(args.columns)||!args.columns.length)throw new ReportInputError('报表需要非空来源和列定义');
  const sources=new Map();let keys=new Set();
  for(const s of args.sources){
   if(!s||!/^s[0-9]+$/.test(s.name)||sources.has(s.name))throw new ReportInputError('来源name必须为不重复的s1、s2等');
   const data=await this.restore(s.datasetRef);if(!data?.complete||!data.columns.includes(s.keyColumn))throw new ReportInputError('来源必须为本任务完整数据集，并指定实际业务主键列');
   const map=new Map();for(const row of data.rows){const key=row[s.keyColumn];if(key===null||key===''||map.has(key))throw new ReportInputError('来源主键为空或重复，不能直接拼接金额；请先按同一业务对象粒度汇总');map.set(key,row);keys.add(key);}
   await this.verifyDerived(data);sources.set(s.name,{...data,map});
  }
  if(args.population){const population=await this.restore(args.population.datasetRef);if(!population?.complete||!population.columns.includes(args.population.keyColumn))throw new ReportInputError('population需要完整范围数据集及主键');keys=uniqueKeys(population,args.population.keyColumn);}
  if(keys.size>this.maxRows)throw new ReportInputError('合并后超过报表行数上限；未生成文件');
  const headers=args.columns.map(c=>c?.label);if(headers.some(x=>typeof x!=='string'||!x.trim()||x.length>80)||new Set(headers).size!==headers.length)throw new ReportInputError('列标题应唯一且不超过80字符');
  const validate=(e,depth=0)=>{if(!e||typeof e!=='object')throw new ReportInputError('报表列计算过于复杂');
   if(e.op==='key')return;
   if(e.op==='field'){const s=sources.get(e.source);if(!s?.columns.includes(e.column)||e.missing!==undefined&&!['zero','empty'].includes(e.missing))throw new ReportInputError('报表字段引用无效');return;}
   if(e.missing!==undefined&&e.missing!=='empty')throw new ReportInputError('算术缺失规则仅支持显式missing=empty传播未知值');
   if(!['add','subtract','min'].includes(e.op)||!Array.isArray(e.args)||e.args.length<2||e.args.length>6)throw new ReportInputError('仅支持key、field、add、subtract、min固定计算，不接受表达式');e.args.forEach(x=>validate(x,depth+1));};
  args.columns.forEach(c=>validate(c.value));
  const evaluate=(e,key)=>{
   if(e.op==='key')return key;
   if(e.op==='field'){const row=sources.get(e.source).map.get(key);const v=row?.[e.column];if(v===undefined||v===null){if(e.missing==='zero')return '0';if(e.missing==='empty')return '';throw new ReportInputError('报表有缺失值；必须明确缺失值的业务处理规则');}return v;}
   const raw=e.args.map(x=>evaluate(x,key));if(e.missing==='empty'&&raw.some(v=>v===null||v===''))return '';const values=raw.map(decimal);let v=values[0];for(const n of values.slice(1))v=e.op==='add'?v+n:e.op==='subtract'?v-n:v<n?v:n;return format(v);
  };
  const rows=[...keys].sort().map(key=>args.columns.map(c=>evaluate(c.value,key)));
  const csv='\uFEFF'+[headers,...rows].map(row=>row.map(csvCell).join(',')).join('\r\n')+'\r\n';const bytes=Buffer.byteLength(csv);
  const totals=Object.fromEntries(args.columns.flatMap((c,i)=>['add','subtract','min'].includes(c.value.op)||c.total===true?[[c.label,c.value.missing==='empty'&&!rows.some(row=>row[i]!=='')?null:format(rows.reduce((n,row)=>n+(c.value.missing==='empty'&&row[i]===''?0n:decimal(row[i])),0n))]]:[]));
  const datasetRef=`dataset-${randomUUID()}`,composed={rows:rows.map(row=>Object.fromEntries(headers.map((h,i)=>[h,row[i]]))),columns:headers,complete:true,numericColumns:args.columns.filter(c=>c.total===true||['add','subtract','min'].includes(c.value.op)||(c.value.op==='field'&&sources.get(c.value.source).numericColumns?.includes(c.value.column))).map(c=>c.label)};
  const snapshotIds=[...new Set([...sources.values()].map(d=>d.snapshotId))].sort(),snapshotId=snapshotIds.length===1?snapshotIds[0]:createHash('sha256').update(JSON.stringify(snapshotIds)).digest('hex');
  const readAt=[...sources.values()].map(d=>d.readAt).filter(Boolean).sort()[0]??new Date().toISOString();
  const dataHash=createHash('sha256').update(JSON.stringify(composed)).digest('hex');
  const id=`report-${randomUUID()}`,filename=id+'.csv';await this.check();await mkdir(this.directory,{recursive:true,mode:0o700});
  const temp=path.join(this.directory,filename+'.tmp'),file=path.join(this.directory,filename);
  try{await writeFile(temp,csv,{mode:0o600,flag:'wx'});await this.check();await rename(temp,file);await this.check();}
  catch(error){await rm(temp,{force:true});await rm(file,{force:true});throw error;}
  this.files++;
  composed.readThroughAt=[...sources.values()].map(d=>d.readThroughAt??d.readAt).sort().at(-1);
  composed.reportDraft={...(args.population?{population:args.population}:{}),keys:[...keys].sort(),file:{id,filename,bytes,sha256:createHash('sha256').update(csv).digest('hex'),rowCount:rows.length,complete:true},sources:args.sources,columns:args.columns,sourceSnapshots:[...sources].map(([name,data])=>({name,readAt:data.readAt,snapshotId:data.snapshotId}))};
  if(this.storage){await this.check();await this.storage.save(datasetRef,composed,snapshotId,readAt);await this.check();}

  // Persisted derived datasets can be resumed without repeating SQL or resetting their evidence age.
  this.remember(datasetRef,{...composed,snapshotId,readAt});
  return {datasetRef,dataHash,readAt,snapshotId,sourceSnapshots:[...sources].map(([name,data])=>({name,readAt:data.readAt,snapshotId:data.snapshotId})),snapshotConsistency:new Set([...sources.values()].map(d=>d.snapshotId)).size>1?'multiple_read_times':'single_transaction',complete:true,truncated:false,rowCount:rows.length,columns:headers,totals,columnAudit:headers.map((label,i)=>({label,populatedRows:rows.filter(r=>r[i]!==null&&r[i]!==''&&r[i]!==undefined).length,totalRows:rows.length})),warnings:headers.filter((_,i)=>rows.length&&rows.every(r=>r[i]===''||r[i]===null)).map(label=>'整列为空：'+label+'；请核实实际来源与关联键，不把文件生成当业务核实'),preview:preview(rows,this.previewRows),draftFile:composed.reportDraft.file,stage:'CSV草稿已生成，尚不可交付；先用finalize_report核验原要求、完整对象范围及各计算分量合计'};
 }
 async enrich(args){
  await this.check();const base=await this.restore(args.datasetRef);
  if(!base?.complete||!base.columns.includes(args.keyColumn)||!Array.isArray(args.lookups)||!args.lookups.length||args.lookups.length>4)throw new ReportInputError('enrich_dataset需要完整主数据集、实际主键和1至4个lookups');
  uniqueKeys(base,args.keyColumn);
  const rows=base.rows.map(row=>({...row})),columns=[...base.columns],lookupChecks=[],inputs=[base],numericColumns=[...(base.numericColumns??[])];
  for(const lookup of args.lookups){
   await this.check();if(!lookup||typeof lookup!=='object'||Array.isArray(lookup))throw new ReportInputError('lookup必须为对象');const right=await this.restore(lookup.datasetRef);
   if(!/^[a-z][a-z0-9_]{0,19}$/.test(lookup.name??'')||!right?.complete||!columns.includes(lookup.sourceColumn)||!right.columns.includes(lookup.targetColumn)||!['empty','error'].includes(lookup.missing)||!Array.isArray(lookup.fields)||!lookup.fields.length||lookup.fields.length>4||lookup.fields.some(f=>!f||typeof f!=='object'||Array.isArray(f)))throw new ReportInputError('lookup需要唯一名称、实际关联列、1至4个字段以及明确missing=empty或error');
   const outputs=lookup.fields.map(f=>f.as),status=lookup.name+'_status';
   if(lookup.fields.some(f=>!right.columns.includes(f.column)||typeof f.as!=='string'||!f.as.trim()||f.as.length>80||['__proto__','constructor','prototype'].includes(f.as))||outputs.includes(status)||columns.includes(status)||new Set(outputs).size!==outputs.length||outputs.some(c=>columns.includes(c)))throw new ReportInputError('lookup字段无效、重复或试图覆盖已有列');
   if(columns.length+outputs.length+1>32)throw new ReportInputError('组合数据集最多32列');
   const index=new Map();for(const row of right.rows){const key=row[lookup.targetColumn];if(key===null||key==='')continue;if(index.has(key))throw new ReportInputError('lookup关联键重复，不能猜测选哪条记录或重复累计；enrich_dataset只查唯一维度。一对多明细须用linked_group_dataset按明细粒度分组，保留无明细主对象用join.type=left；核实关联键及右表筛选，不可去重丢记录');index.set(key,row);}
   if(lookup.fallbackKey!==undefined&&(typeof lookup.fallbackKey!=='string'||!lookup.fallbackKey||lookup.fallbackKey.length>2000||!index.has(lookup.fallbackKey)))throw new ReportInputError('fallbackKey必须指向本次完整维度数据中实际存在且唯一的默认配置，不能猜测或填常量');
   let matchedCount=0,fallbackCount=0;const unmatched=[];
   for(const row of rows){const specific=index.get(row[lookup.sourceColumn]),fallback=!specific&&lookup.fallbackKey!==undefined?index.get(lookup.fallbackKey):null,found=specific??fallback;if(specific)matchedCount++;else if(fallback)fallbackCount++;else unmatched.push(row[args.keyColumn]);for(const f of lookup.fields){const value=found?.[f.column]??'';row[f.as]=value;}row[status]=specific?'已匹配':fallback?'沿用默认配置':'未匹配';}
   if(unmatched.length&&lookup.missing==='error')throw new ReportInputError(`lookup ${lookup.name}有${unmatched.length}个对象未匹配；核对关联键或明确允许保留空值`);
   columns.push(...outputs,status);numericColumns.push(...lookup.fields.filter(f=>right.numericColumns?.includes(f.column)).map(f=>f.as));lookupChecks.push({name:lookup.name,leftColumn:lookup.sourceColumn,rightColumn:lookup.targetColumn,leftEmptyKeys:rows.filter(r=>r[lookup.sourceColumn]===null||r[lookup.sourceColumn]==='').length,leftJsonContainerKeys:rows.filter(r=>typeof r[lookup.sourceColumn]==='string'&&/^[\[{]/.test(r[lookup.sourceColumn].trim())).length,...(matchedCount===0&&rows.length&&right.rows.length?{warning:'整个关联零匹配；核对源码实际左右字段、空值及JSON形态，不能仅按字段名猜关联后就宣称业务全部缺失'}:{}),matchedCount,...(lookup.fallbackKey!==undefined?{fallbackCount,fallbackKey:lookup.fallbackKey}:{}),unmatchedCount:unmatched.length,unmatchedKeys:unmatched.slice(0,this.previewRows),previewLimited:unmatched.length>this.previewRows});inputs.push(right);
  }
  const data={rows,columns,numericColumns,complete:true,readThroughAt:inputs.map(d=>d.readThroughAt??d.readAt).sort().at(-1),derivation:{kind:'left_lookup',datasetRef:args.datasetRef,keyColumn:args.keyColumn,lookups:args.lookups,lookupChecks}};
  const readAt=inputs.map(d=>d.readAt).sort()[0],snapshotIds=[...new Set(inputs.map(d=>d.snapshotId))].sort(),snapshotId=snapshotIds.length===1?snapshotIds[0]:hash(snapshotIds),ref='dataset-'+randomUUID();
  await this.check();if(this.storage)await this.storage.save(ref,data,snapshotId,readAt);await this.check();this.remember(ref,{...data,readAt,snapshotId});
  return {datasetRef:ref,dataHash:hash({rows,columns,numericColumns}),readAt,snapshotId,complete:true,rowCount:rows.length,columns,lookupChecks,warnings:lookupChecks.flatMap(x=>x.warning?[x.warning]:[]),preview:preview(rows,this.previewRows),stage:'主对象完整保留，维度字段已组合；未匹配和多时点不代表业务数据已验收'};
 }
 async refresh(args,{begin,reload}){
  await this.check();if(!Array.isArray(args.checks)||typeof args.populationRef!=='string')throw new ReportInputError('refresh_report需要与finalize_report相同的范围、列定义及独立基准参数');
  const root=await this.restore(args.datasetRef);if(!root?.reportDraft)throw new ReportInputError('refresh_report需要已有草稿引用');
  const graph=new Map(),visiting=new Set();
  const visit=async(ref,depth=0)=>{
   if(graph.has(ref))return;if(visiting.has(ref))throw new ReportInputError('报表来源图存在循环，不能安全集中刷新');
   visiting.add(ref);const d=await this.restore(ref);if(!d?.complete)throw new ReportInputError('刷新来源不完整');
   if(d.reportDraft){for(const source of d.reportDraft.sources)await visit(source.datasetRef,depth+1);if(d.reportDraft.population)await visit(d.reportDraft.population.datasetRef,depth+1);}
   else if(d.derivation?.kind==='relational_transform'){for(const ref of d.derivation.inputs)await visit(ref,depth+1);}
   else if(d.derivation?.kind==='period_grid'){await visit(d.derivation.args.populationRef,depth+1);for(const source of d.derivation.args.sources)await visit(source.datasetRef,depth+1);}
   else if(d.derivation?.kind==='left_lookup'){await visit(d.derivation.datasetRef,depth+1);for(const lookup of d.derivation.lookups)await visit(lookup.datasetRef,depth+1);}
   else{
    const recipe=d.recipe;
    const temporary=value=>value&&typeof value==='object'&&(value.op==='in_set'||Object.values(value).some(temporary));
    if(!recipe||recipe.replayable===false||!['row_dataset','group_dataset','linked_group_dataset'].includes(recipe.tool)||!recipe.args||temporary(recipe.args))throw new ReportInputError('来源缺少可重放的固定工具recipe，或依赖临时in_set集合；先在当前授权下补齐来源，不执行保存的SQL');
   }
   visiting.delete(ref);graph.set(ref,d);
  };
  await visit(args.populationRef);for(const c of args.checks){if(!c||typeof c.referenceRef!=='string')throw new ReportInputError('checks缺少referenceRef');await visit(c.referenceRef);}await visit(args.datasetRef);
  // Finish the entire dependency check before touching the live connection.
  await this.check();await begin();await this.check();this.snapshotId=randomUUID();this.collected.clear();
  const mapped=new Map();let rawCount=0;
  for(const [ref,d] of graph){await this.check();let output;
   if(d.reportDraft){output=await this.compose({sources:d.reportDraft.sources.map(x=>({...x,datasetRef:mapped.get(x.datasetRef)})),columns:d.reportDraft.columns,...(ref===args.datasetRef?{population:{datasetRef:mapped.get(args.populationRef),keyColumn:args.populationKey}}:d.reportDraft.population?{population:{...d.reportDraft.population,datasetRef:mapped.get(d.reportDraft.population.datasetRef)}}:{})});}
   else if(d.derivation?.kind==='relational_transform')output=await this.transform(d.derivation.tool,remapTransform(d.derivation.tool,d.derivation.args,ref=>mapped.get(ref)));
   else if(d.derivation?.kind==='period_grid')output=await this.period({...d.derivation.args,populationRef:mapped.get(d.derivation.args.populationRef),sources:d.derivation.args.sources.map(x=>({...x,datasetRef:mapped.get(x.datasetRef)}))});
   else if(d.derivation?.kind==='left_lookup')output=await this.enrich({...d.derivation,datasetRef:mapped.get(d.derivation.datasetRef),lookups:d.derivation.lookups.map(x=>({...x,datasetRef:mapped.get(x.datasetRef)}))});
   else {output=await reload(d.recipe);rawCount++;if(!output?.complete)throw new ReportInputError('集中刷新返回不完整来源，不能定稿');}
   mapped.set(ref,output.datasetRef);
  }
  const refreshedDatasetRef=mapped.get(args.datasetRef);
  const final=await this.finalize({...args,datasetRef:refreshedDatasetRef,populationRef:mapped.get(args.populationRef),checks:args.checks.map(c=>({...c,referenceRef:mapped.get(c.referenceRef)}))});
  return {...final,refreshedDatasetRef,refresh:{sourceCount:rawCount,mode:'new_readonly_transaction',previousDatasetRef:args.datasetRef},stage:'在新只读事务内集中刷新、重算并通过程序核验；仍需按原问题审阅'};
 }
 async finalize(args){
  await this.check();const verification={verified:new Set(),evidence:new Map()};const data=await this.restore(args.datasetRef),draft=data?.reportDraft;
  if(!draft)throw new ReportInputError('finalize_report需要本任务compose_report产生的草稿引用');
  const text=(v)=>typeof v==='string'&&v.trim().length>=3&&v.length<=1200;
  if(!text(args.requirement)||!text(args.scopeEvidence)||!Array.isArray(args.expectedColumns)||JSON.stringify(args.expectedColumns)!==JSON.stringify(data.columns))throw new ReportInputError('须按原问题登记requirement、scopeEvidence及完全一致的expectedColumns，缺列、额外列或顺序不同应重做草稿');
  if(!Array.isArray(args.columnRules)||args.columnRules.length!==data.columns.length||args.columnRules.some((c,i)=>c?.label!==data.columns[i]||!text(c.definition)||!text(c.evidence)))throw new ReportInputError('每一列都要登记业务定义/公式与源码或文档依据，不得用项目名称包含某词替代已核实业务条件');
  const population=await this.restore(args.populationRef);
  await this.verifyDerived(population??{},new Set(),verification.verified,args.populationRef);
  const periodPopulation=population?.derivation?.kind==='period_grid'&&population.derivation.args.sources.length===0;
  const populationBase=periodPopulation?await this.restore(population.derivation.args.populationRef):population;
  const transformedPopulation=population?.derivation?.kind==='relational_transform'&&Boolean(await this.rawEvidence(population,args.populationKey,verification,args.populationRef));
  if(!population?.complete||population.reportDraft||!transformedPopulation&&(!populationBase?.queryHash||!populationBase.queryDefinition)||!population.columns.includes(args.populationKey))throw new ReportInputError('完整对象范围必须来自独立原始查询数据集，不能拿草稿自身当覆盖证明');
  const expected=uniqueKeys(population,args.populationKey);
  if(!Array.isArray(draft.keys)||draft.keys.length!==data.rows.length||new Set(draft.keys).size!==draft.keys.length||draft.keys.some(k=>typeof k!=='string'||!k))throw new ReportInputError('草稿缺少完整内部主键索引；重新生成草稿后核验');
  const actual=new Set(draft.keys),missing=[...expected].filter(k=>!actual.has(k)),extra=[...actual].filter(k=>!expected.has(k));
  if(missing.length||extra.length)throw new ReportInputError(`清单覆盖未通过：应有${expected.size}个对象，实际${actual.size}个；遗漏${missing.length}个、多出${extra.length}个。补齐后重做草稿，不能把单户抽样当完整清单。`);
  const sources=new Map();for(const s of draft.sources){const source=await this.restore(s.datasetRef);if(source)await this.verifyDerived(source,new Set(),verification.verified,s.datasetRef);if(!source?.complete)throw new ReportInputError('来源已失效，需要重新取数');sources.set(s.name,source);}
  const required=new Set();
  const leaves=(e,numeric)=>{if(e.op==='field'&&numeric)required.add(e.source+':'+e.column);for(const child of e.args??[])leaves(child,true);};
  for(const c of draft.columns)leaves(c.value,data.numericColumns?.includes(c.label)||c.total===true);
  if(!Array.isArray(args.checks))throw new ReportInputError('checks必须为分量合计核验数组');
  const totals=[],proofs=[];const times=[population,data,...sources.values()];
  for(const c of args.checks){
   if(!c||typeof c!=='object'||typeof c.source!=='string'||typeof c.column!=='string'||typeof c.referenceRef!=='string'||typeof c.referenceColumn!=='string')throw new ReportInputError('checks每项必须明确source、column、referenceRef和referenceColumn');
   const source=sources.get(c.source),ref=await this.restore(c.referenceRef),name=c.source+':'+c.column;
   const referenceEvidence=ref&&await this.rawEvidence(ref,c.referenceColumn,verification,c.referenceRef),sourceEvidence=source&&await this.rawEvidence(source,c.column,verification,draft.sources.find(s=>s.name===c.source)?.datasetRef);
   if(!required.has(name)||!source?.columns.includes(c.column)||!ref?.complete||ref.reportDraft||!referenceEvidence||referenceEvidence===sourceEvidence||!ref.columns.includes(c.referenceColumn)||!text(c.evidence))throw new ReportInputError('分量合计需引用不同原始查询的完整基准集和实际数值列，不能用同一查询或草稿自证；须说明基准口径依据');
   if(totals.some(x=>x.name===name))throw new ReportInputError('同一分量不能重复核验');
   const sourceKey=draft.sources.find(s=>s.name===c.source).keyColumn;
   if(source.derivation?.kind==='period_grid'){
    if(ref.derivation?.kind!=='period_grid')throw new ReportInputError('期间金额需独立查询后按相同对象期间规则展开的基准，不能用全年总数代替累计行核验');
    const refKey=ref.derivation.args.rowKey??'period_key',index=new Map(ref.rows.map(row=>[row[refKey],row]));
    for(const row of source.rows)if(expected.has(row[sourceKey])){const other=index.get(row[sourceKey]);if(!other||row[c.column]!==other[c.referenceColumn])throw new ReportInputError('期间分量逐行核对不一致，检查对象、期间、空值、累计和独立来源口径');}
    if(index.size!==expected.size||[...expected].some(k=>!index.has(k)))throw new ReportInputError('期间独立基准覆盖不完整');
   }

   const uses=[];const findUses=e=>{if(e.op==='field'&&e.source===c.source&&e.column===c.column)uses.push(e);for(const child of e.args??[])findUses(child);};draft.columns.forEach(col=>findUses(col.value));
   const missingPolicy=uses.length&&uses.every(e=>e.missing==='zero')?'zero':uses.length&&uses.every(e=>e.missing==='empty')?'empty':'error';
   const sum=(d,col,filter=()=>true,policy='error')=>{
    let value=0n,known=0,missing=0;
    for(const [i,row] of d.rows.entries())if(filter(row)){
     if(row[col]===null){missing++;if(policy==='error')throw new ReportInputError(`分量${col}第${i+1}行为空；须明确保留空值或有业务依据补零，不能当作金额格式错误反复重查`);continue;}
     try{value+=decimal(row[col]);known++;}catch{throw new ReportInputError(`分量${col}第${i+1}行不是受支持的精确金额；核对类型/精度，不输出原值，不通过改精度或补零绕过`);}
    }
    return {value,known,missing};
   };
   const actual=sum(source,c.column,row=>expected.has(row[sourceKey]),missingPolicy),reference=sum(ref,c.referenceColumn,()=>true,missingPolicy==='empty'?'empty':'error');
   if(Boolean(actual.known)!==Boolean(reference.known))throw new ReportInputError('分量与独立基准的已知金额范围不一致；全为空不能当作已知零合计');
   if(actual.value!==reference.value)throw new ReportInputError(`分量合计不一致：${name}为${format(actual.value)}，独立基准为${format(reference.value)}；不能交付，先核对期间、状态、费用范围及关联重复。`);
   times.push(ref);totals.push({name,total:missingPolicy==='empty'&&!actual.known?null:format(actual.value),referenceRef:c.referenceRef,referenceColumn:c.referenceColumn,evidence:c.evidence,...(actual.missing||reference.missing?{knownCount:actual.known,missingCount:actual.missing,referenceMissingCount:reference.missing,missingPolicy,note:missingPolicy==='empty'?'仅核对已知金额合计，空值保留为空，不代表零或完整金额已知':'缺失按明确补零规则处理'}:{})});proofs.push({datasetRef:c.referenceRef,dataHash:hash(ref),queryHash:ref.queryHash});
  }
  if([...required].some(k=>!totals.some(c=>c.name===k)))throw new ReportInputError('计算或标记total的每个来源分量都必须通过独立合计核验；缺少基准：'+[...required].filter(k=>!totals.some(c=>c.name===k)).join('、')+'；补充这些分量的checks，不重复已核验取数');
  const timestamps=times.flatMap(d=>[Date.parse(d.readAt),Date.parse(d.readThroughAt??d.readAt)]);
  if(timestamps.some(t=>!Number.isFinite(t))||Math.max(...timestamps)-Math.min(...timestamps)>this.snapshotWindowMs)throw new ReportInputError(`取数时点相差超过${this.snapshotWindowMs/60000}分钟（管理员配置窗口）；复用不变规则，集中刷新受影响来源与独立基准后重做草稿，不逐轮盲目刷新。`);
  const info=await lstat(path.join(this.directory,draft.file.filename));
  if(!info.isFile()||info.isSymbolicLink()||info.size!==draft.file.bytes||createHash('sha256').update(await readFile(path.join(this.directory,draft.file.filename))).digest('hex')!==draft.file.sha256)throw new ReportInputError('草稿文件已变化，不能交付');
  const receipt={version:1,datasetRef:args.datasetRef,formulas:draft.columns,status:'verified',originalQuestion:this.originalQuestion,verifiedAt:new Date().toISOString(),file:draft.file,requirement:args.requirement,scopeEvidence:args.scopeEvidence,columnRules:args.columnRules,coverage:{populationRef:args.populationRef,populationKey:args.populationKey,rowCount:actual.size},totals,sources:[...sources].map(([name,d])=>({name,dataHash:hash(d),queryHash:d.queryHash,queryDefinition:queryPreview(d.queryDefinition),derivation:d.derivation,readAt:d.readAt,snapshotId:d.snapshotId})),proofs,readWindow:{earliest:new Date(Math.min(...timestamps)).toISOString(),latest:new Date(Math.max(...timestamps)).toISOString(),spreadMs:Math.max(...timestamps)-Math.min(...timestamps),maxSpreadMs:this.snapshotWindowMs},snapshotNote:'按管理员配置的取数窗口核验，不代表多轮属于同一事务；业务定义依据由Agent核实，程序不能理解并证明业务语义正确。'};
  const body=JSON.stringify(receipt);if(Buffer.byteLength(body)>64000)throw new ReportInputError('验收记录过大');
  const file=path.join(this.directory,draft.file.id+'.verification.json'),temp=file+'.tmp';
  try{await lstat(file);throw new ReportInputError('该草稿已定稿；修改口径请重新compose_report，保留旧核验记录');}catch(error){if(error.code!=='ENOENT')throw error;}
  try{await this.check();await writeFile(temp,body,{flag:'wx',mode:0o600});await this.check();await rename(temp,file);await this.check();}catch(error){await rm(temp,{force:true});throw error;}
  return {exportFile:{...draft.file,verificationHash:createHash('sha256').update(body).digest('hex')},coverage:receipt.coverage,totals,readWindow:receipt.readWindow,snapshotNote:receipt.snapshotNote,stage:'列、对象覆盖和计算分量合计核验通过；业务语义仍以所列依据为准，可在最终任务通过后回复文件'};
 }
 clear(){this.collected.clear();this.datasets.clear();this.bytes=0;}
}
const scale=10n**12n;
function decimal(value){const s=String(value);if(!/^-?\d{1,40}(?:\.\d{1,12})?$/.test(s))throw new ReportInputError('金额必须为最多12位小数的精确十进制值');const negative=s[0]==='-',parts=s.replace(/^-/,'').split('.');return (negative?-1n:1n)*(BigInt(parts[0])*scale+BigInt((parts[1]??'').padEnd(12,'0')));}
function format(n){const sign=n<0n?'-':'';if(n<0n)n=-n;const frac=String(n%scale).padStart(12,'0').replace(/0+$/,'');return sign+String(n/scale)+(frac?'.'+frac:'');}
function csvCell(v){let s=String(v??'');if(/^[\s\uFEFF]*[=+@-]/.test(s)&&!/^-[0-9]+(?:\.[0-9]+)?$/.test(s))s="'"+s;return '"'+s.replaceAll('"','""')+'"';}

function preview(rows,limit){const out=[];let bytes=0;for(const row of rows.slice(0,limit)){bytes+=Buffer.byteLength(JSON.stringify(row));if(bytes>8000)break;out.push(row);}return out;}

const hash=value=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
function uniqueKeys(data,column){const keys=new Set();for(const row of data.rows){const key=row[column];if(typeof key!=='string'||!key||keys.has(key))throw new ReportInputError('覆盖核验主键必须为非空唯一字符串；同一对象多月份/分类不是唯一维度，不要丢弃重复行；一对多请用linked_group_dataset按实际明细粒度分组，保留无明细主对象用join.type=left');keys.add(key);}return keys;}
function queryPreview(definition){return definition?{sql:definition.sql.slice(0,200),params:definition.params.slice(0,3).map(v=>v.slice(0,80)),limited:definition.sql.length>200||definition.params.length>3||definition.params.some(v=>v.length>80)}:undefined;}

function requiredChecks(data){const required=new Map();const walk=(e,numeric)=>{if(e.op==='field'&&numeric)required.set(e.source+':'+e.column,{source:e.source,column:e.column});for(const c of e.args??[])walk(c,true);};for(const c of data.reportDraft.columns)walk(c.value,data.numericColumns?.includes(c.label)||c.total===true);return [...required.values()];}
