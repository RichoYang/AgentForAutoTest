// Diagnostics are allowlisted metadata. Never retain raw rejected parameters or exception text.
export function queryRejection(error, job) {
 const d=error.queryDiagnostic;
 let code,reason,correction,recoverable=false;
 if(d?.code==='TEXT_PARAMETER'){
  code=d.code;reason=`第${d.index+1}个查询文本参数不合格（${{type:'类型错误',empty:'为空',control_characters:'含换行或控制字符',length:'长度超限'}[d.reason]}；长度${d.length??'非文本'}，${d.maxLength==null?'无固定目的文本长度上限':'上限'+d.maxLength}）。`;
  correction=`保留原业务目标，将第${d.index+1}个参数改为非空单行文本，${d.maxLength==null?'保留完整目标，不设固定目的文本长度上限':'最多'+d.maxLength+'字符'}；复杂目标可分解为明确的只读步骤，不能删掉原目标。`;recoverable=true;
 }else if(d?.code==='PARAMETER_COUNT'){
  code=d.code;reason=`查询参数数量不符，需要${d.expected}个，收到${d.actual??'非数组'}。`;correction='按当前环境目录的模板参数定义重新生成申请。';recoverable=true;
 }else if(d?.code==='INTEGER_PARAMETER'){
  code=d.code;reason=`第${d.index+1}个查询参数需要${d.min}至${d.max}之间的整数。`;correction='核对模板和业务含义后修正数值；不要为了通过校验任意截断或改变查询范围。';recoverable=true;
 }else if(d?.code==='CONVERGENCE_STALLED'){
  code=d.code;reason=d.reason;correction='停止创建新的环境子任务，保留已有证据并交由项目负责人形成最终结论、明确剩余缺口。';recoverable=false;
 }else if(d?.code==='REPEATED_TARGET'){
  code=d.code;reason=`AgentOS 自动收敛规则暂停了本次追加查询（不是用户拒绝，也不是权限拒绝）：${d.reason}`;
  correction='保留已有证据，针对仍未核实的核心目标缩小查询范围，或改用已登记的数据库、网页、日志、配置或源码证据路径。';recoverable=true;
 }else if(d?.code==='WEBSITE_TARGET_INVALID'){code=d.code;reason=d.reason;correction=d.correction;recoverable=true;
 }else if(['SOURCE_ENVIRONMENT_UNKNOWN','SOURCE_TIER_CONFIG','SOURCE_TIER_UNMAPPED','SOURCE_ENVIRONMENT_SELECTION','ENVIRONMENT_MISMATCH','WEBSITE_TIER_INVALID'].includes(d?.code)){
  code=d.code;reason=d.reason;correction=d.correction;recoverable=d.code==='WEBSITE_TIER_INVALID';
 }else{
  const known={
   '重复环境查询，需要调整范围或补充新证据':['DUPLICATE_QUERY','相同查询已在本问题申请过。','先检查已有申请、审批和结果；复用证据或针对剩余缺口提出不同查询，不能重复申请。',true],
   '环境或查询模板未配置；请管理员在本机配置':['ENVIRONMENT_TEMPLATE','目标环境不属于本项目或查询模板未配置。','核对本项目环境目录；缺少接入时补齐配置。',false],
   '本环境未配置当前机器人对应的查询审批人':['APPROVER_MISSING','本环境未配置当前机器人对应的审批人。','请维护者在本机补齐环境审批人配置。',false],
   '当前阶段不允许申请环境查询':['INVALID_STAGE','当前任务阶段不允许申请环境查询。','请维护者核对任务状态和执行阶段。',false],
   '开发角色未配置':['DEVELOPER_MISSING','开发执行角色未配置。','请维护者补齐开发角色配置。',false]
  };
  [code,reason,correction,recoverable]=known[error.message]??['QUERY_PLAN_ERROR','查询申请规划发生未分类错误。','请维护者检查本机环境配置和规划链路；未扩大权限。',false];
 }
 let repeated=0;
 for(const entry of [...(job.context??[])].reverse()){
  if(entry.result?.environmentEvidence)break;
  const previous=entry.result?.queryRejection;
  if(previous){if(previous.code!==code)break;repeated++;}
 }
 const retry=recoverable&&repeated<2;
 return {code,reason,correction,retry,attempt:repeated+1,...(recoverable&&!retry?{pause:'同类申请错误连续自查后仍未修正，已暂停重复申请。'}:{})};
}
