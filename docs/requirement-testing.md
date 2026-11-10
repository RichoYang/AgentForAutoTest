# 独立项目需求测试

在飞书群新建话题，单独 @ 对应的项目测试机器人，并发送同租户的飞书 Docs 或 Wiki 需求链接。同条消息里有多个 @ 时，系统要求选定一个目标。任务、进度、结果和完成提醒都归属原话题。项目绑定由已验证的应用、消息 profile、机器人 open_id、群 ID 和发起人名单决定。机器人不会依据消息里的项目名称切换项目。

## Windows 接入

1. 复用现有飞书应用。用消息 profile 执行 `lark-cli auth status --verify --json`，核对应用和机器人 open_id，再用已有用户 profile 回读群成员中的应用 ID。群成员查询和机器人自身查询使用各自应用视角的 open_id。
2. 为每个专员使用独立的运行目录、AgentOS 数据目录、监听端口和角色 profile。启动入口为 `node src/control-plane/local.js`，设置 `AGENTOS_DATA_DIR`、`AGENTOS_PROJECTS_FILE`、`AGENTOS_AGENTS_FILE` 和已验证的 `LARK_CLI_ENTRY`。设置 `AGENTOS_RUNNER_CONCURRENCY=1` 保持每个项目本机顺序执行。两项目如共享可写资源，应使用同一锁目录和同一锁键。
3. 在 `projects.local.json` 用 `chatProjectMap`、`topicChatIds` 配置专员入口，在 `projects.<id>.requirementTest` 配置下表字段。发起人用该机器人视角的 open_id，文档操作用用户 profile 的 open_id。团队旧实例可用 `messageExcludedChatIds` 停止接收这个群的新任务。
4. `conversation.local.json` 保持 `questionCards=true`。更改应用、群、项目默认配置后重启对应实例。查看 `/health` 的 `requirementProjects` 和两个订阅的状态。
5. macOS 尚未验证本工作流。部署者应先验证生成 Skill 的 PowerShell 入口、Node 和报告构建依赖，再执行同一组验收。

| 字段 | 含义 |
| --- | --- |
| `bot.profile`, `bot.appId`, `bot.openId` | 机器人消息身份。须与 `agents.local.json` 匹配 |
| `allowedChatIds`, `requesterOpenIds` | 可受理群和真人发起人 |
| `topicBindings` | 可选。数组项填写已核实的 `chatId`、根消息 `rootId` 和完整 `documentUrl`。只将这些话题交给当前项目 |
| `document.profile`, `document.appId`, `document.openId`, `document.configDir`, `document.domain` | 已登录的文档用户及认证目录，独立于机器人。必须具有需求、模板、目录和新表的实际权限 |
| `templateUrl`, `projectFolderUrl`, `timeZone` | 参考工作簿、项目版本目录、月份计算时区。按 `YYYY年MM月版本` 复用或建子目录，标题使用需求名和版本后缀 |
| `environment` | `name` 限 SIT/UAT，`platform`、`iniPath`、`resources` 配置明确的本项目资源节及 `read`、`create_update_read` 或 `full_crud` 范围，`lockKey` 配置共享资源锁 |
| `environment.aliases` | 同一套已验证测试资源可登记另一个 SIT/UAT 名称。消息中的「测试环境」选用项目绑定，原请求名称和实际绑定分别记录 |
| `environment.iniSha256` | 可选。固定资源 INI 的 UTF-8 内容摘要，执行层在加载资源时核对 |
| `allowedProjectFolderUrls`, `allowedReportDirectories`, `allowedInputDirectories` | 可按任务指定的飞书用例目录、本机结果目录和本机材料目录。部署者登记项目内批准的完整链接或绝对路径 |
| `lockDirectory`, `reportDirectory` | 共享资源锁和项目报告证据的本机绝对目录 |
| `skills.generator`, `skills.regression` | 各有绝对 `path` 和 `sha256`。按 `requirement-files.js` 中列表依次散列每个路径、NUL、文件内容、NUL |
| `powerShell`, `validationCli` | 本机 PowerShell 及生成 Skill 校验脚本要求的飞书 CLI 可执行入口 |
| `adapter.path`, `adapter.sha256` | 可选的本机 ESM 执行适配器，须固定文件版本。也可配置下列内置执行目录 |
| `execution.login`、`execution.operations` | 项目登录和可复用操作目录。可登记浏览器交互、业务 API、MySQL 参数化查询、CSV 及带回读和清理的专属对象创建。按操作声明输入、测试对象、可观察字段和业务语义 |
| `execution.dimensions` | 测试对象维度目录。登记项目标签 `labels`、值格式 `pattern` 和可选的 `required`。用例字段与原始需求锚点提供值，计划不能替换 |
| `execution.releaseManifest` | 可选的发布记录来源和组件映射。Runner 记录可取得的版本证据及缺口 |
| `execution.caseReleases` | 可选的用例版本前置，按原 caseId 登记组件和精确版本标识 |
| `analysisRepositories` | 项目源仓与分支。执行前记录配置分支提交，报告另列运行版本证据 |

凭据只在受控执行层按项目读取，操作权限取 INI 与项目绑定的交集。接入示例、受控连接探针、配置变化处理和故障诊断见[受控 INI 接入](controlled-ini.md)。项目适配器是本地受信任代码，由部署者登记。适配器应固定 UI/API/SQL/任务入口，限制业务键，阻止 DDL 和未知归属记录，并完成证据脱敏。

## 在同一群使用独立的话题项目

1. 保留 `chatProjectMap` 中的默认项目。先发一条不含 @ 和需求链接的标记消息作为新话题根，并回读确认群、根消息 ID 和话题 ID。
2. 为受限任务增加单独项目，配置实际源码、环境资源、用例目录和报告目录。`topicBindings` 示例为 `[{"chatId":"oc_群标识","rootId":"om_根消息标识","documentUrl":"https://你的租户.feishu.cn/docx/需求标识"}]`。复用默认项目的机器人和文档身份，授权群和发起人只能是默认范围的子集。
3. 隔离验收可将新项目绑定到专用 Git 根、回环服务、单独的数据库和限定库权限的账号。通过资源加载器核对实际地址、数据库及权限，并以 `environment.iniSha256` 固定专用 INI。配置中仅登记所需资源及本轮输出路径。
4. 重新加载专员实例后检查 `/health` 中的 `scopedTopicCount`，同时核对运行源码、项目配置和消费者归属。从登记根消息发起话题内回复，单独 @ 专员，发送匹配的需求链接。以 `AgentOS隔离验收` 开头的带链接指令要求显式话题绑定。
5. 路由拒绝重叠的话题或需求链接。已登记的受限需求链接在错话题不会进入默认项目。新 Job 保存话题项目摘要和可取得的源事件 ID，Runner 在调用模型前复核摘要、群、根消息、文档、资源和源码。保留配置直至任务和报告清理完成，然后移除临时话题项目。

话题绑定复用同一消息和卡片订阅。需要验证真实群时，应保留源消息、事件、话题、Job、云端用例回读和附件摘要。模块测试和模拟传输的结果按各自入口记录。

## 执行和恢复

- 消息可写「在 UAT 环境进行需求测试」，并另起行填写「用例存放：飞书目录链接」「输出路径：本机绝对目录」「补充文档：本机目录」「开发反馈：本机目录」。显式用例目录直接使用，未指定时沿用按月建子目录的默认规则。原目录同名表会触发核对。
- 补充文档读取登记目录中的 Markdown，使用章节锚点补足正文。开发反馈只用作测试设计参考。发布回读后在选定结果目录的任务子目录保存索引和发布凭证。

- 需求正文和可识别的嵌入工作表记录版本及摘要。用例按生成 Skill 的模板列和模块顺序产生，并用其 PowerShell 脚本做本地校验。配套索引保存需求锚点、caseId、飞书行号。
- 飞书图片、白板和可获取图片预览的脑图会下载到任务目录并记录块锚点与文件摘要。多维表格分页读取字段和记录。已授权的本机补充目录支持 Markdown 和 PNG／JPEG／WebP。旧任务补录图示时会生成覆盖差异。原需求正文和版本相同且尚无业务执行检查点时，明确漏项会校验并发布独立修订表。原表、回执、用例 ID 和旧用例内容保留。歧义由原发起人在原话题用「确认图示 问题编号 答复」处理，示例金额或格式不自动升格为规则。
- 使用指定用户身份复制模板到项目月份目录，逐单元格回读、核对页签和唯一文件。发布意图在调用前落盘，已知副本有 token 回执。超时后核对原目录及回执。未知归属的同名文件由管理员核对，程序不覆盖或删除。
- 业务适配器实现 `prepare(case)`、`execute(case)`、`reconcile(case)` 和 `cleanup(scope)`，可额外实现 `verifyDeployment(scope)` 收集发布证据。读取通过 `useRead`。变更通过 `invoke(intent, apply)` 写入持久化意图和回执。意图应有资源名、操作、runPrefix 归属或明确共享快照、恢复动作。写入和清理前复核资源的非生产归属、操作权限及本轮绑定。单个资源无法确认时阻塞受影响的用例，已登记但无法确认恢复的变更保留锁和清理台账。
- 操作输入可以用 `{"from":0,"field":["id"]}` 引用已执行步骤的观测。`when.ref` 使用同样格式，配合 `when.equals` 按现场观测选择分支。步骤输入及结果随原 Job 保存。条件跳过后缺少用例断言，结果按验证不足处理。
- 浏览器操作登记固定页面路径、选择器及动作。同资源查询可由浏览器操作显式引用已登记的只读 POST。提交仍由变更意图控制，核对同源、方法、端点和本轮业务键。拦截及网络错误保存为执行阻断；确实到达服务的错误响应保留 HTTP 状态，按业务观测和用例判定。
- 用例索引随生成产物记录原始预期、逐条结构化断言、需求锚点与 caseId。执行器使用同一编译器复核。支持登记同义名、并列条件、严格或含边界比较、同一观测记录内的字段关系及加减计算，以及由前后观测证明的状态迁移。HTTP 状态、错误码和成功标记不能代替业务断言。每个不可绑定片段显式留在检查点，包含但不限于未登记字段、条件分支或异步排序规则。
- 业务数据可以用登记的只读查询发现，再用 API 或浏览器夹具构造。写前记录运行键、快照和意图，写后回读保存回执。恢复时对账，清理后按键回读并核对原始快照。报告关联前置矩阵、变更回执、清理失败尝试及恢复证据。
- 可在原话题 @ 专员询问「当前进度怎么样」「当前阻塞」，或发出「继续测试」「暂停测试」「取消测试」「恢复清理」。任务状态来自原 Job 和执行事件。运行中暂停或取消须等待执行进程退出，暂停后继续使用原检查点。并发和重复消息不会为同一话题创建第二个 Job。
- 运行卡和状态回复按同一轮结构化进度显示用例状态、当前用例独立业务检查、过程要求、历史断言尝试、执行器错误和未决变更。发生缺口时展示缺少的证据及下一步。停止测试时保留变更台账，原进程退出后可在原话题恢复清理。
- 需求测试进入待处理时，已送达的任务卡可向原话题发起人投递对应的等待提醒。程序核对同一问题、接收人和回复目标，仍会拦住与当前状态不符的完成提醒。
- 报告投递可与业务结论分别核验。取消后仅清理生成的报告保留未执行条目，卡片显示「已取消 · 清理与报告完成」。未取消任务恢复清理时，已有业务判定保留。存在未执行或阻断时显示业务验收未完成，完成测试但有产品失败时明确标记失败。
- 清理台账分别保存动作回执与恢复回查。实际收到恢复响应时，记录变更键、操作与输入、起止时间及脱敏响应，供过程审查和报告引用。已经回读证实恢复且没有可用动作响应时，标记为回读对账。历史尝试保留原证据，当前检查使用本次尝试和测量轮次的变更键。
- 异步正向动作的就绪条件用于确认后台已结束，再进入恢复。恢复后按原快照回查。仍有未决时暂停更早的撤销步骤。旧版若已继续撤销，程序可校验同对象的原恢复响应、下一步实际清理前回读及当前最终恢复状态，并将历史回读单独登记，保留原失败记录。
- 工具型 Runner 按冻结检查的 `beforeAction` 在对应写入前确认独立前态。历史业务结果、清理后补充证明、报告实际核验和附件投递分别记录。状态回复显示当前过程覆盖，原尝试的断言和过程缺口仍可回查。
- 原发起人可在暂停、等待或结束状态回复「重试未执行」或「重试失败」。前者重跑未执行项，后者同时重跑失败项；两者继续尚未处理用例，保留通过项和旧尝试，不新建 Job 或改原发布回执。重试前必须先恢复并回查所有未决业务变更；重复消息不重复重试。
- 等待解除后，由原发起人在原话题回复「继续」。项目冲突时回复「确认项目」，仍以原机器人绑定为准。对有待清理记录的暂停或已确认进程退出的取消任务，回复「恢复清理」。升级后执行绑定变化且有未决变更时，同样先从原话题「恢复清理」，按保存的资源和恢复契约核验，资源变化需先核对原绑定。需求版本变化应另发新话题，并先处理原任务遗留数据。Windows 的过期租约仍按 AgentOS 进程围栏处理，必须先核实旧进程树，不能仅凭服务重启解锁或重跑。
- 成功运行后用执行 Skill 的专用构建器校验 JSON、生成并重开固定 15 张工作表。逐表核验预览，宽表可用重叠原像素分区复核。另从重开的工作簿核对用例 ID、执行状态和汇总计数。登记 XLSX SHA-256、预览摘要和视觉回执，随后由 AgentOS 文件投递队列回复原话题。产品用例失败计入报告，清理未核验时任务保持待处理。
- 执行记录可提供 `specialty.fix_verifications`、`specialty.code_chains` 和 `specialty.export_validations`。汇总时绑定用例和本轮证据。导出通过或失败的记录须关联实际文件，专项缺少结果时在执行说明中标明状态。
- 本机恢复材料位于 `data/requirement-tests/<JOB>/`，包括需求快照、发布回执、用例及索引、执行和清理台账、报告输入和预览。最终报告和证据位于配置的报告目录。遇到重复事件或发错项目，应核对原任务绑定和可信应用身份，勿手工修改状态文件。
- 整个实例意外退出后，先停止对应实例并核实原 worker 和子进程已退出，备份运行数据。可用 `node scripts/recover-requirement-job.mjs <你的实例数据绝对目录> <JOB-ID> --instance-and-process-tree-stopped` 解除已核实的旧租约，保留资源锁和执行检查点。重启后由原发起人在原话题 @ 专员并回复「继续」或「恢复清理」。Windows 必须核对完整进程树，不能只凭主进程 PID 消失。

## 内置执行器配置和发布清单

需要后台自行调查源码、准备对象并使用工具执行时，配置[工具型需求测试专员](requirement-agent.md)的 `execution.mode=agent`。以下为继续兼容的静态操作目录模式。

操作目录由项目维护并跨需求复用。以下是只读业务观测示例，字段路径须按项目实际接口核对。

```json
{
  "kind": "http",
  "resource": "platform",
  "path": "/api/approved-business-query",
  "inputs": ["id"],
  "outputs": {"amount": ["data", "amount"], "currency": ["data", "currency"]},
  "observations": [{"id": "availableAmount", "label": "可用金额", "type": "number",
    "unit": "元", "unitField": ["currency"], "field": ["amount"]}]
}
```

匹配的独立预期示例为「1. 可用金额等于 100 元」。可用 `aliases` 登记项目同义业务标签。同一语义 ID 在各入口保持相同含义。项目明确为只读查询的 POST 需登记 `readOnly: true`。能返回业务观测的错误响应可按接口契约用 `observeStatuses` 声明。项目无可信观测契约的预期会报告验证不足。

### 对象和浏览器查询契约

每项操作在 `subject` 下以维度名登记 `input` 和响应身份字段路径 `output`。例如维度 `account` 的配置为 `{"labels":["账户编号"],"pattern":"[A-Z][0-9]+","required":true}`，查询操作的同名绑定为 `{"input":"account","output":["owner"]}`。若接口契约保证结果受同一查询约束，可以使用 `verify: "query"`。使用上游返回的 ID 时，配置 `derived: true` 和 `derivedFrom: {operation, field}`，并在上游登记同一维度的核验方式。

浏览器操作通过 `queries` 引用同资源的已登记操作。例如 `{"lookup":{"input":{"account":"account"}}}` 将浏览器输入 account 映射给 lookup 的参数；常量写在可信配置的 `fixed` 内。执行器检查完整请求参数。点击动作可登记 `query: "lookup"` 等待对应 HTTP 响应，再用 `waitFor` 等待页面的数据加载完成标记。以实际查询作为对象证据时，浏览器的 `subject` 需要写明 `query` 名和可选的 `parameter`。

自然语言如「页面显示可用金额等于总额减有效占用，且不含无效占用」会生成两个独立断言，配置要覆盖四个观测，并明确数值单位。「状态从待审转为已审」通过状态观测的 `previous` 指向另一登记观测，分别校验初始及最终状态。待确认或超出当前语法的片段将保留原文，整个用例不会因其余片段通过而判为通过。

项目可以用 `execution.releaseManifest.path` 指向受信任的本机绝对路径，或增加 `resource` 并以相对 URL 路径读取已登记资源上的只读发布记录。远程来源需返回相同结构的 JSON。需要 Bearer 鉴权时显式设置 `bearer: true`，凭据从该资源的 INI `token` 字段读取。每个 `components` 项配置资源名 `resource`、运行版本文件相对 `path` 和对应源码 `repository`。清单顶层包含 `version: 1`、`projectId`、`environment` 及 `releases`，以需求文档 ID 为键记录 `revision`、`sourceHash`、`validUntil` 和各组件的 `commit`、`sha256`、可选的 `buildId`、`imageTag` 或 `imageDigest`。

开始执行时记录当前可取得的发布和运行产物证据。来源缺失、返回 403、记录过期或版本不一致时，执行说明和证据索引会保留缺口，普通用例根据页面、接口和数据实测判定。确实依赖指定版本的用例，可在前置条件写 `发布版本前置：web imageTag=uat-123`，或在 `execution.caseReleases` 按稳定 caseId 登记 `{"component":"web","imageTag":"uat-123"}`。支持 `commit`、`sha256`、`buildId`、`imageTag` 和 `imageDigest`。仅对应组件和要求的版本能被核对时才执行这条用例，缺少证明则在报告中单列阻断。旧任务停在 `deployment_baseline` 时，原发起人在原话题回复「继续测试」，沿用原任务、用例、发布及回读回执。

## 隔离验收及后续部署

Windows PowerShell 中设置两套 Skill 所在目录，使用 Node 22 执行以下命令。测试只使用临时状态、回环站点和模拟飞书。用例校验及 15 表构建器实际运行。

```powershell
$env:AGENTOS_REQUIREMENT_SKILLS_ROOT = '<两套 Skill 的父目录>'
node --test test/requirement-testing.test.js test/topic-chat.test.js test/requirement-followup.test.js test/requirement-isolation.test.js test/requirement-binding.test.js
```

本轮源码可先放到独立程序目录，用该命令核对。实际部署前备份应用与实例数据，核对源码和文件清单。经另行授权时，先停止旧实例并核对后台进程已退出，使用独立数据目录和模拟身份验证新版。正式切换前核对项目业务观测目录、队列及旧变更检查点，确认后再启动现有订阅。

先运行 `node --test test/requirement-testing.test.js test/topic-chat.test.js test/requirement-followup.test.js`，然后检查已配置的消息和文档身份。确认本地启动时的订阅器拿到需求路由表，真实 @ 事件在原话题创建任务。后台只读探测可验证飞书、数据库连接、浏览器导航和报告构建依赖。测试环境验收还需核对用例、实际通过和失败证据、环境权限、重启恢复、清理复核以及最终文件投递。
