import {normalizeReportFormatReview} from './report-output-policy.js';
// Program verification and review against the user's request are separate states.
// This module never creates receipts, queries data or sends files.
const proof=file=>/^[a-f0-9]{64}$/.test(file?.verificationHash??'');
const material=new Set(['current_formula','current_scope','current_coverage','current_source','current_format','required_output']);
const kinds=new Set([...material,'historical_difference','optional_followup','review_access']);
const assessment=(job,result)=>{
 const a=result?.reportAssessment,file=job.reportFiles?.find(f=>f.id===a?.fileId&&proof(f));
 if(!file||!['deliver','deliver_partial','revise','needs_review'].includes(a.decision)||!['complete','incomplete'].includes(a.coverage)||!Array.isArray(a.issues)||a.issues.length>12||a.issues.some(i=>!kinds.has(i?.kind)||typeof i.evidence!=='string'||!i.evidence.trim()||i.evidence.length>1200))return null;
 return {a,file,blocking:a.issues.filter(i=>material.has(i.kind))};
};
export function recordReportFiles(job,files,generation){
 job.reportFiles??=[];job.reportReviews??={};
 for(const f of files){if(!job.reportFiles.some(x=>x.id===f.id))job.reportFiles.push({...structuredClone(f),sourceJobId:job.id,questionGeneration:generation??null});job.reportReviews[f.id]??={status:proof(f)?'awaiting_review':'draft',verificationHash:f.verificationHash};}
}
export function assessReportDelivery(job,result){
 if(job.tabularDelivery&&result?.outcome==='ready'&&!job.reportFiles?.some(f=>proof(f)))return {...result,outcome:'partial',reportReviewRequired:true,investigation:{...result.investigation,status:'continue',blocker:null,goals:[{id:'original-question',required:true,status:'open',evidence:'本请求需要可复用统计表文件，尚未生成核验文件'}],nextStep:'复用已保存数据整理完整表格，compose_report/finalize_report核验后交付；不因用户没写Excel而省略文件'}};

 result=normalizeReportFormatReview(job,result);
 if(job.taskIntent!=='analysis'||!['developer','owner_report'].includes(job.stage)||!job.reportReviews||!job.reportFiles?.length||result?.sourceSyncBlocked)return result;
 const reviewed=assessment(job,result);
 const requested=result?.reportAssessment?.deliverables;
 if(requested && !validDeliverables(job,requested,result.reportAssessment.fileId,result.reportInspections))return {...result,outcome:'partial',reportReviewRequired:true,environmentQuery:null,websiteQuery:null,
  investigation:{...result.investigation,status:'continue',blocker:null,nextStep:'共同交付必须显式列出每份文件及分工，包含主文件，且每份文件均已完成实际CSV及公式核验；不能以补充文件替代未交付主表。'}};
 if(reviewed&&reviewed.a.decision!=='deliver_partial'&&job.reportEvidence&&(job.reportEvidence.status!=='verified'||job.reportEvidence.binding?.fileId!==reviewed.file.id||job.reportEvidence.binding?.verificationHash!==reviewed.file.verificationHash||job.reportEvidence.calculationAudit?.status!=='passed'))return {...result,reportReviewRequired:true,outcome:'partial',environmentQuery:null,websiteQuery:null,investigation:{...result.investigation,goals:(result.investigation?.goals??[]).map(g=>g.id==='original-question'?{...g,status:'open'}:g),status:'continue',blocker:null,nextStep:'先读取与当前文件绑定的inspect_report资料，不能仅凭元数据接受文件。'}};
 const scope=job.reportEvidence?.populationAudit,scopeReview=reviewed?.a.scopeReview;
 const differences=scope?.comparisons?.filter(c=>c.onlyReferenceCount||c.onlyFileCount)??[];
 const scopeReviewed=!differences.length||(scopeReview?.populationRef===scope.selected.datasetRef&&typeof scopeReview.evidence==='string'&&scopeReview.evidence.trim()&&Array.isArray(scopeReview.comparisons)&&differences.every(c=>scopeReview.comparisons.some(r=>r.datasetRef===c.datasetRef&&r.keyColumn===c.keyColumn&&r.decision==='out_of_scope'&&typeof r.evidence==='string'&&r.evidence.trim())));
 if(reviewed&&reviewed.a.coverage==='complete'&&!reviewed.blocking.length&&!scopeReviewed)return {...result,reportReviewRequired:true,outcome:'partial',environmentQuery:null,websiteQuery:null,investigation:{...result.investigation,goals:(result.investigation?.goals??[]).map(g=>g.id==='original-question'?{...g,status:'open'}:g),status:'continue',blocker:null,nextStep:'先审阅populationAudit列出的主键范围差异；当前集合不是天然全集。按原问题修订遗漏对象，或在scopeReview中逐项提供明确排除依据，不能仅凭金额合计通过认定完整。'}};
 if(reviewed&&(reviewed.a.decision==='deliver'||reviewed.a.decision==='revise'&&reviewed.a.issues.length>0)&&reviewed.a.coverage==='complete'&&!reviewed.blocking.length){
  const root={id:'original-question',required:true,status:'verified',evidence:result.investigation?.goals?.find(g=>g.id==='original-question')?.evidence||result.summary||'原要求与已核验文件已逐项审阅'};
  return {...result,reportAssessment:{...reviewed.a,decision:'deliver'},outcome:'ready',environmentQuery:null,websiteQuery:null,environmentSetup:null,
   investigation:{...result.investigation,status:'complete',blocker:null,nextStep:'',goals:[root,...(result.investigation?.goals??[]).filter(g=>g.id!=='original-question').map(g=>({...g,required:false}))]}};
 }
 if(result?.outcome==='ready')return {...result,reportReviewRequired:true,outcome:'partial',environmentQuery:null,websiteQuery:null,
  summary:'文件已完成程序核验，仍需明确审阅是否满足原问题；不能仅凭文件存在认定交付完成。',
  investigation:{...result.investigation,goals:(result.investigation?.goals??[]).map(g=>g.id==='original-question'?{...g,status:'open'}:g),status:'continue',blocker:null,nextStep:'对照原问题填写reportAssessment；历史快照差异仅作补充，只有当前结果或原要求缺口才阻止交付。'}};
 return result;
}
export function recordReportReview(job,result){
 if(!job.reportReviews||result?.handoffGate?.passed!==true||result.sourceSyncBlocked)return;
 const reviewed=assessment(job,result);if(!reviewed)return;
 const {a,file,blocking}=reviewed,previous=job.reportReviews[file.id];
 if(a.decision==='deliver_partial'){
  const components=a.deliverables;
  // Partial overall delivery is explicit; every selected file must nevertheless
  // be complete/verified for its own scope. Missing other outputs stay open.
  if(job.taskIntent!=='analysis'||result.outcome!=='partial'||a.coverage!=='incomplete'
    ||blocking.some(i=>i.kind!=='required_output')||!validDeliverables(job,components,file.id,result.reportInspections))return;
  const inspections=result.reportInspections??[];
  const files=components.map(x=>job.reportFiles.find(f=>f.id===x.fileId));
  if(files.some(f=>!f.complete||!inspections.some(e=>e.status==='verified'&&componentScopeReviewed(e.populationAudit,a.scopeReview)&&e.binding?.fileId===f.id
    &&e.binding.verificationHash===f.verificationHash&&e.binding.sha256===f.sha256
    &&e.binding.rowCount===f.rowCount&&e.calculationAudit?.status==='passed')))return;
  job.reportPartialDeliverySet={files:files.map(f=>({fileId:f.id,verificationHash:f.verificationHash})),
    scope:components.map(x=>({fileId:x.fileId,evidence:x.evidence})),at:new Date().toISOString()};
  for(const f of files)job.reportReviews[f.id]={status:'accepted_partial',verificationHash:f.verificationHash,
    issues:structuredClone(a.issues),at:new Date().toISOString()};
  return;
 }

 if(blocking.length){job.reportReviews[file.id]={status:'revision_required',verificationHash:file.verificationHash,issues:structuredClone(blocking),at:new Date().toISOString()};return;}
 if(a.decision==='deliver'&&a.coverage==='complete'&&result.outcome==='ready'&&result.investigation?.status==='complete'&&result.investigation.goals?.some(g=>g.id==='original-question'&&g.required===true&&g.status==='verified'&&g.evidence?.trim())){
  job.reportReviews[file.id]={status:'accepted',verificationHash:file.verificationHash,issues:structuredClone(a.issues),at:new Date().toISOString(),result:structuredClone(result)};
  if(Array.isArray(a.deliverables)&&a.deliverables.length){
   const files=a.deliverables.map(x=>job.reportFiles.find(f=>f.id===x.fileId));
   const inspections=result.reportInspections??[];
   if(files.some(f=>!proof(f)||!inspections.some(e=>e.binding?.fileId===f.id&&e.binding?.verificationHash===f.verificationHash&&e.calculationAudit?.status==='passed'))){job.reportReviews[file.id]={status:'awaiting_review',verificationHash:file.verificationHash};return;}
   job.reportDeliverySet={files:files.map(f=>({fileId:f.id,verificationHash:f.verificationHash})),at:new Date().toISOString()};
   for(const component of files)job.reportReviews[component.id]={status:'accepted',verificationHash:component.verificationHash,issues:[],at:new Date().toISOString(),result:structuredClone(result)};
  }else delete job.reportDeliverySet;

 }else if(!previous)job.reportReviews[file.id]={status:'awaiting_review',verificationHash:file.verificationHash};
}
export function reportEligible(job,file){if(job.reportDeliverySet?.files?.some(f=>f.fileId===file?.id)&&job.reportDeliverySet.files.some(f=>job.reportReviews?.[f.fileId]?.status!=='accepted'||job.reportReviews[f.fileId].verificationHash!==f.verificationHash))return false;return proof(file)&&(!job.reportReviews||(['accepted','accepted_partial'].includes(job.reportReviews[file.id]?.status)&&job.reportReviews[file.id]?.verificationHash===file.verificationHash));}
export function acceptedReportResult(job){
 const f=[...(job.reportFiles??[])].reverse().find(f=>job.reportReviews?.[f.id]?.status==='accepted'&&reportEligible(job,f));
 if(!f)return null;const r=job.reportReviews[f.id].result;
 return r?.outcome==='ready'?{...structuredClone(r),environmentQuery:null,websiteQuery:null,environmentSetup:null}:null;
}

function validDeliverables(job,requested,primary,transportEvidence=[]){
 if(!Array.isArray(requested)||!requested.length||!requested.some(x=>x.fileId===primary)||new Set(requested.map(x=>x.fileId)).size!==requested.length)return false;
 const evidence=job.reportEvidence?[job.reportEvidence,...(job.reportEvidence.relatedReports??[])]:transportEvidence.filter(e=>e?.status==='verified'&&job.reportFiles?.some(f=>e.binding?.fileId===f.id&&e.binding.sha256===f.sha256&&e.binding.rowCount===f.rowCount&&(!f.sourceJobId||e.binding.sourceJobId===f.sourceJobId)));
 return requested.every(x=>typeof x.evidence==='string'&&x.evidence.trim()&&job.reportFiles?.some(f=>f.id===x.fileId&&proof(f)&&evidence.some(e=>e?.status==='verified'&&e.binding?.fileId===f.id&&e.binding?.verificationHash===f.verificationHash&&e.calculationAudit?.status==='passed')));
}

function componentScopeReviewed(scope,review){
 if(!scope?.selected?.datasetRef||!Array.isArray(scope.comparisons))return false;
 const differences=scope.comparisons.filter(c=>c.onlyReferenceCount||c.onlyFileCount);
 return !differences.length||review?.populationRef===scope.selected.datasetRef&&review.evidence?.trim()
  &&Array.isArray(review.comparisons)&&differences.every(c=>review.comparisons.some(r=>r.datasetRef===c.datasetRef
    &&r.keyColumn===c.keyColumn&&r.decision==='out_of_scope'&&r.evidence?.trim()));
}
