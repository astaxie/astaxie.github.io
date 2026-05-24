---
slug: mcp-production-checklist
url: /notes/mcp-production-checklist/
title: MCP 上生产清单
summary: 上线前检查 schema、权限、错误、日志、超时和回滚。
categoryKey: mcp
category: MCP
categoryLabel: MCP 与工具协议
source: NOTES/MCP
date: 2026-03-30
image: /assets/article-visuals/mcp-production-checklist.svg
tags:
  - Production
  - MCP
---

![标题图](/assets/article-visuals/mcp-production-checklist.svg)

## 问题背景

MCP Server 从 demo 到生产，中间差的不是“多写几个工具”。demo 阶段只要模型能调到工具，工具能返回看起来合理的结果，大家就会觉得链路打通了。生产阶段完全不同：用户会给模糊指令，Host 会取消请求，模型会填错参数，外部系统会限流，权限策略会拒绝，日志里会出现敏感内容，返回结果会超长，工具还可能被重复调用。没有一套上线清单，团队很容易把一个能演示的 Server 当成能运营的 Server。

MCP 的风险来自它站在模型和真实系统之间。一个普通查询接口出错，最多返回错误页面；一个工具接口描述不清，模型可能在错误场景下调用它。一个普通后端超时，前端可以提示稍后再试；一个 MCP 工具超时，Agent 可能重试、换工具、或者基于半截结果继续推理。一个普通管理后台按钮需要人点；一个写操作工具如果缺少确认和幂等保护，模型可能在同一任务里触发多次。生产清单要覆盖这些 Agent 特有的行为，而不是照搬普通 HTTP 服务检查项。

我见过最典型的问题，是团队只检查 handler 的成功路径。比如 `create_ticket` 能创建工单，`search_docs` 能检索知识库，`run_query` 能查数据库。上线后才发现：`create_ticket` 被模型重复调用生成三张工单；`search_docs` 返回内部草稿，用户不该看到；`run_query` 在没有时间范围时扫全表；错误 message 把下游 token 打进日志；某个 Host 默认超时十秒，但工具内部要跑三十秒；回滚工具描述后，Host 还缓存旧列表。这些都不是 handler 单元测试能兜住的。

生产清单的价值，是把上线前的隐性假设变成可检查项。工具是否只读？如果有写操作，是否需要用户确认？输入 schema 是否能引导模型填对参数？错误是否可恢复？日志是否脱敏？超时和取消是否传到下游？返回结果是否有证据引用？上线后能否按工具、租户、Host、版本观察失败率？如果需要立刻停用工具，有没有 kill switch？这些问题越早回答，线上事故越少。

这篇文章不是给一个抽象的“最佳实践”列表，而是把 MCP Server 当成一套需要值班、审计、灰度和回滚的生产系统来设计。清单的目标不是增加流程负担，而是让团队在上线前知道自己承担了什么风险，在上线后知道如何定位问题，在出错时知道如何把损害控制在一个小范围内。

## 核心概念

生产级 MCP Server 至少要满足六个性质：契约清晰、权限明确、执行可控、结果可信、行为可观测、变更可回滚。它们对应的不是六份文档，而是代码、配置、测试和运行时能力。

| 性质 | 需要回答的问题 | 主要机制 |
| --- | --- | --- |
| 契约清晰 | 模型如何知道该不该调用、该填什么参数 | 工具描述、JSON Schema、示例、契约测试 |
| 权限明确 | 谁能访问什么资源，写操作谁确认 | scope、tenant policy、人工确认、审计 |
| 执行可控 | 调用会不会无限跑、重复跑、扫全量数据 | 超时、取消、限流、幂等键、预算 |
| 结果可信 | 返回内容是否可解释、可引用、不过量 | 证据引用、脱敏、截断、分页、质量评分 |
| 行为可观测 | 失败时能否定位到具体阶段 | trace、metrics、结构化日志、replay |
| 变更可回滚 | 工具描述或 handler 出错能否快速止血 | feature flag、kill switch、版本注册表 |

契约清晰是第一步。MCP 工具的描述不是给人看的注释，而是给模型使用的接口说明。描述里要写明适用场景、不适用场景、必要参数、结果含义和副作用。Schema 不能只写类型，还要写约束：时间范围最大多少，`limit` 默认多少，枚举值分别代表什么，路径是否允许通配，查询语句是否允许自由 SQL。描述和 schema 越含糊，模型越容易把工具当成万能入口。

权限明确要比普通服务更细。普通 API 的调用方通常是某个用户或服务账号；MCP 调用里还要区分用户意图、Host 身份、Agent 会话、工具风险、资源范围和确认状态。一个用户有仓库读取权限，不等于 Agent 可以把整个仓库内容返回给外部对话；一个用户能创建工单，不等于 Agent 可以不经确认创建高优先级工单。生产清单必须把这些边界写成策略，而不是靠模型“理解”。

执行可控主要处理成本和副作用。工具应该有默认超时、最大结果数、最大扫描范围、并发限制和取消传播。写操作要有幂等键，避免模型重试导致重复提交。高成本查询要要求时间范围或资源范围。任何下游调用都要接受 context cancel，Host 取消后不应继续消耗资源。

结果可信是 MCP 特别重要的一层。模型拿到工具结果后会继续推理，如果结果缺少证据、混入无权限内容或被截断，最终答案会偏。生产工具返回结果时要区分业务数据、证据、warning 和 meta。不要只返回一段长文本让模型自己猜。对可能超长的结果要分页或摘要，对敏感字段要脱敏，对空结果要说明是确实没有还是权限过滤后不可见。

行为可观测决定团队能不能运营。上线后你需要看每个工具的调用量、成功率、参数校验失败率、策略拒绝率、超时率、重试率、结果截断率、平均返回大小、Host 取消率和用户纠错率。只有 HTTP 500 指标是不够的，因为很多 MCP 失败是“调用成功但任务失败”。可观测性要沿着 MCP 协议和工具执行全链路布点。

变更可回滚是最后一道保险。MCP Server 的变更不只是代码变更，还包括工具描述、schema、权限策略、灰度配置、下游凭证和结果格式。生产清单要定义哪类变更可以快速发布，哪类必须灰度，哪类需要安全评审，以及出现异常时是回滚代码、关闭工具、降级策略还是缩小租户范围。

## 架构/流程图解说明

一个生产级 MCP Server 可以用下面的调用流程来检查：

```text
Client Host / Agent
  |
  | initialize, tools/list, tools/call
  v
Protocol Boundary
  |
  | request_id, session_id, host_id, user_id, tenant_id
  v
Schema Validation
  |
  | JSON Schema, semantic validation, default normalization
  v
Policy Decision
  |
  | auth scope, tenant rule, risk level, confirmation state
  v
Execution Guard
  |
  | timeout, cancellation, rate limit, idempotency, budget
  v
Tool Handler
  |
  | downstream APIs, databases, file systems, queues
  v
Result Guard
  |
  | redaction, truncation, evidence, output schema, warnings
  v
Response and Telemetry
  |
  | structured result, trace, metrics, logs, audit, replay sample
```

这张流程图可以直接变成上线检查表。每个工具至少要说清楚自己在哪一步有什么规则。比如 `search_logs` 在 schema validation 阶段要求 `service` 和 `timeRange`；在 policy decision 阶段检查用户是否能看该服务日志；在 execution guard 阶段限制最多查询十五分钟窗口；在 result guard 阶段脱敏 token、手机号、邮箱和内部 IP；在 telemetry 阶段记录扫描字节数和截断状态。

工具生命周期也需要一张图：

```text
draft
  |
  | contract tests + security review
  v
internal
  |
  | internal host dogfood + replay eval
  v
limited_beta
  |
  | selected tenants + dashboards + rollback flag
  v
general_available
  |
  | SLO + on-call + documented changelog
  v
deprecated
  |
  | warning + migration metrics
  v
removed
```

很多团队跳过 `internal` 和 `limited_beta`，直接把工具放进所有 Host 的 `tools/list`。这会让模型立即开始在真实任务中使用工具，而你还没有足够指标判断它是否安全。更稳的方式是先让内部会话使用，收集参数分布和失败原因，再开放给少量租户。对写操作工具，`limited_beta` 阶段尤其重要，因为你需要观察人工确认拒绝率和幂等冲突率。

生产架构中还应该有一个工具控制面。它不一定是复杂后台，可以先是配置文件加热加载，但必须能完成几件事：按租户关闭工具，按 Host 限制工具，调整灰度比例，设置工具风险等级，更新废弃状态，查看 descriptor hash，定位最近变更。没有控制面时，每次止血都要发代码，速度太慢。

## 工程实现

工程实现可以从一份 `ToolSpec` 开始。每个工具除了 handler，还要声明契约、权限、执行限制和结果治理规则。不要让这些信息分散在 README、代码注释和网关配置里。

```go
type ToolSpec struct {
    Name          string
    Title         string
    Description   string
    InputSchema   json.RawMessage
    OutputSchema  json.RawMessage
    Version       string
    Lifecycle     LifecycleState
    Auth          AuthSpec
    Execution     ExecutionSpec
    Result        ResultSpec
    Handler       ToolHandler
}

type AuthSpec struct {
    RequiredScopes []string
    RiskLevel      string
    Confirm        ConfirmationPolicy
    TenantRules    []TenantRule
}

type ExecutionSpec struct {
    Timeout        time.Duration
    MaxConcurrency int
    MaxResultBytes int
    Idempotent     bool
    RequiresKey    bool
    BudgetClass    string
}

type ResultSpec struct {
    RedactionProfile string
    EvidenceRequired bool
    SupportsPaging   bool
    EmptyResultPolicy string
}
```

注册工具时，Server 可以自动生成工具 descriptor、schema hash、默认 metrics 标签和检查项。handler 只负责业务执行，通用中间件负责校验、权限、超时、审计和结果治理。这种结构比在每个 handler 里手写 `if user == nil`、`context.WithTimeout`、`log.Printf` 稳得多。

输入校验要分两层。第一层是 JSON Schema 校验，检查类型、必填、枚举、长度和格式。第二层是语义校验，检查跨字段关系和业务约束。例如 `start` 必须早于 `end`，时间范围不能超过二十四小时，`project_id` 必须属于当前租户，`limit` 不能超过工具配置。Schema 能给模型明确结构，语义校验能保护真实系统。

一个日志查询工具的输入约束可以这样写：

```json
{
  "type": "object",
  "required": ["service", "timeRange", "query"],
  "properties": {
    "service": {
      "type": "string",
      "description": "服务名，必须是当前租户可访问的服务"
    },
    "timeRange": {
      "type": "object",
      "required": ["start", "end"],
      "properties": {
        "start": { "type": "string", "format": "date-time" },
        "end": { "type": "string", "format": "date-time" }
      }
    },
    "query": {
      "type": "string",
      "minLength": 3,
      "maxLength": 200
    },
    "limit": {
      "type": "integer",
      "minimum": 1,
      "maximum": 100,
      "default": 20
    }
  }
}
```

权限策略要返回结构化 decision，而不是布尔值。上线排障时，你需要知道是缺 scope、租户不匹配、风险等级太高、缺少人工确认，还是策略服务不可用。

```json
{
  "decision": "deny",
  "reason": "confirmation_required",
  "risk_level": "write_high",
  "required_scopes": ["ticket.write"],
  "user_message": "创建高优先级工单需要用户确认",
  "retryable": false,
  "recoverable_by_user": true
}
```

写操作工具必须有幂等设计。Agent 可能因为超时或不确定结果而重试，同一个“创建工单”动作不能产生多个工单。幂等键可以由 Host 提供，也可以由 Server 根据会话、工具名、规范化参数和用户确认 ID 计算。handler 在执行前先查幂等记录，如果上一次已经成功，就返回同一个结果；如果上一次仍在进行，返回 `operation_in_progress`；如果上一次失败且可重试，再允许重新执行。

| 工具类型 | 幂等策略 | 例子 |
| --- | --- | --- |
| 只读查询 | 可重复，限制成本 | 搜索文档、读取配置 |
| 创建资源 | 必须有幂等键 | 创建工单、开任务 |
| 更新资源 | 使用版本号或条件更新 | 修改 issue 状态 |
| 删除资源 | 需要确认和软删除优先 | 归档文档、删除缓存 |
| 外部通知 | 记录发送指纹 | 发 Slack、发邮件 |

超时和取消要从协议边界传到下游。不要只在最外层设置超时，然后 handler 内部继续跑数据库查询。Go 服务里可以要求所有 handler 接收 `context.Context`，下游客户端必须使用这个 context。对于不可取消的外部 API，要用短超时和队列隔离，避免 Host 早已放弃，Server 仍然占着资源。

结果治理是上线前必须实现的通用层。返回给模型的数据应该先通过 redactor，按数据类型脱敏；再通过 size guard，检查字节数和条数；再通过 evidence builder，生成可引用证据；最后通过 output schema validator，确保结构稳定。不要让 handler 自己决定是否脱敏，否则不同工具会有不同安全水平。

观测字段要提前设计。每次调用至少记录：`request_id`、`session_id`、`host_id`、`tenant_id`、`user_id_hash`、`tool_name`、`tool_version`、`descriptor_hash`、`input_schema`、`policy_decision`、`duration_ms`、`status`、`error_code`、`retryable`、`result_bytes`、`truncated`、`redacted`、`downstream_count`。敏感参数不要直接写日志，保存脱敏摘要或引用。

最后是 kill switch。每个工具都要能被快速关闭，最好支持按全局、租户、Host、版本四个维度关闭。关闭时不能返回模糊 500，而要返回稳定错误，例如 `tool_temporarily_disabled`，并带上 `retry_after` 和用户可读说明。这样 Agent 可以停止重试，Host 可以提示用户。

运行配置也要按环境分层。开发环境可以使用本地文件和模拟下游，预发环境必须接真实权限系统和审计 sink，生产环境必须启用脱敏、限流和只读默认策略。不要让一个 `MCP_ENV=prod` 控制所有差异，最好把关键策略显式列出来，例如 `allow_write_tools=false`、`audit_required=true`、`redaction_profile=strict`、`max_result_bytes=65536`。这样配置审查时可以逐项确认，而不是猜测环境变量背后到底改变了什么。

一个实用的配置片段可以长这样：

```yaml
tool_defaults:
  timeout_ms: 8000
  max_result_bytes: 65536
  audit_required: true
  redaction_profile: strict
  fail_closed_on_policy_error: true

tools:
  logs.search:
    timeout_ms: 6000
    max_concurrency: 20
    required_scopes: ["logs.read"]
    requires_time_range: true
    max_time_range_minutes: 60
  ticket.create:
    timeout_ms: 10000
    max_concurrency: 5
    required_scopes: ["ticket.write"]
    confirmation: required
    idempotency: required
```

这类配置要被测试读取，而不是只给运行时使用。CI 可以启动一个最小 Server，读取生产配置，检查所有写工具是否有确认、所有高风险工具是否要求审计、所有查询工具是否有限制结果大小。配置本身就是生产契约的一部分，不能等到发布后才发现某个工具忘了开脱敏。

还有一个容易被忽略的实现点是审计写入失败时的策略。低风险只读查询可以在审计系统短暂不可用时继续执行，并把审计事件放入本地队列；高风险写操作则应该 fail closed，因为不能审计就不能证明谁触发了动作。这个选择必须写进 `ToolSpec`，不能由 handler 临时决定。审计队列也要有容量限制和告警，否则审计系统恢复后可能把 Server 拖垮。

## 测试评测

生产清单里的测试要覆盖模型行为、协议行为和业务行为。只跑 handler 单测会漏掉大部分真实问题。我的最低测试组合是：契约测试、策略测试、执行保护测试、结果治理测试、Agent 回放评测和故障注入。

契约测试检查 `tools/list` 暴露的 descriptor 是否符合规范。每个工具都要有非空 description，输入 schema 必须有 required、description、边界约束，输出 schema 必须包含错误和 warning 结构。测试还要检查只读工具是否标明 read only，写工具是否声明确认策略。契约测试的目标是让工具列表本身可治理，而不是一堆随意 JSON。

策略测试用不同用户、租户和 Host 组合跑工具。比如同一个用户在租户 A 可以读服务日志，在租户 B 不可以；内部 Host 可以调用诊断工具，外部 Host 不能；高风险写操作在没有确认时拒绝，在确认过期后仍然拒绝。策略测试要验证 decision 的 reason，而不仅是 allow 或 deny。

执行保护测试关注超时、取消、限流和幂等。可以构造一个慢下游，确认 Host 取消后 handler 收到 context cancellation；构造并发请求，确认超过工具并发上限会返回 `rate_limited`；构造重复创建请求，确认只生成一个资源；构造大范围查询，确认语义校验拒绝。

结果治理测试要准备包含敏感信息的 fixture。比如日志里有 token、邮箱、手机号、身份证样式字符串、内部 IP、数据库连接串。工具返回前必须脱敏，并在 `meta.redacted=true` 中记录。还要测试超长结果是否被截断，截断时是否保留 warning 和分页提示。空结果也要测，避免模型把权限过滤误解为系统没有数据。

Agent 回放评测使用一组真实任务提示，观察模型是否选择正确工具、是否填齐参数、是否在权限拒绝后追问、是否会重复调用写工具。这个评测不需要一开始很大，二三十个高风险样本就能发现很多描述和 schema 问题。每次改工具描述、参数说明或错误 message，都应该跑回放评测。

故障注入是上线前的最后一关。把下游 API 设置为超时、返回 429、返回 malformed JSON、返回部分数据，观察工具是否给出稳定错误；把审计 sink 设置为短暂不可用，观察高风险工具是否 fail closed；把日志系统设置为不可用，观察主流程是否受影响。MCP Server 会接在很多系统之间，不做故障注入，等于把第一次演练留给线上用户。

一组实用的通过标准如下：

| 测试项 | 最低通过标准 |
| --- | --- |
| 契约测试 | 所有工具 descriptor 有 hash，schema 可校验，风险注解完整 |
| 策略测试 | 关键 allow 和 deny 场景都有覆盖，拒绝 reason 稳定 |
| 超时测试 | 工具在配置时间内返回或取消，下游不继续执行 |
| 幂等测试 | 重复写请求不会产生重复资源 |
| 脱敏测试 | 敏感 fixture 不出现在结果和日志明文中 |
| 回放评测 | 高风险样本无错误写操作，无无限重试 |
| 故障注入 | 下游异常返回结构化错误，指标可见 |

## 失败模式

第一种失败是 schema 太宽。参数全是字符串，`query` 可以写任何东西，`target` 没有枚举，`limit` 没有上限。模型在简单任务里也许能填对，但边界任务会把工具当成万能执行器。解决办法是把 schema 写窄，用枚举、长度、格式、required 和语义校验限制输入。

第二种失败是权限只在下游做。Server 认为数据库或 SaaS API 会拒绝越权请求，于是 MCP 层不做策略。问题是模型可能先得到模糊错误，也可能触发下游审计噪音，还可能在错误 message 里暴露资源存在性。MCP 层应该提前做权限裁剪，让工具列表和调用结果都符合当前用户能力。

第三种失败是写操作没有确认和幂等。模型在一次任务中可能因为不确定结果而再次调用，同一工单、同一邮件、同一部署动作被执行多次。写工具必须把确认 ID、幂等键和资源版本纳入执行逻辑，高风险动作默认 fail closed。

第四种失败是错误不可恢复。工具返回“查询失败，请稍后再试”，Agent 无法判断是参数缺失、权限不足、下游限流还是结果过大。生产错误要稳定分类，告诉 Host 和模型是否可重试、是否需要用户补充信息、是否需要刷新工具列表。

第五种失败是日志成为数据泄露面。为了排障把完整参数、完整查询结果、完整用户文本都打进日志，最后日志系统比业务系统更敏感。MCP 日志要默认脱敏，用户 ID 用 hash，参数只保存摘要或安全字段，高风险结果保存引用。

第六种失败是超时只停在表面。Host 已经取消请求，但 Server 下游查询还在跑，甚至继续写入外部系统。所有 handler 和下游客户端都要接受 context，无法取消的操作要隔离到队列，并在响应里明确异步状态。

第七种失败是工具列表没有按上下文裁剪。模型看见自己不能用的工具，就可能尝试调用，导致无意义拒绝和糟糕体验。`tools/list` 应该根据租户、用户、Host、环境和灰度配置返回可用工具，而不是把所有工具都暴露出来。

第八种失败是回滚只能回代码。工具描述改坏了、schema 太激进、某个租户触发异常时，如果只能发版回滚，止血会很慢。生产系统需要 descriptor 开关、策略开关、灰度开关和全局 kill switch。

第九种失败是只看服务健康，不看任务健康。Server 200 率很高，但 Agent 最终答案错误，用户不断纠正。MCP 生产指标要包含任务层信号，比如工具重试率、参数校验失败率、空结果率、截断率、用户反馈和回放评测回退。

第十种失败是把 dry run 当成可选增强。很多写操作在生产前没有预演模式，用户确认界面只能展示模型自己总结的动作，而不是 Server 规范化后的真实操作。正确方式是让高风险工具先支持 `plan` 或 `dry_run`，返回将要修改的资源、字段差异、影响范围和回滚方式。用户确认的应该是这份规范计划，而不是一句“我将创建工单”。真正执行时再携带确认 ID 和计划 hash，避免确认内容和执行内容不一致。

第十一种失败是没有资源级预算。团队只限制工具 QPS，但不限制一次调用扫描多少数据、返回多少证据、消耗多少下游配额。模型可能用很少的调用次数制造很高成本。生产系统要记录并限制扫描行数、读取文件数、下游请求数、返回字节数和每个会话预算。预算耗尽时返回 `budget_exceeded`，并说明可以缩小范围或让用户授权更高预算。

## 上线 checklist

| 类别 | 检查项 | 通过标准 |
| --- | --- | --- |
| 工具契约 | description 是否写明适用和不适用场景 | 模型评测中不会被明显误选 |
| 工具契约 | input schema 是否有 required、枚举、长度、格式和默认值 | CI schema 校验通过 |
| 工具契约 | output 是否分出 data、evidence、warnings、meta | 输出契约测试通过 |
| 权限 | 每个工具是否声明 scope 和风险等级 | 工具注册表中无空权限 |
| 权限 | 写操作是否需要确认 | 高风险写工具无确认不可执行 |
| 权限 | tools/list 是否按上下文裁剪 | 不可用工具不会暴露给该会话 |
| 执行 | 是否有超时、取消、并发和结果大小限制 | 故障测试可观测且可恢复 |
| 执行 | 写操作是否有幂等键 | 重复调用不产生重复副作用 |
| 结果 | 是否统一脱敏 | 敏感 fixture 不出现在结果和日志 |
| 结果 | 超长结果是否分页或截断带 warning | 模型能知道结果不完整 |
| 错误 | 错误码是否稳定且结构化 | Host 能区分重试、追问、授权和禁用 |
| 观测 | trace、metrics、logs、audit 是否带 request_id | 一次调用可以跨系统串起来 |
| 观测 | 指标是否按工具、版本、租户、Host 拆分 | 灰度对比可用 |
| 发布 | 是否支持灰度和 kill switch | 可按租户或 Host 关闭工具 |
| 回滚 | descriptor、策略、handler 是否能分别回滚 | 不必每次都发代码止血 |
| 文档 | 是否有运行手册和错误码说明 | 值班同学能按手册处理 |

上线前可以按下面流程走一遍：

1. 冻结工具 descriptor，生成 hash，保存 changelog。
2. 跑契约测试、策略测试、结果治理测试和 Agent 回放评测。
3. 开启内部 Host，只允许内部租户调用，观察至少一个工作日。
4. 开启 limited beta，选择低风险租户，设置独立仪表盘。
5. 检查调用量、失败率、拒绝率、超时率、重试率、截断率和用户反馈。
6. 准备回滚动作，包括关闭工具、回退 descriptor、收紧策略和恢复旧 handler。
7. 进入 GA 后把工具纳入值班、周报和版本变更流程。

对于高风险工具，还要额外检查：是否需要双人确认，是否需要审计不可丢，是否要限制工作时间，是否需要强制 dry run，是否要对参数做二次摘要给用户确认，是否需要保留操作前后的资源快照。不要把“模型理解了我的意图”当成授权依据，授权必须来自用户、策略和确认记录。

值班手册也应该在上线前写好。手册不需要很长，但必须覆盖四个动作：如何确认某个工具是否异常，如何按租户或 Host 关闭工具，如何查某次调用的 trace 和审计记录，如何判断是否需要通知用户。没有手册时，事故中大家会先在群里问“这个工具是谁负责”，再找日志，再猜配置，黄金处理时间就过去了。

一个最小手册可以包含这些命令和入口：工具控制面的关闭链接，指标面板链接，按 `request_id` 查询 trace 的方式，按 `tool_name` 查看错误率的方式，审计事件查询条件，最近 descriptor 变更记录，负责人和值班升级路径。尤其要把 kill switch 的影响写清楚，例如关闭 `ticket.create` 会让哪些 Host 看不到工具，正在执行的请求是否会被取消，已创建但未返回的资源如何核对。

上线后第一周不要只看平均值。新工具常见问题会集中在长尾租户、特殊 Host 和模糊提示里。每天抽样查看失败 trace、策略拒绝、空结果和用户纠错，能比仪表盘更早发现描述不清或 schema 过宽。等调用分布稳定后，再把人工抽样频率降下来。

## 总结

MCP 上生产的关键，不是工具数量，而是每个工具是否具备生产边界。一个好用的 MCP Server 应该让模型知道何时调用，让 Server 知道能否执行，让用户知道发生了什么，让团队在失败时知道哪里出了问题。

清单化并不是形式主义。它把 schema、权限、错误、日志、超时、幂等、脱敏、评测、灰度和回滚这些工程问题放到上线前解决。这样 demo 里的能力进入真实环境时，不会因为一次模糊参数、一次重复调用或一次下游超时就变成事故。

我的建议是从第一天就按生产形态写工具：每个工具都有 spec，每次调用都有 trace，每个错误都有 code，每个写操作都有确认和幂等，每次变更都能灰度和回滚。这样 MCP Server 才能从“能被模型调用”升级为“可以长期运营的工具平台”。
