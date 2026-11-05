import {CloudFiles} from './cloud-files.js';
import {validateRetainedRequest,expiredMessage} from '../shared/retention.js';
import {RetentionService} from './retention.js';
import {ControlReceipts,CONTROL_PROTOCOL,criticalControl,controlDigest,validRequestId} from '../shared/control-receipts.js';
import {ContactChannels} from './contact-channels.js';
import {isPrivate,cardDestination} from './private-cards.js';
import {ContactDirectory} from './contact-directory.js';
import {ReportDelivery} from './report-delivery.js';
import {reportFile,validateReportFiles} from '../shared/report-files.js';
import { TeamKnowledgeService } from './team-knowledge.js';
import { queryRejection } from '../shared/query-repair.js';
import { enrollmentTarget } from './environment-enrollment.js';
import { SharedChromeBrowser } from './shared-chrome-browser.js';
import { WebsiteBrowser } from './website-browser.js';
import { prepareWebsiteQuery } from './website-query.js';
import { WebsiteCredentialService } from './website-credentials.js';
import { loadEnvironments, planQuery, verifyApprovedPlan, verifyCompletedPlan } from '../shared/environment-access.js';
import { publishQuestion, questionJob, questionView } from './questions.js';
import http from 'node:http';
import { createReadStream } from 'node:fs';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { controlConfig, loadAgents, loadProjects, saveProjects } from './config.js';
import { FeishuClient, parseFeishuMessage } from './feishu.js';
import { LarkCliFeishuClient } from './lark-cli.js';
import { JsonStore } from '../shared/store.js';
import { environmentContinuation } from '../shared/investigation-review.js';
import { nextStage, routeInstruction, routeInstructionForStage, stageLabel } from '../shared/protocol.js';

import { loadConversationSettings } from './conversation-settings.js';
import { loadMemorySettings } from './memory.js';
import { ConversationService, splitReply, responseMessageId } from './conversations.js';
import { LiveCards } from './live-cards.js';
import { jobCard, resultSummary } from './message-cards.js';
import { handleCardAction } from './card-actions.js';
import { jobTerminalMention } from './requester-mention.js';
import { adminOverview, adminRecordDetail, adminRecords } from './admin-view.js';
import { CODEX_MODELS, CODEX_REASONING_EFFORTS, loadCodexRuntimeSettings, saveCodexRuntimeSettings } from '../shared/codex-runtime.js';
import { handleRequirementMessage, validateRequirementRoutes } from './requirement-testing.js';

const adminDirectory = fileURLToPath(new URL('./admin/', import.meta.url));

export async function createControlPlane(overrides = {}) {
  const config = controlConfig(overrides);
  await loadEnvironments();
  const projects = overrides.projects ?? await loadProjects(config.projectsFile);
  const agents = overrides.agents ?? await loadAgents(config.agentsFile);
  const requirementRoutes = validateRequirementRoutes(projects, agents);
  if (requirementRoutes.size && config.feishu.transport !== 'lark-cli') {
    throw new Error('Requirement testing requires verified local Feishu event sources');
  }
  const store = new JsonStore(config.storeFile);
  await store.reconcileLegacyResults();
  await store.reconcileInvestigationState(agents.agents?.owner_intake?.profile ?? null);
  await store.reconcileReadOnlyApprovals();
  const feishu = overrides.feishuClient ?? (config.feishu.transport === 'lark-cli'
    ? new LarkCliFeishuClient({ ...config.feishu, dataDir: config.dataDir })
    : new FeishuClient({ ...config.feishu, dataDir: config.dataDir }));

  const authorizeBrowser = async (initial,waiting,request)=>{const current=await store.getJob(initial.id);if(current?.status==='awaiting_clarification'&&current?.result?.browserLoginRequired){const type=request.resourceType();const tail=new URL(request.url()).pathname.split('/').at(-1);return type==='document'||['script','stylesheet','image','font'].includes(type)||/^(login|signin|authenticate|auth|captcha|verify)$/i.test(tail);}if(current?.status!=='running')return false;verifyApprovedPlan(await loadEnvironments(),current.environmentAccess);return true;};
  const browserMode = process.env.AGENTOS_BROWSER_MODE ?? (process.platform === 'darwin' ? 'shared-chrome' : 'isolated');
  if (!['shared-chrome','isolated'].includes(browserMode)) throw new Error('Invalid AGENTOS_BROWSER_MODE');
  const context = { config, projects, agents, store, feishu, requirementRoutes, adminSessionToken: randomBytes(32).toString('base64url'),
    websiteBrowser: overrides.websiteBrowser ?? (browserMode === 'shared-chrome' ? new SharedChromeBrowser(authorizeBrowser) : new WebsiteBrowser(config.dataDir,undefined,authorizeBrowser)) };
  context.cloudFiles=overrides.cloudFiles??new CloudFiles(context);
  context.controlReceipts=new ControlReceipts(store);
  context.contacts = overrides.contactService ?? new ContactDirectory(context, { file: config.contactsFile });
  context.knowledge = overrides.knowledgeService ?? new TeamKnowledgeService(context, { file: config.knowledgeFile });
  context.websiteCredentials = overrides.websiteCredentials ?? new WebsiteCredentialService(context);
  context.contactChannels=overrides.contactChannels??new ContactChannels(context,{file:config.contactChannelsFile});
  const cards = new LiveCards(store, feishu, {authorizeDestination:(d,e)=>context.contactChannels.verifyDestination(d,e)});
  context.cards = cards;
  context.reports=new ReportDelivery(context);cards.afterRetry=state=>context.reports.retry(state);
  context.notifyJobEvent = (result) => notifyJobEvent(context, result);
  // Upgrade previously sent owned job cards in place; never create or execute a task during migration.
  if (cards.enabled) await store.transact((state) => {
    for (const job of state.jobs) {
      const attempt = job.events.filter((e) => e.type === 'started').at(-1)?.id ?? 'first';
      const saved = state.cardMessages?.[`job:${job.id}:${attempt}`];
      if (!saved?.messageId || saved.actionsVersion === 2 || saved.destination.profile !== job.agentProfile) continue;
      saved.card = jobCard(job);
      saved.terminal = !['queued', 'running', 'cancelling'].includes(job.status);
      saved.revision++;
      saved.actionsVersion = 2;
      saved.updatedAt = new Date().toISOString();
    }
  });
  const conversations = new ConversationService(context, { ...await loadConversationSettings(config.conversationFile), memorySettings: await loadMemorySettings(config.memoryFile), ...overrides.conversationOptions, decide: overrides.conversationResponder });
  context.conversations = conversations;
  context.retention=new RetentionService(context);
  // Finish startup retention before recovering old card/report/knowledge outboxes.
  await context.retention.run().catch(()=>{});
  const server = http.createServer(async (request, response) => {
    try {
      if(!await durableControl(context,request,response))await route({ ...context, request, response });
    } catch (error) {
      console.error('[control-plane]', error);
      if (!response.headersSent) json(response, error.statusCode ?? 500, { ok: false, error: error.message });
      else response.destroy();
    }
  });

  server.once('listening', () => {
    context.retention.start({initial:false});
    cards.start();
    context.reports.recover().catch(()=>console.error('[report] recovery unavailable'));
    repairStaleTerminalQuestionCards(context).catch((error) => console.error('[card-repair]', error.message));
    context.knowledge.recover().catch(() => console.error('[knowledge] recovery unavailable'));
    conversations.start().catch((error) => console.error('[conversation-start]', error.message));
  });
  server.once('close', () => { cards.stop();void (async()=>{await context.retention.close();await Promise.allSettled([conversations.stop(),context.reports.close(),context.websiteBrowser.close(),context.knowledge.close()]);})(); });
  return { server, config, projects, agents, store, requirementRoutes, conversations, cards, retention:context.retention };
}

export async function repairStaleTerminalQuestionCards(context) {
  const state = await context.store.read(), repairs = [];
  const terminalLabels = { cancelled: '已取消', failed: '执行失败', blocked: '任务受阻', completed: '当前阶段已完成' };
  for (const [key, saved] of Object.entries(state.cardMessages ?? {})) {
    if (!key.startsWith('question:') || !saved.messageId) continue;
    const questionId = key.slice('question:'.length), job = questionJob(state, questionId);
    if (!job || !['completed', 'blocked', 'failed', 'cancelled'].includes(job.status)) continue;
    const serialized = JSON.stringify(saved.card ?? {});
    const header = saved.card?.header?.subtitle?.content ?? saved.card?.header?.title?.content ?? '';
    if (!/"action":"(?:cancel|refresh)"/.test(serialized) && header.includes(terminalLabels[job.status])) continue;
    if (saved.terminalMention && !saved.terminalMention.kind) {
      const view = questionView(state, questionId, context.projects);
      repairs.push(context.cards.upsert(key, view.card, view.destination, { terminal: true, immediate: true,
        resultText: view.resultText, terminalMention: saved.terminalMention, generation: saved.generation ?? 1 }));
    } else repairs.push(publishQuestion(context, questionId));
  }
  const results = await Promise.allSettled(repairs);
  const failed = results.find((result) => result.status === 'rejected');
  if (failed) throw failed.reason;
  return repairs.length;
}

async function route(context) {
  const { request, response, config, store } = context;
  const url = new URL(request.url, `http://${request.headers.host ?? 'localhost'}`);

  if (request.method === 'GET' && ['/admin', '/admin/'].includes(url.pathname)) {
    return serveAdmin(context, response, 'index.html', true);
  }
  const assetMatch = url.pathname.match(/^\/admin\/(app\.js|styles\.css)$/);
  if (request.method === 'GET' && assetMatch) return serveAdmin(context, response, assetMatch[1]);

  if (request.method === 'GET' && url.pathname === '/api/v1/admin/overview') {
    requireAdminSession(context, request, false);
    const state = await store.read();
    const runtime = await loadCodexRuntimeSettings({ file: config.codexRuntimeFile });
    return json(response, 200, { ok: true, overview: adminOverview(state,
      { ...runtime, runnerConcurrency: Number(process.env.AGENTOS_RUNNER_CONCURRENCY ?? 3) }) }, { 'cache-control': 'no-store' });
  }
  if (request.method === 'GET' && url.pathname === '/api/v1/admin/records') {
    requireAdminSession(context, request, false);
    const state = await store.read();
    return json(response, 200, { ok: true, records: adminRecords(state, {
      kind: url.searchParams.get('kind'), status: url.searchParams.get('status'),
      search: url.searchParams.get('q'), limit: url.searchParams.get('limit'),
    }) }, { 'cache-control': 'no-store' });
  }
  const adminRecordMatch = url.pathname.match(/^\/api\/v1\/admin\/records\/([^/]+)$/);
  if (request.method === 'GET' && adminRecordMatch) {
    requireAdminSession(context, request, false);
    const record = adminRecordDetail(await store.read(), decodeURIComponent(adminRecordMatch[1]));
    return record ? json(response, 200, { ok: true, record }, { 'cache-control': 'no-store' })
      : json(response, 404, { ok: false, error: 'Record not found' });
  }
  if (request.method === 'GET' && url.pathname === '/api/v1/admin/settings/runtime') {
    requireAdminSession(context, request, false);
    const runtime = await loadCodexRuntimeSettings({ file: config.codexRuntimeFile });
    return json(response, 200, { ok: true, runtime, models: CODEX_MODELS, efforts: CODEX_REASONING_EFFORTS }, { 'cache-control': 'no-store' });
  }
  if (request.method === 'GET' && url.pathname === '/api/v1/admin/browser-health') {
    requireAdminSession(context, request, false);
    if (typeof context.websiteBrowser.health !== 'function') return json(response, 200, { ok: true, mode: 'isolated' }, { 'cache-control': 'no-store' });
    try {
      const status = await context.websiteBrowser.health();
      return json(response, 200, { ok: true, mode: 'shared-chrome', running: status.running, windows: status.windows }, { 'cache-control': 'no-store' });
    } catch {
      return json(response, 200, { ok: false, mode: 'shared-chrome', code: 'BROWSER_BRIDGE' }, { 'cache-control': 'no-store' });
    }
  }
  if (request.method === 'PUT' && url.pathname === '/api/v1/admin/settings/runtime') {
    requireAdminSession(context, request, true);
    const before = await loadCodexRuntimeSettings({ file: config.codexRuntimeFile });
    const after = await saveCodexRuntimeSettings(await readJson(request, 16 * 1024), { file: config.codexRuntimeFile });
    await store.recordAdminAudit({ actor: 'local-console', action: 'runtime_settings_changed', before, after });
    return json(response, 200, { ok: true, runtime: after,
      message: '已保存。新任务和新会话使用新设置，正在执行的任务不受影响。' }, { 'cache-control': 'no-store' });
  }

  if(request.method==='POST' && url.pathname==='/api/v1/admin/source-snapshots/prune'){
    if(request.headers.authorization)requireBearer(request,config.adminToken,'admin');else requireAdminSession(context,request,true);const body=await readJson(request);
    const results=await context.retention.collectSnapshots({apply:body.apply===true});return json(response,200,{ok:true,results});
  }

  if (request.method === 'GET' && url.pathname === '/health') {
    return json(response, 200, { ok: true, service: 'agentos-control-plane', conversationEngine: 'codex', conversationProtocol: 3,
      conversationScope: 'question-profile-project-v2',
      questionCards: context.conversations.questionCards, environmentAccessPolicy: 'scoped-read-auto-v2',
      requirementProjects: [...context.requirementRoutes.values()].map(route => ({
        projectId: route.projectId, environment: route.test.environment?.name ?? null,
        executionAdapterConfigured: Boolean(route.test.adapter || route.test.execution),
        executionMode: route.test.execution?.mode ?? (route.test.adapter ? 'adapter' : 'catalog'),
        executionProtocol: route.test.execution?.mode === 'agent' ? 'native-tools-ledger-v1' : 'catalog-v1',
        releaseManifestConfigured: Boolean(route.test.execution?.releaseManifest?.path),
        releaseRequiredComponents: Object.keys(route.test.execution?.releaseManifest?.components ?? {}).length,
        releaseEvidencePolicy: 'case-scoped',
      })),
      investigationConvergence: 'evidence-progress-v1', stateStorage: 'bounded-context-json-v1',
      controlRequestProtocol: CONTROL_PROTOCOL, stateReadPolicy:'stat-cache-detached-v1', stateProjectionPolicy:'detached-select-singleflight-v1',retention:context.retention.status(),stateReads:store.readMetrics,processMemory:{rssBytes:process.memoryUsage().rss,heapUsedBytes:process.memoryUsage().heapUsed,heapTotalBytes:process.memoryUsage().heapTotal}, pendingControlRequests:context.controlReceipts.pending.size, stateTransaction:store.lastTransaction??null,
      memoryPolicy: 'question-native-or-sender-extractive-v2', memoryStatus: context.conversations.memory.status,
      conversationTransport: 'app-server-stdio', conversationConcurrency: context.conversations.concurrency,
      messagePresentation: context.cards?.enabled ? 'live-cards-v1' : 'text', cardActions: 'v1-lease-fenced',
      analysisWorkflow: 'continuous-developer-tools-v2', runnerConcurrency: Number(process.env.AGENTOS_RUNNER_CONCURRENCY ?? 3), sourcePolicy: 'folder-evidence-v1', analysisSourcePolicy: 'origin-ff-before-analysis-v1', analysisSnapshotPolicy: 'isolated-environment-source-v1', analysisSourceCachePolicy:'immutable-project-environment-commit-v1',
      resultPresentation: 'analysis-adaptive-tables-v4', identityPolicy: 'profile-linked-human-v1',
      executionPolicy: 'admin-write-members-analysis-v1', harnessPolicy: 'standard-handoff-v1', now: new Date().toISOString() });
  }

  if (request.method === 'POST' && url.pathname === '/webhooks/feishu') {
    const body = await readJson(request);
    if (!verifyFeishu(body, config.feishu.verificationToken)) return json(response, 403, { ok: false });
    if (body.challenge) return json(response, 200, { challenge: body.challenge });
    json(response, 200, { code: 0 });
    setImmediate(() => handleFeishuEvent(context, body).catch((error) => console.error('[feishu-event]', error)));
    return;
  }

  if (request.method === 'POST' && url.pathname === '/api/v1/dev/messages') {
    requireBearer(request, config.adminToken, 'admin');
    const body = await readJson(request);
    const created = await createJobFromMessage(context, {
      messageId: body.messageId,
      chatId: body.chatId,
      senderId: body.senderId ?? 'local-user',
      projectId: body.projectId,
      text: body.text,
      resources: [],
    });
    return json(response, created.duplicate ? 200 : 201, { ok: true, ...created });
  }

  if (request.method === 'POST' && url.pathname === '/api/v1/events/lark-cli') {
    requireBearer(request, config.adminToken, 'admin');
    const body = await readJson(request);
    const created = await handleLarkCliEvent(context, body);
    return json(response, created?.duplicate ? 200 : 201, { ok: true, ...(created ?? {}) });
  }

  if (request.method === 'POST' && url.pathname === '/api/v1/events/card-action') {
    requireBearer(request, config.adminToken, 'admin');
    const result = await handleCardAction(context, await readJson(request));
    return json(response, 200, result);
  }

  const environmentMatch = url.pathname.match(/^\/api\/v1\/jobs\/([^/]+)\/environment-claim$/);
  if (request.method === 'POST' && environmentMatch) {
    requireBearer(request, config.runnerToken, 'runner');
    const body=await readJson(request);const result=await commitControl(context,async()=>({ok:true,plan:await store.claimEnvironment(decodeURIComponent(environmentMatch[1]),body)}));
    return json(response,200,result);
  }

  const controlMatch = url.pathname.match(/^\/api\/v1\/jobs\/([^/]+)\/control$/);
  if (request.method === 'POST' && controlMatch) {
    requireBearer(request, config.runnerToken, 'runner');
    const body = await readJson(request);
    const job = await store.getJob(decodeURIComponent(controlMatch[1]));
    if (!job?.lease || job.lease.id !== body.leaseId || job.lease.runnerId !== body.runnerId) {
      return json(response, 409, { ok: false, error: 'Stale or foreign Runner lease' });
    }
    return json(response, 200, { ok: true, cancelRequested: job.status === 'cancelling' });
  }

  if (request.method === 'POST' && url.pathname === '/api/v1/runners/heartbeat') {
    requireBearer(request, config.runnerToken, 'runner');
    const body = await readJson(request);
    const runner = await store.heartbeat(body);
    return json(response, 200, { ok: true, runner });
  }

  if (request.method === 'POST' && url.pathname === '/api/v1/jobs/lease') {
    requireBearer(request, config.runnerToken, 'runner');
    const body = await readJson(request);
    if(!await store.leaseWork(body.capabilities??[]))return json(response,200,{ok:true,job:null});
    const result=await commitControl(context,async()=>({ok:true,job:await store.leaseNext(body.runnerId,body.capabilities??[])}));
    return json(response,200,result);
  }

  const continuousPlanMatch = url.pathname.match(/^\/api\/v1\/jobs\/([^/]+)\/continuous-environment$/);
  if (request.method === 'POST' && continuousPlanMatch) {
    requireBearer(request, config.runnerToken, 'runner');
    const id = decodeURIComponent(continuousPlanMatch[1]);
    const body = await readJson(request);
    const job = await store.getJob(id);
    if (!job) return json(response, 404, { error: 'Unknown job' });
    if (job.status !== 'running' || !job.continuousInvestigation || !job.lease?.id
      || body.leaseId !== job.lease.id || body.runnerId !== job.lease.runnerId) {
      return json(response, 409, { ok: false, error: 'Stale, foreign or non-continuous Runner lease' });
    }
    const identity = { leaseId: body.leaseId, runnerId: body.runnerId };
    const sourceResult = body.result ?? {};
    try {
      let query = sourceResult.environmentQuery;
      if (sourceResult.websiteQuery) query = await prepareWebsiteQuery(context, job, sourceResult.websiteQuery);
      if (!query || sourceResult.outcome !== 'needs_clarification') throw new Error('当前结果没有可执行的环境查询');
      const plan = planQuery(await loadEnvironments(), query, job.projectId,
        { senderId: job.senderId, profile: job.originProfile });
      const convergence = environmentContinuation(await store.read(), job, query, sourceResult);
      if (!convergence.continue) throw Object.assign(new Error(convergence.reason), { queryDiagnostic: { code: convergence.terminal?'CONVERGENCE_STALLED':'REPEATED_TARGET', reason: convergence.reason } });
      if(convergence.metadata)Object.assign(plan,convergence.metadata);
      const result=await commitControl(context,async()=>({ok:true,planned:true,plan,job:await store.beginContinuousEnvironment(id,identity,plan,sourceResult)}));
      return json(response,200,result);
    } catch (error) {
      if(error.controlReceiptFailure)throw error;
      const diagnostic = queryRejection(error, job);
      const result=await commitControl(context,async()=>({ok:true,planned:false,diagnostic,...await store.rejectContinuousEnvironment(id,identity,sourceResult,diagnostic)}));
      return json(response,200,result);
    }
  }

  if (['/api/v1/knowledge','/api/v1/admin/knowledge'].includes(url.pathname) && request.method === 'GET') {
    if(url.pathname.includes('/admin/')) requireAdminSession(context, request, false);
    else requireBearer(request, config.adminToken, 'admin');
    return json(response, 200, await context.knowledge.overview(), { 'cache-control': 'no-store' });
  }
  const knowledgeMatch = url.pathname.match(/^\/api\/v1\/(?:admin\/)?knowledge\/(KN-[A-Za-z0-9-]+)(?:\/(suspend|resolve))?$/);
  if (knowledgeMatch) {
    if(url.pathname.includes('/admin/')) requireAdminSession(context, request, request.method === 'POST');
    else requireBearer(request, config.adminToken, 'admin');
    await context.knowledge.store.open();
    const entry = context.knowledge.store.get(knowledgeMatch[1]);
    if (!entry) return json(response, 404, { ok: false });
    if (request.method === 'GET' && !knowledgeMatch[2]) return json(response, 200, { ok: true, entry }, { 'cache-control': 'no-store' });
    if (request.method === 'POST' && knowledgeMatch[2]) {
      if (knowledgeMatch[2] === 'suspend') context.knowledge.store.suspend(entry.id);
      else context.knowledge.store.resolve(entry.id);
      await store.recordAdminAudit({actor:'local-knowledge-admin',action:'knowledge_'+knowledgeMatch[2],knowledgeId:entry.id});
      return json(response, 200, { ok: true });
    }
  }

  const continuousResultMatch = url.pathname.match(/^\/api\/v1\/jobs\/([^/]+)\/continuous-environment-result$/);
  if (request.method === 'POST' && continuousResultMatch) {
    requireBearer(request, config.runnerToken, 'runner');
    const id = decodeURIComponent(continuousResultMatch[1]);
    const body = await readJson(request);
    const before = await store.getJob(id);
    if(body.result&&body.result.exportFiles!==undefined)body.result.exportFiles=await validateReportFiles(config.dataDir,id,body.result.exportFiles);
    const result=await commitControl(context,async()=>({ok:true,job:await store.completeContinuousEnvironment(id,
      { leaseId: body.leaseId, runnerId: body.runnerId }, body.result)}));
    if (before?.environmentAccess?.kind === 'website') await context.websiteBrowser.release(id);
    return json(response,200,result);
  }

  const continuousAnalysisMatch = url.pathname.match(/^\/api\/v1\/jobs\/([^/]+)\/continuous-analysis-continue$/);
  if (request.method === 'POST' && continuousAnalysisMatch) {
    requireBearer(request, config.runnerToken, 'runner');
    const id = decodeURIComponent(continuousAnalysisMatch[1]);
    const body = await readJson(request);
    const result=await commitControl(context,async()=>({ok:true,...await store.continueContinuousAnalysis(id,
      { leaseId: body.leaseId, runnerId: body.runnerId }, body.result)}));
    return json(response,200,result);
  }

  const websiteMatch=url.pathname.match(/^\/api\/v1\/jobs\/([^/]+)\/website-tool$/);
  if(request.method==='POST'&&websiteMatch){
    requireBearer(request,config.runnerToken,'runner');const body=await readJson(request);const job=await store.getJob(decodeURIComponent(websiteMatch[1]));
    if(job?.status!=='running'||!job.lease?.id||body.leaseId!==job.lease.id||body.runnerId!==job.lease.runnerId)return json(response,409,{error:'Stale or foreign Runner lease'});
    const e=verifyApprovedPlan(await loadEnvironments(),job.environmentAccess??{});if(e.kind!=='website')throw new Error('Not a website grant');
    const result=await context.websiteBrowser.run(job,e,body.tool,body.args);return json(response,200,{result});
  }
  const eventMatch = url.pathname.match(/^\/api\/v1\/jobs\/([^/]+)\/events$/);
  if (request.method === 'POST' && eventMatch) {
    requireBearer(request, config.runnerToken, 'runner');
    const body = await readJson(request);
    const job = await store.getJob(decodeURIComponent(eventMatch[1]));
    if (!job?.lease?.id || body.leaseId !== job.lease.id || body.runnerId !== job.lease.runnerId) {
      return json(response, 409, { ok: false, error: 'Stale or foreign Runner lease' });
    }
    let routing = agentRouting(context, nextStage(job.workflow, job.stage));
    if(body.type==='completed'&&body.result?.environmentSetup){
      if(job.taskIntent!=='analysis'||!job.questionId||job.environmentAccess||!['developer','owner_report'].includes(job.stage)
        ||body.result.outcome!=='needs_clarification'||body.result.environmentQuery||body.result.websiteQuery)throw new Error('当前阶段不能申请环境接入');
      if(job.convergenceFinal)throw new Error('最终汇总阶段不能再申请环境接入');
      const setup=body.result.environmentSetup;
      if(!['nacos','mysql'].includes(setup.kind)||!['uat','prd'].includes(setup.tier)||typeof setup.url!=='string')throw new Error('接入参数无效');
      if(setup.url)enrollmentTarget(setup);
      if(setup.kind==='mysql'||setup.url)routing={...routing,setupInvestigation:true};
    }
    if(body.type==='completed'&&body.result?.websiteQuery){
      if(job.taskIntent!=='analysis'||!['developer','owner_report'].includes(job.stage)||!job.questionId||job.environmentAccess||body.result.outcome!=='needs_clarification'||body.result.environmentQuery)throw new Error('当前阶段不能申请网页排查');
      if(job.convergenceFinal)throw new Error('最终汇总阶段不能再申请网页排查');
      body.result.environmentQuery=await prepareWebsiteQuery(context,job,body.result.websiteQuery);
    }
    if (body.type === 'completed' && body.result?.environmentQuery) {
      try {
        if (job.taskIntent !== 'analysis' || !['developer', 'owner_report'].includes(job.stage) || !job.questionId || job.environmentAccess
          || body.result.outcome !== 'needs_clarification') throw new Error('当前阶段不允许申请环境查询');
        if(job.convergenceFinal)throw new Error('最终汇总阶段不能再申请环境查询');
        const snapshot = await store.read();
        const earlier = snapshot.jobs.filter(j => j.questionId === job.questionId && j.environmentAccess);
        const request = body.result.environmentQuery;
        const continuation=environmentContinuation(snapshot,job,request,body.result);
        if(!continuation.continue){const error=new Error('自动调查未产生新增证据');error.queryDiagnostic={code:'CONVERGENCE_STALLED',reason:continuation.reason};throw error;}
        if (earlier.some(j => j.environmentAccess.environmentId === request.environmentId
          && j.environmentAccess.queryId === request.queryId
          && JSON.stringify(j.environmentAccess.parameters) === JSON.stringify(request.parameters))) {
          throw new Error('重复环境查询，需要调整范围或补充新证据');
        }
        const plan = planQuery(await loadEnvironments(), body.result.environmentQuery, job.projectId,
          { senderId: job.senderId, profile: job.originProfile });
        if(continuation.metadata)Object.assign(plan,continuation.metadata);
        routing = { ...agentRouting(context, 'developer'), environmentPlan: plan };
        if (!routing.agentProfile) throw new Error('开发角色未配置');
      } catch (error) {
        const diagnostic=queryRejection(error,job);
        if(diagnostic.code==='CONVERGENCE_STALLED'){
          const message=`${diagnostic.reason} 已停止重复启动子任务，现交由项目负责人根据已有证据完成最终汇总。`;
          body.result={...body.result,outcome:'ready',environmentQuery:null,websiteQuery:null,queryRejection:diagnostic,summary:message,finalMessage:`${message}\n\n${diagnostic.correction}`};
          routing={...agentRouting(context,'owner_report'),convergenceFinal:true};
        } else {
        const repairable=diagnostic.retry && job.taskIntent==='analysis' && job.questionId && !job.environmentAccess
          && ['developer','owner_report'].includes(job.stage) && agentRouting(context,'developer').agentProfile;
        diagnostic.retry=Boolean(repairable);
        const message=`${diagnostic.code==='REPEATED_TARGET'?'本次追加查询由 AgentOS 自动暂停':'本次追加查询尚未执行'}：${diagnostic.reason} ${diagnostic.pause??(repairable?'正在自动修正申请并继续原问题，不需要用户重新授权。':diagnostic.correction)} 已有排查证据保留。`;
        body.result = {...body.result,outcome:repairable?'needs_clarification':'blocked',environmentQuery:null,websiteQuery:null,
          queryRejection:diagnostic,summary:message,finalMessage:`${message}\n\n${diagnostic.correction}`};
        routing=repairable?{...agentRouting(context,'developer'),repairQuery:true}:{};
        }
      }
    }
    if (body.type === 'completed' && job.taskIntent === 'analysis' && job.questionId
      && job.environmentAccess && !job.connectionEnrollmentPending && ['partial', 'ready'].includes(body.result?.outcome)
      && context.projects.projects[job.projectId]?.analysisRepositories?.length) {
      const prior = (await store.read()).jobs.filter(j => j.questionId === job.questionId && j.environmentAccess && j.id !== job.id && j.result?.environmentEvidence);
      const hash = body.result.environmentEvidence?.resultHash;
      const stalled = hash && prior.length >= 2 && prior.slice(-2).every(j => j.result.environmentEvidence.resultHash === hash);
      if (!stalled) routing = { ...agentRouting(context, 'developer'), resumeInvestigation: true };
      else body.result.summary = '连续三轮环境调查没有新增证据，已暂停。需要调整调查路径或补充缺失工具。' + (body.result.summary ?? '');
    }
    if (body.type === 'completed' && job.taskIntent === 'analysis' && job.questionId
      && !job.environmentAccess && job.stage === 'owner_report' && body.result?.outcome === 'partial' && !job.convergenceFinal
      && context.projects.projects[job.projectId]?.analysisRepositories?.length) {
      routing = { ...agentRouting(context, 'developer'), reviewInvestigation: true };
    }
    if(body.type==='completed'&&body.result?.exportFiles!==undefined){
      verifyCompletedPlan(await loadEnvironments(),job.environmentAccess??{},body.result.environmentEvidence);
      body.result.exportFiles=await validateReportFiles(config.dataDir,job.id,body.result.exportFiles);
    }
    if (body.type === 'completed' && job.workflow === 'requirement_test' && body.result?.outcome === 'ready'
      && !body.result.requirementReport) throw new Error('Requirement test completion needs a verified workbook');
    if (body.type === 'completed' && body.result?.requirementReport) {
      if (job.workflow !== 'requirement_test' || body.result.requirementReport.kind !== 'requirement-xlsx'
        || body.result.outcome !== 'ready') throw new Error('Invalid requirement report registration');
      await reportFile(config.dataDir, job.id, body.result.requirementReport, { includeContent: false });
    }
    if (job.workflow === 'requirement_test' && ['cancelled', 'failed'].includes(body.type)) {
      const checkpoint = await readFile(path.join(config.dataDir, 'requirement-tests', job.id, 'journal.json'), 'utf8')
        .then(JSON.parse, () => null).catch(() => null);
      const pending = checkpoint?.cleanup?.verified !== true && Boolean(checkpoint?.mutations?.length || checkpoint?.inFlight);
      body.result = {
        finalMessage: (body.type === 'cancelled' ? job.requirement?.stopMode === 'pause' ? '需求测试已暂停，可回复继续测试。' : '需求测试已取消。' : '需求测试执行中断。')
          + (pending ? '本轮有待核对的业务状态，已保留变更和证据。请在原话题 @ 专员并回复“恢复清理”。'
            : '已保留本轮检查点。'),
        requirementWait: pending ? 'cleanup_pending' : null,
      };
    }
    let committedEvent;
    const result=await commitControl(context,async()=>{committedEvent=await store.appendEvent(job.id,body,routing);return {ok:true,job:committedEvent.job};});
    if(['completed','failed','cancelled'].includes(body.type)&&!body.result?.browserLoginRequired)await context.websiteBrowser.release(job.id);
    context.knowledge.capture(result.job);
    if(committedEvent)setImmediate(() => notifyJobEvent(context, committedEvent).catch((error) => console.error('[notify]', error)));
    return json(response, 200, { ok: true, job: result.job });
  }

  const approveMatch = url.pathname.match(/^\/api\/v1\/jobs\/([^/]+)\/approve$/);
  if (request.method === 'POST' && approveMatch) {
    requireBearer(request, config.adminToken, 'admin');
    const body = await readJson(request);
    const job = await store.getJob(decodeURIComponent(approveMatch[1]));
    const nextRole = job ? nextAgentRole(job, context) : null;
    const approved = await store.approve(
      decodeURIComponent(approveMatch[1]),
      body.approverId,
      agentRouting(context, nextRole),
    );
    return json(response, 201, { ok: true, ...approved });
  }

  const attachmentMatch = url.pathname.match(/^\/api\/v1\/jobs\/([^/]+)\/attachments\/([^/]+)$/);
  if (request.method === 'GET' && attachmentMatch) {
    requireBearer(request, config.runnerToken, 'runner');
    const job = await store.getJob(decodeURIComponent(attachmentMatch[1]));
    const attachment = job?.attachments.find((item) => item.id === decodeURIComponent(attachmentMatch[2]));
    if (!attachment) return json(response, 404, { ok: false, error: 'Attachment not found' });
    const info = await stat(attachment.path);
    response.writeHead(200, {
      'content-type': attachment.contentType ?? 'application/octet-stream',
      'content-length': info.size,
      'content-disposition': `attachment; filename="${attachment.id}"`,
    });
    return createReadStream(attachment.path).pipe(response);
  }

  const jobMatch = url.pathname.match(/^\/api\/v1\/jobs\/([^/]+)$/);
  if (request.method === 'GET' && jobMatch) {
    requireBearer(request, config.adminToken, 'admin');
    const job = await store.getJob(decodeURIComponent(jobMatch[1]));
    return job ? json(response, 200, { ok: true, job }) : json(response, 404, { ok: false });
  }

  json(response, 404, { ok: false, error: 'Not found' });
}

async function handleFeishuEvent(context, envelope) {
  if (envelope.header?.event_type !== 'im.message.receive_v1') return;
  const event = envelope.event ?? {};
  const message = event.message ?? {};
  if (['app', 'bot'].includes(event.sender?.sender_type)) return;
  if(expiredMessage(message,context.config.retention))return {ignored:true,reason:'local_retention_expired'};
  const parsed = parseFeishuMessage(message);
  const attachments = [];
  for (const resource of parsed.resources) {
    const item = await context.feishu.downloadMessageResource(message.message_id, message.message_id, resource.key, resource.type);
    if (item) attachments.push({...item,...(resource.name?{name:resource.name}:{})});
  }
  return handleLarkCliEvent(context, {
    type: 'im.message.receive_v1', message_id: message.message_id,create_time:message.create_time,
    chat_id: message.chat_id, chat_type: message.chat_type,
    sender_id: event.sender?.sender_id?.open_id, sender_type: 'user',
    content: parsed.text, mentions: message.mentions, attachments,
    reply_to: message.parent_id, root_id: message.root_id, thread_id: message.thread_id,
    agent_role: context.config.feishu.role ?? 'owner_intake',
    agent_profile: context.config.feishu.profile ?? null,
  });
}

export async function handleLarkCliEvent(context, event) {
  if(expiredMessage(event,context.config.retention))return {ignored:true,reason:'local_retention_expired'};
  if (event.type !== 'im.message.receive_v1' || ['bot', 'app'].includes(event.sender_type)) return null;
  if (context.projects.retiredChatIds?.includes(event.chat_id)) return { ignored: true, reason: 'retired_group' };
  if (context.projects.messageExcludedChatIds?.includes(event.chat_id)) return { ignored: true, reason: 'dedicated_requirement_chat' };
  if (context.requirementRoutes?.has(event.agent_profile)) return handleRequirementMessage(context, event);
  if (context.requirementRoutes?.size) return { ignored: true, reason: 'requirement_profile_required' };
  const messageId = event.message_id ?? event.id;
  const role = event.agent_role ?? 'owner_intake';
  const sourceProfile = event.agent_profile ?? null;
  const credentialResult = await context.websiteCredentials?.handle(event);
  if (credentialResult) return credentialResult;
  const agent = Object.values(context.agents.agents ?? {}).find((item) => (item.profile || null) === sourceProfile);
  if (event.agent_role && context.agents.agents?.[role]?.profile
    && context.agents.agents[role].profile !== sourceProfile) throw new Error('Agent role/profile mismatch');
  const mentions = event.mentions ?? [];
  const mentionIds = mentions.flatMap((item) => [item.id?.open_id ?? item.id, item.open_id, item.user_id]).filter(Boolean);
  const addressed = event.chat_type === 'p2p' || (agent?.openId && mentionIds.includes(agent.openId));
  const state = await context.store.read();
  const related = (state.conversations ?? []).some((turn) => turn.chatId === event.chat_id && turn.profile === sourceProfile
    && [event.reply_to, event.root_id].filter(Boolean).some((id) => turn.messageId === id || turn.feedbackMessageId === id || turn.responseIds?.includes(id)));
  const jobReply = state.jobs.some((job) => job.chatId === event.chat_id
    && job.agentProfile === sourceProfile && job.notificationIds?.includes(event.reply_to));
  const cardReply = Object.values(state.cardMessages ?? {}).some((card) => card.messageId && card.messageId === event.reply_to
    && card.destination.profile === sourceProfile && (card.destination.chatId === event.chat_id
      || (state.conversations ?? []).some((turn) => turn.chatId === event.chat_id && turn.messageId === card.destination.replyTo)));
  // Older CLI events omit chat_type; their subscription is already bot-scoped.
  // Known group events require an actual mention or a recorded conversation reply.
  if (event.chat_type === 'group' && !addressed && !related && !jobReply && !cardReply) return { ignored: true };
  if (mentionIds.length && agent?.openId && !mentionIds.includes(agent.openId)) return { ignored: true };
  return context.conversations.enqueue({
    ...event, message_id: messageId, agent_role: role,
    content: stripMentions(event.content, mentions),
  });
}

function stripMentions(text, mentions = []) {
  let result = String(text ?? '');
  for (const mention of mentions ?? []) {
    if (mention.key) result = result.replaceAll(mention.key, ' ');
    if (mention.name) result = result.replaceAll(`@${mention.name}`, ' ');
  }
  return result.replace(/\s+/g, ' ').trim();
}

async function createJobFromMessage(context, input) {
  const { projects, store, feishu } = context;
  const projectId = input.projectId ?? projects.chatProjectMap[input.chatId];
  if (!projectId || !projects.projects[projectId]) {
    throw new Error(`Chat ${input.chatId ?? '<unknown>'} is not bound to a project`);
  }
  const routed = input.agentRole
    ? routeInstructionForStage(input.text, input.agentRole)
    : routeInstruction(input.text);
  const assigned = agentRouting(context, routed.stage);
  const requestedAgentRole = input.agentRole ?? routed.stage;
  const requestedAgentProfile = input.agentProfile ?? assigned.agentProfile;
  const delegation = routed.delegated ? {
    fromStage: routed.requestedStage,
    toStage: routed.stage,
    reason: routed.delegationReason,
  } : null;
  if (input.parentMessageId && routed.instruction) {
    const activated = await store.activateDraft(input.parentMessageId, {
      sourceMessageId: input.messageId,
      replyToMessageId: input.replyToMessageId,
      workflow: routed.workflow,
      stage: routed.stage,
      instruction: routed.instruction,
      agentRole: routed.stage,
      agentProfile: assigned.agentProfile,
      requestedAgentRole,
      requestedAgentProfile,
      delegation,
    });
    if (activated) return { job: activated, duplicate: false, activatedDraft: true };
  }
  const status = routed.instruction ? 'queued' : 'awaiting_instruction';
  const created = await store.createJob({
    projectId,
    projectName: projects.projects[projectId].displayName ?? projectId,
    chatId: input.chatId,
    senderId: input.senderId,
    originProfile: input.agentProfile ?? null,
    originChatType: input.chatType ?? null,
    agentRole: routed.stage,
    agentProfile: assigned.agentProfile,
    requestedAgentRole,
    requestedAgentProfile,
    delegation,
    sourceMessageId: input.messageId,
    replyToMessageId: input.replyToMessageId,
    workflow: routed.workflow,
    stage: routed.stage,
    instruction: routed.instruction,
    attachmentRefs: input.resources,
    attachments: input.attachments ?? [],
    status,
  });
  if (created.duplicate) return created;
  for (const resource of input.resources) {
    const attachment = await feishu.downloadMessageResource(
      created.job.id, input.messageId, resource.key, resource.type,
      { profile: input.agentProfile },
    );
    if (attachment) await store.addAttachment(created.job.id, attachment);
  }
  return { ...created, job: await store.getJob(created.job.id) };
}

export async function notifyJobEvent(context, { job, event }) {
  if (!job.chatId && !job.replyToMessageId) return;
  if(event.type==='completed')await context.reports?.enqueue(await context.store.getJob(job.id));
  if (context.cards?.enabled) {
    if (!['queued', 'started', 'completed', 'failed', 'cancelled', 'cancel_requested', 'progress'].includes(event.type)) return;
    if (event.type === 'progress' && !['codex_waiting', 'codex_working', 'connection_retry', 'model_capacity_retry', 'verification', 'tool_activity'].includes(event.phase)) return;
    // Always re-read authoritative state; HTTP event notifications may arrive out of order.
    const current = await context.store.getJob(job.id);
    if (current.questionId) { await publishQuestion(context, current.questionId); return; }
    const terminal = !['queued', 'running', 'cancelling'].includes(current.status);
    const attempt = current.events.filter((e) => e.type === 'started').at(-1)?.id ?? 'first';
    const key = `job:${job.id}:${attempt}`;
    // Once queued, keep the exact recipients across retries/config changes.
    const frozenMention = (await context.store.read()).cardMessages?.[key]?.terminalMention;
    const id = await context.cards.upsert(key, jobCard(current),
      current.visibility==='requester'?cardDestination(current):{ chatId: current.chatId, replyTo: current.chatId ? null : current.replyToMessageId, profile: current.agentProfile },
      { terminal, immediate: terminal, resultText: terminal ? current.result?.finalMessage : '',
        terminalMention: frozenMention ?? jobTerminalMention(current, context.projects) });
    if (id) await context.store.transact((state) => {
      const saved = state.jobs.find((item) => item.id === job.id);
      saved.notificationIds = [...new Set([...(saved.notificationIds ?? []), id])];
    });
    return;
  }
  if (event.type === 'progress') {
    const labels = { codex_waiting: 'Codex 已启动，正在等待模型响应', codex_working: 'Codex 仍在处理当前任务，尚未完成',
      connection_retry: 'Codex 连接异常，正在重试；尚未完成', model_capacity_retry: '当前模型服务繁忙，正在同一调查会话中自动重试', verification: 'Codex 已返回，正在执行配置的验证命令' };
    if (!Object.hasOwn(labels, event.phase)) return; // Never publish raw commands, logs or credentials.
    const accepted = await context.store.transact((state) => {
      const current = state.jobs.find((item) => item.id === job.id);
      if (!current || current.status !== 'running') return false;
      if (current.progressNoticeAt && Date.now() - Date.parse(current.progressNoticeAt) < 60_000 && event.phase !== 'verification') return false;
      current.progressNoticeAt = new Date().toISOString();
      return true;
    });
    if (accepted) await sendAsJobAgent(context, job, `${job.id} · ${stageLabel(job.stage)}\n${labels[event.phase]}。已运行约 ${Math.max(0, Math.round(Number(event.elapsedSeconds) || 0))} 秒。`);
  }
  if (event.type === 'started') {
    await sendAsJobAgent(context, job, `${job.id} 已开始：${stageLabel(job.stage)}`);
  }
  if (event.type === 'completed') {
    const conclusion = resultSummary(job.result?.summary || job.result?.finalMessage) || '执行器未返回文字结论，请查看任务记录。';
    const status = job.status === 'awaiting_clarification'
      ? '当前阶段等待补充信息，尚未通过。可直接回复具体补充内容。'
      : job.status === 'awaiting_approval'
        ? '当前阶段待真人管理员确认。可 @项目负责人 说明是否同意进入下一阶段。'
        : job.status === 'blocked' ? '当前阶段未通过，不能放行；请根据以下结论安排修复。'
          : '当前阶段已结束。';
    for (const part of splitReply(`${job.id} · ${stageLabel(job.stage)}\n${status}\n\n${conclusion}`)) {
      await sendAsJobAgent(context, job, part);
    }
  }
  if (event.type === 'failed') {
    await sendAsJobAgent(context, job, `${job.id} 执行失败，未通过当前阶段。错误详情已记录在本地任务日志，请管理员查看。`);
  }
}

function agentRouting(context, role) {
  const profileRole = role === 'owner_report' ? 'owner_intake' : role;
  const agent = profileRole ? context.agents?.agents?.[profileRole] : null;
  return { agentRole: role, agentProfile: agent?.profile ?? null };
}

function nextAgentRole(job) {
  return nextStage(job.workflow, job.stage);
}

async function sendAsJobAgent({ feishu, store }, job, text) {
  if(isPrivate(await store.read(),job))return; // Never fall back to a public message.
  let result;
  if (job.chatId && typeof feishu.send === 'function') {
    result = await feishu.send(job.chatId, text, { profile: job.agentProfile });
  }
  else if (job.replyToMessageId) result = await feishu.reply(job.replyToMessageId, text, { profile: job.agentProfile });
  const id = responseMessageId(result);
  if (id) await store.transact((state) => {
    const saved = state.jobs.find((item) => item.id === job.id);
    if (saved) { saved.notificationIds ??= []; saved.notificationIds.push(id); }
  });
  return result;
}

function verifyFeishu(body, expected) {
  if (!expected) return true;
  return body.token === expected || body.header?.token === expected;
}

function requireBearer(request, expected, kind) {
  if (!expected) throw new Error(`${kind} token is not configured`);
  if (request.headers.authorization !== `Bearer ${expected}`) {
    const error = new Error('Unauthorized');
    error.statusCode = 401;
    throw error;
  }
}

async function readJson(request, limit = 5 * 1024 * 1024) {
  if(request.controlBody!==undefined)return structuredClone(request.controlBody);
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > limit) throw new Error('Request body is too large');
    chunks.push(chunk);
  }
  if (chunks.length === 0) return {};
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

function json(response, status, body, headers = {}) {
  const encoded = Buffer.from(JSON.stringify(body));
  response.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'content-length': encoded.length, ...headers });
  response.end(encoded);
}

async function serveAdmin(context, response, file, establishSession = false) {
  if (!isLoopback(context.config.host)) return json(response, 404, { ok: false, error: 'Admin console is available on loopback only' });
  const target = `${adminDirectory}${file}`;
  const info = await stat(target);
  const headers = {
    'content-type': file.endsWith('.js') ? 'text/javascript; charset=utf-8' : file.endsWith('.css') ? 'text/css; charset=utf-8' : 'text/html; charset=utf-8',
    'content-length': info.size,
    'cache-control': file === 'index.html' ? 'no-store' : 'public, max-age=300',
    'content-security-policy': "default-src 'self'; connect-src 'self'; img-src 'self' data:; style-src 'self'; script-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'",
    'referrer-policy': 'no-referrer', 'x-content-type-options': 'nosniff', 'x-frame-options': 'DENY',
  };
  if (establishSession) headers['set-cookie'] = `agentos_admin=${context.adminSessionToken}; HttpOnly; SameSite=Strict; Path=/`;
  response.writeHead(200, headers);
  return createReadStream(target).pipe(response);
}

function requireAdminSession(context, request, mutation) {
  if (!isLoopback(context.config.host)) unauthorized();
  const value = String(request.headers.cookie ?? '').split(';').map((part) => part.trim())
    .find((part) => part.startsWith('agentos_admin='))?.slice('agentos_admin='.length) ?? '';
  const actual = Buffer.from(value), expected = Buffer.from(context.adminSessionToken);
  if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) unauthorized();
  if (mutation) {
    const origin = request.headers.origin;
    const expectedOrigin = `http://${request.headers.host}`;
    if (origin !== expectedOrigin || request.headers['x-agentos-admin'] !== '1') unauthorized();
  }
}

function unauthorized() {
  const error = new Error('Unauthorized'); error.statusCode = 401; throw error;
}

function isLoopback(host) {
  return ['127.0.0.1', 'localhost', '::1'].includes(String(host).replace(/^\[|\]$/g, ''));
}

async function main() {
  const { server, config } = await createControlPlane();
  server.listen(config.port, config.host, () => {
    console.log(`[control-plane] listening on http://${config.host}:${config.port}`);
  });
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main().catch((error) => { console.error(error); process.exitCode = 1; });
}


async function commitControl(context,operation){return context.controlReceipts.commit(context.request.controlMeta,operation);}
async function receiptAllowed(context,meta,body){
 const saved=(await context.store.snapshot()).controlReceipts?.[meta.id];
 if(!saved?.executable)return;
 const id=saved.jobId??body.job?.id;if(!id)return;const current=await context.store.getJob(id),lease=saved.leaseId??body.job?.lease?.id;
 if(current?.status!=='running'||current.lease?.id!==lease||current.lease?.runnerId!==meta.runnerId||!(Date.parse(current.lease?.expiresAt)>Date.now()))throw Object.assign(new Error('Recovered execution receipt has a stale or cancelled lease'),{statusCode:409});
 if(saved.route.endsWith('/environment-claim')){if(current.environmentAccess?.scopeHash!==body.plan?.scopeHash||current.environmentAccess?.startedAt!==body.plan?.startedAt)throw Object.assign(new Error('Recovered grant is no longer the current environment step'),{statusCode:409});try{verifyApprovedPlan(await loadEnvironments(),body.plan);}catch{throw Object.assign(new Error('Recovered environment authorization is no longer valid'),{statusCode:403});}}
}
async function durableControl(context,request,response){
 const pathname=new URL(request.url,'http://localhost').pathname,receipts=context.controlReceipts;
 const statusMatch=pathname.match(/^\/api\/v1\/control-requests\/([a-f0-9-]{36})$/);
 if(request.method==='GET'&&statusMatch){
  requireBearer(request,context.config.runnerToken,'runner');const meta={id:statusMatch[1],runnerId:request.headers['x-agentos-runner'],digest:request.headers['x-agentos-request-digest']};
  const pending=receipts.pending.get(meta.id);if(pending)receipts.check(pending,meta);
  const saved=await receipts.committed(meta);if(saved){await receiptAllowed(context,meta,saved);json(response,200,{protocol:CONTROL_PROTOCOL,state:'committed',response:saved});}
  else json(response,200,{protocol:CONTROL_PROTOCOL,state:pending?'pending':'unknown'});return true;
 }
 const id=request.headers['x-agentos-request-id'];if(!id)return false;
 requireBearer(request,context.config.runnerToken,'runner');if(request.method!=='POST'||!validRequestId(id))throw Object.assign(new Error('Invalid control request ID'),{statusCode:400});
 validateRetainedRequest(request.headers['x-agentos-request-created-at'],context.config.retention,receipts.pending.has(id)||Boolean((await context.store.snapshot()).controlReceipts?.[id]));
 const body=await readJson(request);if(!criticalControl(pathname,body)||typeof body.runnerId!=='string')throw Object.assign(new Error('Unsupported durable control operation'),{statusCode:400});
 const meta={id,runnerId:body.runnerId,leaseId:body.leaseId,jobId:pathname.match(/^\/api\/v1\/jobs\/([^/]+)\//)?.[1],route:pathname,digest:controlDigest(pathname,body),executable:pathname.endsWith('/environment-claim')||pathname==='/api/v1/jobs/lease'||pathname.endsWith('/events')&&body.type==='started'};
 request.controlBody=body;request.controlMeta=meta;
 let pending=receipts.pending.get(id);
 if(pending)receipts.check(pending,meta);
 else{
  const promise=(async()=>{const saved=await receipts.committed(meta);if(saved){await receiptAllowed(context,meta,saved);return {status:200,body:saved};}
   const capture={headersSent:false,writeHead(status){this.status=status;this.headersSent=true;},end(raw){this.body=JSON.parse(raw.toString());}};
   await route({...context,request,response:capture});return {status:capture.status,body:capture.body};})();
  pending={...meta,promise};receipts.pending.set(id,pending);promise.finally(()=>{if(receipts.pending.get(id)===pending)receipts.pending.delete(id);}).catch(()=>{});
 }
 const result=await pending.promise;if(result.status===200)await receiptAllowed(context,meta,result.body);json(response,result.status,result.body);return true;
}
