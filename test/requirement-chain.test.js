import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { createServer } from 'node:http';
import { createHash, generateKeyPairSync, sign } from 'node:crypto';
import { createAgentResources } from '../src/runner/requirement-agent-resources.js';
import { createRequirementAgent } from '../src/runner/requirement-agent.js';
import { sidebarHandoff } from '../src/runner/requirement-handoff.js';
import { requirementResources } from '../src/runner/requirement-resources.js';
import { sampleLifecycle } from '../src/runner/requirement-samples.js';
import { executeCases } from '../src/runner/requirement-execution.js';
import { readJson, writeJson, command } from '../src/runner/requirement-files.js';
import { verifyRequirementRelease, matchesCaseRelease, caseReleaseRequirement } from '../src/runner/requirement-release.js';
import { collectTopicFeedback, archiveExecutionVersion, recoverExecutionVersion } from '../src/runner/requirement-feedback.js';
import { runRequirementTest } from '../src/runner/requirement-test.js';
import { buildEvidenceBundle } from '../src/runner/requirement-bundle.js';
import { deliverRequirementBundle } from '../src/control-plane/requirement-delivery.js';
import { pathToFileURL } from 'node:url';
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
async function temporary(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'aos-chain-'));
  t.after(() => rm(root, { recursive: true, force: true })); return root;
}

test('multipart reaches the exact registered endpoint; changed files and read-only uploads fail', async t => {
  const root = await temporary(t), requests = [];
  const server = createServer(async (req, res) => {
    const chunks = []; for await (const chunk of req) chunks.push(chunk);
    requests.push({ url: req.url, method: req.method, contentType: req.headers['content-type'], body: Buffer.concat(chunks).toString() });
    res.end(JSON.stringify({ imported: 1, eventId: 'controlled-event' }));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const resource = { base_url: 'http://127.0.0.1:' + server.address().port };
  const file = path.join(root, 'input.csv'); await writeFile(file, 'amount\n500\n');
  const runtime = createAgentResources({ uploadDirectories: [root] }, { state: { operations: {} } });
  const spec = { kind: 'http', resource: 'tpm', access: 'create', method: 'POST', path: '/budget/import',
    multipart: { fields: { scope: 'isolated' }, files: [{ field: 'file', path: file, sha256: sha('amount\n500\n') }] } };
  assert.equal((await runtime.performSpec(spec, {}, resource)).body.imported, 1);
  assert.equal(requests[0].url, '/budget/import'); assert.match(requests[0].contentType, /multipart\/form-data; boundary=/);
  assert.match(requests[0].body, /name="file"; filename="input.csv"/); assert.match(requests[0].body, /500/);
  await assert.rejects(runtime.performSpec({ ...spec, access: 'read' }, {}, resource), /registered write/);
  await writeFile(file, 'changed'); await assert.rejects(runtime.performSpec(spec, {}, resource), /content changed/);
  assert.equal(requests.length, 1);
});

test('explicit independent TPM/OA bindings preserve environment and write restrictions', async t => {
  const root = await temporary(t), iniPath = path.join(root, 'resources.ini');
  await writeFile(iniPath, ['TPM', 'OA'].map(platform => `[${platform}.Sit]\nplatform=${platform}\nenvironment=Sit\nstatus=configured\nai_access=allowed\nai_operation_mode=read\nresource_type=website\nbase_url=http://127.0.0.1:9\n`).join('\n'));
  const resources = await requirementResources({ name: 'SIT', platform: 'TPM', iniPath, resources: {
    tpm: { section: 'TPM.Sit', scope: 'read' }, oa: { platform: 'OA', section: 'OA.Sit', scope: 'full_crud' },
    wrong: { section: 'OA.Sit', scope: 'read' }, prd: { platform: 'OA', section: 'OA.Prd', scope: 'read' },
  } }, { allowUnavailable: true });
  assert.deepEqual(resources.names, ['tpm', 'oa']); assert.notEqual(resources.identity('tpm'), resources.identity('oa'));
  await assert.rejects(resources.assertWrite('oa', 'update'), { code: 'environment_scope' });
});

test('sidebar handoff resumes signed captured evidence and rejects mock substitution or cross-system sessions', async t => {
  const root = await temporary(t), keys = generateKeyPairSync('ed25519');
  const config = { publicKey: keys.publicKey.export({ type: 'spki', format: 'pem' }), provenance: 'controlled' };
  const scope = { workDir: root, reports: root, jobId: 'JOB-controlled', item: { caseId: 'C1' }, attempt: 1,
    environment: 'SIT', projectId: 'demo', resourceIdentity: resource => 'binding-' + resource };
  const action = { resource: 'tpm', action: 'inspect', origin: 'http://127.0.0.1' };
  await assert.rejects(sidebarHandoff(config, scope, action), { code: 'sidebar_handoff' });
  const reply = async (action, provenance = 'controlled', session = 'tpm-session') => {
    const request = JSON.parse(await readFile(path.join(root, 'sidebar-handoff/pending.json')));
    await writeFile(path.join(root, 'state.json'), '{"state":"submitted"}');
    const payload = { requestId: request.id, fingerprint: request.fingerprint, mode: 'codex_sidebar', provenance,
      hostSessionId: 'host-fixture', resourceSessionId: session, role: 'tester', identity: { userId: action.resource + '-tester' }, observedAt: new Date().toISOString(),
      files: [{ path: 'state.json', sha256: sha('{"state":"submitted"}'), sanitized: true }], data: { dom: 'submitted' } };
    await writeFile(path.join(root, 'sidebar-handoff', request.id + '.receipt.json'), JSON.stringify({ payload,
      signature: sign(null, Buffer.from(JSON.stringify(payload)), keys.privateKey).toString('base64') }));
    return sidebarHandoff(config, scope, action);
  };
  await assert.rejects(reply(action, 'real'), { code: 'sidebar_handoff' });
  assert.equal((await reply(action)).provenance, 'controlled');
  const oa = { ...action, resource: 'oa' };
  await assert.rejects(sidebarHandoff(config, scope, oa), { code: 'sidebar_handoff' });
  await assert.rejects(reply(oa), { code: 'sidebar_handoff' });
  assert.equal((await reply(oa, 'controlled', 'oa-session')).dom, 'submitted');
});

test('shared specimens survive case boundaries and dates, with immutable nodes and explicit release evidence', async t => {
  const root = await temporary(t), file = path.join(root, 'journal.json');
  let journal = { results: {} };
  const save = () => writeJson(file, journal);
  let samples = sampleLifecycle(journal, ['C1','C2'].map(caseId => ({ caseId })), 'JOB-shared', save);
  const registration = { id: 'shared', businessKey: 'AOS_JOB_shared_1', caseIds: ['C1','C2'],
    initialState: { status: 'open' }, budgetSnapshot: { reserved: 1000 }, initialEvidence: [{ path: 'initial.json' }],
    cleanupOwner: 'fixture', restoreValue: { status: 'open' } };
  await samples.register(registration);
  await assert.rejects(samples.register({ ...registration, id: 'alias' }), { code: 'sample_scope' });
  await assert.rejects(samples.register({ ...registration, id: 'unowned', businessKey: 'AUTO-unauthorized', resource: 'api',
    originMutationKey: 'missing', businessKeyField: ['id'] }), { code: 'sample_scope' });
  const mutation = { intent: { sampleId: 'shared' } };
  journal.results.C1 = { status: '通过' }; assert.equal(samples.retained(mutation), true);
  await samples.retain('shared', { reason: 'first closing date', continueAt: '2999-01-01T00:00:00Z', nextCondition: 'date reached', owner: 'fixture' });
  journal = await readJson(file); samples = sampleLifecycle(journal, ['C1','C2'].map(caseId => ({ caseId })), 'JOB-shared', save);
  assert.equal(samples.get('shared').budgetSnapshot.reserved, 1000);
  await assert.rejects(samples.release('shared', { actualState: {}, evidence: [{}] }), { code: 'sample_wait' });
  await samples.node('shared', 'close', { amount: 900 }, 'prepared');
  await assert.rejects(samples.node('shared', 'close', { amount: 800 }, 'prepared'), { code: 'sample_scope' });
  await assert.rejects(samples.retain('shared', { reason: 'approval', nextCondition: 'approved', owner: 'fixture' }), { code: 'sample_wait' });
  const clock = t.mock.method(Date, 'now', () => Date.parse('2999-01-02T00:00:00Z'));
  await samples.release('shared', { actualState: { status: 'approved' }, evidence: [{ path: 'approval.json' }] });
  clock.mock.restore();
  journal.results.C2 = { status: '通过' }; assert.equal(samples.retained(mutation), false);
  samples.get('shared').released = true;
  await assert.rejects(samples.node('shared', 'close', { amount: 900 }, 'prepared'), { code: 'sample_scope' });
  await assert.rejects(samples.register(registration), { code: 'sample_scope' });
});

test('trusted host receipt CLI validates captured bytes and signs without putting the private key in the receipt', async t => {
  const root = await temporary(t), keys = generateKeyPairSync('ed25519');
  const request = { id: 'request-one', fingerprint: 'fingerprint', mode: 'codex_sidebar', createdAt: new Date().toISOString() };
  const payload = { requestId: request.id, fingerprint: request.fingerprint, mode: request.mode, provenance: 'controlled',
    hostSessionId: 'fixture', resourceSessionId: 'fixture-tpm', role: 'tester', identity: { userId: 'test-user' }, observedAt: new Date().toISOString(),
    files: [{ path: 'proof.json', sha256: sha('{}'), sanitized: true }], data: { state: 'observed' } };
  const key = keys.privateKey.export({ type: 'pkcs8', format: 'pem' });
  await writeJson(path.join(root, 'request.json'), request); await writeJson(path.join(root, 'capture.json'), payload);
  await writeFile(path.join(root, 'private.pem'), key); await writeFile(path.join(root, 'proof.json'), '{}');
  const args = [new URL('../scripts/requirement-sidebar-receipt.mjs', import.meta.url), 'request.json', 'capture.json', 'private.pem', '.'];
  args[0] = (await import('node:url')).fileURLToPath(args[0]);
  await command(process.execPath, args, { cwd: root });
  const saved = await readFile(path.join(root, request.id + '.receipt.json'), 'utf8');
  assert.ok(!saved.includes('PRIVATE KEY'));
  assert.equal(JSON.parse(saved).payload.provenance, 'controlled');
  await writeFile(path.join(root, 'proof.json'), '{"tampered":true}');
  await assert.rejects(command(process.execPath, args, { cwd: root }), /Evidence bytes changed/);
});

test('process death after business write reconciles the same sample without a second side effect', async t => {
  const root = await temporary(t), adapterFile = path.join(root, 'adapter.mjs');
  const adapterSource = `import {readFile,writeFile} from 'node:fs/promises';
    import path from 'node:path';
    export async function prepare(){return {prerequisites:[]};}
    export async function execute(s){
      const file=path.join(s.workDir,'business.json');
      if(!s.samples.sample){
        await s.invoke({id:'create',resource:'api',operation:'create',target:'fixture',businessKey:s.runPrefix+'_one',beforeHash:'empty',cleanupAction:'remove fixture'},async()=>({observed:{id:'AUTO-1'},evidence:[{path:'creation.json'}]}));
        await s.sampleLifecycle.register({id:'sample',businessKey:'AUTO-1',resource:'api',originMutationKey:s.item.caseId+':create',businessKeyField:['id'],caseIds:['C1','C2'],initialState:{state:'open'},budgetSnapshot:{amount:1000},initialEvidence:[{path:'before.json'}],cleanupOwner:'fixture',restoreValue:{state:'open'}});
      }
      const intent={id:'submit',sampleId:'sample',nodeId:'submit',resource:'api',operation:'update',target:'document',businessKey:'AUTO-1',beforeHash:'before',cleanupAction:'remove fixture'};
      await s.invoke(intent,async()=>{const prior=await readFile(file,'utf8').then(JSON.parse).catch(()=>({count:0}));await writeFile(file,JSON.stringify({count:prior.count+1,state:'submitted'})); if(process.env.AOS_CRASH==='yes')process.exit(17);return {evidence:[{path:'after.json'}]};});
      return {status:'通过',actual:'controlled submitted',evidence:[{path:'after.json'}]};
    }
    export async function reconcile(s){const state=JSON.parse(await readFile(path.join(s.workDir,'business.json')));return {status:state.state==='submitted'?'applied':'uncertain',receipt:{observed:state,evidence:[{path:'readback.json'}]}};}
    export async function cleanup(s){return {verified:true,pending:[],evidence:[{path:'cleanup.json'}]};}`;
  await writeFile(adapterFile, adapterSource);
  const ini = path.join(root, 'test.ini');
  await writeFile(ini, '[Demo.Sit]\nstatus=configured\nenvironment=Sit\nai_access=allowed\nai_operation_mode=full_crud\n');
  const base = { job: { id: 'JOB-crash', status: 'running', projectId: 'demo', requirement: {} }, settings: {
    adapter: { path: adapterFile, sha256: sha(adapterSource) }, lockDirectory: path.join(root, 'locks'),
    environment: { name: 'SIT', platform: 'Demo', iniPath: ini, lockKey: 'fixture', resources: { api: { section: 'Demo.Sit', scope: 'full_crud' } } } },
    source: { id: 'fixture' }, index: [{ caseId: 'C1', row: 2 }, { caseId: 'C2', row: 3 }], manifest: { headers: ['预期结果'], rows: [['submitted'],['submitted']] },
    regression: { files: { 'references/execution-standard.md': '', 'SKILL.md': '' } }, workDir: root, reportDir: root, dataDir: root };
  await writeJson(path.join(root, 'args.json'), base);
  const script = path.join(root, 'child.mjs');
  await writeFile(script, `import {readFile,writeFile} from 'node:fs/promises';
    import {executeCases} from ${JSON.stringify(new URL('../src/runner/requirement-execution.js', import.meta.url).href)};
    import {withSnapshotLock} from ${JSON.stringify(new URL('../src/shared/snapshot-lock.js', import.meta.url).href)};
    const b=JSON.parse(await readFile(${JSON.stringify(path.join(root,'args.json'))}));
    const file=${JSON.stringify(path.join(root,'journal.json'))};
    await withSnapshotLock(b.workDir, async()=>{
    const journal=await readFile(file,'utf8').then(JSON.parse).catch(()=>({publication:{version:'v1'},startedAt:new Date().toISOString()}));
    await executeCases({...b,journal,save:()=>writeFile(file,JSON.stringify(journal)),progress:async()=>{}});});`);
  await assert.rejects(command(process.execPath, [script], { env: { ...process.env, AOS_CRASH: 'yes' } }), error => error.code === 17);
  const before = await readJson(path.join(root,'journal.json'));
  assert.equal(before.mutations.find(item=>item.intent.sampleId).phase, 'prepared');
  await Promise.all([1,2].map(()=>command(process.execPath, [script], { env: { ...process.env, AOS_CRASH: 'no' } })));
  const after = await readJson(path.join(root,'journal.json'));
  assert.equal(after.mutations.find(item=>item.intent.sampleId).reconciled, true);
  assert.equal((await readJson(path.join(root,'business.json'))).count, 1);
  assert.equal(Object.keys(after.results).length, 2);
  assert.equal(after.samples.sample.nodes.submit.phase, 'applied');
  const cancelled = await runRequirementTest({ id: 'JOB-crash', status: 'cancelled', requirement: {} }, { dataDir: root }, async()=>assert.fail('Cancelled job must not execute'));
  assert.equal(cancelled.requirementWait, 'requirement_cancelled');
});

test('deployment accepts a proven ancestor and scopes a missing fix to the dependent case', async t => {
  const root = await temporary(t);
  const git = args => command('git', ['-C', root, ...args]).then(value => value.trim());
  await git(['init', '-b', 'test']);
  const commit = async name => { await git(['-c','user.name=Fixture','-c','user.email=fixture@example.invalid','commit','--allow-empty','-m',name]);return git(['rev-parse','HEAD']); };
  const fix = await commit('fix'), deployed = await commit('deployed'), newer = await commit('not deployed');
  const bytes = Buffer.from('controlled artifact'), source = { id: 'req', revision: 1, hash: 'source' };
  const config = { releaseManifest: { path: path.join(root,'release.json'), components: { web: { resource: 'api', path: '/version', repository: 'repo' } } },
    caseReleases: { C1: { component: 'web', requiredCommits: [fix] }, C2: { component: 'web', requiredCommits: [newer] } } };
  const receipt = await verifyRequirementRelease(config, { projectId: 'demo', environment: 'SIT', source, sourceRoot: root,
    repositories: [{ name: 'repo', path_or_url: root, commit: newer, branch: 'test' }] }, async () => bytes,
    async () => ({ manifest: { version: 1, projectId: 'demo', environment: 'SIT', releases: { req: { ...source, sourceHash: source.hash,
      validUntil: '2999-01-01', components: { web: { commit: deployed, sha256: sha(bytes) } } } } } }));
  assert.equal(receipt.verified, true);
  const requirement = caseId => caseReleaseRequirement({caseId}, [], [], config.caseReleases);
  assert.equal(matchesCaseRelease(requirement('C1'), receipt), true);
  assert.equal(matchesCaseRelease(requirement('C2'), receipt), false);
  assert.equal(receipt.proof[0].source.commit, newer); assert.equal(receipt.proof[0].commit, deployed);
});

test('topic feedback separates product confirmation from developer claims and versions preserve old results', async t => {
  const root = await temporary(t), job = { id: 'JOB-feedback', chatId: 'chat', requirement: { root: 'root', threadId: 'thread' } };
  const settings = { bot: { profile: 'bot' }, feedback: { roles: { product: 'product', dev: 'developer' } } };
  const messages = [ ['root','dev','fixed'], ['confirmation','product','验收确认 CASE-A 财年累计'] ].map(([id,author,text]) => ({
    message_id:id, root_id:'root',chat_id:'chat',sender:{id:author},create_time:'100',body:{content:JSON.stringify({text})} }));
  messages.push({ message_id: 'attachments', root_id: 'root', chat_id: 'chat', sender: { id: 'dev' }, create_time: '101',
    body: { content: JSON.stringify({ zh_cn: { title: '开发交接', content: [[{ tag: 'text', text: '需复测' },
      { tag: 'img', image_key: 'image' }, { tag: 'file', file_key: 'file', file_name: 'handoff.md' }]] } }) } });
  await writeFile(path.join(root, 'attachment-fixture'), 'controlled handoff');
  const feedback = await collectTopicFeedback({ readThread: async () => messages,
    downloadMessageResource: async (_job, _message, _key, type, options) => {
      assert.ok(['file', 'image'].includes(type)); assert.equal(options.profile, 'bot'); return { path: path.join(root, 'attachment-fixture') };
    } }, job, settings, root);
  assert.equal(feedback.records.find(x => x.messageId === 'attachments').attachments.length, 2);
  assert.equal(feedback.records.find(x=>x.author==='dev').kind,'developer_statement');
  const source = { hash:'old' }, current = { hash:'new', feedback };
  const journal = { results: { 'CASE-A': { status:'通过', evidence:[{path:'old.json'}] } }, artifact:{sha256:'oldreport'} };
  await assert.rejects(archiveExecutionVersion({journal,source,current,job,workDir:root,save:async()=>{}}), {code:'requirement_version'});
  job.requirement.revisionRequest = { sourceHash:'new',caseIds:['CASE-A'],messageId:'approval' };
  await archiveExecutionVersion({journal,source,current,job,workDir:root,save:async()=>{}});
  assert.equal(journal.executionVersion,2); assert.equal(journal.versionHistory[0].results['CASE-A'].status,'通过');
  assert.equal((await readJson(path.join(root,'versions/1/journal.json'))).artifact.sha256,'oldreport');
});

test('a crash during execution-version transition replays the archived inputs without losing old results', async t => {
  const root = await temporary(t), journal = { results: { C1: { status: '通过', evidence: [{ path: 'old.json' }] } } };
  const current = { hash: 'new', feedback: { records: [{ messageId: 'product', kind: 'acceptance_confirmation', text: '验收确认 C1 新口径' }] } };
  const job = { requirement: { revisionRequest: { sourceHash: 'new', caseIds: ['C1'] } } };
  await assert.rejects(archiveExecutionVersion({ journal, source: { hash: 'old' }, current, job, workDir: root,
    save: async () => { throw new Error('controlled process death'); } }), /controlled process death/);
  assert.ok(journal.revisionTransition);
  await recoverExecutionVersion(journal, root, async () => {});
  await recoverExecutionVersion(journal, root, async () => {});
  assert.equal(journal.executionVersion, 2);
  assert.equal(journal.versionHistory.length, 1);
  assert.equal(journal.reuseCandidates.results.C1.evidence[0].path, 'old.json');
  assert.equal((await readJson(path.join(root, 'requirement.json'))).hash, 'new');
});

test('TPM 15.1 configuration carries separate rejection, fiscal boundaries and every two-ledger node (controlled only)', async t => {
  const root = await temporary(t), example = JSON.parse(await readFile(new URL('../config/tpm-15.1-chain.example.json', import.meta.url)));
  assert.equal(example.evidenceScope, 'example_not_uat');
  const [reject, duplicate, exact, over, closing] = example.cases;
  assert.equal(reject.reserved - reject.refund, 0);
  assert.equal(duplicate.automaticRetryExists, false);
  assert.equal(duplicate.missingEvidenceVerdict, '失败');
  assert.equal(exact.startBalance, over.startBalance);
  for (const item of [exact, over]) {
    assert.equal(item.startBalance >= item.request, item.expectedAccepted);
    assert.equal(item.startBalance - (item.expectedAccepted ? item.request : 0), item.expectedRemaining);
  }
  const journal = { results: {} }, samples = sampleLifecycle(journal, [{ caseId: closing.id }], 'JOB-config', async()=>{});
  await samples.register({ id: closing.sample, businessKey: 'controlled-1', caseIds: [closing.id], initialState: 'open',
    budgetSnapshot: { reserved: closing.initialReserved }, initialEvidence: [{ path: 'initial.json' }], cleanupOwner: 'fixture', restoreValue: 'open' });
  let reserved = closing.initialReserved, paid = 0, refunded = 0;
  for (const node of closing.nodes) {
    const receipt = { observed: { state: node.state, reserved: node.remaining, paid: node.paid, eventId: 'controlled-' + node.id },
      evidence: [{ path: node.id + '.json', sanitized: true }] };
    await writeJson(path.join(root, node.id + '.json'), { provenance: 'controlled', ...receipt.observed, delta: node.refund });
    await samples.node(closing.sample, node.id, node, 'prepared');
    const newPaid = node.paid - paid;
    reserved -= node.refund + newPaid; refunded += node.refund; paid = node.paid;
    assert.equal(reserved, node.remaining);
    await samples.node(closing.sample, node.id, node, 'applied', receipt);
    await samples.node(closing.sample, node.id, node, 'prepared');
    assert.equal(samples.get(closing.sample).nodes[node.id].phase, 'applied');
  }
  assert.equal(refunded + paid + reserved, closing.initialReserved);
  assert.equal(Object.keys(samples.get(closing.sample).nodes).length, closing.nodes.length);
});

async function deliveryFixture(t) {
  const root = await temporary(t);
  await writeFile(path.join(root,'observation.json'), '{"event":"controlled","amount":200}');
  const job = { id:'JOB-delivery' }, journal = { results:{ C1:{ status:'通过',validationScope:'controlled',evidence:[{path:'observation.json',sanitized:true}] } } };
  const artifact = await buildEvidenceBundle({job,journal,reportDir:root,dataDir:root,checkOutput:x=>x});
  const second = await buildEvidenceBundle({job,journal,reportDir:root,dataDir:root,checkOutput:x=>x});
  const destination = {rootId:'root',chatId:'chat',profile:'app-profile',appId:'app',openId:'bot'};
  const state = {jobs:[{id:job.id,status:'completed',result:{outcome:'ready',requirementDelivery:{version:1,artifacts:[artifact,second]}}}],
    requirementDeliveries:{out:{jobId:job.id,version:1,destination,parts:[{text:'受控验证：一条通过，真实 UAT 未执行。'}, {artifact}, {artifact:second}]}}};
  const messages=new Map(), keys=new Map(), sends=[], downloads=[];
  const controls={failAt:0,lostAt:0,wrongText:false,wrongFile:false,wrongThread:false};
  const send=async (rootId,value,options,file)=>{
    assert.equal(rootId,'root');assert.equal(options.profile,'app-profile');assert.equal(options.replyInThread,true);
    if(keys.has(options.idempotencyKey))return {message_id:keys.get(options.idempotencyKey)};
    const nth=sends.length+1;
    if(controls.failAt===nth){controls.failAt=0;throw new Error('controlled send failure');}
    const id='message-'+nth; keys.set(options.idempotencyKey,id);sends.push({id,options,file});
    messages.set(id,{message_id:id,root_id:'root',thread_id:'thread',chat_id:'chat',sender:{sender_type:'app',id:'app'},
      body:{content:JSON.stringify(file?{file_key:id,file_name:path.basename(value)}:{text:value})},file:file?value:null});
    if(controls.lostAt===nth){controls.lostAt=0;throw new Error('controlled response loss');}
    return {message_id:id};
  };
  const context={config:{dataDir:root},store:{read:async()=>structuredClone(state),transact:async fn=>fn(state)},feishu:{
    reply:(id,text,options)=>send(id,text,options,false),replyFile:(id,file,options)=>send(id,file,options,true),
    readMessage:async id=>{
      if(id==='root')return {message_id:'root',chat_id:'chat',thread_id:'thread'};
      const result=structuredClone(messages.get(id));
      if(controls.wrongText&&id==='message-1')result.body.content=JSON.stringify({text:'truncated'});
      if(controls.wrongThread)result.root_id='another-root';
      return result;
    },downloadMessageResource:async (jobId,id,key,type,options)=>{
      assert.equal(options.profile,'app-profile');downloads.push(id);
      return {path:controls.wrongFile?path.join(root,'observation.json'):messages.get(id).file};
    },
  }};
  return {context,state,sends,controls,downloads};
}

test('bundle outbox reads back the complete conclusion and every attachment as the original app', async t=>{
  const f=await deliveryFixture(t);const receipt=await deliverRequirementBundle(f.context,'out');
  assert.equal(f.state.requirementDeliveries.out.verified,true);assert.equal(f.sends.length,3);assert.equal(f.downloads.length,2);
  assert.ok(f.state.requirementDeliveries.out.parts.every(x=>x.readback&&x.link));
  assert.equal(receipt.messages.length,3);assert.ok(receipt.messages.every(message=>message.link.includes('message_id=')));
  assert.deepEqual(f.state.jobs[0].requirementDeliveryReceipt,receipt);
  assert.deepEqual(await deliverRequirementBundle(f.context,'out'),receipt);assert.equal(f.sends.length,3);
});

test('a cancelled job cannot resume an old requirement delivery', async t=>{
  const f=await deliveryFixture(t);f.state.jobs[0].status='cancelled';
  await deliverRequirementBundle(f.context,'out');
  assert.equal(f.sends.length,0);assert.equal(f.state.requirementDeliveries.out.superseded,true);
});

test('partial send and lost response recover only missing pieces using stable idempotency', async t=>{
  const f=await deliveryFixture(t);f.controls.failAt=3;
  await assert.rejects(deliverRequirementBundle(f.context,'out'),/send failure/);
  assert.equal(f.sends.length,2);assert.equal(f.state.requirementDeliveries.out.parts[1].verified,true);
  f.controls.lostAt=3;await assert.rejects(deliverRequirementBundle(f.context,'out'),/response loss/);
  assert.equal(f.sends.length,3);assert.equal(f.state.requirementDeliveries.out.verified,undefined);
  await deliverRequirementBundle(f.context,'out');assert.equal(f.sends.length,3);assert.equal(f.state.requirementDeliveries.out.verified,true);
});

test('readback mismatch never marks delivery complete and retry does not duplicate an existing message', async t=>{
  const f=await deliveryFixture(t);f.controls.wrongText=true;
  await assert.rejects(deliverRequirementBundle(f.context,'out'),/incomplete/);assert.equal(f.sends.length,1);
  f.controls.wrongText=false;f.controls.wrongFile=true;
  await assert.rejects(deliverRequirementBundle(f.context,'out'),/bytes mismatch/);assert.equal(f.sends.length,2);
  f.controls.wrongFile=false;f.controls.wrongThread=true;
  await assert.rejects(deliverRequirementBundle(f.context,'out'),/thread mismatch/);
  f.controls.wrongThread=false;await deliverRequirementBundle(f.context,'out');assert.equal(f.sends.length,3);
});

test('known credentials in artifacts are rejected before packaging',async t=>{
  const root=await temporary(t);await writeFile(path.join(root,'bad.json'),'fixture-private-credential');
  await assert.rejects(buildEvidenceBundle({job:{id:'JOB-secrets'},journal:{results:{C:{evidence:[{path:'bad.json',sanitized:true}]}}},
    reportDir:root,dataDir:root,checkOutput:value=>{if(JSON.stringify(value).includes('fixture-private-credential'))throw new Error('credential detected');return value;}}),/credential detected/);
});

test('browser multipart upload uses its registered write effect and rejects altered parameters',async t=>{
  const root=await temporary(t);let uploads=0;
  const server=createServer(async(req,res)=>{
    if(req.url==='/import') {for await(const chunk of req){} uploads++;res.setHeader('content-type','application/json');return res.end('{"imported":1}');}
    res.setHeader('content-type','text/html');res.end(`<input id="file" type="file" onchange="const f=new FormData();f.append('scope','isolated');f.append('file',this.files[0]);fetch('/import',{method:'POST',body:f})">`);
  });
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));t.after(()=>new Promise(resolve=>server.close(resolve)));
  const resource={base_url:'http://127.0.0.1:'+server.address().port};
  const runtime=createAgentResources({uploadDirectories:[root]},{state:{operations:{}},useRead:(_,fn)=>fn(resource)});t.after(()=>runtime.close());
  const file={path:path.join(root,'sample.csv'),sha256:sha('500'),type:'text/csv'};await writeFile(file.path,'500');
  await runtime.browser({resource:'tpm',action:'goto',path:'/'});
  const spec={resource:'tpm',kind:'browser',access:'create',action:'upload',selector:'#file',file,
    effect:{path:'/import',method:'POST',multipart:{fields:{scope:'isolated'},files:[{...file,field:'file'}]}}};
  const result=await runtime.performSpec(spec,{},resource);assert.equal(result.body.imported,1);assert.equal(uploads,1);
  await runtime.browser({resource:'tpm',action:'goto',path:'/'});
  await assert.rejects(runtime.performSpec({...spec,effect:{...spec.effect,multipart:{...spec.effect.multipart,fields:{scope:'different'}}}}, {},resource));
  assert.equal(uploads,1);
});

test('runtime gateway evidence becomes a revalidated sourceRef without replacing implementation proof',async t=>{
  const root=await temporary(t);let route='/business';
  const server=createServer((req,res)=>{res.setHeader('content-type','application/json');res.end(JSON.stringify({route}));});
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));t.after(()=>new Promise(resolve=>server.close(resolve)));
  await writeFile(path.join(root,'service.js'),"// GET /routes reads config; POST /business imports a scoped object; GET /business reads it\n");
  let verified=false;
  const agent=createRequirementAgent({}, {workDir:root,review:async()=>({accepted:true,errors:[]}),agentModel:async({call})=>({close:async()=>{},turn:async()=>{
    const run=(name,args)=>call('test_'+name,{args});
    const source=await run('source',{action:'read',path:'service.js'});
    await run('register',{name:'route_config',sourceRefs:[source.sourceRef],reason:'controlled source',spec:{resource:'api',kind:'http',access:'read',method:'GET',path:'/routes',authenticated:false}});
    const observed=await run('observe',{operation:'route_config'});
    const runtime=await run('source',{action:'runtime',observationId:observed.observationId,field:['body','route']});
    const spec={resource:'api',kind:'http',access:'read',method:'GET',path:'/business',authenticated:false};
    await assert.rejects(run('register',{name:'business_only',sourceRefs:[runtime.sourceRef],reason:'not enough',spec}),/implementation source/);
    await run('register',{name:'business_read',sourceRefs:[source.sourceRef,runtime.sourceRef],reason:'gateway and implementation',spec});
    route='/changed';
    await assert.rejects(run('observe',{operation:'business_read'}),/source changed/);
    verified=true;throw new Error('controlled end');
  }})});
  await assert.rejects(agent.execute({item:{caseId:'C'},attempt:1,reports:root,headers:['预期结果'],row:['1. actual business state'],
    source:{},sourceRoot:root,resourceNames:['api'],resourceIdentity:()=> 'resource-binding',resourceCatalog:{api:{}},
    mutations:[],checkOutput:x=>x,progress:async()=>{},standards:'',useRead:(_,fn)=>fn({base_url:'http://127.0.0.1:'+server.address().port})}),/controlled end/);
  assert.equal(verified,true);
});
