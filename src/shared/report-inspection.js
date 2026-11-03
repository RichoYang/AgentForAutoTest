import {verifyTransformTree} from './relational-dataset.js';
import {verifyPeriodDataset} from './period-dataset.js';
import {readFile,readdir,lstat} from 'node:fs/promises';
import path from 'node:path';
import {reportFile} from './report-files.js';
import {TaskDatasetStore} from '../runner/task-dataset-store.js';
export class ReportInspectionError extends Error {constructor(message){super(message);this.code='REPORT_INSPECTION';}}
const fail=message=>{throw new ReportInspectionError(message);};
const scale=10n**12n;
const decimal=v=>{const s=String(v);if(!/^-?\d{1,40}(?:\.\d{1,12})?$/.test(s))fail('报表来源金额格式无效');const [a,b='']=s.replace(/^-/,'').split('.');return (s.startsWith('-')?-1n:1n)*(BigInt(a)*scale+BigInt(b.padEnd(12,'0')));};
const format=n=>{const sign=n<0n?'-':'';if(n<0n)n=-n;const frac=String(n%scale).padStart(12,'0').replace(/0+$/,'');return sign+String(n/scale)+(frac?'.'+frac:'');};
const cell=v=>{let s=String(v??'');if(/^[\s\uFEFF]*[=+@-]/.test(s)&&!/^-[0-9]+(?:\.[0-9]+)?$/.test(s))s="'"+s;return '"'+s.replaceAll('"','""')+'"';};
// Only a file already registered to this job/question can select a path.
export async function inspectReport(dataDir,job,args={}){
 try{return await inspectBoundReport(dataDir,job,args);}
 catch(error){if(error instanceof ReportInspectionError)throw error;throw new ReportInspectionError('当前登记文件、核验记录或绑定来源无法读取或校验；保留成果，由维护者核对本机文件，不能据此认定业务公式错误。');}
}
async function inspectBoundReport(dataDir,job,{fileId,section='summary',offset=0,limit=4}={}){
 const item=job.reportFiles?.find(f=>f.id===fileId);if(!item)fail('文件未登记在当前任务，不能猜测路径或读取其他任务');
 if(!['summary','columns','sources','checks','scope'].includes(section)||!Number.isInteger(offset)||offset<0||!Number.isInteger(limit)||limit<1||limit>4)fail('inspect_report的section或分页参数无效');
 const sourceJobId=item.sourceJobId??job.id;
 const verified=await reportFile(dataDir,sourceJobId,item);
 const receipt=JSON.parse(await readFile(path.join(path.dirname(verified.file),item.id+'.verification.json'),'utf8'));
 const directory=path.dirname(verified.file),datasetRoot=path.join(directory,'datasets');
 if((await lstat(datasetRoot)).isSymbolicLink())fail('报表数据集目录不能是符号链接');
 const names=receipt.datasetRef?[receipt.datasetRef+'.json']:(await readdir(datasetRoot)).filter(n=>/^dataset-[a-f0-9-]{36}\.json$/.test(n));
 let bound=null,storage;
 for(const name of names){
  if(!/^dataset-[a-f0-9-]{36}\.json$/.test(name))fail('核验记录数据集引用无效');
  const file=path.join(datasetRoot,name),info=await lstat(file);if(!info.isFile()||info.isSymbolicLink())continue;
  const candidate=JSON.parse(await readFile(file,'utf8'));if(candidate.data?.reportDraft?.file?.id!==item.id)continue;
  const store=new TaskDatasetStore(directory,candidate.scope),saved=await store.get(candidate.id),draft=saved.data.reportDraft;
  if(draft.file.sha256!==item.sha256||draft.file.rowCount!==item.rowCount||draft.file.bytes!==item.bytes)fail('文件与计算配方绑定不一致');
  if(bound)fail('同一文件出现多个计算配方，不能猜选');bound=saved;storage=store;
 }
 if(!bound)fail('未找到与当前文件摘要绑定的计算配方；不重复生成或查询数据库');
 const data=bound.data,draft=data.reportDraft;
 if(JSON.stringify(data.columns)!==JSON.stringify(receipt.columnRules.map(c=>c.label))||data.rows.length!==item.rowCount||draft.keys.length!==item.rowCount)fail('文件列或对象数量与核验记录不一致');
 const sources=new Map();for(const s of draft.sources){const saved=await storage.get(s.datasetRef);const d=saved.data,index=new Map();for(const row of d.rows){const key=row[s.keyColumn];if(typeof key!=='string'||!key||index.has(key))fail('计算来源主键为空或重复');index.set(key,row);}sources.set(s.name,{...d,index,readAt:saved.readAt,keyColumn:s.keyColumn,datasetRef:s.datasetRef});}
 const validate=(v,depth=0)=>{if(!v||typeof v!=='object')fail('计算配方超出固定表达式范围');if(v.op==='key')return;if(v.op==='field'){if(!sources.get(v.source)?.columns.includes(v.column))fail('计算配方字段不存在');return;}if(!['add','subtract','min'].includes(v.op)||!Array.isArray(v.args)||v.args.length<2||v.args.length>6)fail('计算配方包含不支持的表达式');v.args.forEach(c=>validate(c,depth+1));};draft.columns.forEach(c=>validate(c.value));
 const evaluate=(e,key)=>{if(e.op==='key')return key;if(e.op==='field'){const v=sources.get(e.source).index.get(key)?.[e.column];if(v===undefined||v===null){if(e.missing==='zero')return '0';if(e.missing==='empty')return '';fail('计算缺失值没有明确规则');}return v;}const raw=e.args.map(x=>evaluate(x,key));if(e.missing==='empty'&&raw.some(v=>v===null||v===''))return '';const values=raw.map(decimal);return format(values.slice(1).reduce((a,b)=>e.op==='add'?a+b:e.op==='subtract'?a-b:a<b?a:b,values[0]));};
 const rows=draft.keys.map(key=>draft.columns.map(c=>evaluate(c.value,key)));
 const csv='\uFEFF'+[data.columns,...rows].map(r=>r.map(cell).join(',')).join('\r\n')+'\r\n';
 if(csv!==verified.content.toString('utf8'))fail('实际CSV与绑定配方的逐行重算不一致，不能认定已修正');
 const columns=draft.columns.map((c,i)=>({label:c.label,value:c.value,definition:receipt.columnRules[i].definition,evidence:receipt.columnRules[i].evidence}));
 const sourceList=[...sources].map(([name,d])=>({name,datasetRef:d.datasetRef,keyColumn:d.keyColumn,columns:d.columns,rowCount:d.rows.length,readAt:d.readAt,queryDefinition:d.queryDefinition??null,derivation:d.derivation??null}));
 const population=await storage.get(receipt.coverage.populationRef),fileKeys=new Set(draft.keys),comparisons=[],visited=new Set();
 const describe=(ref,key,d)=>({datasetRef:ref,keyColumn:key,rowCount:d.rows.length,queryDefinition:d.queryDefinition?{sql:d.queryDefinition.sql.slice(0,1400),params:d.queryDefinition.params.slice(0,20)}:null});
 const compareScope=async(ref,key,include=false)=>{
  const identity=ref+':'+key,traversed=visited.has(identity);if(traversed&&(!include||comparisons.some(c=>c.datasetRef===ref&&c.keyColumn===key)))return;visited.add(identity);if(visited.size>100)fail('范围依赖超过可审阅边界');
  const saved=await storage.get(ref),d=saved.data,derivation=d.derivation;
  if(!d.columns.includes(key))fail('范围依赖主键不存在');
  const values=d.rows.map(r=>r[key]),keys=new Set(values),unique=keys.size===values.length&&!keys.has(null)&&!keys.has('');
  if(unique&&include){const onlyReference=[...keys].filter(k=>!fileKeys.has(k)),onlyFile=[...fileKeys].filter(k=>!keys.has(k));comparisons.push({...describe(ref,key,d),onlyReferenceCount:onlyReference.length,onlyFileCount:onlyFile.length,onlyReferencePreview:onlyReference.slice(0,3).map(k=>String(k).slice(0,80)),onlyFilePreview:onlyFile.slice(0,3).map(k=>String(k).slice(0,80))});}
  if(traversed)return;
  if(derivation?.kind==='left_lookup'&&key===derivation.keyColumn){await compareScope(derivation.datasetRef,key);for(const lookup of derivation.lookups.filter(l=>l.sourceColumn===key))await compareScope(lookup.datasetRef,lookup.targetColumn,true);}
 };
 await compareScope(receipt.coverage.populationRef,receipt.coverage.populationKey,true);for(const source of draft.sources)await compareScope(source.datasetRef,source.keyColumn);
 const loadPeriodSource=async ref=>{const saved=await storage.get(ref);return {...saved.data,readAt:saved.readAt,snapshotId:saved.snapshotId};};
 await verifyTransformTree(await loadPeriodSource(receipt.coverage.populationRef),loadPeriodSource);
 await verifyPeriodDataset(await loadPeriodSource(receipt.coverage.populationRef),loadPeriodSource);
 for(const source of draft.sources){await verifyTransformTree(await loadPeriodSource(source.datasetRef),loadPeriodSource);await verifyPeriodDataset(await loadPeriodSource(source.datasetRef),loadPeriodSource);}
 const populationAudit={selected:{...describe(receipt.coverage.populationRef,receipt.coverage.populationKey,population.data),scopeEvidence:receipt.scopeEvidence},comparisons,note:'这些是实际来源与主键直接关联的完整集合，不自动等于应纳入的业务范围。逐项对照原问题和源码确定全集/子集，不能把有金额记录自动当全部对象，也不能因有零金额而排除对象；多层组织维度可能本来不属于同一全集。差异须明确审阅，不因名称相似猜测。'};
 const checks=receipt.totals??[];
 const binding={fileId:item.id,sourceJobId,datasetRef:bound.id,sha256:item.sha256,verificationHash:item.verificationHash,rowCount:item.rowCount};
 const audit={status:'passed',checkedRows:rows.length,checkedCells:rows.length*columns.length,note:'实际CSV逐行等于绑定固定公式的计算结果；业务口径仍需对照原问题和来源依据审阅。'};
 if(section!=='summary'){const all=section==='columns'?columns:section==='sources'?sourceList:section==='scope'?comparisons:checks;const items=all.slice(offset,offset+limit);const result={binding,section,items,totalCount:all.length,nextOffset:offset+items.length<all.length?offset+items.length:null,calculationAudit:audit};if(Buffer.byteLength(JSON.stringify(result))>22000)fail('详情过长，请将limit缩小后继续分页');return result;}
 const result={binding,status:'verified',headers:data.columns,columns:columns.map(c=>({...c,definition:c.definition.slice(0,240),evidence:c.evidence.slice(0,200)})),sources:sourceList.map(d=>({...d,queryDefinition:d.queryDefinition?{sql:d.queryDefinition.sql.slice(0,1000),params:d.queryDefinition.params.slice(0,20)}:null,derivation:d.derivation?{kind:d.derivation.kind,lookupChecks:d.derivation.lookupChecks,audit:d.derivation.audit,args:d.derivation.args}:null})),coverage:receipt.coverage,populationAudit,checks,readWindow:receipt.readWindow,calculationAudit:audit,preview:rows.slice(0,3),limited:true,note:'按文件ID绑定的实际配方与CSV审阅资料，不是新的数据库查询。文本和来源为有界摘要；细节可用inspect_report的columns/sources/checks分页读取。不因未查询数据库把已有文件说成无记录。'};
 if(Buffer.byteLength(JSON.stringify(result))>22000){result.preview=[];result.populationAudit.comparisons=result.populationAudit.comparisons.map(c=>({...c,queryDefinition:c.queryDefinition?{sql:c.queryDefinition.sql.slice(0,300),params:c.queryDefinition.params.slice(0,3)}:null}));result.sources=result.sources.map(s=>({...s,queryDefinition:s.queryDefinition?{sql:s.queryDefinition.sql.slice(0,200),params:s.queryDefinition.params.slice(0,3)}:null}));}
 if(Buffer.byteLength(JSON.stringify(result))>22000){result.populationAudit.comparisons=result.populationAudit.comparisons.map(c=>({...c,queryDefinition:null,onlyReferencePreview:[],onlyFilePreview:[],detailsPaged:true}));}
 if(Buffer.byteLength(JSON.stringify(result))>22000)fail('审阅摘要超限，请使用分段查看');return result;
}
export async function reportReviewEvidence(dataDir,job){
 const item=job.reportFiles?.filter(f=>f.verificationHash).at(-1);if(!item)return null;
 try{return await inspectReport(dataDir,job,{fileId:item.id});}catch{return {status:'unavailable',binding:{fileId:item.id},note:'本机文件审阅校验失败；这是读取/绑定缺口，不是已证实的计算公式错误。请用inspect_report核对该文件，不能要求用户提供本机已有CSV或重复取数。'};}
}
