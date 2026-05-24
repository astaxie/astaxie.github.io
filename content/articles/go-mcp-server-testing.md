---
slug: go-mcp-server-testing
url: /notes/go-mcp-server-testing/
title: Go 里实现 MCP Server 的接口设计和测试策略
summary: 梳理 MCP Server 的资源、工具、错误语义和契约测试。
categoryKey: mcp
category: MCP
categoryLabel: MCP 与工具协议
source: NOTES/MCP
date: 2026-04-12
image: /assets/article-visuals/go-mcp-server-testing.svg
tags:
  - Go
  - MCP
---

![标题图](/assets/article-visuals/go-mcp-server-testing.svg)

## 问题背景

用 Go 写一个 MCP Server，最容易低估的不是协议本身，而是“协议看起来能跑”和“工程上可以长期维护”之间的距离。一个 demo 里，我们写几个 handler，收到 `tools/call` 就执行函数，收到 `resources/read` 就读文件或查数据库，最后把 JSON 返回给 Host。这个阶段只要模型能看到工具、能调用、能拿到结果，开发者就会觉得已经完成了大部分工作。

真正的问题通常在第二周之后出现。第一个问题是接口边界变模糊：工具 handler 里混着参数校验、权限判断、业务访问、日志、错误映射和返回压缩，代码很快变成一团。第二个问题是错误语义不稳定：同样是读不到资源，有时返回空数组，有时返回内部错误，有时把权限不足包装成 not found，Agent 收到后无法判断该澄清、该重试还是该停止。第三个问题是测试只覆盖 Go 函数，而没有覆盖 MCP 契约。函数测试通过，不代表 Host 看到的工具 schema、资源 URI、错误 code 和返回内容是稳定的。

MCP Server 的质量不只在于能否响应请求，更在于资源、工具和错误语义是否稳定可测。Server 面向的调用方不是一个固定的人类前端，而是 Host、模型、Agent 编排层、权限策略和审计系统的组合。模型会根据工具描述构造参数，Host 会根据资源列表决定上下文入口，编排层会根据错误类型做恢复，审计系统会根据调用记录判断副作用。如果 Server 在这些边界上含糊，就算内部业务代码很稳，整体 Agent 体验也会不稳。

Go 在这里有天然优势：类型系统、接口组合、上下文取消、标准测试工具、race 检查和 benchmark 都很适合做协议服务。但 Go 也容易让人写出“看起来很简洁”的大函数，把 MCP 的多个概念折叠成一个 handler。我的建议是从一开始就把 Server 设计成几个清晰层次：传输层只处理消息收发，协议层只处理方法分发和错误包装，能力注册层维护工具与资源的元数据，执行层实现业务动作，测试层从协议外部验证契约。这样写会比 demo 多一些结构，但后面加工具、换传输、接入审计和做兼容测试时，会省掉很多返工。

还有一个背景是 MCP Server 往往不是单独运行的。它可能被桌面应用加载，也可能跑在远程容器里，也可能作为内部平台的一个插件服务。不同 Host 对超时、日志、资源分页、错误展示和安全策略的处理方式不完全一样。Server 如果只按某一个 Host 的表现调试，很容易把 Host 的容错当成协议正确。最稳的方式是把 Server 自己的契约写清楚，并用自动化测试固定下来：给定初始化请求，应该声明什么能力；给定资源列表请求，应该返回哪些 URI；给定工具参数错误，应该返回哪一类错误；给定上下文取消，handler 是否停止执行。

这篇文章讨论的不是 MCP 全部规范细节，而是 Go 实现时更容易踩坑的接口设计和测试策略。目标是把一个能跑的 MCP Server，改造成可以演进、可以回放、可以被 Agent 稳定使用的工程组件。

## 核心概念

写 MCP Server 时，先把几个概念拆开。Tool 是可执行动作，通常有副作用或至少有计算成本；Resource 是可读取上下文，应该帮助模型理解环境，而不是让模型直接操作系统；Prompt 是可复用的交互模板；Transport 是消息进出的通道；Protocol Handler 是 JSON-RPC 或等价协议方法的分发器；Registry 是能力清单；Executor 是真正做业务的代码。

| 概念 | Go 中建议的边界 | 需要测试的契约 | 常见误区 |
| --- | --- | --- | --- |
| Transport | stdin/stdout、HTTP、SSE 或本地进程连接 | 消息顺序、关闭、超时、并发安全 | 在传输层直接写业务逻辑 |
| Protocol Handler | 解析方法、路由、包装错误、生成响应 | 方法名、错误 code、请求 ID 保留 | 每个方法各写一套错误格式 |
| Registry | 保存工具、资源、提示模板的元数据和版本 | 列表稳定性、schema、URI 模式 | 运行时临时拼 schema |
| Tool Executor | 参数解码、业务执行、结果结构化 | 参数错误、权限错误、幂等性 | 把参数 schema 当文档而不是契约 |
| Resource Reader | URI 解析、读取、分页、内容类型 | 不存在、过大、权限、缓存 | 把资源等同于本地文件路径 |
| Error Mapper | 把内部错误映射成协议错误 | 可恢复性、可展示性、审计字段 | 所有错误都返回 internal |

第一个核心概念是“元数据先于执行”。模型在调用工具之前，看到的是工具名、描述、参数 schema 和可能的资源说明。这个元数据不是装饰，它就是模型构造调用的接口。如果工具描述写得像人类 README，参数 schema 却宽泛到 `map[string]any`，模型就会频繁构造歧义参数。Go 代码可以在运行时做二次校验，但那只是兜底，不能替代清晰 schema。工具注册时应该把名称、版本、输入结构、输出摘要、风险等级和错误类型一起声明出来。

第二个概念是“协议错误和业务错误要分层”。协议错误表示请求无法被 Server 正确处理，例如方法不存在、JSON 无法解析、参数结构不符合 schema。业务错误表示请求结构正确，但业务上无法完成，例如资源不存在、权限不足、上游超时、结果为空、操作冲突。Agent 对这两类错误的处理完全不同。协议错误通常说明 Host 或 Server 版本不兼容；业务错误则可能触发澄清、重试、换资源或向用户解释。

第三个概念是“资源读取也是接口，不是随手读文件”。Resource 的 URI、内容类型、大小限制、分页方式和缓存语义，都影响模型上下文质量。一个 `file://` 风格的资源如果直接暴露绝对路径，会把本地安全边界、系统差异和隐私问题一起带出去。更好的方式是定义自己的稳定 URI，比如 `repo://current/README.md`、`issue://project/123`、`trace://run/abc/summary`，由 Resource Reader 在内部映射到实际存储。

第四个概念是“测试对象应该是协议行为”。Go 单元测试当然要写，但 MCP Server 最重要的测试不是某个函数是否返回 `nil`，而是外部调用方能否看到稳定的能力列表、稳定的错误语义和稳定的返回结构。也就是说，测试应当能像 Host 一样发请求，从响应里检查字段，而不是只测私有函数。内部函数可以重构，协议契约不能随便变。

第五个概念是“可观测性是测试的延伸”。如果测试只在 CI 里证明一次，而线上无法记录请求方法、工具名、资源 URI、错误类型、耗时和上下文取消情况，那么失败样本就很难回收。一个好用的 MCP Server 应该把每次工具调用和资源读取都变成可回放的事件。回放不一定重新执行副作用，但至少能重建当时的输入、Server 版本、能力元数据和错误映射结果。

## 架构/流程图解说明

一个适合 Go 的 MCP Server 结构可以分成五层。最外层是 transport，负责从 stdin、HTTP 或其他连接读取消息。再往内是 protocol router，负责把方法名分发到对应处理器。第三层是 registry，提供工具、资源和提示模板清单。第四层是 adapter，完成参数解码、权限检查、上下文注入和错误映射。最里面才是业务服务。

```text
Host / Client
  |
  | initialize, tools/list, tools/call, resources/list, resources/read
  v
Transport
  | 读取消息、写入响应、处理连接关闭
  v
Protocol Router
  | 方法分发、请求 ID、协议错误
  v
Capability Registry
  | 工具元数据、资源模式、schema、版本
  v
Execution Adapter
  | 参数解码、权限、限流、超时、错误映射、trace
  v
Domain Services
  | Git、文件、数据库、工单、知识库、内部 API
```

初始化流程要尽量保守。Host 发起 `initialize` 后，Server 返回协议版本、能力声明和 Server 信息。这里不要返回需要昂贵计算的动态内容，也不要在初始化时尝试访问所有上游系统。初始化应该证明 Server 可通信，而不是证明所有业务依赖都健康。真正的依赖健康可以通过资源或工具的具体调用体现，也可以暴露一个只读诊断资源。

工具调用流程可以这样理解：Host 先通过 `tools/list` 获取工具元数据，模型根据元数据生成 `tools/call` 参数，Server 收到后通过 registry 找到工具定义，再用 schema 或 Go 类型解码参数。解码成功后，adapter 设置超时和 trace，把调用交给 executor。executor 返回结构化结果或业务错误，adapter 把它映射成协议响应。

资源读取流程与工具不同。资源不是动作入口，而是上下文入口。`resources/list` 应该返回可发现的资源或资源模板，`resources/read` 根据 URI 读取内容。对于动态资源，不一定要一次列出全部实例，可以列出模板或分页入口。比如一个代码仓库 Server 不应该在资源列表里塞进十万文件，而应该提供 `repo://current/tree?depth=2` 和 `repo://current/file/{path}` 这类可控入口。

错误流程要单独画出来，因为它决定 Agent 的恢复能力。

```text
内部错误
  |
  | errors.Is / errors.As 分类
  v
Domain Error
  | NotFound / PermissionDenied / InvalidInput / Conflict / Timeout / Unavailable
  v
MCP Error Response
  | code、message、data.reason、data.retryable、data.safeForUser
  v
Agent Recovery
  | 澄清、重试、换资源、请求权限、停止并解释
```

这个流程的关键点是不要让内部错误字符串直接成为协议语义。Go 里的错误可以保留上下文，例如 `fmt.Errorf("read repo config: %w", err)`，但映射到 MCP 响应时要稳定。日志里可以有详细调用栈，返回给 Host 的错误应该是可以被机器判断的类型。

## 工程实现

我更倾向从一个小的能力注册表开始，而不是先写一堆 handler。注册表不是为了炫技抽象，而是为了让工具元数据和执行函数绑定在一起，避免 schema 在一个文件、handler 在另一个文件、测试再手写第三份预期。下面是一个简化的数据结构，省略了具体 JSON Schema 构建细节，但保留了边界。

```go
type ToolSpec struct {
	Name        string
	Title       string
	Description string
	Version     string
	InputSchema json.RawMessage
	Risk        RiskLevel
	Handler     ToolHandler
}

type ToolHandler interface {
	Call(ctx context.Context, req ToolRequest) (ToolResult, error)
}

type ToolRequest struct {
	Name      string
	RawInput  json.RawMessage
	Actor     Actor
	RunID     string
	RequestID string
}

type ToolResult struct {
	Content []ContentBlock
	Meta    map[string]any
}

type Registry struct {
	tools     map[string]ToolSpec
	resources map[string]ResourceSpec
}
```

这里有几个细节。`InputSchema` 放在 `ToolSpec` 里，测试可以直接从 registry 取出并做 golden 比对。`Handler` 接收 `RawInput`，但具体工具内部应该尽快解码到强类型结构。`Actor`、`RunID` 和 `RequestID` 不应该从全局变量里取，而应该由 adapter 放进请求对象，方便测试和审计。`Risk` 不是 MCP 协议必须字段，但在工程里很有用，可以用于 Host 侧展示、策略配置和测试分类。

具体工具可以这样写：

```go
type ReadFileInput struct {
	Path string `json:"path"`
	MaxBytes int `json:"maxBytes,omitempty"`
}

type ReadFileTool struct {
	fs FileService
}

func (t ReadFileTool) Call(ctx context.Context, req ToolRequest) (ToolResult, error) {
	var input ReadFileInput
	if err := decodeStrict(req.RawInput, &input); err != nil {
		return ToolResult{}, NewInvalidInput("invalid read_file input", err)
	}
	if input.Path == "" {
		return ToolResult{}, NewInvalidInput("path is required", nil)
	}
	if input.MaxBytes <= 0 || input.MaxBytes > 256*1024 {
		input.MaxBytes = 64 * 1024
	}
	data, err := t.fs.Read(ctx, req.Actor, input.Path, input.MaxBytes)
	if err != nil {
		return ToolResult{}, err
	}
	return ToolResult{
		Content: []ContentBlock{{Type: "text", Text: string(data)}},
		Meta: map[string]any{"path": input.Path, "bytes": len(data)},
	}, nil
}
```

这个例子里，严格解码很重要。Go 默认的 `json.Decoder` 如果不设置 `DisallowUnknownFields`，模型多传一个字段可能悄悄被忽略。短期看很宽容，长期看会让调用方误以为字段有效。对于 MCP 工具，我更喜欢默认严格，只有明确需要兼容旧客户端时才允许额外字段，并把兼容行为写进测试。

错误类型可以用小而稳定的结构表示：

```go
type Kind string

const (
	KindInvalidInput      Kind = "invalid_input"
	KindNotFound          Kind = "not_found"
	KindPermissionDenied  Kind = "permission_denied"
	KindConflict          Kind = "conflict"
	KindTimeout           Kind = "timeout"
	KindUnavailable       Kind = "unavailable"
	KindInternal          Kind = "internal"
)

type AppError struct {
	Kind      Kind
	Message   string
	Cause     error
	Retryable bool
}

func (e *AppError) Error() string {
	if e.Cause == nil {
		return e.Message
	}
	return e.Message + ": " + e.Cause.Error()
}
```

协议层不要把 `AppError.Error()` 直接返回给用户。更稳的做法是映射成一个固定 envelope：`message` 用于展示，`data.kind` 用于机器判断，`data.retryable` 用于恢复策略，详细 cause 只进日志。测试也应该锁定这个 envelope，而不是锁定内部错误字符串。内部错误字符串包含路径、SQL、上游响应时，一旦被 golden 固定，后面重构会很痛苦；如果直接暴露给 Host，又可能泄漏敏感信息。

资源实现也要有注册表。下面这个结构把 URI 模式、内容类型和读取函数放在一起：

```go
type ResourceSpec struct {
	Pattern     string
	Name        string
	Description string
	MimeTypes   []string
	Reader      ResourceReader
}

type ResourceReader interface {
	Read(ctx context.Context, req ResourceRequest) (ResourceResult, error)
}

type ResourceRequest struct {
	URI       string
	Actor     Actor
	RequestID string
	MaxBytes  int
}
```

资源 URI 解析不要散落在业务代码里。可以给每个 `ResourceSpec` 一个 parser，把 `repo://current/file/docs/api.md` 解析成 `{repo:"current", path:"docs/api.md"}`。这样测试能单独覆盖 URI 规则，也能防止路径穿越。尤其是本地文件资源，必须测试 `../`、软链接、大小写路径、空路径和 URL 编码后的危险片段。

并发模型也要提前定。MCP Server 可能同时处理多个请求。Go handler 本身容易并发，但 registry、缓存、上游 client、临时文件和全局配置未必安全。我的经验是 registry 初始化后只读；每次请求创建独立上下文；共享 client 必须确认并发安全；短期缓存要有租户或 actor 维度；工具执行如果有副作用，需要幂等键或互斥锁。不要依赖“当前 Host 好像串行调用”这个假设，因为一旦换 Host 或引入远程连接，隐含顺序就会失效。

为了让测试更干净，业务依赖要用接口隔离，但接口不要过度抽象。比如文件服务可以定义 `Read(ctx, actor, path, maxBytes)`，Git 服务可以定义 `Diff(ctx, repo, base, head)`，工单服务可以定义 `GetIssue(ctx, id)`。不要把所有依赖塞进一个巨大的 `Backend`，否则测试替身会越来越像第二套系统。每个工具依赖它真正需要的服务，测试时也只构造对应 fake。

接口演进要有明确规则。MCP Server 一旦被多个 Host 使用，工具名、参数字段、资源 URI 和错误类型就不再是内部实现细节。新增可选字段通常安全，删除字段、修改字段含义、改变默认值、调整错误分类都可能让旧 Agent 运行路径变化。我的做法是给 registry 增加一个能力版本快照，每次发布时把快照写入测试数据，review 时可以看到协议层变化，而不是只看到 Go 代码变化。

| 变更类型 | 风险 | 推荐处理 |
| --- | --- | --- |
| 新增工具 | 中等 | 默认不进入高风险任务候选，先加评测样本 |
| 工具改名 | 高 | 保留旧名一段时间，内部转发到新 handler |
| 新增可选参数 | 低 | schema 标注默认值，handler 保持旧行为 |
| 修改参数语义 | 高 | 新增字段或新工具，不静默复用旧字段 |
| 错误分类变化 | 高 | 增加回放测试，确认 Agent 恢复路径仍正确 |
| 资源 URI 迁移 | 高 | 支持旧 URI 重定向，并记录弃用日志 |

如果某个工具真的需要重大升级，我更愿意发布 `search_issues_v2` 这类新工具，再通过 Host 侧能力选择逐步切流，而不是让旧工具在同名下改变行为。名字里带版本不是最优雅，但对 Agent 系统很实用，因为模型上下文、线上 trace、评测样本和用户文档都能明确区分新旧契约。等旧版本调用量降下来，再把旧工具标记为 deprecated，并在 `tools/list` 描述里提示迁移方向。

返回数据也需要设计边界。Tool Result 里不要随意塞原始上游响应，因为上游字段通常过多、含义不稳定，还可能包含敏感信息。更好的做法是定义面向 Agent 的结果结构：先给一段人类可读摘要，再给少量机器可读元数据，最后给可引用的证据块。比如查询工单工具返回“命中三条未关闭缺陷”，同时给出工单 ID、状态、更新时间和摘要，不要把完整工单 JSON 原样丢给模型。这样既节省上下文，也让测试可以锁定真正重要的字段。

这些边界看起来偏繁琐，但它们会直接影响排障速度。接口越窄，失败时越容易判断责任位置；返回越结构化，评测越容易比较差异；版本越明确，回放越不容易被当前实现污染。

## 测试评测

MCP Server 的测试应该分层。底层测纯函数和 URI parser，中层测工具 executor，上层测协议请求响应，最后再做端到端契约测试。不要只选一种测试，因为它们发现的问题不同。

| 测试类型 | 目标 | 例子 | 失败说明 |
| --- | --- | --- | --- |
| 单元测试 | 函数和小组件行为 | URI parser、strict decoder、错误映射 | 实现细节或边界条件错误 |
| 工具测试 | 单个工具的输入输出 | `read_file` 限制大小、权限不足 | 业务行为不符合工具契约 |
| 资源测试 | URI、内容类型、分页 | `repo://current/file/x` 读取 | 上下文入口不稳定 |
| 协议测试 | Host 视角请求响应 | `tools/list`、`tools/call` JSON | 外部契约漂移 |
| Golden 测试 | 稳定元数据 | 工具 schema、资源列表摘要 | 无意修改工具描述或字段 |
| Fuzz 测试 | 输入鲁棒性 | 随机 URI、畸形 JSON | panic、路径穿越、解析歧义 |
| Race 测试 | 并发安全 | 并发读资源、并发工具调用 | 数据竞争或共享状态污染 |
| 回放测试 | 线上失败复现 | 固定请求和 fake 上游响应 | 修复后验证不回退 |

一个很实用的协议测试，是直接构造 JSON 请求，通过内存 transport 调用 Server，然后检查响应。这样测试不关心内部 handler 怎么组织，只关心 Host 会看到什么。

```go
func TestToolsCallInvalidInputContract(t *testing.T) {
	srv := newTestServer(t)
	resp := srv.CallJSON(t, `{
		"jsonrpc":"2.0",
		"id": "req-1",
		"method": "tools/call",
		"params": {
			"name": "read_file",
			"arguments": {"unknown": true}
		}
	}`)

	assertJSONPath(t, resp, "$.id", "req-1")
	assertJSONPath(t, resp, "$.error.data.kind", "invalid_input")
	assertJSONPath(t, resp, "$.error.data.retryable", false)
}
```

这个测试看似简单，却能固定几个重要契约：请求 ID 没丢，未知字段不是悄悄忽略，错误分类稳定，重试语义明确。它不会因为内部从 `ReadFileTool` 改成 `FileReaderTool` 而失败，但会在外部行为变化时提醒你。

Golden 测试适合能力列表。`tools/list` 返回的工具描述一旦变化，模型行为就可能变化。描述更清楚是好事，但也要有意识地改。可以把工具名、描述、输入 schema 和输出摘要写成 golden 文件，变更时通过 review 观察差异。注意不要把动态版本号、构建时间或随机排序写进 golden，否则测试会噪声很大。registry 输出要排序，schema 字段也要规范化。

Fuzz 测试特别适合资源 URI。MCP Server 很多安全问题来自“把模型给的字符串当成本地路径或查询语句”。给 URI parser 做 fuzz，可以发现编码、空字节、重复斜杠、超长路径、奇怪 Unicode 和 `..` 组合带来的问题。即使最后工具只在受信环境运行，也应该把资源 URI 当成不可信输入。

并发测试不要等线上暴露。可以在测试里同时发一百个 `resources/read`，让 fake 后端记录访问次数和 actor，配合 `go test -race` 跑。对于有缓存的资源，还要测试不同 actor 之间不会拿到对方缓存。Agent 场景里，多用户、多会话和后台预取很常见，缓存污染会变成非常隐蔽的数据泄漏。

评测还要包含“模型可用性”。这不是要求每次都调真实模型，而是检查工具描述和 schema 是否足够让模型稳定构造参数。可以准备一组自然语言意图，人工写出期望工具和参数，然后让一个离线评测器或轻量模型生成调用，比较工具选择和参数字段。这里的目标不是追求百分百，而是发现描述歧义。比如 `read`、`fetch`、`open` 三个工具同时存在时，模型很容易混淆；把工具改名为 `read_repo_file`、`get_issue_detail`，错误率可能立刻下降。

最后要把线上 trace 变成回归样本。每次出现失败，脱敏保存请求、能力版本、工具参数、资源 URI、错误 envelope 和上游 fake 响应。修复后把它加入回放测试。这样测试集会沿着真实使用不断增长，而不是停留在开发者想得到的几个 happy path。

## 失败模式

第一类失败是 schema 漂移。Go 结构体改了字段名，工具 schema 没改；或者 schema 改了，handler 仍按旧字段解析。模型会根据新 schema 传参，handler 却按旧逻辑执行，结果可能是空值、默认值或错误动作。解决办法是让 schema 尽量从同一个定义生成或在注册时绑定，并用协议测试验证实际解码。

第二类失败是错误语义坍塌。所有错误都返回 internal，Agent 就无法恢复；所有错误都返回 not found，又会掩盖权限问题；超时没有标记 retryable，会让可恢复故障变成用户可见失败。错误分类不需要很多，但必须稳定。至少要区分输入错误、权限、资源不存在、冲突、超时、上游不可用和内部异常。

第三类失败是资源过大。Server 一次性把长文件、完整日志或大量数据库行返回给 Host，模型上下文被撑爆，或者 Host 在渲染时卡死。资源 reader 必须有大小限制、分页、摘要和内容类型。对于大资源，优先返回索引、摘要或片段入口，不要假设 Host 会替你截断。

第四类失败是忽略 `context.Context`。Host 取消请求后，handler 仍在跑外部命令、查数据库或写文件。短任务里看不出来，长任务和并发请求下会堆积资源。所有上游调用都要接收 ctx，循环处理也要定期检查 ctx。测试里可以构造已取消上下文，确认 handler 及时返回。

第五类失败是副作用不可回放。工具执行了写操作，但没有幂等键、dry-run、差异摘要或审计记录。用户问“为什么改了这个文件”时，只能看最终结果，无法还原当时参数。对有副作用的工具，至少要记录调用参数、目标对象、变更摘要、执行者、时间和结果。高风险操作最好提供 `dry_run` 或 preview 工具，把执行和确认拆开。

第六类失败是 registry 动态顺序不稳定。Go map 遍历顺序随机，如果直接把 map 输出成 `tools/list`，golden 测试会抖动，模型看到的工具顺序也会变化。虽然模型不应该依赖顺序，但上下文排序确实会影响选择。能力列表应按名称、优先级或配置顺序稳定排序。

第七类失败是测试替身过于乐观。fake 后端永远成功，永远返回小数据，永远没有权限边界，导致测试覆盖不到真实系统最常见的问题。好的 fake 应该能配置错误、延迟、空结果、大结果和权限差异。否则测试只证明了 happy path，而不是证明 Server 可运营。

## 上线 checklist

- front matter 和站点元数据一致，文章里说的 Server 名称、工具名和资源 URI 与实际实现保持一致。
- `initialize` 响应稳定，不访问昂贵依赖，不暴露本地敏感路径。
- `tools/list` 和 `resources/list` 输出排序稳定，核心字段有 golden 测试。
- 每个工具都有严格参数解码、必填字段校验、大小限制和清晰错误类型。
- 每个资源 URI 都有 parser 测试，覆盖空路径、路径穿越、编码绕过和超长输入。
- 错误 envelope 区分 `invalid_input`、`not_found`、`permission_denied`、`conflict`、`timeout`、`unavailable` 和 `internal`。
- 所有外部调用都传递 `context.Context`，取消和超时有测试覆盖。
- 有副作用工具提供幂等键、差异摘要、dry-run 或确认流程。
- registry 初始化后只读，共享依赖通过 `go test -race` 验证。
- 协议测试从 Host 视角发 JSON 请求，不只测试内部函数。
- 线上记录工具名、资源 URI、请求 ID、actor、耗时、错误类型和结果摘要。
- 失败 trace 可以脱敏进入回放测试，修复后进入回归集。
- 文档列出能力边界，明确哪些操作不会由 Server 自行决策，而由 Host 或 Agent 编排层判断。

## 总结

Go 里实现 MCP Server，真正要守住的是接口契约。Tool 不是普通函数，Resource 不是随手暴露的文件，错误也不是一段字符串。它们共同构成模型、Host、Agent 编排层和审计系统之间的协议边界。边界清楚，Agent 才能稳定选择工具、读取上下文、解释失败和恢复任务。

工程上最有效的做法，是把 Server 拆成 transport、protocol、registry、adapter 和 domain service 几层。注册表固定元数据，adapter 统一参数、权限、错误和 trace，业务服务保持普通 Go 代码。测试从外部协议行为开始，覆盖工具列表、资源读取、错误 envelope、并发、取消、fuzz 和回放。这样即使内部实现不断变化，外部契约仍然可见、可测、可审查。

MCP 的价值在于让能力接入变标准，但标准协议不会自动带来可靠工程。可靠性来自稳定 schema、清晰错误、可控资源、可观测调用和持续增长的评测样本。一个好的 Go MCP Server，应该让模型用起来顺手，让 Host 接起来放心，也让开发者在出问题时能快速复盘并修复。
