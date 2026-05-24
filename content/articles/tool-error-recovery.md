---
slug: tool-error-recovery
url: /notes/tool-error-recovery/
title: 工具失败后的恢复策略
summary: 工具失败不是异常路径，而是 Agent 系统每天都会遇到的正常状态。
categoryKey: agents
category: AI Agent
categoryLabel: AI Agent 设计
source: NOTES/AGENT
date: 2026-04-25
image: /assets/article-visuals/tool-error-recovery.svg
tags:
  - Recovery
  - Agent
---

![标题图](/assets/article-visuals/tool-error-recovery.svg)

## 问题背景

Agent 一旦接入工具，就会进入一个不稳定的世界。文件可能不存在，命令可能返回非零，网络可能超时，浏览器页面可能换了结构，数据库可能锁表，第三方 API 可能限流，权限可能过期，用户也可能在 Agent 执行期间改了同一个对象。很多 demo 把工具失败当成少见异常，生产系统却会发现：工具失败是日常路径，不是边角路径。

如果 Agent 没有恢复策略，工具失败后的行为通常有三种坏味道。第一种是盲目重试。比如写入远程工单超时后，系统不知道请求是否已经成功，于是再次提交，最后生成两个重复工单。第二种是过早放弃。比如一次 `rg` 没搜到结果，Agent 直接判断仓库没有相关代码，却没有换关键字、检查路径或读取索引。第三种是错误解释。比如测试失败明明是依赖服务没启动，Agent 却开始改业务代码。问题不在模型不会推理，而在工具错误没有被分类、没有进入状态、没有绑定恢复动作。

恢复策略的目标不是把所有失败自动修好。工程系统里有些失败应该自动重试，有些失败应该换路径，有些失败应该降级，有些失败应该暂停并问用户，有些失败必须停止以避免扩大副作用。一个好的 Agent 不应该把“失败”统一翻译成“再试一次”或“任务失败”，而应该先判断失败发生在哪一层、有没有副作用、是否可重放、是否需要刷新证据、继续执行会不会违反用户约束。

工具失败还会影响用户信任。用户可以接受 Agent 告诉他“命令失败了，我已经定位到依赖缺失，需要你决定是否安装”；很难接受 Agent 在失败后胡乱修改更多文件，最后说“已完成”。恢复策略把失败过程变得可见：失败类型是什么，系统尝试了什么，哪些动作被禁止，当前是否安全，下一步需要谁处理。这比一句“出现错误，请重试”有用得多。

做 Agent 平台时，我倾向把工具恢复当成一等能力，而不是每个工具各写一段 `try/catch`。原因很简单：不同工具的错误表现不同，但恢复决策需要统一上下文。一个命令超时，如果是只读搜索，可以换参数再试；如果是支付退款，就必须查幂等记录；如果是写文件，可能要检查工作区差异；如果是浏览器点击，可能要重新定位元素。恢复引擎需要知道任务目标、当前状态、工具风险、历史事件和用户约束，单个工具函数通常拿不到这些信息。

更重要的是，工具失败会污染模型上下文。大量错误堆栈、命令输出和 HTML 片段很容易把关键事实淹没。恢复策略要把原始错误归纳成结构化观察：错误类别、可恢复性、证据、影响范围、建议动作。模型可以读取这个观察来制定下一步，而不是在几千行日志里猜。对长任务来说，这一点尤其关键，因为上下文会压缩，压缩后只剩下被结构化保存的信息。

## 核心概念

工具恢复的第一步是错误分类。不要只保存 `error: true`。一个实际可用的分类至少要覆盖：输入错误、权限错误、资源不存在、临时网络错误、超时、限流、冲突、部分成功、环境缺失、断言失败、不可逆失败、未知错误。分类不是为了做报表，而是为了决定下一步。

| 错误类别 | 典型表现 | 默认恢复动作 | 是否自动重试 |
| --- | --- | --- | --- |
| 输入错误 | 参数格式不对、路径拼错 | 修正参数或回到规划 | 通常不重试 |
| 权限错误 | 401、403、沙箱拒绝 | 请求授权或改用允许范围 | 不自动重试 |
| 资源不存在 | 文件缺失、记录被删 | 刷新上下文、确认目标 | 不直接重试 |
| 临时网络错误 | 连接重置、DNS 抖动 | 指数退避重试 | 可重试 |
| 超时 | 命令或 API 超过时限 | 判断副作用后重试或查询状态 | 视风险而定 |
| 限流 | 429、配额不足 | 等待、降频、切换队列 | 延迟重试 |
| 冲突 | 版本不匹配、锁冲突 | 读取最新状态、合并或询问 | 不盲重试 |
| 部分成功 | 批处理一半成功 | 记录成功集合，补偿或续跑 | 按幂等键续跑 |
| 环境缺失 | 缺依赖、服务未启动 | 提示安装或启动前置服务 | 需要策略 |
| 断言失败 | 测试失败、校验不通过 | 分析原因，回到计划 | 不当作工具故障重试 |
| 不可逆失败 | 外部系统已产生副作用但结果异常 | 停止并升级人工 | 不重试 |
| 未知错误 | 无法分类的异常 | 保存证据，保守暂停 | 限制重试 |

第二个概念是副作用感知。工具恢复必须先问：刚才的调用有没有可能已经改变了外部世界。只读搜索超时和创建订单超时完全不是一回事。对只读工具，重试通常安全；对本地写文件，可以通过工作区 diff 判断；对远程写入，必须依赖幂等键、查询接口或人工确认；对不可逆动作，宁可停住，也不要靠猜测继续。

第三个概念是幂等性。每一次有副作用的工具调用都应该带幂等键，键通常由 `task_id`、`step_id`、工具名和规范化参数哈希组成。工具网关在执行前查幂等记录，执行后保存结果。这样超时后再次调用时，系统可以先查询上一次结果，而不是直接重复执行。很多 Agent 恢复事故，本质上是没有幂等账本。

第四个概念是恢复预算。自动恢复不能无限循环。每个错误类别都应该有重试次数、等待时间和升级条件。比如临时网络错误可以重试三次，限流可以等待到重置窗口，未知错误最多重试一次，写操作状态不明时直接暂停。恢复预算既保护外部系统，也保护用户时间。

第五个概念是观察归纳。工具返回的原始错误要保存，但模型下一轮应该看到的是结构化摘要。例如“`go test ./...` 失败，失败包为 `internal/cache`，错误是断言期望 2 得到 3，发生在最近修改之后，属于验证失败，不建议重试命令，建议读取相关测试和实现”。这个摘要比完整日志更适合决策。

第六个概念是补偿动作。有些部分成功无法简单回滚，但可以补偿。比如批量创建标签时成功了 8 个、失败了 2 个，恢复动作不是重跑全部，而是记录成功集合，只对失败集合续跑；如果创建了错误标签，可能需要删除或标记废弃。补偿必须显式进入计划，不要让模型在自然语言里随手说“我会处理”。

## 架构/流程图解说明

一个健壮的工具调用链路应该把“执行”和“恢复”分开，但共享同一份事件日志。

```text
模型提出工具意图
  |
  v
工具网关预检
  |-- 参数规范化
  |-- 权限检查
  |-- 幂等键生成
  |-- 风险级别判断
  |
  v
执行工具
  |
  v
结果分类器
  |-- 成功
  |-- 可重试失败
  |-- 需要刷新上下文
  |-- 状态不明
  |-- 不可恢复失败
  |
  v
恢复决策器
  |-- 立即重试
  |-- 退避等待
  |-- 查询副作用状态
  |-- 降级替代工具
  |-- 回到计划
  |-- 暂停并询问用户
  |
  v
事件日志和任务状态更新
```

这条链路里，结果分类器不要只看错误字符串。它要结合工具元数据、退出码、HTTP 状态码、标准错误、调用耗时、风险级别和历史事件。比如同样是超时，读网页超时可以重试，远程写入超时要先查幂等结果；同样是命令返回 1，`grep` 没搜到内容可能是正常结果，测试命令返回 1 才是验证失败。

恢复决策可以用一个二维矩阵来表达：一维是错误类别，另一维是副作用级别。

| 副作用级别 | 输入错误 | 临时错误 | 超时 | 部分成功 | 未知错误 |
| --- | --- | --- | --- | --- | --- |
| 只读 | 修参数 | 重试 | 重试或缩小范围 | 不适用 | 重试一次后暂停 |
| 本地写 | 回到计划 | 检查文件后重试 | 查 diff 再决定 | 按文件集合补齐 | 保留 diff 并暂停 |
| 远程可幂等写 | 修参数 | 查幂等后重试 | 查幂等结果 | 按成功集合续跑 | 查询状态并暂停 |
| 远程不可逆写 | 停止 | 停止并人工判断 | 停止并查询外部系统 | 补偿计划需确认 | 停止 |

状态图可以更细一些：

```text
tool_requested
  -> prechecked
  -> running
  -> succeeded
  -> observed

running -> failed_classified -> retry_scheduled -> running
running -> failed_classified -> refresh_context -> tool_requested
running -> failed_classified -> compensation_planned -> waiting_user
running -> failed_classified -> blocked
running -> ambiguous_effect -> effect_probe -> succeeded
running -> ambiguous_effect -> waiting_user
```

`ambiguous_effect` 是恢复设计里非常重要的状态。它表示系统不知道副作用是否已经发生。比如 HTTP 请求发出后连接断开，客户端没有收到响应，但服务端可能已经处理。这个状态下最危险的动作是直接重试。正确做法是先用幂等键查询、读取外部对象、检查本地 diff，或者暂停让用户确认。

一个具体例子：Agent 调用 GitHub API 创建 issue，网络超时。没有恢复策略的系统可能再次调用创建接口。带恢复策略的系统会用同一个幂等键或唯一标题标识查询最近创建的 issue；如果查到，就记录成功并继续；如果查不到，且 API 文档说明幂等键有效，可以重试；如果既查不到又没有幂等保证，就进入 `waiting_user`，告诉用户“请求状态不明，直接重试可能创建重复 issue”。

另一个例子：Agent 运行 `go test ./...` 失败。这个失败不应该进入工具重试，除非错误是测试进程被系统杀掉或依赖下载超时。如果失败内容是断言不通过，它属于验证观察，恢复动作是读取失败测试、定位代码、调整计划。把验证失败当成临时工具失败，会导致系统重复跑同一个必然失败的命令，浪费时间还污染日志。

## 工程实现

工具恢复首先要有统一的结果结构。不要让每个工具返回任意字符串，然后让模型自己猜。

```go
type ToolResult struct {
    CallID        string
    ToolName      string
    IdempotencyKey string
    Risk          RiskLevel
    Status        ToolStatus
    ErrorClass    ErrorClass
    ExitCode      *int
    HTTPStatus    *int
    OutputSummary string
    RawLogRef     string
    Effect         EffectState
    StartedAt     time.Time
    FinishedAt    time.Time
}

type ToolStatus string

const (
    ToolSucceeded ToolStatus = "succeeded"
    ToolFailed    ToolStatus = "failed"
    ToolAmbiguous ToolStatus = "ambiguous"
)

type EffectState string

const (
    EffectNone      EffectState = "none"
    EffectConfirmed EffectState = "confirmed"
    EffectPartial   EffectState = "partial"
    EffectUnknown   EffectState = "unknown"
)
```

错误分类器可以从规则开始，后面再让模型辅助解释复杂日志。规则负责可靠边界，模型负责语义归纳。例如 HTTP 401/403 一定是权限类，429 是限流，超时由运行时标记，测试断言失败可以由命令适配器识别。模型不要被允许把 403 解释成“也许重试会好”。

```go
func Classify(result RawToolResult, meta ToolMeta) ClassifiedFailure {
    if result.Timeout {
        if meta.Risk.IsWrite() {
            return ClassifiedFailure{Class: ErrTimeout, Effect: EffectUnknown}
        }
        return ClassifiedFailure{Class: ErrTimeout, Effect: EffectNone}
    }
    if result.HTTPStatus == 401 || result.HTTPStatus == 403 {
        return ClassifiedFailure{Class: ErrPermission, Effect: EffectNone}
    }
    if result.HTTPStatus == 429 {
        return ClassifiedFailure{Class: ErrRateLimited, Effect: EffectNone}
    }
    if meta.Kind == ToolTestCommand && result.ExitCode != 0 {
        return ClassifiedFailure{Class: ErrAssertionFailed, Effect: EffectNone}
    }
    return ClassifiedFailure{Class: ErrUnknown, Effect: meta.DefaultEffectOnFailure}
}
```

恢复决策器根据分类、风险、预算和任务状态生成下一步动作：

```go
type RecoveryAction struct {
    Kind       RecoveryKind
    Delay      time.Duration
    Reason     string
    MaxAttempts int
    Probe      *ProbeSpec
    UserPrompt string
}

func DecideRecovery(state TaskState, result ToolResult) RecoveryAction {
    budget := state.RecoveryBudget.For(result.ToolName, result.ErrorClass)

    if budget.Exhausted() {
        return RecoveryAction{Kind: RecoveryBlock, Reason: "recovery budget exhausted"}
    }
    if result.Effect == EffectUnknown {
        if probe := buildEffectProbe(result); probe != nil {
            return RecoveryAction{Kind: RecoveryProbeEffect, Probe: probe, Reason: "effect is ambiguous"}
        }
        return RecoveryAction{Kind: RecoveryAskUser, UserPrompt: explainAmbiguousEffect(result)}
    }
    switch result.ErrorClass {
    case ErrTransientNetwork:
        return RecoveryAction{Kind: RecoveryRetry, Delay: budget.NextBackoff()}
    case ErrRateLimited:
        return RecoveryAction{Kind: RecoveryWait, Delay: result.RetryAfter()}
    case ErrPermission:
        return RecoveryAction{Kind: RecoveryAskUser, UserPrompt: "permission is missing"}
    case ErrAssertionFailed:
        return RecoveryAction{Kind: RecoveryReplan, Reason: "verification failed"}
    default:
        return RecoveryAction{Kind: RecoveryBlock, Reason: "unknown failure requires inspection"}
    }
}
```

幂等记录可以设计成一张表或一个键值存储：

| 字段 | 说明 |
| --- | --- |
| `idempotency_key` | 规范化后的唯一键 |
| `task_id` | 所属任务 |
| `step_id` | 所属计划步骤 |
| `tool_name` | 工具名 |
| `arguments_hash` | 参数哈希 |
| `status` | running、succeeded、failed、ambiguous |
| `effect_ref` | 外部对象 ID、本地文件 hash 或补偿记录 |
| `result_ref` | 原始结果存储位置 |
| `created_at` / `updated_at` | 时间 |

执行前先查幂等表。如果同一个键已经成功，直接返回之前的结果摘要；如果是 `running` 且未超时，可以等待；如果是 `ambiguous`，先走副作用探测；如果参数哈希不同但 step 相同，要拒绝复用。这个机制听起来像基础设施细节，但对 Agent 很关键，因为模型在失败后很容易再次提出相似动作。

工具适配器要负责把领域细节翻译成统一语义。以 shell 命令为例，退出码 1 在不同命令里含义不同：`grep` 的 1 可能表示没匹配，`go test` 的 1 表示测试失败，`eslint` 的 1 可能是规则违反。适配器应该把这些差异编码清楚。

```go
func AdaptShellResult(cmd CommandSpec, raw RawProcessResult) ToolResult {
    switch cmd.Semantics {
    case SemSearch:
        if raw.ExitCode == 1 {
            return successWithSummary("no matches found")
        }
    case SemTest:
        if raw.ExitCode != 0 {
            return failed(ErrAssertionFailed, summarizeTestFailure(raw.Stderr))
        }
    case SemBuild:
        if raw.ExitCode != 0 && strings.Contains(raw.Stderr, "permission denied") {
            return failed(ErrPermission, "build cannot access required path")
        }
    }
    return defaultProcessMapping(raw)
}
```

恢复后的上下文也要控制。给模型的不是“工具失败了”，而是：

```text
工具：go test ./...
阶段：验证
分类：断言失败，不是临时工具错误
证据：internal/cache/cache_test.go:42 期望 2 得到 3
影响：最近一次修改后出现，验收未通过
禁止动作：不要重复运行同一命令，除非代码或环境发生变化
建议动作：读取失败测试和相关实现，更新计划
```

这个结构会显著降低模型误判。它明确告诉模型失败的语义和恢复边界。对复杂日志，可以让模型参与摘要，但摘要结果仍要写回结构化字段，并保留原始日志引用。

恢复策略还需要和工具选择器联动。很多失败不是原工具必须成功，而是当前证据目标没有达成。比如浏览器抓取页面失败，目标可能只是确认某个按钮是否存在；系统可以改用接口响应、静态 HTML、截图 OCR 或本地测试来获得证据。这里的关键是记录“替代工具能证明什么，不能证明什么”。如果替代证据只说明页面文本存在，不能说明按钮可点击，就不能把它当成交互验证通过。恢复引擎应该把证据强度写入观察，例如 `strong_interaction`、`weak_content`、`environment_only`。模型后续做计划时，就能区分“已经验证功能可用”和“只是找到了线索”。

对本地开发工具，还要处理工作区污染。命令失败后可能留下临时文件、半写入产物、缓存目录或格式化后的文件。恢复前应先判断这些变化是不是预期副作用。一个实用做法是在高风险步骤前记录工作区快照：文件列表、目标文件 hash、构建产物目录和计划写入路径。失败后比较快照，生成“预期变化”和“意外变化”两类观察。预期变化可以进入后续验证，意外变化要么清理，要么暂停确认。Agent 最怕在脏工作区里继续推理，因为后续测试结果可能来自半成品，而不是当前计划。

## 测试评测

工具恢复的测试要覆盖“失败是否被正确解释”，而不是只覆盖“失败后有没有返回错误”。我会建立一套故障样本库，每个样本包含工具、输入、原始输出、预期错误分类、预期恢复动作和副作用判断。

| 样本 | 原始情况 | 预期分类 | 预期恢复 |
| --- | --- | --- | --- |
| 只读搜索超时 | `rg` 扫描大目录超时 | 超时、无副作用 | 缩小范围或重试 |
| 测试断言失败 | `go test` 返回断言差异 | 验证失败 | 回到计划，不重试 |
| API 429 | 第三方接口限流 | 限流 | 等待 retry-after |
| 远程写超时 | 创建 issue 请求超时 | 状态不明 | 查询幂等结果 |
| 文件冲突 | 写入时发现版本变化 | 冲突 | 读取最新 diff，重新规划 |
| 权限拒绝 | 沙箱拒绝写系统目录 | 权限错误 | 停止或请求授权 |
| 批处理半成功 | 10 个对象成功 7 个 | 部分成功 | 记录成功集合，补齐失败集合 |

单元测试可以直接验证分类器：

```go
func TestWriteTimeoutHasUnknownEffect(t *testing.T) {
    raw := RawToolResult{Timeout: true}
    meta := ToolMeta{Risk: RiskRemoteWrite}
    got := Classify(raw, meta)
    if got.Effect != EffectUnknown {
        t.Fatalf("expected unknown effect, got %s", got.Effect)
    }
}
```

场景测试更重要。模拟一次远程写入超时：第一次调用返回超时，副作用未知；恢复决策器生成 `ProbeEffect`；探测接口返回对象已创建；任务状态记录工具成功，而不是再次创建。这个测试能证明系统真的避免了重复副作用。

还要测试恢复预算。给同一个临时网络错误连续失败四次，前三次退避重试，第四次进入阻塞并给出原因。预算测试可以防止系统在生产里无限轮询。限流测试要验证 `Retry-After` 被尊重，而不是所有错误都用固定 sleep。

评测指标建议至少包含：

| 指标 | 说明 |
| --- | --- |
| 错误分类准确率 | 故障样本库中分类正确比例 |
| 恢复动作准确率 | 分类后选择的动作是否符合预期 |
| 重复副作用次数 | 因恢复导致重复写入的次数 |
| 无效重试次数 | 没有改变条件却重复执行的次数 |
| 平均恢复时长 | 从失败到继续执行或阻塞的时间 |
| 人工升级命中率 | 升级给用户的问题是否确实需要判断 |
| 未知错误占比 | 分类体系覆盖不足的信号 |

对于 Agent 系统，还需要做模型对抗评测。构造一些错误摘要，让模型倾向于做危险动作，例如“虽然创建 issue 超时，但你可以再试一次”。控制器应该拒绝不安全重试。也要测试模型在验证失败后是否会重复跑同一命令；如果代码和环境没有变化，恢复策略应提示它先分析失败原因。

最后，恢复评测要接近真实运行。可以在测试环境里注入网络抖动、随机杀掉进程、修改工作区文件、让外部 API 返回重复请求、制造批处理部分成功。每次注入后观察事件日志是否足够解释：失败在哪里，系统做了什么，为什么继续或暂停。日志如果只能给开发者看懂，不足以支撑用户协作；用户可读摘要也要纳入评测。

## 失败模式

第一种失败模式是把所有异常都当成可重试。自动重试看起来能提升成功率，但对写操作很危险。没有副作用判断和幂等键的重试，会制造重复数据、重复通知、重复扣费或重复提交。只读工具可以乐观一点，写工具必须保守。

第二种失败是把验证失败误认为工具失败。测试不通过、lint 不通过、业务校验不通过，通常说明交付物还不满足要求，而不是工具坏了。恢复动作应该是分析原因和修改计划，而不是重复执行同一命令。只有环境错误、进程被杀、依赖下载失败这类情况才适合按工具故障处理。

第三种失败是错误分类完全依赖模型。模型可以帮助解释复杂日志，但基础分类必须由工具适配器和规则兜底。HTTP 状态码、退出码、超时、权限拒绝、限流头都是确定信号，不应该交给模型自由发挥。模型的作用是补充语义，不是替代协议。

第四种失败是只保存最终错误消息，不保存原始证据。恢复和审计都需要知道当时的参数、输出、时间、环境和副作用。只存一句“调用失败”无法判断是否可以重试，也无法复盘用户事故。原始日志可以不进模型上下文，但必须有引用。

第五种失败是没有部分成功模型。批处理任务很少只有全成或全败。发十封邮件、建十个标签、处理十个文件，都可能成功一部分。没有部分成功模型，系统要么重复处理成功项，要么丢掉失败项。恢复策略应该把成功集合、失败集合和补偿动作记录清楚。

第六种失败是降级路径没有质量边界。比如网页抓取失败后改用搜索缓存，或者 AST 解析失败后改用文本搜索，这些降级可以提高韧性，但必须标记置信度和限制用途。不能用降级得到的弱证据去执行高风险写操作。降级结果更适合帮助探索，不适合直接作为最终验收。

第七种失败是用户提示不具体。Agent 说“工具失败了，要继续吗”，用户很难判断。好的提示应该说明工具、错误类别、已经发生的副作用、继续选项和风险。例如“创建远程 issue 的请求超时，系统无法确认是否已创建；直接重试可能产生重复 issue；我可以先按标题查询最近 issue，或由你在 GitHub 确认后继续”。这种提示才是可协作的。

第八种失败是恢复动作没有回写计划。系统临时决定降级、跳过或补偿，如果不写回计划，后续模型可能忘记这个决定。恢复不是一段旁路逻辑，它会改变任务路线，必须进入任务状态和最终报告。

## 上线 checklist

上线工具恢复能力前，建议逐项检查：

- 每个工具都有元数据：只读还是写入、本地还是远程、是否幂等、默认超时和错误语义。
- 工具结果统一返回结构化字段，不让模型只面对任意字符串错误。
- 有明确错误分类，并为权限、限流、超时、冲突、部分成功、验证失败和未知错误设置默认策略。
- 所有写操作都有幂等键或明确声明不可幂等；不可幂等写操作失败后默认人工升级。
- 状态不明的远程写入会先探测副作用，不会直接重试。
- 恢复预算可配置，包含最大次数、退避策略、总耗时和升级条件。
- 原始日志和结构化摘要都被保存，摘要进入模型上下文，原始日志用于审计。
- 验证失败不会被自动重试，除非环境或输入发生变化。
- 部分成功有成功集合、失败集合和补偿计划，不会重跑全量。
- 降级路径会标记证据强度，弱证据不能直接驱动高风险写入。
- 用户提示包含风险、选项和推荐动作，不只展示“是否继续”。
- 指标能看到错误分类分布、无效重试、重复副作用、恢复耗时和人工升级原因。

上线后还要定期复盘未知错误。未知错误占比高，说明分类体系太粗；无效重试多，说明恢复策略没有识别条件是否变化；人工升级多但用户选择很固定，说明可以把某些策略自动化；重复副作用一旦出现，要优先修幂等和状态不明处理，而不是只调 prompt。

## 总结

工具失败后的恢复策略，是 Agent 从原型走向生产的分水岭。原型可以假设工具大多成功，生产必须假设失败每天发生。真正可靠的系统不会把失败简单交给模型自由处理，而是先分类、判断副作用、检查幂等、消耗恢复预算、记录观察，再决定重试、降级、补偿、重新规划或升级人工。

这套机制听起来像传统工程基础设施，但 Agent 更需要它。因为 Agent 会把工具结果继续用于推理，错误如果没有被正确归纳，就会在后续计划里放大。一个测试失败被误判成临时错误，会导致无效重试；一个远程写超时被误判成未执行，会导致重复副作用；一个权限错误被误判成路径错误，会让 Agent 在错误方向上越走越远。

我的建议是从统一 `ToolResult`、错误分类、幂等记录和恢复预算开始做。先把高风险工具管住，再逐步覆盖只读工具的降级和复杂日志摘要。恢复策略做得好，用户不会只看到“失败了”，而是看到一个专业执行系统在失败后仍然知道边界、证据和下一步。这是 Agent 工程化必须具备的基本能力。
