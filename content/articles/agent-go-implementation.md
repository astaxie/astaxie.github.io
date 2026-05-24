---
slug: agent-go-implementation
url: /notes/agent-go-implementation/
title: 用 Go 写 Agent 后端
summary: Go 适合承载工具执行、并发任务、队列和稳定服务边界。
categoryKey: agents
category: AI Agent
categoryLabel: AI Agent 设计
source: NOTES/AGENT
date: 2026-04-16
image: /assets/article-visuals/agent-go-implementation.svg
tags:
  - Go
  - Agent
---

![标题图](/assets/article-visuals/agent-go-implementation.svg)

## 问题背景

用 Go 写 Agent 后端，真正的挑战不是把一次模型调用封装成 HTTP 接口。那只是最薄的一层。Agent 后端要承担的是一个长时间运行、会调用外部工具、会保存中间状态、会处理权限和人工确认、会在失败后恢复的执行系统。它既要接住模型的不确定性，也要给业务系统提供确定的边界。Go 在这里很合适，因为它擅长构建稳定服务、并发调度、网络网关、队列消费者和清晰的接口层。

很多早期 Agent 原型是一个脚本：读用户输入，拼 prompt，调用模型，解析工具调用，再递归跑几轮。这种写法适合验证想法，但不适合生产。生产环境里，一个任务可能跑几十秒甚至几小时；用户可能关闭页面后再回来；工具可能超时；模型可能输出无法解析的结构；同一个任务可能被重复提交；某个步骤可能需要人审批；任务执行到一半服务重启了。脚本式循环很快会被这些问题击穿。

Go 后端要解决的，是把 Agent 从“会聊天的函数”变成“可运营的任务系统”。这个系统要有明确的 run 状态机，要能把计划和执行分开，要能把工具调用放进受控网关，要能把模型请求集中治理，要能把每一步写入事件日志，要能让任务被取消、恢复、重试和审计。模型仍然重要，但模型只是系统里的一个决策源，不应该成为所有工程边界的替代品。

选择 Go 还有一个现实原因：Agent 后端通常会贴近企业内部服务。它要连数据库、对象存储、消息队列、权限系统、审计系统、搜索服务、代码仓库、工单系统和通知系统。Go 的标准库、上下文取消、接口组合、结构化并发习惯、部署体积和运行稳定性，都很适合做这种“中间层”。当 Agent 开始从 demo 走向多租户和高并发，服务边界比提示词技巧更决定可维护性。

不过，用 Go 写 Agent 也不能把模型当作普通 RPC。普通 RPC 的输入输出 schema 稳定，失败通常有错误码；模型输出可能半结构化，可能自相矛盾，可能需要二次解析，可能要求澄清，可能建议一个被策略禁止的动作。后端要把这种不确定性吸收在运行时内部，对外暴露稳定的任务状态和产物。用户不需要知道模型这轮返回了什么奇怪字段，业务系统也不应该因为模型一次格式漂移就产生副作用。

这篇文章讨论的不是某个框架，而是一套我认为可落地的 Go Agent 后端骨架。重点放在状态机、队列、工具执行、模型网关、上下文组装、评测、失败恢复和上线清单。你可以用 PostgreSQL、Redis、NATS、Kafka 或云厂商队列替换具体组件，但核心边界最好不要省。

## 核心概念

第一个概念是 `Run`。一次用户目标对应一个 run，它是系统对用户的承诺。run 有状态、有所有者、有租户、有入口、有当前步骤、有产物、有审计记录。不要把 run 等同于 HTTP 请求。HTTP 请求可能很快结束，但 run 可以继续执行、等待确认、失败后恢复，也可以被用户取消。

第二个概念是 `Step`。Agent 不是一次性完成任务，而是分步骤推进。一个 step 可以是模型规划、上下文构建、工具调用、人工确认、文件生成、消息发送或状态检查。把 step 记录下来，系统才能知道任务卡在哪里，也才能在重启后从合理位置继续。没有 step，长任务恢复只能靠猜。

第三个概念是 `Tool`。工具不是模型随便调用的函数，而是后端暴露给 Agent 的受控能力。每个工具要有 schema、权限检查、超时、幂等键、dry-run 能力、审计摘要和错误分类。模型可以提出“我要调用某工具”，但后端要决定是否允许、如何执行、如何记录、失败是否可重试。

第四个概念是 `Model Gateway`。不要让业务代码到处直接请求模型。模型网关负责模型选择、超时、重试、token 预算、结构化输出解析、敏感信息处理、trace 记录和成本统计。这样后续换模型、做灰度、加评测、加缓存或加安全策略，才不会在代码库里四处开口子。

第五个概念是 `State Machine`。Agent run 的状态应该少而清晰，例如 `queued`、`running`、`waiting_human`、`completed`、`failed`、`cancelled`。内部可以有更多 step 状态，但对外 run 状态要稳定。状态迁移要集中管理，不要散落在各个 handler 和 goroutine 里。否则重复提交、并发取消、审批回调和 worker 重试会互相打架。

| 对象 | Go 后端职责 | 不建议的做法 |
| --- | --- | --- |
| Run | 管理任务生命周期、租户、状态和产物 | 把一次 HTTP 请求当完整任务 |
| Step | 记录执行阶段、输入输出摘要和错误 | 只在日志里打印模型返回 |
| Tool | 统一权限、超时、幂等、审计和错误分类 | 让模型直接拼外部 API 请求 |
| Model Gateway | 管理模型调用、解析、成本和 trace | 在业务 handler 里散落调用 SDK |
| Queue Worker | 异步推进长任务和重试 | 前端连接不断开就一直同步跑 |
| Event Store | 保存可回放事件 | 只保存最终答案 |

这些概念的核心，是把 Agent 的不确定性关在内部，把稳定契约留给外部。外部系统只看到“创建任务、查询状态、确认动作、取消任务、读取产物”。内部可以多轮模型调用、多次工具尝试、多次上下文压缩，但每一步都有记录、有权限、有超时、有恢复策略。

## 架构/流程图解说明

一个简洁的 Go Agent 后端可以这样拆：

```text
HTTP / WebSocket / RPC
  |
  v
API Layer
  |-- CreateRun
  |-- GetRun
  |-- ConfirmAction
  |-- CancelRun
  v
Run Service
  |-- 状态机、权限入口、幂等提交、产物查询
  v
Queue
  |
  v
Worker Pool
  |-- Planner
  |-- Context Builder
  |-- Model Gateway
  |-- Tool Gateway
  |-- Policy Engine
  |-- Artifact Store
  v
Event Store / SQL DB / Object Storage / Observability
```

请求进入 API 层后，不应该同步跑完整 Agent。更稳妥的做法是创建 run，写入数据库，发送队列消息，然后返回 `run_id`。前端可以通过轮询、SSE 或 WebSocket 看状态变化。这样用户网络断开不会杀死任务，服务重启后 worker 可以重新领取，耗时任务也不会占住 HTTP handler。

worker 领取 run 时要使用租约。租约解决两个问题：避免多个 worker 同时执行同一个 run；worker 崩溃后任务可以被其他 worker 接管。数据库里可以有 `locked_by` 和 `lock_until` 字段，领取时用条件更新实现。队列至少一次投递时，幂等和租约非常关键。不要假设消息只会来一次。

状态机应由 Run Service 控制。比如 `queued -> running` 只能由 worker 成功领取后发生；`running -> waiting_human` 只能由策略要求确认时发生；`waiting_human -> queued` 只能由用户确认后发生；任何非终态都可以被取消；终态不能再执行。把这些规则写在一个地方，比在每个调用点写 if 更安全。

工具执行走 Tool Gateway。Tool Gateway 接收标准化的 `ToolCall`，先做 schema 校验，再做权限检查，再计算幂等键，再执行 dry-run 或真实调用，最后写事件。对于外部写操作，默认应该先 dry-run，返回影响范围，让策略决定是否需要人工确认。确认后再用同一个幂等键提交，防止重复执行。

模型调用走 Model Gateway。Planner 不直接依赖某个模型 SDK，而是依赖一个接口。这个接口返回结构化结果，例如下一步动作、工具参数、是否需要澄清、最终回答草稿。解析失败要成为一种可观察错误，而不是 panic 或悄悄重试到成本失控。

数据存储上，SQL 数据库适合保存 run、step、状态和索引；对象存储适合保存长 prompt、工具大返回、生成文件和完整 trace；事件表适合保存审计和回放需要的结构化事件。不要把所有内容都塞进一张 `runs` 表，也不要只把大 JSON 放对象存储而没有可查询索引。

如果系统要支持流式输出，还要把“用户看到的进度”和“后端确认的状态”分开。模型生成的中间文字可以通过 SSE 推给前端，但它不能直接代表任务已经完成。真正的状态仍然以数据库里的 run 和 step 为准。比如 Agent 一边说“正在查询合同”，一边工具还没有返回；前端可以展示这句话，但不能把合同结果渲染成已确认事实。更稳妥的做法是把流式事件分成 `message.delta`、`step.started`、`step.completed`、`approval.required` 和 `run.completed`。其中只有结构化状态事件能驱动按钮、确认框和产物列表，普通文本只是体验层。

多租户系统还要考虑资源隔离。Agent 经常会跨工具读取信息，如果租户上下文在某个工具适配器里丢失，后果比普通接口更隐蔽，因为模型可能把错误数据自然地写进总结。每个入口都要把 `tenant_id`、`user_id`、`run_id` 放进 context 或显式参数，工具网关在调用前后都检查返回资源是否属于当前租户。对于搜索和向量检索，租户过滤必须在后端查询层完成，不能只靠 prompt 要求模型“只看当前客户”。这条规则看起来朴素，但它决定 Agent 能不能进入企业环境。

## 工程实现

下面是一组简化的 Go 数据结构。真实项目可以加租户、审计、版本和更多错误字段，但核心边界大致如此。

```go
type RunStatus string

const (
	RunQueued       RunStatus = "queued"
	RunRunning      RunStatus = "running"
	RunWaitingHuman RunStatus = "waiting_human"
	RunCompleted    RunStatus = "completed"
	RunFailed       RunStatus = "failed"
	RunCancelled    RunStatus = "cancelled"
)

type Run struct {
	ID          string
	TenantID    string
	UserID      string
	Status      RunStatus
	Goal        string
	CurrentStep string
	CreatedAt   time.Time
	UpdatedAt   time.Time
	LockUntil   *time.Time
	LockedBy    *string
}

type Step struct {
	ID        string
	RunID     string
	Type      string
	Status    string
	InputRef  string
	OutputRef string
	ErrorCode string
	StartedAt time.Time
	EndedAt   *time.Time
}
```

`InputRef` 和 `OutputRef` 可以指向对象存储里的大内容。数据库里保存摘要和引用，避免每次列表查询都拖出长 prompt 和工具原始返回。对排障有用的字段要能索引，例如工具名、错误码、状态、租户、创建时间和模型版本。

worker 主循环要简单，复杂逻辑放服务里。伪代码如下：

```go
func (w *Worker) Handle(ctx context.Context, msg QueueMessage) error {
	run, ok, err := w.runs.Acquire(ctx, msg.RunID, w.id, 2*time.Minute)
	if err != nil || !ok {
		return err
	}
	defer w.runs.Release(ctx, run.ID, w.id)

	for {
		select {
		case <-ctx.Done():
			return ctx.Err()
		default:
		}

		next, err := w.engine.Advance(ctx, run.ID)
		if err != nil {
			return w.runs.MarkFailed(ctx, run.ID, classify(err))
		}
		if next.Done {
			return nil
		}
		if next.WaitingHuman {
			return nil
		}
	}
}
```

这里有几个点。`Acquire` 必须是原子操作；`Release` 不能把已经被别人续约的锁清掉；`Advance` 每次只推进一个可持久化步骤，而不是在内存里跑完整任务；`ctx` 要贯穿模型和工具调用，取消时能尽快停止；错误要分类，决定是否重试、失败、等待人工或降级。

Agent 引擎可以按“读取状态、构建上下文、请求模型、执行动作、保存结果”推进。每一步都要先写开始事件，再写结束事件。这样即使进程崩溃，也能知道停在哪。不要等整个步骤成功后才写日志，否则最关键的失败现场会丢。

```go
type Engine struct {
	runs    RunStore
	events  EventStore
	models  ModelGateway
	tools   ToolGateway
	policy  PolicyEngine
	context ContextBuilder
}

type AdvanceResult struct {
	Done         bool
	WaitingHuman bool
}
```

模型输出建议使用结构化动作，而不是让模型自由生成“我接下来会调用某某”。例如：

```json
{
  "action": "call_tool",
  "tool": "repo.search",
  "arguments": {
    "repo": "docs-site",
    "query": "Agent 评测"
  },
  "reason": "需要先确认现有文档中是否已有相关章节"
}
```

后端拿到这个动作后，先校验 `tool` 是否存在，再用 schema 校验参数，再交给策略引擎判断。策略引擎不要只看工具名，还要看用户、租户、资源、动作类型和风险等级。比如同样是 `repo.write_file`，写个人草稿和写主分支配置文件风险完全不同。

工具接口可以这样设计：

```go
type Tool interface {
	Name() string
	Schema() json.RawMessage
	Call(ctx context.Context, req ToolRequest) (ToolResult, error)
}

type ToolRequest struct {
	RunID       string
	UserID      string
	TenantID    string
	Arguments   json.RawMessage
	DryRun      bool
	Idempotency string
}

type ToolResult struct {
	Summary    string
	ContentRef string
	Effects   []Effect
	Retryable bool
}
```

`Effects` 很重要。它描述工具会产生或已经产生的影响，例如“将创建工单”“将修改文件”“将发送邮件给三个人”。策略引擎和人工确认页面都应该读这个结构，而不是读模型生成的一段解释。模型可以帮助描述，但最终确认要基于后端计算出的影响范围。

并发上，不要让一个 run 内部随意开 goroutine。Agent 的路径依赖很强，很多步骤必须按顺序推进。可以并发的是独立检索、多个只读工具查询、文件上传处理和评测任务，但写操作、状态迁移和确认回调必须串行化。Go 的 goroutine 很便宜，但业务一致性不便宜。

对于上下文构建，建议把来源显式化：系统指令版本、开发者指令版本、用户消息、run 历史、检索证据、工具结果、长期记忆和预算。Context Builder 返回的不只是 prompt 字符串，还要返回上下文清单，供 trace、评测和排障使用。一次模型误判，经常不是模型坏，而是上下文里缺了关键工具结果。

```go
type ContextItem struct {
	Kind    string
	Ref     string
	Summary string
	Tokens  int
}

type BuiltContext struct {
	Messages []ModelMessage
	Items    []ContextItem
	Budget   TokenBudget
}
```

错误处理要按语义分类。`ErrToolTimeout` 可以重试，`ErrPermissionDenied` 应该停止或要求授权，`ErrInvalidModelOutput` 可以重新请求一次结构化输出，`ErrPolicyRequiresConfirmation` 应该进入 `waiting_human`，`ErrUserInputRequired` 应该生成澄清问题。所有错误都变成同一个 `failed`，用户体验会很差，系统也无法优化。

存储层还要保存版本信息。一次 run 至少要记录 Agent 版本、提示词版本、工具 schema 版本、模型版本和策略版本。没有这些字段，线上问题很难复盘。比如同一个用户目标昨天成功、今天失败，根因可能是模型切换，也可能是工具 schema 增加了必填字段，或者安全策略把某个动作改成需要确认。如果版本被写入 run 和事件，工程团队可以按版本聚合失败率，也可以把线上失败样本拉回评测环境重放。

一个具体流程可以这样走：用户要求“把项目周报整理成给客户的邮件草稿”。API 创建 run，worker 领取后先构建上下文，只包含用户消息、项目知识库索引和可用工具列表。模型返回需要调用 `doc.search` 和 `ticket.summary`。工具网关发现这两个工具都是只读，带上租户和用户权限执行，并把结果写入对象存储。第二轮模型生成邮件草稿，但同时建议调用 `email.send`。策略引擎根据入口和风险等级判断，当前任务只允许生成草稿，不允许直接外发，于是拒绝发送动作，改为生成 artifact。run 最终完成，产物是邮件草稿，trace 里能看到发送动作被拒绝。这种流程比简单禁止模型提发送动作更可靠，因为系统既能利用模型的主动性，也能在后端边界守住产品承诺。

后台管理能力也不要拖到最后再做。运营和工程至少需要一个 run 列表，能按状态、租户、用户、工具、错误码和时间筛选；需要一个 run 详情页，能看每个 step、工具参数摘要、策略决策、artifact 和日志关联；还需要安全的重试入口，只允许从可重试状态重新入队，并保留原失败事件。没有这些后台能力，Agent 上线后每次用户反馈都要查数据库和对象存储，排障成本会迅速吞掉开发速度。

## 测试评测

Go Agent 后端的测试要覆盖普通服务测试，也要覆盖 Agent 特有路径。单元测试先从状态机开始。状态机必须明确哪些迁移合法，哪些迁移非法，重复确认、取消后确认、完成后重试、worker 锁过期后续写，都要有测试。状态机测试不需要模型，跑得快，收益很高。

工具网关测试要覆盖 schema 校验、权限拒绝、dry-run、幂等键、超时和错误分类。特别要测重复提交。队列至少一次投递时，同一个写操作可能被 worker 重放。如果幂等键没设计好，Agent 可能重复发邮件、重复建工单、重复改文件。测试里可以构造同一个 `ToolRequest` 调两次，确认第二次返回同一结果或被安全拒绝。

模型网关测试不应该依赖真实模型。可以先用 fake model 返回固定结构，测试解析、错误分类、token 预算和 trace 记录。真实模型评测放在集成或离线评测里。否则单元测试会慢、不稳定、成本高，而且失败难以归因。

worker 测试要模拟崩溃和恢复。一个典型用例是：worker 领取 run，写入 `tool.called` 开始事件后进程退出；锁过期后另一个 worker 接管；引擎读取事件发现工具调用没有完成，决定重试或标记未知状态。没有这类测试，长任务上线后会出现很多“卡住但不知道能不能重跑”的任务。

端到端测试可以用内存队列、临时数据库、fake model 和 fake tools 跑完整任务。目标不是追求数量，而是覆盖关键流程：

| 流程 | 预期结果 | 风险 |
| --- | --- | --- |
| 只读查询后生成摘要 | run completed，artifact 存在，trace 完整 | 基础主路径 |
| 写操作 dry-run 后等待确认 | run waiting_human，effects 可展示 | 高风险动作误执行 |
| 用户确认后继续执行 | run completed，幂等键一致 | 审批回调丢状态 |
| 工具超时后重试成功 | run completed，重试次数可见 | 恢复不可观测 |
| 权限不足 | run failed 或 waiting_human，原因清晰 | 越权或错误降级 |
| 用户取消 | run cancelled，worker 停止 | 取消不生效 |

评测层面，还要把真实 Agent 样本接入运行时。每个样本固定用户、时间、fixture 和预期事件。Go 后端输出的 trace 可以被评分器读取，检查是否调用必要工具、是否错误触发写操作、是否有引用证据、是否超过成本预算。这样模型提示词和后端状态机的改动都能被同一套评测发现。

性能测试不要只测 QPS。Agent 后端更重要的是并发 run 数、队列积压、worker 锁续约、模型超时占比、工具 P95、每个 run 平均 step 数、每个任务成本和恢复成功率。一个系统每秒能创建很多 run 没意义，如果 worker 消费不了，用户看到的仍然是长时间排队。

可观测性测试也值得做。至少要断言一次 run 会产生必要事件：创建、入队、领取、模型调用、工具调用、状态变化、完成或失败。日志字段要包含 run id、step id、tenant id 和 tool name。没有这些字段，生产事故时就要靠手工拼接多套日志。

## 失败模式

第一类失败是同步执行过深。HTTP handler 里直接跑多轮 Agent，看起来简单，但会遇到超时、断连、重试和部署重启问题。解决方式是创建 run 后异步执行，用状态查询或流式事件反馈进度。

第二类失败是没有幂等。用户双击、前端重试、队列重复投递、worker 崩溃恢复，都可能导致同一个动作执行多次。每个 run 创建、每个工具写操作、每个确认提交都要有幂等键。尤其是外部副作用，宁可多设计一个幂等表，也不要依赖“正常不会重复”。

第三类失败是工具权限放在 prompt 里。系统提示写“不要发送邮件”没有工程约束。模型仍可能输出发送动作，解析层也可能误判。权限必须在后端策略引擎里执行，prompt 只是让模型少走弯路，不是安全边界。

第四类失败是状态散落。handler 改状态、worker 改状态、工具回调也改状态，最后出现 completed 后又 failed，cancelled 后继续写文件。状态迁移要集中，数据库更新要带当前状态条件，终态要不可逆。

第五类失败是上下文无限增长。每轮都把完整历史和工具原始返回塞回模型，很快超 token，成本也不可控。Context Builder 要做摘要、裁剪和引用，工具大结果放对象存储，模型只拿必要片段和可追溯引用。被裁剪的材料要在 trace 里留清单，方便排障。

第六类失败是错误分类粗糙。所有错误都重试，会放大成本；所有错误都失败，会让可恢复问题变成用户问题；所有错误都问用户，会让产品难用。错误分类要和状态机联动，决定重试、等待、失败、澄清或接管。

第七类失败是 worker 并发写同一个 run。队列重复消息和锁续约延迟会制造并发。数据库更新要检查锁持有者和版本号，关键步骤要有唯一约束，例如同一个 run 的同一个 step 只能完成一次。Go 内存锁不能替代跨进程一致性。

第八类失败是只保存最终答案。Agent 出错时，最终答案往往无法解释根因。必须保存事件流、工具参数摘要、策略决策、上下文清单和 artifact 引用。敏感原文可以脱敏或放受控存储，但结构化轨迹不能没有。

第九类失败是把模型供应商异常当普通错误。限流、内容过滤、上下文超限、结构化输出解析失败、网络超时，处理策略不同。Model Gateway 要把这些错误变成可观察类别，并支持降级、重试或明确失败。业务层不应该解析供应商 SDK 的细碎错误。

## 上线 checklist

- API 只负责创建 run、查询状态、确认动作和取消任务，长任务由队列 worker 执行。
- run 状态机集中实现，所有迁移有当前状态条件，终态不可逆，取消和确认有并发测试。
- worker 领取任务使用租约和持有者检查，锁过期后可以安全恢复。
- 工具网关统一 schema 校验、权限判断、超时、dry-run、幂等键、错误分类和审计事件。
- 外部写操作默认先生成 effects，并在策略要求时进入人工确认，不允许模型直接越过后端确认。
- 模型调用集中在 Model Gateway，包含模型版本、超时、token 预算、结构化解析、成本统计和 trace。
- Context Builder 输出上下文清单，能说明每轮模型调用使用了哪些系统指令、用户消息、证据和工具结果。
- 数据库保存 run、step、状态和索引；对象存储保存大 prompt、大结果和产物；事件表可用于审计和回放。
- 所有队列消息、确认请求和写工具调用都有幂等设计，重复投递不会产生重复副作用。
- 测试覆盖状态机、工具网关、模型网关、worker 崩溃恢复、端到端主路径和高风险确认路径。
- 指标包含队列延迟、run 成功率、人工接管率、工具错误率、模型解析失败率、平均 step 数、P95 成本和恢复成功率。
- 日志和 trace 至少包含 run id、step id、tenant id、user id、tool name、model version 和 error code。
- 发布前用评测样本跑完整 Agent Runtime，而不是只测 prompt 或模型输出。
- 有后台任务清理卡住的租约、过期确认和孤立产物，并且清理动作本身有审计记录。

## 总结

用 Go 写 Agent 后端，本质是在不确定的模型能力外面搭一个确定的执行系统。这个系统要能把用户目标变成 run，把长任务拆成 step，把工具调用关进网关，把模型请求集中治理，把状态迁移写清楚，把失败恢复设计出来。Go 的优势不在于让提示词更聪明，而在于让这些服务边界稳定、可测试、可部署、可观测。

如果只做原型，一个循环调用模型和工具就够了；如果要上线，就必须认真处理队列、幂等、权限、dry-run、人工确认、事件流、上下文预算和评测。Agent 越能做事，后端越要保守。模型可以提出动作，后端必须判断动作能不能做、怎么做、做了以后如何证明。

我会从最小可靠骨架开始：run 表、状态机、队列 worker、模型网关、工具网关、事件存储和几条端到端评测样本。等这些边界站稳，再逐步扩展更多工具和更复杂的规划能力。这样做出来的 Agent 不一定一开始最花哨，但它能解释、能恢复、能审计，也更容易从真实使用里持续变强。
