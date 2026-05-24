---
slug: codex-review-workflow
url: /notes/codex-review-workflow/
title: 用 Codex 做代码 review
summary: review 要先找风险、行为回归和测试缺口。
categoryKey: workflow
category: Workflow
categoryLabel: AI 工作流与工具
source: NOTES/WORKFLOW
date: 2026-02-24
image: /assets/article-visuals/codex-review-workflow.svg
tags:
  - Codex
  - Review
---

![标题图](/assets/article-visuals/codex-review-workflow.svg)

## 问题背景

很多团队第一次把 Codex 放进代码 review 流程时，会把它当成一个更快的 lint。让它扫一遍 diff，看看有没有空指针、拼写错误、命名问题，最后输出几条建议。这个用法能省一点时间，但没有抓到 AI review 最有价值的部分。真正难的 review 不是发现某一行代码格式不整齐，而是判断一次改动是否改变了系统契约：请求路径有没有绕过权限，缓存有没有破坏一致性，失败分支有没有吞掉错误，测试是否真的覆盖了用户会遇到的路径。

人类 reviewer 的优势是上下文和责任感，知道这段代码为什么存在，也知道线上故障通常从哪里冒出来。Codex 的优势是耐心、检索能力和可重复执行。它不会因为一天看了二十个 PR 就放过异常分支，也不会嫌弃去追一个函数调用链。好的流程不是用 Codex 替代人，而是让它先完成机械但需要细心的证据收集，把 reviewer 的注意力留给产品语义、架构边界和取舍判断。

我更推荐把 Codex review 定义成“风险发现流程”，而不是“代码评价流程”。评价容易变成风格争论，风险才会逼着我们问具体问题：这次 diff 影响哪些入口？有没有跨越权限边界？对已有 API 的返回值、错误码、排序、幂等性有没有影响？如果问题发生在线上，我们能不能从日志和指标里看出来？测试失败时能不能定位到这次变更？这些问题都可以被系统化。

在很多仓库里，review 的真实输入不只是 diff。还包括 issue 描述、产品需求、迁移脚本、配置文件、CI 结果、历史事故、相关测试、发布计划和用户反馈。人类通常靠经验把这些材料拼起来，Codex 则需要明确的操作手册。否则它会在 diff 里做局部判断，看见新增字段就夸“结构清晰”，看见抽函数就说“可读性提升”，却没有检查字段是否进入序列化契约，也没有确认抽出的函数是否改变了锁的持有范围。

另一个常见问题是输出不可用。AI 给出十几条“建议考虑”“可能需要”“最好确认”的评论，表面上很勤奋，实际上增加 reviewer 负担。review 评论应该像 bug report：有位置、有证据、有影响、有复现或验证办法。没有证据的猜测可以放在“开放问题”里，但不要伪装成确定发现。Codex 如果不能说明为什么这行代码会触发风险，人类就很难判断要不要修改。

这篇文章讨论的是一个工程化的 Codex review 工作流。它适合研发助手、仓库机器人、提交前检查，也适合一个人在本地改代码前让 Codex 帮忙预审。重点不是写一个万能提示词，而是把 review 拆成可复用的阶段：收集上下文、建立改动模型、画出风险面、验证关键路径、生成少量高质量评论，并把测试缺口和残余风险交给人类。

## 核心概念

第一个概念是 `diff contract`。任何代码变更都在修改某种契约，哪怕开发者只说自己“重构了一下”。契约可能是 HTTP API 的请求响应，数据库字段含义，队列消息格式，缓存失效策略，命令行参数，前端交互，也可能是内部函数对调用者承诺的错误语义。review 的第一步不是逐行点评，而是问这次 diff 改了哪些契约，以及调用方是否一起更新。

第二个概念是 `blast radius`，也就是影响半径。一行配置可能只影响测试环境，也可能让所有租户走新逻辑。Codex 要从路径、包名、调用链、配置名、数据库表名和路由注册里推断影响范围。影响半径越大，评论标准越严格。改一个后台管理页的文案和改登录 token 校验，不能用同一套风险阈值。

第三个概念是 `behavioral regression`。很多回归不是语法错误，而是行为细节变化。例如原来空列表返回 `[]`，现在返回 `null`；原来超时会重试两次，现在直接失败；原来排序稳定，现在 map 遍历导致顺序随机。这类问题单看新增代码不容易发现，需要对比旧行为、新行为和调用者期望。Codex 适合做这种对照，因为它可以沿着旧实现和新实现分别走一遍。

第四个概念是 `test gap`。review 不是只有“代码有问题”才有价值。很多时候代码看起来合理，但没有测试覆盖关键风险。一个好的 Codex reviewer 应该明确说：当前测试覆盖了什么，没覆盖什么，建议补哪一个最小测试。测试缺口比泛泛的“建议增加测试”更具体，它要指向输入、状态、预期输出和失败断言。

第五个概念是 `actionable finding`。review 发现必须可执行。它至少包含四个元素：文件位置、风险说明、证据链、建议动作。没有位置，人类不知道改哪里；没有风险说明，团队不知道优先级；没有证据链，评论像猜测；没有建议动作，讨论会拖很久。

| 概念 | Codex 需要产出的内容 | 不合格输出 | 合格输出 |
| --- | --- | --- | --- |
| diff contract | 被修改的外部或内部契约 | “代码结构有变化” | “`CreateOrder` 的重复请求从返回旧订单变为报错，影响客户端重试” |
| blast radius | 影响入口、调用者和数据范围 | “影响可能较大” | “该配置被 `api` 和 `worker` 同时读取，所有租户共享” |
| behavioral regression | 新旧行为差异 | “这里可能有回归” | “旧逻辑保留空字符串标签，新逻辑过滤后会丢失用户自定义标签” |
| test gap | 最小补测建议 | “建议加测试” | “缺少并发重复提交下只写一条 ledger 的测试” |
| actionable finding | 可直接处理的评论 | “这里要注意” | “在 `store.go:88` 返回前应回滚事务，否则后续重试会看到半写入状态” |

这些概念可以让 Codex 的 review 不再像聊天，而像工程检查。它先构建一张风险地图，再决定哪里值得深入读。这样输出会少很多，但更有密度。对团队来说，宁愿每个 PR 只有两条真正需要处理的发现，也不希望看到二十条无法决策的提醒。

## 架构/流程图解说明

一个稳定的 Codex review 流程可以按下面的图理解：

```text
Pull Request / Local Diff
  |
  |-- metadata：需求、issue、作者说明、目标分支
  |-- code diff：新增、删除、移动、重命名
  |-- repository context：调用链、测试、配置、历史实现
  |-- CI signal：失败任务、覆盖率、静态检查
  v
Review Intake
  v
Change Model Builder
  |-- 修改了哪些契约
  |-- 影响哪些入口和调用方
  |-- 新旧行为有什么差异
  v
Risk Prioritizer
  |-- 安全、数据、兼容性、并发、性能、可观测性
  v
Evidence Pass
  |-- 读取相关文件
  |-- 追踪调用链
  |-- 对照测试
  |-- 必要时运行目标测试
  v
Findings + Test Gaps + Open Questions
```

这张图的关键是不要让 Codex 一上来就评论每个 hunk。先做 intake，确认输入材料是否足够。一个 PR 如果只有 diff，没有需求说明，Codex 要把假设写清楚：它只能检查实现风险，不能判断产品语义是否满足。接着构建 change model，把 diff 转成“系统行为变化”。然后按照风险排序，而不是按照文件顺序阅读。

一次 review 可以分成五轮。

第一轮是快速扫面。Codex 读取变更文件列表、提交信息和测试变化，先判断类型：bugfix、feature、refactor、migration、dependency bump、config change。类型会影响检查重点。依赖升级要看 breaking change 和锁文件；迁移要看回滚和兼容读写；重构要看行为保持；安全相关改动要看绕过路径。

第二轮是契约建模。Codex 找出新增或修改的入口，例如路由、RPC 方法、CLI 命令、队列消费者、定时任务、数据库 schema、公开包函数。每个入口都要记录调用者、输入、输出、副作用和错误语义。如果 diff 修改了内部函数，也要追踪它是否被外部入口使用。

第三轮是风险展开。对每个契约变化打标签：权限、数据完整性、幂等性、并发、兼容性、性能、观测性、测试覆盖。不是所有标签都要深入，优先检查高影响、高不确定、低测试覆盖的组合。

第四轮是证据验证。Codex 不应该只凭直觉评论。它要读旧代码、新代码、相关测试和调用方；能运行目标测试就运行；不能运行也要说明原因。对于重要发现，最好能构造一个最小输入例子，展示为什么会失败。

第五轮是输出整理。最终评论按严重程度排序，先给 bug 和回归，再给测试缺口，最后给开放问题。风格建议只有在影响维护性或误导调用者时才保留。review 的目标是减少风险，不是展示模型读了很多代码。

## 工程实现

要把这个流程落地，可以先定义 review 的中间数据结构。无论用 Go、TypeScript 还是 Python，核心字段都差不多。下面用 Go 表达一个简化模型：

```go
type ReviewInput struct {
    RepoRoot       string
    BaseRef        string
    HeadRef        string
    ChangedFiles   []ChangedFile
    PullRequest    PullRequestMeta
    CI             []CISignal
    UserIntent     string
}

type ChangeContract struct {
    ID             string
    Kind           string // http_api, db_schema, cli, worker, package_api, config
    Name           string
    Files          []string
    Callers        []string
    OldBehavior    string
    NewBehavior    string
    SideEffects    []string
    Compatibility  string
}

type RiskItem struct {
    ContractID     string
    Category       string // security, data, concurrency, compatibility, performance, observability
    Severity       string // critical, high, medium, low
    Confidence     string // high, medium, low
    EvidenceNeeded []string
}

type ReviewFinding struct {
    File           string
    Line           int
    Severity       string
    Title          string
    Evidence       []string
    Impact         string
    Recommendation string
    TestSuggestion string
}
```

这组结构的价值，是让 Codex 在脑子里保持同一套 review 语言。它可以先填 `ChangeContract`，再生成 `RiskItem`，最后只有证据足够时才转成 `ReviewFinding`。如果某个风险没有证据，就进入开放问题，而不是强行评论。

提示词也要围绕这些结构写，而不是只说“请帮我 review”。一个本地工作流可以这样运行：

```text
1. 读取 git diff --name-status，分类变更文件。
2. 对每个高风险文件读取完整上下文，而不是只看 diff。
3. 构建 ChangeContract 列表，明确新旧行为。
4. 为每个契约生成 RiskItem，按严重程度和不确定性排序。
5. 对最高优先级的 3 到 5 个风险追证据。
6. 只输出证据充分的 Finding，其余放到 Open Questions。
7. 运行相关测试或给出无法运行的原因。
```

举一个具体例子。假设一个 Go 服务里有订单创建接口，PR 把幂等逻辑从 handler 移到了 service：

```go
func (s *OrderService) Create(ctx context.Context, req CreateOrderRequest) (*Order, error) {
    if req.IdempotencyKey != "" {
        existing, err := s.orders.FindByKey(ctx, req.IdempotencyKey)
        if err == nil {
            return existing, nil
        }
    }

    order := NewOrder(req.UserID, req.Items)
    if err := s.orders.Insert(ctx, order); err != nil {
        return nil, err
    }
    return order, nil
}
```

新代码看起来更整洁，但 Codex review 不应该停在“抽象更清晰”。它要追问：`FindByKey` 返回 `ErrNotFound` 和数据库错误是否都进入同一个分支？如果 `err` 是连接超时，新逻辑会继续创建订单，可能导致重复扣款。旧逻辑是否区分了 not found 和 transient error？有没有唯一索引兜底？测试是否覆盖数据库查询失败？如果没有，这就是一个高价值 finding。

一条合格评论可以是：

```text
`OrderService.Create` 现在把 `FindByKey` 的所有错误都当成“没有旧订单”处理。
如果查询因为超时或主从延迟失败，代码会继续 `Insert`，客户端重试时可能创建重复订单。
建议只在 `errors.Is(err, ErrNotFound)` 时继续创建；其他错误直接返回，并补一个
`FindByKey` 返回临时错误时不会调用 `Insert` 的测试。
```

这里有位置、证据、影响和修复方向。它不是泛泛地说“错误处理可能有问题”，而是把失败路径讲清楚。人类 reviewer 可以快速判断并修掉。

在仓库里落地时，我会给 Codex 准备一个 review checklist，但 checklist 不是让它逐项机械输出，而是作为内部检查表：

| 检查项 | 触发条件 | 要读取的证据 | 常见发现 |
| --- | --- | --- | --- |
| 权限边界 | 路由、中间件、角色判断变化 | 路由注册、auth middleware、调用方 | 新入口未挂权限、管理员判断被绕过 |
| 数据完整性 | 写数据库、迁移、事务变化 | schema、事务边界、唯一索引、重试逻辑 | 半写入、重复写、旧数据读不出来 |
| 并发幂等 | 锁、缓存、队列、重试变化 | 锁粒度、key 设计、worker 数量 | 重复消费、竞态覆盖、死锁 |
| 兼容性 | API 响应、消息格式、配置字段变化 | 客户端、文档、序列化测试 | 字段改名、默认值变化、旧客户端崩溃 |
| 性能 | 查询、循环、批处理变化 | explain、索引、数据量估计 | N+1 查询、全表扫描、缓存击穿 |
| 可观测性 | 错误处理、日志、指标变化 | log key、metric label、trace span | 失败无日志、指标基数爆炸、告警失效 |

如果要接入 CI，可以让 Codex 分两种模式运行。轻量模式只读 diff 和少量上下文，适合每次 push 后快速给作者反馈；深度模式在 PR 准备合并前运行，允许读取更多文件、运行目标测试、追调用链。不要让所有 PR 都跑最重流程，否则成本和延迟会让团队关掉它。

输出格式也要固定。我倾向于三段：

```markdown
## Findings

- [high] 标题
  - 位置：
  - 证据：
  - 影响：
  - 建议：
  - 测试：

## Test Gaps

- 缺口：
  - 当前覆盖：
  - 建议补测：

## Open Questions

- 需要作者确认的问题：
```

这能把确定 bug、测试缺口和需要确认的语义问题分开。Codex 不能把“不知道产品是不是允许”写成 bug，也不能把“没有测试”伪装成确定回归。分层输出会让 review 更容易被团队接受。

如果要把评论真正发到 PR，还要解决去重和生命周期问题。AI 每次运行都可能用不同措辞描述同一个风险，如果不做归一化，PR 里会堆出多条重复评论。一个简单做法是为 finding 生成稳定指纹：

```go
type FindingFingerprint struct {
    File        string
    Symbol      string
    Category    string
    EvidenceKey string
}
```

`EvidenceKey` 不要使用完整自然语言，而要使用能稳定定位行为的字段，例如 `FindByKey:non_not_found_error:continues_insert`。当下一次 review 发现同类问题时，机器人更新原评论，而不是新增评论。如果代码修改后证据消失，机器人可以把评论标记为 resolved candidate，交给人类确认。这样 AI review 才像一个持续工作的检查器，而不是每次都从头喊一遍。

权限也要纳入实现。Codex 在 review 里通常只需要只读能力：读 diff、读文件、读 CI、运行本地测试。它不应该默认拥有 push、merge、改 label、关闭 issue 的权限。即使后续要让它自动修复，也应该拆成另一个 workflow：review 负责发现，repair 负责生成补丁，merge 仍由人类或规则门禁决定。把发现和修改分开，会让团队更容易信任它。

还有一个容易忽略的点是“仓库知识注入”。通用模型不知道你们的错误码规范、日志字段约定、租户隔离模型和发布节奏。如果每次 review 都重新解释，成本高且容易漏。更稳的做法是在仓库里维护 `REVIEW_GUIDE.md` 或 `.codex/review.yaml`，写清楚本仓库的硬规则。例如：所有外部 API 必须返回结构化错误；所有跨租户查询必须带 `tenant_id`；所有后台任务必须暴露 `job_id`；数据库迁移必须兼容上一版本二进制。Codex review 先加载这些规则，再结合 diff 判断。这样评论会越来越像团队内部 reviewer，而不是互联网上的通用代码建议。

最后，review 结果应该进入度量系统。不是为了考核作者，而是为了改进流程。可以记录每周 AI 找到的高风险问题数、被采纳比例、误报比例、平均响应时间、最常见测试缺口、哪些模块反复出现同类问题。如果一个模块总被指出缺少幂等测试，问题可能不在 Codex，而在模块设计没有提供容易测试的边界。好的 review workflow 会反过来推动架构变清晰。

## 测试评测

Codex review 本身也需要评测。否则团队只能凭感觉判断“最近评论还不错”。我建议先做一个小而硬的 golden set，把历史 PR、真实事故和人工构造的风险样本放进去。每个样本都要有期望发现、允许的表达范围、不得出现的误报，以及必要证据。

评测样本可以长这样：

```yaml
id: review-order-idempotency-001
title: 幂等查询错误被当成未命中
changedFiles:
  - internal/order/service.go
  - internal/order/service_test.go
expectedFindings:
  - category: data_integrity
    severity: high
    mustMention:
      - FindByKey
      - ErrNotFound
      - duplicate order
      - no Insert on transient error
falsePositiveBudget: 1
requiredEvidence:
  - old behavior distinguishes not found
  - new behavior ignores non-nil err
```

评测不要只看有没有说中关键词。更重要的是判断它是否给出了可操作证据。一个回答提到“可能重复订单”，但没有指出错误分支，也没有建议如何补测试，应该只能拿部分分。可以把评分拆成四项：发现正确性、证据质量、建议可执行性、噪声控制。

我还会在评测里加入“作者反驳”样本。真实 review 不是模型说完就结束，作者可能回复“这个路径只有内部任务会调用”“这里上游已经做了权限检查”“这个错误不会发生，因为数据库有唯一索引”。Codex 需要能读取反驳并重新核验证据，而不是固执重复原评论。对于被证据推翻的 finding，它应该主动降级或撤回；对于作者反驳但证据不足的情况，它可以把问题改写成需要确认的开放项。这个能力非常实用，因为代码 review 本质上是协作，不是单向判决。

另一个评测维度是跨文件一致性。很多 bug 分散在多个文件里，单看任何一个文件都没问题。例如配置新增了 `enable_new_billing`，服务层读取默认值为 true，部署文件却没有给老环境显式设置；又比如数据库迁移新增非空字段，写路径有默认值，历史数据回填任务却没有覆盖失败重试。Codex review 要能把这些片段连起来。评测样本里应该包含这种“多点组合才出问题”的案例，否则 reviewer 会退化成局部 diff 检查器。

| 指标 | 含义 | 目标 |
| --- | --- | --- |
| Recall@Critical | 严重问题是否被发现 | 高，宁愿多花一点时间 |
| Precision@Findings | 输出的 finding 有多少是真的 | 高，避免污染 review |
| Evidence Score | 是否引用具体路径、分支和行为 | 必须达标 |
| Test Gap Quality | 补测建议是否能失败后变绿 | 中高，关注关键路径 |
| Noise Count | 风格类、猜测类评论数量 | 越低越好 |

还要评估稳定性。同一个 PR，重复跑三次，finding 不应该完全漂移。模型可以措辞不同，但关键发现、严重程度和建议测试应该一致。如果结果随机，团队很难把它接入合并流程。稳定性差通常是因为提示词过于开放、上下文选择不固定、没有强制证据结构，或者一次性塞了太多无关文件。

测试运行也要纳入 review 结果。Codex 可以根据变更文件选择目标测试，例如 Go 仓库里从包路径推断 `go test ./internal/order/...`。如果测试失败，它要区分“已有失败”“本次引入失败”“环境失败”。如果无法运行，比如缺少数据库或密钥，也要记录，不要沉默。review 的可信度来自证据链，测试是证据链的一部分。

上线前可以先让 Codex shadow review。也就是它输出评论，但不自动发到 PR，只给维护者看。维护者标注哪些有用、哪些噪声、哪些危险。跑两三周后再决定是否自动评论。对于自动评论，我建议只发布 high 和 critical，medium 以下先进入摘要，避免把 PR 讨论区变成噪声场。

## 失败模式

第一类失败是局部化过度。Codex 只看 diff，不读调用方，结果把重构当成等价变换。真实系统里很多契约藏在调用方和测试里，比如调用者依赖错误字符串、依赖返回顺序、依赖 nil 和空切片的差异。解决办法是强制它为高风险函数读取至少一个上游入口和一个下游依赖。

第二类失败是评论过多。模型为了显得有帮助，会输出大量低置信建议。团队一旦觉得它啰嗦，就会忽略所有评论。要用输出预算约束它：最多列出五条 finding，必须按严重程度排序，低置信内容进开放问题。对风格问题默认不评论，除非它会导致真实误解。

第三类失败是证据不足却语气确定。比如看到 `context.Background()` 就断言“会导致泄漏”，但没有确认调用场景。review 应该允许不确定，但不允许把猜测写成事实。可以要求每条 finding 标注 confidence，并写出至少两条证据。证据不足时改成问题：“这个后台任务是否需要继承请求取消信号？”

第四类失败是忽略测试语义。Codex 可能看到测试文件增加了，就认为覆盖充分，却没有判断断言是否验证关键行为。比如测试只检查返回状态码，不检查数据库副作用；只测 happy path，不测错误分支。解决办法是让它用风险反推测试，而不是用测试数量判断质量。

第五类失败是被作者说明带偏。PR 描述说“纯重构，无行为变化”，Codex 可能降低警惕。但 review 应该把作者意图当输入，不当结论。尤其是重构、依赖升级、配置调整，最容易出现“看起来无行为变化”的回归。

第六类失败是不了解团队约定。比如某个仓库约定所有 handler 都由网关统一鉴权，Codex 却每次都要求 handler 自己检查权限。解决办法是把仓库约定写入 review 手册，并用反例训练评测。AI review 要本地化，否则会变成通用建议生成器。

第七类失败是运行成本失控。深度 review 会读很多文件、跑很多测试，如果每次 push 都执行，会拖慢开发。要按风险分级调度：小文档变更只做格式和链接检查；核心服务变更做深度风险分析；迁移和权限相关变更要求人工确认后再合并。

## 上线 checklist

- 明确 Codex review 的目标是发现风险、回归和测试缺口，不是替代人类最终批准。
- 从历史 PR 和事故里整理至少二十个 golden case，覆盖数据、权限、并发、兼容性、性能和观测性。
- 固定输出格式，把 findings、test gaps、open questions 分开。
- 要求每条 finding 包含位置、证据、影响、建议和测试建议。
- 为低置信内容设置去处，不允许混入高置信 bug 列表。
- 设置评论预算，例如最多五条 finding，按严重程度排序。
- 按变更类型选择 review 深度，避免所有 PR 都跑重流程。
- 接入目标测试时记录命令、结果和失败原因。
- shadow review 一段时间，由维护者标注有用率和误报。
- 对仓库特有约定建立 review 手册，例如鉴权位置、错误码规范、事务约定和日志字段。
- 禁止自动应用修改，除非团队明确启用了单独的修复流程。
- 对安全、数据迁移、账务、权限相关变更保留人工 reviewer 的强制门禁。
- 记录每次 review 的输入版本、模型版本、上下文文件和测试命令，方便追溯。
- 定期用新事故更新评测集，把漏报转成回归样本。
- 在 PR 模板里要求作者说明风险、测试和兼容性，给 Codex 更好的输入。

## 总结

用 Codex 做代码 review，关键不是让它多说话，而是让它按工程风险工作。先建立 diff contract，再评估影响半径，然后追行为回归和测试缺口。它最适合承担那些耗时、细碎、需要耐心的检查：读调用链、对照旧行为、找错误分支、确认测试是否真的断言了风险。

一个成熟的 AI review 流程应该输出少量高质量发现，而不是大量建议。每条发现都要有证据和动作；不确定的问题要进入开放问题；测试缺口要具体到输入、状态和断言。团队也要像测试软件一样测试 reviewer，用历史事故和 golden case 衡量召回、精度、证据质量和噪声。

最终，人类 reviewer 仍然负责判断产品语义和架构取舍。Codex 的价值，是把可重复的风险扫描做扎实，让人类把时间花在真正需要经验的地方。这样的 review 才能进入日常工程流程，而不是停留在一次新鲜的 AI 演示。
