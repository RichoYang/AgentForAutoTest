// Only evidence already validated/persisted for this task; never a new grant.
export function availableEnvironmentEvidence(job) {
  return (job.context ?? []).flatMap(entry => {
    const r=entry.kind==='environment_result'?entry.result:null,e=r?.environmentEvidence;
    return r&&['ready','partial'].includes(r.outcome)&&!r.environmentFailure
      &&Number.isFinite(Date.parse(e?.readAt))&&e?.businessQueryCount>0&&e?.rowCount>0
      &&/^[a-f0-9]{64}$/.test(e?.resultHash??'')&&String(r.summary??'').trim()
      ?[{environmentId:e.environmentId,readAt:e.readAt,resultHash:e.resultHash,summary:r.summary}]:[];
  });
}
export function preserveAvailableEvidence(job, result) {
  const prior=availableEnvironmentEvidence(job);
  if(!prior.length)return result;
  const findings=prior.map(e=>`来源 ${e.environmentId}，取数时间 ${e.readAt}\n${e.summary}`).join('\n\n');
  return {...result,summary:`已取得的结果（保留原取数时点）\n${findings}\n\n补充来源待处理\n${result.summary??''}`,
    finalMessage:`已取得的结果（保留原取数时点）\n${findings}\n\n补充来源待处理\n${result.finalMessage??result.summary??''}`,
    availableEvidence:prior};
}
export const deferredWebsiteStates=new Set(['credential_unavailable','rejected','password_change_required','request_blocked','service_error','request_error']);
export function canReviewAlternativeSources(job, reason) {
  if(job.availableSourceReviewPolicy!=='preserve-and-review-v1'||job.status!=='awaiting_clarification'||job.taskIntent!=='analysis'||!job.continuousInvestigation
    ||job.stage!=='developer'||!job.result?.browserLoginRequired||job.environmentAccess?.kind!=='website'
    ||job.result.browserLoginState!==reason||!deferredWebsiteStates.has(reason)||!availableEnvironmentEvidence(job).length)return false;
  // Do not keep requeuing source review for the identical unresolved source.
  // This does not limit task runtime, queries or new evidence/credential retries.
  return !(job.deferredWebsiteReads??[]).some(x=>x.environmentId===job.environmentAccess.environmentId
    &&x.configHash===job.environmentAccess.configHash&&x.reason===reason);
}
