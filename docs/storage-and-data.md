# AgentOS 文件、数据与日志位置

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
| `data/exports/<JOB>/datasets/` | 本任务完整数据集检查点，含范围指纹、取数时间和摘要；不完整集不保存，不进入团队知识。24小时后不再复用；过保留期且无引用时自动清理 | 是 | 否 |
| `data/lark-cli/reports/` | CLI 文件回复副本，需与正式导出文件分别清理 | 是 | 否 |
| `data/attachments/<JOB>/` | OpenAPI任务附件、Runner流式文件副本及纯文件分析空工作区 | 是 | 否 |
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

状态文件使用紧凑 JSON 和有界问题上下文。每个在途 Job 最多携带 8 项去重证据；已经交接的历史 Job 保留自身结果与事件，不再重复保存整条上下文。主卡只装载最近 6 项有效结果，避免长任务把卡片和每次状态事务拖慢。升级迁移只删除重复的上下文副本，不删除 Job 结果、事件或本机审计历史；迁移前仍应按下文要求停机备份。另有独立的滚动30天保留策略，会删除过期终态问题、任务及无引用文件，详见[自动清理](retention.md)。

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

可选 `analysisSourceMode=isolated`：以配置的项目根目录为来源，根据问题选择 `analysisEnvironments`，在 `analysisSnapshotRoot` 下按项目、环境、仓库来源与实际提交复用不可变源码缓存；新问题先核对远端分支，同题固定原提交。保留个人功能分支与未提交修改；环境未指定且无默认值时先询问，禁止回退 PRD。上文原目录快进同步规则仅适用于未启用此选项的兼容模式。同一卡内的源码与工具步骤复用同一分支/提交证据，仍不能证明实际部署版本。配置、清理与验收见 [源码同步说明](source-sync.spec.md)。

## 按问题发现业务网站

支持从问题与环境源码查找入口，打开本机浏览器并复用会话；等待登录时保留任务、明确显示网站，可由负责人本机登录或回复任务卡提交 Keychain 凭据，登录后自动恢复。配置、权限、存储与兼容边界见[通用网页排查](query-driven-websites.md)。

## 联系人信息图

`data/contact-index/directory.sqlite`保存受范围/权限指纹限制的最小目录候选，不含手机号或邮箱；与团队知识SQLite分开。`data/contact-images/`保存个人资料PNG和校验回执，`data/lark-cli/images/`为CLI上传副本；对话outcome登记原提问范围与投递状态。文件含人员资料，使用本机受限权限，不进入Git或团队知识；停稳后备份，适用滚动30天本机保留策略。配置和验收见[联系人信息图](contact-images.md)。

私有卡片的visibility、固定收件者、privateDeliveryKind及旧临时卡片清理队列随问题/任务和cardMessages存入原状态JSON；共享知识不自动接收私有调查。私有附件仍保存在原本地目录，私聊投递不代表本地管理员隔离。

## 本机控制请求回执

`data/agentos.json.controlReceipts`和`data/control-receipts/<请求编号>.json`共同保存关键状态提交的恢复依据；正文可能含任务证据，须私有保存、停机成套备份，不单独清空。详见[本机状态请求恢复](control-recovery.md)。

报表可选组合行键由完整分组字段（含null区别）计算，属于任务数据集，不进入共享知识。`jobs[].investigationProgress.toolCorrections`保存定向修复类别的去重摘要，随状态备份；不手工清空以规避无进展保护。部署无需新权限、依赖或数据库迁移。见[报表粒度与修复接续](report-grain-recovery.md)。

data/local-executions保存本机实际fork的父/工作进程和租约身份，随状态/回执/exports成套备份；不入Git或共享知识。1.51.0的Windows v2登记另含创建时点和内核Job身份；须证明原整树退出才记录中断，仍不自动重放业务。外机、旧无证明或探测不明时保持隔离。记忆/会话文件、知识库和浏览器状态在Windows使用私有DACL，POSIX保留0600/0700。见[Windows边界](windows-reliability.md)及[空值与本机恢复](local-executor-recovery.md)。

报表分卷临时副本位于`exports/<JOB>/.delivery-*`，正常完成/异常退出投递函数时清理；进程崩溃可能保留，确认无投递后可清理，不删除主报表或核验记录。`reportDeliveries.parts`保存每卷名称、字节、SHA-256与消息回执，不保存正文。详见[报表导出](report-exports.md)。

文件输入按消息资源列表接收并保留原名/格式/大小/SHA-256；Runner副本与file-only工作区位于attachments/JOB目录，沿现有30天策略保护活动引用。纯文件分析不自动进入团队知识，详见[file-input.md](file-input.md)。

话题云文件及pending-export/receipt回执存于lark-cli-events/<profile>/messages/<消息>/cloud-files/，含来源URL、请求归属、摘要、导出标记和完成时间，不含访问令牌；沿既有30天消息资源规则清理，活动引用受保护。新提问重新核实，不以旧副本绕过权限。

源码缓存见[source-sync.spec.md](source-sync.spec.md)：analysis-sources按项目/环境/来源/提交共享，不再每问完整复制；闲置版本单独按小时回收，活动与等待引用受保护，最近选用版本保留。.snapshot-audit只留提交清单和删除审计，不能作为完整源码备份；原提交不可获取时不能承诺自动恢复。该策略独立于30天问答历史，禁止整盘或按目录年龄清理。


## 可选工作台独立数据

工作台默认使用它自己的 `data/workbench/`，不要指向原实例data。`workbench.json`包含私有话题、参与人、消息入站、通知outbox和访问审计，`files/`保存话题上传，`engine/`保存复用核心的独立状态、配置副本、源码缓存、文件与执行登记。配置示例与恢复流程见 [工作台说明](../workbench/README.md)。正常退出释放单实例锁；崩溃后确认PID和执行进程组再恢复，不能盲删锁。终态历史按既有30天策略清理，执行中/等待/未投递保护；不扫描未知目录。原实例数据不被移动、迁移或清理。

报表完整数据集保存原始取数时间、环境配置指纹及不可变摘要；由现有任务历史保留规则管理，不再另设24小时拒读。关联追问仅通过后端核实的同提问者、同profile/群/项目/环境及明确父问题链导入完整来源与依赖；导入不会重置时间或跨环境分享。源任务被原保留机制清理、文件缺失/校验变化时明确要求重新取数，不无限等待或静默换结果。JSON数组拆行、关联、合并、筛选保存可重放派生图，定稿/文件审阅复验来源；详细工具见docs/report-exports.md。

同一Job的调查规划与成功证据保存在`exports/<JOB>/.investigation-session/`，绑定提问者/profile/群/项目/源码环境和当前环境配置指纹，原取证时间不刷新，原30天历史及在途/待交付保护适用。损坏、摘要不符或路径/符号链接越界明确拒绝，不静默回退冒充结果。文件锁随工作进程退出释放；跨工作进程接续native规划thread，数据库连接仍按单进程只读事务关闭。配置/凭据不写入该会话文件。
