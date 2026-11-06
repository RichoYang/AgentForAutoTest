# Windows 兼容与异常恢复验证

2026-11-06，AgentOS **1.51.0**。起点为 main `52ae9c818cde090452da0e7a24e962503146fb8c` / 1.50.0。最终冻结141个 `src/` 文件，按路径排序的 `{path,sha256}` JSON 的 SHA-256 为 **`2a55698b99d9dea0563f705a501b945d72dd0c922892956f3f4df3548864077f`**。所有最终模型和完整检查对应这些源码字节，提交与部署分开记录。

## 结论与环境

最终完整检查 **790/790通过，失败0、取消0、跳过0**；工作台 **14/14通过**。原33个失败名称为32个独立失败及1个questions父级汇总；32项均实际通过，父项随子项修复消失。原4个跳过均有明确处理，不能据此宣称已运行macOS/Linux本机集成。

环境：Windows 10.0.19045 x64，Node 22.23.2，Git 2.45.1.windows.1，MySQL 9.7.1，Playwright 1.63.0，Chromium 153.0.8010.12；Node兼容范围仍为22.13～22.x，npm依赖未增加。模型保持实际配置 **gpt-5.6-sol / high**；没有因主线模型名称修改AgentOS配置。

范围与根因逐项见[问题表](windows-reliability.spec.md)，实现及运维见[实现说明](windows-reliability.md)。W01补Windows内核锁，并修复实际走到下游后发现的Git路径/子仓排除及GC字节采集兼容问题；W02补整树归属与退出证明；W03修真实DACL并保留POSIX权限；W04～W09修平台测试、路径和资源生命周期。后续实际验证又确认W10参数名称Schema缺失、W11测试等待/退出顺序、W12探测拒绝传播、W13创建瞬间权限窗口，均修复后重新冻结与重验。未重写已有nullAs、evidenceRefs、测量基线、独立预期、对账、页面/API分渠道或报告进程隔离。

## 原33个失败名称的去向

以下逐项来自上一轮 `full-baseline-comparison.json` 的失败名单和本轮最终TAP。分类编号不代表每个失败都是独立Bug。

| # | 原失败名称 | 分类 / 最终去向 |
| --- | --- | --- |
| 1 | macOS ChatGPT Codex discovery follows the current nested app bundle | W04 / 通过 |
| 2 | macOS ChatGPT Codex discovery ignores a non-executable bundle file | W04 / 通过 |
| 3 | startup recovers only matching dead local owners and absent entire worker groups, with preserved evidence | W02 / 通过 |
| 4 | successful evidence survives worker reopen with exact arguments and original observation time; fresh reads replace it | W01 / 通过 |
| 5 | different actor, project, source or environment cannot resume prior evidence or planner | W01 / 通过 |
| 6 | bad evidence checksum and symlink directories fail explicitly rather than silently trusting history | W01 / 通过 |
| 7 | failed or incomplete evidence never becomes reusable and revocation is checked on cache hits | W01 / 通过 |
| 8 | same task resumes native planner across process lifetimes and transport failure never silently forks | W01 / 通过 |
| 9 | concurrent workers serialize task evidence publication instead of overwriting a new reference | W01 / 通过 |
| 10 | confirmed missing native thread recovers with retained evidence while changed runtime starts a new compatible planner | W01 / 通过 |
| 11 | Chinese historical query retrieves first of 50 turns after restart without changing raw state | W03 / 通过 |
| 12 | persistent session resumes across engine restart, caches decisions, and keeps private registry | W03 / 通过 |
| 13 | test/questions.test.js（原绝对路径文件级汇总） | W08 / 父级汇总消失；不另算独立Bug |
| 14 | CLI report reply uses a confined relative file and the original bot profile | W05 / 通过 |
| 15 | actual SQLite, personal digests and persistent thread registry delete expired data, keep fresh and pending live work | W06 / 通过 |
| 16 | operator preview is read-only and emits counts without question text or task IDs | W07 / 通过 |
| 17 | isolated environment snapshots preserve dirty feature checkout and separate concurrent UAT/PRD | W01 / 通过 |
| 18 | isolated root plus child repositories work and reject changed manifest, escape, and missing branch | W01 / 通过 |
| 19 | immutable cache deduplicates concurrent questions, refreshes tips, preserves live versions and removes obsolete clean versions | W01 / 通过 |
| 20 | remote rollback selects an existing cache without mutating it; GC follows latest selection, and never follows symlinks | W01 / 通过 |
| 21 | snapshot locks serialize independent callers and release after an operation error | W01 / 通过 |
| 22 | reclaimed continuation restores the exact historical commit, new questions still check remote and failures do not switch versions | W01 / 通过 |
| 23 | GC rechecks references inside state writer and protects pending delivery, dirty ignored files and unknown metadata | W01 / 通过 |
| 24 | separate Node processes reuse one published cache and release the lock after owner exits | W01 / 通过 |
| 25 | recreating a reclaimed cache after remote rollback preserves the original immutable manifest | W01 / 通过 |
| 26 | GC verifies ignored child repositories independently instead of treating managed children as local dirt | W01 / 通过 |
| 27 | live maintenance requires admin authentication and protects waiting references in the state writer | W01 / 通过 |
| 28 | registered worktrees and anomalous manifests are retained instead of reclaimed | W01 / 通过 |
| 29 | a new question ignores tagged historical context while same-question durable pins survive context compaction | W01 / 通过 |
| 30 | history upgrades shallow caches concurrently without changing pinned source or selecting newer remote | W01 / 通过 |
| 31 | history fetch failures preserve current evidence; source identity changes and symlinks are rejected | W01 / 通过 |
| 32 | A verified guide becomes B paraphrase candidate; canonical reply is consistent and survives restart | W03 / 通过 |
| 33 | real browser waits for login, reuses persistent session, isolates pages and blocks write traffic | W03 / 通过 |

## 原4个跳过

| 原测试 | 本轮处理和实际结果 | 证据边界 |
| --- | --- | --- |
| symlinked contact image directory is refused before any output is written | Windows真实directory junction越界，输出前拒绝；通过 | 不依赖开启创建符号链接特权 |
| losing the IPC parent exits the detached worker group; normal completion remains successful | Windows真实IPC断开及Job Object树退出；正常完成仍成功；通过 | POSIX进程组逻辑保留；没有在Linux本机执行 |
| file-only worker reads actual full CSV through real task preparation without a source repository | 编译真实Windows原生标准流转发夹具，正常task准备读取完整CSV；通过 | 夹具用于模块验证，不计真实模型业务证据 |
| POSIX Node installations resolve global lark-cli from the prefix lib directory | 显式平台参数检验prefix/lib布局及目录归属；通过；Windows真实发现另有测试 | 纯布局测试，不冒充POSIX系统可执行权限集成 |

macOS Codex的两项测试也分离了布局选择与X_OK访问探针。真实macOS应用包、系统签名/执行权限及POSIX内核锁仍需相应目标OS验收；本轮没有这些系统。

## 真实Windows组件

- 独立进程争用内核锁、所有者崩溃释放、辅助进程丢失后停止发布、reparse拒绝；临时Git库实际经过版本固定/更新、历史恢复、脏文件和活动引用GC保护。22项源码/调查原失败均运行到下游并通过，未跳锁或按锁年龄删除。
- 实际owner、worker及孙进程加入内核Job；owner退出后树退出，原PID创建时点不符不冒充原执行者；主机、租约、远端及cancelled边界均验证。没有强制系统PID绕回；PID复用边界使用真实存活进程与不同创建时点。系统受保护进程的真实Access denied和不可用辅助程序均保留诊断/租约，未知不被当作不存在。真实Chromium也在正式 `executeTaskProcess` Job包装内启动、读取DOM并退出至active=0。
- Memory、会话注册表原子替换、知识库SQLite关闭/重开、浏览器登录态保存/重用及目录重建实际核验DACL。FileSystemWatcher在**创建事件**核验私有文件和目录，原始二进制字节一致、已有文件不覆盖。修复前确实捕获空临时文件的宽继承窗口；这是合成空文件证据，不声称发生过真实数据泄露。
- 实际AuthzAccessCheck使用当前/外部 **SID-only上下文**，当前读取允许、外部读取拒绝；没有进行第二用户交互登录。Chromium Cookie目录自加的LPAC能力SID由Windows API派生并核对，沙箱保持启用；不能将其任意等同普通用户组，也不能扩大为任意能力白名单。共享父目录ACL前后不变，没有改TPM或用户主目录权限。该边界不防同一用户、管理员或SYSTEM。
- report原生进程读取/预览两项在完整检查中实际启用，使用保留的隔离报告作模块输入，不等于重新执行历史业务。Mono/WASM内部问题未声称修复，已有独立进程隔离方案保留。

## 冻结后真实模型与正常Runner

| 验证 | 实际结果 | 人工干预与边界 |
| --- | --- | --- |
| runner-atomic | 正式控制面、AgentRunner和默认worker实际读取源码；工程中断后恢复1条为blocked并保留源码pin，显式接续后completed/ready；新问题发现新远端提交；业务请求0 | 仅中断本轮只读Runner；没有中断真实专员或重放业务 |
| evidence-atomic | 两个真实Windows进程复用同native planner和成功原始证据；历史2条/30保留原时点，fresh重新读到3条/35，独立SQL一致；数据库和SELECT-only账号已删除 | 凭据读取由隔离账号适配器提供，其余为正式调查器/工具；不冒充macOS钥匙串验证 |
| inventory-atomic | 1/1用例通过；20/20独立业务检查通过、失败0；5/5过程证据；当前计划20次检查尝试；未决0，四表零残留；15表XLSX、15张预览视觉审查与文件哈希回读一致 | 正常需求Runner、实际MySQL/HTTP/Chromium；隔离传输，无固定计划、无人填结果；报告读取与布局为独立进程 |

库存链保留32次工具错误（不是32个Bug）与3次测量重启。重启前均有真实恢复回查；原因依次为：

1. 首次准备B时数据库计算字段available由连接器返回字符串，数值型after契约导致变更状态不确定；已按台账恢复A/B并回查，现以已核实的实际类型重新准备，禁止复用操作后结果作原基线。
2. 冻结计划中C3错误地把空集合snapshot作为主体身份观测，无法由空行核实business_key；已新登记可同时返回请求business_key与完整预留计数的只读数据库方法，需按规范恢复当前准备数据后从原始零残留基线重执行并重新冻结。
3. 冻结计划错误地将原文明确说明属于执行过程的四表清理回查拆成C21-C24业务检查，与P8冲突且冻结后不可移除；当前场景已按台账完整恢复并四表零残留。按审查要求归档该尝试，从零残留基线重新准备，仅保留C1-C20业务检查，将四表回查归入P7清理过程后重执行。

原错误计划把4项清理过程算入24个业务检查，已归档；最终仅计20个业务检查，过程单独统计。按时间边界核对各测量epoch实际POST /reserve次数为 **[0, 0, 1, 1]**，总2次；含恢复后明确重执行的不同epoch，不能误称整个任务只调用一次。每个执行场景epoch至多一次，丢回执后以实际状态对账，没有在同一epoch重复创建。10项台账记录全部清理核验，历史保留。保存7项带源码依据的操作契约；本轮没有拿实时对象状态当稳定知识。最终报告SHA-256为`9463fcc973889d5d8769ef99504c8abcfe0d265c5738fe57e306a83b0a7a2f27`。

| 工具诊断分类 | 次数 |
| --- | --- |
| 测量预检、主体、范围或渠道证据不足 | 12 |
| 候选参数或原文引用不合法 | 2 |
| 变更状态/恢复范围待核实 | 2 |
| 冻结计划变更拒绝 | 2 |
| 连接器诊断（本场景实际丢失回执） | 1 |
| 页面首次A/切回A阶段不符 | 9 |
| 过程要求误计为业务检查 | 2 |
| 过程证据缺少异常分支说明或时间字段 | 2 |

这些诊断记录对应候选计划、证据和工具调用，保留具体字段与修正历史。其中回执丢失由隔离服务有意在提交后断开连接，其余拒绝不通过降低审查门槛消除；本轮已确认的Schema缺口W10在冻结前修复。

丢回执实际发生在同一最终执行器的epoch2，之后通过实际状态对账且该epoch没有重发创建。epoch3在前态恢复核验后重新执行，因隔离服务已记住故障键，回执正常；P6明确记录本epoch未发生丢回执、异常分支未再验证。不能把最终epoch未发生的故障写成当次通过；该故障的实际证据保留在epoch2及同一台账中。

三项均使用实际模型、真实工具及新建隔离资源；没有固定执行计划，没有复用原19条或真实TPM对象。飞书文档/上传使用隔离模拟传输，不能替代真实群接单验收。真实模型的合理拒绝、重试和历史尝试保留；检查通过数按独立checkId当前结论统计，工具错误数不等于产品失败数，部分检查通过没有提前标成整例通过。

人工干预明确限定：工程夹具在真实模型工具活动后中断自身只读Runner；在两个调查进程之间向自有隔离表插入一行，以检验历史时点和fresh读取。业务库存整链由模型发现入口、准备数据、验证基线、执行、独立判定、对账、清理及生成报告，没有人工填计划/预期/结果。工程中修改执行器后旧结果不直接归属新版本；最终阶段未为该库存样本再修改执行器。

## 验证历史与来源

私有证据根为 `.local/windows-repair-20261106`，包含环境、按文件源码清单、各次TAP、模型/工具/台账、ACL、报告与哈希。它不进入公共仓库，避免发布本机运行数据。可复用入口已提交：`scripts/freeze-verification-source.mjs`、`verify-windows-runner.mjs`、`verify-windows-evidence.mjs`；完整需求链复用既有 `verify-requirement-chain.mjs`。必须使用新的证据目录、本轮专用回环MySQL及既有两个Skill，先冻结，后运行，再用 `--verify` 核对；不能覆盖不同冻结或指向业务服务。

| 阶段 | 结果与保留说明 |
| --- | --- |
| 起始1.50.0 | 787项，750通过/33失败/4跳过；保留旧证据 |
| 首轮完整检查，bbb523… | 789项，787通过/0失败/2跳过；原生报告输入未设置，未冒称全覆盖 |
| 第二轮，d5bf7a… | 790项，780通过/2失败/8取消/0跳过；一项会话等待缺陷及父汇总，修W11；取消不算8个新Bug |
| 第三轮，d5bf7a… | 789项，788通过/1失败/0取消/0跳过；真实进程探测拒绝，修W12 |
| 第四轮，37eda8… | 789/789通过；随后创建事件探针暴露W13，因此没有拿这次通过直接交付 |
| 最终，2a5569… | **790/790通过，0失败/0取消/0跳过；工作台14/14**；全量重新覆盖W13；最终模型/ACL/Chromium均绑定2a5569… |

此前不同冻结的Runner、库存及调查通过记录全部保留，不能与最终记录混称一次执行。旧报告重生成也明确区分报告源码与业务执行源码。语法检查、PowerShell解析及 `git diff --check` 已完成。

最终暂存内容与实际验证源码逐一核对：128个源码字节相同，13个既有源码仅有Git将工作区CRLF规范化为LF的差异，无其他内容差异。Git规范化的141源码指纹为`dfdcb4d97e7f3ef2bd9768feb70456c7e51aac212b56ed0e097b7ab1d41418ef`；它和运行字节指纹2a5569…分别记录，不混称。源码ZIP从最终提交归档，再仅对这13个文本条目恢复实际验证过的行尾，逐一核验141个源码条目与冻结字节一致；实际提交、远端、条目转换证明及ZIP摘要另见交付回执和共享Memory。新Git检出的行尾取决于.gitattributes及本机设置，重新验证应冻结实际使用的字节，不能直接套用其他检出目录的原始文件哈希。

## 外部事项与剩余边界

线上飞书手册已只读回查revision1300，现有身份edit=false；与1.51.0一致的章节稿已准备，**没有线上写入或修改共享权限**。获得编辑权后须重新读最新revision、逐章合并及回读。共享Memory已纠正B-020～B-022为1.50.0代码/隔离验证已修，真实项目未验收；历史和Memory恢复哈希证据保留，本轮写入采用重读、并发核对、备份、临时文件校验、替换及回读。

本轮无部署、重启、真实群消息、真实需求接单或TPM业务写入。TPM仍为1.50.0，其他实例1.45.0；程序指纹与任务记录前后相同。原 `JOB-20261104125316-30fdf7` 仍cancelled，其7485个历史文件摘要不变，12项历史恢复/未决0不变；没有重做恢复、补业务结果或复制原用例。取消状态不依赖是否报告生成或清理完成。

本轮专用回环MySQL在核对进程、端口和datadir归属，以及测试库/只读账号均零残留后，已正常shutdown。仅保留隔离系统数据、日志、Git夹具与验证产物供复查；共享MySQL程序和旧隔离目录未删除，未重试旧的被拒绝清理。

后续部署需要**独立授权**、程序/配置/状态/ACL备份、在途与未决检查，再验证实际加载源码和入口；真实群验收另行授权，不能用原取消任务触发。旧Windows v1、远端/主机不符或访问拒绝的进程登记仍需取得可靠归属/退出证据；不会自动猜安全。跨数据库/跨表采集一致性、更多API分页属其他范围。源码和本机隔离通过不代表真实TPM需求、第二用户登录、macOS/Linux系统或真实飞书群已经验收。
