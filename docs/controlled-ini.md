# 需求 Runner 的受控 INI 接入

在 `projects.<id>.requirementTest.environment` 绑定绝对 `iniPath` 和确切的 `resources.<名称>.section`。Runner 校验节名及 `platform`、`environment`，选取该项目的 SIT/UAT 节。允许 `Demo.Sit` 和 `Demo.Sit.Web` 等形式，逐节映射，不按近似名称搜索账号。需要同一套环境兼容另一个称呼时，显式登记 `aliases: ["UAT"]`。别名只接受 SIT/UAT。PRD 在该执行入口没有路由。

## 配置和权限

```ini
[AiPolicy]
sit_access=allowed
destructive_database_operations=explicit_authorization_required

[Demo.Sit.Web]
status=configured
platform=Demo
environment=Sit
resource_type=web_platform
base_url=https://your-sit.example.invalid/
account=your-test-reader
password=replace-locally
account_role=reader
ai_access=allowed
ai_operation_mode=read_only

[Demo.Sit.Db]
status=configured
environment=Sit
resource_type=mysql
host=your-sit-db.example.invalid
port=3306
username=your-test-reader
password=replace-locally
database_name=not_specified
ai_access=allowed
ai_operation_mode=read_only
```

示例项目片段中的 `database` 须由维护者根据资源归属明确指定。配置节已经声明有效库名时，两个值须一致。占位符 `not_specified` 表示尚未确认具体库。直接连接的数据库账号仍须通过服务端权限约束可见范围，尤其是动态只读 SQL。`test_connection` 可返回当前连接库和服务端授权摘要。仅凭服务可达或全局账号登录不能确认业务库归属。

```json
{
  "name": "SIT",
  "aliases": ["UAT"],
  "platform": "Demo",
  "iniPath": "D:/your-private-config/resources.ini",
  "lockKey": "demo-sit",
  "resources": {
    "portal": {"section": "Demo.Sit.Web", "scope": "read"},
    "db": {"section": "Demo.Sit.Db", "scope": "read", "database": "your_verified_sit_database"}
  }
}
```

| 层次 | 生效规则 |
| --- | --- |
| 全局配置 | 存在 `[AiPolicy]` 时须显式 `sit_access=allowed`。配置要求数据库变更有明确授权时，此入口继续提供只读。普通项目绑定不提供逐目标数据库授权 |
| 资源节 | 需要 `status=configured` 和 `ai_access=allowed`，或仅查询的 `allowed_for_query`。需确认、缺失或未知状态按该资源拒绝 |
| 操作交集 | `read_only`、`query_only` 只允许读取。`create_update_read` 允许读、创建和更新。`full_crud` 沿用兼容能力。`allowed_operations`、`delete_access`、`write_access` 可以收窄。开始变更前同时核对恢复权限 |
| 项目和任务 | 项目 `scope` 只收窄权限。发起人、项目、话题、业务键、测量和恢复合同按原 Runner 规则独立校验。实际账号能力由服务端决定 |

自由文本注释、`account_role`、平台清单和 `database_default_mode` 供维护者核对。资源仍须显式声明 `ai_operation_mode`，程序不从这些文字推导额外权限。重复节、重复字段、未知策略、连接字段缺项和未支持协议分别报告。独立可用资源继续出现在模型目录里。`fields` 可把同一个节中的既有字段映射为连接器的 `account`、`username` 或 `password`，如 `{"password":"public_password"}`。每个资源只使用其绑定节。账号、凭据和嵌入认证的 URL 不进入目录。

## 身份、取证和撤权

- `execution.login` 保留单资源用法。Agent 模式可用 `execution.logins.<资源名>` 登记独立登录合同。每个资源使用独立浏览器上下文。可选 `identityProbe` 记录维护者已核实的同源只读身份入口 `path` 及其 `identityFields`。当前身份随工具核验。没有字段合同的登录结果只表示会话建立。
- `test_connection` 读取最小连接信息。HTTP 使用当前绑定入口，MySQL 读取当前身份、连接库及授权摘要，RabbitMQ 只读管理概况和身份，XXLJob 核对配置的 HTTP 入口。具体业务请求仍需现有源码和操作合同。管理接口能力不涉及 AMQP、消费确认和任务触发。[RabbitMQ HTTP API](https://www.rabbitmq.com/docs/http-api-reference)
- 需要管理页面表单认证时，在核实同源登录路径和实际表单字段后登记 `execution.resourceAuth.<资源名>`。例如 `{"kind":"form","path":"/example/login","fields":{"userName":"username","password":"password"}}`。值是同节凭据字段名。会话核验使用已登记的只读入口或经验证的跳转分支。
- 每次使用资源重读绑定节及全局策略。变更、轮换或撤权后，当前任务的旧资源句柄停止使用。项目知识保存可复核的稳定操作线索，新的任务重新连接和读取实时事实。
- `data/requirement-resource-bindings/identity-key.json` 是本机私有的指纹签名材料。它只用于产生不含凭据的版本化资源指纹，应随本机任务状态备份。不可共享或加入 Git。旧指纹无法证明当前凭据一致时，先复核原资源和未决变更，按原恢复流程处理。
- HTTP 及浏览器凭据由执行层注入，授权范围在连接器调用时重新校验。Model 和报告获得脱敏证据。已绑定的 MySQL 库名限制连接选择，动态 SQL 的可见范围同时依赖专属账号的服务端授权。

改配置后，新任务重新加载 INI。升级程序须按实例部署流程另行完成。出现 `environment_config` 时先核对指定节、必填项及有效策略。`environment_scope` 表示当前资源或权限已失效，先按诊断核对原绑定、当前身份和待恢复变更。MongoDB、SAP、SSH 及原生移动端按各自独立连接器或已授权入口处理。
