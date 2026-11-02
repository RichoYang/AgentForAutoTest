const stages = Object.freeze({
  source_analysis:'源码调查',environment_read:'环境只读核验',environment_claim:'领取环境执行范围',
  codex_execution:'模型分析与结果返回',codex_start:'启动模型执行进程',task_worker:'任务执行子进程',task_worker_start:'启动任务执行子进程',
  control_result:'保存任务结果与状态回执',attachment_read:'读取任务附件',
  'account/read':'核对本机Codex登录状态','initialize':'启动本机Codex服务','thread/start':'建立Codex查询会话',
  'browser.launch': '启动后台浏览器', 'browser.open-login': '打开登录页面',
  'browser.login-form': '等待登录表单', 'browser.login-submit': '提交浏览器登录',
  'browser.login-result': '核验浏览器登录', 'browser.open-config': '打开配置列表',
  'browser.click': '点击页面控件', 'browser.search': '搜索页面', 'browser.snapshot': '读取页面', 'browser.operation': '浏览器操作',
  'browser.reuse-session': '复用已登录页面',
  period_dataset:'补齐期间并计算分组累计',group_dataset:'分组查询与保存数据',linked_group_dataset:'关联分组查询与保存数据',inspect_dataset:'读取任务内数据集',list_datasets:'列出任务内数据集',enrich_dataset:'组合业务维度',compare_datasets:'核对数据集差异',inspect_report:'读取文件绑定审阅证据',refresh_report:'集中刷新与重算报表',compose_report:'生成清单草稿',finalize_report:'核验最终清单',read_source_evidence:'读取已核验源码',
  'tct.login':'调度平台登录','tct.read':'调度平台读取',groups:'读取调度分组',tasks:'读取定时任务',task_detail:'读取定时任务规则',task_batches:'读取任务执行批次',
  connection: '环境连接检查', discover: '发现配置', read_config: '读取配置',
  browser_open: '打开后台浏览器页面', browser_click: '点击页面控件',
  browser_snapshot: '读取页面及字段状态', browser_search: '搜索页面', browser_navigate: '进入业务表单页面', browser_fill: '临时填写表单复现', browser_select: '选择页面选项',
  select: '数据库只读查询', schema: '读取表结构', tables: '发现数据表', planning: '规划下一步排查'
});
// Only fixed, reviewed text reaches cards. Never echo exception bodies, URLs or credentials.
const rules = [
 ['DATABASE_NOT_FOUND',/ER_BAD_DB_ERROR/,'目标数据库核验','已配置的数据库在目标服务器上不存在，当前数据查询尚未完成。','核对当前系统、环境与实际发布配置中的库名；保留已有证据，不创建数据库或改用其它环境，也无需盲目重输密码。'],
 ['DATABASE_OBJECT_MISSING',/ER_NO_SUCH_TABLE/,'目标表核验','目标表在当前数据库中不存在，不能据此解释为业务记录为空。','核对当前环境、源码版本和真实表结构，保留其它有效结果，不创建表或跨库猜测。'],
 ['MONGO_AMOUNT_TYPE',/MONGO_AMOUNT_TYPE/,'MongoDB金额类型核验','金额字段含非数值BSON类型，直接数值聚合未通过；不能把数字字符串静默算成零。','保留完整明细并核对类型，使用精确十进制整理及独立原值分组核验；无效值不能丢弃。'],
 ['MONGO_NULL_AMOUNT',/MONGO_NULL_AMOUNT/,'MongoDB金额完整性核验','金额字段存在真实空值或缺失，不能自动补零。','复用已存明细，核对缺失范围和业务含义，保留有效证据，不重跑整项任务。'],
 ['TCT_AUTH', /TCT_AUTH|TCT_LOGIN_PROTOCOL/, '调度平台登录核验', '调度平台登录或会话核验未完成，未触发或修改任务。', '维护者核对本机凭据、验证码、多因素认证及登录协议，保留已有证据后在原问题接续。'],
 ['TCT_NETWORK', /TCT_NETWORK|TCT_HTTP/, '调度平台连接', '调度平台本次连接失败、超时或HTTP读取失败，未取得完整响应。', '核对公司云网络及服务，恢复后继续原问题；不把读取失败当成任务没有执行。'],
 ['TCT_SCOPE', /TCT_SCOPE|TCT_ORIGIN|TCT_CLOSED/, '调度读取范围核验', '请求的调度分组或任务不在当前有效范围，或返回范围发生变化。', '核对当前系统、环境、精确分组及任务归属；不跨环境借用权限。'],
 ['TCT_RATE_LIMIT', /TCT_RATE_LIMIT/, '调度平台读取限流', '平台在短暂退避后仍拒绝当前读取，已有结果保留。', '待平台额度恢复后接续当前读取，不重跑业务任务或触发定时任务。'],
 ['TCT_RESPONSE', /TCT_RESPONSE|TCT_PAGINATION/, '调度结果完整性核验', '调度响应或分页不完整，未将缺失数据当作空结果。', '保留已读证据，核对平台响应后接续缺页。'],
 ['TCT_API', /TCT_API/, '调度只读接口', '调度平台拒绝本次只读接口，未触发或修改任务。', '维护者按任务内具体接口及平台错误码核查权限或平台状态，恢复后在原问题接续。'],
 ['MONGO_SERVER_VERSION', /MONGO_SERVER_VERSION/, 'MongoDB协议兼容检查', '驱动与目标MongoDB协议版本不兼容，尚未查询业务数据。', '维护者选用已核验的兼容驱动；不升级或重启生产数据库，不把版本问题解释为密码错误。'],
 ['MONGO_DATE_TYPE_AMBIGUOUS', /MONGO_DATE_TYPE_AMBIGUOUS/, 'MongoDB日期完整性核验', '候选范围的日期字段存在非日期、空值或缺失；不能把它当范围外数据再补零。', '核对实际字段、业务口径及数据类型，保留已有证据；不能猜测时区或未知金额。'],
 ['MONGO_READ_PERMISSION', /MONGO_READ_PERMISSION|MONGO_ACCOUNT_UNVERIFIED|MONGO_ACCOUNT_HAS_WRITE_PRIVILEGES/, 'MongoDB读取权限检查', '账号未通过当前读取权限或账号模式核验，未绕过权限执行。', '核对管理员登记的账号策略和实际授权；程序只读工具不等于账号自身只读。'],
 ['MONGO_COLLECTION_SCOPE', /MONGO_COLLECTION_SCOPE|MONGO_COLLECTION_MISSING/, 'MongoDB集合覆盖检查', '请求集合超出当前范围或集合未实际存在，不能按无发生额处理。', '先列出已授权实际集合，核对完整月份范围；缺失来源应保留缺口，不能补零。'],
 ['HARNESS_REVIEW_REQUIRED', /Harness版本在任务链中发生变化/, '执行规范复核', '任务保存的执行规范与当前版本不同，已暂停以等待维护复核。', '维护者核对规范差异及原授权，保留已有证据后在原任务恢复；这不是业务数据或网络故障。'],
 ['LOCAL_CONTROL_TIMEOUT', /LOCAL_CONTROL_TIMEOUT/, '本机状态回执', '本机状态接口未及时返回，原请求可能已经受理；尚未确认本次状态是否保存。', '保留任务与成果，核对原请求回执后接续；不重复业务查询或写入。'],
 ['LOCAL_CONTROL_UNCERTAIN', /LOCAL_CONTROL_UNCERTAIN/, '本机状态回执', '本机状态接口无法核实原请求的持久回执，未盲目重复提交。', '维护者核对控制面与回执记录，在原问题接续。'],
 ['CODEX_STREAM_INTERRUPTED', /stream (?:disconnected|closed|ended) before completion|connection closed before message completed/i, '模型分析与结果返回', '模型回复流在完整结果返回前断开；现有记录不能区分本机网络、代理或上游服务原因。', '检查模型接口及网络，保留原会话和已有证据，恢复后从原问题接续。'],
 ['NETWORK_RESET', /ECONNRESET|EPIPE|socket hang up|connection reset by peer/i, '网络连接', '连接在通信过程中被重置或关闭，本次请求未取得完整响应。', '检查对应服务及网络连接，恢复后核对原步骤状态，不盲目重复业务写入。'],
 ['NETWORK_DNS', /ENOTFOUND|EAI_AGAIN/, '网络地址解析', '服务地址的域名解析失败，尚未建立目标连接。', '检查本机网络、DNS及配置地址，恢复后继续原问题。'],
 ['NETWORK_REFUSED', /ECONNREFUSED/, '网络连接', '目标服务拒绝连接，本次未能建立连接。', '检查目标服务是否运行及访问路径；不能仅据此判断是本机断网。'],
 ['TASK_WORKER_EXIT', /Task worker exited/, '任务执行子进程', '任务执行子进程提前退出，未返回完整结果；退出码或信号不能单独证明网络故障或内存不足。', '维护者按任务编号核对进程及本机日志，保留已有成果，不自动重跑整个任务。'],
 ['CODEX_PROCESS_EXIT', /Codex exited/, '模型执行进程', '模型执行进程未正常返回结果，现有记录尚未确认更具体的中断原因。', '维护者核对模型进程及接口记录，保留已有会话和证据。'],
 ['CODEX_TURN_FAILED', /Codex turn failed/, '模型分析与结果返回', '模型执行返回失败，但未提供可确认的更具体原因。', '维护者核对该轮模型接口记录，不把执行失败解释为业务故障。'],
 ['CODEX_RESULT_INVALID', /Codex result invalid|Missing valid outcome/, '模型结果解析', '模型返回内容未通过结果格式校验，未将其记为完整结论。', '保留已有证据，维护者检查结果协议与模型返回；无需据此缩小业务查询范围。'],
 ['LOCAL_FILE_UNAVAILABLE', /\bENOENT\b/, '本机文件或程序读取', '执行需要的本机文件或程序不存在，当前步骤未完成。', '维护者核对本机安装、配置与任务文件，保留现有成果。'],
 ['SSH_EXECUTION', /SSH_(?:EXECUTION|STDIN|PROTOCOL|RESPONSE)/, 'SSH远程数据库通道', '跳板机远程执行通道未能完成，未回退本机数据库连接或转发。', '维护者核对跳板机网络、固定主机密钥、钥匙串凭据及远端运行时；不要重复提供数据库密码或建立隧道。'],
 ['SSH_REMOTE_POLICY', /REMOTE_READONLY_SQL/, '远端只读SQL校验', '远端拒绝了非固定只读语句，未执行写入或存储过程。', '仅使用已提供的受控基础表查询与报表工具，不提交任意SQL。'],
  ['CODEX_RPC_TIMEOUT', /CODEX_RPC_TIMEOUT|Codex RPC timed out/, '本机Codex接口等待', '本机Codex接口返回超时，或未在显式请求等待期内返回；不能据此判断数据库或查询范围有问题。', '检查本机Codex进程与接口状态，保留原问题；无需缩小业务查询范围。'],
  ['CODEX_DISCONNECTED', /Codex app-server (disconnected|stopped|is not connected|could not start)/, '本机Codex连接', '本机Codex子进程退出或连接断开，当前调查尚未完成。', '检查本机Codex进程与启动配置，恢复后继续原问题；这不是已确认的业务故障。'],
 ['REPORT_INSPECTION', /REPORT_INSPECTION/, '文件审阅证据', '当前文件的登记、摘要或计算来源读取未通过；不代表业务公式已证实错误。', '按已登记fileId读取同一任务的核验资料，不索要本机已有CSV、不重复查库或生成文件。'],
  ['DATASET_SERIALIZATION', /Invalid string length|ERR_STRING_TOO_LONG/i, '任务数据序列化', '数据超过单个字符串的引擎容量，保存或核验尚未完成；不是数据库故障。', '使用支持分块数据集与逐行摘要的程序接续；保留已有证据，不把取数成功当保存完成。'],
  ['DATASET_CAPACITY', /DATASET_CAPACITY/, '任务数据存储', '本任务中间数据达到实际空间预算，已有成果仍保留；不是数据库故障。', '先复用已有完整数据并修正草稿；确需增加空间时由维护者评估，不重复查询或删除被引用证据。'],
  ['REPORT_INPUT', /\[REPORT_INPUT\]/, '数据集与报表参数校验', '数据集引用、关联列或报表核验参数不符合要求；不是数据库连接故障。', '依据本轮工具返回的具体校验提示修正；使用list_datasets及实际字段，不重复取数或扩大权限。'],
  ['SOURCE_INPUT', /\[SOURCE_INPUT\]/, '源码读取参数校验', '源码引用或行号不符合当前证据目录，未读取其他文件。', '使用当前sourceQueryContext中的ref和有效行号继续。'],
  ['SOURCE_CHANGED', /源码内容发生变化|源码范围、类型或大小发生变化/, '源码工件校验', '已核验源码工件已改变，未继续使用变化内容。', '回到源码阶段重新核验工件，不绕过摘要或路径校验。'],
  ['BROWSER_BRIDGE', /Chrome自动化|Apple.*JavaScript|通过 AppleScript|日常Google Chrome|Chrome窗口|日常Chrome接管|不能获取对象/, '日常浏览器接管', '日常Chrome自动化通道未就绪，并非业务账号无权限。', '在Mac打开Chrome，开启查看→开发者→允许Apple事件中的JavaScript，并确认系统自动化权限。'],
  ['BROWSER_SCOPE', /浏览器已离开本次批准|原Chrome标签页已关闭/, '浏览器页面范围', '原标签页已关闭或离开本次批准的应用，未读取其他页面。', '打开正确应用页面后重试；不要重复申请业务账号权限。'],
 ['LOCAL_PERMISSION', /\bEPERM\b|\bEACCES\b|Operation not permitted/i, '本机执行权限', '本机系统权限拒绝了当前操作，尚不能据此判断网络是否中断。', '维护者核对对应程序或文件的系统授权，不关闭业务权限校验。'],
  ['QUERY_ALREADY_STARTED', /QUERY_ALREADY_STARTED/, '任务接续校验', '任务已启动，但本次领取没有有效的登录接续凭证；未继续访问网站。', '请维护者检查登录接续状态，不需要用户补充查询范围。'],
  ['LEASE_EXPIRED', /查询租约已失效/, '任务领取校验', '当前执行器的任务租约已失效，未继续查询。', '检查任务恢复与执行器状态，不能通过重复批准解决。'],
  ['COLUMN_LIMIT', /\[COLUMN_LIMIT\]/, '查询字段校验', '单次查询字段超过12个，查询未执行；不是授权不足。', '减少为相关字段后继续，可按相同筛选条件分次查询。'],
  ['SCHEMA_REQUIRED', /\[SCHEMA_REQUIRED\]/, '查询结构校验', '尚未读取目标表结构，查询未执行。', '先读取目标表schema，再使用返回字段查询。'],
  ['SCHEMA_FIELDS', /\[SCHEMA_FIELDS\]/, '查询字段校验', '查询字段尚未在已读取结构中确认，查询未执行。', '读取目标表结构或下一页，并使用实际字段。'],
  ['QUERY_INPUT', /\[QUERY_INPUT\]/, '查询参数校验', '筛选条件或字段参数格式不符合工具要求，查询未执行。', '在原授权范围内修正参数，无需因此重新授权。'],
  ['RESULT_LIMIT', /工具结果超出大小限制|结果超出大小|Response limit/, '工具结果整理', '结果超过单次返回大小限制，并非连接失败。', '缩小查询范围或分页读取；表结构可指定目标表继续。'],
  ['TLS_UNSUPPORTED', /HANDSHAKE_NO_SSL_SUPPORT|does not support secure connection/i, '数据库TLS握手', '数据库服务器不支持当前要求的TLS加密连接；尚未开始查询。', '请运维启用TLS；如需内网非TLS例外，必须由管理员另行明确确认，程序不会自动降级。'],
  ['TLS_VALIDATION', /certificate|SSL|TLS|HANDSHAKE/i, '数据库加密连接', '数据库TLS连接或证书校验未通过。', '请管理员核对服务器TLS支持和信任证书；程序不会自动关闭验证。'],
  ['CREDENTIAL_SOURCE', /凭据引用|外部或加密凭据|目标数据库凭据|凭据字段|配置凭据|Nacos配置已改变/, '配置凭据解析', '配置已改变，或无法唯一解析目标数据库凭据。', '重新发现并确认配置；外部密钥或多个账号需要管理员指定正确来源。'],
  ['RESULT_CONTRACT', /Invalid partial (analysis|environment) evidence/, '结果提交校验', '程序拒绝了部分结果的证据格式，并非已确认的远端连接失败。', '联系维护者核对版本与结果协议；修复后重新发起查询。'],
  ['SCHEMA_COMPAT', /invalid_json_schema|Invalid schema for response_format|text\.format\.schema/i, '结构化结果协议', 'AgentOS提交给Codex的结果结构不兼容，模型尚未开始分析，也未访问业务环境。', '请维护者更新结果结构并重启AgentOS；用户无需补充问题、登录或重新授权。'],
  ['RESULT_GRACE_EXPIRED', /RESULT_GRACE_EXPIRED/, '结果提交校验', '环境读取已停止，但结果在允许的收尾时间内未能提交。', '重新发起任务；系统不会在授权到期后继续访问环境。'],
  ['MODEL_CAPACITY', /Selected model is at capacity|model.{0,40}(at capacity|overloaded|temporarily unavailable)/i, 'Codex模型服务', '当前选择的Codex模型暂时没有可用容量，并非业务代码、数据或权限错误。', 'AgentOS已在同一只读调查会话中自动重试一次；仍失败时请稍后重发，或在本机管理后台选择当前可用的模型。'],
  ['AUTH_REQUIRED', /认证未成功|Invalid login|Login required|credential|本机凭据|ChatGPT 登录|Unapproved login/i, '登录与凭据', '登录未完成或本机凭据不可用。', '在 AgentOS 所在电脑重新登录对应服务或解锁钥匙串。'],
  ['READ_PERMISSION', /只读账号权限|数据库账号含写权限|无权限|ER_ACCESS_DENIED_ERROR|HTTP 40[13]/i, '读取权限检查', '服务拒绝读取，或账号未通过只读权限核验。', '请管理员核对读取权限；核对当前账号策略与授权，不要关闭只读事务。'],
  ['TIMEOUT', /timeout|timed out|超时|ETIMEDOUT/i, '等待响应', '本次操作超过等待时限。', '检查具体超时环节、网络与服务，保留已有证据并在原问题恢复；不能据此判断业务异常或要求缩小整个问题范围。'],
  ['NETWORK', /ECONNREFUSED|ENOTFOUND|EHOSTUNREACH|ENETUNREACH|fetch failed|Operation not permitted/i, '网络连接', '执行环境未能建立网络连接。', '检查 AgentOS 所在电脑的内网连接、服务地址和网络权限。'],
  ['SCOPE_LIMIT', /超出范围|次数.*上限|超过次数|Write control|Redirect blocked|未开放|尚未批准|已过期|未通过|查询表或列|筛选条件/i, '授权与范围检查', '请求未通过当前只读范围、有效期或工具限额检查。', '补充具体查询目标；需要扩大范围时由管理员重新授权。'],
  ['PAGE_REFERENCE', /引用已失效|Not clickable|Invalid search|Unknown browser tool/i, '页面操作', '页面引用或操作参数已失效。', '重新打开页面并获取当前元素；不要复用旧引用。'],
  ['CODEX_RPC_ERROR', /CODEX_RPC_ERROR/, '本机Codex接口', '本机Codex接口返回错误，当前步骤未完成。', '检查具体Codex接口与登录状态，保留原问题和已有证据；无需缩小业务查询范围。'],
  ['HTTP_RESPONSE', /HTTP [45][0-9]{2}|Read failed|环境接口未成功响应/i, '服务响应', '服务接口返回失败状态，未据此确认业务查询是否完成。', '检查服务状态和接口兼容性；未据此判断数据库是否可连接。'],
];
const observedCodes=new Set(['ECONNRESET','ECONNREFUSED','ETIMEDOUT','ENOTFOUND','EAI_AGAIN','EPIPE','EHOSTUNREACH','ENETUNREACH','EACCES','EPERM','ENOENT']);
const exitSignals=new Set(['SIGTERM','SIGKILL','SIGSEGV','SIGABRT','SIGBUS','SIGILL','SIGINT']);
export function failureDetails(error,{stage}={}) {
  const chain=[],seen=new Set();for(let item=error;item&&typeof item==='object'&&!seen.has(item)&&chain.length<5;item=item.cause){chain.push(item);seen.add(item);}
  const httpStatus=[error?.httpStatus,error?.statusCode].find(n=>Number.isInteger(n)&&n>=100&&n<=599);
  const message = typeof error === 'string' ? error : chain.map(e=>`${String(e.code??'')} ${String(e.message??'')}`).join(' ')+(httpStatus?' HTTP '+httpStatus:'');
  const explicit=typeof error==='object'?error?.code:/^\[([A-Z_]+)\]/.exec(message)?.[1];
  const matched = rules.find(([code])=>code===explicit||message.trimStart().startsWith(`[${code}]`)) ?? rules.find(([,pattern])=>pattern.test(message));
  const [code, , phase, cause, next] = matched ?? ['EXECUTION_ERROR', null, '任务执行', '执行器遇到未分类错误，原因尚未确认。', '请维护者按任务编号检查本机日志；不要在群内发送原始日志或凭据。'];
  const diagnosticStage=[error?.diagnosticStage,error?.rpcMethod,error?.stage,stage].find(s=>Object.hasOwn(stages,s));
  const observedCode=[error?.observedCode,...chain.map(e=>e.code)].find(c=>observedCodes.has(c))??[...observedCodes].find(c=>new RegExp('\\b'+c+'\\b').test(message));
  return {code,stage:diagnosticStage??null,phase:diagnosticStage?stages[diagnosticStage]:phase,cause,next,
    ...(typeof error?.platformCode==='string'&&/^(RequestLimitExceeded|AuthFailure|UnauthorizedOperation|ResourceNotFound|InvalidParameter|InternalError|FailedOperation|MissingParameter|UnsupportedOperation)(\.[A-Za-z][A-Za-z0-9]*)?$/.test(error.platformCode)?{platformCode:error.platformCode}:{}),...(['DescribeGroups','DescribeTaskRecords','DescribeTaskDetail','DescribeTaskBatchRecords'].includes(error?.apiAction)?{apiAction:error.apiAction}:{}),...(observedCode?{observedCode}:{}),...(httpStatus?{httpStatus}:{}),...(Number.isInteger(error?.exitCode)&&Math.abs(error.exitCode)<256?{exitCode:error.exitCode}:{}),...(exitSignals.has(error?.exitSignal)?{exitSignal:error.exitSignal}:{})};
}
export function failureDiagnostic(error) {
  const d=failureDetails(error);
  return `错误码：${d.code}\n失败环节：${d.phase}\n原因：${d.cause}${d.apiAction?'\n只读接口：'+d.apiAction:''}${d.platformCode?'\n平台错误码：'+d.platformCode:''}${d.observedCode?'\n记录到：'+d.observedCode:''}${d.httpStatus?'\nHTTP状态：'+d.httpStatus:''}${d.exitCode!==undefined?'\n退出码：'+d.exitCode:''}${d.exitSignal?'\n退出信号：'+d.exitSignal:''}\n建议：${d.next}`;
}
export function safeExecutionError(error) {
  const d=failureDetails(error);
  return Object.assign(new Error(`[${d.code}] ${failureDiagnostic(d)}`),{code:d.code,...(d.stage?{diagnosticStage:d.stage}:{}),...(d.observedCode?{observedCode:d.observedCode}:{}),...(d.httpStatus?{httpStatus:d.httpStatus}:{}),...(d.exitCode!==undefined?{exitCode:d.exitCode}:{}),...(d.exitSignal?{exitSignal:d.exitSignal}:{})});
}
