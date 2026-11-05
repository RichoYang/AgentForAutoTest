# 从 GitHub 到飞书 Agent 团队：小白完整教程

本教程以 **Windows 单机 + lark-cli 长连接 + ChatGPT 登录的 Codex** 为已验证路径。完成后，你会在一个飞书群里拥有项目负责人、PM、开发、测试和审计五个机器人，它们共用一台受信任开发机上的 AgentOS 与 Codex。

> 这不是云托管机器人。运行 AgentOS 的 Windows 用户需要已登录、电脑不休眠、能访问飞书与 Codex；代码仓库也必须在这台机器上。

## 0. 准备清单

- Git。
- Node.js 22.x；项目 `package.json` 要求 `>=22 <23`。
- Codex CLI 或包含可用 CLI 的 Codex 桌面版。
- lark-cli。
- 能创建企业自建应用的飞书权限。
- 一个测试群和至少一个本地 Git 项目；先不要直接接生产仓。

## 1. 克隆成品仓库

```powershell
Set-Location D:\projects
git clone https://github.com/RichoYang/AgentForAutoTest.git
Set-Location .\AgentForAutoTest
git switch main
git pull --ff-only
git rev-parse HEAD
git status
```

默认部署当前维护的 `main`，并保存 `git rev-parse HEAD` 输出，便于验收和回滚。只有团队明确选定且仓库中真实存在的稳定发布标签时，才执行 `git checkout <tag>`；不要照抄历史教程中的 `v1.0.0`，它是首个公开版本，不包含当前能力。

先执行 `npm ci` 安装锁定的 npm 运行依赖（包含可选环境查询使用的 mysql2）。Node、Codex、Git 和 lark-cli 是本机工具。再执行：

```powershell
.\scripts\doctor.ps1
```

诊断脚本只显示版本、路径和缺失项，不打印 App Secret、消息或日志正文。

## 2. 安装并登录 Codex

确认 CLI：

```powershell
codex --version
codex login
codex login status
```

第一次运行 `codex` 也可以选择“Sign in with ChatGPT”。这份 AgentOS 已验证使用 ChatGPT 订阅登录，不需要把 API Key 写进项目。Codex 登录缓存位于当前用户的 Codex 配置目录或系统凭据库，绝对不要提交。

若浏览器回调受限，可根据 OpenAI 官方认证说明使用设备码登录。AgentOS 的 Windows 登录后自启和 Codex 账号登录是两回事：前者决定程序何时启动，后者决定 Codex 能否调用模型。

## 3. 创建五个飞书机器人应用

在飞书开放平台分别创建五个企业自建应用，建议名称：

1. 项目负责人 Agent
2. PM Agent
3. 开发 Agent
4. 测试 Agent
5. 审计 Agent

每个应用都要单独完成：

1. 开启“机器人”能力，设置易区分的名称和头像。
2. 将你和测试群成员加入应用可用范围。
3. 按实际能力申请消息读取、以应用身份发送消息、读取消息资源等权限；不要开启无关通讯录或全量消息权限。
4. “事件与回调 → 事件配置”选择长连接，订阅 `im.message.receive_v1`。
5. “事件与回调 → 回调配置”选择长连接，添加 `card.action.trigger`。它和消息事件不是同一个配置页。
6. 创建版本并发布。负责人应用发布成功不能代替其他四个应用。

## 4. 为每个应用建立 lark-cli profile

下面的 profile 名称与示例配置一致：

```powershell
lark-cli config init --new --name agentos-owner
lark-cli config init --new --name agentos-pm
lark-cli config init --new --name agentos-developer
lark-cli config init --new --name agentos-qa
lark-cli config init --new --name agentos-auditor
```

按浏览器流程选择或配置对应应用。已有应用时先运行 `lark-cli config init --help`，使用当前版本支持的“绑定已有应用”方式；App Secret 使用安全输入，不要写进命令历史、JSON 示例或聊天。

## 5. 生成本地配置副本

```powershell
.\scripts\initialize-local.ps1
```

脚本只在目标文件不存在时复制，不覆盖已有配置：

- `config/agents.local.json`：机器人角色、profile 与机器人 open_id。
- `config/projects.local.json`：真人管理员身份、群与项目、仓库路径和验证命令。
- `config/codex-runtime.local.json`：Codex 路径与直连/代理。

这三个文件均被 Git 忽略。

## 6. 获取群、机器人和真人 ID

首次取 ID 时先确保 AgentOS 没有运行，避免两个消费者争用同一个 profile。以负责人为例：

```powershell
lark-cli --profile agentos-owner event consume im.message.receive_v1 --as bot
```

然后由真人管理员在目标群 `@项目负责人 Agent` 发送“配置身份核对”。从这条事件中记录：

- `chat_id`：目标群 ID，通常以 `oc_` 开头。
- `sender_id`：该 profile 视角下的真人 ID。
- `mentions` 中对应机器人的 `open_id`。

按 Ctrl+C 停止临时监听，对其他四个 profile 重复。**同一个真人在不同应用下的 open_id 可能不同，不能复制同一个值到全部 profile。**

## 7. 编辑机器人配置

打开 `config/agents.local.json`，将每个占位符替换为对应机器人的 open_id；profile 保持和第 4 步一致。新部署可以删除 `legacy` 项。

```json
{
  "agents": {
    "owner_intake": { "displayName": "项目负责人 Agent", "profile": "agentos-owner", "openId": "ou_OWNER_BOT" },
    "pm": { "displayName": "PM Agent", "profile": "agentos-pm", "openId": "ou_PM_BOT" },
    "developer": { "displayName": "开发 Agent", "profile": "agentos-developer", "openId": "ou_DEV_BOT" },
    "qa": { "displayName": "测试 Agent", "profile": "agentos-qa", "openId": "ou_QA_BOT" },
    "owner_audit": { "displayName": "审计 Agent", "profile": "agentos-auditor", "openId": "ou_AUDIT_BOT" }
  }
}
```

`owner_report` 会复用 `owner_intake` 的负责人机器人，不需要第六个应用。

## 8. 编辑项目、群和真人权限

打开 `config/projects.local.json`：

```json
{
  "ownerOpenIds": [],
  "ownerOpenIdsByProfile": {
    "agentos-owner": ["ou_HUMAN_IN_OWNER_APP"]
  },
  "humanIdentities": {
    "leader": {
      "agentos-owner": "ou_HUMAN_IN_OWNER_APP",
      "agentos-pm": "ou_HUMAN_IN_PM_APP",
      "agentos-developer": "ou_HUMAN_IN_DEVELOPER_APP",
      "agentos-qa": "ou_HUMAN_IN_QA_APP",
      "agentos-auditor": "ou_HUMAN_IN_AUDITOR_APP"
    }
  },
  "chatProjectMap": {
    "oc_YOUR_GROUP": "demo"
  },
  "projects": {
    "demo": {
      "displayName": "你的演示项目",
      "repoPath": "D:\\projects\\your-project",
      "baseBranch": "main",
      "verifyCommands": ["npm test"]
    }
  }
}
```

- `repoPath` 必须是这台机器上的真实路径。
- `baseBranch` 必须在项目仓库本地存在。
- `verifyCommands` 由项目负责人审阅后填写；Java、前端和其他工程不能照抄 `npm test`。
- 普通成员可以聊天、询问并发起显式只读 `analysis` 源码排查；不能创建或继续实施、规划、测试、审计、部署等可执行任务。管理员按对应 profile 的真人 ID 校验。
- `humanIdentities` 最外层键只是本机稳定代号，例如 `leader`、`alice`，不要求等于飞书姓名；同一组内必须是同一个真人在五个机器人应用视角下分别收到的 `open_id`，禁止把一个值复制五次。
- 每位需要跨 Agent 补充、刷新或取消自己任务的成员，都要在五个临时事件监听器中各 `@` 一次对应机器人，再将五个 `sender_id` 写入同一组。只在一个 Agent 下对话的普通成员无需提前登记。
- `humanIdentities` 只延续任务发起人身份，不会让普通成员变成管理员，也不会授予代码修改权限；可执行任务和审批仍只看 `ownerOpenIdsByProfile`（兼容 `ownerOpenIds`）。

权限矩阵：

| 操作 | 普通成员 | 真人管理员 |
| --- | --- | --- |
| 普通对话、解释、建议 | 可以 | 可以 |
| 显式只读源码排查（`analysis`） | 可以 | 可以 |
| 创建实施、规划、测试、审计、部署任务 | 不可以 | 可以 |
| 补充并继续只读排查 | 任务发起人可以；跨机器人需完整 `humanIdentities` | 可以 |
| 补充并继续非只读任务 | 不可以 | 可以 |
| 刷新、翻页、取消自己的任务 | 可以 | 可以 |
| 阶段审批、项目绑定 | 不可以 | 可以 |

这不是只靠提示词约束：AI 做出动作判断后，控制面仍会在 Job 落库和任务续接之前校验管理员身份。普通成员即使明确要求“直接改代码”，系统也只会拒绝并说明权限，不会创建后台任务。`/api/v1/dev/messages` 是持有本机管理令牌的运维入口，不应开放给群成员。

群聊里的普通问答完成后，机器人会另回一条原生飞书 `@` 给本次提问人。任务最终完成、受阻、失败或取消后，由最初接单的机器人回复原始消息并 `@` 原任务发起人；中间阶段的“待确认/待补充”不会误报为任务结束。该提醒不要求 `humanIdentities`，但跨 Agent 操作仍要求完整映射。

## 9. 配置 Codex 路径和网络

`config/codex-runtime.local.json`：

```json
{
  "proxyUrl": "",
  "codexBin": "codex",
  "model": "gpt-5.6-sol",
  "reasoningEffort": "high"
}
```

`model` 和 `reasoningEffort` 也可以在 AgentOS 启动后的本机管理控制台修改。留空或删除字段时继承本机 Codex 默认设置；可选模型最终仍受当前 ChatGPT 账号权限约束。

- `proxyUrl` 留空：Codex 子进程直连，并清除继承的代理变量。
- 确有代理时填写本机实际可用的 URL；不要复制别人的端口。
- Windows 使用 `codex` 时会自动寻找 Codex 桌面版更新后的最新 `codex.exe`；macOS 会自动识别 ChatGPT 应用当前嵌套的 `CodexCLI.app` 可执行文件。桌面应用升级并移动内置 CLI 后，无需重新安装 AgentOS 自启项。

## 10. 回归并启动

先跑完整检查：

```powershell
.\scripts\use-node22.ps1 npm run check
```

再启动一体化本地服务：

```powershell
.\scripts\use-node22.ps1 npm run start:local
```

看到 Control Plane、Runner 和每个 profile 的消息/卡片消费者 ready 后，在另一个窗口检查：

```powershell
Invoke-RestMethod http://127.0.0.1:8787/health
```

默认只监听 `127.0.0.1:8787`。不要为了飞书长连接把 8787 暴露到公网。

启动完成后，在同一台电脑打开 `http://127.0.0.1:8787/admin`。页面用于管理和查看已经运行的 AgentOS，不用于启动服务。可以在其中查看服务与 Runner 状态、任务及普通回复记录、模型、耗时、工具调用、失败原因，并修改后续任务使用的模型和推理强度。正在执行的任务保持原设置。参见 [本机管理控制台](admin-console.md)。

`start:local` 默认启动 3 个 Runner 执行槽，因此三张不同问题卡可以真正同时排查。Mac mini 先使用默认值；根据内存、CPU 和 Codex 账号承载情况，可在 `.env` 设置 `AGENTOS_RUNNER_CONCURRENCY=1..8` 后重启。`/health` 的 `runnerConcurrency` 和管理页面的 Runner 池状态必须与配置一致。它只改变并发槽数，不改变模型、账号、项目权限或网页登录态。

本机Codex启动、登录检查、会话建立、模型回答和环境调查不再设置隐式等待时限或固定调用次数。慢响应继续等待，任务卡显示当前准备/规划步骤；用户停止、进程退出、连接断开和真实工具错误仍会结束当前操作。旧 `AGENTOS_ENV_INVESTIGATION_MAX_CALLS`、`AGENTOS_ENV_INVESTIGATION_MAX_MS`、`AGENTOS_ANALYSIS_TOTAL_TIMEOUT_MS`、`AGENTOS_ANALYSIS_MAX_ENV_ROUNDS`、`AGENTOS_ANALYSIS_TURN_TIMEOUT_MS`、`AGENTOS_ANALYSIS_RESUME_TIMEOUT_MS` 均不再生效，可以删除。升级后在任务空闲时重启，无需新增配置。单次数据库/网络请求与授权有效期保持原配置；它们的失败不能当作业务根因。

同一环境模板不再按固定轮数截断；只有相同核心目标在证据没有变化时重复申请，程序才自动暂停并改走其他已登记证据路径。旧部署若仍保留 `AGENTOS_ENV_TARGET_MAX_ROUNDS` 可直接删除，该变量已不再生效。重复批次应使用 `group_count`，源码已有汇总口径时应在一轮内使用 `aggregate` 或 `collect_values` + `linked_aggregate`。

## 11. 拉机器人进群并发送第一条消息

把五个机器人都加入第 8 步配置的群。先验证负责人：

```text
@项目负责人 Agent 你好，请只介绍你自己和当前项目，不创建任务
```

再发一个清晰、低风险的只读请求：

```text
@项目负责人 Agent 帮我查看登录接口在哪里，只分析，不修改代码
```

最后在可丢弃测试仓验证完整流程：

```text
@项目负责人 Agent 在演示项目新增一个 README 小节；先说明目标、范围和验收
```

预期依次经历负责人 → PM → 开发 → 测试 → 审计 → 负责人汇报，并在需要时等待真人补充或确认。AgentOS 不会自动合并、推送或部署业务代码。

## 12. 安装登录后自启

AgentOS 必须运行在保存了飞书、Codex、Keychain和浏览器会话的同一个桌面用户下。先手工启动成功并检查 `/health`，再安装当前平台的登录自启。

### macOS

```bash
./scripts/install-autostart.sh
```

脚本创建当前用户的 `com.agentos.local` LaunchAgent，固定已验证的 Node 22 路径，登录后自动运行，异常退出后自动拉起。日志位于 `data/logs/agentos-launchd.log` 和 `data/logs/agentos-launchd-error.log`。验证：

```bash
launchctl print gui/$(id -u)/com.agentos.local
curl http://127.0.0.1:8787/health
```

切换 Codex 账号后，执行 `launchctl kickstart -k gui/$(id -u)/com.agentos.local`，让新进程读取当前账号缓存。官方 Codex CLI 可用 `codex login status` 确认登录方式；无需重建飞书应用、项目映射或历史数据。服务离线时已发送但没有进入本地状态的消息不会自动补发，需要重新发送。移除自启：`./scripts/uninstall-autostart.sh`。

### Windows

```powershell
.\scripts\install-autostart.ps1
```

它注册当前 Windows 用户的 `HKCU Run` 启动项。关机重启后必须登录这个 Windows 用户，且电脑不能休眠；Codex 与 lark-cli 登录也必须仍有效。日志写入 `data/logs/`。移除自启：

```powershell
.\scripts\uninstall-autostart.ps1
```

## 13. 验收清单

- `doctor.ps1` 没有缺失项。
- `npm run check` 全绿。
- `/health` 返回 `ok: true`，Runner 为 codex。
- `/health` 返回 `analysisWorkflow: continuous-developer-tools-v2`，`runnerConcurrency` 与配置一致。
- 同时提交两到三张只读问题卡时，管理页面能看到多个忙碌 Runner；每张卡只有一个 Job，源码与环境工具证据都进入同一时间线。
- 五个 `im.message.receive_v1` 和五个 `card.action.trigger` 消费者 ready。
- 普通问候只回复、不创建 Job。
- 只读分析能读目标目录但不修改文件。
- 演示任务能停在澄清/审批门；错误身份不能审批。
- 卡片刷新不新建任务；停止任务等待真实进程退出。
- 重启后历史仍在，但没有重复消费同一消息。
- `git status` 不包含 `.env`、`*.local.json` 或 `data/`。

## 14. 更新与排障

更新代码：

```powershell
git pull --ff-only
.\scripts\use-node22.ps1 npm run check
```

在无在途任务时重启 AgentOS。常见检查顺序：

1. `/health` 是否正常。
2. 对应 profile 的消息消费者是否 ready。
3. 是否收到失败卡；收到说明飞书链路已通，继续查 Codex 路径、登录和网络。
4. `codex login status` 是否有效。
5. `proxyUrl` 对应端口是否真的监听；当前网络能直连就保持空字符串。
6. 查看 `data/logs/` 的必要脱敏片段，不把整份日志外发。

所有文件、日志和认证位置见 `docs/storage-and-data.md`；系统边界见 `docs/architecture.md` 与根目录 `SECURITY.md`。

## 分析前同步升级

源码分析现在要求配置 `analysisRepositories`，由 Runner 在只读 Codex 启动前同步各仓 origin 分支。旧版直接读本地目录的行为被此门禁收紧；参见 [同步配置与排查](source-sync.spec.md)。未配置或同步失败会阻塞，不能通过给分析模型开放写权限解决。


## 可追溯记忆与台账入口

默认启用近期预算、持久摘录摘要和范围内历史检索；`config/memory.local.json` 可配置，`data/memory.json` 私有保存。分析任务可用项目 `knowledgePaths` 提供台账入口，仍先同步再只读核实，不写台账或扩大权限。详细方案、字段、执行路径、失败恢复与平台限制见 [记忆管理](memory-management.md)。


## 群共享会话与问题主卡片（可选）

在 `config/conversation.local.json` 开启 `groupSessions` 与 `questionCards`，使用 Codex 原生持久会话，并让每个新问题维护一张主卡片。不开启时保留现有隔离记忆和卡片行为；不会改变普通成员权限或改建话题群。配置、使用、状态结构、备份及限制见[群共享会话与一问一卡](group-question-cards.md)。

## 可选：受控 UAT/PRD 查询

按[环境查询部署与权限说明](environment-access.md)在 Mac 本机配置，准备专用只读数据库账号和已审核模板。源码只读沙箱不放宽；PRD 普通成员请求逐次等待指定环境负责人批准。

## 环境工具排查升级

所有成员均可发起只读排查；PRD 成员查询仍需指定负责人批准。新增 Codex 按范围选择 Nacos API、独立浏览器列表/搜索/详情及 MySQL 结构化查询工具，本机向导可弹出 Nacos 登录窗口，自动发现命名空间并验证连接。固定模板继续兼容。首次凭据仍本机录入，Nacos 业务账号不复用为数据库登录。见 [环境工具说明](environment-access.md)。

浏览器依赖与完整测试：`npm ci` 后运行 `npx playwright install chromium`，再运行 `npm run check`。Linux 使用 `npx playwright install --with-deps chromium` 安装系统依赖。Nacos 使用专用适配器；其他业务网站使用通用网页链路。业务网站等待登录时，卡片会写明具体网址；网站负责人可直接回复该卡片，例如 `admin / 123456`，凭据进入 Mac Keychain 后由固定程序填写。群消息对群成员可见并由飞书留存；验证码、短信、扫码和特殊接口仍可能需要本机配合或适配。

首次环境查询可直接在群里给出明确 Nacos 或 MySQL 入口和排查目的，再由管理员回复原卡同意接入。AgentOS 会在当前已登录的 Mac 打开本机登录/凭据窗口；确认范围后自动继续原问题。需管理员真人映射、Chromium和Keychain，不能把密码发进群。详见 environment-access.md 的群内接入说明。

## 环境源码快照

可选 `analysisSourceMode=isolated`：以配置的项目根目录为来源，根据问题选择 `analysisEnvironments`，在 `analysisSnapshotRoot` 下按项目、环境、仓库来源与实际提交复用不可变源码缓存；新问题先核对远端分支，同题固定原提交。保留个人功能分支与未提交修改；环境未指定且无默认值时先询问，禁止回退 PRD。上文原目录快进同步规则仅适用于未启用此选项的兼容模式。同一卡内的源码与工具步骤复用同一分支/提交证据，仍不能证明实际部署版本。配置、清理与验收见 [源码同步说明](source-sync.spec.md)。

## 按问题发现业务网站

支持从问题与环境源码查找入口，打开本机独立浏览器并复用会话；等待登录时保留任务、登录后自动恢复。配置、权限、存储与兼容边界见[通用网页排查](query-driven-websites.md)。

## 15. 交给 Codex/AI 搭建自己的 AgentOS

可以让 Codex 或其他具备本机文件、终端和浏览器操作能力的 AI 按本教程完成大部分搭建，但必须同时提供本仓库和部署团队自己的事实。文档负责说明通用做法，仓库中的代码、示例配置、脚本和测试才是精确实现来源。

首次部署不要把 [`docs/maintenance-history.md`](maintenance-history.md) 当作当前配置说明。它只保存版本流水和旧验证基线，供维护者在升级、迁移或排查历史回归时查阅；当前行为始终以 `main` 的代码、示例配置、脚本、测试和本教程为准。

### 15.1 交给 AI 前准备这些信息

- AgentOS 仓库地址，以及准备部署的 `main` 提交号或团队明确选定的真实 tag。
- 运行电脑的平台、系统用户、AgentOS 绝对路径和业务项目绝对路径。
- 项目基准分支、只读分析仓库与环境分支映射、真实验证命令。
- 五个飞书应用是否已创建、发布并加入目标群；对应 profile、机器人 open_id、群 chat_id 和真人管理员 open_id。
- 是否启用 UAT/PRD、Nacos、MySQL 或业务网站排查，以及各环境负责人和允许的只读范围。
- 期望的团队角色、并发数、Codex 模型和推理强度。模型必须属于当前登录账号可用范围。
- 是否启用团队知识、共享项目/群/profile/成员范围、知识有效期，以及是否有真实部署版本清单；配置和横向流程图见[团队知识](team-knowledge.md)。

App Secret、密码、token 和生产凭据不要写入提示词、文档或 Git。需要时由真人在本机安全输入、系统钥匙串或受控配置流程中完成。创建和发布飞书应用、登录 Codex、批准权限、输入验证码及真实群验收都需要真人参与。

### 15.2 可直接交给 Codex/AI 的提示词

完整复制版放在 [`docs/ai-deployment-prompt.md`](ai-deployment-prompt.md)。它已经包含飞书实施手册链接、GitHub 地址、部署信息模板、七阶段执行步骤、必须由真人完成的节点、禁止事项、验收标准和最终交付格式。把其中非敏感占位符补齐后，可将整段提示词一次性交给 Codex/AI；App Secret、密码、token、验证码和生产凭据不要填进提示词。

### 15.3 AI 搭建完成的判定

只有同时满足第 13 节验收清单，并且记录以下结果，才能认为搭建完成：

1. 当前提交号与预期版本一致，`npm run check` 通过。
2. `/health` 返回 `ok: true`，Runner 数量、模型配置和策略标识符合预期。
3. 五个消息消费者和五个卡片回调消费者均 ready，没有重复启动第二套服务。
4. 普通成员只读排查与管理员实施权限均经过真实群消息验证。
5. 多个问题并发时使用独立 Job/Codex 会话，卡片、证据和回复不串线。
6. UAT/PRD、网页登录和数据库能力只在已配置且批准的范围内验证；未接入的能力明确标注。
7. `data/`、`*.local.json`、`.env`、凭据和业务日志未进入 Git，备份与自启动方式已记录。
8. 若启用团队知识，记录 SQLite 位置、范围、部署版本信号、跨成员同义命中、实时事实补查和纠错验收；停机备份包括整个 `data/knowledge/`。

## 上传文件提问

话题群先将本地文件上传飞书云空间，复制文件链接，回原话题贴链接并@机器人说明需求，例如“读取这个文件，核对所有行金额合计”。普通群仍可直接发送文件，再回复文件并@机器人；飞书话题编辑器不能直接发送本地文件。

程序以当前机器人身份读取云文件，在线文档/表格识别后只读导出；缺应用scope或文件未共享时显示橙色等待，不冒称完成分析。补齐后回复“已共享，请重试”或“已授权，请重试”，沿同题继续。纯文件分析不要求UAT/PRD，源码对照仍按原环境。部署分别验证应用权限和文件共享范围，操作与排障见[文件输入](file-input.md)。
