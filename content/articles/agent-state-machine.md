---
slug: agent-state-machine
url: /notes/agent-state-machine/
title: 用状态机约束 Agent 行为
summary: 状态机可以让 Agent 的长任务更容易恢复、暂停和审计。
categoryKey: agents
category: AI Agent
categoryLabel: AI Agent 设计
source: NOTES/AGENT
date: 2026-04-26
image: /assets/article-visuals/agent-state-machine.svg
tags:
  - State Machine
  - Agent
---

![标题图](/assets/article-visuals/agent-state-machine.svg)

## 问题背景

很多 Agent 原型看起来像一个聪明的聊天窗口：用户给目标，模型思考，工具执行，再把结果塞回上下文。这个模式能演示能力，却很难承受真实工程任务。真实任务会跨很多步骤：读代码、确认约束、选择工具、修改文件、跑测试、处理失败、等待用户、恢复中断、交付总结。每一步都有可见副作用，每一次失败都可能改变后续路线。只靠一段系统提示词提醒模型“请谨慎行动”，很快就会遇到边界。

我在做工程型 Agent 时，最常见的问题不是模型完全不知道该做什么，而是它不知道自己现在处于什么状态。它可能在还没读完上下文时就开始改文件，可能在测试失败后直接总结，可能在用户要求暂停时继续调用工具，也可能在一个写操作超时后重复执行同一动作。对人类工程师来说，这些行为很容易被称为“不专业”；对 Agent 系统来说，它们往往是控制层没有把状态边界设计清楚。

状态机的价值就在这里。它不是为了让 Agent 变得僵硬，而是把“能做什么、不能做什么、失败后去哪、什么时候需要用户确认”从模型的隐式判断里拿出来，变成宿主系统可以检查的协议。模型仍然负责理解目标、提出计划、解释观察和生成文本，但执行器不再把模型输出当作无条件命令。每一次状态转换都要满足条件，每一种工具调用都要落在允许的阶段里，每一个终止判断都要有证据。

如果没有状态机，Agent 的行为会呈现一种表面流畅、内部混乱的样子。用户看到它一直在输出进展，但系统无法回答关键问题：它为什么进入写文件阶段；它是否已经完成只读调查；它上一次失败属于临时错误还是不可恢复错误；它最终报告里的测试结果是不是晚于最后一次修改；它是否越过了用户给出的文件范围。只要这些问题回答不上来，生产环境里就很难谈审计、恢复和权限。

状态机尤其适合长任务。长任务一定会遇到暂停、等待和恢复。比如一个 Agent 正在修复 CI，先查日志，再定位代码，再改测试，跑到一半机器重启。恢复时不能简单让模型“继续刚才的任务”，因为上下文可能已经压缩，工作区可能被用户改过，远端 CI 也可能重新跑过。系统需要知道上次稳定状态是什么、哪些动作已经有副作用、哪些证据需要刷新。状态机把这些问题变成可编码的判断，而不是让模型重新猜。

还有一个现实场景是协作。用户会在中途追加要求，例如“不要改配置文件”“先别提交”“只生成 Markdown”。如果 Agent 没有状态边界，这些新约束可能只存在于对话里，后续工具调用仍然沿着旧计划走。状态机可以把约束挂到任务状态上，并在进入高风险阶段前重新检查。模型可以忘，控制器不应该忘。

把 Agent 做成状态机，并不意味着要引入庞大的工作流平台。很多项目从一个小型状态枚举、几条转换规则、一份事件日志开始就足够。关键是承认 Agent 不是纯文本生成器，而是一个会影响外部世界的执行系统。只要有执行系统，就需要状态、权限、日志和验收。状态机是最朴素也最稳的起点。

## 核心概念

设计 Agent 状态机时，我会先区分三类东西：任务状态、行动状态和工具状态。任务状态描述整个目标走到哪里，例如理解需求、探索上下文、执行修改、验证结果、等待用户、完成。行动状态描述当前这一步的生命周期，例如已选择、运行中、成功、失败、需要重试。工具状态描述具体外部调用的结果，例如超时、权限不足、参数错误、部分成功。很多系统把这三层混成一个 `running` 字段，后面一定会吃亏。

一个简化但可用的任务状态表如下：

| 状态 | 含义 | 允许的主要动作 | 退出条件 | 风险点 |
| --- | --- | --- | --- | --- |
| `new` | 任务刚创建，目标还没结构化 | 解析输入、初始化日志 | 目标和验收标准被记录 | 过早调用工具 |
| `understanding` | 正在识别目标、范围、硬约束 | 追问、整理约束、读取显式说明 | 形成任务模型 | 把假设当事实 |
| `exploring` | 只读调查环境和代码 | 读文件、搜索、查看状态 | 关键上下文足够支撑计划 | 调查无边界膨胀 |
| `planning` | 生成近期可执行步骤 | 更新计划、评估风险 | 计划通过策略检查 | 计划脱离真实代码 |
| `executing` | 执行有副作用动作 | 写文件、调用 API、修改数据 | 当前步骤完成或失败 | 越权写入、重复副作用 |
| `verifying` | 验证交付物是否满足要求 | 运行测试、检查文件、人工抽样 | 验收通过或发现缺口 | 用旧结果证明新修改 |
| `waiting_user` | 需要用户判断或授权 | 展示问题、保存暂停点 | 用户回复并绑定版本 | 恢复后使用过期确认 |
| `waiting_external` | 等待 CI、队列、外部系统 | 轮询、订阅、超时处理 | 外部结果返回 | 等待期间环境变化 |
| `recovering` | 从中断、异常或压缩后恢复 | 读取日志、刷新证据、重建状态 | 得到安全下一步 | 直接从摘要继续 |
| `done` | 任务完成 | 只允许读取和报告 | 无 | 误把部分完成当完成 |
| `blocked` | 无法安全继续 | 报告阻塞原因 | 用户或系统解除阻塞 | 隐藏真实阻塞 |
| `cancelled` | 用户或策略取消 | 停止副作用、记录状态 | 无 | 取消后仍有后台动作 |

状态本身只是名字，真正有用的是转换条件。比如 `exploring -> executing` 不能只靠模型说“我准备好了”，还要满足至少三个条件：已记录硬约束，写入范围经过策略检查，本轮计划包含可验证的下一步。`executing -> done` 更不能直接发生，必须先进入 `verifying`。这种看似繁琐的边界能挡住很多低级事故。

状态机里还有几个关键概念。

| 概念 | 作用 | 工程落点 |
| --- | --- | --- |
| 不变量 | 每轮行动前都必须成立的条件 | 文件范围、权限、预算、用户硬要求 |
| 事件 | 状态变化和工具调用的事实记录 | append-only 日志，带时间和关联 ID |
| 守卫条件 | 状态转换前的检查函数 | 策略引擎或普通 Go 函数 |
| 副作用级别 | 动作风险分级 | read、write-local、write-remote、irreversible |
| 恢复点 | 可以安全重建上下文的快照 | 状态、计划、观察、产物哈希 |
| 终止条件 | 什么时候可以结束或必须停止 | 验收通过、阻塞、取消、预算耗尽 |

不变量要写得很具体。像“保持安全”没有意义，“只允许修改 `content/articles/agent-state-machine.md` 和 `content/articles/tool-error-recovery.md`”才有意义。像“尽量少改”也不够，“不得修改脚本、图片和已有文章”更适合放进策略检查。状态机不是替代 prompt，而是把 prompt 里的硬要求变成执行层能验证的规则。

守卫条件不一定复杂。很多项目一开始用普通函数就够了：检查当前状态是否允许工具类型，检查文件路径是否在范围内，检查上一次修改后是否跑过指定验证命令，检查用户确认是否仍然绑定当前对象版本。等规则多了，再引入 OPA、CEL 或自研策略 DSL。不要一上来做一个通用工作流引擎，先把关键转换拦住。

状态机也不应该把模型排除在外。模型很适合做两件事：把自然语言观察归纳成结构化事实，以及在多个合法下一步之间给出优先级。控制器负责告诉模型“当前状态允许哪些动作”，模型负责在这些动作里选择“为什么先做这个”。这样模型的灵活性和系统的纪律可以并存。

## 架构/流程图解说明

一个实用的 Agent 状态机可以放在模型调用和工具网关之间。模型不是直接调用工具，而是向控制器提交意图；控制器根据当前状态、守卫条件和权限决定是否执行。

```text
用户目标
  |
  v
任务控制器
  |-- 解析目标、约束、验收标准
  |-- 保存 TaskState 和事件日志
  |-- 计算当前允许动作
  |
  v
模型规划器
  |-- 读取状态摘要
  |-- 提出下一步意图
  |-- 解释选择原因
  |
  v
策略/状态机守卫
  |-- 检查状态转换是否合法
  |-- 检查工具风险级别
  |-- 检查路径、预算、权限、不变量
  |
  v
工具网关
  |-- 执行读写命令或外部 API
  |-- 记录参数、输出摘要、错误分类
  |
  v
观察归纳
  |-- 形成事实、风险、下一步影响
  |-- 更新计划和状态
  +-- 回到任务控制器
```

状态转换可以画成更具体的图：

```text
new
  -> understanding
  -> exploring
  -> planning
  -> executing
  -> verifying
  -> done

understanding -> waiting_user -> understanding
planning -> waiting_user -> planning
executing -> verifying -> planning
executing -> recovering -> planning
verifying -> planning
任何非终态 -> blocked
任何非终态 -> cancelled
```

这里有两个设计点。第一，`verifying` 失败后回到 `planning`，不是回到 `executing`。验证失败说明当前计划至少有一部分假设不成立，需要重新解释原因，而不是机械地继续改。第二，`recovering` 不直接回到 `executing`。恢复阶段必须先重建上下文，刷新必要证据，再决定是否还能沿用旧计划。

在用户界面或日志里，不要只显示“运行中”。更好的展示是当前阶段、正在做的步骤、阻塞条件和下一次转换理由。例如：

| 字段 | 示例 |
| --- | --- |
| 当前阶段 | `verifying` |
| 当前步骤 | 运行 `go test ./...` 验证限流中间件 |
| 最近观察 | 新增测试通过，但全量测试里 `TestConfigReload` 失败 |
| 下一步候选 | 读取配置热更新测试，判断是否由本次修改引起 |
| 不变量 | 不修改公共 API；不改数据库迁移 |
| 完成条件 | 全量测试通过，报告修改文件和残余风险 |

这类状态展示对用户有价值，对 Agent 自己也有价值。上下文压缩后，把这张表重新喂给模型，比把几千行命令输出塞回去更可靠。模型需要的是当前决策所需事实，不是完整噪声。

一个更贴近代码的流程是：每轮循环开始时从存储加载 `TaskState`；根据状态生成 `AllowedActions`；模型只在允许动作列表里选择；控制器校验选择；工具执行后产生 `ToolEvent`；观察器把事件转成 `Observation`；状态机根据观察和守卫条件转换。这样做之后，即使模型输出了“现在提交代码”，控制器也可以因为当前状态是 `exploring` 或缺少用户确认而拒绝。

## 工程实现

下面是一组简化的 Go 数据结构。真实系统可以更复杂，但核心思想是把状态、事件、动作意图和转换结果分开。

```go
type Phase string

const (
    PhaseNew             Phase = "new"
    PhaseUnderstanding   Phase = "understanding"
    PhaseExploring       Phase = "exploring"
    PhasePlanning        Phase = "planning"
    PhaseExecuting       Phase = "executing"
    PhaseVerifying       Phase = "verifying"
    PhaseWaitingUser     Phase = "waiting_user"
    PhaseWaitingExternal Phase = "waiting_external"
    PhaseRecovering      Phase = "recovering"
    PhaseDone            Phase = "done"
    PhaseBlocked         Phase = "blocked"
    PhaseCancelled       Phase = "cancelled"
)

type TaskState struct {
    ID             string
    Phase          Phase
    Goal           string
    Constraints    []Constraint
    Acceptance     []AcceptanceCheck
    Plan           []PlanItem
    Observations   []Observation
    LastMutationAt time.Time
    LastVerifiedAt time.Time
    Version        int64
}

type ActionIntent struct {
    Kind        ActionKind
    Summary     string
    ToolName    string
    Arguments   map[string]any
    Risk        RiskLevel
    Expected    string
    RequiresAck bool
}

type Transition struct {
    From      Phase
    To        Phase
    Reason    string
    Evidence  []string
    CreatedAt time.Time
}
```

这里的 `Version` 很重要。用户确认、恢复点、外部等待结果都应该绑定状态版本。比如用户在版本 8 同意修改配置文件，但状态在等待期间刷新到版本 11，且计划已经变化，那么这个确认不能直接复用。状态机需要把“确认了什么对象”记录清楚，而不是只保存一句“用户同意了”。

守卫条件可以从简单表驱动开始：

```go
type Guard func(ctx context.Context, state TaskState, intent ActionIntent) error

var phaseActions = map[Phase][]ActionKind{
    PhaseUnderstanding: {ActionAskUser, ActionRead},
    PhaseExploring:     {ActionRead, ActionSearch, ActionSummarize},
    PhasePlanning:      {ActionUpdatePlan, ActionAskUser},
    PhaseExecuting:     {ActionWrite, ActionCallAPI, ActionRunCommand},
    PhaseVerifying:     {ActionRunCommand, ActionRead, ActionSummarize},
    PhaseRecovering:    {ActionReadLog, ActionRead, ActionUpdatePlan},
}

func GuardAllowedAction(state TaskState, intent ActionIntent) error {
    allowed := phaseActions[state.Phase]
    if !slices.Contains(allowed, intent.Kind) {
        return fmt.Errorf("action %s is not allowed in phase %s", intent.Kind, state.Phase)
    }
    return nil
}
```

只检查动作类型还不够，路径和副作用也要进守卫：

```go
func GuardWriteScope(state TaskState, intent ActionIntent) error {
    if intent.Risk == RiskReadOnly {
        return nil
    }
    paths := extractPaths(intent.Arguments)
    for _, p := range paths {
        if !state.Scope.Allows(p) {
            return fmt.Errorf("path %q is outside allowed scope", p)
        }
    }
    return nil
}

func GuardVerificationFreshness(state TaskState, target Phase) error {
    if target != PhaseDone {
        return nil
    }
    if state.LastVerifiedAt.IsZero() || state.LastVerifiedAt.Before(state.LastMutationAt) {
        return errors.New("cannot finish: verification is older than last mutation")
    }
    return nil
}
```

状态转换函数要保持确定性。模型可以提供理由，但最终转换最好由代码根据事件和规则决定。比如工具成功不代表任务完成，工具失败也不代表任务失败。

```go
func NextPhase(state TaskState, event Event) (Phase, string) {
    switch state.Phase {
    case PhaseNew:
        return PhaseUnderstanding, "task initialized"
    case PhaseUnderstanding:
        if hasOpenQuestion(state) {
            return PhaseWaitingUser, "missing required clarification"
        }
        if hasMinimumTaskModel(state) {
            return PhaseExploring, "goal and constraints captured"
        }
    case PhaseExploring:
        if enoughContextForPlan(state) {
            return PhasePlanning, "context is sufficient for a bounded plan"
        }
    case PhasePlanning:
        if planNeedsApproval(state) {
            return PhaseWaitingUser, "plan touches high-risk operation"
        }
        if planHasExecutableStep(state) {
            return PhaseExecuting, "next step is ready"
        }
    case PhaseExecuting:
        if event.Kind == EventToolFailed && isRecoverable(event.ErrorClass) {
            return PhaseRecovering, "tool failure is recoverable"
        }
        if event.Kind == EventToolSucceeded {
            return PhaseVerifying, "mutation completed, verification required"
        }
    case PhaseVerifying:
        if allAcceptancePassed(state) {
            return PhaseDone, "acceptance checks passed"
        }
        return PhasePlanning, "verification found a gap"
    }
    return state.Phase, "no transition"
}
```

事件日志建议使用 append-only，不要覆盖。每个事件至少包含 `task_id`、`state_version`、`phase`、`actor`、`kind`、`payload_hash`、`summary`、`created_at`。工具事件还要包含工具名、规范化参数、退出码、错误分类、输出摘要和副作用声明。不要把完整大输出都塞进状态对象，状态需要精炼，原始输出可以放对象存储或日志系统。

一个实际事件例子：

```json
{
  "task_id": "task_20260426_001",
  "state_version": 14,
  "phase": "executing",
  "kind": "tool_finished",
  "tool": "apply_patch",
  "risk": "write_local",
  "summary": "updated rate limiter middleware and unit test",
  "paths": ["internal/http/ratelimit.go", "internal/http/ratelimit_test.go"],
  "exit_code": 0,
  "effect_hash": "sha256:4b8c...",
  "created_at": "2026-04-26T10:31:20Z"
}
```

模型上下文组装也要利用状态机。不要每轮都把所有历史塞进去，而是提供：当前目标、硬约束、当前状态、允许动作、最新计划、关键观察、未解决问题、最近事件摘要。特别是允许动作列表，要明确到工具级别。例如当前状态是 `exploring`，上下文里就不应该出现“你可以写文件”的暗示；当前状态是 `verifying`，模型应优先解释测试结果，而不是发散新功能。

工程上我会把状态机放在工具网关之前，把权限检查放在工具网关之内。前者回答“这个阶段可不可以做”，后者回答“这个具体调用有没有权限”。两层都需要，因为状态机可能允许写文件，但工具网关仍然要拒绝超出工作区的路径；状态机可能允许调用外部 API，但工具网关仍然要检查 token、速率和幂等键。

还有一个实现细节值得单独强调：状态摘要要和原始事件分开维护。原始事件是审计材料，越完整越好；状态摘要是决策材料，越准确越好。每次事件进入日志后，可以由一个 reducer 更新 `TaskState`，把“刚才读到了哪些事实、哪些约束被确认、哪些计划项已经失效”写成短字段。这样模型下一轮看到的是任务结构，而不是日志海洋。这个 reducer 不必完全自动，复杂观察可以先由模型提议，再由规则检查后落库。例如模型总结“测试失败与配置热更新有关”，系统可以要求它附上失败文件、命令和行号，再把这条观察标记为可用于规划。没有证据的总结只能作为备注，不能作为状态转换依据。

在多 Agent 场景里，状态机还可以作为交接协议。一个 Agent 负责探索，另一个 Agent 负责实现，第三个 Agent 负责验证，如果没有共享状态，交接很容易退化成自然语言转述。更稳的做法是把交接点限制在稳定状态：探索 Agent 只能交出 `planning` 状态，并附带已确认约束和证据；实现 Agent 完成后必须进入 `verifying`，不能直接宣布完成；验证 Agent 只能基于晚于最后修改的证据把任务推进到 `done`。这样角色可以变化，纪律不变。

## 测试评测

状态机的测试不能只测 happy path。真正要测的是边界：非法转换能不能被拒绝，失败后有没有进入正确状态，旧验证结果会不会被误用，用户确认是否绑定版本。可以分成四类。

| 测试类型 | 目标 | 示例 |
| --- | --- | --- |
| 单元测试 | 转换函数和守卫条件确定 | `exploring` 阶段拒绝写文件 |
| 场景测试 | 多轮事件后状态正确 | 工具超时后进入 `recovering`，刷新证据后回到 `planning` |
| 回放测试 | 历史事件能重建任务 | 用事件日志恢复状态版本 17 |
| 对抗测试 | 模型输出越界时被拦截 | 模型要求删除目录，控制器拒绝并记录策略错误 |

一个最小测试用例可以这样设计：

```go
func TestCannotFinishWithStaleVerification(t *testing.T) {
    state := TaskState{
        Phase:          PhaseVerifying,
        LastMutationAt: time.Date(2026, 4, 26, 10, 0, 0, 0, time.UTC),
        LastVerifiedAt: time.Date(2026, 4, 26, 9, 59, 0, 0, time.UTC),
    }
    err := GuardVerificationFreshness(state, PhaseDone)
    if err == nil {
        t.Fatal("expected stale verification to block completion")
    }
}
```

场景测试要覆盖真实任务。比如“新增两篇文章，只允许修改两个 Markdown 文件”：模型在 `exploring` 阶段可以读取风格文档和元数据；进入 `executing` 后只能写两个目标文件；如果它想修改校验脚本，守卫必须拒绝；写完后必须进入 `verifying` 并运行指定命令；命令通过后才能 `done`。这个场景能测出路径范围、阶段动作、验收条件和报告内容。

评测指标不要只看最终成功率。状态机系统至少要观察以下指标：

| 指标 | 含义 | 诊断价值 |
| --- | --- | --- |
| 非法动作拦截率 | 模型提出越界动作后被拦住的比例 | 判断 prompt 和策略是否一致 |
| 恢复成功率 | 中断后能回到安全状态的比例 | 判断日志和 checkpoint 是否足够 |
| 验证新鲜度违规次数 | 修改后未重新验证就想完成的次数 | 判断完成条件是否可靠 |
| 用户确认过期次数 | 确认绑定版本失效的次数 | 判断等待和恢复设计是否严谨 |
| 状态停留时间 | 各阶段耗时分布 | 发现探索过度或验证瓶颈 |
| 人工升级率 | 需要用户介入的任务比例 | 区分系统能力边界和产品体验 |

还要做故障注入。让工具随机超时、让文件在等待期间变化、让模型输出非法 JSON、让用户在执行中取消、让测试命令返回非零。每一种故障都应该落到可解释状态，而不是把整个任务变成 `failed`。生产里最有价值的不是永远不失败，而是失败后知道为什么失败、现在是否安全、下一步该由谁处理。

测试里还有一个容易遗漏的点：压缩上下文后的继续执行。可以在长场景中间人为删除对话历史，只保留 `TaskState`、事件摘要和关键观察，再让 Agent 继续。若系统设计正确，它应该能从结构化状态恢复；若它依赖原始聊天记忆，就会开始重复探索、遗漏约束或跳过验证。

## 失败模式

状态机本身也会失败。最常见的失败模式是状态过粗。只有 `idle/running/done/error` 四个状态时，控制器无法区分只读调查和写入执行，也无法区分等待用户和等待外部系统。状态过粗的系统看起来简单，实际把复杂性推给模型，最后还是不可控。

第二种失败是状态过细。有人会把每一个工具调用都设计成一个状态，结果状态图爆炸，任何需求变化都要改流程。Agent 任务天然有不确定性，状态机应该约束风险边界，而不是规定每个微动作。我的经验是：状态表示阶段，计划表示步骤，事件表示细节。不要把计划项全部固化成状态枚举。

第三种失败是把状态机当 UI 进度条。UI 显示 `planning`、`executing`、`verifying`，但工具调用并不受状态约束，模型仍然可以随时写文件或结束任务。这种状态机只有观感，没有安全价值。真正的状态机必须在执行路径上，非法动作必须被拒绝，拒绝本身也要记录事件。

第四种失败是没有处理人工确认的版本。用户同意的是某个计划、某些文件、某个外部对象。如果等待期间计划变了、文件变了、对象变了，确认就可能过期。很多事故不是没有问用户，而是问的是 A，执行的是 B。解决办法是确认记录里保存对象摘要和状态版本，执行前重新比对。

第五种失败是恢复时过度相信摘要。摘要可以帮助模型理解，但不能替代事件日志和状态字段。比如摘要说“测试通过”，但没有测试命令、时间、提交对象和退出码，就不能作为完成证据。恢复阶段要优先读取结构化事实，再让模型解释。

第六种失败是把所有错误都推到 `blocked`。有些错误可以自动恢复，例如只读搜索超时、临时网络失败、测试依赖未安装；有些错误必须升级，例如权限不足、用户要求冲突、不可逆 API 失败。错误分类如果不清楚，系统要么盲目重试，要么过早打断用户。

第七种失败是状态和外部现实脱节。状态记录说文件已修改，但实际工作区被用户改了；状态记录说 CI 等待中，但远端任务已经取消；状态记录说预算足够，但 token 或时间已经耗尽。长任务里状态要定期刷新现实，尤其是在等待和恢复之后。状态机不是世界本身，它只是对世界的一份可验证模型。

## 上线 checklist

上线前我会用下面这份清单逐项过一遍：

- 明确列出任务状态枚举，并为每个状态写清允许动作、退出条件和阻塞条件。
- 所有有副作用工具都经过状态机守卫，不能被模型绕过直接调用。
- 写操作有路径范围检查，远程写操作有权限、幂等键和人工确认策略。
- `done` 状态必须依赖新鲜验证证据，验证时间晚于最后一次副作用。
- 用户确认绑定状态版本、计划摘要和目标对象哈希，恢复后会重新校验。
- 事件日志 append-only，至少记录状态版本、动作意图、工具参数摘要、结果和错误分类。
- 恢复流程先读结构化状态和事件日志，再组装模型上下文。
- 等待状态区分 `waiting_user` 和 `waiting_external`，并有超时与刷新策略。
- 非法动作被拒绝时，拒绝原因会进入日志和用户可读观察。
- 测试覆盖非法转换、工具失败、取消、恢复、过期确认和旧验证结果。
- 指标能看到各状态停留时间、拦截次数、恢复成功率和人工升级率。
- 运行手册写清如何人工解除阻塞、如何取消任务、如何导出审计日志。

还有一个上线前的人工演练：找三个真实但低风险的任务，让 Agent 跑完整流程，中途故意插入变化。比如在执行后改动一个目标文件、在验证前取消任务、在等待用户时修改计划。看系统能否停在合理状态。如果这三种情况都只能靠开发者读日志手工判断，说明状态机还没有真正承担控制职责。

## 总结

Agent 的状态机不是为了限制模型能力，而是为了让能力可以进入工程现场。模型擅长理解、归纳、生成和在不完整信息下提出候选动作；状态机擅长保存事实、执行规则、阻止越界和支持恢复。两者结合之后，Agent 才从“会聊天的自动化脚本”变成“可暂停、可审计、可恢复的执行系统”。

设计时不要追求一次到位。先从任务阶段、允许动作、守卫条件、事件日志和完成条件做起。把只读、写入、验证、等待、恢复这些边界立住，再逐步细化错误分类和评测指标。真正的收益会在失败时出现：工具超时不会让任务乱跳，用户改口不会被忽略，中断恢复不会从记忆里猜，最终报告也能说清每个结论的证据。

对工程团队来说，状态机还有一个额外好处：它让 Agent 行为可以讨论。过去我们只能说“模型有时会乱来”，现在可以具体到“`executing -> done` 缺少验证守卫”“用户确认没有绑定版本”“恢复阶段允许了写操作”。问题一旦能被命名，就能被测试、监控和修复。Agent 系统要走向生产，这种可讨论性比任何漂亮 prompt 都更重要。
