import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import { mkdir, readFile, readdir, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { JsonStore } from '../../../src/shared/store.js';
import { handleRequirementMessage, validateRequirementRoutes } from '../../../src/control-plane/requirement-testing.js';
import { runRequirementTest } from '../../../src/runner/requirement-test.js';
import { digest } from '../../../src/runner/requirement-feishu.js';
import { generatorReferences, regressionReferences, command, readJson, writeJson } from '../../../src/runner/requirement-files.js';
import { fixtureModule, fixtureRequirement, fixtureSource, startFixture } from './db-fixture-delivery6.mjs';

import {checkDelivery} from './delivery-proof.mjs';
const evidence=process.env.AGENTOS_RELEASE_FIXTURE_DIR;
assert.ok(evidence&&path.isAbsolute(evidence),'Set an absolute isolated evidence directory');
const [mode,label]=process.argv.slice(2);
assert.ok(['wide6','holdout6','negative6'].includes(mode));
assert.match(label,/^native-[a-z0-9-]+$/);
const root=path.join(evidence,label), repo=path.join(root,'source'), dataDir=path.join(root,'data');
await mkdir(root); await mkdir(repo); await mkdir(dataDir);
const sourceCode=await fixtureSource(mode);
await writeFile(path.join(repo,'service.mjs'),sourceCode);
await writeFile(path.join(repo,'AGENTS.md'),'# 本轮专属隔离服务\n请使用当前任务授权的资源和本仓源码核验，不推断业务真实值。\n');
const git=async(...args)=>(await command('git',['-C',repo,'-c','user.name=Fixture','-c','user.email=fixture@example.invalid',...args])).trim();
await git('init','-b','main');
await git('add','.'); await git('commit','-m','Fixture baseline');
const configCommit=await git('rev-parse','HEAD');
await git('switch','-c','verified-sit');
await git('commit','--allow-empty','-m','Actual worktree');
const origin=path.join(root,'fixture-origin.git');
await command('git',['init','--bare',origin]);
await git('remote','add','origin',origin);
await git('push','origin','main','verified-sit');
const iniPath=path.join(root,'resource.ini');
const service=await startFixture(mode);
await writeFile(iniPath,service.ini,{flag:'wx'});
const inputBytes=await readFile(path.join(import.meta.dirname,mode+'.json'));
const original=JSON.parse(inputBytes),{headers,rows}=original;
const caseSource='https://fixture.invalid/sheets/Original';
const skill=async(name,refs)=>{
  const folder=path.join(process.env.AGENTOS_REQUIREMENT_SKILLS_ROOT,name), hash=createHash('sha256');
  for(const file of ['SKILL.md',...refs]) hash.update(file).update('\0').update(await readFile(path.join(folder,file))).update('\0');
  return {path:folder,sha256:hash.digest('hex')};
};
const validationCli=path.join(root,'offline.cmd'); await writeFile(validationCli,'@exit /b 94\r\n');
const bot={profile:'local-qa',appId:'cli_local',openId:'ou_bot'}, doc='https://fixture.invalid/docx/Scenario';
const cfg={module: fixtureModule(mode), paragraphs:fixtureRequirement(mode)};
const source={id:'Scenario',url:doc,title:cfg.module+'隔离验收',revision:1,embedded:[],
  xml:'<h1 id="module">'+cfg.module+'</h1>'+cfg.paragraphs.map((text,i)=>`<p id="r${i+1}">${text}</p>`).join('')};
const execution={mode:'agent'};
const settings={bot,allowedChatIds:['oc_local'],requesterOpenIds:['ou_requester'],document:{domain:'fixture.invalid',profile:'local-docs',appId:'cli_docs',openId:'ou_docs'},
  projectName:'隔离执行链',templateUrl:'https://fixture.invalid/sheets/Template',projectFolderUrl:'https://fixture.invalid/drive/folder/Root',
  timeZone:'Asia/Shanghai',reportDirectory:path.join(root,'reports'),lockDirectory:path.join(root,'locks'),validationCli,powerShell:'pwsh',
  skills:{generator:await skill('lark-testcase-by-prd-order-generator',generatorReferences),regression:await skill('run-full-requirement-regression',regressionReferences)},
  environment:{name:'SIT',platform:'Fixture',iniPath,lockKey:'local',resources:service.resources},execution};
const projects={projects:{fixture:{displayName:settings.projectName,repoPath:repo,baseBranch:'main',requirementTest:settings}},
  chatProjectMap:{oc_local:'fixture'},topicChatIds:['oc_local']};
const config={projects:projects.projects,dataDir,codexBin:process.env.CODEX_BIN};
const store=new JsonStore(path.join(dataDir,'agentos.json'));
const replies=[];
const context={config,store,requirementRoutes:validateRequirementRoutes(projects,{agents:{qa:bot}}),feishu:{reply:async(_,message)=>replies.push(message)}};
const message=(id,content)=>handleRequirementMessage(context,{agent_profile:bot.profile,receiving_app_id:bot.appId,receiving_bot_id:bot.openId,
  chat_id:'oc_local',chat_type:'group',sender_id:'ou_requester',message_id:'om_'+id,thread_id:'omt_local',content,
  mentions:[{id:{open_id:bot.openId}}]});
const matrix=token=>{
  assert.ok(['Template','Original'].includes(token));
  return token==='Original'?[headers,...rows]:[headers];
};
const client={verify:async()=>{},readRequirement:async()=>({...source,hash:digest(source)}),
  resolveInput:async(reference,kind)=>{
    assert.equal(reference,caseSource);assert.equal(kind,'cases');
    return {url:caseSource,token:'Original'};
  },
  workbook:async token=>({sheets:[{sheet_id:'cases',title:'测试场景',grid_properties:{row_count:matrix(token).length,column_count:headers.length}}],revision:1}),
  readGrid:async token=>structuredClone(matrix(token))};
try {
  const {jobId}=await message('start','需求文档：'+doc+'\n测试用例：'+caseSource);
  assert.ok(jobId);
  await writeJson(path.join(root,'fixture-receipt.json'),{jobId,mode,label,engine:process.env.AGENTOS_RETRY_SOURCE_SHA,configCommit,
    sourceHead:await git('rev-parse','HEAD'),model:`${process.env.AGENTOS_CODEX_MODEL}/${process.env.AGENTOS_CODEX_REASONING_EFFORT}`,
    originalCases:{sha256:createHash('sha256').update(inputBytes).digest('hex'),rows:rows.length,version:digest([headers,...rows])},
    transport:'simulated Feishu',databaseEndpoint:'127.0.0.1:23410',schemas:service.schemas,injectedPlansOrVerdicts:0});
  const jobDir=path.join(dataDir,'requirement-tests',jobId);
  const run=async step=>{
    const current=await store.leaseNext('isolated-runner',['requirement_test']);
    assert.equal(current.id,jobId);
    const lease={runnerId:'isolated-runner',leaseId:current.lease.id};

    const result=await runRequirementTest(current,config,async event=>{
      await store.appendEvent(jobId,{...event,...lease});
      const {activity}=event;
      if(activity) console.log(JSON.stringify({step,phase:activity.current,counts:activity.requirement?.cases,coverage:activity.requirement?.coverage?.compared}));
    },{client});
    await store.appendEvent(jobId,{...lease,type:'completed',result});
    const out={jobId,result,head:await git('rev-parse','HEAD')};
    await writeJson(path.join(root,step+'-result.json'),out);
    console.log(JSON.stringify({step,outcome:result.outcome,summary:result.requirementSummary,wait:result.requirementWait}));
    return out;
  };
  const first=await run('first');
  const journal=await readJson(path.join(dataDir,'requirement-tests',jobId,'journal.json'));
  assert.equal(journal.publication?.external,true);
  assert.equal(journal.publication.version,digest([headers,...rows]));
  if(first.result.outcome==='ready') await writeJson(path.join(root,'delivery-proof.json'), await checkDelivery({root,dataDir,jobId,journal,store,projects}));
  await writeJson(path.join(root,'fixture-summary.json'),{jobId,mode,schemas:service.schemas,finalStatus:(await store.getJob(jobId)).status,
    pending:journal?.mutations?.filter(item=>!item.cleanup?.verified).length??0,caseAttempts:journal?.caseAttempts??{},reportHistory:journal?.reportHistory??[]});
} finally {
  await service.close(); await unlink(iniPath);
}
