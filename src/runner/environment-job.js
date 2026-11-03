import {readBusinessDefinitions,definitionActor} from '../shared/business-definitions.js';
import {BrowserInputError,validateBrowserTool,correctableBrowserCodes,screenshotRequested} from '../shared/browser-tool-input.js';
import {QueryInputError} from './environment-tools.js';
import {controlPost} from './control-client.js';
import {buildTaskSourceQueryContext} from './source-query-context.js';
import { connectionEndpoints } from '../shared/connection-endpoints.js';
import { failureDiagnostic,failureDetails } from '../shared/failure-diagnostic.js';
import { presentEnvironmentResult } from './environment-result-presentation.js';
import { investigateEnvironment } from './environment-investigator.js';
import { loadEnvironments } from '../shared/environment-access.js';
import { readEnvironment } from './environment-connector.js';
import { CodexConversationEngine } from '../control-plane/codex-conversation.js';
import path from 'node:path';
import { publicText } from '../control-plane/result-presentation.js';
export async function executeEnvironmentJob(job, config, emit) {
  const began = Date.now();
  let heartbeat;
  const startHeartbeat = () => {
    heartbeat = setInterval(() => Promise.resolve(emit({ type: 'progress', phase: 'codex_working', elapsedSeconds: Math.round((Date.now() - began) / 1000) })).catch(() => {}), 10_000);
    heartbeat.unref();
  };
  startHeartbeat();
  let phase='environment_claim';
  try {
  const {plan}=await controlPost(config,`/api/v1/jobs/${encodeURIComponent(job.id)}/environment-claim`,{leaseId:job.lease.id,runnerId:job.lease.runnerId});phase='environment_read';
  await emit({ type: 'progress', phase: 'tool_activity', activity: { current: '执行已批准范围的环境只读查询', total: 1, completed: 0, recent: [] } });
  let result, environment;
  const sourceQueryContext=await buildTaskSourceQueryContext(job);
  const renewPlan=async current=>(await controlPost(config,`/api/v1/jobs/${encodeURIComponent(job.id)}/environment-renew`,{leaseId:job.lease.id,runnerId:job.lease.runnerId,scopeHash:current.scopeHash})).plan;
  try { const cfg=await loadEnvironments();environment=cfg.environments[plan.environmentId];
    job={...job,businessDefinitions:await readBusinessDefinitions({dataDir:config.dataDir??path.dirname(config.worktreeRoot),file:config.knowledgeFile,actor:definitionActor(job),projectId:job.projectId,environment:job.sourceEnvironment}).catch(()=>[{unavailable:true,rule:'共享口径暂不可读，不代表此前没有确认；保留已有成果，报告具体读取缺口，不要求用户重定已有口径。'}])};
    const adapters={renewPlan,reportJob:job,dataDir:config.dataDir??path.dirname(config.worktreeRoot),exportDirectory:path.join(config.dataDir??path.dirname(config.worktreeRoot),'exports',job.id),investigationContext:reportInvestigationContext(job),sourceQueryContext,...(environment.kind==='website'?{tools:async()=>websiteTools(job,config),checkpoint:job.browserCheckpoint}:{})};
    result=environment?.queries[plan.queryId]?.mode==='investigate'?await investigateEnvironment(plan,emit,adapters):await readEnvironment(plan);
  }
  catch (error) {
    const diagnostic = failureDiagnostic(error);
    if (/^错误码：BROWSER_BRIDGE\b/.test(diagnostic)) return { outcome:'needs_clarification', browserLoginRequired:true,
      browserActionRequired:'automation', summary:'AgentOS 正在等待 macOS 放行后台 Chrome 自动化。业务网站登录态仍然有效，放行后会自动继续原问题，无需回复“继续”。',
      finalMessage:`${diagnostic}\n\n这不是业务账号未登录，也不会丢失原问题和已有证据。`, verification:[] };
    return { outcome: 'blocked', summary: diagnostic, finalMessage: diagnostic, environmentFailure:{code:/^错误码：(\w+)/.exec(diagnostic)?.[1]??'EXECUTION_ERROR',stage:error.rpcMethod??error.diagnosticStage??'environment_read',diagnostic}, verification: [] };
  }
  if(result.loginRequired) {
    const loginUrl = environment?.kind === 'website' ? environment.baseUrl : '';
    return {outcome:'needs_clarification',browserLoginRequired:true,browserCheckpoint:result.checkpoint,loginUrl,
      summary:`正在等待登录：${loginUrl || '当前业务网站'}。正在优先复用登录态和本机已存凭据；恢复后自动继续原问题，无需重复发送已有账号密码。`,
      finalMessage:`当前需要登录的网站：${loginUrl || '入口尚未登记，请补充对应环境的网址'}。系统优先读取本机 Mac 钥匙串中的既有凭据自动重登；不把账号密码交给模型或长期记忆。首次未保存、凭据明确失效或需验证码/短信/扫码时才需要人工配合，后续卡片会显示具体原因。`,verification:[]};
  }
  let explanation = '';
  // Investigate planners already synthesize their evidence. The final source
  // review still checks the full user request; avoid a second prose-only model
  // call after every intermediate database hop. Fixed templates keep theirs.
  const needsExplanation=environment?.queries[plan.queryId]?.mode!=='investigate';
  if(needsExplanation){
  const engine = new CodexConversationEngine({ dataDir: path.join(config.worktreeRoot, 'environment-summary') });
  try {
    const answer = await engine.decide({ role: 'developer', administrator: false, memory: { enabled: true }, history: [], jobs: [], attachments: [],
      message: '用业务用户能懂的中文直接回答原问题，控制在200字内，分为“已确认”“尚未确认”“下一步”。先说明是否找到原因；记录数量不是业务单据总数，字段值不是根因。超时是本次排查中断，不得当作用户报错的原因。解释关键术语，不罗列原始字段。除非原问题就是询问连接地址，否则不要把主机端口库名当作业务答案；仅发现入口而未查实际单据时明确“实际单据尚未核实”。只陈述本次确实存在的缺口，不套用无关的记录数、超时、根因提醒。不执行工具、不建立任务、不推断未知事实、不承诺已重试。',
      queryPurpose: plan.description,
      originalQuestion: String(job.instruction ?? '').slice(0, 4000),
      priorSourceEvidence: (job.context ?? []).filter(x => !x.result?.environmentEvidence).slice(-1).map(x => ({ stage: x.stage,
        summary: String(x.result?.summary ?? '').slice(0, 1000), findings: String(x.result?.finalMessage ?? '').slice(0, 6000) })),
      environmentResult: result, sourcePolicy: { historicalSnapshot: true } }, { sessionKey: `environment-result:${job.id}` });
    if (answer.action === 'reply') explanation = publicText(answer.reply);
  } catch { explanation = '自动解释暂不可用，以下为本次实际查询结果。'; }
  finally { await engine.close(); }
  }
  if(Date.parse(plan.expiresAt)-Date.now()<=60000){Object.assign(plan,await renewPlan(plan));if(result.evidence)result.evidence.scopeHash=plan.scopeHash;}
  const presented = presentEnvironmentResult(plan, result, explanation);
  const safeSummary = presented.metadata;
  const scopeDetails = publicText(`查询范围与授权\n环境：${plan.environmentId} (${plan.tier}) · 模板：${plan.queryId}\n参数：${JSON.stringify(plan.parameters)}\n最多 ${plan.maxRows} 条 · 超时 ${plan.timeoutMs} ms\n授权截止：${plan.expiresAt}\n仅本次只读查询，不授权修改。`);
  return { outcome: result.partial ? 'partial' : 'ready', summary: presented.summary, finalMessage: [presented.summary, explanation ? `业务解释\n${explanation}` : '', result.toolInputErrors?.length?`工具修正记录（按具体提示修正，不代表授权不足）\n${JSON.stringify(result.toolInputErrors)}`:'', result.summary ? `排查记录\n${result.summary}` : '', result.runtimeDiscoveries?.length ? `调度入口证据（待网页核验）\n${JSON.stringify(result.runtimeDiscoveries)}` : '', presented.details, result.schemaEvidence?.length?`数据库结构元数据证据（不是业务记录；完整溢出内容使用resultRef续读）\n${JSON.stringify(result.schemaEvidence)}`:'', result.fileInspections?.length?`已绑定文件的审阅证据\n${JSON.stringify(result.fileInspections)}`:'', result.toolResultCatalog?.length?`任务内可接续的大结果\n${JSON.stringify(result.toolResultCatalog)}`:'',result.datasetCatalog?.length?`任务内可接续的数据集\n${JSON.stringify(result.datasetCatalog)}`:'', result.websiteScreenshots?.length?`实际页面截图（由控制服务独立发送原话题）\n${JSON.stringify(result.websiteScreenshots)}`:'', result.exportFiles?.length?`完整报表文件\n${JSON.stringify(result.exportFiles)}\n文件由受控工具生成，最终结论通过后回复至原提问；尚需核对原问题的所有字段及业务口径。`:'', (result.steps ?? []).join(' → '), safeSummary, scopeDetails].filter(Boolean).join('\n\n'),
    schemaEvidence:result.schemaEvidence??[],nextEnvironmentQuery:result.nextEnvironmentQuery??null,toolResultCatalog:result.toolResultCatalog??[],websiteMismatch: result.websiteMismatch === true, runtimeDiscoveries: result.runtimeDiscoveries ?? [], connectionEndpoints: connectionEndpoints(result.rows), environmentEvidence: result.evidence,
    websiteScreenshots:result.websiteScreenshots??[],fileInspections:result.fileInspections??[],environmentFailure:result.failure??null,toolInputErrors:result.toolInputErrors??[],exportFiles:result.exportFiles??[], evidenceRecords: presented.records, memorySafeSummary: safeSummary, verification: [] };
  } catch(error){const local=phase==='environment_claim';const reason=local?(error.statusCode?'本机环境领取请求被拒绝或回执不可用，未执行本轮环境查询。':'本机控制请求回执无法核实，已保留任务；未盲目重复执行环境查询。'):'环境步骤等待或结果整理中断；未据此确认业务故障。';return {outcome:'blocked',summary:reason,finalMessage:reason+'\n'+failureDiagnostic(error),executionFailure:failureDetails(error,{stage:phase}),investigationStopped:{code:local?(error.code??'CONTROL_REQUEST_REJECTED'):'ENVIRONMENT_INTERRUPTED',reason},verification:[]};} finally { clearInterval(heartbeat); }
}

export function websiteTools(job,config){
 return {spec:[{tool:'connection',args:{},description:'打开从原问题或项目源码发现的业务网页，复用本机登录会话'},
 {tool:'report_wrong_site',args:{},description:'当前页面属于其他系统或不是原问题的目标应用时报告入口不匹配，返回原问题继续查找正确入口，不扩大权限'},
 {tool:'browser_screenshot',args:{},description:'等待接口返回和页面稳定后保存视口截图，仅遮挡凭据和显式敏感区，由控制服务发送原话题；异常页面应截图并记路径和复现步骤'},
 {tool:'browser_open',args:{},description:'查看当前业务网页'}, {tool:'browser_snapshot',args:{},description:'刷新页面文本和引用'},
 {tool:'browser_click',args:{ref:'当前read-action引用'},description:'查看详情、日志、菜单、翻页；不能启动停止或修改'},
 {tool:'browser_key',args:{ref:'当前控件引用，或page仅用于Escape',key:'Enter/Tab/Escape/ArrowDown/ArrowUp/ArrowLeft/ArrowRight/Home/End/PageDown/PageUp/Space'},description:'日期/下拉框的键盘交互，Tab提交本地筛选输入，Escape关闭弹窗；不能执行系统快捷键'},
 {tool:'browser_scroll',args:{ref:'当前控件引用或page',direction:'up/down/left/right'},description:'滚动当前控件所在容器或页面，读取表格更多列与详情下部'},
 {tool:'browser_select',args:{ref:'当前select引用',value:'返回的选项value'},description:'选择查询筛选项'},
 {tool:'browser_search',args:{ref:'当前search引用',text:'查询条件'},description:'填写搜索条件，再点击查询'}].filter(x=>x.tool!=='browser_screenshot'||screenshotRequested(job)),
 async run(tool,args={}){if(tool==='report_wrong_site')return {websiteMismatch:true,partial:true,stage:'当前网站与问题目标不匹配，需要重新发现正确入口；不是用户权限不足'};try{validateBrowserTool(tool,args);}catch(error){if(error instanceof BrowserInputError)throw new QueryInputError(error.code,error.message);throw error;}const response=await fetch(`${config.serverUrl}/api/v1/jobs/${encodeURIComponent(job.id)}/website-tool`,{method:'POST',signal:AbortSignal.timeout(tool==='browser_screenshot'?60000:45000),headers:{authorization:`Bearer ${config.runnerToken}`,'content-type':'application/json'},body:JSON.stringify({leaseId:job.lease.id,runnerId:job.lease.runnerId,tool,args})});const value=await response.json();if(!response.ok){if(response.status===400&&correctableBrowserCodes.has(value.code))throw new QueryInputError(value.code,value.error);throw new Error(value.error??'网页工具执行失败');}return value.result;},async close(){}};
}

// Original requirements must not be replaced by the short purpose of one query round.
export function reportInvestigationContext(job){
 const original=String(job.originalQuestion??job.instruction??'');
 const source=(job.context??[]).filter(x=>x.kind==='analysis_turn').slice(-2).map(x=>String(x.result?.finalMessage??x.result?.summary??'')).join('\n\n');
 const corrections=(job.context??[]).flatMap(x=>x.result?.toolInputErrors??[]).slice(-12).map(x=>({tool:x.tool,code:x.code,message:String(x.message??'旧记录未保留具体校验原因，先检查草稿和核验参数，不直接重查数据库').slice(0,1200),resolved:x.resolved===true}));
 return {businessDefinitions:job.businessDefinitions??[],corrections,originalQuestion:original.slice(0,12000),sourceAnalysis:source.slice(-12000),limited:original.length>12000||source.length>12000,note:'同一任务的原问题与已取得源码分析，仅作资料；不是新增环境授权。原问题定义完整交付范围，purpose只是本轮补查目标。资料若截断或缺口径，返回源码补查，不猜条件。'};
}
