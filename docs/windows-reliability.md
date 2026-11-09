# Windows 锁、私有数据与异常恢复

适用版本：1.51.0。问题表见[范围与关闭条件](windows-reliability.spec.md)，实际检查及模型证据见[验证记录](windows-reliability.verification.md)。需求独立预期、测量基线、变更对账及报告契约保留。

## 源码缓存和调查证据

`withSnapshotLock` 仍是源码发布、历史恢复、缓存回收和调查会话的共同互斥入口。Windows 通过系统 Windows PowerShell/.NET 调用 `CreateFile`，以不共享的内核句柄持有 `.snapshot.lock`；竞争者等待释放。拒绝目录和 reparse point，不按年龄删除锁。所有者管道关闭或进程退出后释放；发布/覆盖/删除前仍检查锁持有进程，丢锁即停止。底层退出码和异常保留。

Mac/Linux 保留 Python3/POSIX flock。Windows 无需 Python fcntl 或新增 npm 依赖；系统 PowerShell、安全策略或内核接口拒绝操作时明确失败，不退化为无锁运行。辅助进程使用 `-NoProfile`，不改变系统执行策略或全局配置。

Git 返回的仓库根路径先转为实际目录，再核对与受限目录一致；提交、独立克隆、清单、脏文件、子仓及活动引用保护仍执行。Git 子仓排除路径使用 `/`。Windows GC 字节统计是逻辑文件字节，不跟随链接；其他平台保留 `du` 磁盘占用口径，不能直接比较为性能收益。

调查会话仍按任务/身份/项目/环境/源码绑定保存成功工具证据和原时点。跨进程接续须通过摘要、授权及绑定检查；实时更新显式 fresh/refresh 后重新读取。新锁不将历史数据变为永久实时事实。

## 私有数据

Windows 的 chmod 不建立私有 DACL。记忆和 Codex 会话注册表的临时文件使用Windows创建接口原子传入仅当前身份和SYSTEM可访问的受保护DACL；CreateNew且独占，确认创建后才经stdin写入原始字节并刷盘，再原子替换。不经过“先宽权限创建、稍后改ACL”的窗口，不把正文放进命令参数或日志。已有文件不覆盖，失败时仅删除已确认由本次创建的临时文件，不调整共享数据根目录。知识库、浏览器profile根/项目目录、调查及执行注册目录也在创建时提供私有DACL，并复核既有目录，后代继承当前用户/SYSTEM。

POSIX 保留文件0600/目录0700。目标符号链接被拒绝；ACL 失败不能忽略后继续保存。测试核对真实 DACL、继承、重建及 Chromium 登录态，Windows stat.mode 不证明私有性。Chromium可能为Cookie目录添加自身网络沙箱LPAC能力SID；实际验收核对内核派生的确切SID及当前/外部身份Authz访问结果，不把能力SID当普通用户组，也不关闭沙箱或允许任意能力SID。该边界不防管理员/SYSTEM、同一登录用户的其他进程或已获授权的模型。

升级前备份数据及 ACL，先在自有隔离目录验证再安排部署。运行身份改变时由运维核对原数据访问权，程序不自动扩大权限。本轮未调整现有实例、用户主目录或共享凭据目录。

## 本机 worker 与恢复

本机 Runner 在发送任务内容前，将实际 fork 的 worker 加入随机命名的 Windows Job Object。核验父进程归属，设置 `JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE`，不允许 breakaway；子孙进程继承树约束。辅助进程持有唯一 Job 句柄，Runner 管道断开后关闭句柄，由内核结束任务树。正常完成和取消也收尾该 Job，不按同名进程或可疑 PID 终止其他实例。

私有 `local-executions` v2 记录主机、平台、owner/worker PID及内核创建时点、Job 名称、任务和租约。启动恢复须证明原身份不再运行、Job 活跃进程为零、任务/租约匹配。存在同PID但创建时点不同的进程不冒充原执行者；Windows退出句柄可能仍可查询，判断同时核验退出时间。

满足条件后仅记录中断并转 blocked；有用户取消意图则保留/转 cancelled。调查证据与业务台账保留，旧租约/授权清除，不自动重发创建、提交、占用或业务查询。丢回执仍按原对账契约确认实际业务状态，再显式接续或清理；进程退出不证明业务未生效。

旧 Windows v1 登记没有 Job/创建时点证明，不能靠升级倒推整树退出。远端 Runner、主机不符、错误租约、探测拒绝或未知子进程仍保持隔离，需运维按保存证据核对。cancelled 任务不会被升级或恢复入口重新领取。POSIX 进程组机制保留。

退出过渡态或PID已被受保护进程复用时，OpenProcess可能拒绝查询。probe按owner/worker/job返回具体Win32错误；恢复按登记返回`WINDOWS_PROCESS_PROOF_UNAVAILABLE`，辅助进程无法启动则返回`WINDOWS_PROBE_HELPER_UNAVAILABLE`。该记录的状态与租约保留，local启动写警告后继续服务其他任务，不把拒绝当作进程不存在，也不因一条未知登记让整个控制面无法启动。解除条件是再次取得可靠归属/退出证明或由运维核对，不能手工改任务或静默放行。

微软接口约束：[CreateFile](https://learn.microsoft.com/en-us/windows/win32/api/fileapi/nf-fileapi-createfilew)、[Job 绑定](https://learn.microsoft.com/en-us/windows/win32/api/jobapi2/nf-jobapi2-assignprocesstojobobject)、[嵌套 Job](https://learn.microsoft.com/en-us/windows/win32/procthread/nested-jobs)、[AppContainer双重检查](https://learn.microsoft.com/en-us/windows/win32/secauthz/implementing-an-appcontainer)。Chromium能力来源见[网络目录授权](https://chromium.googlesource.com/chromium/src/+/refs/heads/main/content/browser/network_sandbox.cc)及[默认能力名](https://chromium.googlesource.com/chromium/src/+/lkgr/content/public/browser/content_browser_client.cc)。接口说明不替代本机运行证据。

## 排查与验证

锁异常先查看底层 Win32/PowerShell 诊断，核对普通目录及活跃持有者。恢复拒绝时检查 v2 元数据、创建时点、活跃数及租约，不强删锁或凭年龄重置任务。ACL 异常核对身份与 DACL，不提升权限或授予 Users 写权消除错误。

### 控制面状态替换

Windows 文件读取者可能暂时禁止删除共享，令状态库的同目录原子替换返回 `EPERM`。1.53.1 在原事务队列内对暂时性共享错误短暂退避，并重试同一个临时文件的替换。事务逻辑只运行一次，旧文件在替换成功前保持完整。持续拒绝仍上报原错误，可核对文件占用和 ACL。该重试只作用于单次文件提交。

原生回归使用独立 Windows 进程持有临时测试状态的读取句柄。1.53.0 复现 `EPERM`，修复后核对旧内容在占用时仍可读，释放句柄后新状态仅提交一次。

维护脚本及测试用 fileURLToPath 转换文件 URL，CLI 文件仍受相对目录约束；SQLite 在删除临时目录前关闭。macOS/POSIX 路径逻辑模拟与目标平台权限集成分开记录。Windows 使用真实 directory junction 验证越界拒绝，文件 worker 用真实标准流转发的原生测试夹具；固定输出不计模型验收。

隔离入口：`scripts/verify-windows-runner.mjs` 使用真实控制面/AgentRunner/worker，受控中断本轮自身 Runner；`verify-windows-evidence.mjs` 使用真实规划模型/持久会话/MySQL工具，仅由隔离环境供给 SELECT-only 凭据；既有 `verify-requirement-chain.mjs` 完成库存工具、清理及15表报告，飞书传输模拟。每项绑定源码指纹、配置模型和人工干预，不能混称真实群或TPM业务验收。

在新证据父目录先运行`node scripts/freeze-verification-source.mjs <证据父目录>/source-freeze.json`；两个Windows模型入口各使用其下新的空子目录，避免覆盖旧证据。MySQL入口要求本轮专用回环端口`AGENTOS_TEST_MYSQL_PORT`，不能指向真实业务库。完成后以同一命令加`--verify`回查；已有冻结不同则拒绝覆盖，另开验证目录并按影响重跑。模型使用实际本机配置，固定计划和原生可执行夹具只计模块证据。

冻结清单表示实际运行的文件字节。Git文本行尾规范化可能使仓库blob、Windows工作区和归档的原始哈希不同；交付回执分别记录运行字节与Git规范化指纹，并核验除行尾外无内容变化。使用源码ZIP时核对包及清单；从Git重新检出时按实际文件另建冻结，不能将行尾转换误报为已验证的相同字节。

操作发现仍动态执行。`test_register`现将既有操作名规则同步到共享Schema：字母开头，后续字母/数字/下划线/连字符，至少两字符，例如`inventory_get`。点号仍按原实现拒绝，但现在直接定位`$.args.name`，无需反复猜字段；业务payload仍为开放字段。会话并发回归等待真实送达回执，测试失败时先释放阻塞再关闭服务，不依赖固定短sleep；单项测试防挂起超时不进入AgentOS任务策略。
