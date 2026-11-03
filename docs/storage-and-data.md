# AgentOS 文件、数据与日志位置

1.52.0长任务与查询规则见[完整查询与大结果接续](long-query-continuity.md)：原范围自动复核续期、无整批查询截止、历史数据不按24小时失效、大结果保存续读；不改变只读权限及完整文件核验。

1.51.0数据集信封新增createdAt，仅表示工件创建，原readAt不变；旧工件缺少时不补造。calendar-v3统计配方与civil_day/month筛选随原任务datasets完整备份，旧程序不能重放新配方。目录及预览展示改进、回退兼容边界见[报表效率与接续](report-efficiency.md)。

本页回答“AgentOS 生成的东西都在哪里”。默认程序目录以下用 `<agentos>` 表示；默认运行数据根目录是 `<agentos>/data`，可用 `AGENTOS_DATA_DIR` 改到其他绝对路径。

快速查看本机实际路径和占用大小：

```powershell
.\scripts\show-storage.ps1
```

该脚本只显示路径、是否存在和大小，不读取或输出消息、凭据、日志正文。

## 项目目录内

| 位置 | 内容 | 是否敏感 | 是否进入 Git |
|---|---|---:|---:|
| `src/` | Control Plane、Runner、Codex 连接和持久化源码 | 否 | 是 |
| `config/*.example.json`、`config/roles/` | 可复制示例、角色规则和协议 schema | 脱敏后否 | 是 |
| `config/*.local.json` | 真实项目路径、群 ID、机器人/真人 ID、网络出口 | 是 | 否 |
| `.env` | 可选环境变量和令牌 | 严重敏感 | 否 |
| `docs/`、`scripts/`、`test/` | 设计、部署、维护、辅助脚本和回归测试 | 否 | 是 |
| `data/codex-conversations.json` | 可选群会话的持久线程引用、待定请求与最近决策；依赖本机 Codex 会话文件，0600，不是登录文件 | 是 | 否 |
| `data/knowledge/knowledge.sqlite` | 显式团队范围内的通用知识、版本、依赖指纹、索引与命中计数；不包含原始聊天。见[团队知识](team-knowledge.md) | 是 | 否 |
| `data/memory.json` | 按范围的持久摘录摘要、来源指纹及停用记录；详见[记忆管理](memory-management.md) | 是 | 否 |
| `data/agentos.json` | Job、Mission、对话、AI 决策、状态、结果、发送、幂等记录及最近 200 项本机设置审计 | 是 | 否 |
| `data/exports/<JOB>/` | 完整分组报表 CSV，含实时业务金额；通过文件校验后回复原提问。见[报表导出](report-exports.md) | 是 | 否 |
| `data/exports/<JOB>/report-*.verification.json` | 最终文件的列/覆盖/分量核验及业务依据，与CSV绑定；不等于人工业务验收 | 是 | 否 |
| `data/exports/<JOB>/datasets/` | 本任务完整数据集检查点，含范围指纹、取数时间和摘要；普通查询长字段可保存为明确标记不完整的证据，不参与完整报表；不进入团队知识。不按固定24小时失效；按当前授权复用并保留原始取数时间；启用历史保留策略后随过期任务清理 | 是 | 否 |
| `data/lark-cli/reports/` | CLI 文件回复副本，需与正式导出文件分别清理 | 是 | 否 |
| `data/website-evidence/<JOB>/` | 用户要求的当前网页视口截图，等待接口/渲染稳定，仅凭据及显式敏感区灰色遮挡，未就绪时标记现场证据；摘要校验后通过原话题投递，待发送保存在websiteEvidenceDeliveries，随问题保留策略清理 | 是 | 否 |
| `data/attachments/<JOB>/` | HTTPS/OpenAPI 接入下载的任务附件 | 是 | 否 |
| `data/lark-cli/` | lark-cli 消息资源下载工作目录 | 是 | 否 |
| `data/lark-cli-events/<profile>/messages/<messageId>/` | 长连接消息中的图片、文件、音频和媒体 | 是 | 否 |
| `data/lark-cli-events/<profile>/pending-card-actions/` | 尚未成功送达 Control Plane 的卡片回调重放文件 | 是 | 否 |
| `data/lark-cli-config/<profile>/config.json` | 为避免多个机器人争用而复制的 lark-cli profile 配置 | 严重敏感 | 否 |
| `data/worktrees/<JOB-stage>/` | 实施任务的隔离 Git worktree 与未提交业务改动 | 严重敏感 | 否 |
| `data/worktrees/analysis-resources/` | 只读分析任务下载的附件资源 | 是 | 否 |
| `data/logs/agentos.stdout.log`、`agentos.stderr.log` | Windows 登录后启动的标准输出和错误日志 | 是 | 否 |
| `data/card-updates.paused` | 暂停更新的飞书卡片 message_id 列表 | 是 | 否 |
| `data/smoke/`、`data/card-previews/` | 本地烟测和卡片预览输出 | 可能敏感 | 否 |

`data/agentos.json` 是默认唯一业务状态真源。它不是数据库，但包含真实消息和任务上下文；重启会继续读取它。对话会保存 `chatType`，任务会保存 `originProfile`、`originChatType`、原 `senderId` 和不可变的 `originMessageId`；卡片 outbox 还会保存终态提醒及 `mentionDelivered`，以便断网后只补发一次 `@`。不要上传到 GitHub、飞书文档或问题单。

状态文件使用紧凑 JSON 和有界问题上下文。每个在途 Job 最多携带 8 项去重证据；已经交接的历史 Job 保留自身结果与事件，不再重复保存整条上下文。主卡只装载最近 6 项有效结果，避免长任务把卡片和每次状态事务拖慢。升级迁移只删除重复的上下文副本，不删除 Job 结果、事件或本机审计历史；迁移前仍应按下文要求停机备份。

## 项目目录外

| 位置 | 内容 | 注意事项 |
|---|---|---|
| 系统临时目录 `agentos-chat-<数据目录哈希>/` | 常驻只读聊天线程的工作目录 | 重启会重建线程；不要当长期状态或业务源码 |
| 当前用户 `~/.codex/` 或系统凭据库 | Codex 配置和登录缓存 | `auth.json` 等同密码，绝不提交或复制给陌生人 |
| macOS Keychain `com.angel.agentos.environment.<网站引用>` | 网站负责人回复等待登录卡片时提交的账号密码 | AgentOS 状态、卡片和日志只保存非敏感凭据引用；原始群消息仍按企业飞书留存策略保存 |
| 当前用户 `~/.lark-cli/` | lark-cli 原始 profile 与认证 | 运行时会复制到 `data/lark-cli-config/`，两处都敏感 |
| `HKCU\Software\Microsoft\Windows\CurrentVersion\Run\AngelAgentOS` | Windows 当前用户登录后启动项 | 不是系统服务，也不是 Codex 登录 |
| 业务仓库 `.git/worktrees/` 元数据 | 关联 `data/worktrees/` 中的工作树 | 清理工作树必须回到对应业务仓执行 Git worktree 命令 |

## 保存、备份与清理

- 停止 AgentOS 后，至少备份 `data/agentos.json`、已有 `data/memory.json`、local 配置和仍需保留的 `data/worktrees/`。备份包含敏感信息，应加密并限制访问。
- 不要在运行中手工编辑 `agentos.json`；写入采用临时文件加原子重命名，外部同时改写会破坏状态。
- 不要直接删除有未提交修改的 `data/worktrees/`。先在对应业务仓执行 `git status`，确认归属和保留方式，再使用 `git worktree remove <路径>`；必要时另行备份。
- `pending-card-actions/` 未清空表示仍有卡片动作等待送达；不能把删除文件当成“处理成功”。
- 系统临时聊天目录可在 AgentOS 完全停止后清理，但长期对话仍在 `agentos.json`；清理临时目录不会删除任务历史。
- 日志可能包含群、任务和路径信息。排障只截取必要、已脱敏片段。

## 什么能上传 GitHub

只上传源码、脱敏示例、设计文档、脚本和测试。发布前确认：

```powershell
git status --short
git check-ignore .env config\projects.local.json config\agents.local.json config\codex-runtime.local.json data\agentos.json
```

这些私有路径都应显示为 ignored。完整发布检查见根目录 `SECURITY.md`。

开启问题卡片后，`agentos.json` 新增 `questions` 元数据，新对话与新 Job 带 `questionId`；旧记录不回填。备份应包括已有 `codex-conversations.json` 与 `config/conversation.local.json`，详见[实现与恢复](group-question-cards.md)。

## 可选环境查询边界

详见[受控环境查询](environment-access.md)和[只读排查自动授权](read-only-auto-authorization.md)。环境配置仅存在 ignored 的 `config/environments.local.json`，凭据保存在当前 Mac 用户 Keychain。UAT/PRD 受控只读查询由策略自动授权，修改操作仍需管理员审批。查询原始结果归属原问题卡片，不注入个人共享记忆；显式启用团队知识后，仅对完成且有证据的分析提炼不含具体案例数据的通用说明，独立保存。真实环境验收须在本机配置后完成。

通用网站等待登录时，只有该网站环境在当前机器人 profile 下配置的负责人可以直接回复对应任务卡提交账号密码。控制面用卡片或同一话题绑定具体网站，在普通对话入库之前消费凭据消息，不把正文写入 `data/agentos.json`；Keychain 保存后仅使用凭据引用。AgentOS 无法删除飞书服务端群消息，群成员可见范围和留存按企业飞书策略执行。固定登录脚本只在已批准网站 origin、应用路径或同源认证路径填写表单，验证码和 MFA 不保存也不绕过。详见[日常 Chrome 登录态复用](shared-chrome.md)。

## 环境源码快照

可选 `analysisSourceMode=isolated`：以配置的项目根目录为来源，根据问题选择 `analysisEnvironments`，在 `analysisSnapshotRoot` 下按项目、环境、仓库来源及实际提交复用不可变快照。保留个人功能分支与未提交修改；环境未指定且无默认值时先询问，禁止回退 PRD。上文原目录快进同步规则仅适用于未启用此选项的兼容模式。同一卡内的源码与工具步骤复用同一分支/提交证据，仍不能证明实际部署版本。配置、清理与验收见 [源码同步说明](source-sync.spec.md)。

## 按问题发现业务网站

支持从问题与环境源码查找入口，打开本机浏览器并复用会话；等待登录时保留任务、明确显示网站，可由负责人本机登录或回复任务卡提交 Keychain 凭据，登录后自动恢复。配置、权限、存储与兼容边界见[通用网页排查](query-driven-websites.md)。

## 联系人信息图

`data/contact-index/directory.sqlite`保存受范围/权限指纹限制的最小目录候选，不含手机号或邮箱；与团队知识SQLite分开。`data/contact-images/`保存个人资料PNG和校验回执，`data/lark-cli/images/`为CLI上传副本；对话outcome登记原提问范围与投递状态。文件含人员资料，使用本机受限权限，不进入Git或团队知识；停稳后备份；启用历史保留策略后清理过期本地图片与索引。配置和验收见[联系人信息图](contact-images.md)。

私有卡片的visibility、固定收件者、privateDeliveryKind及旧临时卡片清理队列随问题/任务和cardMessages存入原状态JSON；共享知识不自动接收私有调查。私有附件仍保存在原本地目录，私聊投递不代表本地管理员隔离。

## 本机控制请求回执

`data/agentos.json.controlReceipts`和`data/control-receipts/<请求编号>.json`共同保存关键状态提交的恢复依据；正文可能含任务证据，须私有保存、停机成套备份，不单独清空。详见[本机状态请求恢复](control-recovery.md)。

报表可选组合行键由完整分组字段（含null区别）计算，属于任务数据集，不进入共享知识。`jobs[].investigationProgress.toolCorrections`保存定向修复类别的去重摘要，随状态备份；不手工清空以规避无进展保护。部署无需新权限、依赖或数据库迁移。见[报表粒度与修复接续](report-grain-recovery.md)。

data/local-executions保存本机实际fork的父/工作进程和租约身份，随状态/回执/exports成套备份；不入Git或共享知识。进程存在、外机、旧无登记、Windows或无法证明整个进程组已退出时，不自动解除执行隔离。见[空值与本机异常退出恢复](local-executor-recovery.md)。

报表分卷临时副本位于`exports/<JOB>/.delivery-*`，正常完成/异常退出投递函数时清理；进程崩溃可能保留，确认无投递后可清理，不删除主报表或核验记录。`reportDeliveries.parts`保存每卷名称、字节、SHA-256与消息回执，不保存正文。详见[报表导出](report-exports.md)。

## 可选历史保留策略

独立多系统启动器默认保留30天；通用服务需设置 `AGENTOS_RETENTION_DAYS` 显式启用。启动及每日清理已结束且无在途交付依赖的过期问题、任务、索引、缓存和允许目录内的文件。活动/等待问题、配置凭据、源码和开发worktree不因达到30天被删除。并非整盘清理，飞书服务器与系统级Codex记录不受影响。完整目录、配置、失败与验收边界见[多系统说明：本地历史保留与自动释放](system-assistants.md#本地历史保留与自动释放)。

源码缓存独立于30天问答历史保留：每个环境保留最近选用版本，活动及等待任务的依赖另行保留；结束任务不再永久占用完整源码副本，仍保留报告与提交证据。详见 [快照缓存与清理](source-sync.spec.md#不可变快照缓存与清理)。


首次构建隔离源码缓存时，先从origin/HEAD与清单一致的同仓同分支缓存或已配置来源仓独立复制Git对象与浅仓边界，再从真实origin拉取指定环境提交，减少重复下载；最终缓存不依赖来源仓objects。发布前清除临时仓中的其它refs/reflogs和不可达对象，不导入个人未推送分支或工作区改动。构建/复用拒绝外部对象依赖文件；来源仓不执行任何清理。该优化不改变环境分支选择、远端版本核验或清理保护，见[源码同步说明](source-sync.spec.md)。

1.49.0新增固定提交历史状态、analysisContinuation与轻量`.snapshot-audit`；迁移备份时同状态、source-manifest及datasets成套保留。长字段证据、calendar-v2版本配方与查询完整性标记保存在任务datasets内。详见[通用能力与迁移验证](multi-system-capability-audit.md)。

1.49.2中断结果的executionFailure保存固定诊断分类、环节及安全错误码/HTTP状态/退出信息，随任务状态备份；不保存新的原始错误正文或凭据副本。旧卡缺少原始错误时不能反推根因。见[中断卡片诊断](multi-system-capability-audit.md#中断卡片的诊断信息)。

1.49.3：完整数据集的树/筛选派生规则由 `dataset_transform/tree-filter-v1` 保存，复用原始来源引用、取数时点和作用域；恢复及定稿从来源重算，集中刷新重建依赖。迁移须保留整个任务 datasets 目录及配方依赖，不只复制输出CSV。卡片拒绝回调仅入私有审计和回调返回，不在群话题广播；审计新增操作人和白名单动作，旧事件的缺失字段不回填猜测值。

1.49.4：`lark-cli-events/<profile>/edited-mentions-status.json` 内含按群、profile和可信机器人身份绑定的v2检查点，仅保存消息ID、摘要和观察时间，不保存正文。完整私有迁移须保留这些检查点及主状态中的消息去重索引；缺少检查点的新实例只建基线，不盲目重放旧编辑。首次启用、平台权限待审核、正常扫描和读取失败须分别核验。

1.54.0显式业务口径另存knowledge/definitions.sqlite，不受个人历史或源码知识TTL清理。按knowledge.local.json范围读取，保存来源、版本及幂等回执。停稳备份与完整私有迁移须包含整个knowledge目录，代码归档不得携带其中私有内容。

`data/source-methods/`是可重建的同版本源码定位索引，仅保存路径/摘要/大小/行号及哈希主题特征，不含历史答案、业务行、金额、查询参数或凭据。版本、环境、助手、群和已确认口径隔离，当前源码再次校验后才读取。`window_counts`配方保存在原任务数据集，恢复/刷新需要全部原始来源；迁移继续保留完整data，不仅复制最终CSV。索引失效回到普通调查，数据集损坏仍是实际核验缺口。

双环境调查任务还保留`analysisSourceSnapshots`、`sourceEnvironmentEvidence`、`sourceEnvironmentThreads`/`analysisContinuations`；单值快照仍为活动环境投影。迁移保留完整任务和所引用快照；缓存回收已有递归引用检查会保护活任务的两套工作区，禁止只备份当前单值快照。旧版不能接管未完成的双环境任务。


模型容量暂时不可用的只读任务现使用持久等待与原步骤自动恢复，状态/范围/取消/检查点及迁移边界见 [模型容量恢复](model-capacity-recovery.md)。不是整任务重放，不新增整任务截止；实施与业务写入不套用。
