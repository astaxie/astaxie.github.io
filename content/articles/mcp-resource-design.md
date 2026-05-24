---
slug: mcp-resource-design
url: /notes/mcp-resource-design/
title: MCP Resource 设计
summary: Resource 不是文件列表，而是模型能理解的上下文入口。
categoryKey: mcp
category: MCP
categoryLabel: MCP 与工具协议
source: NOTES/MCP
date: 2026-04-11
image: /assets/article-visuals/mcp-resource-design.svg
tags:
  - Resource
  - MCP
---

![标题图](/assets/article-visuals/mcp-resource-design.svg)

## 问题背景

很多团队第一次做 MCP Resource，会把它理解成“把系统里的文件、记录、文档列出来”。这个理解不算错，但太浅。Resource 的目标不是替代文件浏览器，也不是把数据库表直接摊给模型，而是给模型一个可理解、可选择、可验证的上下文入口。模型需要知道当前系统里有哪些信息源、每个信息源代表什么、什么时候该读、读出来后能支持什么判断。一个只返回长长文件列表的 Resource，很可能让模型更困惑，而不是更聪明。

在 Agent 工作流里，上下文是稀缺资源。模型窗口有限，用户耐心有限，工具调用也有成本。Host 不可能把整个仓库、全部工单、所有日志和个人知识库一次性塞进 prompt。Resource 的价值就在这里：它把庞大的信息空间拆成可发现、可读取、可分页、可缓存、可授权的入口，让 Agent 在需要时逐步取证。好的 Resource 设计会降低模型盲猜的概率，坏的 Resource 设计会把 Agent 推向“看似有很多信息，实际抓不住重点”的状态。

我见过几种常见失败。第一种是把 Resource 当文件树，暴露了几千个 URI，模型或 Host 根本不知道从哪里开始。第二种是把 Resource 当搜索结果，每次列表都动态返回一堆摘要，但 URI 不稳定，后续无法引用和回放。第三种是把权限交给下游系统，Resource 列表里先展示了用户无权读取的名称，读取时才报错，结果把敏感存在性泄漏出去了。第四种是忽略内容大小，读取一次资源返回几十万字，模型上下文被压爆，真正有价值的信息反而被截断。

Resource 设计的难点在于它同时面对三个读者。第一个读者是模型，它需要短而明确的描述、稳定的 URI 和足够的内容结构。第二个读者是 Host，它需要知道资源类型、大小、缓存、权限和变化通知，才能决定如何展示和何时读取。第三个读者是工程团队，它需要可测试、可观测、可演进的接口，能在资源命名、分页、脱敏和版本升级时不破坏旧任务。

所以，MCP Resource 不是“系统里有什么就暴露什么”。它更像一个上下文产品的 API 设计：先确定 Agent 要完成哪些任务，再确定它需要哪些证据，最后把证据设计成稳定入口。一个任务如果经常需要“理解当前仓库”，资源入口应该是仓库摘要、目录骨架、关键文件、最近变更和测试状态，而不是完整文件系统。一个任务如果经常需要“分析客户反馈”，资源入口应该是反馈主题、样本、时间范围、来源和置信度，而不是原始数据库导出。

这篇文章把 Resource 当成工程接口来讨论：怎么命名 URI，怎么做列表和模板，怎么组织内容块，怎么处理权限、缓存、大小限制、测试评测和上线检查。重点不在协议字段的逐项解释，而在如何让 Resource 真正服务 Agent 的上下文决策。

## 核心概念

第一个核心概念是“Resource 是可读证据，不是执行动作”。如果一个入口会修改状态，它应该是 Tool；如果一个入口提供上下文材料，它才是 Resource。这个边界听起来简单，但实际很容易混。比如“生成一份报告摘要”到底是 Resource 还是 Tool？如果摘要是对已有数据的只读视图，并且可以通过 URI 稳定读取，它可以是 Resource；如果生成过程会创建新文件、触发异步任务或消耗显著外部配额，它更像 Tool。

第二个概念是“URI 是长期契约”。Resource URI 不应该只是内部路径的直接暴露，也不应该带随机排序或一次性游标。URI 要能表达资源身份，最好能在日志、评测、审计和用户界面里稳定引用。比如 `repo://current/file/docs/adr/001.md` 比 `/Users/alice/work/project/docs/adr/001.md` 更适合 Agent；`feedback://product/app/range/2026-04/topic/onboarding` 比 `query?id=8f7a` 更适合回放和解释。

第三个概念是“列表不是越全越好”。`resources/list` 的目标是帮助发现入口，而不是枚举所有对象。对于小规模、稳定集合，可以列出具体资源；对于大规模、动态集合，更适合列出资源模板、索引资源或分层目录。模型需要的是“我应该从哪里开始”，不是“这里有十万条记录”。资源列表要像地图，而不是仓库清单。

第四个概念是“内容要为上下文组装服务”。Resource 返回的内容不应该只是大段原文。它应该带有内容类型、标题、摘要、来源、时间、片段边界和必要元数据。模型读取一份长文档时，最需要的是知道这是什么、为什么相关、哪些段落可引用、是否完整、有没有被截断。只返回一个 text blob，会让 Host 难以做引用，也让后续评测难以判断证据是否命中。

第五个概念是“权限要在发现阶段就介入”。如果用户无权读取某个资源，通常也不应该在列表里看到敏感名称。存在性本身可能就是敏感信息。Resource 设计要区分可发现、可读取、可引用和可导出四个权限。一个用户可能能发现项目摘要，但不能读取客户原文；能读取脱敏样本，但不能导出完整数据。把这些边界写进资源层，比让每个 Agent 自己判断更可靠。

下面这个表可以帮助团队在设计 Resource 时统一语言。

| 设计对象 | 关键问题 | 推荐做法 | 不推荐做法 |
| --- | --- | --- | --- |
| URI | 如何稳定定位资源 | 使用领域协议和可读路径 | 直接暴露本机绝对路径 |
| 列表 | 如何让模型发现入口 | 返回索引、模板和少量高价值资源 | 一次列出全部对象 |
| 内容 | 如何进入模型上下文 | 分块、摘要、元数据、引用 ID | 返回无结构大文本 |
| 权限 | 谁能发现和读取 | 发现前过滤，读取时再校验 | 列表展示后读取报错 |
| 缓存 | 何时复用结果 | ETag、版本、更新时间 | 靠 Host 猜测是否变化 |
| 观测 | 如何复盘使用 | 记录 URI、版本、大小、截断 | 只记录读取成功或失败 |

## 架构/流程图解说明

一个完整的 Resource 读取链路，通常不应该直接从协议层打到数据库或文件系统。中间需要资源目录、权限过滤、URI 解析、内容组装、大小控制和观测记录。可以把它理解为一个只读的上下文网关。

```text
Agent / Host
  |
  | resources/list 或 resources/read
  v
Resource Gateway
  | 请求 ID、actor、租户、trace
  v
Catalog
  | 资源索引、模板、描述、排序
  v
Policy Filter
  | 可发现权限、可读取权限、脱敏规则
  v
URI Resolver
  | 解析 repo://、issue://、feedback://、trace://
  v
Content Assembler
  | 摘要、分块、引用、大小限制、内容类型
  v
Backing Stores
  | Git、文档库、数据库、日志、对象存储、搜索索引
```

列表流程强调“从可发现入口开始”。Host 发起 `resources/list` 时，Resource Gateway 根据 actor 和当前工作区决定可以展示哪些资源组。Catalog 返回稳定排序的资源条目和模板，Policy Filter 去掉不可见对象，最后返回给 Host。这里的排序很重要。优先展示与当前任务最相关、最安全、最常用的入口，而不是按数据库主键或文件系统顺序。

读取流程强调“从 URI 到证据”。Host 发起 `resources/read` 后，URI Resolver 先判断 URI 是否属于已注册模式，再解析出领域参数。Policy Filter 再做一次读取权限校验，因为列表结果可能被缓存，权限也可能在两次调用之间变化。Content Assembler 从后端拿数据后，不是原样返回，而是根据内容类型组装成适合模型使用的块：标题、摘要、正文片段、引用 ID、截断提示、更新时间和来源。

```text
repo://current/file/docs/design.md
  |
  v
{scheme: repo, repo: current, kind: file, path: docs/design.md}
  |
  v
检查 actor 是否能读取 current 仓库和该路径
  |
  v
读取文件、检测 MIME、限制大小、生成章节片段
  |
  v
返回 text block + meta: path、commit、bytes、truncated、references
```

这里的 `commit` 或版本号很关键。Agent 可能先读取资源，再过几分钟执行工具。如果资源内容变了，后续动作依据的证据就可能失效。Resource 返回版本信息后，Tool 执行时可以带上“我基于哪个版本判断”的条件。比如修改文件前检查当前 commit 是否仍然一致，分析工单前检查 updated_at 是否没有变化。

Resource 还可以承担上下文导航。一个仓库资源不必只提供文件读取，也可以提供 `repo://current/overview`、`repo://current/recent-changes`、`repo://current/test-status`、`repo://current/dependency-map`。这些资源不一定对应物理文件，但它们对应 Agent 常见问题。设计 Resource 时要从任务路径反推入口：Agent 为了回答这个问题，第一步最该读什么？读完之后，下一层资源应该是什么？

## 工程实现

我会从资源目录模型开始。目录模型的目标是把资源身份、可发现信息和读取逻辑拆开。下面是一个简化结构：

```go
type ResourceDescriptor struct {
	URI         string
	Name        string
	Description string
	MimeType    string
	Kind        string
	Version     string
	Tags        []string
	EstimatedBytes int64
}

type ResourceTemplate struct {
	URIPattern  string
	Name        string
	Description string
	Parameters  []TemplateParameter
}

type ResourceProvider interface {
	List(ctx context.Context, actor Actor, cursor Cursor) (ResourcePage, error)
	Read(ctx context.Context, actor Actor, uri string, opts ReadOptions) (ResourceContent, error)
}
```

`ResourceDescriptor` 适合小规模、可以直接列出的资源，比如当前工作区概览、最近运行 trace、项目说明。`ResourceTemplate` 适合大规模资源，比如仓库文件、工单详情、日志片段。模板告诉 Host 和模型“这种 URI 可以读取”，但不要求一次枚举所有实例。这样既保留可发现性，又不会把列表变成巨大的对象 dump。

URI 命名要遵守几个原则。第一，scheme 表达领域，而不是技术实现。用 `repo://`、`issue://`、`feedback://`，少用 `postgres://`、`s3://` 这类后端细节。第二，路径表达稳定身份，不表达临时查询状态。时间范围、分页和筛选可以放进 query，但要可读且可规范化。第三，URI 不要承载权限秘密。不要把签名 token、临时下载地址或用户私钥塞进 URI。第四，URI 要有规范化函数，同一个资源不能因为大小写、重复斜杠或编码差异产生多个身份。

一个资源读取结果可以这样组织：

```go
type ResourceContent struct {
	URI       string
	Version   string
	MimeType  string
	Title     string
	Summary   string
	Blocks    []ContentBlock
	Meta      ResourceMeta
}

type ContentBlock struct {
	ID       string
	Type     string
	Text     string
	Citation string
}

type ResourceMeta struct {
	Source        string
	UpdatedAt     time.Time
	Bytes         int64
	Truncated     bool
	NextURI       string
	Sensitivity   string
}
```

这个结构的重点是 `Blocks` 和 `Citation`。Agent 不只是要读内容，还要在回答或后续动作里引用证据。每个 block 有稳定 ID，Host 可以把模型回答里的引用映射回资源片段。`Truncated` 和 `NextURI` 告诉 Agent 当前内容是否完整，以及如果不完整应该怎么继续读取。`Sensitivity` 可以帮助 Host 决定是否允许把内容发送给外部模型或写入日志。

内容组装要按类型处理。Markdown 文档可以按标题切块，代码文件可以按函数、类或固定行数切块，日志可以按时间窗口和错误等级切块，工单可以按字段和评论切块，表格可以按行范围切块。不要对所有资源使用同一种“每两千字切一块”的策略。切块边界如果破坏语义，模型会看到很多不完整证据，回答质量会下降。

权限实现上，我建议把“可发现”和“可读取”分成两个函数：

```go
type ResourcePolicy interface {
	CanDiscover(ctx context.Context, actor Actor, desc ResourceDescriptor) (bool, error)
	CanRead(ctx context.Context, actor Actor, uri string) (ReadDecision, error)
}

type ReadDecision struct {
	Allowed     bool
	Redactions  []RedactionRule
	MaxBytes     int64
	Sensitivity  string
}
```

发现权限决定列表里出现什么，读取权限决定内容如何返回。`ReadDecision` 不只是允许或拒绝，还能携带脱敏规则、大小限制和敏感等级。比如支持同一个反馈资源对产品经理返回脱敏摘要，对客服主管返回原文，对外部协作者只返回主题统计。这样 Resource 层可以统一治理，而不是让每个 Agent prompt 去记住复杂规则。

缓存设计也要和版本绑定。Resource 如果没有版本信息，Host 缓存就很危险；如果所有资源都不缓存，性能又会很差。对于 Git 文件，版本可以是 commit hash；对于工单，可以是 updated_at 或 revision；对于搜索结果，可以是查询规范化后的 hash 加索引版本；对于动态诊断资源，可以声明短 TTL。缓存 key 至少包含 URI、actor 权限范围、版本和脱敏策略。少一个维度，都可能造成旧数据或越权数据复用。

还要注意资源摘要不是简单截断。摘要应该由领域逻辑生成，例如仓库概览包括语言、入口目录、测试命令、最近变更和风险文件；客户反馈摘要包括主题、样本量、时间范围、代表性原文和异常值；日志摘要包括错误类型、时间分布、关联 trace 和最近部署。摘要越贴近任务，Agent 越少需要读取大文本。

一个具体例子：给代码仓库设计 Resource，可以分成四层。

| 层级 | URI | 用途 | 内容形态 |
| --- | --- | --- | --- |
| 入口 | `repo://current/overview` | 让 Agent 了解项目边界 | 项目摘要、语言、目录、测试命令 |
| 导航 | `repo://current/tree?depth=2` | 查找相关模块 | 稳定排序的目录树和说明 |
| 证据 | `repo://current/file/{path}` | 读取具体文件 | 按标题或函数切块，带行号引用 |
| 状态 | `repo://current/recent-changes` | 理解当前工作区变化 | git status、diff 摘要、风险提示 |

这样的设计比直接列出所有文件更适合 Agent。Agent 先读 overview，知道项目是 Web 站点还是 Go 服务；再读 tree 找模块；再读具体文件；如果需要修改，再读 recent changes 避免覆盖用户改动。每一层都有明确任务，不会把模型扔进无差别文件海。

再看一个客户反馈资源的例子。原始数据可能来自客服系统、应用商店评论、社区帖子和销售记录。如果直接把所有记录暴露成 `feedback://raw/{id}`，Agent 会先陷入召回问题：它不知道该读哪个来源、哪个时间范围、哪类客户。更合适的做法是先提供主题索引，再提供样本入口，最后才允许读取原文。

| 层级 | URI | 用途 | 设计要点 |
| --- | --- | --- | --- |
| 入口 | `feedback://product/app/overview?range=30d` | 理解最近反馈概况 | 主题、数量、趋势、来源分布 |
| 主题 | `feedback://product/app/topic/onboarding?range=30d` | 聚焦某类问题 | 代表性样本、置信度、变化趋势 |
| 样本 | `feedback://product/app/topic/onboarding/samples?limit=20` | 读取可引用证据 | 脱敏原文、渠道、时间、用户类型 |
| 原文 | `feedback://item/{id}` | 必要时核对细节 | 严格权限、脱敏策略、审计记录 |

这个例子能说明 Resource 不是越接近原始数据越好。Agent 多数时候需要先理解结构，再选择证据。主题资源不是为了替代原文，而是帮助模型把问题空间变小；样本资源不是为了穷举所有反馈，而是给模型足够可引用的证据；原文资源保留在最后一层，只有当任务需要精确措辞、投诉升级或合规复核时才读取。这样的层次设计会让上下文成本更低，也让权限治理更自然。

Resource 描述也要具体到任务。`用户反馈列表` 这种描述过于宽泛，模型不知道它适合做趋势分析、问题归因还是客服回复。更好的描述是“最近三十天按主题聚合的产品反馈，适合判断高频问题和选择后续样本；不包含完整用户原文”。一句话里同时说明范围、用途和限制，能显著减少错误读取。限制尤其重要，因为模型如果不知道一个资源不包含什么，就会把缺失信息当成事实。

在多人团队里，这些描述还承担协作契约的作用。后端知道哪些字段必须稳定，产品知道用户看到的证据来自哪里，安全团队知道哪些资源可能进入模型上下文。Resource 写清楚之后，很多争论会从“模型为什么乱读”变成“这个入口是否真的表达了任务需要”。

## 测试评测

Resource 的测试不能只验证“能读取”。更重要的是验证它是否能稳定提供上下文。测试应该覆盖列表、URI、权限、内容结构、大小限制、版本和评测样本。

| 测试维度 | 检查点 | 示例 |
| --- | --- | --- |
| 列表稳定性 | 排序、字段、模板是否稳定 | `resources/list` 连续两次输出一致 |
| URI 解析 | 规范化、非法路径、编码绕过 | `repo://current/file/../secret` 被拒绝 |
| 权限过滤 | 不可见资源是否在列表阶段消失 | 普通成员看不到高敏客户资源 |
| 内容结构 | title、summary、blocks、citation 是否存在 | Markdown 按标题切块并带引用 |
| 大小限制 | 超大文件是否摘要或分页 | 大日志返回 `truncated=true` 和 `nextURI` |
| 版本一致 | 读取结果是否带版本 | 文件资源返回 commit 或 revision |
| 脱敏 | 敏感字段是否替换且可审计 | 邮箱、手机号、密钥不进入文本块 |

一个好用的测试方式是准备小型 fixtures。比如一个仓库 fixture 包含 README、两个源码文件、一个隐藏目录、一个超大日志和一个符号链接。测试不需要真的连 Git，只要让 provider 读这个 fixture，就能覆盖目录树、文件读取、大小限制和危险路径。对工单或反馈资源，也可以准备几条不同权限和敏感等级的样本。

评测要关注模型是否能从 Resource 里找到证据。可以设计一组任务，例如“这个项目的测试命令是什么”“最近变更是否影响登录模块”“客户反馈里 onboarding 的主要抱怨是什么”。每个任务标注期望读取的资源 URI 和证据 block。让 Agent 在受控环境里完成任务，记录它读取了哪些资源、是否命中证据、是否读取过量无关资源。这样可以发现 Resource 入口是否清晰。

除了成功率，还要看上下文效率。一个 Resource 设计如果能回答问题，但每次都要读二十个大文件，也不是好设计。可以记录这些指标：平均读取次数、平均读取字节数、证据命中率、无关读取比例、截断后继续读取比例、权限拒绝比例、缓存命中率。Resource 是上下文基础设施，成本和质量要一起看。

失败回放也很重要。线上如果 Agent 读错资源、漏读资源或因为截断回答错误，要保存当时的 `resources/list` 摘要、读取 URI、版本、权限决策、返回 block 和模型最后引用。修复 Resource 描述、排序或切块策略后，用同一个任务回放，看 Agent 是否更早读到正确证据。否则团队很容易凭感觉改描述，改完后没有证据证明它真的更好。

Resource 还需要兼容测试。URI 一旦被外部 trace、评测和用户书签引用，就不能随意改。如果确实要升级命名，应该保留重定向或别名，并记录弃用时间。测试里要固定旧 URI 的读取行为，至少在迁移窗口内保证可用。对 Agent 来说，资源身份漂移会破坏长期记忆和回放数据。

## 失败模式

第一种失败是把资源列表做成数据倾倒。列表返回几千个文件、工单或数据库记录，看起来“信息很全”，实际模型只能在噪声里猜。解决办法是提供索引资源、模板和分层入口，让列表回答“从哪里开始”，而不是“全部有什么”。

第二种失败是 URI 不稳定。用搜索排名、临时游标或数据库自增 ID 直接做 URI，后续同一个任务回放时指向不同内容。Resource URI 要表达领域身份，动态查询结果也要有规范化参数和版本。对于临时结果，可以返回一个带 TTL 的快照资源，并明确它不是长期引用。

第三种失败是内容没有边界。读取一个 Markdown 返回整篇原文，没有章节 ID；读取日志返回一大段文本，没有时间范围；读取表格返回 CSV 字符串，没有列说明。模型可能能读，但 Host 很难做引用，评测也无法判断证据命中。内容块和引用 ID 是 Resource 工程化的基本单元。

第四种失败是权限后置。列表阶段暴露了项目名、客户名或文件名，读取时才拒绝。对一些业务来说，名称本身就是敏感信息。可发现权限要先于列表输出，读取权限只是第二道门。缓存也必须带权限维度，否则管理员读过的内容可能被普通用户命中。

第五种失败是摘要误导。为了省 token，Resource 返回了过度压缩的摘要，遗漏重要限定条件，Agent 据此做出错误判断。摘要可以短，但必须保留范围、来源、时间和不确定性。对于高风险任务，摘要应该引导 Agent 继续读取原始证据，而不是替代证据。

第六种失败是截断无提示。Server 为了限制大小默默截断内容，模型以为已经读完整，最后漏掉关键段落。所有截断都应该显式标记，并提供 `nextURI` 或更精确的读取方式。静默截断是上下文系统里非常危险的隐性错误。

第七种失败是把 Resource 做成隐藏 Tool。读取资源时顺便触发索引重建、同步远程数据或创建临时报告，导致读取变慢、有副作用、不可预测。如果确实需要昂贵计算，应该用 Tool 创建快照，再用 Resource 读取快照。这样副作用、耗时和审计边界都更清楚。

第八种失败是没有观测。只知道 `resources/read` 成功，不知道读了哪个 URI、返回多少字节、是否截断、命中哪个版本、用了什么脱敏策略。Agent 出错后，团队无法判断是模型没读、Resource 没给、权限拦了，还是内容被截断。Resource 读取事件应该是 Agent trace 的一等公民。

## 上线 checklist

- Resource URI 使用领域 scheme，不直接暴露本机路径、数据库连接或对象存储内部地址。
- `resources/list` 返回索引、模板和少量高价值入口，不枚举大规模动态对象。
- 列表输出稳定排序，并经过可发现权限过滤。
- 每个 URI 模式都有 parser、规范化和非法输入测试。
- 读取结果包含 title、summary、mime type、version、blocks、citation 和 meta。
- 大内容有大小限制、截断标记和继续读取入口，不做静默截断。
- 缓存 key 包含 URI、版本、actor 权限范围和脱敏策略。
- 发现权限和读取权限分开实现，敏感资源名称不会通过列表泄漏。
- 脱敏规则在 Resource 层执行，并记录脱敏命中和敏感等级。
- 资源摘要保留时间范围、来源、样本量和不确定性，不把摘要伪装成完整证据。
- 读取事件进入 trace，记录 URI、版本、字节数、耗时、截断、权限决策和错误类型。
- 有一组任务评测样本，检查 Agent 是否读取正确资源、命中正确证据、避免过量读取。
- URI 命名升级有兼容期，旧 URI 在迁移窗口内可读或可重定向。
- 高成本或有副作用的准备动作拆成 Tool，Resource 只负责读取稳定结果。

## 总结

MCP Resource 的核心不是“把数据暴露给模型”，而是把上下文设计成模型能理解、Host 能治理、工程团队能测试的入口。它既要提供足够证据，又要控制大小、权限、缓存和引用边界。Resource 做得好，Agent 会更少盲猜，更容易解释，也更容易从失败中学习；Resource 做得差，Agent 会在噪声、旧数据和权限错误里反复消耗 token。

设计 Resource 时，可以从任务出发：Agent 为了完成某类任务，需要先读哪些概览，再读哪些索引，最后读哪些原始证据。把这些路径固化成稳定 URI、内容块、引用 ID 和版本信息，再配上发现权限、读取权限、脱敏、截断和观测。这样 Resource 就不只是协议里的一个列表方法，而是整个 Agent 上下文系统的地基。

最终，好的 Resource 应该像一张清晰的地图。它不会把所有道路一次性塞给模型，而是标出入口、层级、证据和边界。模型沿着地图读取上下文，Host 能控制风险，开发者能通过测试和 trace 持续改进。这才是 MCP Resource 在真实工程里的价值。
