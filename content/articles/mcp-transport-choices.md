---
slug: mcp-transport-choices
url: /notes/mcp-transport-choices/
title: MCP 传输层怎么选
summary: stdio、HTTP 和长连接适合不同部署形态。
categoryKey: mcp
category: MCP
categoryLabel: MCP 与工具协议
source: NOTES/MCP
date: 2026-04-07
image: /assets/article-visuals/mcp-transport-choices.svg
tags:
  - Transport
  - MCP
---

![标题图](/assets/article-visuals/mcp-transport-choices.svg)

## 问题背景

做 MCP Server 时，很多人第一反应是先选传输层：用 stdio 还是 HTTP，用不用 SSE，要不要 WebSocket，要不要放到远端服务里。这个问题看起来像技术偏好，实际是部署模型、权限边界、运维能力和用户体验的综合选择。传输层选错，不一定马上坏，但会在并发、认证、日志、更新、跨平台和故障恢复上持续放大成本。

本地工具最适合从 stdio 起步。桌面应用或开发工具启动一个子进程，通过标准输入输出交换 JSON-RPC 消息，配置简单，权限跟随本地用户，调试也直观。很多文件系统、Git、测试运行器、代码分析工具都适合这种方式。问题是 stdio 天生更像“一个 Host 管一个子进程”的模型，不适合多用户共享，不适合横向扩展，也不适合复杂的网络认证。你可以在本地做得很顺，但一旦想让团队共用同一个 Server，stdio 就会变得别扭。

HTTP 适合远端服务化。它能复用负载均衡、认证网关、审计日志、限流、服务发现、容器部署和零停机发布。企业系统、工单、知识库、数据库代理、云资源控制面，大多天然已经在 HTTP 体系里。HTTP 的问题是每次请求都要处理身份、租户、超时、重试和网络错误，连接状态不如本地进程简单。模型工具调用本身是短动作，但 Agent 工作流常常是多步骤，服务端如果没有会话和上下文设计，会让 Client 反复传递大量信息。

长连接适合需要服务端主动推送或流式进展的场景。例如日志追踪、长任务执行、浏览器自动化、远程 shell、实时协作、订阅资源变化。它能减少轮询，也能让用户更早看到进度。代价是连接管理复杂：心跳、断线重连、背压、消息顺序、会话迁移、代理超时都会出现。很多团队一开始为了“实时感”选择长连接，后来发现真正的工作都耗在运维细节上。

传输层不是 MCP 的核心语义，但它决定核心语义能不能稳定落地。比如取消请求，stdio 下可以通过同一进程的消息快速传给执行器；HTTP 下可能已经被网关超时切断，需要后台任务感知取消；长连接下要处理断线时任务是否继续。再比如幂等，stdio 的重试通常来自 Host 重启或子进程崩溃，HTTP 的重试可能来自网关、SDK、用户重复点击和 Agent 自我恢复。不同传输层下，同一个工具契约需要不同的运行时补强。

我一般不会问“哪种传输最好”，而是先问四个更具体的问题。第一，Server 是本地私有进程，还是多用户共享服务。第二，工具是否需要访问用户本机资源，还是访问远端业务系统。第三，调用是短请求为主，还是长任务、流式输出、订阅变化。第四，团队是否有足够能力运维连接、认证、限流和观测。回答清楚以后，传输层选择通常很自然。

## 核心概念

MCP 传输层要解决的是消息如何在 Client 和 Server 之间可靠到达，但工程上它同时承载了部署边界、身份边界、故障边界和观测边界。比较 stdio、HTTP 和长连接时，不要只比较性能，要比较这些边界。

| 维度 | stdio | HTTP | 长连接 |
| --- | --- | --- | --- |
| 典型部署 | Host 启动本地子进程 | 远端服务或本地 HTTP 服务 | 远端实时服务或本地持久会话 |
| 身份模型 | 继承本地用户和进程权限 | 明确 token、cookie、mTLS 或网关认证 | 连接级身份加消息级授权 |
| 并发模型 | 单 Host 单进程或少量进程 | 多实例、多租户、水平扩展 | 会话保持、连接池、分片 |
| 调试体验 | 本地日志、进程退出明显 | 标准 HTTP 工具链完整 | 需要抓连接生命周期 |
| 取消和进度 | 进程内传播较直接 | 需要请求、后台任务和状态查询配合 | 适合进度推送和主动取消 |
| 运维成本 | 低，但依赖本机环境 | 中等，复用 Web 基础设施 | 高，心跳和重连复杂 |
| 适合场景 | 文件、Git、测试、个人工具 | 企业系统、团队工具、云服务 | 长任务、订阅、实时自动化 |

stdio 的核心概念是“进程即连接”。Client 启动 Server，Server 从 stdin 读消息，从 stdout 写消息，stderr 留给日志。这个模型非常干净：没有端口冲突，没有跨网络暴露，没有复杂认证。只要进程活着，连接基本就在；进程死了，连接就断了。它特别适合本地优先的工具，因为权限和数据都在用户机器上。缺点也来自这里：进程状态依赖本地环境，升级要处理二进制分发，多个 Host 共享同一个 Server 很麻烦，跨设备访问更麻烦。

HTTP 的核心概念是“请求即边界”。每次工具调用都是一次明确的请求，带身份、租户、超时和审计信息。这个边界非常适合企业集成：可以放在 API 网关后面，可以接现有 OAuth，可以做限流，可以进 APM，可以蓝绿发布。缺点是 MCP 的一些交互语义不是传统 REST 风格，尤其是能力发现、流式结果、取消和长任务状态。用 HTTP 做 MCP 时，不能只把工具调用包装成一个 POST，还要设计好连接初始化、能力缓存、请求关联和后台任务。

长连接的核心概念是“会话承载多次消息”。WebSocket、SSE 或其他持久连接都可以提供更连续的交互体验。Server 可以主动推送进度、日志片段、资源变化和任务完成事件，Client 不用不断轮询。它适合浏览器自动化、远程执行、日志 tail、多人协作这类场景。代价是连接本身成为状态，状态就需要迁移、恢复和清理。部署在负载均衡后面时，你还要考虑粘性会话、实例重启、消息丢失和客户端重放。

传输层选择还涉及消息大小和流控。很多 MCP 工具会返回日志、文件片段、搜索结果、网页正文。stdio 下 stdout 管道可能被大输出堵住；HTTP 下网关可能有 body 大小限制；长连接下如果 Client 消费慢，Server 要做背压。不要让工具随便返回无限长文本。更稳的方式是分页、引用、摘要和资源句柄。例如日志工具先返回前后相关片段和一个 `log_ref`，需要更多内容时再按范围读取，而不是一次把几 MB 日志塞进模型上下文。

安全边界也不同。stdio Server 通常默认信任启动它的 Host，但仍然要防止路径越界和命令注入；HTTP Server 必须把所有请求当成网络输入，认证、授权、CSRF、重放、防火墙和审计都要考虑；长连接 Server 还要处理连接劫持、token 过期、会话续期和消息级权限。传输层越远离本机，越不能把“只有可信 Client 会调用”当成前提。

## 架构/流程图解说明

可以用三张小图理解不同传输层的运行形态。

```text
stdio 本地模式

Desktop Host / IDE / CLI
  |
  | spawn process
  v
MCP Server 子进程
  |
  | local filesystem / git / test runner
  v
用户本机资源
```

stdio 的边界很短，适合把工具贴近本机资源。Host 控制 Server 生命周期，Server 退出就是故障信号。这里最重要的是进程启动参数、工作目录、环境变量和 stderr 日志。不要把业务日志写到 stdout，否则会污染协议消息。也不要默认工作目录永远正确，Client 应该显式传入授权工作区，Server 再做路径解析。

```text
HTTP 服务模式

Agent Host
  |
  | HTTPS + token
  v
API Gateway / Auth / Rate Limit
  |
  v
MCP Server Service
  |
  | internal API
  v
工单 / 知识库 / 数据库 / 云资源
```

HTTP 模式的边界更长，但也更适合团队共享。请求从 Host 到网关，再到 MCP Server，再到内部系统。每一段都可能失败，也都应该有 request ID。这里最重要的是身份透传、租户隔离、超时预算和幂等键。不要让 Agent 直接持有高权限后端 token，最好通过网关或 Server 把用户身份映射成最小权限的业务调用。

```text
长连接会话模式

Agent Host
  |
  | WebSocket / SSE session
  v
Session Manager
  |
  | command / progress / event
  v
Worker Pool
  |
  | logs / browser / remote executor
  v
长任务资源
```

长连接模式需要额外的 Session Manager。它负责心跳、重连、消息序号、订阅关系、任务状态和连接清理。Worker 可以执行长任务，进度通过会话推送给 Client。这里最重要的是“连接断了，任务怎么办”。有些任务应该取消，有些任务应该继续并可查询，有些任务应该暂停等待用户重新连接。这个策略不能藏在实现里，要写进工具契约和任务状态机。

从消息流看，一次远端 HTTP 工具调用可以这样拆：

```text
Client 选择工具
  |
  v
构造请求: request_id, tenant, user, deadline, idempotency_key, arguments
  |
  v
网关认证和限流
  |
  v
Server 校验能力版本和参数
  |
  v
执行业务调用
  |
  v
返回 result 或 structured error
  |
  v
Client 根据错误码决定重试、澄清、降级或停止
```

长任务则应该拆成“提交”和“查询/订阅”两个动作，而不是让一个 HTTP 请求一直挂着：

```text
submit_task -> 返回 task_id
subscribe_task_events(task_id) -> 推送 progress/log/result
get_task_result(task_id) -> 断线后查询最终状态
cancel_task(task_id) -> 用户或 Client 取消
```

这样做会多几个工具或资源，但系统可恢复。网络断开不等于任务丢失，Client 重启后也能通过 `task_id` 找回状态。对模型来说，这种结构也更清晰：先提交，再观察，再根据结果做下一步。

## 工程实现

工程实现可以从一个选择矩阵开始。下面是我会在项目里写进设计文档的简化版本。

| 场景 | 推荐传输 | 原因 | 需要补强 |
| --- | --- | --- | --- |
| 本地仓库读写、运行测试 | stdio | 贴近本机资源，权限自然，延迟低 | 工作区限制、stderr 日志、进程健康检查 |
| 团队知识库查询 | HTTP | 共享服务，复用认证和审计 | 租户隔离、分页、缓存、限流 |
| 创建工单或评论 | HTTP | 外部写需要审计和幂等 | 用户身份映射、确认、idempotency key |
| 浏览器自动化 | 长连接或本地 stdio | 需要持续状态和进度 | 会话清理、截图大小控制、取消 |
| 远程日志 tail | 长连接加查询 API | 服务端主动推送更自然 | 背压、断线恢复、日志引用 |
| 私有数据库查询 | HTTP | 权限和审计重要 | SQL 白名单、结果脱敏、超时预算 |

如果是 stdio，我会把 Server 当成一个严格的子进程协议端点。启动命令只做三件事：读取配置、初始化能力、进入消息循环。所有人类日志写 stderr，所有协议消息写 stdout。下面是一个简化的 Go 结构，表达 stdio Server 的主循环。

```go
type StdioServer struct {
    decoder *json.Decoder
    encoder *json.Encoder
    logger  *slog.Logger
    router  *Router
}

func (s *StdioServer) Serve(ctx context.Context) error {
    for {
        var msg Request
        if err := s.decoder.Decode(&msg); err != nil {
            if errors.Is(err, io.EOF) {
                return nil
            }
            s.logger.Error("decode request", "error", err)
            return err
        }

        resp := s.router.Handle(ctx, msg)
        if err := s.encoder.Encode(resp); err != nil {
            s.logger.Error("encode response", "request_id", msg.ID, "error", err)
            return err
        }
    }
}
```

这段代码看起来简单，但有几个约束必须守住。第一，不要在 stdout 打日志。第二，每个响应都要带回 request ID。第三，长时间任务不能阻塞整个读循环，可以交给 worker，但要有并发上限。第四，进程收到退出信号时要取消上下文，让正在执行的工具尽快停下。第五，Server 初始化失败要通过 stderr 给人类可读错误，同时用非零退出码让 Host 知道启动失败。

如果是 HTTP，我会避免把 MCP 请求直接散落成很多无约束端点，而是保留统一消息入口，再用中间件处理身份、限流、超时和审计。

```go
func MCPHandler(registry *Registry, exec *Executor) http.Handler {
    return withRequestID(
        withAuth(
            withTenant(
                withTimeout(15*time.Second,
                    http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
                        var req MCPRequest
                        if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
                            writeError(w, req.ID, ErrInvalidJSON(err))
                            return
                        }

                        ctx := AttachCallContext(r.Context(), r, req)
                        resp := exec.Handle(ctx, registry, req)
                        writeJSON(w, http.StatusOK, resp)
                    }),
                ),
            ),
        ),
    )
}
```

HTTP 模式里，最容易忽略的是超时预算传递。网关有超时，Server 有超时，后端 API 也有超时。如果每一层都各自设置 30 秒，实际体验会很乱。更好的做法是 Client 带 `deadline` 或 `timeout_ms`，网关和 Server 逐层收缩预算，后端调用使用剩余时间。写操作如果超时，要返回明确副作用状态，不能只返回 504。

HTTP 还要认真处理幂等。对外部写工具，可以要求 Client 提供幂等键，也可以由 Server 根据用户、工具名和业务参数生成。但生成规则要谨慎，不能把大文本全量哈希后就认为安全。一个评论工具可以用 `tenant_id + issue_id + client_request_id` 做幂等范围；一个创建工单工具可以用 `tenant_id + user_id + idempotency_key`。幂等记录要保存请求摘要、外部结果和过期时间。

长连接实现的关键不是 WebSocket API，而是会话状态。一个最小的数据结构可以这样设计：

```go
type Session struct {
    ID          string
    UserID      string
    TenantID    string
    ConnectedAt time.Time
    LastSeen    time.Time
    SendQueue   chan Event
    Subscriptions map[string]Subscription
    Inflight    map[string]TaskRef
}

type Event struct {
    Seq       int64           `json:"seq"`
    RequestID string          `json:"request_id,omitempty"`
    Type      string          `json:"type"`
    Payload   json.RawMessage `json:"payload"`
}
```

这里的 `Seq` 很重要。没有消息序号，断线重连后 Client 不知道错过了哪些事件。`SendQueue` 也不能无限大，Client 消费慢时要么丢弃可丢事件，要么断开连接，要么让后端任务减速。日志流通常可以按窗口丢弃旧片段，但任务完成事件不能丢。不同事件要有不同可靠性等级。

传输层抽象也可以做成接口，让工具执行层不关心底下是 stdio、HTTP 还是长连接。

```go
type Transport interface {
    Serve(ctx context.Context, handler Handler) error
    Name() string
}

type Handler interface {
    Handle(ctx context.Context, req MCPRequest) MCPResponse
}
```

这个抽象不应该过度膨胀。传输层只负责收发消息、连接生命周期和基础上下文，工具层负责业务执行，Host 策略负责确认和权限。不要把 HTTP 的 cookie、stdio 的进程参数、WebSocket 的订阅状态全部泄漏进工具函数。否则工具代码会很快变成传输层特判集合。

配置上，我建议显式写出运行模式，而不是自动猜。

```yaml
mcp:
  transport: http
  http:
    listen: ":8080"
    public_url: "https://mcp.example.com"
    request_timeout_ms: 15000
    max_body_bytes: 1048576
  security:
    auth_mode: oauth
    require_idempotency_for_writes: true
  limits:
    max_concurrent_calls: 64
    max_result_bytes: 262144
```

自动猜测看起来省配置，但会让故障更难解释。本地开发可以用 stdio，团队环境用 HTTP，实时任务启用长连接，这些模式应该在部署文件里清清楚楚。

还有一个经常被忽略的实现问题：同一个 Server 是否要同时支持多种传输。我的建议是可以支持，但不要让多传输共享同一套未加区分的默认值。stdio 的默认超时可以短一些，因为它通常靠近本机资源；HTTP 的默认超时要考虑网关和后端预算；长连接的任务超时则应该拆成连接空闲超时和任务执行超时。三者可以共用工具注册表、执行器和错误模型，但传输适配层必须各自填充正确的 `CallContext`。否则表面上是复用代码，实际上是把不同环境的假设混在一起。

我更喜欢的目录结构是把传输放在最外层，把工具实现放在内层：

```text
cmd/
  mcp-stdio/
  mcp-http/
internal/
  transport/
    stdio/
    http/
    stream/
  contract/
  tools/
  auth/
  audit/
```

这样做有两个好处。第一，本地二进制和远端服务可以独立打包，stdio 版本不必带上 HTTP 网关依赖，HTTP 版本也不必假装自己是本地子进程。第二，工具代码只面对统一的调用上下文，不需要知道请求来自 stdin、HTTPS 还是 WebSocket。传输层负责把外部世界的差异翻译成内部契约，工具层负责执行业务规则。边界清楚以后，测试也更容易：工具单测不需要启动网络，传输集成测试不需要真的调用所有业务系统。

如果后续要从 stdio 迁移到 HTTP，不要直接把本地工具原样搬到远端。迁移前至少要重新审视三件事：原来依赖本机文件权限的地方，远端是否还有同等安全边界；原来靠用户桌面确认的写操作，远端如何展示预览并记录确认；原来不需要租户的缓存、临时文件和日志，远端是否已经加上租户隔离。很多所谓“传输层迁移”最后变成安全重构，就是因为这些隐含前提没有提前列出来。

## 测试评测

传输层测试要覆盖的不只是协议正确，还要覆盖真实网络和进程故障。不同传输层的测试重点不同。

| 测试对象 | 关键用例 | 通过标准 |
| --- | --- | --- |
| stdio | 启动失败、stdout 污染、进程退出、并发请求 | Host 能识别失败，协议流不被日志破坏 |
| HTTP | 认证失败、限流、超时、重试、body 限制 | 返回结构化错误，审计链路完整 |
| 长连接 | 心跳超时、断线重连、慢消费者、消息乱序 | 会话可恢复，关键事件不丢 |
| 通用 | 大结果、取消、幂等、错误分类 | Client 能做正确恢复策略 |

stdio 的测试可以用子进程集成测试。启动 Server，发送初始化消息，发送工具调用，读取响应，然后模拟输入 EOF、发送取消、杀掉进程。还要专门测试“日志是否污染 stdout”：让工具打印一段日志，确认它只出现在 stderr。这个测试很朴素，但非常有价值。stdio 协议一旦 stdout 混入日志，Client 解析会直接崩。

HTTP 的测试需要引入中间件和网关行为。只测 Handler 不够，因为很多问题发生在 Handler 之前或之后。比如请求体超过限制时是否返回 MCP 风格错误，token 过期时是否让模型停止而不是重试，网关超时时 Server 是否取消后端调用，重复幂等键是否返回同一个外部结果。可以用 httptest 做单进程测试，也可以用 docker compose 拉起接近生产的网关链路。

长连接测试要模拟坏网络。断开连接后立即重连，Client 带上最后收到的 `Seq`，Server 应该补发关键事件或提供查询入口。Client 长时间不读取消息时，Server 不应该无限堆内存。心跳丢失时，Server 要释放订阅和任务引用。任务完成事件、取消确认事件、错误事件属于关键事件，日志片段和进度百分比可以降级。

评测指标也要按传输层拆开：

| 指标 | stdio 关注 | HTTP 关注 | 长连接关注 |
| --- | --- | --- | --- |
| startup_latency | 子进程启动是否拖慢 Host | 服务发现延迟 | 建连和认证耗时 |
| call_latency_p95 | 本地执行和管道阻塞 | 网关和后端耗时 | 消息排队耗时 |
| disconnect_rate | 子进程崩溃率 | 网络错误率 | 心跳断开率 |
| retry_duplicate_rate | Host 重启后的重复执行 | HTTP 重试导致的重复写 | 重连重放导致的重复任务 |
| max_buffer_bytes | stdout/stderr 缓冲 | 请求和响应体大小 | send queue 和事件缓存 |
| cancellation_latency | 进程内取消速度 | 后端取消传播速度 | 会话取消传播速度 |

除了自动化测试，我还会做一次“故障演练”。比如在 HTTP 模式下强制后端 API 卡住 20 秒，看 Client 得到什么错误；在长连接模式下断掉网络 30 秒，看任务是否可恢复；在 stdio 模式下让 Server 写出大量 stderr，看 Host 是否还能正常读协议消息。传输层问题经常不是代码逻辑错，而是缓冲、代理、超时和操作系统行为组合出来的。演练能提前暴露这些缝隙。

## 失败模式

第一个失败模式是把 stdio Server 当成普通 CLI 写。普通 CLI 喜欢往 stdout 打进度、提示和表格，stdio MCP Server 绝对不能这样做。stdout 是协议通道，任何非协议字节都可能让 Client 解码失败。人类日志、调试信息、panic 输出都应该去 stderr，并且最好有结构化日志等级。

第二个失败模式是 HTTP 模式没有幂等。网络层会重试，用户会重试，Agent 也可能在不确定时重试。没有幂等键的创建、评论、发送消息、触发部署，都会产生重复副作用。不要用“我们前端不会重复点击”安慰自己，MCP Client 不一定是你的前端。

第三个失败模式是长连接没有背压。Server 以为 WebSocket 可以一直推，Client 如果卡住或网络变慢，发送队列会堆积，最后内存上涨。正确做法是为队列设上限，为事件分优先级，对可丢事件做合并或丢弃，对关键事件落盘或提供查询。

第四个失败模式是把认证放在连接建立时就结束。HTTP 请求每次都要校验身份，长连接也要考虑 token 过期和消息级授权。用户连接时有权限，不代表十分钟后仍然有权限；用户能订阅一个任务，不代表能取消另一个租户的任务。权限检查应该靠近每次工具调用和资源访问。

第五个失败模式是忽略代理和平台限制。HTTP 网关可能限制请求体，SSE 可能被某些代理缓冲，WebSocket 可能被企业网络断开，容器平台可能在滚动发布时杀掉连接，本地 stdio 可能因为 PATH 不一致启动失败。传输层设计必须尊重实际运行环境，而不是只在开发机上验证。

第六个失败模式是结果过大。模型上下文不是日志仓库。传输层能传大结果，不代表应该传。大文件、大日志、大搜索结果都应该用分页、摘要、引用和范围读取。否则 stdio 会堵管道，HTTP 会碰 body 限制，长连接会拖垮队列，模型还会被无关文本淹没。

第七个失败模式是没有统一观测。stdio 只有本地日志，HTTP 有网关日志，长连接有会话日志，如果三者字段不统一，跨模式排查会非常痛苦。至少要统一 request ID、tool name、tenant、user、duration、error code、retry count、result bytes 和 side effect status。传输不同，观测语义要一致。

## 上线 checklist

选择和上线 MCP 传输层前，我会按下面清单检查。

- 明确 Server 是本地私有、团队共享，还是远端多租户服务。
- 明确工具主要访问本机资源、内部业务系统，还是长任务资源。
- stdio 模式下，stdout 只输出协议消息，stderr 承载日志，启动失败有非零退出码。
- stdio 模式下，工作目录、环境变量、二进制路径和权限范围都由 Host 显式配置。
- HTTP 模式下，认证、租户、限流、请求体大小、超时和审计都经过中间件统一处理。
- HTTP 写操作要求幂等键，超时后能表达副作用状态。
- 长连接模式下，有心跳、消息序号、断线重连、慢消费者处理和会话清理。
- 长任务拆成提交、订阅、查询、取消，不依赖单个长 HTTP 请求承载全部状态。
- 所有模式都有 request ID，并能贯穿 Client、Server、后端系统和日志。
- 大结果使用分页、摘要、引用或资源句柄，不直接把无限输出返回给模型。
- 取消请求能传播到执行层，不能取消的工具要在契约里声明。
- 传输层错误被归一化为 MCP 可理解的结构化错误，而不是泄露底层网关或系统文本。
- 有针对进程崩溃、网络超时、断线重连、重复请求、慢消费者和大响应的集成测试。
- 指标按传输模式拆分，但字段语义保持一致。
- 发布策略写清楚：本地二进制如何升级，HTTP 服务如何灰度，长连接如何滚动重启。

## 总结

MCP 传输层没有唯一答案。stdio、HTTP 和长连接各有适合的位置。stdio 简单、贴近本机，适合个人工具和本地开发能力；HTTP 标准、可运维，适合团队共享和企业系统集成；长连接连续、实时，适合长任务、订阅和进度推送。真正的问题不是哪一个更先进，而是哪一个匹配你的资源边界、身份模型和运维能力。

工程上最稳的路线通常是从最小可行传输开始，但不要把临时选择写死。本地文件和 Git 工具先用 stdio，很合理；知识库和工单工具直接用 HTTP，也很合理；只有当任务真的需要推送和会话时，再引入长连接。传输层可以抽象，但不要抽象到抹掉差异。取消、幂等、认证、背压、结果大小和观测，在不同传输下都有不同实现细节。

我判断一个 MCP 传输层设计是否靠谱，不看它用了什么时髦技术，而看它在失败时是否清楚：连接断了任务怎么办，超时后副作用是否已发生，重复请求会不会重复写，慢消费者会不会拖垮服务，日志能不能追到同一次调用。能把这些问题回答清楚，传输层就已经完成了大部分工程责任。剩下的才是性能优化和体验打磨。
