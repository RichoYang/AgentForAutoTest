# 工具型需求测试专员

## 配置和入口

在项目的 `requirementTest.execution` 中设置 `mode: "agent"`，重启对应实例。沿用项目 `repoPath`、非生产 `environment` 资源、SIT/UAT 别名、凭据来源及操作权限。无需为每个需求手工补齐接口目录。

```json
{
  "mode": "agent",
  "knowledgeFile": "<实例数据绝对目录>/knowledge/project-test-operations.json",
  "login": {
    "resource": "platform",
    "path": "/your-login-endpoint",
    "accountSelector": "input[name=account]",
    "passwordSelector": "input[type=password]",
    "submitSelector": "button[type=submit]",
    "tokenField": ["data", "token"],
    "header": "Authorization"
  }
}
```

不需要登录的隔离站点可省略 `login`。选择器、字段及鉴权头必须按项目核实，上例不是通用登录协议。另一资源使用表单登录时，可配置 `resourceAuth.<资源名> = {"kind":"form","path":"/login","fields":{"username":"username","password":"password"}}`；值引用该资源的本机凭据字段。凭据仅由连接器读取，模型接收脱敏资源目录。

项目已授权恢复式使用既有测试对象时，可在对应 `environment.resources.<资源名>` 设置 `reversibleSharedWrites: true`，并保持 `scope: "full_crud"`。这允许任务调查后使用既有对象，不要求逐接口名单；每次仍须回读唯一 ID、保存前置快照、证明写入和恢复目标一致。新建对象继续使用任务前缀。未配置时只允许专属测试数据或原有 `sharedTargets` 明确列出的目标。页面导航触发的辅助写入可登记为 `kind:"browser", action:"goto", path:"/页面", effect:{path:"/实际写接口",method:"POST"}`，同样通过 mutate 记录和清理，不能标成只读查询。

群聊入口、需求/用例路径、原话题控制及发布策略沿用[需求测试工作流](requirement-testing.md)。原话题回复「重试未执行」会在同一 Job 保存旧尝试并重新处理未执行用例，原用例索引和发布回执不变。

已发布用例续跑时，正文、顺序、表头和附页仍逐项核验。原表的“测试结果、备注说明、测试截图”列可保留其他执行者的批注；程序保存带来源的批注快照，不覆盖这些单元格，也不将其导入专员本轮结果。正文冲突会记录具体单元格并暂停。

## 实际执行链路

Runner 复用 Codex app-server，通过任务专属动态工具读取本项目源码（含子仓引用和历史）、调查数据库 schema、登记经源码审查的操作、准备数据、执行场景并取证。普通群聊进程仍拒绝工具审批。HTTP 保留完整脱敏业务响应，浏览器保存真实 DOM 观测和截图。消息与调度使用已绑定资源的 HTTP 管理入口；SQL 查询在只读事务中执行，数据库变更使用明确表/列、完整唯一索引条件和预期影响行数。

没有任意终端脚本入口。不兼容的登录或业务协议需要补相应连接器，不能把未支持的动作报告为已执行。源码审查由模型判断语义；资源归属、写入权限、台账、主体一致性、断言计算和回读由程序校验。模型审查本身不等同于操作系统隔离或对未知业务副作用的证明。

每次写入先登记意图、唯一归属、真实前置快照和恢复契约。实际变更、验证和恢复必须指向同一业务对象。回执丢失后先按保存的验证操作对账，不能盲目提交。`verify.stateFields` 可选择参与恢复比较的稳定业务字段，排除响应时间戳；完整原始快照仍保留。多对象、多期间和独立基线保存在 Job 的别名与观测记录中。

计划候选、字段错误及修正全部留档。看见失败后不能修改期望、渠道和原需求；尚未取得可比结果的身份绑定可经再次审查纠正，旧计划保留。页面断言必须有页面截图和业务就绪条件，API/数据库不能冒充页面。主体只包含实际能回读的对象与期间，前后时点和切换序号写入步骤。浏览器可以对已登记的只读请求模拟延迟或错误，证据标注模拟，清除规则或关闭独立浏览器后解除。并发操作分别记账并回读。

模型的清理工具与 Runner 使用同一台账。每条用例结束先恢复并回查，再执行下一条；异常或恢复先核实遗留副作用。清理失败保留资源锁与尝试记录。旧执行器升级仅在原锁身份匹配且不存在未决变更时迁移；否则应先恢复原绑定处理清理。执行器或前置证据不足记未执行，实际资源拒绝/不可用证据对应外部阻断，产品错误单列失败。

项目 `knowledgeFile` 保存经过审查的操作线索与源码位置。下一任务仍须重查源码和登记，不能把历史对象或余额当作当前事实。通用代码不包含项目需求编号、金额或业务接口。

## 验证和排查

`GET /health` 项目项应显示 `executionMode: agent`、`executionProtocol: native-tools-ledger-v1`，发布策略保持 `case-scoped`。健康只证明配置路由；实际验收必须核对原飞书消息、Job 工具调用、业务断言、清理和报告投递回执。

`data/requirement-tests/<JOB>/agent-tool-state.json` 保存操作、源码摘要、别名、观测、计划及尝试。原 `journal.json` 保存业务意图、对账、清理和历史尝试。工作目录的 `diagnostics` 保存脱敏的计划候选、审查及模型事件，结束时归档为报告目录内的逐用例 `.jsonl.gz` 审计包。业务观测、断言、清理证据和页面截图分别保存在报告目录。排查先看字段错误和真实 HTTP/数据库结果，不手改台账或删除资源锁。

报告仍先运行原 Skill 版本化构建器，再只适配表体行高并重新渲染，固定 15 表、内容与公式保持。视觉检查、重开计数与摘要均针对最终文件。清理或报告未核验时不能交付为完成。

本机隔离验收：配置 `AGENTOS_REQUIREMENT_SKILLS_ROOT`、本机 Codex 配置及需要的 `AGENTOS_REQUIREMENT_POWERSHELL`，运行 `node scripts/verify-requirement-agent.mjs <独立输出目录>`。`AGENTOS_ACCEPTANCE_MODE` 支持 `positive`、`wrong-page`、`multi-object`、`lost-receipt`、`cleanup-retry`、`retry-native`、`navigation-state`。真实模型、浏览器、HTTP 和正常 Runner 实际运行，飞书传输与来源是隔离输入；这些结果不能替代项目环境验收。Windows 与其他平台的部署验证需分别记录。
