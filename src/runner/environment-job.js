import {waitForBrowser} from './browser-readiness.js';
import {reusableReportSources} from './report-reuse.js';
import {createHash} from 'node:crypto';
import {controlPost} from './control-client.js';
import {buildSourceQueryContext} from './source-query-context.js';
import { connectionEndpoints } from '../shared/connection-endpoints.js';
import { failureDiagnostic } from '../shared/failure-diagnostic.js';
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
  const sourceResult=(job.context??[]).filter(x=>x.kind==='analysis_turn').at(-1)?.result;
  const sourceQueryContext=await buildSourceQueryContext(sourceResult);
  try { const cfg = await loadEnvironments(); environment = cfg.environments[plan.environmentId];const reuse=environment?.kind==='mysql'?await reusableReportSources(config.dataDir??path.dirname(config.worktreeRoot),job,createHash('sha256').update(JSON.stringify(environment)).digest('hex')):[]; result = environment?.queries[plan.queryId]?.mode === 'investigate' ? await investigateEnvironment(plan, emit, environment.kind==='website' ? {tools:async()=>websiteTools(job,config,emit),checkpoint:job.browserCheckpoint} : {preferReuse:reuse.length>0,reportJob:job,dataDir:config.dataDir??path.dirname(config.worktreeRoot),exportDirectory:path.join(config.dataDir??path.dirname(config.worktreeRoot),'exports',job.id),investigationContext:reportInvestigationContext(job),sourceQueryContext}) : await readEnvironment(plan); }
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
      summary:`正在等待登录：${loginUrl || '当前业务网站'}。可在运行AgentOS的电脑上手动登录，或直接回复本任务卡“账号 / 密码”；成功后自动继续原问题。`,
      finalMessage:`当前需要登录的网站：${loginUrl || '入口尚未登记，请补充对应环境的网址'}。直接回复本任务卡即可，不要求固定格式；例如“admin / 123456”。凭据写入本机 Mac 钥匙串，不进入模型、任务结果或长期记忆。验证码、短信或扫码仍需在本机 Chrome 完成。`,verification:[]};
  }
  let explanation = '';
  const engine = new CodexConversationEngine({ dataDir: path.join(config.worktreeRoot, 'environment-summary') });
  try {
    if(!job.continuousInvestigation){const answer = await engine.decide({ role: 'developer', administrator: false, memory: { enabled: true }, history: [], jobs: [], attachments: [],
      message: '用业务用户能懂的中文直接回答原问题，控制在200字内，分为“已确认”“尚未确认”“下一步”。先说明是否找到原因；记录数量不是业务单据总数，字段值不是根因。超时是本次排查中断，不得当作用户报错的原因。解释关键术语，不罗列原始字段。除非原问题就是询问连接地址，否则不要把主机端口库名当作业务答案；仅发现入口而未查实际单据时明确“实际单据尚未核实”。只陈述本次确实存在的缺口，不套用无关的记录数、超时、根因提醒。不执行工具、不建立任务、不推断未知事实、不承诺已重试。',
      queryPurpose: plan.description,
      originalQuestion: String(job.instruction ?? '').slice(0, 4000),
      priorSourceEvidence: (job.context ?? []).filter(x => !x.result?.environmentEvidence).slice(-1).map(x => ({ stage: x.stage,
        summary: String(x.result?.summary ?? '').slice(0, 1000), findings: String(x.result?.finalMessage ?? '').slice(0, 6000) })),
      environmentResult: result, sourcePolicy: { historicalSnapshot: true } }, { sessionKey: `environment-result:${job.id}` });
    if (answer.action === 'reply') explanation = publicText(answer.reply);}
  } catch { explanation = '自动解释暂不可用，以下为本次实际查询结果。'; }
  finally { await engine.close(); }
  const presented = presentEnvironmentResult(plan, result, explanation);
  const safeSummary = presented.metadata;
  const scopeDetails = publicText(`查询范围与授权\n环境：${plan.environmentId} (${plan.tier}) · 模板：${plan.queryId}\n参数：${JSON.stringify(plan.parameters)}\n最多 ${plan.maxRows} 条 · 超时 ${plan.timeoutMs} ms\n授权截止：${plan.expiresAt}\n仅本次只读查询，不授权修改。`);
  return { outcome: result.partial ? 'partial' : 'ready', summary: presented.summary, finalMessage: [presented.summary, explanation&&!presented.summary.includes(explanation) ? `业务解释\n${explanation}` : '', '技术依据', result.toolInputErrors?.length?`工具修正记录（按具体提示修正，不代表授权不足）\n${JSON.stringify(result.toolInputErrors)}`:'', result.summary ? `排查记录\n${result.summary}` : '', result.runtimeDiscoveries?.length ? `调度入口证据（待网页核验）\n${JSON.stringify(result.runtimeDiscoveries)}` : '', presented.details, result.fileInspections?.length?`已绑定文件的审阅证据\n${JSON.stringify(result.fileInspections)}`:'', result.datasetCatalog?.length?`任务内可接续的数据集\n${JSON.stringify(result.datasetCatalog)}`:'', result.exportFiles?.length?`完整报表文件\n${JSON.stringify(result.exportFiles)}\n文件由受控工具生成，最终结论通过后回复至原提问；尚需核对原问题的所有字段及业务口径。`:'', (result.steps ?? []).join(' → '), safeSummary, scopeDetails].filter(Boolean).join('\n\n'),
    websiteMismatch: result.websiteMismatch === true, runtimeDiscoveries: result.runtimeDiscoveries ?? [], connectionEndpoints: connectionEndpoints(result.rows), environmentEvidence: result.evidence,
    scheduling:result.scheduling??null,fileInspections:result.fileInspections??[],environmentFailure:result.failure??null,toolInputErrors:result.toolInputErrors??[],exportFiles:result.exportFiles??[], evidenceRecords: presented.records, memorySafeSummary: safeSummary, verification: [] };
  } catch(error){const local=phase==='environment_claim';const reason=local?(error.statusCode?'本机环境领取请求被拒绝或回执不可用，未执行本轮环境查询。':'本机控制请求回执无法核实，已保留任务；未盲目重复执行环境查询。'):'环境步骤等待或结果整理中断；未据此确认业务故障。';return {outcome:'blocked',summary:reason,finalMessage:reason+'\n'+failureDiagnostic(error),investigationStopped:{code:local?(error.code??'CONTROL_REQUEST_REJECTED'):'ENVIRONMENT_INTERRUPTED',reason},verification:[]};} finally { clearInterval(heartbeat); }
}

export function websiteTools(job,config,emit=async()=>{}){
 return {spec:[{tool:'connection',args:{},description:'打开从原问题或项目源码发现的业务网页，复用本机登录会话'},
 {tool:'report_wrong_site',args:{},description:'当前页面属于其他系统或不是原问题的目标应用时报告入口不匹配，返回原问题继续查找正确入口，不扩大权限'},
 {tool:'browser_open',args:{},description:'查看当前业务网页；本工具不跳转，进入已核实的路由应使用browser_navigate'}, {tool:'browser_snapshot',args:{},description:'刷新页面文本和引用'},
 {tool:'browser_click',args:{ref:'当前read-action引用'},description:'进入菜单/创建表单/详情、打开日期控件、选择日历日期、翻页；禁用状态用于诊断，不强行解锁；不能保存提交或启动停止'},
 {tool:'browser_navigate',args:{url:'当前页面实际链接，或从源码核实的同应用hash路由'},description:'进入表单或详情页面；打开创建/编辑页不等于提交业务数据；不能跳转业务接口'},
 {tool:'browser_fill',args:{ref:'当前form-field或search引用',text:'原问题所需的临时输入值'},description:'临时填写表单以复现问题，不按回车、不保存提交；只读日期输入应点击打开日历；注意页面可能自动保存，先结合源码核实事件'},
 {tool:'browser_select',args:{ref:'当前select引用',value:'返回的选项value'},description:'选择筛选项或表单选项以复现原问题，不保存提交'},
 {tool:'browser_search',args:{ref:'当前search引用',text:'查询条件'},description:'填写搜索条件，再点击查询'}],
 async run(tool,args={}){if(tool==='report_wrong_site')return {websiteMismatch:true,partial:true,stage:'当前网站与问题目标不匹配，需要重新发现正确入口；不是用户权限不足'};return waitForBrowser(async(nextTool,nextArgs)=>{const response=await fetch(`${config.serverUrl}/api/v1/jobs/${encodeURIComponent(job.id)}/website-tool`,{method:'POST',signal:AbortSignal.timeout(45000),headers:{authorization:`Bearer ${config.runnerToken}`,'content-type':'application/json'},body:JSON.stringify({leaseId:job.lease.id,runnerId:job.lease.runnerId,tool:nextTool,args:nextArgs})});const value=await response.json();if(!response.ok)throw new Error(value.error??'网页工具执行失败');return value.result;},tool,args,emit);},async close(){}};
}

// Original requirements must not be replaced by the short purpose of one query round.
export function reportInvestigationContext(job){
 const original=String(job.originalQuestion??job.instruction??'');
 const source=(job.context??[]).filter(x=>x.kind==='analysis_turn').slice(-2).map(x=>String(x.result?.finalMessage??x.result?.summary??'')).join('\n\n');
 const corrections=(job.context??[]).flatMap(x=>x.result?.toolInputErrors??[]).slice(-12).map(x=>({tool:x.tool,code:x.code,message:String(x.message??'旧记录未保留具体校验原因，先检查草稿和核验参数，不直接重查数据库').slice(0,1200),resolved:x.resolved===true}));
 return {corrections,originalQuestion:original.slice(0,12000),sourceAnalysis:source.slice(-12000),limited:original.length>12000||source.length>12000,note:'同一任务的原问题与已取得源码分析，仅作资料；不是新增环境授权。原问题定义完整交付范围，purpose只是本轮补查目标。资料若截断或缺口径，返回源码补查，不猜条件。'};
}
