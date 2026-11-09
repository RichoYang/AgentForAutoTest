import test from 'node:test';import assert from 'node:assert/strict';
import {fork,execFile,spawn} from 'node:child_process';import {once} from 'node:events';import {promisify} from 'node:util';
import {mkdtemp,writeFile,readFile,readdir,rm,mkdir,symlink,realpath,stat} from 'node:fs/promises';
import os from 'node:os';import path from 'node:path';import {pathToFileURL,fileURLToPath} from 'node:url';
import {withSnapshotLock} from '../src/shared/snapshot-lock.js';
import {recoverLocalExecutions} from '../src/runner/local-executions.js';
import {windowsQuery} from '../src/shared/windows-kernel.js';
import {privateDirectory,writePrivateFile,privatePathProof} from '../src/shared/private-files.js';
import {JsonStore} from '../src/shared/store.js';
const url=file=>pathToFileURL(path.resolve(file)).href;
async function fixture(t){const root=await realpath(await mkdtemp(path.join(os.tmpdir(),'agentos-win-native-')));t.after(()=>rm(root,{recursive:true,force:true}));return root;}
async function until(read,accept){const start=Date.now();for(;;){const value=await read();if(accept(value))return value;if(Date.now()-start>15000)throw Error('Native component did not settle');await new Promise(r=>setTimeout(r,50));}}

test('Windows state replacement survives a reader that temporarily denies delete sharing', async t => {
  if (process.platform !== 'win32') return;
  const root = await fixture(t);
  const file = path.join(root, 'state.json');
  const store = new JsonStore(file);
  await store.transact(state => { state.counter = 0; });
  const script = [
    "$ErrorActionPreference='Stop'",
    '$handle=[IO.File]::Open($env:AGENTOS_TEST_LOCK_TARGET,[IO.FileMode]::Open,[IO.FileAccess]::Read,[IO.FileShare]::ReadWrite)',
    "try { [Console]::WriteLine('ready'); [void][Console]::ReadLine() } finally { $handle.Dispose() }",
  ].join('; ');
  const holder = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], {
    env: { ...process.env, AGENTOS_TEST_LOCK_TARGET: file }, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'],
  });
  const exited = once(holder, 'close');
  let stderr = '';
  holder.stderr.on('data', chunk => { stderr += chunk; });
  try {
    await Promise.race([
      once(holder.stdout, 'data').then(([ready]) => assert.equal(String(ready).trim(), 'ready')),
      exited.then(() => assert.fail(stderr || 'Windows file holder exited before acquiring the handle')),
    ]);
    let calls = 0;
    const update = store.transact(state => { calls++; state.counter++; }).then(() => null, error => error);
    await until(() => stat(file + '.' + process.pid + '.tmp').then(() => true, error => {
      if (error.code !== 'ENOENT') throw error;
      return false;
    }), Boolean);
    await new Promise(resolve => setTimeout(resolve, 100));
    assert.equal(JSON.parse(await readFile(file)).counter, 0);
    holder.stdin.end();
    assert.equal((await exited)[0], 0, stderr);
    const error = await update;
    if (error) throw error;
    assert.equal(calls, 1);
    assert.equal(JSON.parse(await readFile(file)).counter, 1);
  } finally {
    holder.stdin.end();
    await exited;
  }
});

test('Windows snapshot kernel lock survives contention, owner crash and rejects reparse paths',async t=>{
 if(process.platform!=='win32')return;const root=await fixture(t),file=path.join(root,'owner.mjs');
 await writeFile(file,`import {withSnapshotLock} from ${JSON.stringify(url('src/shared/snapshot-lock.js'))};await withSnapshotLock(process.argv[2],async()=>{process.send('locked');await new Promise(()=>{});});`);
 const owner=fork(file,[root],{execArgv:[],stdio:['ignore','ignore','ignore','ipc']});t.after(()=>owner.kill());await once(owner,'message');
 let entered=false;const pending=withSnapshotLock(root,async()=>{entered=true;return 'reacquired';});await new Promise(r=>setTimeout(r,150));assert.equal(entered,false);
 const exited=once(owner,'exit');owner.kill();await exited;assert.equal(await pending,'reacquired');
 const outside=path.join(root,'outside'),link=path.join(root,'junction');await mkdir(outside);await symlink(outside,link,'junction');await assert.rejects(withSnapshotLock(link,()=>{}),/root/);
 // Terminate only the exact helper spawned by this test's current Node process.
 await withSnapshotLock(root,async check=>{
  const code=`Get-CimInstance Win32_Process -Filter 'ParentProcessId=${process.pid}' | Where-Object {$_.ProcessId -ne $PID -and $_.CommandLine -like '*windows-kernel.ps1*' -and $_.CommandLine -like '*lock*'} | Select-Object -ExpandProperty ProcessId`;
  const {stdout}=await promisify(execFile)('powershell.exe',['-NoProfile','-Command',code],{windowsHide:true});const pids=stdout.trim().split(/\s+/).filter(Boolean).map(Number);assert.equal(pids.length,1);process.kill(pids[0]);await until(async()=>{try{check();return false;}catch{return true;}},Boolean);assert.throws(check,/已丢失/);
 });
 assert.equal(await withSnapshotLock(root,()=>true),true);
});

test('Windows kernel-owned worker trees exit on owner loss; recovery preserves leases, history, cancellation and uncertain business actions',async t=>{
 if(process.platform!=='win32')return;const root=await fixture(t),registry=path.join(root,'registry'),store=new JsonStore(path.join(root,'state.json'));
 const job={id:'JOB-native-recovery',status:'running',taskIntent:'analysis',lease:{id:'lease-one',runnerId:'local-one'},events:[],context:[{result:{summary:'retained'}}],mutationReceipt:'uncertain-do-not-repeat'};await store.transact(s=>s.jobs.push(job));
 const worker=path.join(root,'worker.mjs'),ownerFile=path.join(root,'owner.mjs');
 await writeFile(worker,`import {spawn} from 'node:child_process';process.once('message',()=>{const c=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore'});process.send({grandchild:c.pid});setInterval(()=>{},1000);});`);
 await writeFile(ownerFile,`import {fork} from 'node:child_process';import {registerLocalExecution} from ${JSON.stringify(url('src/runner/local-executions.js'))};const j=JSON.parse(process.argv[3]);const w=fork(process.argv[4],[],{execArgv:[],stdio:['ignore','ignore','ignore','ipc']});const guard=await registerLocalExecution(process.argv[2],j,w.pid);w.once('message',m=>process.send({...m,worker:w.pid}));w.send('go');`);
 const owner=fork(ownerFile,[registry,JSON.stringify(job),worker],{execArgv:[],stdio:['ignore','ignore','pipe','ipc']});let diagnostic='';owner.stderr.on('data',b=>diagnostic+=b);t.after(()=>owner.kill());const [ready]=await Promise.race([once(owner,'message'),once(owner,'exit').then(([code])=>{throw Error('Isolated owner exited '+code+': '+diagnostic);})]);
 const [name]=await readdir(registry),file=path.join(registry,name),entry=JSON.parse(await readFile(file));assert.equal(entry.version,2);assert.equal((await recoverLocalExecutions(store,registry)).recovered,0);
 assert.ok((await windowsQuery('probe',{...entry,name:entry.jobName})).active>=2);
 const exit=once(owner,'exit');owner.kill();await exit;
 await until(()=>windowsQuery('probe',{...entry,name:entry.jobName}),p=>!p.errors?.length&&p.active===0&&p.workerCreated!==entry.workerCreated);
 // Original child and grandchild are both gone. PID existence alone was never the proof.
 const descendants=await until(()=>windowsQuery('probe',{name:entry.jobName,ownerPid:ready.worker,workerPid:ready.grandchild}),p=>!p.errors?.length);assert.equal(descendants.ownerCreated,null);assert.equal(descendants.workerCreated,null);
 assert.equal((await recoverLocalExecutions(store,registry,{host:'foreign-host'})).recovered,0);
 await store.transact(s=>s.jobs[0].lease.id='different-lease');assert.equal((await recoverLocalExecutions(store,registry)).recovered,0);assert.equal((await store.getJob(job.id)).status,'running');
 await writeFile(file,JSON.stringify(entry));await store.transact(s=>s.jobs[0].lease.id=job.lease.id);
 assert.equal((await until(()=>recoverLocalExecutions(store,registry),r=>r.recovered===1)).recovered,1);let saved=await store.getJob(job.id);assert.equal(saved.status,'blocked');assert.equal(saved.lease,null);assert.equal(saved.context[0].result.summary,'retained');assert.equal(saved.mutationReceipt,'uncertain-do-not-repeat');assert.match(saved.result.summary??JSON.stringify(saved.result),/对账/);
 // A currently live PID with another creation time is not the original owner/worker.
 const reused={...entry,ownerPid:process.pid,workerPid:process.pid};await writeFile(file,JSON.stringify(reused));await store.transact(s=>s.jobs[0]={...job});assert.equal((await recoverLocalExecutions(store,registry)).recovered,1);
 // System PID is queried read-only to exercise actual access refusal; never assigned or terminated.
 const denied=await windowsQuery('probe',{name:entry.jobName,ownerPid:4,workerPid:process.pid});
 if(denied.errors.length){await writeFile(file,JSON.stringify({...entry,ownerPid:4,workerPid:process.pid}));await store.transact(s=>s.jobs[0]={...job});const fenced=await recoverLocalExecutions(store,registry);assert.equal(fenced.recovered,0);assert.equal(fenced.blocked[0].code,'WINDOWS_PROCESS_PROOF_UNAVAILABLE');assert.ok(fenced.blocked[0].details.some(e=>e.field==='owner'&&e.code===5));assert.equal((await store.getJob(job.id)).status,'running');assert.equal((await store.getJob(job.id)).lease.id,job.lease.id);}
 const systemRoot=process.env.SystemRoot;try{process.env.SystemRoot=path.join(root,'missing-system-runtime');await writeFile(file,JSON.stringify(entry));await store.transact(s=>s.jobs[0]={...job});const unavailable=await recoverLocalExecutions(store,registry);assert.equal(unavailable.recovered,0);assert.equal(unavailable.blocked[0].code,'WINDOWS_PROBE_HELPER_UNAVAILABLE');assert.equal((await store.getJob(job.id)).lease.id,job.lease.id);}finally{if(systemRoot===undefined)delete process.env.SystemRoot;else process.env.SystemRoot=systemRoot;}
 for(const status of ['cancelled','cancelling']){await writeFile(file,JSON.stringify(entry));await store.transact(s=>s.jobs[0]={...job,status,events:[{type:'cancel_requested'}]});const before=JSON.stringify(await store.getJob(job.id));const result=await recoverLocalExecutions(store,registry);saved=await store.getJob(job.id);assert.equal(saved.status,'cancelled');if(status==='cancelled'){assert.equal(result.recovered,0);assert.equal(JSON.stringify(saved),before);}else assert.equal(result.recovered,1);}
 await writeFile(file,JSON.stringify({...entry,version:1}));await store.transact(s=>s.jobs[0]={...job});assert.equal((await recoverLocalExecutions(store,registry)).recovered,0);
});

test('private ACL or POSIX mode is retained across file replacement and directory reconstruction without touching the parent',async t=>{
 const root=await fixture(t),dir=path.join(root,'private');await privateDirectory(dir);const file=path.join(dir,'state.json');await writePrivateFile(file,'first');
 const parentBefore=process.platform==='win32'?await windowsQuery('inspectAcl',{file:root}):null;
 assert.equal((await privatePathProof(dir,true)).private,true);assert.equal((await privatePathProof(file)).private,true);
 if(process.platform==='win32'){const child=path.join(dir,'inherited.txt');await writeFile(child,'private by inheritance');assert.equal((await privatePathProof(child)).private,true);}
 await rm(dir,{recursive:true});await privateDirectory(dir);await writePrivateFile(file,'second');assert.equal((await privatePathProof(file)).private,true);
 if(parentBefore)assert.deepEqual(await windowsQuery('inspectAcl',{file:root}),parentBefore);
});

test('Windows private files and directories are protected at creation, preserve exact bytes and refuse existing targets',{timeout:30000},async t=>{
 if(process.platform!=='win32')return;let watcher,closed=Promise.resolve();t.after(async()=>{watcher?.kill();await closed;});const root=await fixture(t);
 const observe=async(name,create)=>{
  watcher=(await import('node:child_process')).spawn('powershell.exe',['-NoProfile','-File',fileURLToPath(new URL('../test-support/watch-private-creation.ps1',import.meta.url)),Buffer.from(root).toString('base64'),name],{windowsHide:true,stdio:['ignore','pipe','pipe']});let output='',error='';
  let readyResolve,readyReject;const ready=new Promise((resolve,reject)=>{readyResolve=resolve;readyReject=reject;});closed=new Promise(resolve=>watcher.once('close',code=>{if(!output.includes('ready'))readyReject(Error(error||'Creation observer exited'));resolve(code);}));watcher.once('error',readyReject);watcher.stdout.on('data',b=>{output+=b;if(output.includes('ready\n')||output.includes('ready\r\n'))readyResolve();});watcher.stderr.on('data',b=>error+=b);
  await ready;await create();assert.equal(await closed,0,error);const proof=JSON.parse(output.trim().split(/\r?\n/).at(-1));assert.equal(proof.protected,true);assert.equal(proof.allows.some(s=>['S-1-1-0','S-1-5-11','S-1-5-32-545'].includes(s)),false);return proof;
 };
 const file=path.join(root,'secret.tmp'),data=Buffer.from([0,255,239,187,191,228,184,173,0]);await observe('secret.tmp',()=>writePrivateFile(file,data));assert.deepEqual(await readFile(file),data);await assert.rejects(writePrivateFile(file,'do not overwrite'));assert.deepEqual(await readFile(file),data);
 const dir=path.join(root,'private-dir.tmp');assert.equal((await observe('private-dir.tmp',()=>privateDirectory(dir))).directory,true);assert.equal((await privatePathProof(dir,true)).private,true);
});
