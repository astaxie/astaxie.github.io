---
slug: embeddings-pipeline
url: /notes/embeddings-pipeline/
title: Embedding Pipeline 设计
summary: Embedding 不是一次性脚本，而是可追踪的数据管线。
categoryKey: llm-apps
category: LLM Apps
categoryLabel: LLM 应用工程
source: NOTES/LLM
date: 2026-03-16
image: /assets/article-visuals/embeddings-pipeline.svg
tags:
  - Embedding
  - Pipeline
---

![标题图](/assets/article-visuals/embeddings-pipeline.svg)

## 问题背景

很多团队第一次做知识库检索时，会把 embedding 当成一个离线脚本：扫一遍 Markdown、PDF、网页或数据库记录，切块，调用模型，写进向量库，然后开始问答。这个路径能很快做出 demo，但一旦资料每天都在变、用户开始依赖答案、索引规模超过本地内存，脚本就会暴露出工程问题。今天某个文档改了标题，旧向量还在；昨天模型升级，只有一半数据重新嵌入；删除的合同仍能被召回；切块策略变更后无法解释召回质量变化；线上回答引用了过期段落，排查时发现没人知道那条向量来自哪个版本的源文件。

Embedding 的本质不是“把文本变成向量”这么简单。它是知识系统的数据管线，连接源数据、解析器、清洗规则、切块策略、模型版本、索引结构、召回服务和评测集。任何一环变化，都会影响最终检索质量。把它写成一次性脚本，相当于把数据治理、版本管理、重试机制和观测全部丢掉。短期看省事，长期看每一次问题都要从头猜。

在 RAG 和 Agent 应用里，embedding pipeline 还承担一个很关键的责任：把“可读材料”转成“可被系统稳定访问的证据单元”。模型回答不应该只依赖相似度最高的几段文字，还要知道这些文字来自哪里、什么时候生成、是否被撤回、属于哪个权限范围、和上游文档的结构关系是什么。没有这些元数据，检索结果只是一些孤立向量；有了管线化设计，检索结果才是可以审计、可以回放、可以更新的知识资产。

我在工程里更倾向于从三个问题开始设计 embedding pipeline。第一，源数据如何变化，系统如何知道要重新处理哪些内容。第二，文本如何被切成既适合模型理解又适合引用的片段。第三，向量和元数据如何一起版本化，使得检索质量出现波动时能定位到具体原因。只要这三个问题没有答案，向量库再快、模型再新，也只是把不确定性推迟到线上。

一个常见场景是团队文档站。上游包括产品 PRD、设计决策、事故复盘、API 文档和代码注释。用户的问题可能是“支付回调失败时应该怎么补偿”，也可能是“这个接口为什么不支持批量更新”。如果 pipeline 只按文件切块，很容易把上下文切断；如果只按段落切块，召回结果可能过碎；如果不记录文档状态，草稿和废弃方案也会被回答出来；如果没有增量索引，每次全量重建都会带来成本、延迟和线上抖动。Embedding pipeline 的价值，就是把这些现实问题在数据进入向量库之前处理清楚。

## 核心概念

设计 embedding pipeline 时，我会把它拆成八个概念：源对象、内容快照、解析产物、规范化文本、切块单元、嵌入任务、索引记录和召回视图。它们看起来比“文档到向量”复杂，但每个概念都对应一个真实的排障点。

| 概念 | 主要字段 | 工程作用 | 常见错误 |
| --- | --- | --- | --- |
| 源对象 | source_id、uri、owner、state | 标识数据来源和权限边界 | 只保存文件路径，不保存业务状态 |
| 内容快照 | content_hash、etag、updated_at | 判断是否需要重新处理 | 每次扫描都全量重算 |
| 解析产物 | title、sections、blocks、assets | 保留文档结构 | 直接把 HTML 或 PDF 文本拼成一坨 |
| 规范化文本 | language、normalized_body | 去掉噪声并稳定输入 | 清洗规则变化后不记录版本 |
| 切块单元 | chunk_id、parent_id、range | 支持召回和引用 | chunk 没有稳定 ID |
| 嵌入任务 | model、dimension、prompt_version | 管理模型与参数 | 模型升级后混用向量 |
| 索引记录 | vector_id、metadata、visibility | 写入向量库和过滤条件 | 元数据太少，无法过滤 |
| 召回视图 | active_index、alias、ranking_profile | 控制线上读取哪一版 | 重建索引时直接覆盖线上表 |

源对象是所有后续数据的根。它可以是一篇 Markdown、一个网页、一条数据库记录、一段代码注释，也可以是一个工单。关键是源对象要有稳定身份，而不是依赖临时文件名。内容快照负责回答“这次内容和上次是否一样”。在 Git 仓库里可以用 blob hash；在对象存储里可以用 etag；在数据库里可以用更新时间加正文 hash。快照不是为了省调用费这么简单，它让 pipeline 能做幂等处理和增量更新。

解析产物决定系统是否理解文档结构。比如 Markdown 的标题层级、列表、表格和代码块，PDF 的页码和段落，网页的导航、正文、脚注，都不应该被粗暴压扁。检索结果的可解释性很大程度来自结构保留：用户看到引用时，要能回到“第几节、哪一段、哪一张表”。如果解析阶段丢掉结构，后面再靠模型补回来，质量很难稳定。

规范化文本是模型输入的稳定层。它处理换行、空白、重复导航、页眉页脚、不可见字符、语言标记和敏感字段脱敏。这里要特别注意规则版本。很多团队发现召回质量突然变差，最后定位到某次清洗把代码块里的错误码删掉了，或者把中文标点统一时破坏了表格。规范化不只是清理，它是会影响语义的转换。

切块单元是 embedding pipeline 的核心产物。chunk 不能只是一段文本，它至少要知道自己来自哪个源对象、哪个快照、哪个结构位置、前后邻居是谁、是否包含标题、是否需要和父级摘要一起召回。对于技术文档，我通常让 chunk 保留“局部正文 + 层级标题 + 必要上下文”。这样向量既能表达段落内容，也能表达它在文档里的语义位置。

嵌入任务需要独立建模。一次 embedding 调用包含模型名、向量维度、输入格式、归一化规则、重试策略和费用统计。把它独立出来，才能在模型升级、维度变更或限流时有清楚的状态。索引记录则是面向检索服务的对象，它把向量、文本、引用、权限、状态、时间和业务标签放在一起。召回视图最后控制线上使用哪套索引和哪套 ranking profile，避免重建过程污染生产流量。

## 架构/流程图解说明

一个稳健的 embedding pipeline 不应该让写入向量库成为第一目标。更合理的流程是先把数据处理成可追踪的中间产物，再由索引发布步骤把通过校验的记录切换到线上视图。

```text
源系统
  |
  v
扫描器：发现新增、更新、删除、权限变化
  |
  v
快照表：source_id + content_hash + state + visibility
  |
  v
解析器：Markdown / HTML / PDF / DB record -> structured document
  |
  v
规范化：清洗噪声、保留结构、脱敏、生成 normalized_hash
  |
  v
切块器：chunk + heading path + source range + neighbor links
  |
  v
任务队列：embedding jobs，按模型版本和优先级调度
  |
  v
向量写入：vector store + metadata store + raw text store
  |
  v
索引发布：质量检查、别名切换、灰度、回滚
  |
  v
检索服务：过滤 -> 召回 -> 重排 -> 引用组装
```

这张图的重点是“中间状态可落盘”。扫描器只负责发现变化，不负责做全部工作；解析器失败不会导致整批任务丢失；切块策略升级可以在旧快照上重跑；embedding 模型切换可以并行生成新索引；发布步骤可以在新旧索引之间比较质量。每个阶段都有自己的输入、输出和错误状态，系统才能在规模变大后继续可控。

工程上我会把 pipeline 分成三条路径。第一条是 ingestion path，负责把源数据转成标准文档和 chunk。第二条是 embedding path，负责把 chunk 转成向量并写入候选索引。第三条是 serving path，负责在线检索和引用展示。三条路径共享元数据，但不要互相阻塞。比如线上检索不应该依赖正在运行的解析任务；解析失败也不应该影响已经发布的旧索引；新模型生成的向量只有通过评测后才会进入 serving alias。

这里还有一个容易忽略的设计：删除和失效要作为一等事件处理。很多人只考虑新增和更新，删除时直接从源目录看不到文件，却没有从向量库里删除旧 chunk。更好的做法是扫描器产生 `source_deleted` 或 `source_archived` 事件，索引发布步骤把对应 chunk 标记为不可见，再异步物理删除。这样即使删除事件处理失败，也能通过状态表追踪。

## 工程实现

具体实现时，可以先定义一组稳定的数据结构。下面是一个偏 Go 服务的简化模型，真实项目里可以拆成数据库表、队列表和对象存储记录。

```go
type SourceSnapshot struct {
    SourceID      string
    URI           string
    SourceType    string
    ContentHash   string
    State         string // active, draft, archived, deleted
    Visibility    string // public, team, private
    Owner         string
    UpdatedAt     time.Time
    ParserVersion string
}

type ChunkRecord struct {
    ChunkID          string
    SourceID         string
    SnapshotHash     string
    ChunkerVersion   string
    HeadingPath      []string
    Text             string
    TextHash         string
    StartOffset      int
    EndOffset        int
    PrevChunkID      string
    NextChunkID      string
    Metadata         map[string]string
}

type EmbeddingJob struct {
    JobID        string
    ChunkID      string
    TextHash     string
    Model        string
    Dimension    int
    Status       string // queued, running, done, failed, skipped
    RetryCount   int
    ErrorMessage string
    CreatedAt    time.Time
}

type VectorRecord struct {
    VectorID       string
    ChunkID        string
    Model          string
    Dimension      int
    IndexName      string
    Metadata       map[string]string
    EmbeddedAt     time.Time
}
```

这些字段里最重要的是各种 hash 和 version。`ContentHash` 表示源内容有没有变；`ParserVersion` 表示结构解析规则；`ChunkerVersion` 表示切块算法；`TextHash` 表示送进 embedding 模型的最终文本；`Model` 和 `Dimension` 表示向量空间。只有这些信息齐全，系统才能回答：“为什么这个 chunk 需要重新嵌入？”如果源内容没变，但 chunker 版本变了，需要重新切块；如果 chunk 文本没变，但模型版本变了，需要重新嵌入；如果只改了权限元数据，可能只需要更新索引 metadata，不需要重新调用 embedding。

增量处理的核心逻辑可以写成事件驱动，也可以先用批处理加状态表。小团队不必一开始就上复杂流式系统，但状态必须清楚。一次扫描后，对每个源对象计算快照，然后和数据库里的上一版比较：

```text
if source_missing:
    emit SourceDeleted(source_id)
elif content_hash changed or parser_version changed:
    emit SourceChanged(source_id, new_snapshot)
elif visibility changed:
    emit MetadataChanged(source_id, visibility)
else:
    skip
```

切块策略要按内容类型做，而不是一个固定字符数走天下。技术文章可以按标题层级切，再把过长 section 按段落合并；API 文档可以以 endpoint 为主要边界；代码文档可以按函数、类型和注释块；事故复盘可以按时间线、影响、原因、修复和预防措施切。每个 chunk 的文本建议包含一个短的上下文头，例如：

```text
文档：支付回调补偿设计
路径：异常处理 / 回调超时 / 重试策略
正文：
当第三方网关返回超时但本地订单状态未知时，补偿任务不应立即关闭订单...
```

这个上下文头会占用一些 token，但能显著改善召回。因为用户很少精确复述正文，他们会用上层概念提问。标题路径让 chunk 的向量同时携带局部事实和结构语义。需要注意的是，标题路径也要进入 `TextHash`，否则标题变更后系统会误以为 embedding 输入没变。

向量写入最好采用候选索引加发布别名。比如当前线上使用 `kb_v20260310`，新一轮处理写入 `kb_candidate_20260316`。评测通过后，把检索服务里的 alias 从旧索引切到新索引。这样做有几个好处：重建期间不会污染线上；失败时可以丢弃候选索引；新旧索引可以做 A/B 比较；模型维度变化时也不会和旧向量混在同一个集合里。

元数据过滤不能临时拼。检索服务应该在召回之前就应用权限、状态、语言、项目、时间等过滤条件。一个向量记录至少要带这些 metadata：

| 字段 | 用途 |
| --- | --- |
| source_id | 回到源对象，支持删除和引用 |
| chunk_id | 唯一定位片段 |
| state | 排除 draft、archived、deleted |
| visibility | 权限过滤 |
| owner/team | 团队范围过滤 |
| updated_at | 新鲜度排序和冲突判断 |
| heading_path | 生成引用和上下文展示 |
| content_hash | 排查向量来源 |
| model | 区分向量空间 |

在 Go 服务里，写入过程还要处理批量、限流和重试。Embedding API 常见的失败包括 429、超时、单条输入过长、内容触发安全策略、网络中断和服务端 5xx。重试要按错误分类，不能一律无限重试。输入过长应该回到切块阶段修复；权限缺失应该标记配置错误；429 可以指数退避；内容被拒绝需要记录 source_id 并进入人工处理队列。

还有一个工程细节：不要把原文只存向量库 metadata。很多向量库对 metadata 大小有限制，也不适合作为文档存储。更稳的做法是三份存储分工：对象存储或数据库保存原始解析产物，关系型数据库保存 source、chunk、job 状态，向量库保存向量和用于过滤的少量 metadata。检索时先从向量库拿 chunk_id，再批量回表取文本和引用信息。这样索引可以重建，原始证据不会丢。

## 测试评测

Embedding pipeline 的测试不能只测“能不能写入向量库”。要分层测：解析是否稳定，切块是否合理，增量是否正确，召回是否命中，引用是否可回溯，权限是否生效，发布是否可回滚。每层测试失败的修复路径不同，混在一起只会让排查变慢。

| 测试类型 | 样例 | 通过标准 |
| --- | --- | --- |
| 解析快照测试 | 同一 Markdown 重复解析 | structured document 完全一致 |
| 切块黄金测试 | 含标题、表格、代码块的技术文档 | chunk 数量、标题路径、范围符合预期 |
| 增量测试 | 修改一个段落、改权限、删除文件 | 只产生必要任务 |
| 向量任务测试 | 模拟 429、超时、输入过长 | 状态、重试、错误分类正确 |
| 召回评测 | 问题和期望 source_id/chunk_id | topK 命中率达标 |
| 引用测试 | 返回 chunk 后生成链接 | 能打开原文位置 |
| 权限测试 | 不同用户检索同一问题 | 不泄露不可见文档 |
| 发布测试 | 候选索引质量低于旧索引 | 不切换 alias |

召回评测最好不要只写“问题 -> 标准答案”。对于 embedding pipeline，更有效的是写“问题 -> 必须召回的证据”。例如：

```json
{
  "query": "支付回调超时后补偿任务怎么避免重复扣款？",
  "must_hit": [
    {
      "source_id": "docs/payment/callback-retry.md",
      "heading": "幂等键与补偿任务",
      "reason": "这里定义了重试时使用 order_id + gateway_txn_id 作为幂等键"
    }
  ],
  "filters": {
    "team": "payment",
    "state": "active"
  }
}
```

这类评测能把问题定位在检索层，而不是让生成模型掩盖召回失败。指标可以从 `Recall@K` 开始，再加上 `MRR`、重复 chunk 比例、过期文档召回率、无权限召回率、平均上下文 token、P95 检索延迟和单次更新成本。对于中文技术文档，我还会单独看“标题词命中”和“错误码命中”，因为用户经常用模块名和错误码定位问题，清洗或切块稍有不慎就会丢。

评测集要分桶。基础桶覆盖高频问法；结构桶覆盖表格、代码块、列表和多级标题；变更桶覆盖刚更新的文档；权限桶覆盖跨团队隔离；冲突桶覆盖新旧知识同时存在；长尾桶来自线上失败。每次 pipeline 变更，例如换 embedding 模型、调整 chunk size、改清洗规则，都要在这些桶上对比旧索引和新索引。不要只看总体分数，因为总体分数很容易被高频简单样本掩盖。

生产观测同样重要。每一次检索请求都应该有 trace：query、用户过滤条件、召回的 chunk_id、相似度、重排分、最终进入上下文的片段、生成答案引用、耗时、成本和版本。线上用户反馈“答案不对”时，工程师应该能打开 trace 看到：是没有召回正确文档，还是召回了但重排丢掉，还是进入上下文后模型没用，还是引用展示指向了旧位置。没有 trace，embedding pipeline 的问题会被误判成 prompt 问题。

## 失败模式

Embedding pipeline 的失败经常不是一次大事故，而是很多小偏差累积。第一类是静默过期。源文档已经删除或归档，向量还在服务。用户问到旧方案时，系统继续给出看似合理的答案。解决办法是把删除、归档和权限变化都作为增量事件，并在检索层默认过滤非 active 状态。

第二类是向量空间混用。不同模型、不同维度、不同输入格式生成的向量被写进同一个集合，短期可能不报错，但相似度不再有统一含义。表现为召回结果飘忽，某些新文档永远排不上来。解决办法是模型和维度必须进入 index name 或 metadata，发布时按同一向量空间切换。

第三类是切块失去语义边界。固定每八百字切一段，可能把一个决策的条件和结论分开，也可能把表格表头和表体拆散。召回时用户看到半句话，生成模型只好猜。解决办法是以结构优先，长度只是约束；对于表格、代码和列表要有专门策略。

第四类是清洗过度。为了减少噪声删除了代码块、错误码、URL、版本号、表格符号，结果把技术文档最有检索价值的信息去掉了。清洗规则要有测试样本，尤其保留错误码、接口名、配置项、命令和枚举值。

第五类是元数据缺失。向量召回到了相关文本，但无法判断用户是否有权限，无法生成引用，无法知道是否过期。元数据不是锦上添花，而是生产检索的安全边界。最少要有 source_id、chunk_id、状态、权限、更新时间和版本。

第六类是重建污染线上。全量重建时直接删除旧索引再写新索引，中途失败导致部分文档消失。或者候选索引未评测就切换，召回质量下降。解决办法是候选索引、质量门禁和 alias 切换三步走。

第七类是成本失控。扫描器没有正确判断 hash，每次部署都全量 embedding；重试没有上限；大文档被切成过多碎片；无效草稿也进入索引。成本问题通常来自状态设计，而不是单价。要在 job 层统计每个 source、每个模型、每次发布的调用量和失败率。

第八类是评测错位。离线评测只问几个漂亮问题，线上用户却用权限过滤、时间限制和模糊描述提问。最后指标很好看，真实体验不好。评测样本必须从线上 trace 回流，并保留失败原因，否则 pipeline 会朝错误方向优化。

## 上线 checklist

- 源对象有稳定 `source_id`，删除、归档、权限变化都能进入 pipeline。
- 快照表记录 `content_hash`、解析版本、状态、可见范围和更新时间。
- 解析器对 Markdown、HTML、PDF 或业务记录有结构化产物，而不是只输出纯文本。
- 规范化规则有版本号，并有样本覆盖代码块、表格、错误码、链接和中文标点。
- 切块器保留标题路径、源位置、前后邻居和父子关系。
- chunk ID 可复现，同一快照和同一切块规则下重复运行不会产生不同 ID。
- embedding job 有状态机、错误分类、重试上限、死信队列和成本统计。
- 向量索引按模型、维度和发布批次隔离，不混用不同向量空间。
- 向量库 metadata 至少支持权限、状态、source_id、chunk_id 和更新时间过滤。
- 原文和解析产物不只存在向量库里，可以通过 chunk_id 回表取证据。
- 候选索引发布前跑召回评测、权限测试、引用测试和延迟测试。
- 检索服务通过 alias 或配置切换索引，支持快速回滚到上一版。
- 生产 trace 记录 query、过滤条件、召回结果、重排结果、上下文片段和版本。
- 线上失败样本能回流到评测集，并标记失败发生在解析、切块、召回、重排还是生成。
- 对大批量重建设置速率限制和预算阈值，避免抢占线上服务资源。

## 总结

Embedding pipeline 的工程目标不是把所有文本尽快塞进向量库，而是把知识变成可追踪、可更新、可评测、可回滚的检索资产。向量只是其中一个产物，真正决定系统质量的是源数据治理、结构解析、切块策略、版本管理、元数据过滤、发布流程和观测回路。

如果一个团队刚开始做，可以先保持实现简单：一张 source 表，一张 chunk 表，一张 embedding job 表，一个候选索引，一个小评测集。但这些对象要从第一天就存在。后面无论换模型、扩文档、加权限、做 GraphRAG，还是把检索接进 Agent workflow，都能沿着这条管线演进。反过来，如果只有一个脚本和一个向量集合，早期速度很快，后期每次出问题都要重新补工程债。

Embedding 是 LLM 应用里最像数据工程的一环。它不靠一句 prompt 变稳定，也不靠一次全量导入变可靠。把它当成 pipeline，给每个阶段明确输入输出，给每个版本留下证据，给每次发布设置评测门槛，知识库才会从“能搜到一些东西”变成“能长期服务业务决策”的系统。
