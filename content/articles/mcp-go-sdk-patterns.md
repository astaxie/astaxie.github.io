---
slug: mcp-go-sdk-patterns
url: /notes/mcp-go-sdk-patterns/
title: Go MCP SDK 的接口模式
summary: 小接口、显式 context 和可测试 handler 是 Go SDK 的核心。
categoryKey: mcp
category: MCP
categoryLabel: MCP 与工具协议
source: NOTES/MCP
date: 2026-04-05
image: /assets/article-visuals/mcp-go-sdk-patterns.svg
tags:
  - Go SDK
  - MCP
---

![标题图](/assets/article-visuals/mcp-go-sdk-patterns.svg)

## 问题背景

用 Go 写 MCP Server，很容易一开始就写成一个“大框架”。注册工具、处理 JSON-RPC、管理连接、做权限、打日志、调用业务服务、包装错误、做流式返回，全都塞进一个 `Server` 类型里。demo 阶段这种写法速度很快，几百行代码就能跑起来；但工具一多、部署形态一复杂、测试要求一上来，就会发现每个改动都要牵动整条链路。一个工具 handler 想测参数校验，必须启动 Server；一个鉴权策略想测边界，必须模拟传输；一个下游服务想替换成 fake，发现依赖被藏在全局变量里。

Go 的优势不是写出宏大的抽象，而是用小接口把边界切清楚。MCP SDK 尤其适合这种风格。协议层要稳定，业务工具要独立，Host 上下文要显式传递，错误要可判定，测试要能直接调用 handler。SDK 如果把所有事情都藏在反射和魔法注册里，短期少写样板，长期会让工具作者不知道请求从哪里来、权限在哪里校验、日志字段在哪里注入、取消信号是否能传到下游。

MCP 的 Go SDK 设计，我会优先考虑四个工程目标。第一，handler 是普通 Go 函数，能用 `context.Context` 控制生命周期，能在单元测试里直接调用。第二，工具定义和执行逻辑分离，schema、描述、风险等级、权限要求可以被 Host 和文档系统读取。第三，传输层可替换，stdio、HTTP、长连接不应该影响工具业务代码。第四，错误、日志、指标和审计是 SDK 的一等能力，而不是每个工具作者自己拼。

这个问题和普通 Web 框架不完全一样。HTTP handler 的输入输出已经由协议和浏览器生态约束，MCP handler 的调用方通常是模型和 Host。模型会根据 schema 生成参数，Host 会根据策略决定是否调用，Server 要把结果再放回模型上下文。接口设计如果太随意，模型行为会被放大。例如 handler 接收 `map[string]any`，工具作者每次手动断言类型，就会出现字段名拼错、默认值不一致、错误码不统一。再比如 handler 直接返回字符串，后续就很难区分结构化结果、用户展示文本和诊断信息。

Go 社区有一条很朴素的经验：接口应该由使用方定义，越小越好。放到 MCP SDK 里，就是 SDK 不应该逼业务服务实现庞大的生命周期接口，而应该提供几个窄边界：工具注册、请求解码、handler 执行、结果编码、中间件、传输适配。每个边界都可以被测试替换，每个工具都可以独立评测。这样写出来的 SDK 不一定看起来最炫，但会在真实项目里活得久。

## 核心概念

Go MCP SDK 的核心概念可以拆成六个：`ToolSpec`、`Handler`、`Context`、`Middleware`、`Transport`、`Registry`。它们分别回答不同问题。

| 概念 | 责任 | 不该承担的事 | 测试方式 |
| --- | --- | --- | --- |
| `ToolSpec` | 描述工具名称、schema、输出、风险和版本 | 不执行业务逻辑 | 静态契约测试 |
| `Handler` | 接收强类型请求，返回强类型结果或错误 | 不管理连接和注册表 | 直接单元测试 |
| `Context` | 传递取消、deadline、trace、身份、租户 | 不存业务全局状态 | 构造测试上下文 |
| `Middleware` | 做日志、鉴权、限流、指标、恢复 | 不解析具体业务参数 | fake handler 断言 |
| `Transport` | 处理 stdio、HTTP、stream 等 I/O | 不知道工具内部语义 | 端到端协议测试 |
| `Registry` | 管理工具目录、版本、查找和能力暴露 | 不做具体业务调用 | 注册和发现测试 |

`ToolSpec` 是给模型和 Host 看的契约。它不只是 JSON schema，还可以包含风险等级、是否需要确认、是否只读、示例参数、废弃信息。SDK 可以把标准字段序列化给 MCP 客户端，把内部治理字段留给 Host 或观测系统。这样工具作者在一个地方维护语义，不需要在 README、提示词和代码里重复三遍。

`Handler` 应该尽量强类型。Go 没有必要把每个工具都写成 `func(ctx context.Context, args map[string]any) (any, error)`。这个签名虽然通用，但把类型安全和校验都推迟到运行时。更好的模式是泛型 handler：

```go
type Handler[Req any, Res any] interface {
    Handle(ctx context.Context, req Req) (Res, error)
}

type HandlerFunc[Req any, Res any] func(context.Context, Req) (Res, error)

func (f HandlerFunc[Req, Res]) Handle(ctx context.Context, req Req) (Res, error) {
    return f(ctx, req)
}
```

SDK 在协议边界负责把 JSON 参数解码成 `Req`，做 schema 校验，再调用强类型 handler。工具作者拿到的是明确结构体，而不是到处断言 `float64`、`string`、`[]any`。单元测试也可以直接构造 `Req` 调用，不需要走 JSON-RPC。

`context.Context` 要显式贯穿整个调用链。MCP 工具经常会访问文件系统、数据库、HTTP API、向量库、CI 系统，这些调用都可能慢或挂起。Host 取消任务时，Server 必须能及时停止；用户关闭会话时，长任务不能继续在后台乱跑；deadline 到了，handler 应该返回可判定的超时错误。把 context 藏在全局变量里，或者只在传输层使用，都会让取消信号断掉。

中间件是 SDK 保持小核心的关键。鉴权、日志、指标、panic 恢复、参数审计、幂等、确认检查都不应该写死在 handler 里，也不应该让每个工具复制。Go 里可以用函数组合实现中间件，简单直接：

```go
type Middleware[Req any, Res any] func(Handler[Req, Res]) Handler[Req, Res]
```

Transport 则要和业务完全分离。一个工具不应该关心自己是通过 stdio 被桌面 Host 调用，还是通过 HTTP 被远程 Agent 调用。传输层负责读写消息、维护连接、处理协议错误；执行层负责找到工具、解码、跑中间件、调用 handler、编码结果。这个分离会让测试和部署都更简单。

还有一个容易被忽略的概念是结果形态。MCP 工具返回给模型的内容，不应该只有一段字符串。至少要区分结构化数据、用户可读文本、引用资源和诊断元数据。Go SDK 可以把 handler 的强类型 `Res` 映射成标准结果对象，例如 `structuredContent` 给后续工具继续消费，`content` 给模型阅读，`resourceRefs` 指向大文件或日志片段，`diagnostics` 只进 Host 日志。这样做比让每个 handler 手动拼 Markdown 更稳，也能避免大结果无节制进入上下文。

SDK 还要处理工具生命周期。MCP Server 启动时需要注册工具、校验 schema、准备依赖；运行时需要响应能力发现和工具调用；关闭时需要取消长任务、刷完审计日志、关闭下游连接。生命周期接口不宜做成一个庞大的 `Plugin`，可以拆成可选小接口：

```go
type Starter interface {
    Start(ctx context.Context) error
}

type Stopper interface {
    Stop(ctx context.Context) error
}

type HealthChecker interface {
    CheckHealth(ctx context.Context) error
}
```

工具本身通常不需要实现这些接口，持有外部连接的服务实现即可。比如向量库客户端可以实现健康检查，队列消费者可以实现启动和停止，普通只读文件工具不需要生命周期钩子。可选小接口比大接口更符合 Go 的惯用法，也能让应用按需组合。

## 架构/流程图解说明

一个 Go MCP SDK 可以按下面的分层实现：

```text
┌──────────────────────────────────────────────┐
│                MCP Client / Host             │
└──────────────────────┬───────────────────────┘
                       │ JSON-RPC / MCP message
┌──────────────────────▼───────────────────────┐
│ Transport: stdio / HTTP / stream adapter      │
└──────────────────────┬───────────────────────┘
                       │ Request envelope
┌──────────────────────▼───────────────────────┐
│ Protocol Router: method dispatch, version     │
└──────────────────────┬───────────────────────┘
                       │ Tool call request
┌──────────────────────▼───────────────────────┐
│ Executor: registry lookup, decode, middleware │
└──────────────────────┬───────────────────────┘
                       │ Strong typed Req
┌──────────────────────▼───────────────────────┐
│ Tool Handler: business service boundary       │
└──────────────────────┬───────────────────────┘
                       │ Strong typed Res / error
┌──────────────────────▼───────────────────────┐
│ Result Encoder: content, structured, errors   │
└──────────────────────────────────────────────┘
```

这个架构里，`Transport` 不知道有哪些工具，`Handler` 不知道底层连接，`Executor` 是协议和业务之间的窄桥。很多 Go 项目一开始会把 router、registry、handler、transport 写成互相引用的对象，导致任何一层都不能单独测试。上面这种拆法看起来多了几个类型，但每个类型都很小，替换成本低。

一次工具调用的流程可以细化为：

```text
1. Transport 收到 MCP 请求，解析出 method、id、params
2. Router 确认这是 tools/call，并读取 tool name
3. Executor 从 Registry 找到 ToolEntry
4. Executor 用 ToolSpec 的 schema 或 Go 类型解码参数
5. Middleware 链注入 trace、身份、权限、指标和 panic recover
6. Handler 执行业务逻辑，尊重 context 取消和 deadline
7. 错误被归一化为 MCP 错误，结果被编码为结构化 content
8. Transport 把响应写回 Client
```

这里要注意两种上下文。第一种是 Go 的 `context.Context`，用于取消、deadline 和请求级值。第二种是 MCP 会话上下文，比如客户端能力、用户身份、租户、工作区、授权 scope、Host 名称。不要把第二种上下文随便塞满 `context.Value`。可以把身份和 trace 放进 context，但复杂会话状态最好有明确结构，在执行入口组装后传给中间件和 handler。

一个实用的结构是：

```go
type CallContext struct {
    TraceID   string
    UserID    string
    TenantID  string
    Workspace string
    Scopes    []string
    Client    ClientInfo
}

type contextKey struct{}

func WithCallContext(ctx context.Context, cc CallContext) context.Context {
    return context.WithValue(ctx, contextKey{}, cc)
}

func GetCallContext(ctx context.Context) (CallContext, bool) {
    cc, ok := ctx.Value(contextKey{}).(CallContext)
    return cc, ok
}
```

这个结构可以被日志、鉴权和 handler 读取，但不要把数据库连接、缓存客户端、业务服务也塞进去。依赖注入应该通过 struct 字段完成，调用上下文才通过 context 传播。两者混在一起，测试会变得混乱，生命周期也不清楚。

如果把这套分层落到包结构上，我会保持非常直接的布局：

```text
/mcp
  /protocol     JSON-RPC envelope、MCP method、错误编码
  /transport    stdio、http、stream adapter
  /tool         ToolSpec、Registry、Executor、Handler 泛型
  /middleware   auth、logging、metrics、recover、limits
  /schema       Go struct 到 JSON Schema 的辅助和校验
  /testkit      fake transport、golden request、handler harness
```

包结构不需要提前做得很深，但要避免业务工具反向依赖 transport。`tool` 包可以依赖 `protocol` 的少量类型，`transport` 可以依赖 `protocol`，应用层把具体工具注册进去。`testkit` 很重要，它会决定 SDK 是否真的好用。一个好用的 SDK 不只是运行时 API 顺手，测试 API 也应该顺手。

## 工程实现

下面给一个具体实现骨架。先定义工具注册项：

```go
type ToolEntry struct {
    Spec     ToolSpec
    invoker  Invoker
}

type ToolSpec struct {
    Name        string          `json:"name"`
    Description string          `json:"description"`
    InputSchema json.RawMessage `json:"inputSchema"`
    ReadOnly    bool            `json:"readOnly"`
    RiskLevel   string          `json:"riskLevel"`
    Version     string          `json:"version"`
}

type Invoker interface {
    Invoke(ctx context.Context, raw json.RawMessage) (any, error)
}
```

`Invoker` 是类型擦除层。注册时我们仍然保留强类型 handler，执行时由 invoker 负责解码：

```go
type typedInvoker[Req any, Res any] struct {
    handler Handler[Req, Res]
    decode  func(json.RawMessage) (Req, error)
}

func (i typedInvoker[Req, Res]) Invoke(ctx context.Context, raw json.RawMessage) (any, error) {
    req, err := i.decode(raw)
    if err != nil {
        var zero any
        return zero, NewSDKError("INVALID_ARGUMENT", "decode tool arguments", err)
    }
    return i.handler.Handle(ctx, req)
}
```

注册函数可以长这样：

```go
type Registry struct {
    mu    sync.RWMutex
    tools map[string]ToolEntry
}

func Register[Req any, Res any](
    r *Registry,
    spec ToolSpec,
    handler Handler[Req, Res],
    middlewares ...Middleware[Req, Res],
) error {
    if spec.Name == "" {
        return errors.New("tool name is required")
    }
    h := handler
    for i := len(middlewares) - 1; i >= 0; i-- {
        h = middlewares[i](h)
    }
    entry := ToolEntry{
        Spec: spec,
        invoker: typedInvoker[Req, Res]{
            handler: h,
            decode:  DecodeJSON[Req],
        },
    }
    r.mu.Lock()
    defer r.mu.Unlock()
    if _, exists := r.tools[spec.Name]; exists {
        return fmt.Errorf("tool %q already registered", spec.Name)
    }
    r.tools[spec.Name] = entry
    return nil
}
```

这里的一个小取舍是中间件在注册时绑定，而不是每次调用时动态查找。这样执行路径更简单，也方便测试某个工具自己的中间件组合。全局中间件可以在注册辅助函数里统一注入，工具级中间件可以追加。注意中间件应用顺序要稳定，并且文档写清楚，通常日志和 panic recover 在外层，鉴权和限流在业务前，指标记录覆盖全链路。

为了让注册语义更清晰，可以提供 option 模式，但 option 只负责元数据，不要让它变成隐藏控制流。比如：

```go
type ToolOption func(*ToolSpec)

func WithRisk(level string) ToolOption {
    return func(spec *ToolSpec) { spec.RiskLevel = level }
}

func WithReadOnly(readOnly bool) ToolOption {
    return func(spec *ToolSpec) { spec.ReadOnly = readOnly }
}

func WithVersion(version string) ToolOption {
    return func(spec *ToolSpec) { spec.Version = version }
}
```

然后注册工具时语义很直观：

```go
Register(registry, ToolSpec{
    Name:        "repo.read_file",
    Description: "读取当前工作区内的文本文件，返回内容和截断标记。",
    InputSchema: mustSchema[ReadFileRequest](),
}, ReadFileHandler{Repo: repo},
    RequireScope[ReadFileRequest, ReadFileResult]("repo:read"),
    Observe[ReadFileRequest, ReadFileResult](metrics),
)
```

这里我没有把所有东西都塞进 option，是因为显式结构体更容易被代码审查。工具名、描述和 schema 是关键契约，应该在调用点直接看见。option 更适合有默认值的辅助字段。SDK 设计里最怕“看起来少写了几行，实际把语义藏进魔法里”。工具契约要给模型看，也要给人审查，显式是优点。

再看一个具体工具：读取仓库文件。请求和结果都是强类型结构：

```go
type ReadFileRequest struct {
    Path     string `json:"path"`
    MaxBytes int    `json:"max_bytes,omitempty"`
}

type ReadFileResult struct {
    Path      string `json:"path"`
    Content   string `json:"content"`
    Truncated bool   `json:"truncated"`
}

type RepoService interface {
    ReadFile(ctx context.Context, workspace string, path string, maxBytes int) (ReadFileResult, error)
}

type ReadFileHandler struct {
    Repo RepoService
}

func (h ReadFileHandler) Handle(ctx context.Context, req ReadFileRequest) (ReadFileResult, error) {
    cc, ok := GetCallContext(ctx)
    if !ok {
        return ReadFileResult{}, NewSDKError("INTERNAL_ERROR", "missing call context", nil)
    }
    if req.Path == "" {
        return ReadFileResult{}, NewSDKError("MISSING_REQUIRED_ARGUMENT", "path is required", nil)
    }
    if req.MaxBytes <= 0 {
        req.MaxBytes = 64 * 1024
    }
    return h.Repo.ReadFile(ctx, cc.Workspace, req.Path, req.MaxBytes)
}
```

这个 handler 没有接触 JSON-RPC，没有打开连接，没有读全局配置。它的依赖是一个小接口 `RepoService`，测试时可以轻松 fake。`CallContext` 提供工作区边界，`context.Context` 负责取消。这样工具代码保持了 Go 代码应有的直白。

鉴权可以放在中间件里：

```go
func RequireScope[Req any, Res any](scope string) Middleware[Req, Res] {
    return func(next Handler[Req, Res]) Handler[Req, Res] {
        return HandlerFunc[Req, Res](func(ctx context.Context, req Req) (Res, error) {
            cc, ok := GetCallContext(ctx)
            if !ok || !hasScope(cc.Scopes, scope) {
                var zero Res
                return zero, NewSDKError("PERMISSION_DENIED", "missing required scope", nil)
            }
            return next.Handle(ctx, req)
        })
    }
}
```

传输层只需要调用执行器：

```go
type Executor struct {
    Registry *Registry
}

func (e Executor) CallTool(ctx context.Context, name string, raw json.RawMessage) (any, error) {
    entry, ok := e.Registry.Lookup(name)
    if !ok {
        return nil, NewSDKError("TOOL_NOT_FOUND", "tool not found", nil)
    }
    return entry.invoker.Invoke(ctx, raw)
}
```

这段骨架没有追求花哨，但边界清楚。工具作者写结构体和 handler，平台团队维护 registry、executor、transport、middleware。等工具增长到几十个时，这种边界会明显降低维护成本。

结果编码也建议集中处理。不同工具可能返回文本、表格、文件引用、分页游标或结构化对象。如果让每个工具自己决定最终 MCP content，风格会很快分裂。可以让 handler 返回业务结果，再由 SDK 的 `ResultEncoder` 统一转换：

```go
type ResultEnvelope struct {
    Content           []ContentBlock `json:"content"`
    StructuredContent any            `json:"structuredContent,omitempty"`
    IsError           bool           `json:"isError,omitempty"`
    Meta              map[string]any `json:"_meta,omitempty"`
}

type ResultEncoder interface {
    Encode(ctx context.Context, value any) (ResultEnvelope, error)
}
```

默认 encoder 可以把字符串转成文本块，把结构体放进 `structuredContent`，再用简短摘要生成 `content`。大对象要有大小限制，超过阈值时返回引用或截断标记。对于日志和搜索结果，最好返回条目列表和引用 id，而不是一整段拼接文本。这样模型可以基于结构化字段继续调用工具，用户也能看到可读摘要。

还有一个生产中非常关键的点：并发和背压。MCP Server 可能同时处理多个工具调用，某些 Host 还会并行执行只读工具。SDK 应该提供并发限制中间件，按工具、租户或下游资源限流。Go 里最简单的实现是带缓冲 channel：

```go
func LimitConcurrency[Req any, Res any](n int) Middleware[Req, Res] {
    sem := make(chan struct{}, n)
    return func(next Handler[Req, Res]) Handler[Req, Res] {
        return HandlerFunc[Req, Res](func(ctx context.Context, req Req) (Res, error) {
            select {
            case sem <- struct{}{}:
                defer func() { <-sem }()
                return next.Handle(ctx, req)
            case <-ctx.Done():
                var zero Res
                return zero, ctx.Err()
            }
        })
    }
}
```

这个中间件虽然简单，却能挡住很多真实问题：模型反复检索导致向量库打满，批量读文件导致磁盘抖动，多租户共享下游被单个会话占满。限流错误也要走统一错误模型，让 Agent 知道是等待、降级还是停止。

工具注册还要考虑版本演进。MCP 工具一旦被 Host 发现，就可能被缓存、被评测、被用户工作流依赖。直接改字段名、改默认值、改语义，会让模型旧提示和自动化脚本一起失效。Go SDK 可以在 `ToolSpec` 里支持 `Version`、`Deprecated`、`ReplacedBy` 和 `Compatibility`，并在能力发现时把废弃工具继续暴露一段时间。业务代码可以复用同一个 handler，但给新旧 schema 分别写适配层。

```go
type Compatibility struct {
    Since      string `json:"since"`
    Deprecated bool   `json:"deprecated,omitempty"`
    ReplacedBy string `json:"replaced_by,omitempty"`
}
```

版本演进不要只看 Go 类型是否兼容，还要看模型语义是否兼容。把 `query` 改名为 `keywords`，Go 里只是字段变化；对模型来说，可能意味着从自然语言问题变成关键词数组。把默认 `limit` 从 20 改成 100，类型没变，但上下文成本和下游负载都变了。SDK 至少要让这些变化显式出现在 ToolSpec diff 里，方便代码审查和 Agent 评测。

配置也要保持朴素。一个 MCP Server 通常需要知道监听方式、授权策略、日志级别、工具开关、下游地址和资源限制。SDK 可以提供配置结构，但不应该强行接管应用配置系统。比较稳的做法是 SDK 接收已经解析好的配置对象，应用自己决定来自环境变量、文件还是控制面。这样 SDK 不会把部署约束写死，也便于在测试里构造不同场景。

## 测试评测

Go MCP SDK 的测试应该优先覆盖边界，而不是只跑端到端。端到端测试有价值，但它发现问题晚、定位慢。一个合理的测试矩阵如下：

| 测试层 | 关注点 | 示例 |
| --- | --- | --- |
| Handler 单元测试 | 业务参数、默认值、依赖调用、错误映射 | 直接调用 `ReadFileHandler.Handle` |
| Middleware 测试 | 权限、日志、panic、指标、限流 | fake next handler，断言是否被调用 |
| Registry 测试 | 重名注册、schema 存储、版本暴露 | 注册两个同名工具应失败 |
| Executor 测试 | JSON 解码、工具查找、错误归一化 | 原始参数非法返回 `INVALID_ARGUMENT` |
| Transport 测试 | MCP 消息格式、请求响应 id、协议错误 | stdio 或 HTTP golden test |
| Agent 评测 | schema 是否让模型正确调用工具 | 给任务，看模型构造参数是否稳定 |

handler 测试应该像普通 Go service 测试一样简单：

```go
type fakeRepo struct {
    gotWorkspace string
    gotPath      string
}

func (f *fakeRepo) ReadFile(ctx context.Context, workspace, path string, maxBytes int) (ReadFileResult, error) {
    f.gotWorkspace = workspace
    f.gotPath = path
    return ReadFileResult{Path: path, Content: "hello"}, nil
}

func TestReadFileHandler(t *testing.T) {
    repo := &fakeRepo{}
    h := ReadFileHandler{Repo: repo}
    ctx := WithCallContext(context.Background(), CallContext{Workspace: "/repo", Scopes: []string{"repo:read"}})

    res, err := h.Handle(ctx, ReadFileRequest{Path: "README.md"})
    require.NoError(t, err)
    require.Equal(t, "hello", res.Content)
    require.Equal(t, "/repo", repo.gotWorkspace)
    require.Equal(t, "README.md", repo.gotPath)
}
```

中间件测试要验证短路行为。例如缺少 scope 时，next handler 不应该被调用；panic recover 后应该返回标准错误；context 已取消时不应该继续访问下游。很多 SDK 在这里出问题：日志中间件吞掉错误，鉴权中间件返回普通 `error` 导致协议层无法识别，panic 被恢复但没有 trace id。

Executor 测试要包含 JSON 边界。比如 `max_bytes` 传字符串应该失败，未知字段是否允许要有明确策略，缺少必填字段要返回稳定错误码。这里可以选择严格解码，默认拒绝未知字段；也可以允许未知字段但打指标。对模型调用来说，我更推荐严格一些，因为未知字段通常意味着 schema 和模型理解出现偏差。

性能评测也不能忽略。MCP Server 的瓶颈通常不在泛型 handler，而在下游 I/O；但 SDK 层仍然要避免每次调用重复生成 schema、重复反射扫描、过度复制大结果。可以为注册阶段生成并缓存 schema，调用阶段只做解码和必要校验。对于大文件、大日志、大检索结果，结果编码要支持截断和引用，不能无脑把几 MB 文本塞回模型上下文。

最后是 Agent 评测。SDK 接口写得再漂亮，如果生成的 ToolSpec 让模型总是填错参数，也是不合格。可以准备一组自然语言任务，记录模型选择工具和构造参数的结果，比较 schema 修改前后的成功率。Go SDK 可以提供测试辅助函数，把工具目录导出为评测夹具，让应用团队在 CI 里跑小规模工具调用评测。

我会特别增加一类“取消传播测试”。测试里创建一个会阻塞的 fake 下游，然后取消 context，断言 handler 能及时返回，goroutine 没有泄漏，transport 能给客户端明确错误。MCP 工具经常被长任务诱惑，比如跑测试、下载日志、检索大仓库、生成报告。如果取消传播做不好，用户以为任务停了，后台其实还在消耗资源，甚至继续执行写操作。Go 的 context 是解决这个问题的标准工具，SDK 应该让它成为默认路径，而不是可选能力。

另一个常见评测是“schema 漂移测试”。请求结构体变了，ToolSpec 的 JSON schema 却没更新，模型还按旧字段调用，线上就会出现大量参数错误。可以在注册测试里从 `Req` 生成 schema，再和手写 schema 做兼容检查。对于关键工具，我仍然喜欢手写或审查 schema，因为描述和枚举语义很重要；但结构字段、必填项、类型可以由测试帮忙发现漂移。

发布前还应做一轮可观测性演练。启动一个带 fake transport 的 Server，连续调用成功工具、参数错误工具、权限失败工具、超时工具和 panic 工具，检查日志、指标、trace 是否能串起来。很多 SDK 示例只演示“如何返回结果”，却没有演示“如何排查线上失败”。生产里真正救命的是这些字段：工具名、请求 id、用户或租户、耗时、输入大小、输出大小、错误码、重试次数、取消原因。字段不需要多，但必须稳定。

可以用一张小表定义发布门槛：

| 门槛 | 通过标准 | 不通过时的处理 |
| --- | --- | --- |
| 单元覆盖 | 新工具 handler 有直接测试 | 不允许注册到默认目录 |
| schema 稳定 | ToolSpec diff 已审查 | 标记实验工具或延后发布 |
| 取消传播 | context 取消后无泄漏 | 修复下游调用或加超时 |
| 错误归一 | 无裸字符串错误暴露 | 接入 SDK 标准错误 |
| 观测完整 | trace 能串起请求和下游 | 补日志字段再上线 |
| Agent 评测 | 关键任务参数构造稳定 | 调整描述、schema 或工具粒度 |

## 失败模式

第一种失败模式是接口过大。比如定义一个 `ServerContext`，里面有 logger、db、config、auth、metrics、workspace、transport、session、cache，然后所有 handler 都接收它。这样看似方便，实际让每个工具都依赖整个平台。测试时要构造一堆无关对象，工具也容易偷偷访问不该访问的能力。小接口能让依赖暴露得更诚实。

第二种失败模式是把 `context.Context` 当成依赖容器。context 适合传请求级数据，不适合传业务服务。把数据库、HTTP client、配置对象放进 context，会让依赖关系不可见，生命周期不清楚，也让静态分析和测试变差。业务依赖应该放在 handler struct 字段里，调用元数据才进 context。

第三种失败模式是 handler 接收 `map[string]any`。这种写法在工具数量少时灵活，工具数量多时会变成类型陷阱。JSON 数字变 `float64`，数组元素要手动断言，字段拼写没有编译期保护，默认值散落在各处。强类型请求结构体配合统一解码，能减少很多低级错误。

第四种失败模式是传输层和业务层耦合。工具 handler 直接读 stdio、直接写 JSON-RPC 响应，或者依赖 HTTP request。这样一换部署形态就要改业务代码，也很难做单元测试。Transport 应该只处理消息，Executor 才进入工具世界。

第五种失败模式是错误模型不统一。每个工具返回自己的错误字符串，协议层再统一包成 `internal error`。这会破坏 Agent 恢复能力，也会让指标不可用。SDK 应该提供标准错误类型和包装函数，并在中间件里兜底未知 panic 和普通 error。

第六种失败模式是注册期没有验证。工具名为空、schema 不是 object、必填字段和结构体 tag 不一致、风险等级缺失、同名工具覆盖，如果这些问题等到运行时才暴露，排障成本很高。注册函数应该尽量在启动时失败，让 Server 不带着坏工具上线。

第七种失败模式是过度反射。为了减少样板，SDK 自动从任意函数推导 schema、推导工具名、推导描述、推导错误。适度反射可以接受，但关键语义必须显式。工具描述、风险、副作用、权限 scope、示例参数都不应该靠函数名猜。模型调用的是语义契约，不是 Go 函数签名。

第八种失败模式是忽略运行时资源治理。很多工具单次调用看起来很轻，但 Agent 会把它们组合成循环：反复搜索、反复读取、反复请求日志、反复尝试参数。SDK 如果没有每工具超时、并发上限、结果大小限制和租户级配额，业务 handler 就会被迫自己处理资源保护，最后每个工具做法都不同。资源治理应该在执行层统一实现，工具只表达自己的成本等级和是否允许并行。

第九种失败模式是把示例代码当成生产模板。SDK 文档里常见的最小示例会省略鉴权、错误归一、context 超时和观测字段，读者复制后直接上线。一个负责任的 Go SDK 应该同时提供“最小可运行示例”和“生产骨架示例”。前者帮助理解概念，后者展示注册校验、中间件顺序、结构化日志、fake 测试和关闭流程。否则 SDK 易学，但项目难维护。

## 上线 checklist

- 每个工具都有独立 `ToolSpec`，包含名称、描述、输入 schema、版本、只读标记和风险等级。
- handler 使用强类型请求和结果，不直接接收 `map[string]any` 作为业务入口。
- 所有 handler 第一个参数是 `context.Context`，下游 I/O 尊重取消和 deadline。
- 业务依赖通过 struct 字段或构造函数注入，不通过全局变量和 context 隐式获取。
- Registry 在启动期校验工具名、重复注册、schema 合法性、必填元数据和版本。
- Transport、Router、Executor、Handler 分层清楚，stdio 和 HTTP 部署不改业务工具代码。
- 鉴权、日志、指标、panic recover、限流、确认检查通过中间件实现，并有独立测试。
- SDK 错误类型能表达错误码、用户提示、模型提示、trace id、可重试和可恢复策略。
- 测试覆盖 handler、middleware、registry、executor、transport，以及至少一组工具调用 Agent 评测。
- 大结果有截断、分页或引用机制，避免把大文件和长日志直接塞进模型上下文。
- 观测字段至少包含 tool name、trace id、tenant、duration、error code、retry count 和 result size。
- 文档里给出最小工具示例、带鉴权工具示例、外部写工具示例和测试示例。

## 总结

Go MCP SDK 的好设计，应该让工具作者写普通、可测试、边界清楚的 Go 代码。小接口减少耦合，强类型 handler 减少运行时猜测，显式 context 保证取消和 trace 能穿透，中间件承接横切能力，transport 分离部署形态。这样 SDK 不需要做成复杂框架，也能支撑真实生产里的工具增长。

我最看重的判断标准很简单：一个工具 handler 能不能在不启动 MCP Server 的情况下被单元测试；一个权限策略能不能用 fake handler 单独测试；一个传输实现能不能在不知道业务工具的情况下替换；一个错误能不能被 Agent、用户和日志分别正确消费。做到这些，Go MCP SDK 就有了稳固的工程骨架。后续无论接更多工具、更多 Host，还是扩展流式结果、幂等写入和远程部署，都不会把业务代码拖进协议细节里。

接口越克制，工具生态越容易长期演进；这也是 Go 写基础设施最值得坚持的地方。
