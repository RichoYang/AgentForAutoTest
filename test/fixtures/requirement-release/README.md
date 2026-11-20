# 需求测试发布验收夹具

三个 JSON 文件是原隔离场景的「测试场景」表。原生脚本通过指定用例入口读取原行及顺序，每次创建新的合成 Job。实际计划、断言、清理、报告和结论来自正常 Runner 与本机配置的模型。

使用项目 Node 22，从冻结产物目录启动。为每轮设置新的私有 `AGENTOS_RELEASE_FIXTURE_DIR`，仅在 `127.0.0.1:23410` 启动专用 MySQL 5.7，服务器数据目录为该证据目录下的 `mysql/data`。脚本核对服务器版本和数据目录后才建合成库，结束时清理临时库和账号。需要已配置的 Codex 模型和本地需求测试 Skill。

对 `holdout6`、`negative6`、`wide6` 分别运行 `node test/fixtures/requirement-release/native.mjs <场景> native-<场景>`。再运行 `node test/fixtures/requirement-release/audit.mjs native-<场景>`，审计读取证据目录上一级的冻结产物清单。保留两条命令的实际退出码、场景审计、报告和回执。缺少独立审计的档案用例必须如实未执行或阻断，其后的独立索引用例须正式通过。
