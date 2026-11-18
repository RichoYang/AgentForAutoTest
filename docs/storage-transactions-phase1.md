# JSON 状态存储一期验证

本实验基于 AgentOS 1.65.0（`42a109795597985b7e7201a09b3621192a8a0ebf`），交付分支为 `codex/storage-transactions-phase1`。设计对照固定在 `angelaboy0113/agentos` 的 `ec0827e8b50781555d465721953563f205e76a9e`（1.133.12）。

建议采用。800 Job 夹具上，候选的六轮空事务和普通写入中位数均低于基线的六轮，历史兼容对照及完整回归通过。

## 改动与边界

- `JsonStore.transact()` 先排队，调用 `read()` 获得可变副本，再执行操作并调用 `write()`。候选只改 `read()`。当本次快照与缓存对象相同，从该缓存原始 JSON 解析一份独立副本，省掉一次 `structuredClone` 全量复制。回执作用域内的未提交草稿、缺失文件及快照与当前缓存不匹配时，继续使用 `structuredClone`。
- `snapshot()` 和选择器内部借用缓存视图，仓内消费者将其视为只读。事务草稿、`read()` 与 `select()` 的结果可独立修改。`ControlReceipts` 给嵌套事务传入外层草稿，外层成功后统一提交。留存与源码缓存维护仍在原队列中检查状态和执行已登记的操作。
- 实际写入仍生成完整 JSON，以临时文件和原子替换提交。普通写入仍承担编码和提交后解析，Windows 的占用退避继续重试同一份临时文件。缓存按文件元数据失效，进程间并发写入沿用现有约束。
- 本分支沿用原版本号、数据格式及配置。运维步骤无变化，线上实施手册继续描述当前已采用版本。本次分支测量保留在仓内备查。

## 方法

Windows 10 22H2（19045）x64，AMD Ryzen 7 3700X（8 核、16 线程），约 32 GiB 内存，Node 22.23.2。本机 C 盘 NTFS 临时目录，单 Store 顺序执行。固定种子 `0x1652026` 生成 8 Job（84,559 字节）及 800 Job（8,431,259 字节），包含长证据、取消终态、租约及副作用去重。两版使用相同内容，两份 SHA-256 分别为 `5f248b8396a0a3940339f59dd2db2dd6509bf1bc8ae5d28fb9c92465303157e6`、`bd60f62d4710cab600e424dda2850731928680aeb2f58830d38a7c313b7ec4df`。

每次运行覆盖四种工作负载。每组用独立 Store 和初始文件，三轮，每轮预热 5 次、计时 24 次。空事务定位运行中的 Job。写事务每次推进该 Job 的检查点。写后读回在每次写成功后新建 Store 并读取该字段。完整读取从 `read()` 返回的副本中定位运行中的 Job。计时使用 `performance.now()`，p95 取升序样本第 `ceil(0.95*n)` 个。每轮计时后另外探测一次顶层 `structuredClone`、`JSON.parse`、`JSON.stringify` 调用和文件 ID 变化。文件 ID 变化确认实际文件替换次数，物理磁盘刷新次数未测量。基线与候选交替各运行两次，性能测量与回归分开运行。

| 夹具 | 操作 | 基线中位 / p95（ms） | 候选中位 / p95（ms） | 中位变化 |
| --- | --- | ---: | ---: | ---: |
| 8 Job | 空事务 | 1.10 / 1.92 | 0.90 / 1.66 | −18.1% |
| 8 Job | 单 Job 写入 | 3.44 / 4.95 | 2.92 / 4.12 | −15.0% |
| 8 Job | 写入后重开读回 | 4.76 / 6.51 | 3.79 / 5.22 | −20.4% |
| 8 Job | 完整读取 | 0.42 / 0.73 | 0.27 / 0.43 | −34.5% |
| 800 Job | 空事务 | 91.51 / 113.48 | 68.51 / 87.32 | −25.1% |
| 800 Job | 单 Job 写入 | 125.17 / 164.26 | 107.91 / 135.17 | −13.8% |
| 800 Job | 写入后重开读回 | 182.77 / 216.23 | 157.69 / 196.16 | −13.7% |
| 800 Job | 完整读取 | 29.42 / 36.43 | 16.87 / 18.27 | −42.7% |

两版每格各 144 个计时样本。候选各路径每次以一次整份解析替换一次整份对象图复制。空事务均编码一次且替换零次。普通写均编码一次且替换一次，解析从 1 次变为 2 次，包含重开读回时从 2 次变为 3 次。完整读取编码和替换均为零。

800 Job 空事务的六轮中位数，基线为 88.05–97.54 ms，候选为 60.47–70.86 ms。8 Job 单 Job 写入第一次基线和候选分别为 2.78 和 3.13 ms，第二次分别为 3.97 和 2.77 ms。小夹具的空事务和单 Job 写入耗时变化方向随采样批次波动。

## 正确性

相同的 6 项存储契约测试在基线和候选均通过。测试用固定的模拟 ID 和时间比较返回值、原始错误类型、持久化 JSON 及新建 Store 读回。覆盖无租约的取消任务、有效租约、逐例检查点、附件回执、已登记副作用和待恢复记录，包含深层编辑、删除、输入和返回值隔离、回调和编码异常后恢复排队、控制回执嵌套及外部文件替换。旧 JSON 的 `-0`、溢出指数和自有 `__proto__` 字段也纳入对照。

包含 Windows 真实占用句柄、控制回执、留存、需求测试申请和报告投递的定向回归通过 58 项，失败、跳过、取消各 0。Windows 用独立持有者暂时阻止替换，释放前读到旧文件，释放后只执行一次业务回调并读到新文件。

`npm run check` 退出码 0，主测试 863/863，工作台 14/14，失败、跳过、取消各 0，总耗时约 14 分 26 秒。隔离夹具覆盖需求接单、原表顺序、逐例证据、独立断言、恢复清理、15 表报告及附件回执。回环 MySQL 5.7.44 退出后端口无监听。原始日志、输入摘要和每次计时样本保存在 Git 忽略的 `data/storage-transactions-phase1-evidence/`。

## 复跑

从开发分支根目录使用已确认符合 `>=22.13 <23` 的 Node。下列命令在本地临时目录解包基线并保存两组原始样本。

```powershell
$node22 = (Get-Command node.exe).Source
& $node22 --version
$base = '42a109795597985b7e7201a09b3621192a8a0ebf'
$candidate = git rev-parse HEAD
$here = (Get-Location).Path
$out = Join-Path ([IO.Path]::GetTempPath()) ('agentos-store-' + [guid]::NewGuid())
New-Item -ItemType Directory -Path $out | Out-Null
git archive --format=zip --output="$out/baseline.zip" $base
Expand-Archive -LiteralPath "$out/baseline.zip" -DestinationPath "$out/baseline"
$bench = Join-Path $here 'scripts/benchmark-json-store.mjs'
& $node22 $bench "$out/baseline/src/shared/store.js" $base > "$out/baseline.json"
& $node22 $bench "$here/src/shared/store.js" $candidate > "$out/candidate.json"
Copy-Item -LiteralPath 'test/json-store-transactions.test.js' -Destination "$out/baseline/test/"
& $node22 --test "$out/baseline/test/json-store-transactions.test.js"
& $node22 --test test/json-store-transactions.test.js test/windows-reliability.test.js
```

基准脚本使用系统临时目录创建并清理合成状态副本。建议避开全量测试等磁盘和 CPU 密集任务，再将运行顺序反转复核波动。完整回归在开发分支安装锁定依赖后执行 `npm run check`，可提供仓库支持的隔离 MySQL、QA Skill 和报表合成夹具，以覆盖默认跳过的项目。

## 回退与验收边界

在开发分支对 `JsonStore.read()` 的实现提交执行 `git revert` 并复跑存储契约即可回退。相同文件格式可由基线读取，无需回填旧状态。分支结果仅覆盖隔离验证。真实实例性能、业务链路验收和部署属于独立验证。
