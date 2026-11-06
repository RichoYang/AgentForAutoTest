import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm, symlink, readdir, access, realpath } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import path from 'node:path';
import os from 'node:os';
import {fileURLToPath} from 'node:url';
import { syncAnalysisSources, verifyAnalysisSources, prepareAnalysisSources } from '../src/runner/source-sync.js';
import { executeJob, buildPrompt, buildCodexArgs } from '../src/runner/codex-executor.js';
const exec = promisify(execFile);
const git = async (cwd, ...args) => (await exec('git', ['-C', cwd, ...args])).stdout.trim();
async function commit(cwd, value) {
  await writeFile(path.join(cwd, 'source.txt'), value);
  await git(cwd, 'add', '.');
  await git(cwd, '-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', '-c', 'commit.gpgsign=false', 'commit', '-m', value);
}
async function fixture(t, name = 'business', branch = 'business-main') {
  const base = await realpath(await mkdtemp(path.join(os.tmpdir(), 'agentos-source-sync-')));
  t.after(() => rm(base, { recursive: true, force: true }));
  const root = path.join(base, 'workspace'), origin = path.join(base, 'origin.git'), writer = path.join(base, 'writer');
  await mkdir(root); await mkdir(writer);
  await git(base, 'init', '--bare', origin);
  await git(writer, 'init', '-b', branch); await commit(writer, 'old');
  await git(writer, 'remote', 'add', 'origin', origin); await git(writer, 'push', '-u', 'origin', branch);
  const repo = path.join(root, name);
  await git(base, 'clone', '-b', branch, origin, repo);
  return { base, root, origin, writer, repo, branch, project: { repoPath: root, analysisRepositories: [{ path: name, branch }] } };
}
test('sync advances clean checkout to explicit origin branch, records proof, and report never fetches again', async (t) => {
  const f = await fixture(t);
  await commit(f.writer, 'new'); await git(f.writer, 'push');
  const report = await syncAnalysisSources(f.project);
  assert.equal(await readFile(path.join(f.repo, 'source.txt'), 'utf8'), 'new');
  assert.equal(report.repositories[0].changed, true);
  assert.equal(report.repositories[0].commit, await git(f.writer, 'rev-parse', 'HEAD'));
  assert.ok(report.checkedAt);
  await git(f.repo, 'remote', 'set-url', 'origin', path.join(f.base, 'unavailable'));
  assert.deepEqual(await prepareAnalysisSources({ stage: 'owner_report', context: [{ result: { sourceSync: report } }] }, f.project), report);
  assert.deepEqual(await prepareAnalysisSources({ stage: 'developer', context: [{ result: { sourceSync: report } }] }, f.project), report);
  await writeFile(path.join(f.repo, 'source.txt'), 'changed during analysis');
  await assert.rejects(verifyAnalysisSources(f.project, report), /本地修改/);
});
test('dirty, wrong branch, detached, ahead and diverged checkouts cannot be analyzed or overwritten', async (t) => {
  const f = await fixture(t), initial = await git(f.repo, 'rev-parse', 'HEAD');
  await writeFile(path.join(f.repo, 'untracked.txt'), 'keep');
  await assert.rejects(syncAnalysisSources(f.project), /本地修改/);
  assert.equal(await readFile(path.join(f.repo, 'untracked.txt'), 'utf8'), 'keep');
  await rm(path.join(f.repo, 'untracked.txt'));
  await git(f.repo, 'checkout', '-b', 'other');
  await assert.rejects(syncAnalysisSources(f.project), /当前分支/);
  await git(f.repo, 'checkout', '--detach');
  await assert.rejects(syncAnalysisSources(f.project), /当前分支/);
  await git(f.repo, 'checkout', f.branch);
  await commit(f.repo, 'local only');
  await assert.rejects(syncAnalysisSources(f.project), /未推送提交/);
  await commit(f.writer, 'remote edit'); await git(f.writer, 'push');
  await assert.rejects(syncAnalysisSources(f.project), /分叉/);
  assert.notEqual(await git(f.repo, 'rev-parse', 'HEAD'), initial);
  assert.equal(await readFile(path.join(f.repo, 'source.txt'), 'utf8'), 'local only');
});
test('all repositories are preflighted before any checkout advances; independent branches stay independent', async (t) => {
  const f = await fixture(t), second = path.join(f.root, 'second');
  await git(f.writer, 'checkout', '-b', 'second-main'); await commit(f.writer, 'second'); await git(f.writer, 'push', '-u', 'origin', 'second-main');
  await git(f.base, 'clone', '-b', 'second-main', f.origin, second);
  f.project.analysisRepositories.push({ path: 'second', branch: 'second-main' });
  await git(f.writer, 'checkout', f.branch); await commit(f.writer, 'new first'); await git(f.writer, 'push', 'origin', f.branch);
  await writeFile(path.join(second, 'untracked'), 'keep');
  await assert.rejects(syncAnalysisSources(f.project), /本地修改/);
  assert.equal(await readFile(path.join(f.repo, 'source.txt'), 'utf8'), 'old');
  await rm(path.join(second, 'untracked'));
  const report = await syncAnalysisSources(f.project);
  assert.deepEqual(report.repositories.map(r => r.branch), [f.branch, 'second-main']);
  assert.equal(await readFile(path.join(second, 'source.txt'), 'utf8'), 'second');
});
test('missing configuration, missing remote branch, paths outside root and duplicates fail closed', async (t) => {
  const f = await fixture(t);
  await assert.rejects(syncAnalysisSources({ repoPath: f.root }), /analysisRepositories/);
  await assert.rejects(syncAnalysisSources({ ...f.project, analysisRepositories: [{ path: '../writer', branch: f.branch }] }), /越界/);
  await assert.rejects(syncAnalysisSources({ ...f.project, analysisRepositories: [...f.project.analysisRepositories, ...f.project.analysisRepositories] }), /重复/);
  await git(f.repo, 'checkout', '-b', 'missing-on-origin');
  f.project.analysisRepositories[0].branch = 'missing-on-origin';
  await assert.rejects(syncAnalysisSources(f.project), /Git 操作失败/);
});
test('fetch errors with credential-bearing remote never expose URL or token', async (t) => {
  const f = await fixture(t);
  await git(f.repo, 'remote', 'set-url', 'origin', 'https://hidden:secret@127.0.0.1:1/no.git');
  await assert.rejects(syncAnalysisSources(f.project), error => !/hidden|secret|127\.0\.0\.1/.test(error.message));
});
test('executeJob blocks before starting Codex when sync config is absent; read-only permission remains', async () => {
  const result = await executeJob({ taskIntent: 'analysis', stage: 'developer', projectId: 'demo' }, {
    executor: 'codex', codexBin: '/must-not-start', projects: { demo: {} },
  }, async () => {});
  assert.equal(result.outcome, 'blocked');
  assert.equal(result.sourceSyncBlocked, true);
  assert.match(result.finalMessage, /analysisRepositories/);
  const args = buildCodexArgs('/tmp', [], { readOnly: true });
  assert.equal(args[args.indexOf('--sandbox') + 1], 'read-only');
  const evidence = { policy: 'origin-ff-before-analysis-v1', repositories: [{ path: '.', branch: 'main', commit: 'abc' }] };
  const prompt = await buildPrompt({ taskIntent: 'analysis' }, {}, { instruction: '', metadata: {} }, evidence);
  assert.match(prompt, /"commit":"abc"/);
  assert.match(prompt, /不同图片中各自明确标注的状态、错误提示或数值都属于需要逐项解释的可见目标/);
  assert.match(prompt, /原始字段行由系统留在审计证据中/);
});

test('unfinished Git operation, symlink escape and changed committed evidence are rejected', async (t) => {
  const f = await fixture(t);
  await writeFile(path.join(f.repo, '.git', 'CHERRY_PICK_HEAD'), await git(f.repo, 'rev-parse', 'HEAD'));
  await assert.rejects(syncAnalysisSources(f.project), /未结束/);
  await rm(path.join(f.repo, '.git', 'CHERRY_PICK_HEAD'));
  await symlink(f.writer, path.join(f.root, 'outside'), 'junction');
  await assert.rejects(syncAnalysisSources({ ...f.project, analysisRepositories: [{ path: 'outside', branch: f.branch }] }), /越界/);
  const report = await syncAnalysisSources(f.project);
  await commit(f.repo, 'later commit');
  await assert.rejects(verifyAnalysisSources(f.project, report), /不同于/);
  await assert.rejects(prepareAnalysisSources({ stage: 'owner_report', context: [] }, f.project), /缺少本次/);
});

test('isolated environment snapshots preserve dirty feature checkout and separate concurrent UAT/PRD', async t => {
  const f = await fixture(t);
  await git(f.writer, 'checkout', '-b', 'uat'); await commit(f.writer, 'uat code'); await git(f.writer, 'push', 'origin', 'uat');
  await git(f.repo, 'checkout', '-b', 'personal'); await writeFile(path.join(f.repo, 'source.txt'), 'my unfinished work');
  const before = await git(f.repo, 'status', '--porcelain');
  const project = { ...f.project, analysisSourceMode: 'isolated', analysisSnapshotRoot: path.join(f.base, 'snapshots'), analysisEnvironments: {
    uat: { repositories: [{ path: 'business', branch: 'uat' }] }, prd: { repositories: [{ path: 'business', branch: f.branch }] },
  } };
  const [uat, prd] = await Promise.all(['uat','prd'].map(sourceEnvironment => prepareAnalysisSources({ stage: 'developer', sourceEnvironment }, project)));
  assert.notEqual(uat.workspace, prd.workspace);
  assert.equal(await readFile(path.join(uat.workspace, 'business/source.txt'), 'utf8'), 'uat code');
  assert.equal(await readFile(path.join(prd.workspace, 'business/source.txt'), 'utf8'), 'old');
  assert.equal(await git(f.repo, 'branch', '--show-current'), 'personal');
  assert.equal(await git(f.repo, 'status', '--porcelain'), before);
  assert.equal(await readFile(path.join(f.repo, 'source.txt'), 'utf8'), 'my unfinished work');
  await git(f.repo, 'remote', 'set-url', 'origin', '/unavailable');
  assert.deepEqual(await prepareAnalysisSources({ stage:'owner_report', context:[{result:{sourceSync:uat}}] }, project), uat);
  await assert.rejects(prepareAnalysisSources({ stage:'developer' }, project), /明确/);
  await assert.rejects(prepareAnalysisSources({ stage:'developer',sourceEnvironment:'other' }, project), /明确/);
  await assert.rejects(verifyAnalysisSources(project, {...uat, environment:'prd'}), /不匹配/);
  await writeFile(path.join(uat.workspace,'business/source.txt'), 'tampered');
  await assert.rejects(verifyAnalysisSources(project, uat), /本地修改/);
});

test('isolated root plus child repositories work and reject changed manifest, escape, and missing branch', async t => {
  const f = await fixture(t);
  await git(f.root,'init','-b','docs'); await commit(f.root,'root docs');
  // The root must not track the independently configured child repository.
  await git(f.root,'rm','--cached','business');
  await writeFile(path.join(f.root,'.gitignore'),'business/\n');
  await git(f.root,'add','.gitignore'); await git(f.root,'-c','user.name=Test','-c','user.email=test@example.invalid','commit','-m','ignore child');
  const rootOrigin=path.join(f.base,'root.git'); await git(f.base,'clone','--bare',f.root,rootOrigin); await git(f.root,'remote','add','origin',rootOrigin);
  const project={repoPath:f.root,analysisSourceMode:'isolated',analysisSnapshotRoot:path.join(f.base,'snapshots'),analysisEnvironments:{uat:{repositories:[{path:'.',branch:'docs'},{path:'business',branch:f.branch}]}}};
  const report=await prepareAnalysisSources({stage:'developer',sourceEnvironment:'uat'},project);
  assert.equal(report.repositories.length,2); await verifyAnalysisSources(project,report);
  await assert.rejects(verifyAnalysisSources(project,{...report,workspace:f.root}),/不匹配/);
  await assert.rejects(prepareAnalysisSources({stage:'developer',sourceEnvironment:'uat'},{...project,analysisSnapshotRoot:path.join(f.root,'snapshots')}),/分开/);
  project.analysisEnvironments.uat.repositories[1].branch='missing';
  await assert.rejects(prepareAnalysisSources({stage:'developer',sourceEnvironment:'uat'},project),/business.*missing/);
});

test('immutable cache deduplicates concurrent questions, refreshes tips, preserves live versions and removes obsolete clean versions',async t=>{
 const {pruneSourceSnapshots}=await import('../src/shared/source-snapshot-gc.js');
 const f=await fixture(t),project={...f.project,id:'demo',analysisSourceMode:'isolated',analysisSnapshotRoot:path.join(f.base,'snapshots'),analysisEnvironments:{uat:{repositories:[{path:'business',branch:f.branch}]}}};
 const question=()=>prepareAnalysisSources({stage:'developer',sourceEnvironment:'uat'},project);
 const [a,b]=await Promise.all([question(),question()]);assert.equal(a.workspace,b.workspace);
 assert.equal((await readdir(project.analysisSnapshotRoot)).filter(x=>x.startsWith('analysis-')).length,1);
 await commit(f.writer,'version two');await git(f.writer,'push');const c=await question();assert.notEqual(a.workspace,c.workspace);
 assert.equal(await readFile(path.join(a.workspace,'business/source.txt'),'utf8'),'old');
 let state={jobs:[{projectId:'demo',status:'awaiting_clarification',questionId:'q',context:[{result:{sourceSync:a}}]}]};
 const gc=(apply=false)=>pruneSourceSnapshots(project,{getState:async()=>state,apply});
 let result=await gc(true);assert.equal(result.removed.length,0);assert.ok(result.kept.some(x=>x.reason==='active-or-delivery-reference'));
 state.jobs[0].status='completed';state.conversations=[{status:'sent',setupPending:true,questionId:'q'}];result=await gc();assert.equal(result.removed.length,1);await access(a.workspace);
 await writeFile(path.join(a.workspace,'business/source.txt'),'valuable edit');result=await gc(true);assert.equal(result.removed.length,0);assert.equal(result.unknown.length,1);
 await git(path.join(a.workspace,'business'),'checkout','--','source.txt');
 state.jobs.push({projectId:'demo',status:'running'});assert.equal((await gc(true)).skipped,'project-busy');state.jobs.pop();
 result=await gc(true);assert.equal(result.removed.length,1);await assert.rejects(access(a.workspace));await access(c.workspace);
 await git(f.repo,'remote','set-url','origin','/unavailable');await assert.rejects(question(),/未回退/);await access(c.workspace);
});

test('remote rollback selects an existing cache without mutating it; GC follows latest selection, and never follows symlinks',async t=>{
 const {pruneSourceSnapshots}=await import('../src/shared/source-snapshot-gc.js');const f=await fixture(t);
 const project={...f.project,id:'demo',analysisSourceMode:'isolated',analysisSnapshotRoot:path.join(f.base,'snapshots'),analysisEnvironments:{uat:{repositories:[{path:'business',branch:f.branch}]}}};
 const q=()=>prepareAnalysisSources({stage:'developer',sourceEnvironment:'uat'},project);
 await symlink('source.txt',path.join(f.writer,'tracked-link'));await git(f.writer,'add','.');await git(f.writer,'-c','user.name=Test','-c','user.email=test@example.invalid','commit','-m','tracked symlink');await git(f.writer,'push');
 const a=await q(),old=await git(f.writer,'rev-parse','HEAD');await commit(f.writer,'second');await git(f.writer,'push');const b=await q();
 await git(f.writer,'push','--force','origin',old+':refs/heads/'+f.branch);assert.equal((await q()).workspace,a.workspace);
 const link=path.join(project.analysisSnapshotRoot,'analysis-external');await symlink(f.writer,link);
 const r=await pruneSourceSnapshots(project,{getState:async()=>({jobs:[]}),apply:true});assert.equal(r.removed.length,1);assert.ok(r.unknown.some(x=>x.name==='analysis-external'));await access(a.workspace);await assert.rejects(access(b.workspace));await access(f.writer);
});


test('snapshot locks serialize independent callers and release after an operation error',async t=>{
 const {withSnapshotLock}=await import('../src/shared/snapshot-lock.js');const f=await fixture(t);const seen=[];
 await Promise.all([withSnapshotLock(f.base,async()=>{seen.push('first-start');await new Promise(r=>setTimeout(r,30));seen.push('first-end');}),withSnapshotLock(f.base,async()=>{seen.push('second');})]);
 assert.ok(seen.indexOf('first-end')===seen.indexOf('first-start')+1);
 await assert.rejects(withSnapshotLock(f.base,async()=>{throw new Error('fixture failure');}),/fixture failure/);
 assert.equal(await withSnapshotLock(f.base,async()=>42),42);
});

test('reclaimed continuation restores the exact historical commit, new questions still check remote and failures do not switch versions',async t=>{
 const {pruneSourceSnapshots}=await import('../src/shared/source-snapshot-gc.js');const f=await fixture(t);
 const project={...f.project,id:'demo',analysisSourceMode:'isolated',analysisSnapshotRoot:path.join(f.base,'snapshots'),analysisEnvironments:{uat:{repositories:[{path:'business',branch:f.branch}]}}};
 const fresh=()=>prepareAnalysisSources({projectId:'demo',questionId:'new',stage:'developer',sourceEnvironment:'uat'},project);
 const a=await fresh();await commit(f.writer,'later');await git(f.writer,'push');const b=await fresh();
 const state={jobs:[]};let gc=await pruneSourceSnapshots(project,{getState:async()=>state,apply:true});assert.equal(gc.removed.length,1);
 const resumed={projectId:'demo',questionId:'old',stage:'developer',sourceEnvironment:'uat',context:[{result:{sourceSync:a}}]};
 assert.deepEqual(await prepareAnalysisSources(resumed,project),a);assert.equal(await readFile(path.join(a.workspace,'business/source.txt'),'utf8'),'old');assert.equal((await fresh()).workspace,b.workspace);
 await pruneSourceSnapshots(project,{getState:async()=>state,apply:true});await git(f.repo,'remote','set-url','origin','/unavailable');
 await assert.rejects(prepareAnalysisSources(resumed,project),/恢复失败/);await assert.rejects(fresh(),/未回退/);
 await assert.rejects(prepareAnalysisSources({...resumed,sourceEnvironment:'prd'},project),/不混用/);
});

test('GC rechecks references inside state writer and protects pending delivery, dirty ignored files and unknown metadata',async t=>{
 const {pruneSourceSnapshots}=await import('../src/shared/source-snapshot-gc.js');const f=await fixture(t);
 const project={...f.project,id:'demo',analysisSourceMode:'isolated',analysisSnapshotRoot:path.join(f.base,'snapshots'),analysisEnvironments:{uat:{repositories:[{path:'business',branch:f.branch}]}}};
 const a=await prepareAnalysisSources({stage:'developer',sourceEnvironment:'uat'},project);await commit(f.writer,'later');await git(f.writer,'push');await prepareAnalysisSources({stage:'developer',sourceEnvironment:'uat'},project);
 let state={jobs:[]};let result=await pruneSourceSnapshots(project,{getState:async()=>state,apply:true,withState:async fn=>{state={jobs:[{projectId:'demo',status:'queued',analysisSourceSnapshot:a}]};return fn(state);}});
 assert.equal(result.removed.length,0);assert.ok(result.kept.some(x=>x.reason==='became-active-before-delete'));await access(a.workspace);
 state={jobs:[{id:'j',projectId:'demo',status:'completed',questionId:'q',result:{sourceSync:a}}],reportDeliveries:{x:{jobId:'j',questionId:'q',status:'queued'}}};result=await pruneSourceSnapshots(project,{getState:async()=>state,apply:true});assert.equal(result.removed.length,0);
 state={jobs:[]};await writeFile(path.join(a.workspace,'business/.git/info/exclude'),'valuable.tmp\n');await writeFile(path.join(a.workspace,'business/valuable.tmp'),'untracked valuable content');result=await pruneSourceSnapshots(project,{getState:async()=>state,apply:true});assert.equal(result.removed.length,0);assert.ok(result.unknown.some(x=>x.reason==='local-changes'));
});

test('separate Node processes reuse one published cache and release the lock after owner exits',async t=>{
 const f=await fixture(t),project={...f.project,id:'demo',analysisSourceMode:'isolated',analysisSnapshotRoot:path.join(f.base,'snapshots'),analysisEnvironments:{uat:{repositories:[{path:'business',branch:f.branch}]}}};
 const module=new URL('../src/runner/source-sync.js',import.meta.url).href,code=`import {prepareAnalysisSources} from ${JSON.stringify(module)};const r=await prepareAnalysisSources({stage:'developer',sourceEnvironment:'uat'},JSON.parse(process.argv[1]));console.log(JSON.stringify(r));`;
 const [x,y]=await Promise.all([exec(process.execPath,['--input-type=module','-e',code,JSON.stringify(project)]),exec(process.execPath,['--input-type=module','-e',code,JSON.stringify(project)])]);
 assert.equal(JSON.parse(x.stdout).workspace,JSON.parse(y.stdout).workspace);assert.equal((await readdir(project.analysisSnapshotRoot)).filter(n=>n.startsWith('analysis-')).length,1);
});

test('recreating a reclaimed cache after remote rollback preserves the original immutable manifest',async t=>{
 const {pruneSourceSnapshots}=await import('../src/shared/source-snapshot-gc.js');const f=await fixture(t),project={...f.project,id:'demo',analysisSourceMode:'isolated',analysisSnapshotRoot:path.join(f.base,'snapshots'),analysisEnvironments:{uat:{repositories:[{path:'business',branch:f.branch}]}}};
 const fresh=()=>prepareAnalysisSources({stage:'developer',sourceEnvironment:'uat'},project),a=await fresh(),old=await git(f.writer,'rev-parse','HEAD');await commit(f.writer,'later');await git(f.writer,'push');await fresh();
 await pruneSourceSnapshots(project,{getState:async()=>({jobs:[]}),apply:true});await git(f.writer,'push','--force','origin',old+':refs/heads/'+f.branch);const rebuilt=await fresh();assert.equal(rebuilt.workspace,a.workspace);assert.equal(rebuilt.checkedAt,a.checkedAt);await verifyAnalysisSources(project,a);
});

test('GC verifies ignored child repositories independently instead of treating managed children as local dirt',async t=>{
 const {pruneSourceSnapshots}=await import('../src/shared/source-snapshot-gc.js');const f=await fixture(t);
 await git(f.root,'init','-b','docs');await writeFile(path.join(f.root,'.gitignore'),'business/\n');await commit(f.root,'docs');const origin=path.join(f.base,'docs.git');await git(f.base,'clone','--bare',f.root,origin);await git(f.root,'remote','add','origin',origin);
 const project={repoPath:f.root,analysisSourceMode:'isolated',analysisSnapshotRoot:path.join(f.base,'snapshots'),analysisEnvironments:{uat:{repositories:[{path:'.',branch:'docs'},{path:'business',branch:f.branch}]}}};
 const a=await prepareAnalysisSources({stage:'developer',sourceEnvironment:'uat'},project);await commit(f.writer,'next');await git(f.writer,'push');const b=await prepareAnalysisSources({stage:'developer',sourceEnvironment:'uat'},project);
 const result=await pruneSourceSnapshots(project,{getState:async()=>({jobs:[]}),apply:true});assert.equal(result.removed.length,1);assert.equal(result.unknown.length,0);await assert.rejects(access(a.workspace));await access(b.workspace);
});

test('live maintenance requires admin authentication and protects waiting references in the state writer',async t=>{
 const {createControlPlane}=await import('../src/control-plane/server.js');const f=await fixture(t),project={...f.project,id:'demo',analysisSourceMode:'isolated',analysisSnapshotRoot:path.join(f.base,'snapshots'),analysisEnvironments:{uat:{repositories:[{path:'business',branch:f.branch}]}}};
 const a=await prepareAnalysisSources({stage:'developer',sourceEnvironment:'uat'},project);await commit(f.writer,'later');await git(f.writer,'push');await prepareAnalysisSources({stage:'developer',sourceEnvironment:'uat'},project);
 const app=await createControlPlane({dataDir:path.join(f.base,'state'),adminToken:'test-admin',runnerToken:'test-runner',retention:{enabled:false},projects:{projects:{demo:project}},agents:{agents:{}},feishuClient:{enabled:false},conversationResponder:async()=>({action:'reply',reply:'unused'})});
 await new Promise(r=>app.server.listen(0,'127.0.0.1',r));t.after(async()=>{await app.retention.close();app.server.closeAllConnections();await new Promise(r=>app.server.close(r));});
 await app.store.transact(s=>s.jobs.push({id:'j',projectId:'demo',questionId:'q',status:'awaiting_clarification',analysisSourceSnapshot:a}));
 const url='http://127.0.0.1:'+app.server.address().port+'/api/v1/admin/source-snapshots/prune';const headers={authorization:'Bearer test-admin','content-type':'application/json'};
 const denied=await fetch(url,{method:'POST',body:'{}'});assert.equal(denied.status,401);await denied.json();
 const session=await fetch(new URL('/admin',url));const cookie=session.headers.get('set-cookie').split(';')[0];await session.arrayBuffer();const origin=new URL(url).origin;let bad=await fetch(url,{method:'POST',headers:{cookie,origin:'https://foreign.invalid','x-agentos-admin':'1','content-type':'application/json'},body:'{}'});assert.equal(bad.status,401);await bad.json();const local=await fetch(url,{method:'POST',headers:{cookie,origin,'x-agentos-admin':'1','content-type':'application/json'},body:'{"apply":false}'});assert.equal(local.status,200);assert.equal((await local.json()).results[0].removed.length,0);
 let r=await fetch(url,{method:'POST',headers,body:'{"apply":true}'});let x=await r.json();assert.equal(x.results[0].removed.length,0);await access(a.workspace);
 await app.store.transact(s=>{s.jobs[0].status='completed';});r=await fetch(url,{method:'POST',headers,body:'{"apply":false}'});x=await r.json();assert.equal(x.results[0].removed.length,1);await access(a.workspace);
 r=await fetch(url,{method:'POST',headers,body:'{"apply":true}'});x=await r.json();assert.equal(x.results[0].removed.length,1);await assert.rejects(access(a.workspace));
 const cli=fileURLToPath(new URL('../scripts/prune-source-snapshots.mjs',import.meta.url));const run=await exec(process.execPath,[cli,'--apply','--server',new URL(url).origin],{env:{...process.env,AGENTOS_ADMIN_TOKEN:''}});assert.equal(JSON.parse(run.stdout).ok,true);
});

test('registered worktrees and anomalous manifests are retained instead of reclaimed',async t=>{
 const {pruneSourceSnapshots}=await import('../src/shared/source-snapshot-gc.js');const f=await fixture(t),project={...f.project,id:'demo',analysisSourceMode:'isolated',analysisSnapshotRoot:path.join(f.base,'snapshots'),analysisEnvironments:{uat:{repositories:[{path:'business',branch:f.branch}]}}};
 const a=await prepareAnalysisSources({stage:'developer',sourceEnvironment:'uat'},project);await commit(f.writer,'later');await git(f.writer,'push');await prepareAnalysisSources({stage:'developer',sourceEnvironment:'uat'},project);
 const external=path.join(f.base,'personal-worktree');await git(path.join(a.workspace,'business'),'worktree','add','--detach',external,a.repositories[0].commit);
 const unknown=path.join(project.analysisSnapshotRoot,'analysis-invalid');await mkdir(unknown);await writeFile(path.join(unknown,'source-manifest.json'),'{"policy":"unknown"}');
 const r=await pruneSourceSnapshots(project,{getState:async()=>({jobs:[]}),apply:true});assert.equal(r.removed.length,0);assert.ok(r.unknown.some(x=>x.reason==='registered-worktree'));assert.ok(r.unknown.some(x=>x.name==='analysis-invalid'));assert.equal(await readFile(path.join(external,'source.txt'),'utf8'),'old');
});

test('a new question ignores tagged historical context while same-question durable pins survive context compaction',async t=>{
 const f=await fixture(t),project={...f.project,id:'demo',analysisSourceMode:'isolated',analysisSnapshotRoot:path.join(f.base,'snapshots'),analysisEnvironments:{uat:{repositories:[{path:'business',branch:f.branch}]}}};
 const a=await prepareAnalysisSources({questionId:'old',stage:'developer',sourceEnvironment:'uat'},project);await commit(f.writer,'later');await git(f.writer,'push');
 const b=await prepareAnalysisSources({questionId:'new',stage:'developer',sourceEnvironment:'uat',context:[{result:{sourceQuestionId:'old',sourceSync:a}}]},project);assert.notEqual(b.workspace,a.workspace);
 await git(f.repo,'remote','set-url','origin','/unavailable');assert.deepEqual(await prepareAnalysisSources({questionId:'old',stage:'owner_report',sourceEnvironment:'uat',analysisSourceSnapshot:a,context:[]},project),a);
 await assert.rejects(prepareAnalysisSources({questionId:'newer',stage:'developer',sourceEnvironment:'uat',context:[{result:{sourceQuestionId:'old',sourceSync:a}}]},project),/未回退/);
});

test('leased runner persists a fixed snapshot outside compacted evidence and rejects a replacement',async t=>{
 const {JsonStore}=await import('../src/shared/store.js');const f=await fixture(t),store=new JsonStore(path.join(f.base,'state.json'));
 const {job}=await store.createJob({projectId:'demo',stage:'developer',taskIntent:'analysis',workflow:'continuous_analysis',instruction:'read only'});const lease=await store.leaseNext('r');
 const proof={policy:'isolated-environment-source-v1',environment:'uat',workspace:path.join(f.base,'fixed'),repositories:[{path:'business',branch:'uat',commit:'a'.repeat(40)}]};
 const identity={runnerId:'r',leaseId:lease.lease.id};await store.appendEvent(job.id,{type:'progress',...identity,sourceSnapshot:proof});await store.transact(s=>{s.jobs[0].context=[];});
 const reopened=new JsonStore(path.join(f.base,'state.json'));assert.deepEqual((await reopened.getJob(job.id)).analysisSourceSnapshot,proof);
 await assert.rejects(reopened.appendEvent(job.id,{type:'progress',...identity,sourceSnapshot:{...proof,workspace:path.join(f.base,'other')}}),/不能替换提交/);
});

test('history upgrades shallow caches concurrently without changing pinned source or selecting newer remote',async t=>{
 const {prepareSnapshotHistory}=await import('../src/runner/source-snapshot.js');
 const f=await fixture(t);await commit(f.writer,'second');await git(f.writer,'push');
 const project={...f.project,id:'history',analysisSourceMode:'isolated',analysisSnapshotRoot:path.join(f.base,'snapshots'),analysisEnvironments:{prd:{repositories:[{path:'business',branch:f.branch}]}}};
 const job={stage:'developer',sourceEnvironment:'prd'};
 const report=await prepareAnalysisSources(job,project),cwd=path.join(report.workspace,'business');
 const manifest=await readFile(path.join(path.dirname(report.workspace),'source-manifest.json'),'utf8');
 assert.equal(await git(cwd,'rev-parse','--is-shallow-repository'),'true');
 await commit(f.writer,'third');await git(f.writer,'push');
 const outputs=await Promise.all([prepareSnapshotHistory(project,report),prepareSnapshotHistory(project,report)]);
 assert.ok(outputs.every(o=>o.repositories[0].status==='complete'));
 assert.equal(await git(cwd,'rev-list','--count','HEAD'),'2');
 assert.equal(await git(cwd,'show','HEAD~1:source.txt'),'old');
 assert.equal(await git(cwd,'rev-parse','HEAD'),report.repositories[0].commit);
 assert.equal(await readFile(path.join(path.dirname(report.workspace),'source-manifest.json'),'utf8'),manifest);
 assert.equal(await readFile(path.join(cwd,'source.txt'),'utf8'),'second');
 await verifyAnalysisSources(project,report);
 // Complete history remains usable offline, without contacting the remote again.
 await rm(f.origin,{recursive:true,force:true});
 assert.equal((await prepareSnapshotHistory(project,report)).repositories[0].status,'complete');
});

test('history fetch failures preserve current evidence; source identity changes and symlinks are rejected',async t=>{
 const {prepareSnapshotHistory}=await import('../src/runner/source-snapshot.js');
 const f=await fixture(t);await commit(f.writer,'second');await git(f.writer,'push');
 const project={...f.project,id:'history',analysisSourceMode:'isolated',analysisSnapshotRoot:path.join(f.base,'snapshots'),analysisEnvironments:{prd:{repositories:[{path:'business',branch:f.branch}]}}};
 const report=await prepareAnalysisSources({stage:'developer',sourceEnvironment:'prd'},project),cwd=path.join(report.workspace,'business');
 const sentinel=path.join(f.base,'sentinel');await writeFile(sentinel,'keep');
 await rm(path.join(cwd,'.git','FETCH_HEAD'));await symlink(sentinel,path.join(cwd,'.git','FETCH_HEAD'));
 assert.match((await prepareSnapshotHistory(project,report)).repositories[0].reason,/符号链接/);
 assert.equal(await readFile(sentinel,'utf8'),'keep');await rm(path.join(cwd,'.git','FETCH_HEAD'));
 await writeFile(path.join(cwd,'.git','objects','info','alternates'),path.join(f.repo,'.git','objects'));
 assert.match((await prepareSnapshotHistory(project,report)).repositories[0].reason,/共享对象库/);
 await rm(path.join(cwd,'.git','objects','info','alternates'));
 await rm(f.origin,{recursive:true,force:true});
 const failed=await prepareSnapshotHistory(project,report);
 assert.equal(failed.repositories[0].status,'unavailable');assert.match(failed.repositories[0].recovery,/不切换/);
 await verifyAnalysisSources(project,report);
 await git(cwd,'remote','set-url','origin',path.join(f.base,'other.git'));
 assert.match((await prepareSnapshotHistory(project,report)).repositories[0].reason,/来源变化/);
 await assert.rejects(prepareSnapshotHistory(project,{...report,workspace:f.root}),/路径|证据/);
 await rm(path.join(cwd,'.git'),{recursive:true,force:true});await symlink(path.join(f.repo,'.git'),path.join(cwd,'.git'));
 await assert.rejects(prepareSnapshotHistory(project,report),/独立克隆/);
});

test('history guidance covers resumed investigation and separates code dates from deployed evidence',async()=>{
 const {sourceHistoryInstructions}=await import('../src/runner/codex-executor.js');
 const text=sourceHistoryInstructions({repositories:[{status:'complete'}]});
 assert.match(text,/git log --follow/);assert.match(text,/不是生产上线时间/);assert.match(text,/已有可用入口就继续取证/);
 assert.equal(sourceHistoryInstructions(null),'');
});
