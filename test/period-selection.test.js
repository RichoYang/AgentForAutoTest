import test from 'node:test';import assert from 'node:assert/strict';
import {transformDataset,verifyRelationalDataset} from '../src/shared/relational-dataset.js';
const data=rows=>({rows,columns:Object.keys(rows[0]??{id:null,p:null,amount:null}),complete:true,numericColumns:['amount'],readAt:'2026-11-02T08:33:00.000Z',snapshotId:'original'});
const norm={datasetRef:'raw',fields:[{column:'p',as:'month',unit:'month',nulls:'error'}]};
const pick={datasetRef:'raw',keyColumns:['id'],periodColumn:'p',unit:'month',select:'last',ties:'all',nulls:'error'};
test('normalizes complete months without modifying original fields or precision; projects aliases without deduplication',async()=>{
 const raw=data([{id:'001',p:202609,amount:'9007199254740993.01'},{id:'001',p:'2026-9',amount:'-0.01'}]);
 const n=await transformDataset('normalize_period_dataset',norm,async()=>raw);assert.deepEqual(n.rows.map(x=>x.month),['2026-09','2026-09']);assert.equal(n.rows[0].p,202609);assert.equal(n.readAt,raw.readAt);
 const projected=await transformDataset('project_dataset',{datasetRef:'n',fields:[{column:'id',as:'object'},{column:'month',as:'period'},{column:'amount',as:'value'}]},async()=>n);assert.equal(projected.rows.length,2);assert.deepEqual(projected.numericColumns,['value']);assert.equal(projected.rows[0].value,raw.rows[0].amount);await verifyRelationalDataset(n,async()=>raw);
});
test('selects per-object periods across years, normalizes comparison, preserves all ties and original rows',async()=>{
 const raw=data([{id:'001',p:'2026-9',amount:'1'},{id:'001',p:'202610',amount:'2'},{id:'001',p:'2026-10',amount:'3'},{id:'002',p:'2025-12',amount:'4'},{id:'002',p:'2026-01',amount:'5'}]);
 const out=await transformDataset('select_period_dataset',pick,async()=>raw);assert.deepEqual(out.rows.map(x=>x.amount),['2','3','5']);assert.equal(out.derivation.audit.tieGroups,1);assert.equal(out.readAt,raw.readAt);await verifyRelationalDataset(out,async()=>raw);
 await assert.rejects(transformDataset('select_period_dataset',{...pick,ties:'error'},async()=>raw),/并列/);
 const first=await transformDataset('select_period_dataset',{...pick,select:'first'},async()=>raw);assert.deepEqual(first.rows.map(x=>x.amount),['1','4']);
 out.rows[0].amount='999';await assert.rejects(verifyRelationalDataset(out,async()=>raw),/不一致/);
});
test('invalid periods, unsafe outputs, nulls and missing keys fail before publishing; explicit null exclusion is audited',async()=>{
 for(const p of ['202613','2026-00','20260230','n/a',null])await assert.rejects(transformDataset('normalize_period_dataset',norm,async()=>data([{id:'a',p,amount:'1'}])));
 await assert.rejects(transformDataset('normalize_period_dataset',{...norm,fields:[{...norm.fields[0],as:'__proto__'}]},async()=>data([{id:'a',p:'202601'}])));
 await assert.rejects(transformDataset('select_period_dataset',pick,async()=>data([{id:null,p:'202601'}])),/分组键/);
 const raw=data([{id:'a',p:null},{id:'b',p:'202601'}]);await assert.rejects(transformDataset('select_period_dataset',{...pick,nulls:'exclude'},async()=>raw),/依据/);
 const out=await transformDataset('select_period_dataset',{...pick,nulls:'exclude',nullEvidence:'空期间没有可选事件，完整对象由主集左关联保留'},async()=>raw);assert.equal(out.derivation.audit.nullRows,1);
 const n=await transformDataset('normalize_period_dataset',{...norm,fields:[{...norm.fields[0],nulls:'keep'}]},async()=>raw);assert.equal(n.rows[0].month,null);
});
test('split year/month and day selection support other object types and cancellation',async()=>{
 const raw=data([{id:'department',year:'2026',p:'2',amount:'1'}]);const n=await transformDataset('normalize_period_dataset',{...norm,fields:[{...norm.fields[0],yearColumn:'year'}]},async()=>raw);assert.equal(n.rows[0].month,'2026-02');
 const days=data([{id:'order',p:'20260228',amount:'1'},{id:'order',p:'2026-03-01',amount:'2'}]);const out=await transformDataset('select_period_dataset',{...pick,unit:'day'},async()=>days);assert.equal(out.rows[0].amount,'2');
 await assert.rejects(transformDataset('select_period_dataset',pick,async()=>raw,{check:async()=>{throw Error('cancelled');}}),/cancelled/);
});
test('explicit arithmetic missing propagation keeps unknown objects instead of guessing zero; bound file inspection agrees',async t=>{
 const {ReportDatasets}=await import('../src/runner/report-datasets.js');const {mkdtemp,rm}=await import('node:fs/promises');const {tmpdir}=await import('node:os');const {inspectReport}=await import('../src/shared/report-inspection.js');
 const root=await mkdtemp(tmpdir()+'/period-null-');t.after(()=>rm(root,{recursive:true,force:true}));const d=new ReportDatasets({directory:root+'/exports/JOB-test',scope:'test',maxRows:'all'});
 const pop=await d.collect({sql:'SELECT id FROM objects',params:[],columns:['id']},async()=>[[{id:'a'},{id:'b'}]]);
 const raw=await d.collect({sql:'SELECT id,amount FROM facts',params:[],columns:['id','amount'],numericColumns:['amount']},async()=>[[{id:'a',amount:'0'}]]);
 const ref=await d.collect({sql:'SELECT id,SUM(amount) AS amount FROM facts GROUP BY id',params:[],columns:['id','amount'],numericColumns:['amount']},async()=>[[{id:'a',amount:'0'}]]);
 const value={op:'subtract',missing:'empty',args:[{op:'field',source:'s1',column:'amount',missing:'empty'},{op:'field',source:'s1',column:'amount',missing:'empty'}]};
 const draft=await d.compose({population:{datasetRef:pop.datasetRef,keyColumn:'id'},sources:[{name:'s1',datasetRef:raw.datasetRef,keyColumn:'id'}],columns:[{label:'编号',value:{op:'key'}},{label:'余额',value,total:true}]});
 const saved=await d.restore(draft.datasetRef);assert.equal(saved.rows[0]['余额'],'0');assert.equal(saved.rows[1]['余额'],'');assert.equal(draft.totals['余额'],'0');
 const final=await d.finalize({datasetRef:draft.datasetRef,populationRef:pop.datasetRef,populationKey:'id',requirement:'完整对象保留未知金额',scopeEvidence:'完整对象原始查询',expectedColumns:['编号','余额'],columnRules:[{label:'编号',definition:'对象实际编号',evidence:'对象id字段'},{label:'余额',definition:'本例原金额减自身；未知则未知',evidence:'测试固定规则'}],checks:[{source:'s1',column:'amount',referenceRef:ref.datasetRef,referenceColumn:'amount',evidence:'原始独立分组核验'}]});
 const info=await inspectReport(root,{id:'JOB-test',reportFiles:[final.exportFile]},{fileId:final.exportFile.id});assert.equal(info.calculationAudit.checkedRows,2);
 await assert.rejects(d.compose({population:{datasetRef:pop.datasetRef,keyColumn:'id'},sources:[{name:'s1',datasetRef:raw.datasetRef,keyColumn:'id'}],columns:[{label:'余额',value:{...value,missing:undefined}}]}),/金额/);
});
test('local dataset processing outlives SQL/export deadlines, checks auth and does not connect',async t=>{
 const {ReportDatasets}=await import('../src/runner/report-datasets.js');const {createEnvironmentTools}=await import('../src/runner/environment-tools.js');const {mkdtemp,rm}=await import('node:fs/promises');const {tmpdir}=await import('node:os');const {createHash}=await import('node:crypto');
 const dir=await mkdtemp(tmpdir()+'/local-period-wait-');t.after(()=>rm(dir,{recursive:true,force:true}));const e={kind:'mysql'},q={maxRows:20,timeoutMs:1,exportTimeoutMs:1,exportMaxRows:'all',tables:['*']};const scope=createHash('sha256').update(JSON.stringify(e)).digest('hex'),d=new ReportDatasets({directory:dir,scope,maxRows:'all'});
 const raw=await d.collect({sql:'SELECT id,p FROM facts',params:[],columns:['id','p']},async()=>[[{id:'001',p:'202611'}]]);
 let allowed=true,checks=0;const tools=await createEnvironmentTools(e,q,{}, {exportDirectory:dir,authorize:async()=>{checks++;await new Promise(r=>setTimeout(r,10));if(!allowed)throw Error('授权已过期');},mysql:{createConnection:()=>{throw Error('unnecessary connection');}}});t.after(()=>tools.close());
 const n=await tools.run('normalize_period_dataset',{...norm,datasetRef:raw.datasetRef});assert.equal(n.rowCount,1);assert.ok(checks>=2);allowed=false;
 await assert.rejects(tools.run('select_period_dataset',{...pick,datasetRef:n.datasetRef,periodColumn:'month'}),/SCOPE_LIMIT/);
});
test('final verification shares immutable dependency proofs only inside one operation',async t=>{
 const {ReportDatasets}=await import('../src/runner/report-datasets.js');const {mkdtemp,rm}=await import('node:fs/promises');const {tmpdir}=await import('node:os');const dir=await mkdtemp(tmpdir()+'/period-proof-');t.after(()=>rm(dir,{recursive:true,force:true}));const d=new ReportDatasets({directory:dir,scope:'test',maxRows:'all'});
 const raw=await d.collect({sql:'SELECT id,p FROM facts',params:[],columns:['id','p']},async()=>[[{id:'001',p:'202611'}]]);const n=await d.transform('normalize_period_dataset',{...norm,datasetRef:raw.datasetRef});const verified=new Set();await d.verifyDerived(await d.restore(n.datasetRef),new Set(),verified,n.datasetRef);assert.ok(verified.has(n.datasetRef));
 const source=await d.restore(raw.datasetRef);source.rows[0].p='202612';await assert.rejects(d.verifyDerived(await d.restore(n.datasetRef)),/重放不一致/);
});
test('refresh replays normalization, projection and per-object selection without changing the old result',async t=>{
 const {ReportDatasets}=await import('../src/runner/report-datasets.js');const {mkdtemp,rm}=await import('node:fs/promises');const {tmpdir}=await import('node:os');const dir=await mkdtemp(tmpdir()+'/period-refresh-');t.after(()=>rm(dir,{recursive:true,force:true}));const d=new ReportDatasets({directory:dir,scope:'test',maxRows:'all'});
 const collect=async(table,rows)=>d.collect({sql:'SELECT id,p FROM '+table,params:[],columns:['id','p'],recipe:{tool:'row_dataset',args:{table,columns:['id','p'],orderBy:['id'],filters:[]}}},async()=>[rows]);
 const pop=await collect('objects',[{id:'001',p:'202601'}]),raw=await collect('facts',[{id:'001',p:'202601'}]);const n=await d.transform('normalize_period_dataset',{...norm,datasetRef:raw.datasetRef});const projection=await d.transform('project_dataset',{datasetRef:n.datasetRef,fields:[{column:'id',as:'id'},{column:'month',as:'p'}]});const last=await d.transform('select_period_dataset',{...pick,datasetRef:projection.datasetRef});
 const columns=[{label:'编号',value:{op:'key'}},{label:'末月',value:{op:'field',source:'s1',column:'p'}}];const draft=await d.compose({sources:[{name:'s1',datasetRef:last.datasetRef,keyColumn:'id'}],columns});let reloads=0;
 const next=await d.refresh({datasetRef:draft.datasetRef,populationRef:pop.datasetRef,populationKey:'id',checks:[],requirement:'全部对象最后发生月份',scopeEvidence:'完整对象与事件来源',expectedColumns:['编号','末月'],columnRules:[{label:'编号',definition:'原始对象编码',evidence:'原始对象字段'},{label:'末月',definition:'每个对象最后发生月份',evidence:'原始事件p字段'}]},{begin:async()=>{},reload:async recipe=>{reloads++;return collect(recipe.args.table,[{id:'001',p:'202602'}]);}});
 assert.equal(next.exportFile.rowCount,1);assert.equal(reloads,2);assert.equal((await d.restore(next.refreshedDatasetRef)).rows[0]['末月'],'2026-02');assert.equal((await d.restore(last.datasetRef)).rows[0].p,'2026-01');
});
