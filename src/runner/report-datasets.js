import {buildWindowDataset} from '../shared/window-dataset.js';
import {summarizeDataset,percentage,divide} from '../shared/dataset-summary.js';
import {transformDataset} from '../shared/dataset-transform.js';
import {deploymentEvidence} from '../shared/deployment-evidence.js';
import {queryEvidenceIdentity} from '../shared/query-evidence.js';
import {buildPeriodDataset,verifyPeriodDataset} from '../shared/period-dataset.js';
import {datasetDependencies,TaskDatasetStore} from './task-dataset-store.js';
import {randomUUID,createHash} from 'node:crypto';
import {mkdir,writeFile,rename,rm,readFile,lstat} from 'node:fs/promises';
import path from 'node:path';
import {reportColumns,validateReportHeaders} from '../shared/report-headers.js';

export class ReportInputError extends Error {constructor(message){super(message);this.code='REPORT_INPUT';}}

// Task-scoped evidence can resume under renewed authorization; never shared as knowledge.
export class ReportDatasets {
 constructor({maxRows,previewRows=20,directory,authorize=async()=>{},active=()=>true,secrets=[],scope,datasetScopes=[],originalQuestion='',cacheBytes=16_000_000,snapshotWindowMs=null,dataBudgetBytes=Number.MAX_SAFE_INTEGER,reuseQueries=false,deploymentScope={},onProgress=async()=>{}}){
  this.onProgress=onProgress;this.scope=scope;this.sourceScopes=new Map();this.datasetScopes=[...new Set([scope,...datasetScopes].filter(Boolean))];this.deploymentScope=deploymentScope;this.reuseQueries=reuseQueries;this.cacheBytes=cacheBytes;this.snapshotWindowMs=snapshotWindowMs;this.originalQuestion=originalQuestion;this.snapshotId=randomUUID();this.storage=directory&&scope?new TaskDatasetStore(directory,scope,{maxBytes:dataBudgetBytes,additionalScopes:datasetScopes}):null;
  this.secrets=secrets.filter(Boolean);this.maxRows=maxRows==='all'?Number.MAX_SAFE_INTEGER:maxRows;this.previewRows=Math.min(previewRows,20);this.directory=directory;this.authorize=authorize;this.active=active;this.collected=new Map();this.datasets=new Map();this.bytes=0;this.files=0;
 }
 async check(){if(!this.active())throw new ReportInputError('报表查询已结束');await this.authorize();if(!this.active())throw new ReportInputError('报表查询已结束');}
 async collect(statement,execute){
  await this.check();
  const queryHash=createHash('sha256').update(JSON.stringify([statement.sql,statement.params])).digest('hex');
  const signature=hash([queryHash,statement.columns,statement.numericColumns??[],statement.rowKey??null]);
  const previous=this.reuseQueries?this.collected.get(signature):null;
  if(previous){const d=await this.restore(previous.datasetRef);if(d?.complete)return {...previous,reused:true,stage:'复用本轮同一只读事务中已完成的相同查询；保留原取数时间'};}
  const rows=[];let batch=Number.isInteger(statement.batchSize)&&statement.batchSize>=1&&statement.batchSize<=5000?statement.batchSize:500;let complete=false;
  let cursor=null,pages=0,lastProgress=0;const started=Date.now();
  const progress=async(phase)=>{if(phase==='reading'&&Date.now()-lastProgress<5000)return;lastProgress=Date.now();try{await this.onProgress({phase,rows:rows.length,pages,elapsedMs:Date.now()-started,pagination:statement.cursor?'keyset':'offset'});}catch{/* Progress delivery cannot invalidate a successful authorized database read. */}};
  await progress('starting');
  for(let offset=0;offset<=this.maxRows;){
   await this.check();const size=Math.min(batch,this.maxRows-offset+1);
   const keyset=statement.cursor,cursorParams=[];
   const after=keyset&&cursor?keyset.expressions.map((expression,i)=>'('+[...keyset.expressions.slice(0,i).map((previous,j)=>{cursorParams.push(cursor[j]);return previous+' = ?';}),(()=>{cursorParams.push(cursor[i]);return expression+' > ?';})()].join(' AND ')+')').join(' OR '):null;
   const marker=statement.sql.includes(' GROUP BY ')?' GROUP BY ':' ORDER BY ';
   const sql=after?statement.sql.replace(marker,` AND (${after})${marker}`):statement.sql;
   let page;try{[page]=await execute({sql:`${sql} LIMIT ${size}${keyset?'':` OFFSET ${offset}`}`},[...statement.params,...cursorParams]);}catch(error){if(error.code==='REMOTE_PAGE_TOO_LARGE'&&batch>1){batch=Math.max(1,Math.floor(batch/2));continue;}throw error;}
   await this.check();pages++;if(!Array.isArray(page)||page.length>size)throw new ReportInputError('报表分页返回异常');
   for(const row of page){
    if(rows.length===this.maxRows)break;
    const clean=Object.fromEntries(statement.columns.map(c=>{const v=row[c];if(v!==null&&!['string','number','bigint'].includes(typeof v))throw new ReportInputError(`报表含不支持的字段值：列${c}，类型${v instanceof Date?'Date':Array.isArray(v)?'array':typeof v}；日期应由驱动dateStrings保留原值，结构化字段须先核实类型，不可猜值或删列`);if(typeof v==='number'&&!Number.isSafeInteger(v))throw new ReportInputError('报表数值未以精确字符串返回，停止导出');return [c,v===null?null:this.secrets.reduce((text,secret)=>text.split(secret).join('[已隐藏]'),String(v))];}));
    if(statement.rowKey)clean[statement.rowKey.column]=hash(statement.rowKey.fields.map(c=>clean[c]));
    rows.push(clean);
   }
   await progress('reading');
   if(page.length<size){complete=true;break;}
   if(page.length>this.maxRows-offset)break;
   offset+=page.length;
   if(keyset&&page.length){const next=keyset.columns.map(k=>page.at(-1)[k]);if(next.some(v=>v===null||v===undefined)||JSON.stringify(next)===JSON.stringify(cursor))throw new ReportInputError('游标主键为空或没有前进；保留已有证据，不能跳行或改用抽样');cursor=next;}
   if(statement.batchSize&&page.length){const average=Buffer.byteLength(JSON.stringify(page))/page.length;batch=Math.max(1,Math.min(statement.cursor?5000:500,Math.floor(2000000/Math.max(1,average*1.5))));}
  }
  await progress('collected');
  // A short final page proves completion; exactly-at-cap requires one look-ahead.
  const ref=`dataset-${randomUUID()}`,data={rows,columns:[...statement.columns,...(statement.rowKey?[statement.rowKey.column]:[])],complete,numericColumns:statement.numericColumns??[],queryHash,queryDefinition:{sql:statement.sql,params:statement.params.map(v=>this.secrets.reduce((text,secret)=>text.split(secret).join('[已隐藏]'),String(v)))}};
  if(statement.recipe){const original=JSON.stringify(statement.recipe),safe=this.secrets.reduce((text,secret)=>text.split(secret).join('[已隐藏]'),original);data.recipe={...JSON.parse(safe),replayable:original===safe};}
  const dataHash=createHash('sha256').update(JSON.stringify(data)).digest('hex');
  let readAt=new Date().toISOString();if(complete&&this.storage){await this.check();const saved=await this.storage.save(ref,data,this.snapshotId);readAt=saved.readAt;await this.check();}
  this.remember(ref,{...data,snapshotId:this.snapshotId,readAt});
  const result={datasetRef:ref,queryHash,dataHash,snapshotId:this.snapshotId,readAt,queryDefinition:queryPreview(data.queryDefinition),rowCount:rows.length,complete,truncated:!complete,partial:!complete,columns:data.columns,preview:preview(rows,this.previewRows),stage:complete?'分组数据已完整读取':'达到报表行数上限；数据不完整，不能合成完整报表'};
  if(complete&&this.reuseQueries)this.collected.set(signature,result);return result;
 }
 async list({offset=0,limit=20,kind,columns=[]}={}){
  await this.check();
  if(!Number.isInteger(offset)||offset<0||!Number.isInteger(limit)||limit<1||limit>20||kind!==undefined&&!['query','derived','report_draft'].includes(kind)||!Array.isArray(columns)||columns.some(c=>typeof c!=='string'))throw new ReportInputError('Invalid dataset catalog offset/limit/kind/columns');
  const all=(this.storage?await this.storage.list():[]).filter(d=>(kind===undefined||d.kind===kind)&&columns.every(c=>d.columns.includes(c)));
  await this.check();
  all.sort((a,b)=>Number(b.kind==='report_draft')-Number(a.kind==='report_draft')||(b.createdAt??b.readAt).localeCompare(a.createdAt??a.readAt)||a.datasetRef.localeCompare(b.datasetRef));
  const datasets=[];let bytes=0;
  for(const item of all.slice(offset,offset+limit)){const size=Buffer.byteLength(JSON.stringify(item));if(datasets.length&&bytes+size>16000)break;datasets.push(item);bytes+=size;}
  return {datasets,totalCount:all.length,nextOffset:offset+datasets.length<all.length?offset+datasets.length:null,note:'Task-scoped authorized complete datasets; drafts first, then creation time. createdAt is artifact creation, readAt is source acquisition, never a new live read. Filter kind/columns to locate saved evidence.'};
 }
 async inspect({datasetRef,offset=0,limit=20,columns,sections}={}){
  await this.check();const data=await this.restore(datasetRef);if(!data)throw new ReportInputError('Invalid dataset reference');
  columns??=data.columns;
  const allowedSections=['preview','queryDefinition','derivation','dependencies','reportDraft'];
  if(sections!==undefined&&(!Array.isArray(sections)||!sections.length||sections.some(s=>!allowedSections.includes(s))))throw new ReportInputError('sections须为preview/queryDefinition/derivation/dependencies/reportDraft的非空数组');
  if(!Number.isInteger(offset)||offset<0||offset>data.rows.length||!Number.isInteger(limit)||limit<1||limit>100||!Array.isArray(columns)||!columns.length||new Set(columns).size!==columns.length||columns.some(c=>!data.columns.includes(c)))throw new ReportInputError('Inspect needs actual columns and nonnegative offset, limit 1..100');
  const rows=[];let bytes=0;
  for(const row of data.rows.slice(offset,offset+limit)){const selected=Object.fromEntries(columns.map(c=>[c,row[c]])),size=Buffer.byteLength(JSON.stringify(selected));if(bytes+size>8000)break;rows.push(selected);bytes+=size;}
  const dependencies=[];
  for(const ref of datasetDependencies(data)){const d=await this.restore(ref);if(d)dependencies.push({datasetRef:ref,kind:d.reportDraft?'report_draft':d.derivation?.kind??'query',columns:d.columns,rowCount:d.rows.length,queryHash:d.queryHash,dependencies:datasetDependencies(d)});}
  const populationPlans=[];
  for(const source of data.reportDraft?.sources??[]){const d=await this.restore(source.datasetRef);if(d?.derivation?.kind==='period_grid'){const a=d.derivation.args;populationPlans.push({tool:'period_dataset',arguments:{populationRef:a.populationRef,keyColumns:a.keyColumns,period:a.period,rowKey:a.rowKey??'period_key',sources:[]},keyColumn:a.rowKey??'period_key'});}}
  const q=data.queryDefinition;
  await this.check();
  const result={datasetRef,columns:data.columns,rowCount:data.rows.length,historical:Date.now()-Date.parse(data.readAt)>86400000,preview:rows,previewOffset:offset,nextOffset:offset+rows.length<data.rows.length?offset+rows.length:null,previewBlocked:rows.length===0&&offset<data.rows.length,previewNote:'Saved evidence only, no database read; old readAt is historical, not current. If previewBlocked, select fewer columns or use read_dataset for a long cell. Preview is not a complete population.',readAt:data.readAt,snapshotId:data.snapshotId,queryHash:data.queryHash,sourceRead:data.sourceRead,queryDefinition:q?{sql:q.sql.slice(0,6000),params:q.params.slice(0,50),limited:q.sql.length>6000||q.params.length>50}:null,derivation:data.derivation,dependencies,reportDraft:data.reportDraft?{sources:data.reportDraft.sources,columns:data.reportDraft.columns,finalization:{expectedColumns:data.columns,requiredChecks:requiredChecks(data),populationPlans,snapshotWindowMs:this.snapshotWindowMs,note:'Each numeric check requires a different raw query. A period coverage population is a separate period_dataset with sources=[], not a metric grid. populationPlans only describe existing population/range; verify business scope and raw provenance before use.'}}:undefined};
  if(sections)for(const section of allowedSections)if(!sections.includes(section))delete result[section];
  result.omittedSections=[];
  for(const section of ['preview','dependencies','derivation','queryDefinition','reportDraft']){
   if(Buffer.byteLength(JSON.stringify(result))<=22000)break;
   if(result[section]!==undefined){delete result[section];result.omittedSections.push(section);}
  }
  if(result.omittedSections.length)result.sectionNote='响应过大；omittedSections未展示，不代表为空。用sections指定其中一项读取；预览改选更少columns。';
  if(result.omittedSections.includes('preview')){result.nextOffset=offset;result.previewBlocked=true;}
  return result;
 }
 async restore(ref){
  if(this.datasets.has(ref)){const data=this.datasets.get(ref);this.datasets.delete(ref);this.datasets.set(ref,data);return data;}
  await this.check();if(!this.storage)return null;
  let saved;try{saved=await this.storage.get(ref);}catch{throw new ReportInputError('数据集范围、文件或摘要校验失败；先调用list_datasets核对本任务已有成果，必要时重新取数。');}await this.check();const bytes=Buffer.byteLength(JSON.stringify(saved.data));
  if(saved.data.rows.length>this.maxRows)throw new ReportInputError('恢复数据集超过当前授权行数上限');
  this.sourceScopes.set(ref,saved.scope);const data={...saved.data,readAt:saved.readAt,snapshotId:saved.snapshotId};this.remember(ref,data);return data;
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
 async deployment(args){await this.check();const data=await this.restore(args.datasetRef);const result=deploymentEvidence(args,data,this.deploymentScope);await this.check();return result;}
 async captureRows(rows,columns,{complete,queryDefinition,numericColumns=[],recipe,sourceRead}){
  await this.check();if(!this.storage)throw new ReportInputError('长字段已读取但未配置任务证据存储；需要维护者配置本任务输出目录，不能截断后冒充完整字段');
  queryDefinition={...queryDefinition,sql:queryDefinition.sql,params:queryDefinition.params.map(v=>this.secrets.reduce((text,secret)=>text.split(secret).join('[已隐藏]'),String(v)))};
  const ref='dataset-'+randomUUID(),data={rows,columns,complete,numericColumns,queryDefinition,queryHash:hash(queryDefinition),...(recipe?{recipe:{...structuredClone(recipe),replayable:true}}:{}),...(sourceRead?{sourceRead:structuredClone(sourceRead)}:{})};
  const saved=await this.storage.save(ref,data,this.snapshotId);await this.check();
  this.sourceScopes.set(ref,this.scope);return {datasetRef:ref,evidenceRef:ref,queryHash:data.queryHash,rowCount:rows.length,columns,readAt:saved.readAt,complete,partial:!complete,rows:[],resultLimited:true,stage:'完整字段已保存到本任务证据；用read_dataset按行/列与textOffset读取，未重新查询，有限行样本不能当完整对象范围'};
 }
 async readDataset({datasetRef,offset=0,column,textOffset=0,limit=1024}){
  await this.check();if(!Number.isInteger(offset)||offset<0||!Number.isInteger(textOffset)||textOffset<0||!Number.isInteger(limit)||limit<1||limit>4000)throw new ReportInputError('证据分页位置须为非负整数，limit为1至4000字符；按nextTextOffset续读');
  let data=this.datasets.get(datasetRef);
  if(!data&&this.storage){const saved=await this.storage.get(datasetRef,{allowPartial:true});data={...saved.data,readAt:saved.readAt,snapshotId:saved.snapshotId};}
  if(!data||!data.columns.includes(column)||offset>=data.rows.length)throw new ReportInputError('证据引用、行号或列名无效；只能读取本任务实际保存字段');
  const value=data.rows[offset][column],text=value===null?null:String(value);if(textOffset>(text?.length??0))throw new ReportInputError('字段分页位置超出实际长度');
  const part=text===null?null:text.slice(textOffset,textOffset+limit),nextTextOffset=text!==null&&textOffset+limit<text.length?textOffset+limit:null;
  await this.check();return {datasetRef,offset,column,value:part,totalCharacters:text?.length??0,nextTextOffset,nextRowOffset:nextTextOffset===null&&offset+1<data.rows.length?offset+1:null,rowCount:data.rows.length,complete:data.complete,readAt:data.readAt,snapshotId:data.snapshotId,note:'仅分段显示；null仍为null，完整性沿用原查询，未取新数据。'};
 }
 async summarize(args){
  await this.check();const base=await this.restore(args.datasetRef);if(base)await this.verifyDerived(base);
  const data=summarizeDataset(args,base),ref='dataset-'+randomUUID();
  await this.check();if(this.storage)await this.storage.save(ref,data,data.snapshotId,data.readAt);await this.check();this.remember(ref,data);
  return {datasetRef:ref,complete:true,rowCount:data.rows.length,columns:data.columns,readAt:data.readAt,snapshotId:data.snapshotId,audit:data.derivation.audit,preview:preview(data.rows,this.previewRows),stage:'按完整来源整理并保存配方；仍须核验范围、文件及原要求'};
 }
 async transform(args){
  await this.check();const base=await this.restore(args.datasetRef);if(base)await this.verifyDerived(base);
  const data=transformDataset(args,base),ref='dataset-'+randomUUID();
  await this.check();if(this.storage)await this.storage.save(ref,data,data.snapshotId,data.readAt);await this.check();this.remember(ref,data);
  return {datasetRef:ref,complete:true,rowCount:data.rows.length,columns:data.columns,readAt:data.readAt,snapshotId:data.snapshotId,audit:data.derivation.audit,preview:preview(data.rows,this.previewRows),stage:'按完整来源整理并保存配方；仍须核验范围、文件及原要求'};
 }
 async period(args){
  await this.check();const data=await buildPeriodDataset(args,ref=>this.restore(ref),{check:()=>this.check(),maxRows:this.maxRows}),ref='dataset-'+randomUUID();
  if(this.storage)await this.storage.save(ref,data,data.snapshotId,data.readAt);await this.check();this.remember(ref,data);
  return {datasetRef:ref,dataHash:hash(data),complete:true,rowCount:data.rows.length,columns:data.columns,numericColumns:data.numericColumns,readAt:data.readAt,snapshotId:data.snapshotId,audit:data.derivation.audit,preview:preview(data.rows,this.previewRows),stage:'完整对象期间表已生成并精确累计；需独立基准核对及原问题审阅后交付'};
 }
 async window(args){
  await this.check();const data=await buildWindowDataset(args,ref=>this.restore(ref),{check:()=>this.check()}),ref='dataset-'+randomUUID();
  if(this.storage)await this.storage.save(ref,data,data.snapshotId,data.readAt);await this.check();this.remember(ref,data);
  return {datasetRef:ref,dataHash:hash(data),complete:true,rowCount:data.rows.length,columns:data.columns,numericColumns:data.numericColumns,readAt:data.readAt,snapshotId:data.snapshotId,audit:data.derivation.audit,preview:preview(data.rows,this.previewRows),stage:'完整主对象的所有显式窗口已一次去重统计，保留零发生组；仍需独立核验与原问题审阅'};
 }
 async verifyDerived(data,validation={}){await verifyPeriodDataset(data,ref=>this.restore(ref),Object.assign(validation,{check:()=>this.check(),maxRows:this.maxRows}));}
 async rawEvidence(data,column,validation={}){
  await this.verifyDerived(data,validation);
  if(data.derivation?.kind==='window_counts'){
   const proof=await this.windowEvidence(data,column,validation);return proof.ids.length===1?proof.ids[0]:proof.ids.length?hash(proof.ids):null;
  }
  if(data.derivation?.kind==='period_grid'){
   const p=data.derivation.provenance[column]??{datasetRef:data.derivation.args.populationRef,column};
   return this.rawEvidence(await this.restore(p.datasetRef),p.column,validation);
  }
  if(['dataset_summary','dataset_transform'].includes(data.derivation?.kind))return this.rawEvidence(await this.restore(data.derivation.args.datasetRef),column,validation);
  if(data.derivation?.kind==='left_lookup'){
   for(const lookup of data.derivation.lookups){const field=lookup.fields.find(f=>f.as===column);if(field)return this.rawEvidence(await this.restore(lookup.datasetRef),field.column,validation);}
   return this.rawEvidence(await this.restore(data.derivation.datasetRef),column,validation);
  }
  return queryEvidenceIdentity(data);
 }
 async windowEvidence(data,column,validation={}){
  const d=data.derivation;
  if(d?.kind==='window_counts'){
   const refs=column===(d.args.denominatorColumn??'population_count')?[d.args.populationRef]:d.args.sources.map(s=>s.datasetRef),ids=[];
   for(const ref of refs){const p=await this.windowEvidence(await this.restore(ref),column,validation);ids.push(...p.ids);}
   return {window:true,ids:[...new Set(ids)].sort()};
  }
  if(['dataset_summary','dataset_transform'].includes(d?.kind))return this.windowEvidence(await this.restore(d.args.datasetRef),column,validation);
  if(d?.kind==='period_grid'){const p=d.provenance[column]??{datasetRef:d.args.populationRef,column};return this.windowEvidence(await this.restore(p.datasetRef),p.column,validation);}
  if(d?.kind==='left_lookup'){const lookup=d.lookups.find(l=>l.fields.some(f=>f.as===column)),field=lookup?.fields.find(f=>f.as===column);return this.windowEvidence(await this.restore(lookup?.datasetRef??d.datasetRef),field?.column??column,validation);}
  const id=queryEvidenceIdentity(data);return {window:false,ids:id?[id]:[]};
 }
 async windowField(data,column){
  const d=data.derivation;if(!d)return null;
  if(d.kind==='window_counts'){const w=d.args.windows.find(w=>w.percentageColumn===column);return w?{count:w.countColumn,denominator:d.args.denominatorColumn??'population_count',precision:w.precision??2,zeroDenominator:w.zeroDenominator??'empty'}:null;}
  if(['dataset_summary','dataset_transform'].includes(d.kind))return this.windowField(await this.restore(d.args.datasetRef),column);
  if(d.kind==='left_lookup'){
   const lookup=d.lookups.find(l=>l.fields.some(f=>f.as===column));if(!lookup)return this.windowField(await this.restore(d.datasetRef),column);
   const original=lookup.fields.find(f=>f.as===column).column,w=await this.windowField(await this.restore(lookup.datasetRef),original);
   return w?{...w,count:lookup.fields.find(f=>f.column===w.count)?.as,denominator:lookup.fields.find(f=>f.column===w.denominator)?.as}:null;
  }return null;
 }
 async compose(args){
  const validation={};
  await this.check();if(!this.directory)throw new ReportInputError('本次执行未配置报表输出目录');
  if(!Array.isArray(args.sources)||!args.sources.length||!Array.isArray(args.columns)||!args.columns.length)throw new ReportInputError('报表需要非空来源和列定义');
  try{args={...args,columns:reportColumns(args.columns,this.originalQuestion)};}catch(error){throw new ReportInputError(error.message);}
  const sources=new Map();let keys=new Set();
  for(const s of args.sources){
   if(!s||!/^s[0-9]+$/.test(s.name)||sources.has(s.name))throw new ReportInputError('来源name必须为不重复的s1、s2等');
   const data=await this.restore(s.datasetRef);if(!data?.complete||!data.columns.includes(s.keyColumn))throw new ReportInputError('来源必须为本任务完整数据集，并指定实际业务主键列');
   const map=new Map();for(const row of data.rows){const key=row[s.keyColumn];if(key===null||key===''||map.has(key))throw new ReportInputError('来源主键为空或重复，不能直接拼接金额；请先按同一业务对象粒度汇总');map.set(key,row);keys.add(key);}
   await this.verifyDerived(data,validation);sources.set(s.name,{...data,map});
  }
  if(args.population){const population=await this.restore(args.population.datasetRef);if(!population?.complete||!population.columns.includes(args.population.keyColumn))throw new ReportInputError('population需要完整范围数据集及主键');keys=uniqueKeys(population,args.population.keyColumn);}
  if(keys.size>this.maxRows)throw new ReportInputError('合并后超过报表行数上限；未生成文件');
  const headers=args.columns.map(c=>c?.label);if(headers.some(x=>typeof x!=='string'||!x.trim()||x.length>80)||new Set(headers).size!==headers.length)throw new ReportInputError('列标题应唯一且不超过80字符');
  const expandWindow=async e=>{
   if(e?.op==='field'){
    const source=sources.get(e.source);const w=source&&await this.windowField(source,e.column);
    if(w){if(!source.columns.includes(w.count)||!source.columns.includes(w.denominator))throw new ReportInputError('窗口占比需要原始去重数量和分母分量参与核验；使用包含这两列的窗口来源，不只复制百分比文本');return {op:'percentage',args:[{...e,column:w.count},{...e,column:w.denominator}],precision:w.precision,zeroDenominator:w.zeroDenominator};}
   }
   return Array.isArray(e?.args)?{...e,args:await Promise.all(e.args.map(expandWindow))}:e;
  };
  args={...args,columns:await Promise.all(args.columns.map(async c=>({...c,value:await expandWindow(c.value)})))};
  const validate=(e,depth=0)=>{if(!e||typeof e!=='object')throw new ReportInputError('报表列计算过于复杂');
   if(e.op==='constant'){if(!depth)throw new ReportInputError('常量只允许作为计算参数');decimal(e.value);return;}
   if(e.op==='key')return;
   if(e.op==='field'){const s=sources.get(e.source);if(!s?.columns.includes(e.column)||e.missing!==undefined&&!['zero','empty'].includes(e.missing))throw new ReportInputError('报表字段引用无效');return;}
   if(!['add','subtract','min','percentage','divide'].includes(e.op)||!Array.isArray(e.args)||e.args.length<2)throw new ReportInputError('仅支持key、field、add、subtract、min固定计算，不接受表达式');e.args.forEach(x=>validate(x,depth+1));};
  args.columns.forEach(c=>{validate(c.value);if(c.value.op==='percentage')percentage('0','1',c.value);if(c.value.op==='divide')divide('0','1',c.value);});
  const evaluate=(e,key)=>{
   if(e.op==='key')return key;
   if(e.op==='field'){const row=sources.get(e.source).map.get(key);const v=row?.[e.column];if(v===undefined||v===null){if(e.missing==='zero')return '0';if(e.missing==='empty')return '';throw new ReportInputError('报表有缺失值；必须明确缺失值的业务处理规则');}return v;}
   if(e.op==='constant')return String(e.value);if(e.op==='divide'){if(e.args.length!==2)throw new Error('divide requires two operands');return divide(evaluate(e.args[0],key),evaluate(e.args[1],key),e);}if(e.op==='percentage'){if(e.args.length!==2)throw new ReportInputError('percentage requires two operands');return percentage(evaluate(e.args[0],key),evaluate(e.args[1],key),e);}
   const values=e.args.map(x=>decimal(evaluate(x,key)));let v=values[0];for(const n of values.slice(1))v=e.op==='add'?v+n:e.op==='subtract'?v-n:v<n?v:n;return format(v);
  };
  const rows=[...keys].sort().map(key=>args.columns.map(c=>evaluate(c.value,key)));
  const csv='\uFEFF'+[headers,...rows].map(row=>row.map(csvCell).join(',')).join('\r\n')+'\r\n';const bytes=Buffer.byteLength(csv);
  const totals=Object.fromEntries(args.columns.flatMap((c,i)=>['add','subtract','min'].includes(c.value.op)||c.total===true?[[c.label,c.value.op==='field'&&c.value.missing==='empty'&&!rows.some(row=>row[i]!=='')?null:format(rows.reduce((n,row)=>n+(c.value.op==='field'&&c.value.missing==='empty'&&row[i]===''?0n:decimal(row[i])),0n))]]:[]));
  const datasetRef=`dataset-${randomUUID()}`,composed={rows:rows.map(row=>Object.fromEntries(headers.map((h,i)=>[h,row[i]]))),columns:headers,complete:true,numericColumns:args.columns.filter(c=>c.total===true||['add','subtract','min','divide'].includes(c.value.op)||(c.value.op==='field'&&sources.get(c.value.source).numericColumns?.includes(c.value.column))).map(c=>c.label)};
  const snapshotIds=[...new Set([...sources.values()].map(d=>d.snapshotId))].sort(),snapshotId=snapshotIds.length===1?snapshotIds[0]:createHash('sha256').update(JSON.stringify(snapshotIds)).digest('hex');
  const readAt=[...sources.values()].map(d=>d.readAt).filter(Boolean).sort()[0]??new Date().toISOString();
  const dataHash=createHash('sha256').update(JSON.stringify(composed)).digest('hex');
  const id=`report-${randomUUID()}`,filename=id+'.csv';await this.check();await mkdir(this.directory,{recursive:true,mode:0o700});
  const temp=path.join(this.directory,filename+'.tmp'),file=path.join(this.directory,filename);
  try{await writeFile(temp,csv,{mode:0o600,flag:'wx'});await this.check();await rename(temp,file);await this.check();}
  catch(error){await rm(temp,{force:true});await rm(file,{force:true});throw error;}
  this.files++;
  composed.readThroughAt=[...sources.values()].map(d=>d.readThroughAt??d.readAt).sort().at(-1);
  composed.authorizedDatasetScopes=this.datasetScopes;
  composed.reportDraft={...(args.population?{population:args.population}:{}),keys:[...keys].sort(),file:{id,filename,bytes,sha256:createHash('sha256').update(csv).digest('hex'),rowCount:rows.length,complete:true},sources:args.sources,columns:args.columns,sourceSnapshots:[...sources].map(([name,data])=>({name,readAt:data.readAt,snapshotId:data.snapshotId}))};
  if(this.storage){await this.check();await this.storage.save(datasetRef,composed,snapshotId,readAt);await this.check();}

  // Persisted derived datasets can be resumed without repeating SQL or resetting their evidence age.
  this.remember(datasetRef,{...composed,snapshotId,readAt});
  return {datasetRef,dataHash,readAt,snapshotId,sourceSnapshots:[...sources].map(([name,data])=>({name,readAt:data.readAt,snapshotId:data.snapshotId})),snapshotConsistency:new Set([...sources.values()].map(d=>d.snapshotId)).size>1?'multiple_read_times':'single_transaction',complete:true,truncated:false,rowCount:rows.length,columns:headers,totals,preview:preview(rows,this.previewRows),draftFile:composed.reportDraft.file,stage:'CSV草稿已生成，尚不可交付；先用finalize_report核验原要求、完整对象范围及各计算分量合计'};
 }
 async enrich(args){
  await this.check();const base=await this.restore(args.datasetRef);
  if(!base?.complete||!base.columns.includes(args.keyColumn)||!Array.isArray(args.lookups)||!args.lookups.length)throw new ReportInputError('enrich_dataset需要完整主数据集、实际主键和非空lookups');
  uniqueKeys(base,args.keyColumn);
  const rows=base.rows.map(row=>({...row})),columns=[...base.columns],lookupChecks=[],inputs=[base],numericColumns=[...(base.numericColumns??[])];
  for(const lookup of args.lookups){
   await this.check();if(!lookup||typeof lookup!=='object'||Array.isArray(lookup))throw new ReportInputError('lookup必须为对象');const right=await this.restore(lookup.datasetRef);
   if(!/^[a-z][a-z0-9_]{0,19}$/.test(lookup.name??'')||!right?.complete||!columns.includes(lookup.sourceColumn)||!right.columns.includes(lookup.targetColumn)||!['empty','error'].includes(lookup.missing)||!Array.isArray(lookup.fields)||!lookup.fields.length||lookup.fields.some(f=>!f||typeof f!=='object'||Array.isArray(f)))throw new ReportInputError('lookup需要唯一名称、实际关联列、非空字段以及明确missing=empty或error');
   const outputs=lookup.fields.map(f=>f.as),status=lookup.name+'_status';
   if(lookup.fields.some(f=>!right.columns.includes(f.column)||typeof f.as!=='string'||!f.as.trim()||f.as.length>80||['__proto__','constructor','prototype'].includes(f.as))||outputs.includes(status)||columns.includes(status)||new Set(outputs).size!==outputs.length||outputs.some(c=>columns.includes(c)))throw new ReportInputError('lookup字段无效、重复或试图覆盖已有列');
   const index=new Map();for(const row of right.rows){const key=row[lookup.targetColumn];if(key===null||key==='')continue;if(index.has(key))throw new ReportInputError('lookup关联键重复，不能猜测选哪条记录或重复累计；enrich_dataset只查唯一维度。一对多明细须用linked_group_dataset按明细粒度分组，保留无明细主对象用join.type=left；核实关联键及右表筛选，不可去重丢记录');index.set(key,row);}
   if(lookup.fallbackKey!==undefined&&(typeof lookup.fallbackKey!=='string'||!lookup.fallbackKey||lookup.fallbackKey.length>2000||!index.has(lookup.fallbackKey)))throw new ReportInputError('fallbackKey必须指向本次完整维度数据中实际存在且唯一的默认配置，不能猜测或填常量');
   let matchedCount=0,fallbackCount=0;const unmatched=[];
   for(const row of rows){const specific=index.get(row[lookup.sourceColumn]),fallback=!specific&&lookup.fallbackKey!==undefined?index.get(lookup.fallbackKey):null,found=specific??fallback;if(specific)matchedCount++;else if(fallback)fallbackCount++;else unmatched.push(row[args.keyColumn]);for(const f of lookup.fields){const value=found?found[f.column]:'';row[f.as]=value;}row[status]=specific?'已匹配':fallback?'沿用默认配置':'未匹配';}
   if(unmatched.length&&lookup.missing==='error')throw new ReportInputError(`lookup ${lookup.name}有${unmatched.length}个对象未匹配；核对关联键或明确允许保留空值`);
   columns.push(...outputs,status);numericColumns.push(...lookup.fields.filter(f=>right.numericColumns?.includes(f.column)).map(f=>f.as));lookupChecks.push({name:lookup.name,matchedCount,...(lookup.fallbackKey!==undefined?{fallbackCount,fallbackKey:lookup.fallbackKey}:{}),unmatchedCount:unmatched.length,unmatchedKeys:unmatched.slice(0,this.previewRows),previewLimited:unmatched.length>this.previewRows});inputs.push(right);
  }
  const data={rows,columns,numericColumns,complete:true,readThroughAt:inputs.map(d=>d.readThroughAt??d.readAt).sort().at(-1),derivation:{kind:'left_lookup',datasetRef:args.datasetRef,keyColumn:args.keyColumn,lookups:args.lookups,lookupChecks}};
  const readAt=inputs.map(d=>d.readAt).sort()[0],snapshotIds=[...new Set(inputs.map(d=>d.snapshotId))].sort(),snapshotId=snapshotIds.length===1?snapshotIds[0]:hash(snapshotIds),ref='dataset-'+randomUUID();
  await this.check();if(this.storage)await this.storage.save(ref,data,snapshotId,readAt);await this.check();this.remember(ref,{...data,readAt,snapshotId});
  return {datasetRef:ref,dataHash:hash({rows,columns,numericColumns}),readAt,snapshotId,complete:true,rowCount:rows.length,columns,lookupChecks,preview:preview(rows,this.previewRows),stage:'主对象完整保留，维度字段已组合；未匹配和多时点不代表业务数据已验收'};
 }
 async refresh(args,{begin,reload}){
  await this.check();if(!Array.isArray(args.checks)||typeof args.populationRef!=='string')throw new ReportInputError('refresh_report需要与finalize_report相同的范围、列定义及独立基准参数');
  const root=await this.restore(args.datasetRef);if(!root?.reportDraft)throw new ReportInputError('refresh_report需要已有草稿引用');
  const graph=new Map(),visiting=new Set();
  const visit=async(ref,depth=0)=>{
   if(graph.has(ref))return;if(visiting.has(ref))throw new ReportInputError('报表来源图循环，不能安全集中刷新');
   visiting.add(ref);const d=await this.restore(ref);if(!d?.complete)throw new ReportInputError('刷新来源不完整');
   if(d.reportDraft){for(const source of d.reportDraft.sources)await visit(source.datasetRef,depth+1);if(d.reportDraft.population)await visit(d.reportDraft.population.datasetRef,depth+1);}
   else if(['dataset_summary','dataset_transform'].includes(d.derivation?.kind)){await visit(d.derivation.args.datasetRef,depth+1);}
   else if(['period_grid','window_counts'].includes(d.derivation?.kind)){await visit(d.derivation.args.populationRef,depth+1);for(const source of d.derivation.args.sources)await visit(source.datasetRef,depth+1);}
   else if(d.derivation?.kind==='left_lookup'){await visit(d.derivation.datasetRef,depth+1);for(const lookup of d.derivation.lookups)await visit(lookup.datasetRef,depth+1);}
   else{
    const recipe=d.recipe;
    const temporary=value=>value&&typeof value==='object'&&(value.op==='in_set'||Object.values(value).some(temporary));
    if(!recipe||recipe.replayable===false||!['group_dataset','linked_group_dataset','mongo_dataset'].includes(recipe.tool)||!recipe.args||temporary(recipe.args))throw new ReportInputError('来源缺少可重放的固定工具recipe，或依赖临时in_set集合；先在当前授权下补齐来源，不执行保存的SQL');
    if(recipe.tool==='mongo_dataset'&&recipe.args.cohort)await visit(recipe.args.cohort.datasetRef,depth+1);
   }
   visiting.delete(ref);graph.set(ref,d);
  };
  await visit(args.populationRef);for(const c of args.checks){if(!c||typeof c.referenceRef!=='string')throw new ReportInputError('checks缺少referenceRef');await visit(c.referenceRef);}await visit(args.datasetRef);
  // Finish the entire dependency check before touching the live connection.
  await this.check();await begin();await this.check();this.snapshotId=randomUUID();this.collected.clear();
  const mapped=new Map();let rawCount=0;
  for(const [ref,d] of graph){await this.check();let output;
   if(d.reportDraft){output=await this.compose({sources:d.reportDraft.sources.map(x=>({...x,datasetRef:mapped.get(x.datasetRef)})),columns:d.reportDraft.columns,...(ref===args.datasetRef?{population:{datasetRef:mapped.get(args.populationRef),keyColumn:args.populationKey}}:d.reportDraft.population?{population:{...d.reportDraft.population,datasetRef:mapped.get(d.reportDraft.population.datasetRef)}}:{})});}
   else if(['dataset_summary','dataset_transform'].includes(d.derivation?.kind))output=await this[d.derivation.kind==='dataset_summary'?'summarize':'transform']({...d.derivation.args,datasetRef:mapped.get(d.derivation.args.datasetRef)});
   else if(d.derivation?.kind==='window_counts')output=await this.window({...d.derivation.args,populationRef:mapped.get(d.derivation.args.populationRef),sources:d.derivation.args.sources.map(x=>({...x,datasetRef:mapped.get(x.datasetRef)}))});
   else if(d.derivation?.kind==='period_grid')output=await this.period({...d.derivation.args,populationRef:mapped.get(d.derivation.args.populationRef),sources:d.derivation.args.sources.map(x=>({...x,datasetRef:mapped.get(x.datasetRef)}))});
   else if(d.derivation?.kind==='left_lookup')output=await this.enrich({...d.derivation,datasetRef:mapped.get(d.derivation.datasetRef),lookups:d.derivation.lookups.map(x=>({...x,datasetRef:mapped.get(x.datasetRef)}))});
   else {const recipe=structuredClone(d.recipe);if(recipe.tool==='mongo_dataset'&&recipe.args.cohort)recipe.args.cohort.datasetRef=mapped.get(recipe.args.cohort.datasetRef);output=await reload(recipe,{scope:this.sourceScopes.get(ref)??this.scope});rawCount++;if(!output?.complete)throw new ReportInputError('集中刷新返回不完整来源，不能定稿');}
   mapped.set(ref,output.datasetRef);
  }
  const refreshedDatasetRef=mapped.get(args.datasetRef);
  const final=await this.finalize({...args,datasetRef:refreshedDatasetRef,populationRef:mapped.get(args.populationRef),checks:args.checks.map(c=>({...c,referenceRef:mapped.get(c.referenceRef)}))});
  return {...final,refreshedDatasetRef,refresh:{sourceCount:rawCount,mode:graph.size&&[...graph.values()].some(x=>x.recipe?.tool==='mongo_dataset')?'renewed_authorized_sources_with_read_times':'new_readonly_transaction',previousDatasetRef:args.datasetRef},stage:'已按各授权来源集中刷新、重算并通过程序核验；跨来源不是同一事务，仍需按原问题审阅'};
 }
 async finalize(args){
  const validation={};
  await this.check();const data=await this.restore(args.datasetRef),draft=data?.reportDraft;
  if(!draft)throw new ReportInputError('finalize_report需要本任务compose_report产生的草稿引用');
  const text=(v)=>typeof v==='string'&&v.trim().length>=3&&v.length<=1200;
  if(!text(args.requirement)||!text(args.scopeEvidence)||!Array.isArray(args.expectedColumns)||JSON.stringify(args.expectedColumns)!==JSON.stringify(data.columns))throw new ReportInputError('须按原问题登记requirement、scopeEvidence及完全一致的expectedColumns，缺列、额外列或顺序不同应重做草稿');
  if(!Array.isArray(args.columnRules)||args.columnRules.length!==data.columns.length||args.columnRules.some((c,i)=>c?.label!==data.columns[i]||!text(c.definition)||!text(c.evidence)))throw new ReportInputError('每一列都要登记业务定义/公式与源码或文档依据，不得用项目名称包含某词替代已核实业务条件');
  try{validateReportHeaders(data.columns,this.originalQuestion);}catch(error){throw new ReportInputError(error.message);}
  const population=await this.restore(args.populationRef);
  await this.verifyDerived(population??{},validation);
  const periodPopulation=population?.derivation?.kind==='period_grid'&&population.derivation.args.sources.length===0;
  let populationBase=periodPopulation?await this.restore(population.derivation.args.populationRef):population;
  const populationVisited=new Set();while(['dataset_summary','dataset_transform'].includes(populationBase?.derivation?.kind)){const ref=populationBase.derivation.args.datasetRef;if(populationVisited.has(ref))throw new ReportInputError('范围依赖循环');populationVisited.add(ref);populationBase=await this.restore(ref);}
  if(!population?.complete||population.reportDraft||!populationBase?.queryHash||!populationBase.queryDefinition||!population.columns.includes(args.populationKey))throw new ReportInputError('完整对象范围必须来自独立原始查询数据集，不能拿草稿自身当覆盖证明；期间覆盖请从原始对象集合单独period_dataset，sources=[]，populationKey使用其period_key；inspect_dataset的populationPlans可定位已有来源及范围，不需重查整套数据');
  const expected=uniqueKeys(population,args.populationKey);
  if(!Array.isArray(draft.keys)||draft.keys.length!==data.rows.length||new Set(draft.keys).size!==draft.keys.length||draft.keys.some(k=>typeof k!=='string'||!k))throw new ReportInputError('草稿缺少完整内部主键索引；重新生成草稿后核验');
  const actual=new Set(draft.keys),missing=[...expected].filter(k=>!actual.has(k)),extra=[...actual].filter(k=>!expected.has(k));
  if(missing.length||extra.length)throw new ReportInputError(`清单覆盖未通过：应有${expected.size}个对象，实际${actual.size}个；遗漏${missing.length}个、多出${extra.length}个。补齐后重做草稿，不能把单户抽样当完整清单。`);
  const sources=new Map();for(const s of draft.sources){const source=await this.restore(s.datasetRef);if(source)await this.verifyDerived(source,validation);if(!source?.complete)throw new ReportInputError('来源已失效，需要重新取数');sources.set(s.name,source);}
  const required=new Set();
  const leaves=(e,numeric)=>{if(e.op==='field'&&numeric)required.add(e.source+':'+e.column);for(const child of e.args??[])leaves(child,true);};
  for(const c of draft.columns)leaves(c.value,data.numericColumns?.includes(c.label)||c.total===true);
  if(!Array.isArray(args.checks))throw new ReportInputError('checks必须为分量合计核验数组');
  const totals=[],proofs=[];const times=[population,data,...sources.values()];
  for(const c of args.checks){
   if(!c||typeof c!=='object'||typeof c.source!=='string'||typeof c.column!=='string'||typeof c.referenceRef!=='string'||typeof c.referenceColumn!=='string')throw new ReportInputError('checks每项必须明确source、column、referenceRef和referenceColumn');
   const source=sources.get(c.source),ref=await this.restore(c.referenceRef),name=c.source+':'+c.column;
   // Separate input mistakes from provenance failures. A single generic error
   // made the planner inspect every dataset repeatedly to discover which check
   // was wrong; none of these diagnostics changes the verification criteria.
   const issues=[];
   if(!required.has(name))issues.push('source/column不是草稿requiredChecks要求的分量；inspect_dataset选择reportDraft核对来源别名与实际字段');
   if(!source?.columns.includes(c.column))issues.push('source或column不存在于草稿实际来源；不要把输出中文列名当作来源字段');
   if(!ref?.complete)issues.push('referenceRef不存在、范围不符或不是完整数据集；list_datasets定位已保存的完整基准');
   if(ref?.reportDraft)issues.push('referenceRef指向report_draft；需要原始查询基准，不能拿草稿自证');
   if(ref&&!ref.columns.includes(c.referenceColumn))issues.push('referenceColumn不存在于referenceRef；inspect_dataset核对该基准实际列名，不重跑业务查询');
   if(!text(c.evidence))issues.push('evidence缺少有效的基准口径依据文字');
   const prefix='分量合计需引用不同原始查询的完整基准集和实际数值列：';
   if(issues.length)throw new ReportInputError(prefix+issues.join('；'));
   const referenceEvidence=await this.rawEvidence(ref,c.referenceColumn,validation),sourceEvidence=await this.rawEvidence(source,c.column,validation);
   if(!referenceEvidence)throw new ReportInputError(prefix+'基准无法追溯到原始查询；inspect_dataset核对dependencies/derivation和queryDefinition，只补缺失来源，不重跑整套取数');
   const sourceProof=await this.windowEvidence(source,c.column,validation),referenceProof=await this.windowEvidence(ref,c.referenceColumn,validation);
   if((sourceProof.window||referenceProof.window)&&sourceProof.ids.some(id=>referenceProof.ids.includes(id)))throw new ReportInputError('窗口分量与基准共享同一原始查询；不能从同一批来源重算后自证');
   if(referenceEvidence===sourceEvidence)throw new ReportInputError(prefix+'基准与分量来自同一查询，另存datasetRef或改列名不能自证；复用已有不同原始查询的完整基准，没有时按同口径补一次独立聚合，不重复全部明细');
   if(totals.some(x=>x.name===name))throw new ReportInputError('同一分量不能重复核验');
   const sourceKey=draft.sources.find(s=>s.name===c.source).keyColumn;
   if(sourceProof.window&&source.derivation?.kind!=='period_grid'){
    if(!referenceProof.window)throw new ReportInputError('窗口统计须用不同原始查询生成同分组同窗口基准，逐对象核对，不能只核对合计');
    const refKey=c.referenceKey??ref.derivation?.args?.rowKey??'group_key',index=new Map(ref.rows.map(row=>[row[refKey],row]));
    if(index.size!==ref.rows.length||index.size!==expected.size)throw new ReportInputError('窗口独立基准范围重复或不完整');
    for(const row of source.rows)if(expected.has(row[sourceKey])){const other=index.get(row[sourceKey]);if(!other||decimal(row[c.column])!==decimal(other[c.referenceColumn]))throw new ReportInputError('窗口独立基准逐对象数值不一致，不能用总数相等代替');}
   }
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
  if(timestamps.some(t=>!Number.isFinite(t))||(this.snapshotWindowMs!==null&&Math.max(...timestamps)-Math.min(...timestamps)>this.snapshotWindowMs))throw new ReportInputError(`取数时点相差超过${this.snapshotWindowMs/60000}分钟（管理员配置窗口）；复用不变规则，集中刷新受影响来源与独立基准后重做草稿，不逐轮盲目刷新。`);
  const info=await lstat(path.join(this.directory,draft.file.filename));
  if(!info.isFile()||info.isSymbolicLink()||info.size!==draft.file.bytes||createHash('sha256').update(await readFile(path.join(this.directory,draft.file.filename))).digest('hex')!==draft.file.sha256)throw new ReportInputError('草稿文件已变化，不能交付');
  const receipt={version:1,datasetRef:args.datasetRef,formulas:draft.columns,status:'verified',originalQuestion:this.originalQuestion,verifiedAt:new Date().toISOString(),file:draft.file,requirement:args.requirement,scopeEvidence:args.scopeEvidence,columnRules:args.columnRules,coverage:{populationRef:args.populationRef,populationKey:args.populationKey,rowCount:actual.size},totals,sources:[...sources].map(([name,d])=>({name,dataHash:hash(d),queryHash:d.queryHash,queryDefinition:queryPreview(d.queryDefinition),derivation:d.derivation,readAt:d.readAt,snapshotId:d.snapshotId})),proofs,readWindow:{earliest:new Date(Math.min(...timestamps)).toISOString(),latest:new Date(Math.max(...timestamps)).toISOString(),spreadMs:Math.max(...timestamps)-Math.min(...timestamps),maxSpreadMs:this.snapshotWindowMs},snapshotNote:this.snapshotWindowMs===null?'记录全部来源真实取数起止时间，未设置固定跨来源时间窗口；不代表同一事务，业务定义仍须审阅。':'按管理员配置的取数窗口核验，不代表多轮属于同一事务；业务定义依据由Agent核实，程序不能理解并证明业务语义正确。'};
  const body=JSON.stringify(receipt);
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
