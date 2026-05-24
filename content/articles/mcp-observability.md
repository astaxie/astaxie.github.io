---
slug: mcp-observability
url: /notes/mcp-observability/
title: MCP Server 可观测性
summary: 协议层 trace 可以让工具调用失败变得可定位。
categoryKey: mcp
category: MCP
categoryLabel: MCP 与工具协议
source: NOTES/MCP
date: 2026-04-01
image: /assets/article-visuals/mcp-observability.svg
tags:
  - Trace
  - MCP
---

![标题图](/assets/article-visuals/mcp-observability.svg)

## 问题背景

MCP Server 刚接起来时，很多失败看起来都像“模型又不稳定了”。用户说“帮我查一下 CI 为什么失败”，Agent 调了工具，工具返回了一段日志，最后答案不对；用户说“读取这个项目的配置”，Agent 调了资源读取，返回空；用户说“修一个文件”，工具调用超时，Agent 又重试了一次，结果状态更乱。没有可观测性时，团队只能在三处猜：模型是不是选错工具，Host 是不是传错参数，Server 是不是执行失败。猜得越久，大家越容易把问题归因到“AI 不可靠”，而不是找到具体哪一层出了错。

传统后端服务的可观测性，主要围绕 HTTP 请求、数据库查询、队列消费和业务错误。MCP Server 多了一层特殊性：它处在模型、Host、工具、外部系统和用户意图之间。一次失败不一定是 500，也可能是工具 schema 误导了模型、参数来自错误上下文、权限策略拒绝但错误不可读、结果太长被截断后丢了关键证据，或者外部数据里有提示注入导致 Agent 解释偏了。这些问题如果只看应用日志，很难定位。

MCP 可观测性的核心，不是把日志打得更多，而是把一次 Agent 工具调用拆成可追踪的事件链。你需要知道：模型当时看到了哪些工具，为什么选择这个工具，传入参数是什么，参数是否通过 schema 校验，Host 是否做了权限确认，Server 执行了哪个 handler，handler 调用了哪些下游系统，返回结果有多大，是否被脱敏或截断，Agent 最后如何使用结果。只有这条链完整，失败才可定位、可复现、可改进。

还有一个容易忽略的事实：MCP Server 的消费者不是固定前端，而是多个 Host 和多个 Agent 编排器。不同 Host 对工具列表裁剪、确认策略、超时、重试、错误展示和上下文注入的行为可能不同。如果 Server 只记录“收到一次 tools/call”，不知道来自哪个 Host、哪个会话、哪个模型运行，就没法解释为什么同一个工具在 A 客户端稳定，在 B 客户端经常失败。可观测性必须把协议上下文作为一等信息，而不是只记录业务 handler。

从工程角度看，MCP 可观测性要服务三类人。第一类是 Server 开发者，他们要定位 handler bug、性能瓶颈和错误语义。第二类是 Agent 工程师，他们要判断工具描述、schema 和结果格式是否让模型选对、填对、解释对。第三类是安全和平台团队，他们要审计工具访问、敏感数据流动和越权尝试。如果只满足第一类，系统会像普通服务一样“有日志”；同时满足三类，系统才真正具备面向 Agent 的可运营能力。

我在生产系统里更愿意把 MCP 可观测性分成四个层次：协议 trace、工具事件、结果治理记录和对话评测回放。协议 trace 解决“请求经过了哪里”；工具事件解决“工具具体做了什么”；结果治理记录解决“返回给模型的东西有没有被处理”；对话评测回放解决“模型拿到结果后为何这样回答”。这四层不是一次性上完，但从第一天就要留好字段，不然后面补链路会非常痛苦。

## 核心概念

MCP Server 可观测性由 trace、metrics、logs、audit 和 replay 五类数据组成。它们不是互相替代的关系，而是从不同角度观察同一次调用。

| 数据类型 | 回答的问题 | 典型字段 | 使用者 |
| --- | --- | --- | --- |
| Trace | 一次调用经过哪些阶段、哪里慢 | span_id、parent_span_id、method、tool、duration | 平台和服务端工程师 |
| Metrics | 系统整体趋势是否异常 | QPS、错误率、P95、拒绝率、截断率 | 运维和团队负责人 |
| Logs | 具体失败的上下文是什么 | error_code、message、sanitized_input、handler | 开发者 |
| Audit | 谁访问了什么，是否合规 | actor、tenant、resource、decision、data_class | 安全和合规 |
| Replay | 失败样本能否复现和评测 | tool_schema_version、input、output_ref、model_context_ref | Agent 工程师 |

Trace 是骨架。一次 MCP 调用可能从 Host 发起 `tools/call`，进入 Server 的协议适配器，然后进入工具路由、参数校验、权限判断、业务执行、结果压缩、审计写入，最后返回给 Host。每一段都应该是一个 span。这样当用户说“工具很慢”时，你能看到慢在模型等待、Host 确认、Server handler、下游 API 还是结果处理，而不是只看到总耗时 12 秒。

Metrics 是仪表盘。你不可能每天逐条看 trace，所以需要聚合指标观察趋势。对 MCP Server 来说，除了常规延迟和错误率，还应该有工具选择相关指标：每个工具的调用量、参数校验失败率、策略拒绝率、空结果率、结果截断率、重试率、Host 取消率、超时率、下游错误率。一个工具突然从每天 20 次变成 2000 次，可能是用户需求增长，也可能是 Agent 陷入循环调用。

Logs 是解释细节。日志要结构化，不能只写自然语言。错误日志里至少要有 `run_id`、`request_id`、`tool_name`、`error_code`、`retryable`、`safe_for_user`、`sanitized_input_ref`。注意是 `sanitized_input_ref`，不是把完整参数无脑打到日志里。MCP 工具经常处理文件内容、数据库结果、邮件、工单、代码和用户文本，日志本身也可能成为敏感数据仓库。

Audit 和普通日志不同。日志主要服务排障，审计服务责任追踪。审计事件要记录 actor、授权来源、数据分类、策略决策、是否人工确认、是否访问敏感资源、是否发生外部写操作。即使业务调用成功，也要写审计。很多安全事故不是异常，而是“系统按设计执行了不该放行的事”。审计必须能证明当时为什么放行。

Replay 是 Agent 系统特有的需求。一次失败的根因可能不在 Server，而在工具描述、schema、上下文裁剪或模型规划。要改进这些问题，需要把失败样本沉淀成可回放数据：当时工具 schema 版本是什么，模型看到了哪些候选工具，调用参数是什么，工具返回了哪些结构化结果，哪些部分被截断，Agent 最后输出了什么。回放不一定要保存敏感原文，可以保存脱敏快照、引用和摘要，但必须能支撑离线评测。

还有两个贯穿概念：相关 ID 和数据分级。相关 ID 让多系统日志能串起来，数据分级决定什么能记录、什么必须脱敏、什么只能存引用。没有相关 ID，trace、日志、审计会散成孤岛；没有数据分级，可观测性会变成新的泄露面。MCP Server 因为接触上下文和工具结果，更要把这两件事从第一版就做好。

## 架构/流程图解说明

一个 MCP Server 的可观测性链路可以画成下面这样：

```text
Host / Agent
  |
  | run_id, request_id, session_id, tool_call_id
  v
MCP Protocol Middleware
  | span: mcp.request
  | 记录 method、client、server_version、schema_version
  v
Capability Router
  | span: mcp.route
  | 记录 tool/resource/prompt 名称和版本
  v
Validation & Policy
  | span: mcp.validation / mcp.policy
  | 记录校验结果、策略决策、确认状态
  v
Tool Handler
  | span: tool.execute
  | 记录下游调用、重试、超时、取消
  v
Result Guard
  | span: result.shape
  | 记录截断、脱敏、字节数、证据引用
  v
Response Writer
  | span: mcp.response
  | 记录状态、错误码、返回大小
  v
Telemetry Exporters
  | traces, metrics, structured logs, audit events, replay samples
```

这个结构里，Protocol Middleware 很关键。很多团队把 trace 埋在 handler 里，结果只能看到业务执行，看不到协议阶段。实际上，`initialize`、`tools/list`、`resources/list`、`resources/read`、`tools/call` 都应该有统一观测。特别是 `tools/list`，它决定模型看到了什么工具。如果工具列表被 Host 裁剪、缓存或版本不一致，后面的调用失败会很难解释。

一次成功的 `tools/call` trace 可以长这样：

```text
mcp.request method=tools/call duration=184ms status=ok
  mcp.route tool=repo.search version=2026-04-01 duration=2ms
  mcp.validation schema_version=7 duration=1ms
  mcp.policy decision=allow risk=L1 duration=3ms
  tool.execute handler=RepoSearch duration=151ms
    downstream.git_grep duration=118ms exit=0
  result.shape rows=12 bytes=6421 truncated=false redacted=false duration=9ms
  audit.write sink=local duration=6ms
```

一次失败 trace 则应该让人快速看到失败点：

```text
mcp.request method=tools/call duration=23ms status=error error_code=invalid_input
  mcp.route tool=db.aggregate version=2026-04-02 duration=1ms
  mcp.validation schema_version=4 duration=2ms status=ok
  mcp.policy decision=deny reason=missing_time_range duration=4ms
  mcp.response safe_for_user=true retryable=false duration=1ms
```

第二个例子说明，失败不一定是异常。策略拒绝是正常业务结果，应该用稳定错误码表达。Agent 看到 `missing_time_range`，可以回去问用户“请给出时间范围”，或者调用目录工具找默认报表周期。如果只返回 500 或一段自然语言，编排层就无法自动恢复。

指标层可以按四个维度组织：

| 维度 | 指标 | 价值 |
| --- | --- | --- |
| 协议 | request_count、request_latency、method_error_rate | 判断 Server 是否健康 |
| 工具 | tool_call_count、tool_latency、tool_error_rate、retry_count | 找出高风险或不稳定工具 |
| 策略 | deny_count、confirm_count、sensitive_access_count | 观察权限和安全边界 |
| 结果 | response_bytes、truncated_count、redacted_count、empty_result_count | 判断上下文质量和数据暴露 |

不要把所有标签都塞进 metrics。`actor_id`、完整资源路径、SQL、文件名这类高基数字段应该进入日志或审计，不应该成为 Prometheus label。指标标签可以保留 `method`、`tool_name`、`server_version`、`host_type`、`status`、`error_code`、`risk_level`。标签过多会让监控系统先被打爆。

## 工程实现

我通常从一个统一的 telemetry envelope 开始。所有 trace、日志、审计和回放都从同一个上下文对象拿字段，避免每个 handler 自己拼。

```go
type CallContext struct {
	RunID        string
	SessionID    string
	RequestID    string
	ToolCallID   string
	Actor        Actor
	Host         HostInfo
	ServerVersion string
	SchemaVersion string
	Method       string
	ToolName     string
	RiskLevel    string
	StartTime    time.Time
}

type TelemetryEvent struct {
	Type       string            `json:"type"`
	RunID      string            `json:"run_id"`
	RequestID  string            `json:"request_id"`
	ToolCallID string            `json:"tool_call_id,omitempty"`
	Method     string            `json:"method"`
	Tool       string            `json:"tool,omitempty"`
	Status     string            `json:"status"`
	ErrorCode  string            `json:"error_code,omitempty"`
	DurationMS int64             `json:"duration_ms"`
	Attrs      map[string]string `json:"attrs,omitempty"`
	Counters   map[string]int64  `json:"counters,omitempty"`
}
```

`RunID` 表示一次 Agent 任务或对话运行，`RequestID` 表示一次协议请求，`ToolCallID` 表示一次具体工具调用。三者不要混用。一个 run 里可能有多次请求，一次请求里通常只有一个工具调用，但某些 Host 或代理层可能会包装批量操作。字段清晰，后面的 trace 聚合才不会乱。

中间件可以这样包住 MCP 方法：

```go
func (s *Server) handle(ctx context.Context, req Request) (Response, error) {
	call := s.newCallContext(ctx, req)
	ctx, span := s.tracer.Start(ctx, "mcp.request",
		attribute.String("mcp.method", req.Method),
		attribute.String("mcp.request_id", call.RequestID),
		attribute.String("mcp.run_id", call.RunID),
		attribute.String("mcp.host", call.Host.Name),
		attribute.String("mcp.server_version", call.ServerVersion),
	)
	defer span.End()

	start := time.Now()
	resp, err := s.router.Dispatch(ctx, call, req)
	event := buildTelemetryEvent(call, resp, err, time.Since(start))
	s.telemetry.Emit(ctx, event)

	if err != nil {
		span.RecordError(err)
		span.SetAttributes(attribute.String("mcp.error_code", stableErrorCode(err)))
	}
	return resp, err
}
```

这段代码背后的原则是：trace 记录链路，event 记录可查询事实，二者都从同一个 `CallContext` 派生。不要在 trace 里放完整参数，也不要在 metric label 里放用户输入。需要排查参数时，写一个脱敏后的 input snapshot，并通过引用关联。

工具 handler 的包装层负责记录工具阶段：

```go
func (r *ToolRunner) Run(ctx context.Context, call CallContext, input json.RawMessage) (ToolResult, error) {
	ctx, span := r.tracer.Start(ctx, "tool.execute",
		attribute.String("mcp.tool", call.ToolName),
		attribute.String("mcp.risk", call.RiskLevel),
	)
	defer span.End()

	decision, err := r.policy.Evaluate(ctx, call, input)
	if err != nil {
		return ToolResult{}, err
	}
	span.SetAttributes(
		attribute.String("mcp.policy.decision", decision.Decision),
		attribute.String("mcp.policy.reason", decision.Reason),
	)
	if decision.Decision == "deny" {
		return ToolResult{}, NewPolicyError(decision.Reason)
	}

	result, err := r.handlers[call.ToolName].Call(ctx, input)
	r.observeResult(ctx, call, result, err)
	return result, err
}
```

这里要注意，策略判断本身也要可观测。很多 MCP 失败不是工具执行失败，而是策略拒绝。拒绝次数上升可能意味着新版本 schema 让模型经常漏传字段，也可能意味着真实越权尝试增加。没有策略指标，你只能看到“工具调用失败率上升”，看不到为什么。

日志建议采用稳定字段，而不是每个 handler 自己写一句话：

```json
{
  "level": "warn",
  "event": "mcp.tool.denied",
  "run_id": "run_7f3c",
  "request_id": "req_91a2",
  "tool_call_id": "tc_12",
  "host": "desktop",
  "method": "tools/call",
  "tool": "db.aggregate",
  "risk": "L2",
  "actor_hash": "u_8c9a",
  "error_code": "missing_time_range",
  "retryable": false,
  "safe_for_user": true,
  "schema_version": "4",
  "server_version": "2026.04.01"
}
```

`actor_hash` 比原始账号更适合进入普通日志。安全团队需要实名时，可以通过审计系统映射。普通应用日志不应该成为人肉查询用户行为的入口。类似地，文件路径、SQL、邮件标题、工单正文都要按数据分类决定是否记录原文、哈希、摘要或引用。

结果治理也要记录。很多排障会停在“工具返回了结果，为什么 Agent 还答错”。答案可能是结果被截断了、排序丢了、长文本被摘要了、敏感字段被脱敏了、空结果没有带原因。Result Guard 应该输出一个小型事件：

```json
{
  "event": "mcp.result.shaped",
  "tool": "repo.search",
  "rows": 12,
  "content_blocks": 3,
  "bytes_before": 18422,
  "bytes_after": 6421,
  "truncated": false,
  "redacted": false,
  "external_text_blocks": 2,
  "evidence_ref": "ev_01HR..."
}
```

这个事件对 Agent 工程师很有用。如果错误答案集中发生在 `truncated=true` 的样本上，就说明工具返回结构或上下文预算要调整。如果 `external_text_blocks` 很多，就要检查提示注入防护和引用标记是否清晰。

## 具体实现例子：一次资源读取失败

假设用户让 Agent “读取当前项目的部署配置”。Agent 调用了 `resources/read`，URI 是 `repo://current/deploy.yaml`，最后返回 not found。没有可观测性时，用户只会看到“文件不存在”。但真正原因可能有五种：Host 没把当前工作区传给 Server；Server 的资源 URI 解析规则不支持根目录；文件名实际是 `deploy.yml`；权限策略禁止读取部署文件；或者 repo reader 在稀疏检出环境里看不到文件。

可观测链路应该把它拆开：

```text
mcp.request method=resources/read uri=repo://current/deploy.yaml status=error
  resource.parse scheme=repo workspace=current path=deploy.yaml status=ok
  resource.resolve workspace_id=ws_42 root=/workspace/app status=ok
  policy.evaluate decision=allow data_class=config status=ok
  resource.read backend=filesystem path_hash=p_ab12 status=not_found
  resource.suggest candidates=deploy.yml,k8s/deploy.yaml status=ok
```

Server 返回给 Host 的错误可以是：

```json
{
  "code": "resource_not_found",
  "message": "未找到 repo://current/deploy.yaml",
  "data": {
    "retryable": false,
    "safe_for_user": true,
    "suggestions": ["repo://current/deploy.yml", "repo://current/k8s/deploy.yaml"]
  }
}
```

这个例子说明，可观测性和产品体验是连在一起的。内部 trace 帮工程师定位，稳定错误码帮 Agent 决策，suggestions 帮用户继续任务。可观测性不是只给 SRE 看的 dashboard，它会直接影响 Agent 的恢复能力。

## 采样、保留期和告警设计

MCP Server 的观测数据不能简单地“全量永久保存”。工具调用里可能包含代码、客户数据、数据库摘要、日志片段和内部路径，保存得越多，排障越方便，数据治理压力也越大。一个可持续的方案要把采样、保留期和访问权限放在同一张表里设计，而不是等数据堆起来以后再补清理任务。

| 数据类别 | 默认采样 | 保留期 | 访问控制 | 备注 |
| --- | --- | --- | --- | --- |
| 聚合指标 | 全量 | 长期 | 团队可见 | 不含高基数字段和敏感原文 |
| Trace 元数据 | 低风险采样，高风险全量 | 7 到 30 天 | 工程团队 | 包含 span 结构和错误码 |
| 普通结构化日志 | 错误全量，成功采样 | 14 到 30 天 | 服务维护者 | 输入输出只存脱敏摘要 |
| 审计事件 | 全量 | 180 天或更久 | 安全和平台授权 | 高风险工具不可采样丢弃 |
| Replay 样本 | 失败和代表性成功样本 | 按评测周期滚动 | Agent 工程师受控访问 | 保存 schema 版本、脱敏输入输出和引用 |

采样策略要按风险和价值分层。只读、低风险、稳定成功的工具可以低比例采样 trace；策略拒绝、权限相关、外部写操作、访问敏感数据、结果截断、模型循环调用这几类事件应该全量保留关键元数据。采样也不能只在请求入口做，因为入口不知道后面是否会失败。更实用的方式是先生成轻量事件，调用结束后根据状态决定是否提升为完整样本。例如成功且低风险的调用只保留指标和少量 span，失败或高风险调用再补写 replay snapshot。

保留期要和用途匹配。排查线上故障通常需要最近几天的细粒度 trace；观察工具质量需要几周的趋势；安全审计可能需要半年以上；离线评测则需要可代表当前 schema 和模型行为的样本。不要把所有数据都塞进同一个日志索引里。短期热数据可以放在检索系统，长期审计事件放在成本更低、权限更严格的存储，replay 样本则应该进入评测仓库或专门的数据集管理流程。

告警设计也要符合 MCP 的语义。普通服务里错误率升高就是告警，但 MCP 里策略拒绝升高未必是坏事，可能是工具开始正确拦截越权请求。更合理的告警要区分“系统不可用”和“安全边界触发”。比如 `tool_error_rate` 升高、`mcp.request` P99 飙升、下游超时增加，应该通知服务维护者；`policy_deny_count` 突然升高、敏感字段访问增加，应该通知平台和安全；`truncated_count` 长期偏高、`empty_result_count` 异常上升，则更像工具设计和 Agent 体验问题，应该进入产品和 Agent 工程队列。

一个告警规则可以保守一点：

```text
系统故障：tools/call P95 > 3s 持续 10 分钟，且 error_code != policy_denied
策略异常：同一 actor_hash 在 5 分钟内触发 20 次 sensitive_access_denied
体验退化：某工具 truncated_count / success_count > 0.3 持续 1 小时
循环调用：同一 run_id 在 3 分钟内调用同一工具超过 8 次且参数相似
审计风险：高风险工具 audit.write 失败一次即告警或拒绝继续执行
```

这里的“参数相似”不需要保存完整原文，可以用规范化后的参数哈希。比如去掉时间戳、排序键和空白后计算 digest。如果同一个 run 反复用相同参数调用搜索工具，通常说明 Agent 没从结果中得到可行动信息，或者错误恢复策略在原地打转。这类问题靠服务错误率看不出来，但会直接浪费上下文、消耗配额，并让用户觉得 Agent 卡住。

最后，观测数据本身也要被观测。exporter 队列长度、丢弃事件数、审计写入延迟、脱敏失败数、采样命中率都应该有指标。否则你以为系统稳定，只是 telemetry 管道已经悄悄丢样本。MCP Server 的可观测性不是在业务旁边加一个日志库，而是一条需要持续维护的数据产品线。

## 测试评测

MCP 可观测性也需要测试。很多团队上线后才发现 trace 缺字段、错误码不稳定、审计事件在异常路径没写、日志里泄露了参数原文。可观测性代码如果没有测试，很快会在重构中退化。

第一类测试是 trace 契约测试。对每个协议方法构造请求，断言至少产生 `mcp.request` span，并包含 `method`、`request_id`、`server_version`、`status`。对 `tools/call`，还要断言包含 `mcp.route`、`mcp.validation`、`tool.execute` 或对应的拒绝 span。测试不需要依赖真实 exporter，可以用内存 exporter 收集 spans。

第二类测试是错误路径测试。可观测性最容易漏在错误路径：schema 校验失败、策略拒绝、handler panic、context canceled、下游超时、结果过大、审计写入失败。每个路径都要断言：返回错误码稳定，span 状态正确，日志没有敏感原文，指标计数增加。特别是 panic，要确保恢复后仍然记录 request_id 和工具名，否则事故发生时最需要的信息会丢。

第三类测试是脱敏测试。准备带有邮箱、手机号、token、SQL、文件路径和用户正文的输入，经过日志和 replay snapshot 后检查输出。这里不要只测一个正则。实际系统里敏感数据可能在 JSON 字段、错误字符串、下游响应、文件内容和工具结果里。脱敏策略要按数据类型做，而不是在最终字符串上临时替换。

第四类测试是指标基数测试。可以在测试里生成一批不同 actor、文件路径和资源 URI 的调用，检查 metrics label 没有包含高基数字段。这个测试很朴素，但能避免监控系统被动态标签拖垮。指标一旦进入生产再改标签，迁移成本很高。

第五类测试是 replay 可用性评测。随机抽取失败样本，确认它能回答三个问题：模型看到了哪个工具 schema，Server 收到了什么脱敏输入，工具返回了什么脱敏输出或错误。然后把这些样本纳入离线评测，修改工具描述或 schema 后重新跑。这样可观测性就不只是事后排障，而会进入持续改进闭环。

一个可执行的验收表可以这样写：

| 测试项 | 通过标准 | 常见问题 |
| --- | --- | --- |
| 成功工具调用 trace | 阶段 span 完整，耗时相加可解释 | 只有 handler span |
| 策略拒绝 | 错误码、策略原因、deny 指标都有 | 被记成 internal error |
| Host 取消 | 返回 canceled，数据库或下游调用停止 | Server 继续后台执行 |
| 结果截断 | `truncated=true`，记录前后字节数 | Agent 不知道结果不完整 |
| 日志脱敏 | 普通日志无 token、邮箱原文 | 失败参数全量落盘 |
| 审计写入 | 高风险工具成功和拒绝都记录 | 只记录成功 |
| Replay 样本 | 可关联 schema、输入、输出和最终答案 | 只有孤立错误日志 |

性能评测也要覆盖 telemetry 自身。可观测性不能让每次工具调用多 200 毫秒。trace 和指标通常可以同步记录，审计和 replay 可以按风险分级：低风险采样，高风险全量；普通日志异步写，关键审计同步写；大结果只存摘要和引用，不把完整内容写入观测系统。这里的目标不是“所有东西都存下来”，而是“关键路径可定位，敏感内容可控制，系统成本可接受”。

## 失败模式

第一类失败是只有日志，没有 trace。表现是能看到某个 handler 报错，但不知道这次调用属于哪个 Agent run，也不知道前面 schema 校验和策略判断发生了什么。修复方式是在协议入口创建统一上下文，并把 run_id、request_id、tool_call_id 贯穿所有层。不要让 handler 自己生成新的随机 ID。

第二类失败是 trace 有了，但字段不可用。比如每个 span 都叫 `call`，没有 method、tool、error_code；或者所有错误都标成 `unknown`。这样的 trace 只能证明系统有埋点，不能用于定位。修复方式是定义字段字典，像 API 契约一样维护观测字段。字段名一旦用于 dashboard 和告警，就不要随意改。

第三类失败是观测系统泄露数据。为了排查方便，把完整工具参数、数据库结果、文件内容、邮件正文都写进日志。这会让可观测性系统变成比原业务库更宽松的数据副本。修复方式是数据分级、脱敏、引用化和权限隔离。默认日志只存哈希、摘要、长度和分类，高风险排查需要有审计的临时授权。

第四类失败是指标标签爆炸。把路径、用户 ID、SQL digest、资源 URI 放进 label，短期看 dashboard 很方便，长期会让时序数据库成本飙升，查询变慢，甚至丢数据。修复方式是限制 label，只保留低基数字段，把高基数字段放日志或审计，并通过 trace ID 关联。

第五类失败是错误语义不稳定。同一种策略拒绝，有时返回 `permission_denied`，有时返回 `invalid_input`，有时返回 500。Agent 无法根据错误恢复，用户看到的解释也不一致。修复方式是建立错误码表，区分可重试、可澄清、需授权、需停止四类，并在测试里固定。

第六类失败是审计和 replay 断链。安全团队能看到某人调用了工具，但看不到工具返回是否被 Agent 用于外部写操作；Agent 团队能看到错误答案，但找不到当时的工具结果。修复方式是让 run_id 从对话开始贯穿到工具调用、结果治理和最终响应。对于外部写工具，还要记录“使用了哪些 evidence_ref 做依据”。

第七类失败是 telemetry 反过来影响业务。同步写远端日志失败导致工具失败，exporter 阻塞导致请求延迟上升，采样配置错误导致关键事故没有样本。修复方式是给 telemetry 明确降级策略：metrics 和 trace 不能阻塞主流程，审计按风险决定同步或异步，高风险审计 sink 不可用时宁可拒绝工具调用，低风险 replay 可以采样丢弃。

## 上线 checklist

- 协议入口统一生成或接收 `run_id`、`session_id`、`request_id`、`tool_call_id`，并贯穿日志、trace、审计和 replay。
- `initialize`、`tools/list`、`tools/call`、`resources/list`、`resources/read` 都有基础 span 和指标。
- 每个工具调用记录工具名、版本、风险等级、schema 版本、Host 类型、状态、错误码和耗时。
- 策略判断、用户确认、权限拒绝、参数校验失败都有独立事件，不被混成 internal error。
- 指标标签只使用低基数字段，不包含用户 ID、完整路径、SQL、URI、自然语言输入。
- 普通日志默认脱敏，敏感内容只存摘要、哈希或引用；审计系统有单独权限控制。
- 结果治理记录返回字节数、行数、content block 数、截断状态、脱敏状态和 evidence_ref。
- 错误码表稳定，标注 `retryable`、`safe_for_user`、`needs_confirmation`、`needs_clarification`。
- context cancellation 能传递到下游调用，取消路径有 trace 和指标。
- 高风险工具审计成功、拒绝、失败三种结果；审计写入失败时有明确降级策略。
- Replay 样本能关联工具 schema 版本、脱敏输入、脱敏输出、错误码和最终回答。
- dashboard 覆盖协议请求量、工具调用量、错误率、P95/P99、拒绝率、截断率、脱敏率、重试率。
- 告警区分系统故障和策略拒绝，避免把正常拒绝当成服务不可用。
- 观测字段有文档和契约测试，重构后不会悄悄丢字段。
- 采样策略按风险分级：低风险采样，高风险全量，敏感内容引用化。

## 总结

MCP Server 的可观测性，不能只照搬普通 Web 服务的几条日志和几个延迟指标。它要看见协议、工具、策略、结果和 Agent 使用结果的全过程。一次工具调用失败，可能发生在模型选择、参数构造、Host 权限、Server handler、下游系统、结果截断或后续推理中的任何一环。没有 trace 和可回放事件，团队只能凭感觉调提示词或改代码。

真正有用的做法，是把 run_id、request_id、tool_call_id 这些相关 ID 先打通，再围绕协议方法和工具阶段建立 span；用 metrics 看趋势，用结构化日志看细节，用 audit 追责任，用 replay 改进工具 schema 和评测。与此同时，要把数据分级和脱敏当成观测系统的基础能力，否则可观测性会制造新的安全问题。

当 MCP Server 的可观测性做好以后，很多“模型不稳定”的问题会变得很具体：这个工具描述让模型误选了，那个参数 schema 缺少必填关系，这次策略拒绝没有给出可澄清错误，某类结果总是被截断，某个 Host 没有传工作区上下文。具体的问题才能被具体修复。协议层 trace 的价值就在这里：它把 Agent 系统里最模糊的部分，变成可以讨论、可以测试、可以持续改进的工程事实。
