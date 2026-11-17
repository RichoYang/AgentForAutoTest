export const DAY=86400000;
export function retentionSettings(value={}){
 const enabled=value.enabled??true,days=value.days??30,intervalMs=value.intervalMs??3600000;
 if(typeof enabled!=='boolean'||!Number.isSafeInteger(days)||days<1||!Number.isSafeInteger(days*DAY)||!Number.isSafeInteger(intervalMs)||intervalMs<1000)throw new Error('Invalid retention settings');
 return {enabled,days,intervalMs,maxAgeMs:days*DAY};
}
export const timestamp=value=>typeof value==='number'?value:typeof value==='string'?Date.parse(value):NaN;
// Invalid legacy timestamps fail safe: date knowledge is not invented.
export function recordTime(row){const values=['updatedAt','completedAt','createdAt','at','lastSeenAt'].map(k=>timestamp(row?.[k])).filter(Number.isFinite);return values.length?Math.max(...values):NaN;}
const doneJobs=new Set(['completed','failed','blocked','cancelled']);
const doneTurns=new Set(['sent','failed','cancelled']);
function references(value,ids,found=new Set()){
 if(typeof value==='string'){if(ids.has(value))found.add(value);}
 else if(Array.isArray(value))for(const v of value)references(v,ids,found);
 else if(value&&typeof value==='object')for(const v of Object.values(value))references(v,ids,found);
 return found;
}
export function pruneState(state,{now=Date.now(),days=30,protectIds=[]}={}){
 const cutoff=now-days*DAY,old=row=>{const t=recordTime(row);return Number.isFinite(t)&&t<cutoff;};
 const jobs=state.jobs??[],turns=state.conversations??[],questions=Object.values(state.questions??{}),all=[...jobs,...turns,...questions];
 const byId=new Map(all.map(r=>[r.id,r])),allIds=new Set(byId.keys()),keep=new Set(protectIds),groups=new Map();
 const connect=(key,id)=>{if(!key)return;if(!groups.has(key))groups.set(key,[]);groups.get(key).push(id);};
 for(const row of all){connect('q:'+(row.questionId??(state.questions?.[row.id]?row.id:'')),row.id);if(row.missionId)connect('m:'+row.missionId,row.id);}
 // No question means no group, rather than joining all unscoped history together.
 groups.delete('q:');
 for(const j of jobs)if(!doneJobs.has(j.status)||j.lease||!old(j))keep.add(j.id);
 for(const j of jobs)if(j.result?.requirementSummary?.retainedSamples>0)keep.add(j.id);
 for(const d of Object.values(state.requirementDeliveries??{}))if(!d.verified)keep.add(d.jobId);
 for(const t of turns)if(!doneTurns.has(t.status)||!old(t))keep.add(t.id);
 for(const q of questions)if(!old(q))keep.add(q.id);
 const aliases=new Map([...allIds].map(id=>[id,new Set([id])]));
 for(const r of all)for(const alias of [r.messageId,...(r.notificationIds??[])].filter(Boolean)){if(!aliases.has(alias))aliases.set(alias,new Set());aliases.get(alias).add(r.id);}
 const targets=new Set(aliases.keys()),links=new Map();for(const r of all)links.set(r.id,new Set([...references(r,targets)].flatMap(key=>[...aliases.get(key)])));
 let changed=true;while(changed){changed=false;for(const id of [...keep]){const row=byId.get(id);if(!row)continue;const linked=[...links.get(id),...(groups.get('q:'+(row.questionId??(state.questions?.[row.id]?row.id:'')))??[]),...(groups.get('m:'+row.missionId)??[])];for(const other of linked)if(!keep.has(other)){keep.add(other);changed=true;}}}
 const removedJobs=jobs.filter(j=>!keep.has(j.id)),removedTurns=turns.filter(t=>!keep.has(t.id)),removedQuestions=questions.filter(q=>!keep.has(q.id));
 const removedIds=new Set([...removedJobs,...removedTurns,...removedQuestions].map(r=>r.id));
 const counts={jobs:removedJobs.length,conversations:removedTurns.length,questions:removedQuestions.length,related:0};
 state.jobs=jobs.filter(j=>keep.has(j.id));if(state.conversations)state.conversations=turns.filter(t=>keep.has(t.id));
 for(const q of removedQuestions)delete state.questions[q.id];
 for(const [k,id]of Object.entries(state.processedMessages??{}))if(removedIds.has(id)){delete state.processedMessages[k];counts.related++;}
 for(const [k,c]of Object.entries(state.cardMessages??{})){
  const bound=k.split(':')[1],linked=references(c,allIds);
  if(removedIds.has(bound)||old(c)&&![...linked].some(id=>keep.has(id))){delete state.cardMessages[k];counts.related++;}
 }
 for(const [k,d]of Object.entries(state.reportDeliveries??{}))if(removedIds.has(d.sourceJobId)||removedIds.has(d.questionId)){delete state.reportDeliveries[k];counts.related++;}
 for(const [k,d]of Object.entries(state.requirementDeliveries??{}))if(removedIds.has(d.jobId)){delete state.requirementDeliveries[k];counts.related++;}
 const liveRunners=new Set(state.jobs.map(j=>j.lease?.runnerId).filter(Boolean));
 for(const [k,r]of Object.entries(state.runners??{}))if(old(r)&&!liveRunners.has(k)){delete state.runners[k];counts.related++;}
 for(const key of ['environmentEnrollments','controlReceipts','cardCallbackChecks'])for(const [k,r]of Object.entries(state[key]??{})){
  const refs=references(r,allIds);if(old(r)&&![...refs].some(id=>keep.has(id))&&!protectIds.includes(k)){delete state[key][k];counts.related++;}
 }
 for(const key of ['adminAudit','cardCallbackAudit','cardActionPresentationFailures'])if(Array.isArray(state[key])){const n=state[key].length;state[key]=state[key].filter(r=>!old(r));counts.related+=n-state[key].length;}
 // Legacy effect/notice entries had no date. Record first observation once;
 // newly written entries receive their real timestamps in JsonStore.
 state.retention??={};const dates=state.retention.undated??={};
 for(const key of ['effects','cardActionNotices'])for(const [k,r]of Object.entries(state[key]??{})){
  const label=key+':'+k,stamp=Number.isFinite(recordTime(r))?recordTime(r):(dates[label]??=now);
  const refs=references(r,allIds);if(stamp<cutoff&&![...refs].some(id=>keep.has(id))){delete state[key][k];delete dates[label];counts.related++;}
 }
 for(const k of Object.keys(dates)){const split=k.indexOf(':');if(!Object.hasOwn(state[k.slice(0,split)]??{},k.slice(split+1)))delete dates[k];}
 state.retention.lastRun={at:new Date(now).toISOString(),cutoff:new Date(cutoff).toISOString(),days,counts,protectedOld:all.filter(r=>old(r)&&keep.has(r.id)).length};
 return {counts,cutoff,removedJobs:removedJobs.map(j=>j.id),removedTurns:removedTurns.map(t=>t.id),removedQuestions:removedQuestions.map(q=>q.id),protectedOld:state.retention.lastRun.protectedOld};
}

export function validateRetainedRequest(issuedAt,settings,known=false,now=Date.now()){
 if(!settings?.enabled||known)return;
 const at=timestamp(issuedAt);if(!Number.isFinite(at))throw Object.assign(new Error('Control request requires x-agentos-request-created-at; upgrade Runner before sending a new durable request'),{statusCode:426});
 if(at<now-settings.maxAgeMs)throw Object.assign(new Error('Control request expired under local retention; original operation will not be replayed'),{statusCode:410});
 if(at>now+300000)throw Object.assign(new Error('Control request creation time is in the future'),{statusCode:400});
}
export function expiredMessage(event,settings,now=Date.now()){
 if(!settings?.enabled)return false;let value=event.create_time??event.created_at;
 if(typeof value==='string'&&/^\d+$/.test(value))value=Number(value);
 if(typeof value==='number'&&value<100000000000)value*=1000;
 const at=timestamp(value);return Number.isFinite(at)&&at<now-settings.maxAgeMs;
}
