import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm,mkdir,writeFile} from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {JsonStore} from '../src/shared/store.js';
import {assessInvestigation} from '../src/shared/investigation-review.js';
import {pollEnrollments} from '../src/control-plane/environment-enrollment.js';
import {conversationCard} from '../src/control-plane/message-cards.js';
import {conversationTerminalMention,jobTerminalMention} from '../src/control-plane/requester-mention.js';
async function fixture(t,automaticCleanup=true){const dir=await mkdtemp(path.join(os.tmpdir(),'agentos-setup-chain-'));if(automaticCleanup)t.after(()=>rm(dir,{recursive:true,force:true}));const store=new JsonStore(path.join(dir,'state.json'));
 await store.transact(s=>{s.conversations=[{id:'root',messageId:'message',questionId:'q',chatId:'group',senderId:'ou_member',profile:'owner',role:'owner_intake',chatType:'group',status:'sent',attachments:[]}];s.questions={q:{id:'q',rootTurnId:'root',latestTurnId:'root',chatId:'group',projectId:'p',generation:1}};});
 await store.createJob({projectId:'p',chatId:'group',questionId:'q',senderId:'ou_member',originProfile:'owner',taskIntent:'analysis',workflow:'analysis_review',stage:'developer',instruction:'Check original amounts',context:[{stage:'developer',result:{summary:'Source already checked'}}],attachments:[{id:'image',path:'/synthetic'}]});
 const job=await store.leaseNext('r');return{dir,store,job};}
const result=()=>({outcome:'needs_clarification',finalMessage:'Need UAT connection',environmentSetup:{kind:'mysql',tier:'uat',url:'mysql://db.example:3306/uat_db'}});
test('source setup handoff is atomic and retains original identity, evidence and attachments',async t=>{
 const {store,job}=await fixture(t);const event={type:'completed',leaseId:job.lease.id,runnerId:'r',result:result()};
 const out=await store.appendEvent(job.id,event,{setupInvestigation:true});const s=await store.read(),turn=s.conversations.at(-1);
 assert.equal(out.job.status,'completed');assert.equal(turn.status,'decided');assert.equal(turn.senderId,'ou_member');assert.equal(turn.profile,'owner');assert.equal(turn.setupPending,true);assert.equal(turn.decision.action,'request_environment_setup');assert.equal(turn.questionId,'q');assert.equal(turn.investigationContext.length,2);assert.equal(turn.resumeAttachments[0].id,'image');assert.equal(s.questions.q.latestTurnId,turn.id);
 assert.equal(jobTerminalMention(out.job),null);await assert.rejects(store.appendEvent(job.id,event,{setupInvestigation:true}));assert.equal((await store.read()).conversations.length,2);
 assert.equal(conversationCard({...turn,status:'sent',response:'Please confirm'}).header.template,'orange');assert.equal(conversationTerminalMention(turn),null);
});
test('unknown URL stays resumable and recoverable missing input is not a blocked result',async t=>{
 const {store,job}=await fixture(t);const r=result();r.environmentSetup={kind:'nacos',tier:'uat',url:''};
 const out=await store.appendEvent(job.id,{type:'completed',result:r});assert.equal(out.job.status,'awaiting_clarification');assert.equal((await store.read()).conversations.length,1);
 const resumed=await store.resumeClarification(job.id,{instruction:'https://nacos.example/nacos',senderId:'ou_member'});assert.equal(resumed.status,'queued');assert.equal(resumed.context.at(-1).result.environmentSetup.kind,'nacos');
 assert.equal(assessInvestigation(job,{...r,outcome:'blocked'}).outcome,'needs_clarification');
 assert.equal(assessInvestigation(job,{outcome:'blocked',investigation:{status:'wait',blocker:{kind:'user_input',needed:'URL'}}}).outcome,'needs_clarification');
});
test('completed enrollment resumes original requester without borrowing approval and keeps source evidence',async t=>{
 const {store,job,dir}=await fixture(t);await store.appendEvent(job.id,{type:'completed',result:result()},{setupInvestigation:true});
 const turn=(await store.read()).conversations.at(-1),id='ENR-test';
 await store.transact(s=>{s.conversations.at(-1).status='sent';s.environmentEnrollments={[id]:{id,turnId:turn.id,questionId:'q',projectId:'p',kind:'mysql',tier:'uat',status:'opening',createdAt:new Date().toISOString(),approver:{senderId:'ou_admin'}}};});
 const d=path.join(dir,'environment-enrollments',id);await mkdir(d,{recursive:true});await writeFile(path.join(d,'status.json'),JSON.stringify({status:'complete'}));
 await pollEnrollments({store,config:{dataDir:dir}},async()=>({environments:{'enr-test':{projectId:'p',tier:'uat',kind:'mysql',queries:{investigate:{mode:'investigate'}}}}}));
 const after=(await store.read()).conversations.at(-1);assert.equal(after.status,'decided');assert.equal(after.setupPending,false);assert.equal(after.senderId,'ou_member');assert.equal(after.decision.action,'create_task');assert.equal(after.decision.environmentQuery.environmentId,'enr-test');assert.equal(after.investigationContext.length,2);assert.equal(after.decision.environmentSetup,null);
 await pollEnrollments({store,config:{dataDir:dir}});assert.equal((await store.read()).conversations.length,2);
});
test('HTTP source setup routes once without opening a connection and rejects credentials',async t=>{
 const {createControlPlane}=await import('../src/control-plane/server.js');
 const {dir,store,job}=await fixture(t,false);
 let app;
 t.after(async()=>{await app?.conversations.stop();if(app?.server.listening){app.server.closeAllConnections();await new Promise(r=>app.server.close(r));}await rm(dir,{recursive:true,force:true});});
 app=await createControlPlane({dataDir:dir,storeFile:store.file,conversationFile:path.join(dir,'conversations.json'),memoryFile:path.join(dir,'memory.json'),runnerToken:'r',projects:{projects:{p:{repoPath:dir}},chatProjectMap:{group:'p'}},agents:{agents:{developer:{profile:'dev'}}},feishuClient:{enabled:false},conversationOptions:{enabled:false}});
 await new Promise(r=>app.server.listen(0,'127.0.0.1',r));
 const endpoint=`http://127.0.0.1:${app.server.address().port}/api/v1/jobs/${job.id}/events`;
 const send=r=>fetch(endpoint,{method:'POST',headers:{authorization:'Bearer r','content-type':'application/json'},body:JSON.stringify({type:'completed',runnerId:'r',leaseId:job.lease.id,result:r})});
 const bad=result();bad.environmentSetup.url='mysql://user:secret@db.example/uat_db';assert.notEqual((await send(bad)).status,200);
 assert.equal((await send(result())).status,200);assert.equal((await send(result())).status,409);
 const s=await store.read();assert.equal(s.conversations.length,2);assert.equal(s.environmentEnrollments,undefined);
});
test('setup apply reuses a known connector and discovers provenance before enrolling a bare database',async t=>{
 const {ConversationService}=await import('../src/control-plane/conversations.js');
 for(const kind of ['nacos','mysql']) {
  const {store,job,dir}=await fixture(t);const r=result();if(kind==='nacos')r.environmentSetup={kind:'nacos',tier:'uat',url:'https://nacos.example/nacos'};
  await store.appendEvent(job.id,{type:'completed',result:r},{setupInvestigation:true});const turn=(await store.read()).conversations.at(-1);
  const previous=process.env.AGENTOS_ENVIRONMENTS_FILE;process.env.AGENTOS_ENVIRONMENTS_FILE=path.join(dir,'environments.json');
  try {
   await writeFile(process.env.AGENTOS_ENVIRONMENTS_FILE,JSON.stringify({version:1,environments:{uat:{kind:'nacos',projectId:'p',tier:'uat',baseUrl:'https://nacos.example/nacos',credentialRef:'synthetic',membersRead:false,ownerOpenIdsByProfile:{owner:['ou_admin']},queries:{investigate:{mode:'investigate',reviewed:true,description:'Read configuration',namespaces:['uat'],maxRows:20,timeoutMs:1000,parameters:[{name:'purpose',type:'string',maxLength:200}]}}}}}));
   const context={store,projects:{projects:{p:{}},chatProjectMap:{group:'p'}},agents:{agents:{developer:{profile:'dev'}}}};
   const service={context,update:async(id,patch)=>store.transact(s=>Object.assign(s.conversations.find(x=>x.id===id),patch))};
   const out=await ConversationService.prototype.apply.call(service,turn),created=await store.getJob(out.jobId);
   assert.equal(created.senderId,'ou_member');assert.equal(created.questionId,'q');assert.equal(created.status,'queued');assert.equal(created.environmentAccess.environmentId,'uat');assert.equal(created.environmentAccess.approvedBy,'policy:read-only');assert.equal(created.context.length,2);assert.equal(created.attachments[0].id,'image');
   assert.equal(Boolean(created.connectionEnrollmentPending),kind==='mysql');assert.equal((await store.read()).environmentEnrollments,undefined);
   if(kind==='mysql')assert.equal((await store.read()).conversations.at(-1).setupTargetUrl,'mysql://db.example:3306/uat_db');
  } finally {if(previous===undefined)delete process.env.AGENTOS_ENVIRONMENTS_FILE;else process.env.AGENTOS_ENVIRONMENTS_FILE=previous;}
 }
});
