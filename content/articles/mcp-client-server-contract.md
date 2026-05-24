---
slug: mcp-client-server-contract
url: /notes/mcp-client-server-contract/
title: MCP Client/Server 契约
summary: 契约稳定比实现炫技重要，尤其是错误、超时和能力声明。
categoryKey: mcp
category: MCP
categoryLabel: MCP 与工具协议
source: NOTES/MCP
date: 2026-04-08
image: /assets/article-visuals/mcp-client-server-contract.svg
tags:
  - Contract
  - MCP
---

![标题图](/assets/article-visuals/mcp-client-server-contract.svg)

## 问题背景

MCP 很容易被理解成“让模型调用工具的一层协议”。这个理解没有错，但如果只停在工具调用，工程上会少看一半问题。真正难的是 Client 和 Server 之间的契约：谁声明能力，谁负责校验，谁处理超时，谁解释错误，谁保证幂等，谁把外部系统的脏数据挡在模型上下文之外。契约写清楚，工具生态可以慢慢扩展；契约写含糊，demo 越顺，生产事故越靠近。

我在做 Agent 和工具系统时，最怕的一种情况是“双方都觉得自己已经做了”。Server 觉得输入 schema 已经写了，参数错了就是 Client 的问题；Client 觉得工具描述已经注入给模型，模型传错了就是 Server 的问题；Host 觉得调用失败会返回错误，错误信息能给模型看就够了；业务系统觉得 MCP Server 只是一个代理，权限和审计应该在上游解决。最后一次调用失败，会沿着链路变成一串互相推卸：模型说它不知道，Client 说 Server 没声明，Server 说参数不合法，业务系统说用户无权，用户看到的只有一句“工具调用失败”。

契约的目的不是把责任写成法律文本，而是让每一层都能做确定的事情。Client 必须知道 Server 现在有哪些能力、哪些能力需要确认、哪些调用可以重试、哪些错误可以让模型修正。Server 必须知道 Client 会不会发送并发请求、会不会取消请求、会不会重复发送同一个写操作、会不会把旧版本字段继续传过来。双方都必须知道一次调用从开始到结束有哪些状态，失败时如何表达，升级时如何兼容。

很多 MCP 接入失败，不是因为协议本身复杂，而是因为团队把本来应该显式化的工程约定藏在了实现细节里。例如一个本地文件 Server 允许读写工作区文件，最初只有一个桌面客户端调用，大家默认它一定运行在某个目录下，也默认用户会看着屏幕确认每次写入。后来同一个 Server 被接入远端 Agent 平台，工作目录变成容器路径，用户确认变成异步审批，错误日志被模型读取。原来的隐含约定全部失效，结果就出现路径越界、重复写入、错误恢复困难这些问题。

Client/Server 契约还决定了团队能不能安全演进。工具数量会增加，参数会调整，返回结构会变，权限策略会细化，传输方式可能从 stdio 换成 HTTP，Server 也可能从单进程变成多租户服务。如果契约里没有版本、能力声明和错误分类，每一次小改动都要靠人肉同步。更糟的是，模型调用的失败经常不是马上暴露，而是在某个组合任务里才暴露：前一个工具返回字段改名，后一个工具拿不到引用，模型开始猜参数，最后写错外部系统。

所以我更愿意把 MCP 看成“Client 和 Server 之间的可演进运行时边界”。工具只是边界上的一个能力单元。稳定的边界至少要回答八个问题：连接建立时如何协商能力；工具目录如何声明语义；请求如何关联响应；取消和超时如何传播；错误如何分层；结果如何标注可信度；写操作如何保证幂等和审计；版本升级如何不破坏旧 Client。把这些问题在设计早期讲清楚，比上线后靠日志补洞便宜得多。

## 核心概念

Client/Server 契约可以拆成六类：能力契约、调用契约、数据契约、错误契约、生命周期契约和演进契约。它们不是协议文档里的装饰，而是运行时真实影响稳定性的东西。

| 契约类型 | 解决的问题 | Client 责任 | Server 责任 | 常见事故 |
| --- | --- | --- | --- | --- |
| 能力契约 | 当前可用什么工具和资源 | 读取并缓存能力，按版本选择调用 | 声明工具、资源、提示、风险和版本 | Client 调用不存在或语义已变的工具 |
| 调用契约 | 一次请求如何开始和结束 | 生成请求 ID，传超时和取消信号 | 保持响应关联，处理重复和取消 | 响应串线、后台任务继续执行 |
| 数据契约 | 输入输出结构是什么 | 调用前做 schema 校验和来源检查 | 执行业务校验，返回结构化结果 | 模型猜字段，长文本污染上下文 |
| 错误契约 | 失败如何表达 | 区分可修正、可重试、需用户介入 | 返回稳定错误码和诊断信息 | 所有错误都变成 unknown |
| 生命周期契约 | 连接何时有效 | 处理初始化、重连、降级 | 发布状态，释放资源 | 半开连接、重复初始化 |
| 演进契约 | 如何升级不破坏 | 支持能力探测，兼容旧字段 | 版本化变更，提供废弃期 | 小版本上线导致老客户端崩溃 |

能力契约的核心是“声明不是文档，而是运行时输入”。Client 不应该硬编码某个 Server 一定有某个工具，也不应该只靠工具名猜测能力。Server 在初始化后应该给出一份当前连接可见的能力表，其中包括工具名称、描述、输入 schema、输出约定、风险等级、是否需要确认、是否支持取消、是否支持流式返回。Client 再根据用户任务和 Host 策略选择注入哪些能力给模型。这里的能力表要足够稳定，也要足够诚实。一个 Server 如果不能保证写操作幂等，就不要在契约里暗示可以安全重试。

调用契约强调“请求是有身份和生命周期的”。每个请求都应该有唯一 ID，日志、指标、审计、取消和重试都围绕这个 ID 关联。Client 发送调用时要带上超时预算，Server 不能假装自己不知道时间限制。一个工具如果需要 30 秒查日志，Client 只给 5 秒，Server 应该尽早返回可重试或超时错误，而不是继续在后台跑完再写外部状态。对只读工具，超时后继续执行也许只是浪费；对写工具，超时后继续执行可能导致用户以为失败而再次触发，产生重复副作用。

数据契约不只是 JSON Schema。JSON Schema 解决的是形状，工程契约还要解决来源、默认值、权限和可信度。一个 `path` 字段可以通过 schema 限制为字符串，但它到底能不能是绝对路径、能不能包含 `..`、能不能指向软链、能不能来自模型推断，这些必须由 Client 和 Server 共同约束。Client 适合做调用前校验和用户确认，Server 适合做最终授权和业务校验。不能因为 Client 已校验，Server 就相信参数；也不能因为 Server 会校验，Client 就把所有脏参数直接发过去。

错误契约是生产可用性的分水岭。模型能否自己修正一次失败，取决于错误是否结构化。例如 `INVALID_ARGUMENT` 可以让模型调整参数，`PERMISSION_DENIED` 应该让模型停止并解释权限问题，`RATE_LIMITED` 可以等待或降级，`SIDE_EFFECT_UNKNOWN` 则必须提示用户检查外部系统，不能自动重试。错误信息还要分层：用户可见说明应该简洁，模型可见诊断应该包含可修正线索，开发者日志可以包含堆栈和内部 ID，但不能把密钥、完整请求或敏感内容塞进模型上下文。

生命周期契约主要处理初始化、心跳、重连和资源释放。stdio 场景里，进程退出就是强信号；HTTP 场景里，连接可用不代表后端依赖可用；长连接场景里，半开连接和会话状态更容易出问题。Client 需要知道能力表是否随连接固定，还是可能动态变化；Server 需要知道 Client 重连后是否会重新初始化，旧请求是否还可能返回。没有生命周期契约，最常见的问题是重连后能力缓存过期，Client 继续调用旧工具，Server 返回一个普通 404，模型完全不知道下一步该怎么办。

演进契约则是长期维护的关键。工具 schema 一旦进入模型上下文，就相当于公开接口。字段改名、枚举收缩、默认值变化、错误码重解释，都可能影响 Agent 行为。比较稳的做法是使用能力探测加兼容期：新增字段可以默认可选，废弃字段保留一段时间，语义变化要升版本，破坏性变化要注册新工具名或新 namespace。不要迷信“只有我们自己的 Client 会用”。只要 Server 被更多 Host 接入，旧调用就会长期存在。

## 架构/流程图解说明

可以把 MCP Client/Server 契约画成一条从连接到审计的链路。重点不是消息怎么编码，而是每一步谁拥有判断权。

```text
Host 启动任务
  |
  v
MCP Client 建立连接
  |
  v
initialize: 协议版本、Client 信息、能力偏好
  |
  v
Server 返回能力声明: tools/resources/prompts/limits/features
  |
  v
Client 生成本地能力目录: 版本、风险、确认策略、schema 缓存
  |
  v
Agent 选择下一步工具
  |
  v
Client 调用前门禁: schema 校验、权限、超时、幂等键、用户确认
  |
  v
Server 执行前门禁: 认证、授权、业务校验、资源预算
  |
  v
业务执行: 读、写、查询、调用外部 API
  |
  v
Server 包装结果: 结构化数据、错误码、诊断、引用、审计 ID
  |
  v
Client 解释结果: 更新 Agent 上下文、记录指标、决定是否重试
```

这条链路里有两个门禁。Client 门禁靠近模型，重点是防止模型把不可靠参数和危险意图直接送到 Server；Server 门禁靠近资源，重点是保证最终安全性。两个门禁不能互相替代。Client 如果不做门禁，用户体验会很差，因为大量本可提前发现的问题会变成工具失败；Server 如果不做门禁，安全性会很差，因为任何绕过 Client 的调用都可能打到真实系统。

能力声明也应该分层。最外层是协议能力，例如是否支持工具调用、资源订阅、取消请求、流式响应。中间层是工具能力，例如工具名、输入输出、风险等级、幂等性。最内层是环境能力，例如当前工作区、租户、可访问仓库、可用配额、只读模式。很多团队只声明中间层，忽略环境能力，结果同一个工具在不同环境下语义不一致。例如 `repo.write_file` 在本地开发环境可写，在 CI 容器里只读，在生产审计模式下只能生成补丁。Client 如果不知道环境差异，就会给模型暴露一个看似可写的工具。

```text
能力目录
  协议层
    - tools: enabled
    - cancellation: supported
    - streaming: partial
  工具层
    - repo.read_file: read-only, idempotent
    - repo.apply_patch: local-write, confirm-required
    - issue.create: external-write, idempotency-key-required
  环境层
    - workspace: /work/project
    - write_mode: patch-only
    - max_request_ms: 15000
    - tenant: team-alpha
```

一次调用的状态机也需要写清楚。没有状态机，调用失败时很难判断能否重试。

```text
prepared
  -> sent
  -> accepted
  -> running
  -> succeeded

prepared
  -> rejected_by_client

sent
  -> rejected_by_server

running
  -> cancelled
  -> timed_out
  -> failed_no_side_effect
  -> failed_side_effect_unknown
```

其中 `failed_no_side_effect` 和 `failed_side_effect_unknown` 的区别非常重要。比如创建 issue 时网络断开，Server 已经把请求发给工单系统，但还没拿到响应。此时 Client 不能简单重试，因为可能已经创建成功。契约里必须允许 Server 返回“副作用状态未知”，并附带查询线索，例如幂等键、外部请求 ID 或建议的查询工具。模型看到这种错误时应该停止自动写入，先查询状态或让用户确认。

## 工程实现

实现契约时，我建议从类型开始，而不是从一堆松散的 map 开始。类型会逼你把运行时责任写出来。下面是一个 Go 里的简化结构，重点表达能力声明、调用上下文和错误分层。

```go
type CapabilitySet struct {
    ProtocolVersion string            `json:"protocolVersion"`
    ServerName      string            `json:"serverName"`
    Features        FeatureFlags      `json:"features"`
    Tools           []ToolContract    `json:"tools"`
    Environment     EnvironmentScope  `json:"environment"`
    Limits          RuntimeLimits     `json:"limits"`
}

type ToolContract struct {
    Name                  string          `json:"name"`
    Version               string          `json:"version"`
    Description           string          `json:"description"`
    InputSchema           json.RawMessage `json:"inputSchema"`
    OutputSchema          json.RawMessage `json:"outputSchema,omitempty"`
    Risk                  RiskLevel       `json:"risk"`
    Idempotency           IdempotencyMode `json:"idempotency"`
    SupportsCancellation  bool            `json:"supportsCancellation"`
    RequiresConfirmation  bool            `json:"requiresConfirmation"`
    DeprecatedAfter       string          `json:"deprecatedAfter,omitempty"`
}

type CallContext struct {
    RequestID       string
    UserID          string
    TenantID        string
    Deadline        time.Time
    IdempotencyKey  string
    TraceID         string
    DryRun          bool
}

type ToolError struct {
    Code            string         `json:"code"`
    Message         string         `json:"message"`
    Retryable       bool           `json:"retryable"`
    ArgumentPath    string         `json:"argumentPath,omitempty"`
    SideEffect      SideEffectInfo `json:"sideEffect"`
    DiagnosticRef   string         `json:"diagnosticRef,omitempty"`
    UserAction      string         `json:"userAction,omitempty"`
}
```

这几个结构里，最值得注意的是 `Idempotency`、`Deadline` 和 `SideEffect`。很多工具系统在早期没有这三个字段，因为 demo 里不需要。到了生产环境，几乎所有难查事故都绕不开它们。没有幂等模式，Client 不知道能不能重试；没有截止时间，Server 会在用户已经放弃后继续执行；没有副作用状态，错误恢复只能靠猜。

在 Server 端，我会把一次调用拆成四个阶段：协议校验、业务预检、执行、结果包装。每个阶段只做自己的事。

```go
func (s *Server) CallTool(ctx context.Context, req ToolRequest) ToolResponse {
    contract, ok := s.registry.Find(req.Name)
    if !ok {
        return ErrorResponse(req.ID, ErrToolNotFound(req.Name))
    }

    if err := ValidateJSON(contract.InputSchema, req.Arguments); err != nil {
        return ErrorResponse(req.ID, ErrInvalidArgument(err))
    }

    callCtx, err := s.prepareCallContext(ctx, req, contract)
    if err != nil {
        return ErrorResponse(req.ID, err)
    }

    if err := s.authorizer.Allow(callCtx, contract, req.Arguments); err != nil {
        return ErrorResponse(req.ID, ErrPermissionDenied(err))
    }

    result, execErr := s.executor.Execute(callCtx, contract, req.Arguments)
    if execErr != nil {
        return ErrorResponse(req.ID, NormalizeExecutionError(execErr))
    }

    return SuccessResponse(req.ID, WrapResult(contract, result))
}
```

这里不要把 `ValidateJSON` 当成安全边界。它只是第一道形状校验。真正的授权在 `authorizer.Allow`，真正的业务合法性在 executor 内部。例如路径工具需要解析真实路径、处理软链、检查工作区根目录；工单工具需要检查用户是否属于项目；云资源工具需要检查租户配额和操作窗口。契约能让这些检查有标准位置，而不是散落在工具函数里。

Client 端则要有一个调用前门禁。我一般会把门禁结果分成允许、需要确认、需要澄清、拒绝四类。

| 门禁结果 | 触发条件 | Agent 下一步 |
| --- | --- | --- |
| allow | 只读或低风险，参数来源可靠 | 直接调用 |
| confirm | 外部写、批量写、风险较高 | 给用户展示预览并等待确认 |
| clarify | 缺少关键参数，模型在猜 | 向用户追问或先调用查询工具 |
| reject | 越权、破坏性操作、策略禁止 | 解释原因，停止调用 |

举一个具体例子：用户说“把刚才失败的 CI 日志贴到 issue 里”。Agent 可能计划调用 `ci.get_failed_logs`，再调用 `issue.append_comment`。第一个工具是只读，可以直接执行。第二个工具是外部可见写，需要检查 issue ID 是否来自用户明确指定或前一步工具结果，评论正文是否包含密钥，是否有幂等键，是否需要预览。如果 issue ID 是模型根据标题猜出来的，门禁应该返回 `clarify`；如果评论正文包含疑似 token，门禁应该返回 `reject` 或要求脱敏；如果一切正常，门禁返回 `confirm`，让用户看到将要追加的内容。

错误模型最好也有固定枚举。不要让每个工具随便返回自然语言错误。下面是一组常用分类：

```text
INVALID_ARGUMENT        参数形状正确但值不合法，模型可以修正
MISSING_ARGUMENT        缺少必需参数，模型应补齐或追问
PERMISSION_DENIED       当前身份无权执行，模型不应重试
RESOURCE_NOT_FOUND      目标不存在，模型可先查询候选资源
CONFLICT                状态冲突，可能需要读取最新状态后再试
RATE_LIMITED            配额或限速，Client 可退避
TIMEOUT                 超过预算，是否重试取决于幂等和副作用状态
CANCELLED               Client 或用户取消
SIDE_EFFECT_UNKNOWN     外部写状态未知，必须查询或人工确认
INTERNAL                Server 内部错误，模型不应猜测修复
```

这些错误码不必一次设计得很复杂，但必须稳定。错误码给机器用，错误消息给人和模型用，诊断引用给开发者用。三者不要混在一起。尤其不要把堆栈和数据库错误直接返回给模型，因为它会把外部错误文本当成上下文事实，甚至在下一步里引用出来。

演进方面，我建议为工具契约维护一个快照测试。每次修改工具描述、schema、风险等级或错误码，都生成一份契约快照，代码评审时看差异。工具契约不是内部实现细节，变化应该像 API 变化一样被审查。例如：

```text
contracts/
  mcp-server.json
  tools/
    repo.read_file.v1.json
    repo.apply_patch.v2.json
    issue.append_comment.v1.json
```

快照测试能发现很多无意变化：字段从必填变成可选，枚举少了一个值，描述删除了副作用说明，风险等级从 external-write 变成 local-write，错误码少了 `CONFLICT`。这些变化不一定都错，但必须被看见。

## 测试评测

MCP Client/Server 契约的测试不能只测“调用成功”。成功路径通常最简单，真正的问题在边界。测试可以分为五层：契约快照、协议兼容、参数门禁、错误恢复和端到端任务评测。

| 测试层 | 目标 | 样例 |
| --- | --- | --- |
| 契约快照 | 防止能力声明无意变化 | schema、描述、风险、错误码 diff |
| 协议兼容 | 确认初始化、请求 ID、取消、超时正常 | 老 Client 调新 Server，新 Client 调老 Server |
| 参数门禁 | 验证危险参数被拦截 | 路径越界、缺少来源、批量写入 |
| 错误恢复 | 验证模型和 Client 的下一步合理 | 参数错误后修正，权限错误后停止 |
| 任务评测 | 验证完整 Agent 工作流 | 修复测试、创建 issue、查询日志并总结 |

契约快照是最低成本的保障。它不需要模型参与，只要比较 JSON。比较时不要只看 schema，还要看描述、风险等级、幂等模式、确认策略和限制。很多事故不是字段变了，而是描述里删掉了“只读”或“不会自动提交”，导致模型选工具时失去边界信号。

协议兼容测试要模拟不同版本。比如 v1 Client 不知道 `supportsCancellation`，Server 仍然要能处理；v2 Client 发送取消请求，老 Server 不支持时要返回明确能力不足，而不是静默忽略；新 Server 把某个工具标记为 deprecated，老 Client 仍可调用但日志里要有告警。兼容测试最好在 CI 里跑一组固定 fixture，而不是靠人工记忆。

参数门禁测试可以写得非常具体。例如对 `repo.apply_patch`：

- 相对路径在工作区内，允许进入确认。
- 绝对路径指向工作区外，拒绝。
- patch 修改超过策略允许的文件数量，需要确认或拒绝。
- 参数 `reason` 来自模型猜测，但工具是外部写，要求澄清。
- 用户开启只读模式，所有写工具都不暴露或被拒绝。

错误恢复测试需要把模型纳入评测，但不要完全依赖主观观察。可以构造固定任务，让模拟 Server 返回不同错误，观察 Agent 下一步是否符合预期。比如 `INVALID_ARGUMENT` 后是否修正参数，`PERMISSION_DENIED` 后是否停止，`RATE_LIMITED` 后是否退避，`SIDE_EFFECT_UNKNOWN` 后是否先查询状态。评测指标可以很朴素：正确停止率、错误重试率、无确认写入次数、泄露诊断信息次数。

端到端任务评测要覆盖真实链路。一个有代表性的用例是“读取失败测试日志，定位相关文件，生成补丁，运行测试，汇报结果”。这里会经过只读工具、本地写工具、长输出压缩、超时、取消、错误归一化。另一个用例是“根据用户描述创建工单并附上证据”，这里会经过外部写、用户确认、幂等键、审计 ID。两类用例结合起来，基本能暴露契约里大部分弱点。

指标上，我会关注这些数：

| 指标 | 说明 | 异常信号 |
| --- | --- | --- |
| tool_call_reject_rate | Client 或 Server 拒绝调用比例 | schema 太宽或模型常猜参数 |
| recoverable_error_success_rate | 可修正错误后的成功率 | 错误信息不够可操作 |
| unknown_error_rate | 未分类错误比例 | 错误模型没有覆盖真实失败 |
| side_effect_unknown_count | 写操作状态未知次数 | 幂等或外部系统回执不足 |
| confirmation_bypass_count | 需要确认却直接执行次数 | 风险声明或门禁策略失效 |
| contract_diff_count | 每次发布契约变化数量 | 工具演进缺少审查 |

这些指标不只是给平台团队看，也应该反馈给工具作者。一个工具如果长期产生大量 `INVALID_ARGUMENT`，往往说明 schema 或描述不够清楚；一个工具如果经常 `TIMEOUT`，可能需要分页、异步任务或更小的默认范围；一个工具如果频繁 `SIDE_EFFECT_UNKNOWN`，说明外部写缺少幂等查询能力。

## 失败模式

第一个失败模式是能力声明过度乐观。Server 把工具都声明出来，但没有声明当前环境限制。例如在只读部署里仍然暴露写工具，或者在未登录状态下暴露需要身份的工具。模型会根据能力表计划任务，后面再失败，用户体验很差。更好的做法是在能力声明阶段就按身份、租户、环境裁剪工具，或者明确标注 disabled reason。

第二个失败模式是 Client 过度信任模型参数。模型生成的 JSON 看起来结构正确，但字段来源不可靠。它可能把用户说的“上次那个 issue”猜成某个 ID，也可能把日志里的路径当成本地路径。写操作必须要求关键参数有可信来源：用户明确提供、前一步可信工具返回、Host 策略注入。缺少来源时要澄清，不要让模型用语言自信填空。

第三个失败模式是 Server 过度信任 Client。即使 Client 是官方实现，Server 仍然要做最终授权。MCP Server 一旦作为独立进程或网络服务存在，就可能被其他 Host 调用。只在 Client 里检查路径、权限和风险，等于把安全边界放在最容易变化的一层。

第四个失败模式是超时后副作用继续发生。用户看到失败，重新发起任务，外部系统出现重复评论、重复工单、重复部署。解决办法是写工具必须有幂等键，Server 在超时前尽量返回外部请求引用，Client 对未知副作用不自动重试。对无法幂等的操作，要把契约标记为不可重试，并要求人工确认。

第五个失败模式是错误信息污染模型上下文。外部系统错误可能包含 SQL、路径、用户名、内部服务名，甚至用户输入的恶意文本。如果 Server 原样返回，模型会把它当成事实或指令继续推理。错误契约应该把用户可见消息、模型可见修正建议、开发者诊断分开，并对外部文本做引用隔离。

第六个失败模式是契约演进没有废弃期。字段一删，老 Client 立即坏；工具语义一改，模型行为悄悄变；错误码一合并，恢复策略失效。任何已经发布给 Client 的契约都要有兼容策略。实在要破坏性变化，就注册新工具名或新版本，并在能力声明里同时暴露一段时间。

第七个失败模式是日志无法串起一次调用。没有 request ID、trace ID、idempotency key 和 audit ID，出了问题只能靠时间戳猜。Agent 工作流往往包含多次工具调用，一次外部写可能由前面三次查询铺垫而来。日志必须能从用户任务追到模型计划、Client 门禁、Server 执行和外部系统回执。

## 上线 checklist

上线 MCP Client/Server 契约前，我会用下面的清单过一遍。它不追求复杂，但每一项都要能在代码、配置或测试里找到证据。

- 能力声明包含协议版本、Server 名称、工具列表、输入 schema、风险等级、幂等模式、确认策略和运行限制。
- Client 不硬编码工具存在，所有调用都来自当前连接的能力目录。
- 工具调用都有 request ID、trace ID、deadline，写操作还有 idempotency key 或明确标注不可重试。
- Client 调用前执行 schema 校验、参数来源检查、权限策略检查和确认策略判断。
- Server 对所有参数做最终授权和业务校验，不依赖 Client 已经检查。
- 错误码稳定分层，至少区分参数错误、权限错误、资源不存在、冲突、限速、超时、取消、未知副作用和内部错误。
- 错误响应不把敏感诊断、密钥、完整堆栈或外部指令文本直接塞进模型上下文。
- 取消请求和超时有明确行为，Server 不在取消后继续执行危险写操作。
- 能力快照进入版本控制，工具契约变化需要代码评审。
- 有老 Client 调新 Server、新 Client 调老 Server 的兼容测试。
- 有危险参数、路径越界、批量写、权限不足、未知副作用的负向测试。
- 有端到端 Agent 任务评测，覆盖只读、本地写、外部写和失败恢复。
- 日志能按 request ID 串起 Client、Server 和外部系统调用。
- 指标能看到拒绝率、可恢复错误成功率、未知错误率、确认绕过次数和契约变化次数。
- 文档写清楚每个工具的副作用、重试策略、确认策略和废弃计划。

## 总结

MCP Client/Server 契约的价值，在于把“模型应该怎么调用工具”变成可验证、可观测、可演进的工程边界。工具描述和 schema 只是开始，真正稳定的系统还需要能力声明、调用生命周期、错误分层、幂等策略、确认门禁、兼容测试和审计链路。

如果只做 demo，很多问题可以靠提示词、人工观察和一次性实现绕过去。但只要工具接入真实文件、工单、代码仓库、云资源和团队协作系统，隐含约定就会迅速变成风险。Client 不知道 Server 的真实能力，会计划错误；Server 不知道 Client 的超时和重试，会产生重复副作用；模型看不到结构化错误，会在失败后继续猜。

我更推荐的做法是把契约当成产品的一部分维护。每个工具上线前，先问它的能力是否声明完整，参数来源是否可检查，错误是否可恢复，副作用是否可审计，版本是否可演进。做到这些，MCP 才不只是“模型调用函数”的胶水，而是一个可以支撑长期工程协作的工具边界。
