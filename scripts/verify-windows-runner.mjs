// Explicit local-only acceptance. Uses actual control plane, AgentRunner, task worker,
// configured Codex model and a newly owned Git fixture. Never addresses specialist instances.
import {mkdir,writeFile,readFile,readdir} from 'node:fs/promises';import path from 'node:path';
import {fork,execFile} from 'node:child_process';import {promisify} from 'node:util';import {once} from 'node:events';
import {fileURLToPath} from 'node:url';import {createHash} from 'node:crypto';
import {createControlPlane} from '../src/control-plane/server.js';
import {AgentRunner} from '../src/runner/index.js';import {recoverLocalExecutions} from '../src/runner/local-executions.js';
import {loadCodexRuntimeSettings} from '../src/shared/codex-runtime.js';
if(!process.argv[2]||process.argv[3]&&!['owner'].includes(process.argv[3]))throw Error('Usage: node scripts/verify-windows-runner.mjs <fresh-isolated-directory>');
const command=promisify(execFile),self=fileURLToPath(import.meta.url),root=path.resolve(process.argv[2]);
const save=(name,value)=>writeFile(path.join(root,name),JSON.stringify(value,null,2));
if(process.argv[3]==='owner'){
 const {config}=JSON.parse(await readFile(path.join(root,'input.json')));const runner=new AgentRunner(config);await runner.heartbeat();const job=await runner.lease();if(!job)throw Error('No isolated job leased');process.send?.({leased:job.id});await runner.run(job);process.send?.({finished:true});process.disconnect?.();
}else{
 if(process.platform!=='win32')throw Error('This acceptance needs actual Windows');await mkdir(root,{recursive:true});if((await readdir(root)).length)throw Error('Use a fresh isolated directory; existing evidence is never overwritten');
 const work=path.join(root,'personal'),repo=path.join(work,'inventory'),origin=path.join(root,'origin.git');await mkdir(repo,{recursive:true});
 await writeFile(path.join(repo,'AGENTS.md'),'# Read-only isolated source investigation\nRead source.mjs and RULES.md. No business service or credentials exist in this fixture. Do not modify files.\n');
 await writeFile(path.join(repo,'source.mjs'),'export function available(stock){ if(stock.quantity == null || stock.reserved == null) return null; return stock.quantity-stock.reserved; }\nexport function visible(stock,tenant){ return stock.tenant === tenant && !stock.archived; }\n');
 await writeFile(path.join(repo,'RULES.md'),'库存可用量由完整库存数减已预留数。缺失任一原值时未知，不能补零。租户必须精确相同且已归档记录不可见。此仓仅给源码定义，不包含实时库存值；实时值须重新查询授权环境。\n');
 const git=(...args)=>command('git',args,{windowsHide:true});await git('init','--bare',origin);await git('-C',repo,'init','-b','main');await git('-C',repo,'add','.');await git('-C',repo,'-c','user.name=Isolation','-c','user.email=isolation@example.invalid','-c','commit.gpgsign=false','commit','-m','Isolated source rules');await git('-C',repo,'remote','add','origin',origin);await git('-C',repo,'push','-u','origin','main');
 const project={id:'isolated',repoPath:work,baseBranch:'main',analysisSourceMode:'isolated',analysisSnapshotRoot:path.join(root,'snapshots'),analysisEnvironments:{uat:{repositories:[{path:'inventory',branch:'main'}]}}};
 const dataDir=path.join(root,'data');const app=await createControlPlane({dataDir,runnerToken:'isolated-only-token',retention:{enabled:false},projects:{projects:{isolated:project}},agents:{agents:{}},feishuClient:{enabled:false},conversationResponder:async()=>({action:'reply',reply:'unused'}),conversationFile:path.join(root,'conversation.json'),memoryFile:path.join(root,'memory-settings.json'),knowledgeFile:path.join(root,'knowledge-settings.json'),contactsFile:path.join(root,'contacts.json'),contactChannelsFile:path.join(root,'channels.json')});
 await new Promise(r=>app.server.listen(0,'127.0.0.1',r));let owner;
 try{
 const config={executor:'codex',codexBin:'codex',runnerToken:'isolated-only-token',runnerId:'isolated-windows',serverUrl:'http://127.0.0.1:'+app.server.address().port,dataDir,worktreeRoot:path.join(root,'worktrees'),localExecutionRegistry:path.join(dataDir,'local-executions'),projects:{isolated:project}};
 const model=await loadCodexRuntimeSettings();await save('input.json',{config,model,humanInterventions:['Engineering harness intentionally terminates only its own Runner after actual model tool activity; no business action is interrupted.'],sourceFreeze:JSON.parse(await readFile(path.join(root,'../source-freeze.json')))});
 const {job}=await app.store.createJob({projectId:'isolated',projectName:'隔离库存源码',stage:'developer',workflow:'continuous_analysis',taskIntent:'analysis',sourceEnvironment:'uat',instruction:'只读调查库存可用量公式、原值缺失处理、租户与归档可见性。必须实际读取source.mjs和RULES.md并在结论引用对应文件/行号，以code工件列出依据。明确源码定义与尚未查询的实时库存值的边界，不执行业务请求或改文件。按正常调查结果与handoff契约完成。'});
 owner=fork(self,[root,'owner'],{execArgv:[],stdio:['ignore','pipe','pipe','ipc']});owner.stdout.pipe((await import('node:fs')).createWriteStream(path.join(root,'owner.stdout.log')));owner.stderr.pipe((await import('node:fs')).createWriteStream(path.join(root,'owner.stderr.log')));await once(owner,'message');
 let checkpoint;for(;;){checkpoint=await app.store.getJob(job.id);if(checkpoint.events.some(e=>e.type==='progress'&&e.phase==='tool_activity'&&e.activity?.completed>0))break;if(!['running','queued'].includes(checkpoint.status))throw Error('Runner ended before planned interruption: '+checkpoint.status);await new Promise(r=>setTimeout(r,100));}
 await save('before-interruption.json',checkpoint);const exited=once(owner,'exit');owner.kill();await exited;
 let recovery;for(;;){recovery=await recoverLocalExecutions(app.store,config.localExecutionRegistry);if(recovery.recovered)break;await new Promise(r=>setTimeout(r,100));}
 const interrupted=await app.store.getJob(job.id);await save('recovered.json',interrupted);if(interrupted.status!=='blocked'||!interrupted.analysisSourceSnapshot)throw Error('Recovery lost source pin or did not fence execution');
 const oldPin=interrupted.analysisSourceSnapshot;await writeFile(path.join(repo,'source.mjs'),'export function changedRemote(){return "new-question-only";}\n');await git('-C',repo,'add','.');await git('-C',repo,'-c','user.name=Isolation','-c','user.email=isolation@example.invalid','-c','commit.gpgsign=false','commit','-m','Later remote version');await git('-C',repo,'push');
 // Explicit harness continuation after read-only process reconciliation. Not an automatic business replay.
 await app.store.transact(s=>{const j=s.jobs.find(x=>x.id===job.id);j.status='queued';j.events.push({type:'isolated_explicit_resume',at:new Date().toISOString(),reason:'read-only interrupted investigation; no business actions'});j.result=null;});
 const runner=new AgentRunner({...config,runnerId:'isolated-windows-resumed'});await runner.heartbeat();const resumed=await runner.lease();await runner.run(resumed);const result=await app.store.getJob(job.id);await save('final-job.json',result);
 if(result.result?.outcome!=='ready'||JSON.stringify(result.analysisSourceSnapshot)!==JSON.stringify(oldPin)||result.result.sourceSync?.cacheKey!==oldPin.cacheKey)throw Error('Normal resumed Runner failed or changed source identity');
 const {prepareAnalysisSources}=await import('../src/runner/source-sync.js');const next=await prepareAnalysisSources({projectId:'isolated',stage:'developer',sourceEnvironment:'uat'},project);if(next.cacheKey===oldPin.cacheKey)throw Error('New question did not refresh remote');
 await save('result.json',{ok:true,model,jobId:job.id,recovery,sourcePin:oldPin.cacheKey,newQuestion:next.cacheKey,outcome:result.result.outcome,realModel:true,normalRunner:true,fixedPlan:false,businessRequests:0,sourceSha256:JSON.parse(await readFile(path.join(root,'../source-freeze.json'))).sha256,retained:['Git fixture and task evidence'],at:new Date().toISOString()});console.log(JSON.stringify({ok:true,model,jobId:job.id}));
 }finally{owner?.kill();await app.retention.close();await app.websiteBrowser?.close();await app.reportDelivery?.close();app.server.closeAllConnections();await new Promise(r=>app.server.close(r));}
}
