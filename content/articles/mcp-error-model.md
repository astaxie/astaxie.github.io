---
slug: mcp-error-model
url: /notes/mcp-error-model/
title: MCP 错误模型
summary: 错误码、用户可见提示和诊断信息应该分层返回。
categoryKey: mcp
category: MCP
categoryLabel: MCP 与工具协议
source: NOTES/MCP
date: 2026-04-06
image: /assets/article-visuals/mcp-error-model.svg
tags:
  - Error
  - MCP
---

![标题图](/assets/article-visuals/mcp-error-model.svg)

## 问题背景

MCP 把模型、Host 和外部工具接在一起之后，错误就不再是一个简单的 `error string`。过去我们写 Web API，错误主要给调用方工程师看：状态码、错误码、日志 trace、重试建议，最多再加一句用户提示。到了 MCP 场景里，同一个错误会同时影响三类对象：模型需要知道下一步能不能继续计划，Host 需要知道要不要重试、确认、降级或中断，最终用户需要知道自己该补充什么信息，运维和开发还要能从日志里定位问题。把这些诉求揉成一个字符串返回，短期能跑，长期一定会变成排障黑洞。

很多 MCP Server 的第一版错误处理都很随意。工具执行失败就返回“failed to call api”，权限不足就返回后端原文，参数非法就把校验库生成的英文堆栈直接塞回模型上下文。demo 时看起来没问题，因为人站在旁边知道发生了什么；一旦工具进入多步骤 Agent 流程，模型会把这些字符串当作事实或指令继续推理。它可能在权限错误后反复调用同一个工具，也可能在参数缺失时自己猜一个值，还可能把数据库异常、内部路径、租户标识带进最终回答。错误模型不清楚，Agent 的恢复策略就会变成随机行为。

MCP 错误还有一个容易被低估的特点：错误发生的位置很多。Host 发现工具 schema 不匹配是一类错误，Client 和 Server 之间连接断开是一类错误，Server 收到请求后业务校验失败是一类错误，下游 SaaS 限流是一类错误，工具执行成功但结果不可信又是一类错误。它们都可以表现为“工具调用失败”，但工程语义完全不同。连接超时可以重试，参数错误应该让模型修正，权限错误需要用户授权，外部系统不一致需要降级，安全策略拦截则不应该让模型绕过去。

我更倾向于把 MCP 错误看成一个跨边界协议，而不是某个函数的返回值。这个协议需要分层：机器可判定的错误码，模型可理解的恢复提示，用户可见的短说明，开发可排障的诊断信息，审计可关联的 trace 元数据。每一层服务不同读者，互相不要越界。用户不应该看到堆栈，模型不应该看到密钥、内部路径和数据库表名，日志不应该丢掉请求上下文，错误码也不应该被写成无法演进的散乱字符串。

真实系统里的错误成本经常高于成功路径成本。一个读工具失败，模型也许还能换关键词；一个写工具半成功，系统就要判断是否已经创建外部对象；一个超时返回，Host 不知道下游是否完成；一个安全拦截如果提示过细，模型可能学会构造绕过参数；一个错误提示如果过于含糊，用户只能反复让 Agent “再试一次”。错误模型做不好，最后会把所有压力推给提示词和人工客服。

所以 MCP Server 上线前，我会把错误处理当成一套产品接口来设计，而不是等到异常发生时临时拼接字符串。至少要回答几个问题：错误是否有稳定分类，是否能区分可重试和不可重试，是否能告诉模型应该澄清、换工具还是停止，是否能给用户一个不泄露实现细节的解释，是否能让开发用同一个 request id 找到日志，是否能在评测里被稳定断言。答不出来的地方，就是以后线上事故会放大的地方。

## 核心概念

一个可用的 MCP 错误模型，应该把“发生了什么”和“接下来怎么办”拆开。错误码描述类别，恢复策略描述动作，用户提示描述影响，诊断信息描述证据。很多系统把这些东西混在一起，导致错误码里带自然语言，用户提示里带堆栈，模型恢复建议又依赖正则匹配字符串。这样做最直接的问题是不可测试：文案稍微改动，Agent 恢复逻辑就可能失效。

我通常把错误分成五层：

| 层级 | 面向对象 | 典型内容 | 是否给模型 | 是否给用户 | 是否进日志 |
| --- | --- | --- | --- | --- | --- |
| 协议层 | MCP Client/Host | 请求格式错误、方法不存在、版本不兼容 | 是，简化后 | 是，概括后 | 是 |
| 参数层 | 模型和 Host | 字段缺失、枚举非法、路径越界、类型不匹配 | 是 | 视情况 | 是 |
| 权限层 | Host 和用户 | 未授权、scope 不足、租户不匹配、需要确认 | 是，给下一步动作 | 是 | 是 |
| 执行层 | Server 和下游 | 超时、限流、依赖故障、部分成功 | 是，给重试或降级建议 | 是，避免细节 | 是 |
| 语义层 | Agent 计划器 | 结果为空、证据冲突、状态已变化、前置条件失败 | 是 | 是 | 是 |

协议层错误强调兼容性。比如工具不存在，不一定是用户任务失败，也可能是 Host 缓存了旧工具目录。参数层错误强调可修复性。模型需要知道哪个字段错了、合法范围是什么、是否应该向用户澄清。权限层错误强调边界，不能让模型通过换参数绕过策略。执行层错误强调稳定性，Host 需要知道是否安全重试。语义层错误强调任务状态，比如“没有找到匹配文件”和“检索服务失败”都可能返回空，但前者是业务结果，后者是基础设施问题。

错误码要稳定，但不要过度细碎。一个错误码如果只被一个 if 分支使用，意义不大；一个错误码如果覆盖了十种恢复策略，也没有意义。好的错误码应该和恢复动作基本对齐。例如 `INVALID_ARGUMENT`、`MISSING_REQUIRED_ARGUMENT`、`AUTH_REQUIRED`、`PERMISSION_DENIED`、`CONFIRMATION_REQUIRED`、`RATE_LIMITED`、`DOWNSTREAM_TIMEOUT`、`CONFLICT`、`PARTIAL_SUCCESS`、`RESULT_UNTRUSTED`。这些名字能让 Host 做策略表，也能让评测用例断言。

比错误码更重要的是错误的可见边界。面向模型的内容应该帮助它纠正下一步，而不是泄露内部实现；面向用户的内容应该说明影响和可选动作，而不是把全部技术细节倒出来；面向日志的内容应该完整保存诊断证据，但必须经过脱敏。三者不能共用同一个字段。共用字段看似省事，最后会在安全和可用性之间反复摇摆：想让开发看清楚，就会泄露；想避免泄露，就会排障困难。

可以把一次错误返回建模成下面这个结构：

```go
type MCPToolError struct {
    Code        string            `json:"code"`
    Category    string            `json:"category"`
    Retryable   bool              `json:"retryable"`
    Recoverable bool              `json:"recoverable"`
    UserMessage string            `json:"user_message"`
    ModelHint   string            `json:"model_hint"`
    Details     map[string]string `json:"details,omitempty"`
    TraceID     string            `json:"trace_id"`
    Cause       string            `json:"-"`
}
```

这里的 `Cause` 不序列化给模型和用户，只写日志；`Details` 也要做白名单，不能把后端错误原样透出。`UserMessage` 控制最终展示，语言要稳定、短、可行动。`ModelHint` 控制 Agent 恢复，应该说明“可以怎么做”，例如“请向用户索要项目 ID”，或者“不要重试同一请求，先刷新资源列表”。`Retryable` 给 Host 做自动重试，`Recoverable` 给计划器判断是否还能继续任务。二者不等价：参数错误不可重试但可恢复，限流可重试但未必需要模型参与。

## 架构/流程图解说明

MCP 错误链路可以按“捕获、归一化、分发、观察”四步理解：

```text
工具调用请求
  |
  v
Host 预检：schema 校验、权限检查、确认策略
  |        \
  |         -> 预检错误：直接构造标准错误
  v
MCP Client 发送请求
  |
  v
MCP Server 路由 handler
  |
  v
业务执行：参数二次校验、下游调用、状态变更
  |
  v
错误归一化：内部错误 -> 标准错误码 + 恢复策略 + trace
  |
  v
Host 分发：给模型的 hint、给用户的 message、给日志的 diagnostics
  |
  v
Agent 下一步：修正参数、请求授权、重试、降级、停止
```

这张图的关键是错误不应该只在 Server 末端处理。Host 预检能拦住一大批低成本错误，比如 JSON schema 不合法、路径不在工作区、写操作缺少确认、工具版本不匹配。越早发现，越少副作用，也越容易给模型明确反馈。Server 仍然要做完整校验，因为 Host 不是安全边界；但 Host 预检可以减少无意义下游调用，让错误更接近用户意图。

错误归一化层要避免两个极端。一个极端是把所有异常都映射成 `INTERNAL_ERROR`，这样 Host 无法判断动作；另一个极端是把每个下游错误都变成新的外部错误码，导致客户端策略爆炸。更实用的做法是内部保留细粒度 cause，外部暴露有限稳定码，再用 `details` 放经过白名单处理的辅助字段。例如 GitHub API 返回 404，内部 cause 可以记录原始 endpoint、status、response id；外部错误码要根据语境区分为 `RESOURCE_NOT_FOUND`、`PERMISSION_DENIED` 或 `SCOPE_MISMATCH`，因为这三种恢复方式不同。

对 Agent 来说，错误也是流程控制信号。一个多步骤任务可能像这样执行：

```text
1. 用户：把昨天 CI 失败原因整理到 issue
2. Agent 调用 ci.list_failed_runs(date=yesterday)
3. 工具返回 AUTH_REQUIRED，model_hint=请求用户连接 CI 权限
4. Agent 向用户说明需要授权
5. 用户授权后重试
6. Agent 调用 ci.get_run_logs(run_id=...)
7. 工具返回 DOWNSTREAM_TIMEOUT，retryable=true
8. Host 自动退避重试
9. 重试成功，Agent 调用 issue.append_comment
10. 工具返回 CONFIRMATION_REQUIRED，Host 展示写入预览
```

这里至少出现三种错误处理路径：权限需要用户参与，超时可以 Host 自动重试，外部写入需要确认。它们如果都只是“tool failed”，模型就只能猜。错误模型清楚后，Agent 计划器反而可以更简单：按错误码和策略表做动作，而不是读一段自然语言再推理。

在观测层，我建议把错误事件拆成两个指标族：用户任务视角和系统组件视角。用户任务视角关注某类错误是否导致任务失败、是否被恢复、恢复花了几轮；系统组件视角关注哪个工具、哪个下游、哪个租户、哪个版本产生了错误。只看组件错误率会漏掉一个事实：有些错误很多但可恢复，对用户影响不大；有些错误少但每次都阻断关键路径，需要优先修。

## 工程实现

实现时我会先定义统一错误类型，再让每个 handler 只负责把业务异常映射到这个类型。不要在每个工具里临时拼 JSON。下面是一个简化但足够落地的 Go 例子：

```go
type ErrorCode string

const (
    ErrInvalidArgument       ErrorCode = "INVALID_ARGUMENT"
    ErrMissingArgument       ErrorCode = "MISSING_REQUIRED_ARGUMENT"
    ErrAuthRequired          ErrorCode = "AUTH_REQUIRED"
    ErrPermissionDenied      ErrorCode = "PERMISSION_DENIED"
    ErrConfirmationRequired  ErrorCode = "CONFIRMATION_REQUIRED"
    ErrRateLimited           ErrorCode = "RATE_LIMITED"
    ErrDownstreamTimeout     ErrorCode = "DOWNSTREAM_TIMEOUT"
    ErrConflict              ErrorCode = "CONFLICT"
    ErrPartialSuccess        ErrorCode = "PARTIAL_SUCCESS"
    ErrInternal              ErrorCode = "INTERNAL_ERROR"
)

type ToolError struct {
    Code        ErrorCode          `json:"code"`
    Message     string             `json:"message"`
    UserMessage string             `json:"user_message"`
    ModelHint   string             `json:"model_hint"`
    Retryable   bool               `json:"retryable"`
    Recoverable bool               `json:"recoverable"`
    Details     map[string]any     `json:"details,omitempty"`
    TraceID     string             `json:"trace_id"`
    cause       error
}

func (e *ToolError) Error() string {
    return string(e.Code) + ": " + e.Message
}
```

`Message` 是给开发和日志看的简短摘要，`UserMessage` 是最终可以展示的文案，`ModelHint` 是给模型继续计划的提示。注意 `cause` 不直接序列化。如果要把 cause 写入日志，必须通过结构化日志系统，并做敏感字段脱敏。很多团队在这里偷懒，直接 `fmt.Sprintf("%v", err)` 返回给调用方，结果把 SQL、token 片段、本地路径、内部服务名都带了出去。

然后写一个小的构造器，强制每个错误码带默认策略：

```go
func NewToolError(code ErrorCode, traceID string) *ToolError {
    e := &ToolError{Code: code, TraceID: traceID}
    switch code {
    case ErrMissingArgument:
        e.Retryable = false
        e.Recoverable = true
        e.UserMessage = "缺少必要参数。"
        e.ModelHint = "检查工具 schema，补齐缺失字段；如果参数无法从上下文确定，请向用户澄清。"
    case ErrAuthRequired:
        e.Retryable = false
        e.Recoverable = true
        e.UserMessage = "需要先完成授权。"
        e.ModelHint = "停止调用该工具，请请求用户授权后再继续。"
    case ErrRateLimited:
        e.Retryable = true
        e.Recoverable = true
        e.UserMessage = "外部服务暂时限流，请稍后重试。"
        e.ModelHint = "不要改变参数；等待 Host 退避重试，或选择只读降级路径。"
    case ErrConfirmationRequired:
        e.Retryable = false
        e.Recoverable = true
        e.UserMessage = "执行前需要确认。"
        e.ModelHint = "不要绕过确认；等待用户确认或调整计划。"
    default:
        e.Retryable = false
        e.Recoverable = false
        e.UserMessage = "工具执行失败。"
        e.ModelHint = "停止当前工具路径，向用户报告失败并保留 trace id。"
    }
    return e
}
```

这个构造器不是为了减少几行代码，而是为了把默认策略集中管理。后续如果发现 `RATE_LIMITED` 的自动重试太激进，只改一处。每个 handler 可以在默认文案上补充安全的字段：

```go
func readRepoFile(ctx context.Context, req ReadFileRequest) (*ReadFileResult, error) {
    traceID := TraceIDFromContext(ctx)

    if req.Path == "" {
        return nil, NewToolError(ErrMissingArgument, traceID).
            WithDetail("field", "path").
            WithMessage("path is required")
    }

    normalized, ok := normalizeWorkspacePath(req.Path)
    if !ok {
        return nil, NewToolError(ErrInvalidArgument, traceID).
            WithDetail("field", "path").
            WithDetail("reason", "outside_workspace").
            WithUserMessage("路径不在当前授权工作区内。").
            WithModelHint("不要猜测绝对路径；请使用用户提供的相对路径，或先列出工作区文件。")
    }

    data, err := os.ReadFile(normalized)
    if err != nil {
        if errors.Is(err, os.ErrNotExist) {
            return nil, NewToolError(ErrInvalidArgument, traceID).
                WithDetail("field", "path").
                WithDetail("reason", "not_found").
                WithUserMessage("指定文件不存在。").
                WithModelHint("先调用文件列表或搜索工具确认路径，再重试。")
        }
        return nil, NewToolError(ErrInternal, traceID).WithCause(err)
    }

    return &ReadFileResult{Content: string(data)}, nil
}
```

这里有几个工程细节值得坚持。第一，字段级错误要指出字段名，但不要把危险输入原样回显。路径可以回显相对路径，token、查询语句、用户隐私不要回显。第二，模型提示要告诉它下一步动作，而不是只描述失败。第三，错误码和 `details.reason` 要可枚举，便于测试和指标聚合。第四，内部错误仍然要带 trace id，否则用户把失败截图发来时，工程师无法定位。

错误归一化最好不要散落在 handler 里，而是建立一个小的边界适配层。每个下游系统都有自己的错误语言：文件系统有 `os.ErrNotExist` 和权限错误，HTTP 有状态码和响应体，数据库有驱动错误和事务错误，云服务有 request id 和限流头。MCP Server 不应该把这些语言直接暴露给 Agent，而应该先映射成内部 `CauseKind`，再映射成外部错误码。这样做的好处是，工具作者可以保留足够的诊断细节，Host 又只需要理解有限集合。

```go
type CauseKind string

const (
    CauseNotFound       CauseKind = "not_found"
    CauseUnauthorized   CauseKind = "unauthorized"
    CauseRateLimit      CauseKind = "rate_limit"
    CauseTimeout        CauseKind = "timeout"
    CauseConflict       CauseKind = "conflict"
    CauseUnsafeArgument CauseKind = "unsafe_argument"
)

func MapHTTPError(status int, retryAfter string, traceID string) *ToolError {
    switch status {
    case 401:
        return NewToolError(ErrAuthRequired, traceID)
    case 403:
        return NewToolError(ErrPermissionDenied, traceID)
    case 409:
        return NewToolError(ErrConflict, traceID).
            WithModelHint("资源状态已变化；请重新读取最新状态后再决定下一步。")
    case 429:
        return NewToolError(ErrRateLimited, traceID).
            WithDetail("retry_after", retryAfter)
    case 504:
        return NewToolError(ErrDownstreamTimeout, traceID)
    default:
        return NewToolError(ErrInternal, traceID)
    }
}
```

这里不要机械地把 HTTP 状态码等同于 MCP 错误码。比如 404 在公开 API 里可能是资源不存在，在多租户系统里也可能是权限隐藏策略。映射必须结合当前工具语义。如果用户查一个明确存在的私有仓库，后端返回 404，给模型的外部错误也许应该是 `PERMISSION_DENIED`，否则模型会告诉用户“仓库不存在”，造成错误结论。错误模型和业务语义要在 Server 里汇合，不能只靠网关做通用翻译。

对于有副作用的工具，错误模型还要表达“是否已经发生部分执行”。例如写 issue 评论时，网络在提交后断开，Server 不确定评论是否创建成功。此时不能简单返回超时并让 Host 重试，否则可能重复发评论。更稳的流程是要求写工具带幂等键：

```json
{
  "code": "UNKNOWN_COMMIT_STATE",
  "retryable": false,
  "recoverable": true,
  "user_message": "操作状态暂时无法确认。",
  "model_hint": "不要重复提交相同写操作；先使用 idempotency_key 查询操作状态。",
  "details": {
    "operation": "issue.append_comment",
    "idempotency_key": "host-generated-key"
  },
  "trace_id": "req_8f3d..."
}
```

这个错误不是普通失败，而是状态未知。工程上要给它单独分类，否则自动重试会制造重复副作用。很多事故不是因为工具不会失败，而是因为系统把“不知道成功没有”误当成“失败了”。

## 测试评测

错误模型的测试不能只测 happy path。我的做法是把错误测试分成单元测试、契约测试、恢复评测和混沌评测四类。

| 测试类型 | 目标 | 示例断言 | 适合频率 |
| --- | --- | --- | --- |
| 单元测试 | handler 把业务异常映射到正确错误 | 缺少 `path` 返回 `MISSING_REQUIRED_ARGUMENT` | 每次提交 |
| 契约测试 | MCP 返回结构稳定 | `user_message`、`model_hint`、`trace_id` 必有 | 每次提交 |
| 恢复评测 | Agent 看到错误后动作正确 | 权限错误后不重复调用，转为请求授权 | 每日或发布前 |
| 混沌评测 | 下游异常时系统不放大故障 | 超时、限流、半成功、返回脏数据 | 发布前和演练 |

单元测试要避免只断言字符串。字符串会因为文案优化而变化，真正应该稳定的是错误码、策略字段和安全细节。例如：

```go
func TestReadFileOutsideWorkspace(t *testing.T) {
    _, err := readRepoFile(ctx, ReadFileRequest{Path: "../../secret"})
    var toolErr *ToolError
    require.ErrorAs(t, err, &toolErr)
    require.Equal(t, ErrInvalidArgument, toolErr.Code)
    require.False(t, toolErr.Retryable)
    require.True(t, toolErr.Recoverable)
    require.Equal(t, "path", toolErr.Details["field"])
    require.NotContains(t, toolErr.UserMessage, "../../secret")
    require.NotEmpty(t, toolErr.ModelHint)
}
```

契约测试要跑在 MCP 边界，而不是只测内部函数。很多泄露发生在序列化层：内部字段本来不该暴露，结果 JSON tag 写错了；`cause` 原本只进日志，结果被包装成 `details.raw_error`；trace id 在某条路径丢了。契约测试可以读取真实工具返回，检查允许字段白名单，确保敏感字段不会进模型上下文。

恢复评测更像 Agent 行为测试。给模型一个任务，然后模拟工具返回错误，看它下一步是否符合预期。例如参数缺失时是否向用户澄清，权限不足时是否请求授权，限流时是否等待 Host 重试，确认错误时是否展示预览，安全拦截时是否停止而不是换一个更宽的工具。这里不要追求模型每个字都一样，而要断言行为类别。

还需要观察线上指标。至少应有这些维度：`tool_name`、`error_code`、`retryable`、`recoverable`、`host_version`、`server_version`、`tenant_tier`、`trace_id`、`recovered`、`user_visible`。单看错误率不够，要看恢复率和最终任务完成率。如果 `INVALID_ARGUMENT` 很高但恢复率也高，可能是 schema 描述不清；如果 `PERMISSION_DENIED` 很高且恢复率低，可能是授权流程断了；如果 `DOWNSTREAM_TIMEOUT` 不高但任务失败率高，可能是关键工具缺少降级路径。

我还会给错误路径做一组“红队式”评测，专门验证系统不会在失败时泄露或放大风险。比如构造一个包含 prompt injection 的文件名，确认参数错误不会把完整文件名作为模型指令返回；构造一个超长下游错误体，确认 Server 会截断并脱敏；构造一个外部写操作超时，确认 Host 不会自动重复提交；构造一个安全策略拦截，确认模型不会改用更宽的 shell 工具绕过。错误评测不只是稳定性评测，也是安全评测，因为很多攻击都是借失败路径把内部信息挤出来。

下面是一组可以落到 CI 的错误夹具：

| 场景 | 注入方式 | 期望错误 | 关键断言 |
| --- | --- | --- | --- |
| 缺少字段 | 删除必填 `path` | `MISSING_REQUIRED_ARGUMENT` | 模型提示要求澄清，不猜路径 |
| 路径越界 | `../../secret` | `INVALID_ARGUMENT` | 不回显敏感绝对路径 |
| 权限过窄 | 移除 `repo:write` | `PERMISSION_DENIED` | 不调用下游写接口 |
| 下游限流 | fake 429 | `RATE_LIMITED` | 有退避信息，无重复副作用 |
| 提交状态未知 | 写后断连 | `UNKNOWN_COMMIT_STATE` | 要求查询状态，不自动重试 |
| 外部错误污染 | 响应体含指令文本 | `INTERNAL_ERROR` | 指令文本不进入 `model_hint` |

## 失败模式

第一种失败模式是把内部错误原样透出。后端返回什么，MCP Server 就返回什么。短期排障方便，长期会泄露实现细节，也会污染模型上下文。模型看到“database locked”可能建议用户等待，看到“no such table”可能把内部表名写进总结，看到“permission denied for role service_x”可能暴露租户架构。

第二种失败模式是错误码只有技术含义，没有恢复含义。比如所有参数错误都叫 `BAD_REQUEST`，所有下游错误都叫 `INTERNAL_ERROR`。这对 HTTP 调用也许够用，对 Agent 不够。Agent 需要知道是补字段、换工具、请求授权、稍后重试还是停止。错误码不能指导动作，就会退化成展示文案。

第三种失败模式是重试策略过于粗暴。看到超时就重试，看到 500 就重试，看到连接断开也重试。对于只读工具这通常可接受，对于写工具就危险。尤其是创建评论、发消息、修改状态、触发部署这类工具，必须区分“请求未到达”“请求已执行但响应丢失”“请求执行到一半”。没有幂等键，就不要做自动写重试。

第四种失败模式是用户提示和模型提示混用。为了让用户看懂，提示写得很温和；模型读到后却不知道下一步动作。或者为了让模型修正，提示写得非常技术化；用户看到后完全不知道怎么处理。两个字段分开后，文案才能各自优化。

第五种失败模式是错误指标没有闭环。系统记录了错误日志，但不知道错误是否被 Agent 恢复，也不知道用户最终任务是否完成。这样排优先级时只能看噪音最大的错误，而不是影响最大的错误。真正应该关注的是“不可恢复错误导致的任务失败”和“可恢复错误消耗的额外轮次”。

第六种失败模式是安全错误提示过细。比如路径越界时返回“禁止访问 `/Users/alice/.ssh/id_rsa`”，权限不足时列出用户缺少的所有内部 scope，策略拦截时解释具体正则。过细提示会帮助攻击者迭代输入。安全类错误的 `details` 要严格白名单，模型提示要强调停止或请求授权，而不是提供绕过线索。

第七种失败模式是把空结果当错误，或者把错误伪装成空结果。检索没有命中、列表为空、文件没有匹配行，这些都是正常业务结果，应该返回成功响应并带上清楚的空状态说明。反过来，检索服务超时、索引损坏、权限过滤失败，则不能返回一个空数组假装没有数据。Agent 会根据空结果继续推理，如果错误被伪装成空结果，它可能给用户一个错误结论，例如“没有相关工单”“仓库里不存在这个配置”。空结果和失败必须在协议上分开。

第八种失败模式是错误版本没有兼容策略。Host 可能缓存工具目录，Server 可能先于客户端升级。如果新版本突然改变错误码含义，旧 Host 的恢复策略就会失效。错误码要保持向后兼容，新错误码上线前可以先映射到一个旧大类，同时在 `details.reason` 里暴露细分原因。等 Host 支持后，再把细分码纳入策略表。错误模型和 API 一样需要版本治理。

## 上线 checklist

- 所有工具错误都映射到有限稳定的错误码集合，没有裸 `error.Error()` 直接返回。
- 每个错误都有 `retryable` 和 `recoverable`，并且写工具的自动重试默认关闭或依赖幂等键。
- `user_message`、`model_hint`、`trace_id` 是标准字段，序列化契约测试覆盖所有工具。
- `cause`、堆栈、下游响应体、内部路径、token、SQL、租户内部标识不会进入模型上下文。
- 参数错误能指出字段名和合法修正方向，但不会回显敏感输入。
- 权限错误能区分未登录、scope 不足、租户不匹配、需要用户确认。
- 下游限流和超时有退避策略，且指标能区分自动恢复和最终失败。
- 外部写工具支持幂等键或操作状态查询，不能确认提交状态时返回专门错误。
- Agent 恢复评测覆盖参数缺失、权限不足、限流、确认、冲突、部分成功和安全拦截。
- 日志里能用 trace id 关联 Host 请求、MCP Server handler、下游请求和最终用户任务。
- 错误文案经过产品和安全检查，用户可见提示不包含实现细节。
- 发布后仪表盘展示错误码分布、恢复率、重试次数、用户可见失败率和任务完成率。

## 总结

MCP 错误模型的核心不是多定义几个错误码，而是把错误变成 Agent 可以理解、Host 可以治理、用户可以行动、工程师可以排查的协议。错误码负责稳定分类，恢复字段负责下一步动作，用户提示负责清楚表达影响，诊断信息负责定位问题，trace 负责把一次失败串回完整链路。每层边界清楚，系统才不会在失败时泄露、乱重试或让模型盲猜。

工程上最值得投入的是三件事：统一错误类型、错误契约测试、恢复行为评测。统一类型让每个工具按同一套语言说话，契约测试防止字段泄露和结构漂移，恢复评测保证 Agent 真能按错误语义继续任务。MCP 的成功路径通常很快能跑通，但生产稳定性往往取决于失败路径。把失败路径设计好，工具系统才有资格被更高程度地自动化调用。
