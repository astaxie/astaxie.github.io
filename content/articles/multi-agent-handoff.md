---
slug: multi-agent-handoff
url: /notes/multi-agent-handoff/
title: 多 Agent 协作里的交接格式
summary: 多 Agent 不是多几个角色名，而是需要稳定的任务交接协议。
categoryKey: agents
category: AI Agent
categoryLabel: AI Agent 设计
source: NOTES/AGENT
date: 2026-04-27
image: /assets/article-visuals/multi-agent-handoff.svg
tags:
  - Multi-Agent
  - Handoff
---

![标题图](/assets/article-visuals/multi-agent-handoff.svg)

## 问题背景

多 Agent 协作很容易被讲成一个组织结构问题：规划 Agent、执行 Agent、审查 Agent、测试 Agent、文档 Agent，各自有角色名，看起来像一个小团队。真正落到工程里，问题不在于起几个角色名，而在于这些角色之间怎样交接。没有稳定交接格式，多 Agent 只是把一个不确定系统拆成多个不确定系统，最后靠上下文里的自然语言互相猜测。任务稍微长一点，前一个 Agent 做过什么、为什么这样做、哪些地方还没验证、哪些假设不能碰、哪些文件已经改过，都会在交接时丢失。

我更愿意把多 Agent 看成带有审计要求的异步流水线。每个 Agent 都可能在不同时间、不同上下文窗口、不同权限边界里工作。它不是人类同事坐在旁边听完整讨论，而是拿到一份有限材料后继续推进。交接格式就是这个流水线里的接口协议。接口协议不清楚，后续 Agent 只能重新扫描代码、重新推理需求、重复跑测试，甚至把上游已经否定的方案再做一遍。成本上升还是小事，真正危险的是它可能覆盖上游的局部改动，或者在没有理解风险的情况下继续调用有副作用的工具。

在很多原型里，交接就是一句“我已经完成了大部分工作，剩下测试”。这对人也许勉强有用，对 Agent 基本不够。什么叫大部分？哪些文件动过？测试失败是环境问题还是代码问题？有没有用户明确限制不能改某个目录？有没有正在运行的进程？有没有未提交的用户变更？有没有临时绕过方案？如果交接不回答这些问题，下一个 Agent 一定会把时间花在恢复现场上。更糟的是，它恢复出来的现场可能和真实历史不一致。

多 Agent 的另一个误区是把交接当成总结。总结面向阅读，交接面向继续执行。总结可以有叙事顺序，交接必须有操作顺序；总结可以只讲结果，交接必须讲证据；总结可以忽略失败尝试，交接必须保留关键失败路径，因为那些失败路径会影响后续决策。比如一个迁移方案已经证明会破坏兼容性，交接里不写，后续 Agent 很可能又走回去。

交接格式还承担上下文压缩的职责。长任务中原始对话、工具日志、文件 diff、测试输出会迅速超过上下文预算。不能简单把所有历史塞给下一个 Agent，也不能只给一句结论。好的交接是结构化压缩：保留足以继续工作的状态、证据和约束，丢掉过程噪声。它像数据库的 checkpoint，而不是聊天记录的尾注。

在代码仓库里，多 Agent 交接尤其要关注工作区一致性。Agent 之间共享一个仓库，可能还有用户同时修改文件。上一个 Agent 如果没有说明自己改了哪些文件、哪些修改是它做的、哪些文件已经存在用户变更，下一个 Agent 可能误以为所有 diff 都属于当前任务。于是它会格式化无关文件、重写别人正在做的工作，或者为了让测试通过回滚用户改动。这个问题不是模型聪不聪明，而是协议没有把所有权说清楚。

我认为多 Agent 协作的底层目标不是“并行更多人”，而是让长任务在中断、切换、并行和复盘时仍然可控。交接格式必须让接手者回答四个问题：现在真实状态是什么，为什么状态会变成这样，下一步应该做什么，哪些事情不能做。只要这四个问题不清楚，Agent 数量越多，系统越不稳定。

## 核心概念

交接格式的核心不是写得长，而是把继续执行所需的信息拆成稳定字段。一个有效的 handoff 至少包含目标、边界、当前状态、已完成工作、未完成工作、证据、风险、下一步、资源占用和所有权。字段固定以后，接手 Agent 可以按字段读取，调度系统也可以按字段做检查，而不是从一段自然语言里猜。

| 字段 | 需要表达的内容 | 常见错误 | 工程处理 |
| --- | --- | --- | --- |
| `goal` | 用户真正要达成的结果 | 只复述当前步骤 | 写成可验收目标 |
| `scope` | 允许和禁止触碰的范围 | 忘记用户限制 | 明确文件、工具、权限边界 |
| `state` | 当前任务状态和工作区状态 | 用“差不多完成” | 使用枚举和证据 |
| `changes` | 已经修改或创建的文件 | 只说“改了逻辑” | 列路径和意图 |
| `evidence` | 测试、命令、观察结果 | 只写结论 | 记录命令和关键输出 |
| `assumptions` | 仍未验证但影响决策的判断 | 把假设当事实 | 标注置信度和验证方式 |
| `blockers` | 阻塞原因和解除条件 | 把失败堆在一起 | 分类为环境、权限、需求、代码 |
| `next_actions` | 接手后最小可执行步骤 | 写成大方向 | 排序、标注是否阻塞 |
| `ownership` | 哪些改动属于当前 Agent | 混入用户改动 | 标记 touched files 和外部 diff |
| `risks` | 继续执行可能踩到的问题 | 只写“注意风险” | 绑定具体文件、工具、业务影响 |

交接里最重要的区分是事实、推断和建议。事实来自文件内容、命令输出、用户指令或工具返回；推断来自 Agent 对这些事实的理解；建议是下一步行动。三者混在一起，接手者很难判断该信什么。比如“测试环境坏了，所以不用管失败”这句话同时包含观察和判断。更好的写法是：事实是 `npm test` 在某个依赖下载阶段超时；推断是网络受限导致，不是代码断言失败；建议是本地可先跑无网络单元测试，CI 再验证集成部分。

另一个关键概念是交接粒度。粒度太粗，接手者无法执行；粒度太细，交接本身变成冗长日志。实践中我会按“下一位 Agent 能在五分钟内定位现场”为标准。它不需要知道每一次搜索命令，但需要知道最终确认的入口文件；它不需要完整粘贴测试输出，但需要知道失败断言、失败命令和是否可复现；它不需要所有思考过程，但需要知道被排除的关键方案。

交接还要区分同步交接和异步交接。同步交接发生在同一轮任务里，接手 Agent 可能还能访问完整上下文或同一工作区；异步交接发生在上下文被压缩、任务被暂停、甚至第二天再恢复时。异步交接必须更严格，尤其要记录时间、命令、分支、工作区 dirty 状态和外部依赖。越是可能跨时间恢复，越不能依赖“刚才说过”。

多 Agent 并行时，还需要引入写集合概念。每个执行 Agent 应该有明确负责的文件或模块，交接中说明它的写集合和读集合。写集合是它允许改动的范围，读集合是它为了理解上下文读取的范围。调度层可以用写集合避免冲突，接手者可以用写集合判断哪些 diff 应该由谁解释。没有写集合，两个 Agent 同时改共享配置文件，最后合并时只能靠人工猜。

交接协议还应该可机器检查。不是说正文完全变成 JSON，而是关键字段要稳定。比如状态枚举可以是 `planned`、`in_progress`、`blocked`、`ready_for_review`、`verified`；风险等级可以是 `low`、`medium`、`high`；测试结果可以记录命令、退出码和摘要。机器检查可以发现缺少 `next_actions`、缺少 touched files、把 blocked 任务标成完成等问题。多 Agent 系统里，人看不完所有交接，必须让基础检查自动化。

## 架构/流程图解说明

一个稳定的多 Agent 协作流程，可以把 handoff 放在调度器和工作区之间。Agent 不直接把一段聊天甩给下一个 Agent，而是向 handoff store 提交结构化交接。调度器根据交接里的状态、写集合和阻塞条件决定谁接手。

```text
用户目标
  |
  v
任务分解器
  |-- 生成子任务、验收条件、写集合
  v
执行 Agent A ---- 修改文件、运行命令、收集证据
  |
  v
Handoff Builder ---- 压缩事实、记录状态、标注风险
  |
  v
Handoff Store ---- 版本化保存、可检索、可审计
  |
  v
调度器 ---- 检查冲突、选择接手角色、注入必要上下文
  |
  v
执行 Agent B ---- 继续实现、测试或审查
```

这张图的重点是交接不是附属消息，而是任务状态的一部分。调度器不应该只知道“某个 Agent 完成了”，还应该知道完成到什么程度、有哪些证据、是否存在冲突。handoff store 最好是版本化的，因为一次任务可能有多次交接。后续复盘事故时，团队要能看到每次交接的状态变化。

在一个代码修改任务里，流程可以更具体：

```text
1. Planner 创建任务：
   - 目标：修复导入页面的空状态
   - 写集合：src/pages/import/*, src/components/EmptyState.tsx
   - 验收：单测通过，截图无重叠

2. Worker 实现：
   - 修改两个组件
   - 新增一个单测
   - 发现移动端样式仍有问题

3. Worker 交接：
   - state: blocked
   - blocker: 需要浏览器验证，但本地端口被占用
   - evidence: 单测通过，截图未跑
   - next: 找可用端口启动 dev server

4. Browser Agent 接手：
   - 只处理视觉验证
   - 不改业务逻辑
   - 产出截图观察和必要 CSS 修复

5. Reviewer 接手：
   - 检查 diff 是否越界
   - 跑最终验证
```

这个流程里，交接把“谁能做什么”说清楚。Browser Agent 不需要重新设计业务逻辑，也不应该顺手重构导入模块。Reviewer 不需要再探索问题背景，它只要根据交接中的验收条件审查结果。每个角色都靠交接缩小工作面。

交接图解还可以用状态流表示：

```text
draft
  -> claimed
  -> working
  -> handoff_ready
  -> accepted
  -> working
  -> verified
  -> closed

异常分支：
working -> blocked -> reassigned
handoff_ready -> rejected -> working
accepted -> conflict_detected -> coordinator_review
```

这里有两个容易忽视的状态。`handoff_ready` 不等于 `accepted`。前一个 Agent 可以提交交接，但接手者要先校验它是否足够完整，工作区是否一致，写集合是否冲突。`conflict_detected` 也应该是显式状态，而不是在聊天里抱怨。只要检测到文件已经被别人改过，或者交接里的路径和实际 diff 不一致，就应该进入协调状态。

## 工程实现

我通常把交接对象设计成一个 envelope，里面分成可机器处理的头部和面向人的正文。头部用于调度、检查、过滤；正文用于解释工程判断。下面是一个可以落地的数据结构：

```yaml
handoff_id: hf_20260427_001
task_id: task_import_empty_state
run_id: run_7b31
created_at: "2026-04-27T16:20:00+08:00"
from_agent: worker-ui
to_agent_hint: browser-verifier
state: blocked
risk: medium
goal: "修复导入页面无数据时的空状态，并通过移动端视觉验证。"
scope:
  write_set:
    - src/pages/import/ImportPage.tsx
    - src/components/EmptyState.tsx
    - src/pages/import/ImportPage.test.tsx
  forbidden:
    - package.json
    - src/api/*
ownership:
  touched_files:
    - path: src/pages/import/ImportPage.tsx
      intent: "接入 EmptyState，处理 records.length === 0"
    - path: src/components/EmptyState.tsx
      intent: "增加 compact 变体"
  user_changes_observed:
    - path: src/theme/tokens.css
      action: "read only, do not revert"
evidence:
  commands:
    - cmd: "npm test -- ImportPage.test.tsx"
      exit_code: 0
      summary: "3 tests passed"
    - cmd: "npm run dev -- --port 3000"
      exit_code: 1
      summary: "port already in use"
assumptions:
  - text: "移动端重叠风险来自 compact 变体高度不足"
    confidence: "medium"
    verify_by: "打开 /import，375px 宽度截图"
blockers:
  - type: environment
    description: "默认端口被占用，尚未完成浏览器截图验证"
next_actions:
  - order: 1
    action: "使用可用端口启动 dev server"
  - order: 2
    action: "用浏览器检查 375px 和 1280px 视口"
  - order: 3
    action: "如有重叠，只修改 EmptyState 样式，不改业务 API"
acceptance:
  - "单测通过"
  - "移动端空状态按钮不换行遮挡"
  - "未修改 forbidden 路径"
```

这个结构不是为了显得正式，而是为了让接手者少猜。比如 `user_changes_observed` 很重要，它提醒下一个 Agent 某些 diff 不是上游 Agent 的，不要随便回滚。`assumptions` 也很重要，它把没有验证的判断单独拿出来，避免接手者把它当事实。`next_actions` 使用顺序字段，调度器可以直接展示成待办，也可以校验是否为空。

在实现上，handoff builder 不应该完全依赖模型自由发挥。可以把输入分成四类：任务元数据来自调度器，文件变更来自 git diff 或工作区扫描，命令证据来自工具执行记录，工程解释由 Agent 填写。这样交接更可靠。模型负责解释为什么这样做，而不是凭记忆列文件。文件列表和命令退出码应该由系统填充。

一个 Go 风格的结构体可以这样表达：

```go
type Handoff struct {
    ID          string        `json:"handoff_id"`
    TaskID      string        `json:"task_id"`
    CreatedAt   time.Time     `json:"created_at"`
    FromAgent   string        `json:"from_agent"`
    ToAgentHint string        `json:"to_agent_hint,omitempty"`
    State       HandoffState  `json:"state"`
    Risk        RiskLevel     `json:"risk"`
    Goal        string        `json:"goal"`
    Scope       Scope         `json:"scope"`
    Ownership   Ownership     `json:"ownership"`
    Evidence    Evidence      `json:"evidence"`
    Assumptions []Assumption  `json:"assumptions"`
    Blockers    []Blocker     `json:"blockers"`
    NextActions []NextAction  `json:"next_actions"`
    Acceptance  []string      `json:"acceptance"`
    Narrative   string        `json:"narrative"`
}

type Evidence struct {
    Commands []CommandResult `json:"commands"`
    Files    []FileEvidence  `json:"files"`
    Links    []ArtifactLink  `json:"links"`
}
```

真正的工程点在校验函数。比如状态为 `blocked` 时必须有 blockers；状态为 `handoff_ready` 时必须有 next actions；风险为 high 时必须有人工确认字段；存在写集合时 touched files 不能越界。校验器越早发现交接缺口，后续 Agent 越少浪费时间。

```go
func ValidateHandoff(h Handoff) []string {
    var errors []string
    if h.Goal == "" {
        errors = append(errors, "goal is required")
    }
    if h.State == "blocked" && len(h.Blockers) == 0 {
        errors = append(errors, "blocked handoff must include blockers")
    }
    if len(h.NextActions) == 0 && h.State != "verified" {
        errors = append(errors, "non-final handoff must include next actions")
    }
    allowed := map[string]bool{}
    for _, p := range h.Scope.WriteSet {
        allowed[p] = true
    }
    for _, f := range h.Ownership.TouchedFiles {
        if !pathAllowed(f.Path, allowed) {
            errors = append(errors, "touched file outside write set: "+f.Path)
        }
    }
    return errors
}
```

路径校验不能只做字符串相等，因为写集合可能是目录或 glob。更稳妥的做法是把写集合规范化成仓库相对路径，禁止 `..`，处理软链接，最后用同一套 matcher 校验。否则一个看似普通的路径可能越过边界。多 Agent 系统里，这种边界不是安全装饰，而是避免并行工作互相踩踏的基础。

交接生成的时机也要设计。只在任务结束时生成交接是不够的。长任务应该在三个时机生成 checkpoint：完成一个可验收子目标、遇到阻塞、上下文预算接近阈值。上下文预算触发很重要，因为很多 Agent 是在快没上下文时才被迫交接。此时如果没有增量记录，它会遗漏早期决策。可以让工具层持续记录轻量事件，handoff builder 在需要时聚合。

```text
事件日志：
- user_constraint_added: "只修改 content/articles/*.md"
- file_read: content/ARTICLE_STYLE.md
- file_written: content/articles/example.md
- command_run: python3 scripts/check_articles.py ...
- test_result: ok

交接生成：
- 读取任务元数据
- 汇总文件读写和命令结果
- 要求 Agent 填写 narrative、assumptions、risks
- 校验必填字段
- 保存版本并返回 handoff_id
```

如果多个 Agent 并行工作，handoff store 还需要冲突检测。冲突不只来自同一文件写入，也来自共享资源，比如同一个本地端口、同一条数据库迁移、同一个外部测试账号。交接里可以加入 `locks` 字段，说明当前 Agent 占用或释放了什么资源。接手者看到锁未释放，要先确认进程状态，不能盲目启动新服务。

```yaml
locks:
  - type: port
    id: "localhost:5173"
    status: released
  - type: branch
    id: "feature/import-empty-state"
    status: active
  - type: external_account
    id: "sandbox-crm-user-03"
    status: active
    note: "contains test campaign created by this run"
```

还有一个实用技巧：交接里要保留“不要做”的列表。人类交接常常会讲下一步，却忘记讲哪些路已经被证明不可行。Agent 接手后会重新探索，如果没有负面知识，它会消耗大量时间。`rejected_options` 可以记录被排除的方案、证据和是否可重新考虑。比如“不要升级 React 版本来解决这个样式问题，因为用户要求只改文章文件”；“不要删除缓存目录，因为失败来自权限而不是缓存污染”。

```yaml
rejected_options:
  - option: "修改全局 Button 组件"
    reason: "影响面过大，当前问题只在导入页空状态出现"
    evidence: "其它页面截图正常，单测只覆盖 ImportPage"
    revisit_when: "发现 EmptyState 局部修复无法覆盖"
```

交接正文的语气也要工程化。不要写“我认为可能差不多好了”，要写“已完成 A、B；未完成 C；C 的阻塞条件是 D；解除后第一步做 E”。不要把不确定性藏起来。多 Agent 协作不是比谁更自信，而是比谁能把不确定性准确传下去。

在仓库内落地时，可以把 handoff 作为任务系统里的对象，也可以作为临时 Markdown。对于轻量团队，`docs/handoffs/<task-id>.md` 就够用；对于平台化系统，建议存数据库并关联 trace、diff、artifact 和审批记录。无论存哪里，原则相同：结构化字段必须能被程序读取，叙事说明必须足够让人复盘。

## 测试评测

交接格式需要测试，不然它会慢慢退化成漂亮的说明文。测试可以分成静态校验、接手评测、回放评测和冲突评测。静态校验检查字段完整性和格式；接手评测看新 Agent 能否基于交接继续完成任务；回放评测用历史任务验证交接是否能复原关键决策；冲突评测模拟并行 Agent 修改同一区域，检查调度器能否发现。

| 评测类型 | 输入 | 观察指标 | 失败信号 |
| --- | --- | --- | --- |
| 静态校验 | handoff 对象 | 必填字段、枚举、路径范围 | 缺少 blocker、路径越界 |
| 接手评测 | 交接 + 干净上下文 | 接手耗时、重复探索次数 | 重新读取大量无关文件 |
| 回放评测 | 历史任务日志 | 决策还原率、证据覆盖率 | 不知道为什么选该方案 |
| 冲突评测 | 多个 handoff | 写集合冲突检出率 | 两个 Agent 改同一文件未报警 |
| 人工评审 | 抽样交接 | 可读性、风险表达 | “下一步”无法执行 |

接手评测最有价值。做法是故意不给接手 Agent 原始长对话，只给 handoff 和仓库，让它完成剩余任务。记录它需要额外探索多少文件、是否重复上游已经做过的尝试、是否违反 scope。一次好的交接应该让接手者快速进入执行，而不是重新做需求分析。

可以设计一组固定样本。比如样本一是前端修复，样本二是后端迁移，样本三是文档长文，样本四是 CI 失败诊断。每个样本都有标准交接和带缺陷交接。评测时比较不同格式下的完成率和误操作率。很多团队只评测模型答案质量，不评测协作质量，结果多 Agent 系统上线后才发现主要问题不是模型不会做，而是交接把信息丢了。

回放评测要关注“证据链”。比如交接说“测试通过”，回放时应该能找到命令、退出码和摘要；交接说“某方案不可行”，应该能找到失败原因；交接说“用户禁止修改配置”，应该能找到用户指令来源。如果证据链断了，交接就会变成不可验证的口头承诺。

冲突评测可以比较机械。构造两个 handoff：一个写 `src/api/user.ts`，另一个写 `src/api/*`；一个占用端口 3000，另一个也要求 3000；一个修改数据库迁移，另一个修改模型定义。调度器应该能标出冲突，要求协调，而不是把两个 Agent 结果硬合并。代码仓库里的冲突不仅是 Git 冲突，语义冲突更常见。

人工评审不需要重。可以每周抽十条交接，让团队按三个问题打分：能否理解当前状态，能否直接执行下一步，能否知道哪些风险不能碰。低分交接拿出来改协议字段，而不是只批评某个 Agent 写得不好。协议如果总让 Agent 漏同一种信息，说明字段设计本身有问题。

## 失败模式

第一个失败模式是“角色叙事替代工程状态”。交接写了很多“分析 Agent 已完成分析，执行 Agent 可以继续执行”，但没有文件、命令、阻塞和验收。角色名不能恢复现场，工程状态才能。解决办法是减少角色套话，增加结构化字段。

第二个失败模式是“把假设写成事实”。上游 Agent 没跑浏览器，却写“页面正常”；没读完整配置，却写“没有兼容问题”。接手者会基于错误事实继续推进，最后问题更隐蔽。交接必须允许诚实表达未验证状态，而且未验证不应该被视为低质量。真正低质量的是把未验证包装成完成。

第三个失败模式是“隐藏失败尝试”。有些 Agent 为了让交接看起来顺利，只写最终方案，不写被排除方案。接手者遇到类似问题会重新尝试同样路径。对于长任务，关键失败尝试是资产。交接不需要记录所有弯路，但要记录会影响后续决策的失败。

第四个失败模式是“工作区所有权混乱”。交接没有说明哪些 diff 是自己造成的，哪些是用户原有改动。接手者为了清理工作区可能误删用户内容。这个问题在共享仓库里非常严重。解决方式是交接自动记录 touched files，并在开始任务时记录初始 dirty 状态。接手者看到非本人改动，应默认保留。

第五个失败模式是“下一步不可执行”。比如写“继续优化性能”“完善测试”“检查边界”。这些都太大。下一步应该是动作，例如“运行 `go test ./internal/search -run TestRanker`，如果失败先看 `ranker_fixture.json` 的字段名变更”。可执行下一步可以让接手 Agent 减少自由探索，也更容易被调度系统估算。

第六个失败模式是“交接过度压缩”。为了省上下文，只剩结论，没有证据。接手者虽然知道方向，却不知道为什么。过度压缩常见于上下文快满时临时总结。解决办法是持续事件记录，让最后生成交接时不依赖模型短期记忆。

第七个失败模式是“交接协议和真实工具脱节”。协议要求记录命令结果，但工具层没有保存命令输出；协议要求记录文件改动，但执行环境拿不到 diff；协议要求记录外部 artifact，但没有统一 artifact ID。字段再好，如果系统不能自动填充，最终会变成手写负担。工程上要优先自动采集事实字段，人工只补解释。

第八个失败模式是“接手不验收交接”。下一个 Agent 拿到交接就开始改，不检查状态和工作区是否匹配。比如交接说端口已释放，实际进程还在；交接说测试通过，代码又被用户改过。接手时应该先做轻量验收：确认文件存在、关键 diff 仍在、阻塞是否解除、写集合是否冲突。交接不是圣旨，是可验证输入。

## 上线 checklist

- 为每类任务定义 handoff schema，至少包含目标、范围、状态、证据、阻塞、下一步、风险和所有权。
- 状态使用枚举，不允许只写“完成了一部分”“差不多好了”。
- 文件改动、命令结果、测试输出、artifact 链接尽量由系统自动采集。
- 每个 handoff 保存创建时间、来源 Agent、任务 ID、运行 ID 和版本。
- 写集合和禁止范围必须可校验，路径统一为仓库相对路径。
- 状态为 `blocked` 时必须有 blocker，状态非最终时必须有 next actions。
- 交接中区分事实、假设和建议，不把未验证判断写成事实。
- 记录用户原有改动和当前 Agent touched files，避免接手者误回滚。
- 支持 rejected options，保留关键失败路径和不可行方案。
- 接手 Agent 必须先验收 handoff，再继续修改文件或调用有副作用工具。
- 调度器检查写集合、资源锁、端口、外部账号等冲突。
- 高风险任务要求人工确认 handoff，尤其是数据库迁移、权限变更、外部发送和批量写操作。
- 定期抽样评审交接质量，把低分样本转成 schema 改进。
- 用历史任务做回放评测，验证只凭交接能否恢复现场。
- 保留 handoff 与最终结果的关联，方便事故复盘和模型评测。

## 总结

多 Agent 协作的关键不是让模型扮演更多职位，而是让任务状态可以被可靠交接。交接格式是 Agent 之间的接口协议，也是长任务的 checkpoint、审计日志和上下文压缩层。它必须回答当前状态、证据、风险、下一步和所有权，而不是写一段漂亮总结。

好的 handoff 会让接手者少猜、少重复探索、少误改文件。它把事实和假设分开，把写集合和用户改动分开，把完成结果和未完成风险分开。工程上要用 schema、校验器、事件日志和调度器把这些规则固化下来。多 Agent 系统越复杂，越不能靠临场默契。交接协议稳定了，角色分工才有意义，并行协作才不会变成混乱叠加。
