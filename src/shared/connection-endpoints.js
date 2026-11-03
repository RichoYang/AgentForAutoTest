// Connection metadata only. Never retain usernames, passwords or arbitrary row fields.
export function connectionEndpoints(rows = []) {
 const unique = new Map();
 for (const r of rows) {
  if (!r || typeof r.host !== 'string' || !/^[a-zA-Z0-9.-]+$/.test(r.host) || !/^[a-zA-Z0-9_-]+$/.test(r.database ?? '')) continue;
  const port = Number(r.port); if (!Number.isInteger(port) || port < 1 || port > 65535) continue;
  const source=r.connectionSource;
  const validSource=source && ['namespace','group','dataId'].every(k=>typeof source[k]==='string' && source[k].length<256) && /^[a-f0-9]{64}$/.test(source.contentHash??'');
  const value = {host:r.host,port,database:r.database,...(validSource?{connectionSource:{namespace:source.namespace,group:source.group,dataId:source.dataId,contentHash:source.contentHash}}:{})}; const key=`mysql://${value.host}:${port}/${value.database}`, old=unique.get(key);
  if (!old?.connectionSource || value.connectionSource) unique.set(key,value);
 }
 return [...unique].slice(0,20).map(([url,value])=>({...value,url}));
}
export function connectionCandidates(state, turn, projectId) {
 const ids = new Set(); let q = state.questions?.[turn.questionId];
 while(q && !ids.has(q.id)) {ids.add(q.id); q=state.questions[q.parentQuestionId];}
 const candidates = (state.jobs ?? []).filter(j=>ids.has(j.questionId) && j.chatId===turn.chatId && j.projectId===projectId
  && j.originProfile===turn.profile && j.status==='completed' && Date.now()-Date.parse(j.updatedAt)<86400000)
 .sort((a,b)=>Date.parse(a.updatedAt)-Date.parse(b.updatedAt))
 .flatMap(j=>[...(j.completedEnvironmentReads??[]),{plan:j.environmentAccess,result:j.result}]
  .filter(({plan,result})=>(!plan?.projectId||plan.projectId===projectId)&&plan?.startedAt && ['ready','partial'].includes(result?.outcome)
   && result.environmentEvidence?.scopeHash===plan.scopeHash)
  .flatMap(({plan,result})=>connectionEndpoints(result.connectionEndpoints).map(e=>({...e,tier:plan.tier,sourceJobId:j.id,sourceEnvironmentId:plan.environmentId,sourceQueryId:plan.queryId,sourceConfigHash:plan.configHash,readAt:result.environmentEvidence.readAt}))))
;
 // Keep a whole evidence record: never combine a source proof with another job's grant.
 const unique=new Map();
 for(const candidate of candidates){
  const key=JSON.stringify([candidate.tier,candidate.url]), old=unique.get(key);
  if(!old?.connectionSource || candidate.connectionSource)unique.set(key,candidate);
 }
 return [...unique.values()].slice(0,20);
}
