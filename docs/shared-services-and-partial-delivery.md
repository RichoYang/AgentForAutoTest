# 共享只读平台与部分文件交付（1.60.0）

## 共享基础平台

同一ESB或日志平台服务多个业务系统，不表示机器人自动获得其它项目权限。已有站点仅登记给一个项目时，另一个项目的工具目录不会展示它；维护者应核对同一实际应用与生产/测试分级，再显式登记目标项目入口。

`node scripts/bind-shared-website.mjs --environments <私有环境文件> --projects <私有项目文件> --source <已有环境ID> --target <新环境ID> --project <目标项目ID> --profile <已绑定机器人profile> --source-environment <目标源码环境ID> --output <独立待审文件>`。

命令仅生成待审文件（0600，不覆盖已有输出），不改运行配置。核对后在实例安全维护窗口只合并新增目标条目，保护期间新增的其它配置；不要整体覆盖旧文件。源入口必须是已审核的website/investigate，目标profile在可信群映射中属于该项目且有管理员配置，目标源码分级必须一致。拒绝覆盖已有目标或复制内联密码/token等值。只保留investigate，不复制其它固定模板；owner映射改为目标profile，凭据继续引用同一应用Keychain条目，不把密码交给模型。sharedReadBinding记录来源环境及配置摘要供维护复核，不自动追随源配置变更。

登记后通过普通catalog/planQuery/verifyApprovedPlan及浏览器网络规则执行；模型不能因此直接请求原项目环境，数据库/源码跨项目边界也保持。站点能登录不等于全部OA实例可见，更不等于可以测试、审批或写业务接口。只读GET定义、日志与业务调用的认证/范围仍逐项核对，不以控制台管理员身份绕过业务鉴权。

## 完整子范围文件先交付

原问题可能同时要求PC权限、移动权限与外部审批角色。某部分证据未取得，不应丢掉其它已完整核实的部分；但未完整核验的文件不能为了交付放行。

模型以reportAssessment.decision=deliver_partial、coverage=incomplete明确提出部分交付，用既有deliverables列出每份文件及其独立完整范围，整体result.outcome保持partial。需handoffGate通过；每份文件有程序核验摘要、完整标记、实际逐行/公式inspection、当前scope/population差异审阅。只允许其它必需输出缺失（required_output）；当前公式、来源、范围、格式等缺陷仍阻断部分交付。原始核心验收目标保持未完成，acceptedReportResult不会把accepted_partial文件当整项完成。

控制面持久化reportPartialDeliverySet与accepted_partial审阅；仅指定且同话题代次、原发起人/目标、原任务绑定与摘要相符的文件进入既有ReportDelivery outbox。文件发送前仍核对真实文件内容摘要，网络/上传失败只重试投递，不重查数据库。整体结果仍显示缺口，不能将未投递写成已投递。完整交付继续原deliver逻辑。

程序inspection在Runner到控制面的传输包括核验状态、绑定、计算审计与populationAudit；控制面不能依赖Runner内临时job副本，也不能让模型伪造或从别的任务搬用证据。旧协议的deliver/revise/needs_review和已验收文件保持兼容；新部分决定需同版本控制面与Runner。

## 运维与验证

测试至少包含两项目绑定、生产/测试拒绝、未绑定profile、原配置保护、内联密钥拒绝；完整部分文件发送、错误公式/范围拒绝、原目标不变绿、原任务/代次隔离、实际CSV读回与投递重试。真实系统读取与群文件投递要另验，不能用模拟证明OA实际角色已查清。

迁移带模块、脚本、配置示例、schema、文档、测试和完整原runtime/data（含审阅/投递凭据及未完成证据），真实凭据仍安全迁移，不进Git。回退须等任务/消息/投递自然空闲并备份，逐一处理新partial审阅/共享绑定再回退，不将新协议任务交旧程序、不回灌旧状态。其它OS及完整私有跨机需要独立测试，未验不能宣称通过。
