---
slug: llm-api-error-handling
url: /notes/llm-api-error-handling/
title: LLM API 错误处理
summary: 超时、限流、内容过滤和结构化失败都应该有明确降级。
categoryKey: llm-apps
category: LLM Apps
categoryLabel: LLM 应用工程
source: NOTES/LLM
date: 2026-03-17
image: /assets/article-visuals/llm-api-error-handling.svg
tags:
  - API
  - LLM
---

![标题图](/assets/article-visuals/llm-api-error-handling.svg)

## 问题背景

LLM API 的错误处理很容易被低估。很多应用的第一个版本只包一层 `try catch`，失败后提示“请稍后重试”。这个做法在演示阶段可以接受，但在真实业务里会很快失控。因为 LLM 调用不是普通的数据库查询，也不是一个稳定的内部函数。它可能因为网络抖动、供应商限流、上下文过长、内容过滤、结构化输出不合法、工具调用不完整、模型版本变化、用户取消请求、账户余额、区域策略和内部安全规则失败。更麻烦的是，有些失败不是异常返回，而是看起来成功却不能被业务消费。

传统 API 错误处理通常围绕状态码、重试和告警展开。LLM API 需要更多层次。一次请求可能先经过输入清洗、上下文装配、模型调用、流式输出、结构化解析、业务校验、工具执行和最终响应合成。任意一层失败，都要给调用方一个清楚的语义：是否可以自动重试，是否需要换模型，是否需要减少上下文，是否需要向用户追问，是否需要人工审核，是否已经产生副作用。只把错误记录成 `500` 或 `model failed`，后续排障和产品降级都会很困难。

举一个客服助手的例子。用户问“我刚才支付失败，订单号是 9821，帮我处理一下”。系统需要识别意图、查询订单、判断支付状态、可能调用退款或重试支付工具，然后给出答复。如果模型 API 超时，系统可以提示用户稍后重试；如果订单查询工具失败，不能假装已经处理；如果模型输出了不符合 schema 的动作参数，应该阻断工具执行；如果内容安全策略拦截了用户输入，应该给出合规提示；如果供应商返回限流，系统可以降级到另一个模型或排队。不同错误对用户、业务和工程的含义完全不同。

LLM API 错误处理的目标不是“永不失败”。外部服务一定会失败，模型也一定会输出不稳定结果。真正的目标是让失败可分类、可观测、可恢复、可降级，并且不会扩大成业务事故。一个成熟的系统应该知道哪些错误可以重试，哪些错误必须停止，哪些错误可以走缓存，哪些错误要让用户补充信息，哪些错误要进入评测样本，哪些错误要触发工程告警。

很多问题来自边界不清。应用把供应商错误、模型输出错误、业务规则错误和用户输入错误混在一起，最后前端只能显示统一失败文案。工程师排障时，只看到某次请求失败，却不知道是首字节超时、流中断、JSON 截断、敏感内容拦截、工具参数缺字段，还是重试后产生重复外部操作。要解决这些问题，必须把 LLM API 调用视为一条有状态的工程链路，而不是一个简单的文本生成函数。

## 核心概念

LLM API 错误处理的第一件事是建立错误分类。分类不是为了写漂亮枚举，而是为了驱动不同处理策略。一般可以分成八类：输入错误、上下文错误、供应商错误、限流和配额错误、超时和取消、模型拒答或内容过滤、结构化输出错误、业务校验和工具执行错误。每一类都要明确是否可重试、是否可降级、是否暴露给用户、是否需要告警、是否可进入评测样本。

| 错误类型 | 典型表现 | 是否重试 | 用户提示 | 工程动作 |
| --- | --- | --- | --- | --- |
| 输入错误 | 空输入、附件损坏、语言不支持 | 否 | 请补充或更换输入 | 返回可修正文案 |
| 上下文错误 | 检索为空、上下文超长、证据冲突 | 部分可重试 | 说明材料不足或需要选择范围 | 调整召回和裁剪 |
| 供应商错误 | 连接失败、内部错误、无效响应 | 可重试 | 稍后重试或自动恢复 | 指数退避和切换 |
| 限流配额 | 请求过多、余额不足、速率限制 | 延迟重试 | 排队或提示繁忙 | 限速、熔断、预算控制 |
| 超时取消 | 首字节超时、流式中断、用户取消 | 视阶段而定 | 保留已生成内容或提示重试 | 分段超时和取消传播 |
| 内容过滤 | 输入或输出被安全策略拦截 | 否 | 合规说明 | 记录策略命中 |
| 结构化失败 | JSON 无法解析、字段缺失、枚举非法 | 可有限修复 | 提示系统未能生成可用结果 | 修复重试或降级 |
| 业务工具失败 | 参数非法、权限不足、外部工具报错 | 视副作用而定 | 明确未完成的动作 | 幂等、回滚、人工接管 |

第二个概念是“错误语义要和重试策略绑定”。不是所有错误都应该重试。输入为空、权限不足、内容过滤、业务规则不允许，重试只会浪费成本。网络抖动、供应商临时错误、首字节超时，可以重试，但要有次数、退避和预算。结构化输出错误可以做一次修复重试，但如果连续失败，应该降级到安全文本回复或人工处理。工具执行失败要看是否已经产生副作用，不能盲目重试。

第三个概念是“流式输出有中间状态”。很多 LLM 应用使用 streaming 提升体验。流式输出下，错误可能发生在开始前、首字节前、输出中、输出后解析时、最终业务校验时。用户可能已经看到部分内容，前端也可能已经渲染。此时错误处理不能简单地把响应替换成失败。系统要知道已发送内容是否可用，是否需要标记为草稿，是否需要撤回，是否需要补发结构化结果。

第四个概念是“模型成功不等于调用成功”。供应商返回 `200`，模型也生成了文本，但系统仍可能失败：返回不是合法 JSON，字段含义不符合业务规则，引用不存在，工具参数缺少必填项，输出违反产品策略，或者置信度低于阈值。LLM API 的调用边界应该延伸到结构化解析和业务校验之后，只有结果能被下游安全消费，才算真正成功。

第五个概念是“降级不是最后一行兜底文案”。降级应该是设计好的路径。可以降级到较小模型、缓存结果、摘要模式、只读建议、人工确认、异步任务、排队处理、固定模板或明确拒绝。每种降级都应该有适用条件和观测指标。没有设计过的降级，往往会变成用户无法理解的失败提示。

## 架构/流程图解说明

一套稳健的 LLM API 错误处理链路可以画成下面这样：

```text
用户请求
  -> 输入校验：格式、大小、权限、敏感字段
  -> 上下文准备：检索、裁剪、证据检查、预算计算
  -> 调用计划：选择模型、超时、重试、降级候选
  -> 模型 API：非流式或流式调用
  -> 输出接收：完整性检查、流中断处理、取消传播
  -> 结构化解析：JSON/schema/函数调用参数校验
  -> 业务校验：权限、风险、幂等、副作用检查
  -> 工具执行：外部系统调用、回滚、结果包装
  -> 响应合成：用户可理解状态、下一步操作
  -> 观测记录：trace、错误分类、成本、延迟、版本
```

这条链路里每一步都可能返回不同类型的错误。关键是不要让底层错误直接穿透到用户，也不要把所有错误抹平成同一个失败。服务内部应该使用统一错误对象，前端或上游服务只依赖稳定语义。例如：

```text
LLMError
  category: rate_limit | timeout | invalid_output | content_filter | tool_failed
  stage: input | context | provider | stream | parse | validate | tool | response
  retryable: true | false
  user_actionable: true | false
  side_effect: none | pending | committed | unknown
  fallback: retry | switch_model | shrink_context | ask_user | human_review | fail_closed
  trace_id: ...
```

`category` 用来决定大类策略，`stage` 用来定位链路位置，`retryable` 用来控制自动重试，`user_actionable` 用来决定是否请用户补充信息，`side_effect` 用来避免重复执行外部动作，`fallback` 用来选择降级路径，`trace_id` 用来关联日志。这个结构比直接返回异常字符串更啰嗦，但它能让系统在失败时做出稳定决策。

错误处理还要区分同步路径和异步路径。对于聊天、搜索摘要、代码补全这类交互产品，用户等待时间很敏感，超时后可以展示部分结果或快速失败。对于合同审查、批量文档整理、工单归类这类任务，系统可以把请求转成异步作业，遇到限流时排队，遇到供应商失败时稍后重试。不要用同一种超时策略覆盖所有场景。

可以把调用控制做成一个小型状态机：

```text
prepared
  -> calling
  -> receiving
  -> parsing
  -> validating
  -> executing_tool
  -> completed

calling -> retry_wait -> calling
calling -> fallback_model -> calling
receiving -> partial_available -> completed_with_warning
parsing -> repair_once -> parsing
validating -> ask_user -> waiting_user
executing_tool -> human_review
任何状态 -> failed_closed
```

状态机的好处是让“失败后做什么”变成显式分支。比如 `parsing -> repair_once` 只允许一次，避免无限让模型修 JSON；`executing_tool -> human_review` 表示工具阶段失败后不要再自动生成“已经完成”的回复；`receiving -> partial_available` 表示流中断但草稿可保留。对复杂应用来说，状态机比一串嵌套异常处理更可维护。

## 工程实现

下面给出一个 Go 风格的实现草图。重点不是某个 SDK 的用法，而是错误语义、重试边界和降级策略。先定义统一错误类型：

```go
type ErrorCategory string

const (
    ErrInput         ErrorCategory = "input"
    ErrContext       ErrorCategory = "context"
    ErrProvider      ErrorCategory = "provider"
    ErrRateLimit     ErrorCategory = "rate_limit"
    ErrTimeout       ErrorCategory = "timeout"
    ErrContentFilter ErrorCategory = "content_filter"
    ErrInvalidOutput ErrorCategory = "invalid_output"
    ErrBusinessRule  ErrorCategory = "business_rule"
    ErrTool          ErrorCategory = "tool"
)

type ErrorStage string

const (
    StageInput    ErrorStage = "input"
    StageContext  ErrorStage = "context"
    StageProvider ErrorStage = "provider"
    StageStream   ErrorStage = "stream"
    StageParse    ErrorStage = "parse"
    StageValidate ErrorStage = "validate"
    StageTool     ErrorStage = "tool"
)

type SideEffectState string

const (
    SideEffectNone      SideEffectState = "none"
    SideEffectPending   SideEffectState = "pending"
    SideEffectCommitted SideEffectState = "committed"
    SideEffectUnknown   SideEffectState = "unknown"
)

type LLMError struct {
    Category       ErrorCategory
    Stage          ErrorStage
    Message        string
    Retryable      bool
    UserActionable bool
    SideEffect     SideEffectState
    ProviderCode   string
    TraceID        string
    Cause          error
}
```

统一错误对象要在适配层创建，而不是散落在业务代码里。每个供应商 SDK 的错误码、HTTP 状态码和响应体都不一样，业务层不应该理解这些细节。适配层负责把供应商错误翻译成内部语义：

```go
func classifyProviderError(err error, traceID string) *LLMError {
    if errors.Is(err, context.DeadlineExceeded) {
        return &LLMError{
            Category: ErrTimeout, Stage: StageProvider,
            Message: "model request timed out",
            Retryable: true, TraceID: traceID, Cause: err,
        }
    }

    var apiErr *ProviderAPIError
    if errors.As(err, &apiErr) {
        switch apiErr.StatusCode {
        case 400:
            return &LLMError{Category: ErrInput, Stage: StageProvider, Message: "bad model request", Retryable: false, TraceID: traceID, Cause: err}
        case 429:
            return &LLMError{Category: ErrRateLimit, Stage: StageProvider, Message: "model rate limited", Retryable: true, TraceID: traceID, Cause: err}
        case 500, 502, 503, 504:
            return &LLMError{Category: ErrProvider, Stage: StageProvider, Message: "provider unavailable", Retryable: true, TraceID: traceID, Cause: err}
        }
    }

    return &LLMError{Category: ErrProvider, Stage: StageProvider, Message: "unknown provider error", Retryable: true, TraceID: traceID, Cause: err}
}
```

重试策略应该由错误语义驱动，并且受预算控制。重试不是越多越好。对于交互请求，重试会直接增加用户等待；对于批量任务，重试会放大成本；对于有副作用的工具调用，重试可能造成重复操作。一个实用策略是：

```go
type RetryPolicy struct {
    MaxAttempts       int
    BaseDelay         time.Duration
    MaxDelay          time.Duration
    PerAttemptTimeout time.Duration
    TotalBudget       time.Duration
}

func shouldRetry(err *LLMError, attempt int, policy RetryPolicy) bool {
    if err == nil || !err.Retryable {
        return false
    }
    if attempt >= policy.MaxAttempts {
        return false
    }
    if err.SideEffect == SideEffectCommitted || err.SideEffect == SideEffectUnknown {
        return false
    }
    switch err.Category {
    case ErrRateLimit, ErrProvider, ErrTimeout:
        return true
    case ErrInvalidOutput:
        return attempt == 0
    default:
        return false
    }
}
```

结构化输出失败要单独处理。很多应用把“请输出 JSON”写进 prompt，然后用字符串截取或正则修复。这种做法在生产里很危险。更稳妥的方式是使用 schema 校验，并把解析失败分成语法失败和业务失败。语法失败可以做一次修复重试，业务失败要看字段含义。例如模型输出的 `refund_amount` 超过订单金额，不应该让模型自己猜一个新金额，而应该阻断并要求人工确认。

```go
type ToolPlan struct {
    Action       string `json:"action"`
    OrderID      string `json:"order_id"`
    Reason       string `json:"reason"`
    Confidence   int    `json:"confidence"`
    NeedConfirm  bool   `json:"need_confirm"`
}

func validateToolPlan(plan ToolPlan, order Order) *LLMError {
    if plan.OrderID == "" || plan.Action == "" {
        return &LLMError{Category: ErrInvalidOutput, Stage: StageValidate, Message: "missing required tool fields", Retryable: true}
    }
    if plan.OrderID != order.ID {
        return &LLMError{Category: ErrBusinessRule, Stage: StageValidate, Message: "order id mismatch", Retryable: false, UserActionable: true}
    }
    if plan.Action == "refund" && !plan.NeedConfirm {
        return &LLMError{Category: ErrBusinessRule, Stage: StageValidate, Message: "refund requires confirmation", Retryable: false}
    }
    if plan.Confidence < 70 {
        return &LLMError{Category: ErrBusinessRule, Stage: StageValidate, Message: "low confidence tool plan", Retryable: false, UserActionable: true}
    }
    return nil
}
```

流式调用要处理部分结果。前端收到 token 后，服务端仍可能在最后解析失败。一个常见做法是把流式内容分成 `draft` 和 `committed` 两种状态。模型输出过程中，界面显示草稿；只有结构化解析和业务校验通过后，才把结果标记为可执行或可引用。对于写作和摘要，草稿可保留；对于支付、退款、发消息这类动作，草稿绝不能被当成已执行。

工具调用要使用幂等键。假设模型决定创建工单，第一次调用外部系统超时，服务端不知道工单是否创建成功。如果直接重试，可能创建重复工单。每个有副作用的工具都应该接收 `idempotency_key`，这个键由业务对象和运行编号生成。外部系统若不支持幂等，调用层也要维护本地操作记录，并在未知状态时转人工处理。

```text
idempotency_key = hash(task_id + run_id + action + business_object_id)
```

还有一个常被忽略的实现点是请求预算。很多线上问题不是单次调用失败，而是一个用户请求在多个环节里不断消耗时间和 token，最后超过用户可接受范围。预算应该在请求入口创建，并随着上下文装配、模型调用、修复重试和工具执行逐步扣减。比如一个客服会话总预算是八秒，检索最多一秒，首字节最多两秒，结构化修复最多一次，工具执行最多三秒。到了后半段如果预算不足，就不要再尝试昂贵的备用模型，而应该进入可解释降级。这样用户虽然没有拿到完整自动处理，但至少能得到明确状态。

```go
type RequestBudget struct {
    Deadline       time.Time
    MaxInputTokens int
    MaxCostMicro   int64
    RepairUsed     bool
}

func (b RequestBudget) Remaining(now time.Time) time.Duration {
    if now.After(b.Deadline) {
        return 0
    }
    return b.Deadline.Sub(now)
}
```

预算对象的价值在于让每个环节都知道自己不是无限资源。上下文装配可以根据剩余 token 裁剪材料；模型适配层可以根据剩余时间选择流式或非流式；解析失败后可以判断是否还允许修复；工具执行前可以确认是否还有足够时间给用户一个可靠结果。没有预算，错误处理会变成各层自己决定重试，最终把请求拖到不可控。

最后，错误响应要面向用户任务，而不是暴露底层细节。比如供应商 `429` 不应该直接显示“rate limit exceeded”，而应该根据场景显示“当前生成排队中，预计稍后继续”或“系统繁忙，本次不会重复扣减额度”。内容过滤不应该只说“失败”，而应该说明输入或输出触发了安全策略。结构化失败不应该让用户看到 JSON 错误，而应该提示系统没有生成可执行结果，并保留可编辑草稿。

## 测试评测

LLM API 错误处理需要专门测试，不能只靠线上碰运气。测试要覆盖供应商适配、重试策略、流式中断、结构化解析、业务校验、工具幂等和用户文案。最小测试矩阵可以这样设计：

| 场景 | 注入方式 | 期望结果 |
| --- | --- | --- |
| 供应商 500 | mock API 返回内部错误 | 自动重试，超过次数后降级 |
| 供应商 429 | mock API 返回限流 | 按退避等待，记录限流指标 |
| 首字节超时 | 延迟首包 | 在总预算内重试或快速失败 |
| 流中断 | 输出一半后断开连接 | 标记草稿，不执行工具 |
| JSON 截断 | 返回不完整结构 | 修复重试一次，失败后安全降级 |
| 字段越权 | 模型计划执行无权限动作 | 阻断工具调用，进入人工确认 |
| 内容过滤 | 返回安全拦截码 | 给用户合规提示，不重试 |
| 工具未知状态 | 工具超时但可能成功 | 不盲目重试，按幂等键查询或转人工 |

单元测试适合验证分类函数和策略函数。比如不同 HTTP 状态码是否映射到正确 `ErrorCategory`，不同错误是否允许重试，副作用未知时是否阻断自动重试。集成测试适合验证完整链路，尤其是流式输出和工具调用。端到端测试要关注用户看到的状态是否和真实业务一致：没有完成的动作不能说已经完成；可保留的草稿不能因为后台解析失败直接丢失；需要用户补充信息时，文案要明确下一步。

评测还要覆盖“成功但不可用”的情况。可以准备一组模型响应样本，模拟供应商正常返回但内容有问题：

```json
{
  "action": "refund",
  "order_id": "9821",
  "reason": "用户支付失败",
  "confidence": 91,
  "need_confirm": false
}
```

这个响应语法正确，也有较高置信度，但对于退款动作缺少确认，应该被业务校验拦截。类似样本要进入回归测试，因为它们最容易在换模型或改 prompt 后反复出现。只测异常返回，会漏掉这类更危险的失败。

观测指标也属于评测的一部分。生产环境至少要记录：按错误类别统计的失败率、按阶段统计的失败率、重试次数分布、重试后成功率、降级路径使用率、结构化解析失败率、工具未知状态数量、用户取消率、首字节延迟、完整响应延迟、单位成功任务成本。指标要按模型版本、prompt 版本、供应商、场景和流量分桶拆开，否则平均值会掩盖问题。

告警要避免过度噪声。供应商偶发错误可以通过重试恢复，不一定需要立刻打电话；结构化失败率突然升高，可能说明 prompt 或模型版本有回归；工具未知状态哪怕数量少，也可能影响真实业务；内容过滤率升高，可能是用户场景变化，也可能是提示词误触发。告警级别要和业务影响绑定，而不是只和技术错误码绑定。

压测时要特别关注限流和排队。很多模型服务在低并发下表现很好，高峰期却因为并发连接、上下文长度和流式响应占用导致队列堆积。压测不要只模拟短 prompt，也要模拟真实长上下文和慢用户连接。对于流式接口，客户端读得慢会影响服务端资源释放，这也要进入测试。

回放测试也很关键。一次线上失败如果只能靠日志描述，很难判断修复是否有效。比较好的做法是保存脱敏后的输入摘要、上下文引用列表、模型版本、prompt 版本、供应商响应片段、解析错误和业务校验结果。回放时不一定重新调用真实模型，可以先用记录下来的响应验证解析器、校验器和降级路径；需要验证新 prompt 时，再把同一组输入送进候选模型。这样可以把“外部服务不稳定”和“本地处理逻辑有缺陷”拆开。对于高风险业务，回放样本还应该覆盖已产生副作用、未知副作用和无副作用三种状态，确认修复不会重复执行动作。

在团队协作上，测试报告要让产品和工程都看得懂。只写“错误率下降百分之二”不够，还要说明哪些用户任务从失败变成可恢复，哪些错误从自动重试改成了人工确认，哪些降级会影响体验。LLM API 错误处理不是纯后端细节，它会直接改变用户对系统的信任边界。

## 失败模式

第一类失败是“无差别重试”。系统遇到任何错误都重试三次，看似提高成功率，实际会放大限流、增加成本、拖慢用户体验，甚至重复执行外部动作。重试必须依赖错误语义和副作用状态。对于不可重试错误，要快速失败并给出可操作提示。

第二类失败是“吞掉结构化错误”。模型返回的 JSON 不合法，服务端悄悄把缺失字段填默认值。这个做法非常危险，因为默认值可能改变业务含义。比如默认 `need_confirm=false` 会绕过确认，默认 `priority=normal` 会压低紧急事件。结构化失败应该显式记录，并根据字段风险决定修复、追问或阻断。

第三类失败是“流式体验和业务状态不一致”。用户已经看到“已为你创建退款申请”，但后台工具调用失败。这个问题通常来自把生成文本和外部动作混在同一次流里。解决方式是先生成计划和确认，再执行工具，最后基于工具结果合成最终回复。对有副作用动作，界面要清楚区分“准备执行”“等待确认”“执行成功”“执行失败”。

第四类失败是“降级路径没有测试”。系统设计文档里写了可以切换备用模型，但真正限流时发现备用模型不支持同样 schema；写了可以使用缓存，但缓存没有场景维度，返回了不适合当前用户的结果；写了可以转人工，但人工队列没有收到足够上下文。降级路径和主路径一样需要测试。

第五类失败是“错误文案泄漏内部细节”。直接把供应商错误码、prompt 名称、内部工具名、数据库字段暴露给用户，会造成安全和信任问题。用户需要知道的是任务状态和下一步，不需要知道底层栈。内部细节应该进入 trace 和日志，用户文案应该经过产品设计。

第六类失败是“观测缺少关联”。日志里有供应商错误，前端埋点里有用户重试，工具系统里有超时，但没有统一 `trace_id`。排障时只能人工拼时间线。LLM 调用链路必须贯穿统一追踪标识，并记录版本、阶段、错误类别和降级路径。

第七类失败是“把安全拒答当普通失败”。内容过滤和安全拒答不是供应商不稳定，而是策略命中。系统不应该对这类错误做模型切换绕过，也不应该用更弱的提示词强行生成。正确做法是给出合规说明，记录命中类别，并在必要时提供用户可修改输入的路径。

## 上线 checklist

- 错误分类完成：输入、上下文、供应商、限流、超时、内容过滤、结构化输出、业务校验和工具失败都有明确枚举。
- 适配层隔离：业务代码不直接依赖供应商原始错误码，所有错误先转换为内部 `LLMError` 语义。
- 重试受控：每类错误有最大次数、退避、总预算和副作用约束，不可重试错误不会进入自动重试。
- 超时分层：输入处理、上下文准备、首字节、完整生成、工具执行和总请求都有独立超时。
- 流式安全：部分输出被标记为草稿，结构化校验或工具执行未完成前不会展示为最终动作。
- 结构化校验严格：JSON schema、枚举、必填字段和业务规则都经过验证，危险默认值被禁止。
- 工具幂等可用：所有有副作用工具都有幂等键、操作记录和未知状态处理策略。
- 降级路径可测：备用模型、缩短上下文、缓存、异步排队、人工审核和安全失败都有集成测试。
- 用户文案明确：用户能理解任务状态、失败原因类型和下一步操作，内部错误细节不会泄漏。
- 观测贯通：`trace_id` 贯穿前端、服务端、模型供应商适配层和工具层，指标可按版本和场景拆分。
- 告警分级合理：结构化失败、工具未知状态、限流、成本异常和安全策略命中分别有不同告警阈值。
- 回放能力存在：关键失败请求可以用脱敏输入、上下文引用、版本号和模型响应复现。

## 总结

LLM API 错误处理不是在模型调用外面包一层异常捕获，而是为整条智能应用链路设计失败语义。输入、上下文、供应商、流式输出、结构化解析、业务校验和工具执行都可能失败，而且每类失败的恢复方式不同。把它们混成一个通用错误，会让系统既难排障，也难给用户稳定体验。

工程上最重要的几件事是：建立统一错误对象，把供应商错误翻译成内部语义；让重试由错误类别和副作用状态驱动；把结构化输出和业务校验纳入调用成功的定义；为流式输出设计中间状态；为有副作用工具提供幂等和未知状态处理；把降级路径做成可测试的产品能力。这样系统即使失败，也能失败得清楚、可恢复、可观测。

LLM 应用进入生产后，错误处理会直接决定用户信任。用户可以接受系统繁忙、材料不足或需要确认，但很难接受系统假装成功、重复执行、丢失草稿或给出无法解释的失败。把超时、限流、内容过滤和结构化失败都纳入明确降级，才是 LLM API 从演示走向可靠产品的基本功。
