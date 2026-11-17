# 跨 TPM、OA 与账务的需求测试

适用源码版本：AgentOS 1.65.0。运行要求沿用 Node.js 22.13 以上、23 以下。本次交付是框架代码和受控验证；原专员未部署，真实 UAT 尚未执行。Windows 是本轮验证平台，macOS 的新增交接流程未实测。

## 能力和边界

入口仍是原群的需求测试专员，执行器、权限校验、变更台账和 15 页工作簿继续复用。新增内容对应五类断点：侧边栏无法被后台调用、多系统及上传、跨用例留样、口径与发布追溯、正文和附件回传。

当前聊天可访问 Codex in-app browser；后台 Runner 没有可调用的直接桥接。`codex_sidebar` 使用可恢复交接，不启动独立 Chromium 冒充侧边栏。普通浏览器模式沿用 Playwright。可信宿主签名只能证明交接来源及文件字节，不能证明业务通过。每个业务断言仍须有状态、单号/事件号、流水及运行版本证据。

## 项目配置

在自己的 `projects.local.json` 的 `projects.<项目>.requirementTest` 合并配置，保留原 `bot`、文档身份、群/发起人名单、skills、锁和报告目录。修改配置后按正常停机部署流程重启该专员，不让两个实例共用一份数据目录。

```json
{
  "environment": {
    "name": "SIT", "platform": "TPM", "iniPath": "你的资源INI绝对路径", "lockKey": "测试资源锁键",
    "resources": {
      "tpm": { "section": "TPM.Sit.Platform", "scope": "create_update_read" },
      "oa": { "platform": "OA", "section": "OA.Sit.Platform", "scope": "create_update_read" }
    }
  },
  "feedback": {
    "enabled": true,
    "roles": { "产品确认人的open_id": "product", "开发人的open_id": "developer", "测试人的open_id": "tester" }
  },
  "execution": {
    "mode": "agent",
    "sidebar": { "publicKey": "可信宿主Ed25519公钥PEM全文", "provenance": "real" },
    "uploadDirectories": ["你的项目上传材料绝对目录"],
    "logins": {
      "tpm": { "path": "/实际登录入口", "accountSelector": "实际账号选择器", "passwordSelector": "实际密码选择器", "submitSelector": "实际提交选择器", "tokenField": ["实际令牌字段"], "header": "Authorization", "identityFields": { "userId": ["实际公开账号字段"] } },
      "oa": { "path": "/OA实际登录入口", "accountSelector": "OA账号选择器", "passwordSelector": "OA密码选择器", "submitSelector": "OA提交选择器", "tokenField": ["实际令牌字段"], "header": "Authorization", "identityFields": { "userId": ["OA公开账号字段"] } }
    },
    "caseReleases": { "实际CASE-ID": { "component": "web", "requiredCommits": ["必需修复的完整Git SHA"] } }
  }
}
```

登录字段是模板，须按两套真实入口配置，不保证任何站点使用相同登录协议。账号密码仍从各自 INI 节认证，不放进上述示例或消息。每个节配置 `account_role`、环境及允许操作。显式 `platform` 只允许另一个已授权测试平台，不放宽环境、数据库写入或资源操作权限。侧边栏回执须携带相符角色；不同资源使用不同 `resourceSessionId`。非侧边栏浏览器上下文及登录缓存按资源隔离。

## 侧边栏交接的实际操作

1. 原任务备注写“仅使用 Codex 自带侧边栏浏览器”。未配置可信宿主时，Runner 保存 `requirement-tests/<Job>/sidebar-task.json`（用例、样本、版本、当前结果），返回 `sidebar_handoff`，不执行业务动作。
2. 部署者在自己受控的宿主准备 Ed25519 密钥对。只把公钥放入 `execution.sidebar.publicKey`，私钥留在宿主密钥存储或受保护文件，不能交给模型或报告。受控测试必须使用 `provenance=controlled`，不能用它替代 `real` 配置。
3. 已配置宿主时，每个节点生成 `sidebar-handoff/<指纹>.pending.json`、`<requestId>.request.json`，`pending.json` 指向最近请求。执行端核对 binding（任务、用例、尝试、执行版本、环境、资源身份）和 action。按指定浏览器、独立账号执行；人工审批由审批人执行。若动作可能已发生，先完成回读对账，不重新提交。
4. 宿主把脱敏状态/流水/截图保存到该任务 `journal.reportDirectory`，编制下列 capture JSON。文件只填 basename 和实际 SHA-256，截图须遮盖密码、令牌、Cookie、敏感 URL 参数。Runner 对文本和已知凭据做检查；不能自动证明任意图片已脱敏，可信宿主须先检查图片内容。

```json
{
  "requestId": "原请求id", "fingerprint": "原请求指纹", "mode": "codex_sidebar", "provenance": "real",
  "hostSessionId": "实际Codex宿主会话", "resourceSessionId": "该系统独立会话", "role": "INI中的account_role", "identity": { "userId": "实际公开账号标识" },
  "observedAt": "实际观测的ISO时间",
  "files": [{ "path": "实际状态.json", "sha256": "文件真实SHA256", "sanitized": true }],
  "data": { "填写": "对应请求的真实返回结构" }
}
```

页面 `observe` 还要求 `data.screenshot.path` 指向 files 中的实际截图；HTTP 返回保留 `status` 和 `body`；认证返回公开身份字段。数据结构沿用原执行协议，以请求 action 和原连接器观测为准，不能只填写“成功”。

5. 在受控宿主运行 `node scripts/requirement-sidebar-receipt.mjs REQUEST CAPTURE PRIVATE_KEY REPORT_DIRECTORY`。脚本核对请求、时间和文件字节，写入同目录 `<requestId>.receipt.json`，不会控制浏览器，也不会判定用例通过。错配签名、篡改证据、跨资源共用会话或受控/真实来源不匹配会拒收。
6. 原发起人在原话题回复“继续测试”。Runner 在原节点接收回执并继续，有下一交接时再次等待。它不是跨日自动调度器；取消任务不会自动恢复。本轮只验证了签名交接协议，尚未完成真实宿主操作联调。

## 上传和动态网关映射

HTTP 注册契约支持 `multipart: {fields:{...}, files:[{field,path,sha256,name,type}]}`，路径为批准上传目录内的绝对路径。上传必须是已授权写操作；发送前重新核对文件字节。浏览器 `action=upload` 使用同一文件描述，业务自动提交必须通过 `mutate` 的 `effect.multipart` 注册路径、方法及字段。网络请求与预定字段、文件名、类型和哈希逐项核对；普通浏览器导航不能趁机写入。

从已核验只读接口取得网关映射后，调用 `source {action:"runtime",observationId,field}`，将实际观测字段转成可审计来源引用。它记录读取操作、资源身份和内容摘要；使用前重读核对，变化则拒绝。注册业务接口还须关联源码/实现来源并经现有独立审查，绑定环境、资源、路径、方法和输入约束。运行映射单独不能授予写权限。

## 共用单据、检查点及重跑

agent 工具 `sample` 支持 `register/inspect/retain/release`。先从真实只读观测取得实际单号、初态及预算，注册 `caseIds`、`cleanupOwner`。`keyField/stateField/budgetField` 都是该 observation 的字段路径；恢复值保存初态，变更自身继续保存原快照和恢复契约。业务系统自动生成的单号不必包含 runPrefix：先通过原 create 契约创建带任务归属的数据，再把返回的 `mutationKey` 作为 `originMutationKey` 注册样本，精确关联创建回执中的单号字段。仅同一资源、同一已证实创建对象的后续动作可沿用归属；其他旧数据仍需原有 sharedTargets/reversibleSharedWrites 授权。

每个 `mutate` 提供稳定 `sampleId/nodeId`，例如提交、审批、驳回、上账、关闭上账、关单。每个节点先落操作意图，再发请求，再落实际状态和证据。恢复会按同一节点对账：已生效则接收回读，未生效才允许操作，不确定则等待。不能仅靠 `phase=prepared` 判断未发送。任务目录使用操作系统锁，两个调度不能并发改同一任务样本；环境锁继续约束跨任务共享资源。

后续关联用例未完成时跳过该样本的逐例清理。跨日调用 `retain` 写明 `reason/continueAt/nextCondition/owner`，然后按用例记录等待条件。到期不会自动执行业务；负责人完成条件后，通过新观测调用 `release`，再在原话题继续或重试阻断项。显式“恢复清理”仍须按原契约回读确认，确认后才释放留样。

使用现有“重试失败”“重试阻断”只选相关用例。被保留的样本意图继续沿用；其他未决写入先清理。旧尝试、证据和源码读取记录保留。外部条件不足不直接判产品缺陷；二元验收报告将所有缺证据项列为失败，另保留内部状态、尝试路径、缺少条件和处理责任。

## 反馈和部署依据

启用 feedback 后按 bot 身份读原话题，记录消息 ID、作者、时间、正文和附件 SHA。角色由部署配置绑定：产品只有以“验收确认”开头的明确消息可变更口径；开发“已修复”和测试观察仅作为分开的材料。支持文件、图片及富文本中的附件引用；文本附件保存脱敏内容，二进制附件标记为已捕获字节、仍需内容审阅。尚未解释的图片或工作簿须通过现有需求材料读取流程补读，不能把下载成功认定为口径已确认。

来源或用例变更时先等待。产品确认须写出受影响用例 ID；原发起人再按提示发送“确认执行版本 <新来源64位摘要> 用例 CASE-A,CASE-B”。旧版本保存在 `versions/<版本>`；报告及证据包保持独立。仅明确未受影响且用例定义哈希一致的结果可复用，同时保留原执行版本、源码、证据和复用范围。尚有保留样本或未核验变更时不切版本，先核对处理它们。

源码分支完整 SHA、开发声明、发布 manifest 和实际运行产物分别记录。沿用 `releaseManifest.components` 的资源/产物路径/仓库/摘要配置，增加 `requiredCommits`。用本地仓库 `git merge-base --is-ancestor` 验证指定修复包含在部署提交内，允许部署为目标源码的已知祖先；缺 Git 对象不能假定包含。按 `caseReleases` 只阻塞依赖该修复的用例。开发人员负责提供修复 SHA，发布负责人负责提供环境实际产物及可信发布对应关系。

## 报告和原话题回传

最终生成大白话正文、原 15 页 XLSX 和 `.evidence.json.gz`。证据包解压后为 JSON：manifest 含结果、版本、样本、源码/部署及完整报告索引；files 按文件名、SHA-256 和 base64 保存已引用证据。结果可追到 case_id、执行版本、样本单号/事件号及 EV 编号。原始输入附件保存于任务来源目录，证据包携带其来源和摘要；没有检查过的附件不自动对外打包。

`ReportDelivery` 的 `requirementDeliveries` 保存每一部分的发送意图、幂等键、消息 ID、读回和消息链接。CLI 强制 `--as bot`、`--reply-in-thread`，目的应用/群/根消息来自原任务绑定；thread_id 只用于话题身份。发送后按同一应用读消息、核对完整正文，再下载两份附件核对字节与原文件。全部核对才 `verified=true`。只拿到 message_id 不算送达完成。

失败重试保留已发送消息，已核验部分不再发送；读回不一致须处理原消息或权限问题，不能重发整套掩盖问题。应用启动和交付重试沿用原队列，已取消或已被新执行版本替代的交付不继续发送。完成后返回 receipt.messages 的消息链接和读回凭证，并保存到 Job 的 requirementDeliveryReceipt；队列每个 part.link 同样可查。本轮四种投递验收使用替身，真实平台幂等期限及消息/文件权限仍需专门联调。

## TPM 15.1 的下一次执行

将 [样例材料](../config/tpm-15.1-chain.example.json) 放入项目需求/用例材料，填写真实入口和确认依据后形成正式用例；样例不能直接运行或授权。A 的真实驳回与重复通知分两条，平台无自动重试不构成缺陷；无正式同事件重发证据，重复通知验证不得通过。B 从相同初态分别测 50/50 和 50/51，确认财年口径替换季度断言。C 共用原单逐节点记流水，保留已付 200；不到首次结案日期就留样等待，不重建替代原单。

开始前由部署者安装本版本并核对健康和完整 SHA；测试负责人授权本轮任务、账号及数据；产品确认财年口径；OA 负责人提供审批人及可用的正式重发入口；发布负责人提供部署产物；宿主维护者完成真实侧边栏交接；飞书管理员在获准测试群完成应用读回及附件验证。以上缺口不能由 Mock 填成真实 UAT 通过。本轮未改动运行专员、未恢复取消任务、未操作真实业务。
