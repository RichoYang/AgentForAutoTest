# Windows 基础兼容与异常恢复修复

适用起点：1.50.0 / 52ae9c8；本轮仅源码、隔离验证和提交推送，不部署、不重启、不执行真实业务。原取消任务与历史只读。

| 编号 / 分类 | 已有实现与实际失败证据 | 根因确认 / 必要修改 | 影响路径 / 验证及关闭条件 |
| --- | --- | --- | --- |
| W01 平台缺少兼容实现 | snapshot-lock 用 Python fcntl；起始 source-sync 15、investigation-session 7 失败；旧全量 full-check-ninth.log | 已确认：Windows 无 POSIX flock；保留统一 withSnapshotLock，接 Windows 内核独占句柄，保留底层诊断、路径检查和丢锁中止 | 真实独立 Windows 进程争用/退出/丢锁，临时 Git 缓存版本、GC、调查证据/身份/损坏拒绝；下游22项实际运行 |
| W02 平台缺少恢复证明 | local-executions 的 win32 直接 unsupported；死 owner 回归失败 | 已确认；Windows 进程创建时点及内核 Job Object 约束整棵树，先登记归属再下发任务；恢复只标记中断/阻塞，保留业务对账，不自动重放 | 真实 owner/worker/孙进程、父退出、PID重用边界、租约/主机、cancelled；无整树退出证明不得释放 |
| W03 平台权限能力缺失与测试假设混合 | memory/session/knowledge/browser 仅 chmod；4个 Unix mode 断言失败；本机隔离目录 ACL 实际含 Users 读和 Authenticated Users 修改 | 已确认；Windows 建立当前用户及 SYSTEM 私有受保护 DACL，POSIX 保留0600/0700；写入前及重建校验 | 真 ACL、继承/重建、Chromium登录态及SQLite；只操作隔离目标，不改现有实例/用户主目录/共享凭据目录 |
| W04 测试平台假设 | macOS发现2项在 Windows依赖 X_OK/chmod 及自动发现优先级 | 已确认；分开纯路径逻辑和目标系统执行权限验证 | 显式平台/访问探针逻辑测试通过，Windows真实发现保留；macOS本机集成仍未运行 |
| W05 测试路径契约 | CLI相对文件路径硬编码斜线 | 已确认；用系统路径并验证相对/目录归属 | 真CLI子进程读文件通过，逃逸保护保留 |
| W06 测试资源生命周期 | retention数据库句柄在临时目录删除后才close，Windows EBUSY | 已确认；先关闭SQLite，再清理 | 实际SQLite文件关闭/清理通过，没有无条件重试吞错 |
| W07 测试URL路径 | retention-preview测试将URL.pathname传给Node | 已确认；fileURLToPath | 实际Windows进程预览、数据字节不变、输出无敏感正文 |
| W08 汇总而非独立缺陷 | questions文件级父项随子断言失败 | 确认统计口径；单列父级汇总 | 最终33名称逐项去向，不重复算Bug |
| W09 覆盖缺口 | 4跳过：符号链接权限、IPC退出、文件worker、POSIX CLI | 已逐项核实；补Windows等价验证；POSIX布局与目标系统集成分开 | 真Windows junction越界拒绝、IPC树退出、原生worker及POSIX布局逻辑均通过；最终无跳过，未冒充目标POSIX系统验收 |
| W10 已有参数契约未完整发布 | 本轮库存模型一次提交5个含点操作名；实现合理拒绝，但Schema仅string、错误未定位具体字段 | 已确认；只将既有名称正则作为共享Schema发布并由参数校验返回$.args.name，不放宽或新增操作限制 | 契约模块正反例及新冻结后的真实模型库存链；旧候选/错误保留，不把5条拒绝当5个Bug |
| W11 工程异步验证缺陷 | 第二轮全量会话并发测试固定100次5ms轮询过早断言，后置release hook排在stop后造成8项取消及父汇总 | 已确认；等待实际其他会话送达回执，release先于stop，保留同会话次序/并发断言。30秒仅为此测试防挂起，不是AgentOS任务上限 | 单文件及完整检查实际重跑，保留第二轮失败/取消，新增独立失败须为0 |
| W12 异常恢复的探测拒绝处理 | 第三轮真实Windows树退出探测偶发OpenProcess Access denied，安全拒绝但异常传播会阻止整个local启动 | 已确认；probe按owner/worker/job保留具体错误，恢复逐记录保持原租约/状态并返回blocked诊断，启动记录警告后服务其他任务，不将拒绝当进程不存在 | 真权限拒绝/退出过渡态及正常树恢复；未知时不释放、不重放。新冻结后重跑相关组件、正常Runner和全量 |
| W13 私有权限创建时序缺陷 | 实际FileSystemWatcher捕获文件刚创建时protected=false、存在AU/Users，稍后静态ACL才私有 | 已确认；Windows FileStream/Directory创建时传入私有DACL，文件CreateNew且独占，接收正文前确认创建；已有目标不覆盖，失败只清理已证明由本次创建的临时文件，POSIX原子0600保留 | 真实Windows创建事件时点即protected且无普通用户、精确字节、既有文件保留、目录重建/继承；私有存储/Chromium/正常Runner及全量重验 |

已有 nullAs、evidenceRefs、测量/冻结预期/恢复、页面/API隔离、报告进程隔离全部保留。模型工具拒绝数不等于Bug数；仅有实际通用缺陷才纳入本轮。使用现有隔离业务设施，不新增真实需求项目。

验证层次：根因回归 → 真 Windows Git/进程/ACL/SQLite/必要Chromium → 实际配置模型及正常Runner受影响路径 → 全量/工作台。最终记录源码指纹、模型参数、人工干预、旧33项及4跳过去向、新增/残留。文档和共享Memory增量合并，线上手册权限另记；提交与推送不等于部署。
