import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp,mkdir,writeFile,readFile,rm,symlink,stat } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { TeamKnowledgeService,shareableKnowledge,knowledgeSettings } from '../src/control-plane/team-knowledge.js';
import { KnowledgeStore } from '../src/control-plane/knowledge-store.js';
import { ConversationService } from '../src/control-plane/conversations.js';
import { validateDecision } from '../src/control-plane/codex-conversation.js';
const proposal={shareable:true,roleIndependent:true,containsCaseData:false,kind:'guide',title:'如何创建搭赠方案',aliases:['搭赠在哪里新建','怎么申请搭赠'],answer:'进入方案管理，选择方案创建，再选择随单搭赠。填写基本信息后可先保存，需要发起审批时再提交。',existingId:'',dependencies:[{repository:'.',path:'guide.js'}]};
const actor={senderId:'B',chatId:'g',profile:'owner',chatType:'group',content:'想做搭赠活动，要怎么操作',attachments:[]};
const match=id=>({id,sameIntent:true,currentData:false,correction:false,roleIndependent:true,environment:'prd'});
const decision=id=>({reply:'模型另一种说法',action:'reply',intent:'none',instruction:'',jobId:'',projectId:'',attachmentIds:[],requiresSourceInspection:false,environmentQuery:null,environmentSetup:null,knowledgeMatch:match(id)});
async function setup(t){
  const dir=await mkdtemp(path.join(os.tmpdir(),'agentos-knowledge-test-'));await writeFile(path.join(dir,'guide.js'),'export const entry="create";');
  const team={id:'team',projectId:'p',chatIds:['g'],profiles:['owner'],membersByProfile:{owner:['A','B']},freshnessMs:86400000};
  const context={config:{dataDir:path.join(dir,'data')},projects:{chatProjectMap:{g:'p'},projects:{p:{repoPath:dir,analysisRepositories:[{path:'.',branch:'main'}]}}}};
  let now=Date.now(),calls=0;
  const options={settings:{enabled:true,teams:[team]},now:()=>now,model:{extract:async()=>{calls++;return structuredClone(proposal);},close:async()=>{}}};
  const service=new TeamKnowledgeService(context,options);context.knowledge=service;
  const job={id:'job1',chatId:'g',senderId:'A',originProfile:'owner',projectId:'p',taskIntent:'analysis',status:'completed',createdAt:new Date(now).toISOString(),updatedAt:new Date(now).toISOString(),sourceEnvironment:'prd',
    instruction:'创建搭赠方案',result:{outcome:'ready',handoffGate:{passed:true},verifiedArtifacts:[{path:'report.md'}],finalMessage:'已核实创建流程，来源guide.js',workspace:dir,
      sourceSync:{environment:'prd',repositories:[{path:'.',branch:'main',commit:'a'}]}}};
  t.after(async()=>{await service.close();await rm(dir,{recursive:true,force:true});});
  return {dir,team,context,service,job,options,advance:ms=>now+=ms,calls:()=>calls};
}
async function seeded(t){const x=await setup(t);await x.service.ingest(x.job);const input={teamKnowledge:await x.service.candidates(actor,'p'),jobs:[]};return {...x,input,id:input.teamKnowledge.candidates[0].id};}

test('A verified guide becomes B paraphrase candidate; canonical reply is consistent and survives restart',async t=>{
  const x=await seeded(t);assert.equal(x.input.teamKnowledge.candidates[0].directReusable,true);
  const reply=await x.service.reuse(actor,'p',decision(x.id),x.input);assert.ok(reply.reply.startsWith(proposal.answer));assert.equal(reply.knowledgeReceipt.version,1);
  const A=await x.service.reuse({...actor,senderId:'A',content:'搭赠在哪建'},'p',decision(x.id),x.input);assert.equal(reply.reply,A.reply);
  const store=new KnowledgeStore(x.context.config.dataDir);await store.open();assert.equal(store.get(x.id).answer,proposal.answer);store.close();
  assert.equal((await (await import('../src/shared/private-files.js')).privatePathProof(path.join(x.context.config.dataDir,'knowledge','knowledge.sqlite'))).private,true);
  await x.service.ingest(x.job);assert.equal(x.calls(),1);
});
test('scope filters before retrieval: other user, group, profile or project cannot see answer',async t=>{
  const x=await seeded(t);for(const changed of [{senderId:'C'},{chatId:'other'},{profile:'dev'},{chatType:'p2p'}])assert.equal((await x.service.candidates({...actor,...changed},'p')).candidates.length,0);
  assert.equal((await x.service.candidates(actor,'other')).candidates.length,0);
  x.team.membersByProfile.owner=['A'];assert.equal((await x.service.candidates(actor,'p')).candidates.length,0);
});
test('expiry or dependency change after retrieval forces read-only recheck',async t=>{
  const x=await seeded(t);await writeFile(path.join(x.dir,'guide.js'),'changed');
  const result=await x.service.reuse(actor,'p',decision(x.id),x.input);assert.equal(result.action,'create_task');assert.equal(result.intent,'analysis');
  await writeFile(path.join(x.dir,'guide.js'),'export const entry="create";');x.advance(86400001);
  assert.equal((await x.service.candidates(actor,'p')).candidates[0].reason,'expired');
});
test('actual configured deployment marker changes even with unchanged source',async t=>{
  const x=await setup(t);const file=path.join(x.dir,'revision.txt');await writeFile(file,'release1');x.team.revisionFiles={prd:file};x.job.updatedAt=new Date(Math.ceil((await stat(file)).mtimeMs)+1).toISOString();
  await x.service.ingest(x.job);const first=await x.service.candidates(actor,'p');assert.equal(first.candidates[0].reason,'source_guidance_only');
  await writeFile(file,'release2');assert.equal((await x.service.candidates(actor,'p')).candidates[0].reason,'deployment_changed');
});
test('live data, role difference and wrong environment cannot directly reuse',async t=>{
  const x=await seeded(t);for(const change of [{currentData:true},{roleIndependent:false},{environment:'uat'}]){
    const d=decision(x.id);Object.assign(d.knowledgeMatch,change);assert.equal((await x.service.reuse(actor,'p',d,x.input)).action,'create_task');
  }
});
test('screenshots and ongoing jobs cannot be silently replaced by knowledge',async t=>{
  const x=await seeded(t);assert.equal((await x.service.candidates({...actor,attachments:[{id:'image'}]},'p')).candidates.length,1);
  const input={...x.input,jobs:[{status:'awaiting_clarification'}]};assert.equal((await x.service.reuse(actor,'p',decision(x.id),input)).knowledgeMatch,null);
  const d={...decision(x.id),action:'create_task',intent:'implementation',instruction:'修改代码'};
  assert.equal((await x.service.reuse(actor,'p',d,x.input)).action,'create_task');
});
test('correction suspends knowledge and creates recheck; resolution never resets evidence time',async t=>{
  const x=await seeded(t),d=decision(x.id);d.knowledgeMatch.correction=true;
  assert.equal((await x.service.reuse(actor,'p',d,x.input)).action,'create_task');assert.equal(x.service.store.get(x.id).status,'suspended');
  assert.equal((await x.service.candidates(actor,'p')).candidates.length,0);const time=x.service.store.get(x.id).verifiedAt;
  x.service.store.resolve(x.id);assert.equal(x.service.store.get(x.id).verifiedAt,time);
});
test('conflicting answers under same dependencies suspend both; changed version can supersede',async t=>{
  const x=await seeded(t);x.options.model.extract=async()=>({...proposal,existingId:x.id,answer:'另一种不同步骤说明，内容未经冲突确认。'});
  await x.service.ingest({...x.job,id:'job2',updatedAt:new Date(Date.parse(x.job.updatedAt)+1).toISOString()});assert.equal(x.service.store.get(x.id).status,'conflict');
  const candidates=(await x.service.candidates(actor,'p')).candidates;assert.equal(candidates.length,2);assert.ok(candidates.every(x=>!x.directReusable));
});
test('private case details, failed gate, partial or intermediate results are never shared',async t=>{
  const x=await setup(t);for(const modified of [{nextJobId:'next'},{result:{...x.job.result,outcome:'partial'}},{result:{...x.job.result,handoffGate:{passed:false}}},{environmentAccess:{}}])await x.service.ingest({...x.job,...modified});
  assert.equal(x.calls(),0);
  for(const answer of ['单据 HD-20261014-0001 的审批状态。','该客户本月金额为123元。','用户 ou_secret 的资料。','账号 password=abc。'])assert.equal(shareableKnowledge({...proposal,answer}),false);
  x.options.model.extract=async()=>({...proposal,containsCaseData:true});await x.service.ingest(x.job);assert.equal(x.service.store.size(),0);
});
test('symlink dependency escape fails closed; changed policy during extraction aborts publication',async t=>{
  const x=await setup(t);await symlink(os.tmpdir(),path.join(x.dir,'outside'));
  await assert.rejects(x.service.digest(x.dir,'outside/file'),'');
  await assert.rejects(x.service.digest(x.dir,'../file'));await assert.rejects(x.service.digest(x.dir,'.env'));
  x.options.model.extract=async()=>{x.team.membersByProfile.owner=['B'];return proposal;};await x.service.ingest(x.job);assert.equal(x.service.store.size(),0);
});
test('cache failure falls back to ordinary investigation and never changes original task',async t=>{
  const x=await setup(t);x.service.store.open=async()=>{throw new Error('storage unavailable');};
  assert.equal((await x.service.candidates(actor,'p')).reason,'knowledge_unavailable');
  assert.equal((await x.service.reuse(actor,'p',decision('fake'),{teamKnowledge:{candidates:[{id:'fake'}]}})).action,'create_task');
});
test('main conversation AI receives bounded shared candidates and performs semantic choice without extra model',async t=>{
  const x=await seeded(t),state={conversations:[],jobs:[]};x.context.store={read:async()=>state};
  const conversations=new ConversationService(x.context,{decide:async()=>decision(x.id)});
  const input=await conversations.buildInput({...actor,id:'turn',attachments:[],messageId:'m'});
  assert.equal(input.teamKnowledge.candidates[0].id,x.id);assert.ok(JSON.stringify(input.teamKnowledge).length<12000);
  const d=validateDecision(decision(x.id));assert.equal((await x.service.reuse(actor,'p',d,input)).knowledgeReceipt.id,x.id);
  await conversations.stop();
});
test('invalid semantic decisions and ambiguous sharing scopes are rejected',()=>{
  assert.throws(()=>validateDecision({...decision('id'),knowledgeMatch:{id:'id'}}),/knowledge match/);
  assert.throws(()=>knowledgeSettings({enabled:true,teams:[{id:'a',projectId:'p',chatIds:['g'],profiles:['x']},{id:'b',projectId:'q',chatIds:['g'],profiles:['x']}]}),/Ambiguous/);
});
test('old delayed extraction cannot replace newer knowledge, and startup never replays undated personal history',async t=>{
  const x=await seeded(t);x.context.store={read:async()=>({jobs:[x.job]})};await x.service.recover();await x.service.queue;assert.equal(x.calls(),1);
  x.options.model.extract=async()=>({...proposal,existingId:x.id,answer:'旧版本迟到的说明内容。'});
  await x.service.ingest({...x.job,id:'older',updatedAt:new Date(Date.parse(x.job.updatedAt)-1000).toISOString()});
  assert.equal(x.service.store.get(x.id).status,'active');assert.equal(x.service.store.processed('older'),'older_evidence');
});
test('Runner completion publishes asynchronously; local knowledge admin enforces session and same-origin mutations',async t=>{
  const x=await setup(t);const {createControlPlane}=await import('../src/control-plane/server.js');
  const app=await createControlPlane({dataDir:x.context.config.dataDir,storeFile:path.join(x.dir,'state.json'),projects:x.context.projects,
    agents:{agents:{developer:{profile:'owner'}}},knowledgeService:x.service,adminToken:'admin',runnerToken:'runner',conversationResponder:async()=>decision(''),
    feishuClient:{send:async()=>({}),reply:async()=>({})},websiteBrowser:{release:async()=>{},close:async()=>{}}});
  await new Promise(r=>app.server.listen(0,'127.0.0.1',r));t.after(async()=>{await new Promise(r=>app.server.close(r));await app.conversations.stop();await x.service.queue;});
  const base=`http://127.0.0.1:${app.server.address().port}`;
  const {job}=await app.store.createJob({chatId:'g',projectId:'p',senderId:'A',originProfile:'owner',agentProfile:'owner',stage:'developer',workflow:'single_developer',taskIntent:'analysis',instruction:'创建搭赠方案',sourceEnvironment:'prd'});
  const lease=await app.store.leaseNext('runner');
  const completed=await fetch(`${base}/api/v1/jobs/${job.id}/events`,{method:'POST',headers:{authorization:'Bearer runner','content-type':'application/json'},body:JSON.stringify({type:'completed',leaseId:lease.lease.id,runnerId:'runner',result:x.job.result})});
  assert.equal(completed.status,200);await x.service.queue;assert.equal(x.service.store.size(),1);
  assert.equal((await fetch(base+'/api/v1/admin/knowledge')).status,401);
  const page=await fetch(base+'/admin');assert.match(await page.text(),/团队知识/);const cookie=page.headers.get('set-cookie').split(';')[0];
  const overview=await fetch(base+'/api/v1/admin/knowledge',{headers:{cookie}});assert.equal(overview.status,200);const body=await overview.json();const id=body.entries[0].id;assert.equal(body.entries[0].title,proposal.title);
  assert.equal((await fetch(`${base}/api/v1/admin/knowledge/${id}/suspend`,{method:'POST',headers:{cookie}})).status,401);
  assert.equal((await fetch(`${base}/api/v1/admin/knowledge/${id}/suspend`,{method:'POST',headers:{cookie,origin:base,'x-agentos-admin':'1'}})).status,200);
  assert.equal(x.service.store.get(id).status,'suspended');assert.equal((await app.store.read()).adminAudit.at(-1).action,'knowledge_suspend');
});
test('validated source-backed partial guide enters knowledge with unverified live scope explicitly preserved',async t=>{
 const x=await setup(t);const {assessInvestigation}=await import('../src/shared/investigation-review.js');
 const job={...x.job,stage:'developer',originalQuestion:'prd环境搭赠方案在哪里创建？',result:{...x.job.result,outcome:'ready',verifiedArtifacts:[{kind:'code',path:'guide.js'}],
   investigation:{status:'wait',goals:[{id:'original-question',required:true,status:'open',evidence:'源码入口已确认，线上页面为空'}],blocker:{kind:'unavailable',needed:'页面恢复',evidence:'页面为空'}},
   handoff:{artifacts:[{kind:'code',path:'guide.js'}],checks:[{id:'original-question',required:true,status:'failed',evidence:'页面未实测'},{id:'source-route',required:false,status:'passed',evidence:'源码路径确认'}],risks:['线上账号权限未核实'],returnTo:'none'}}};
 job.result=assessInvestigation(job,job.result);assert.equal(job.result.outcome,'partial');
 await x.service.ingest(job);const input={teamKnowledge:await x.service.candidates(actor,'p')};assert.equal(input.teamKnowledge.candidates.length,1);
 const candidate=input.teamKnowledge.candidates[0];assert.equal(candidate.evidenceScope,'source_guidance_only');
 const reused=await x.service.reuse(actor,'p',decision(candidate.id),input);assert.match(reused.reply,/线上页面、当前账号权限和提交后的结果尚未实测/);
 const live=decision(candidate.id);live.knowledgeMatch.currentData=true;assert.equal((await x.service.reuse(actor,'p',live,input)).action,'create_task');
});
test('same facts with different prose do not conflict; additional verified steps extend the shared guide',async t=>{
 const x=await seeded(t);x.options.model.compare=async()=>({relation:'equivalent',reason:'同一入口的改写'});
 x.options.model.extract=async()=>({...proposal,existingId:x.id,answer:'从方案管理的方案创建中选择随单搭赠即可。'});
 await x.service.ingest({...x.job,id:'paraphrase',updatedAt:new Date(Date.parse(x.job.updatedAt)+1).toISOString()});
 let latest=x.service.store.latest('team','prd',x.service.store.get(x.id).topic);assert.equal(latest.status,'active');assert.equal(latest.answer,proposal.answer);
 x.options.model.compare=async()=>({relation:'extension',reason:'补充填写步骤，没有矛盾'});
 x.options.model.extract=async()=>({...proposal,existingId:latest.id,answer:proposal.answer+'提交前确认填写内容。'});
 await x.service.ingest({...x.job,id:'extended',updatedAt:new Date(Date.parse(x.job.updatedAt)+2).toISOString()});
 latest=x.service.store.latest('team','prd',latest.topic);assert.equal(latest.status,'active');assert.match(latest.answer,/提交前确认/);
});
test('real fact contradiction stays conflict; old suspended topic cannot reactivate automatically',async t=>{
 const x=await seeded(t);x.options.model.compare=async()=>({relation:'contradiction',reason:'入口相互矛盾'});x.options.model.extract=async()=>({...proposal,existingId:x.id,answer:'入口在另一个业务菜单，不在方案管理。'});
 await x.service.ingest({...x.job,id:'wrong',updatedAt:new Date(Date.parse(x.job.updatedAt)+1).toISOString()});assert.equal(x.service.store.get(x.id).status,'conflict');
});
test('a newly verified rule can supersede old contradiction after relevant dependency evidence changes',async t=>{
 const x=await seeded(t);x.options.model.compare=async()=>({relation:'contradiction',reason:'新代码改了入口'});
 x.options.model.extract=async()=>({...proposal,existingId:x.id,answer:'新版入口改为活动管理中的方案创建。'});
 await writeFile(path.join(x.dir,'guide.js'),'export const entry="new-route";');
 await x.service.ingest({...x.job,id:'new-rule',updatedAt:new Date(Date.parse(x.job.updatedAt)+1).toISOString()});
 const latest=x.service.store.latest('team','prd',x.service.store.get(x.id).topic);assert.equal(latest.status,'active');assert.equal(x.service.store.get(x.id).status,'superseded');
});
test('legacy false conflicts upgrade environment proof without renewing verification time or reviving suspensions',async t=>{
 const x=await seeded(t);const workspace=path.join(x.dir,'snapshots','run','workspace');await mkdir(workspace,{recursive:true});await writeFile(path.join(workspace,'guide.js'),'export const entry="create";');
 x.context.projects.projects.p.analysisSnapshotRoot=path.join(x.dir,'snapshots');
 x.options.model.extract=async()=>({...proposal,existingId:x.id,answer:'另一个同义表述：在方案管理中创建随单搭赠。'});
 const later={...x.job,id:'second',updatedAt:new Date(Date.parse(x.job.updatedAt)+1).toISOString()};await x.service.ingest(later);
 const second=x.service.store.latest('team','prd',x.service.store.get(x.id).topic);assert.equal(second.status,'conflict');const before=second.verifiedAt;
 const jobs=[x.job,later].map(j=>({...j,result:{...j.result,sourceSync:{...j.result.sourceSync,workspace}}}));x.context.store={read:async()=>({jobs})};
 x.service.source={bindings:async()=>[{repository:'.',branch:'main',commit:'a'.repeat(40),originHash:'test'}],current:async()=>({same:true})};
 x.options.model.compare=async()=>({relation:'equivalent',reason:'同义'});await x.service.reconcile();
 assert.equal(x.service.store.get(second.id).status,'active');assert.equal(x.service.store.get(second.id).verifiedAt,before);assert.equal(x.service.store.get(second.id).sourceBindings.length,1);
 x.service.store.suspend(second.id);await x.service.reconcile();assert.equal(x.service.store.get(second.id).status,'suspended');
});

test('context screenshots retrieve and reuse generic knowledge only after all actually shown images are reviewed',async t=>{
 const x=await seeded(t),image={id:'pic',type:'image',path:'/fixture/page.png'},turn={...actor,attachments:[image]};
 const input={teamKnowledge:await x.service.candidates(turn,'p'),jobs:[],attachments:[image]};assert.equal(input.teamKnowledge.candidates.length,1);
 const d=decision(x.id);d.knowledgeMatch.attachmentReview={reviewedIds:['pic'],impact:'context_only',reason:'截图仅用于定位同一功能，用户询问通用操作规则'};
 const reply=await x.service.reuse(turn,'p',d,input);assert.equal(reply.action,'reply');assert.ok(reply.knowledgeReceipt.attachmentScope);assert.ok(reply.reply.startsWith(proposal.answer));
 // apply() rechecks validity without resending images; only the unchanged program-generated binding is accepted.
 assert.equal((await x.service.reuse(turn,'p',reply,{teamKnowledge:input.teamKnowledge,jobs:[]})).action,'reply');
 const changed={...turn,attachments:[{...image,path:'/fixture/changed.png'}]};assert.equal((await x.service.reuse(changed,'p',reply,{teamKnowledge:input.teamKnowledge,jobs:[]})).action,'create_task');
});
test('image review cannot omit an image, claim an unseen image, or bless unread files',async t=>{
 const x=await seeded(t),image={id:'pic',type:'image',path:'/fixture/page.png'};
 for(const sample of [
  {attachments:[image],review:null,shown:[image]},
  {attachments:[image],review:{reviewedIds:[],impact:'context_only',reason:'incomplete'},shown:[image]},
  {attachments:[image],review:{reviewedIds:['pic'],impact:'context_only',reason:'not shown'},shown:[]},
  {attachments:[image,{...image,id:'two'}],review:{reviewedIds:['pic'],impact:'context_only',reason:'omitted'},shown:[image]},
  {attachments:[{id:'doc',type:'file',path:'/fixture/file.pdf'}],review:{reviewedIds:['doc'],impact:'context_only',reason:'not an image'},shown:[]},
 ]){
  const d=decision(x.id);d.knowledgeMatch.attachmentReview=sample.review;
  const r=await x.service.reuse({...actor,attachments:sample.attachments},'p',d,{...x.input,attachments:sample.shown});assert.equal(r.action,'create_task');assert.deepEqual(r.attachmentIds,sample.attachments.map(a=>a.id));
 }
});
test('mixed live and knowledge questions pass reusable facts to a targeted investigation and retain the screenshot',async t=>{
 const x=await seeded(t),image={id:'pic',type:'image',path:'/fixture/page.png'},turn={...actor,attachments:[image],content:'说明创建规则，并核实这张单当前为什么不能提交'};
 for(const impact of ['requires_live','different_scope','uncertain']){
  const d=decision(x.id);d.knowledgeMatch.attachmentReview={reviewedIds:['pic'],impact,reason:'需要核对本次上下文'};d.knowledgeMatch.currentData=impact==='requires_live';
  const r=await x.service.reuse(turn,'p',d,{...x.input,attachments:[image]});assert.equal(r.action,'create_task');assert.equal(r.knowledgeReceipt,null);assert.equal(r.knowledgeHint.id,impact==='different_scope'?null:x.id);assert.equal(r.instruction.includes(proposal.answer),impact!=='different_scope');assert.ok(r.instruction.includes(turn.content));assert.deepEqual(r.attachmentIds,['pic']);
 }
 const d={...decision(x.id),action:'create_task',intent:'analysis',requiresSourceInspection:true};d.knowledgeMatch.currentData=true;
 const r=await x.service.reuse(actor,'p',d,x.input);assert.equal(r.action,'create_task');assert.ok(r.instruction.includes(proposal.answer));
});
test('attachment review is typed and rejects invalid impacts and duplicate review IDs',()=>{
 for(const review of [{reviewedIds:['x'],impact:'trust_everything',reason:'bad'},{reviewedIds:['x','x'],impact:'context_only',reason:'bad'},{reviewedIds:['x'],impact:'context_only',reason:''}]){
  const d=decision('id');d.knowledgeMatch.attachmentReview=review;assert.throws(()=>validateDecision(d),/attachment review/);
 }
 const d=decision('id');d.knowledgeMatch.attachmentReview={reviewedIds:['x'],impact:'context_only',reason:'用于定位同一页面'};assert.doesNotThrow(()=>validateDecision(d));
});
