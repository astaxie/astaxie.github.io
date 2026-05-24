---
slug: mcp-versioning
url: /notes/mcp-versioning/
title: MCP 工具版本化
summary: 工具参数和返回值升级要兼容旧客户端。
categoryKey: mcp
category: MCP
categoryLabel: MCP 与工具协议
source: NOTES/MCP
date: 2026-03-31
image: /assets/article-visuals/mcp-versioning.svg
tags:
  - Versioning
  - MCP
---

![标题图](/assets/article-visuals/mcp-versioning.svg)

## 问题背景

MCP Server 刚接入一个 Agent 产品时，团队往往先关心工具能不能调用成功。工具描述写清楚，JSON Schema 能校验参数，handler 能返回结果，就觉得协议层已经完成。真正的问题通常发生在第二个月：业务字段改名，权限模型细化，返回结果需要补充证据引用，某个 Host 缓存了旧的工具列表，另一个 Host 已经把新 schema 暴露给模型。此时一次很小的字段调整，可能让旧客户端传入无法识别的参数，也可能让新客户端误以为所有 Server 都支持新能力。

MCP 工具版本化的难点不在于给工具名后面加一个 `v2`。难点在于工具的消费者不是一个固定前端，而是模型、Host、编排器、人工确认界面、审计系统和离线评测集共同组成的链路。模型会根据工具描述和 schema 生成参数；Host 会缓存工具列表并决定是否让用户确认；Server 会根据租户、权限、上下文执行真实操作；评测系统会把历史样本拿来回放。只要其中一层看见的版本和另一层不一致，就会出现“明明本地测试通过，线上却偶发失败”的情况。

传统 API 版本管理通常围绕 HTTP path、header 或 semver 展开。MCP 工具更细，因为一次工具调用包含多个可变面：工具名称、自然语言描述、输入 schema、输出结构、错误码、权限语义、幂等语义、结果大小、side effect 说明、采样和审计字段。更麻烦的是，自然语言描述本身也是接口的一部分。你把“按仓库搜索文件”改成“检索代码证据”，即使参数 schema 没变，模型的调用倾向也会变，历史评测结果也可能漂移。

我更愿意把 MCP 工具当成“面向模型的产品接口”，而不是一个普通函数。普通函数可以让调用方编译失败，然后大家同步升级；面向模型的接口必须在不打断旧会话、不破坏缓存、不污染评测集的前提下演进。版本化的目标不是让所有东西永远兼容，而是让不兼容变更可发现、可灰度、可回滚、可审计，并且让模型在升级窗口里尽量少犯错。

一个常见失败场景是给查询工具增加 `timeRange` 必填参数。后端同学认为这是安全改动，因为没有时间范围的查询成本太高。上线后，旧 Host 仍然缓存着旧 schema，模型继续调用 `search_logs`，没有传 `timeRange`。Server 如果直接返回 `invalid_input`，Agent 可能不断重试；如果 Server 默默填一个默认时间范围，又可能返回错误证据。正确做法应该是在版本策略里明确：旧版本工具继续支持无时间范围，但限制最大扫描窗口；新版本工具要求显式时间范围；Server 在响应里通过 warning 和 deprecation hint 促使 Host 更新缓存。

另一个场景是输出结构升级。早期 `repo.search` 只返回 `path` 和 `snippet`，后来为了可审计，需要返回 `evidence_id`、`commit`、`score` 和 `redaction_state`。如果直接改变结果数组结构，依赖旧字段的 Agent 评测会失败。如果同时返回新旧字段，结果变长又可能触发截断。这里需要把输出兼容策略写进版本协议：新增字段默认可忽略，字段语义改变必须升级版本，结果大小变化要进入评测，证据引用最好独立成稳定子结构。

所以 MCP 工具版本化不是发布规范里的附录，而是 Server 工程的核心设计。它需要从第一版就进入代码结构、测试集、观测字段和上线流程。没有版本化时，团队靠口头约定维护兼容；有版本化后，团队可以把每次改动落到变更类型、迁移策略、适配层和回滚计划上，减少 Agent 系统最怕的隐性行为漂移。

## 核心概念

MCP 工具版本至少有四个层次：协议版本、能力版本、工具版本和 schema 版本。很多系统只记录一个 `version` 字段，最后定位问题时才发现它含义不清。协议版本说明 Server 支持哪一版 MCP 协议能力；能力版本说明资源、提示词、工具、采样等 capability 的行为边界；工具版本说明某个工具的业务语义；schema 版本说明输入输出结构的精确形态。四者可以相关，但不能混用。

| 层次 | 关注点 | 典型变化 | 是否影响模型行为 | 推荐记录位置 |
| --- | --- | --- | --- | --- |
| 协议版本 | MCP 基础方法和消息格式 | 初始化字段、传输细节、通知语义 | 间接影响 | initialize 响应、Server 元数据 |
| 能力版本 | tools、resources、prompts 的可用范围 | 新增流式结果、资源订阅、确认策略 | 中等影响 | capability descriptor |
| 工具版本 | 工具业务语义和 side effect | 查询范围、写操作幂等性、权限要求 | 强影响 | tool name 或 tool annotations |
| Schema 版本 | 输入参数、返回结构、错误结构 | 字段新增、枚举扩展、字段废弃 | 强影响 | inputSchema、outputSchema、telemetry |

兼容性也要细分。输入新增可选字段通常是向后兼容，因为旧客户端不会传；输入新增必填字段是不兼容；输出新增字段通常兼容，因为旧消费者可以忽略；输出删除字段不兼容；枚举新增值对模型来说不一定兼容，因为旧 prompt 或评测可能只认识旧值；错误码新增通常兼容，但错误码含义变化不兼容；自然语言描述改写要进入行为评测，因为它会改变模型选择工具的概率。

我建议把变更分成五类：

| 变更类型 | 例子 | 版本动作 | 发布策略 |
| --- | --- | --- | --- |
| Patch | 修正文案错别字、放宽字段长度、修复 handler bug | schema 不变，tool revision 增加 | 可快速发布，但保留 trace |
| Additive | 新增可选输入、新增可忽略输出字段 | schema minor 增加 | 灰度给新 Host，旧 Host 可继续使用 |
| Behavioral | 排序规则、默认范围、权限判断改变 | tool minor 或新工具别名 | 必须评测和公告 |
| Breaking | 必填字段新增、字段删除、语义改名 | 新 major 或新工具名 | 双运行期、迁移窗口、明确下线 |
| Security Override | 紧急收紧权限、关闭高风险字段 | 安全策略版本增加 | 可以打断兼容，但要有审计说明 |

工具名称是否带版本，是一个需要谨慎处理的选择。`search_logs_v2` 简单直接，模型也容易区分，但工具列表会膨胀，描述相近时模型可能选错。`search_logs` 加 `schema_version` 字段更干净，但旧 Host 和离线样本可能不知道这个字段。我的实践是：破坏性变更用新工具名，兼容性变更保持工具名，通过 descriptor 中的 `x-tool-version`、`x-schema-version`、`x-deprecated-after` 等扩展字段记录。这样模型看到的是少量稳定工具，工程系统看到的是完整版本信息。

版本化还要处理 deprecation，也就是废弃。废弃不是删除前发一封通知，而是一个可观测的生命周期。工具可以进入 `active`、`deprecated`、`shadowed`、`blocked`、`removed` 五个状态。`deprecated` 表示仍可调用但返回 warning；`shadowed` 表示新版本也在后台执行或评测；`blocked` 表示默认拒绝但允许特定租户豁免；`removed` 表示工具不再出现在列表里，直接调用也返回稳定错误。

错误结构也属于版本契约。Agent 是否能恢复，取决于错误是否稳定。一个好的工具错误至少包含 `code`、`message`、`retryable`、`recoverable_by_user`、`recoverable_by_model`、`details_schema_version`。例如 `missing_time_range` 应该告诉模型可以补传 `timeRange`；`permission_denied` 应该告诉 Host 需要用户授权；`tool_version_removed` 应该提示 Host 刷新工具列表。把所有失败都变成自然语言，会让版本迁移不可自动化。

最后是版本协商。MCP Server 不应该假设 Host 永远取最新工具。Host 可能为了稳定固定某个工具版本，也可能针对某个会话锁定 tools/list 结果。Server 需要知道调用来自哪个 Host、哪个 session、哪个工具 descriptor revision。一次 `tools/call` 中即使工具名相同，也应该带上或可推导出 `tool_descriptor_id`。否则 Server 无法判断调用方看见的 schema 是哪一版，也就无法给出正确兼容逻辑。

## 架构/流程图解说明

一个可演进的 MCP 工具版本架构，可以拆成工具注册表、兼容适配层、策略层、执行层和观测层。

```text
Tool Registry
  |
  | tool descriptors: name, version, schema, lifecycle, annotations
  v
Host / Agent tools/list
  |
  | descriptor_id, schema_version, cache_ttl, compatibility_window
  v
tools/call
  |
  | tool_name, descriptor_id, arguments
  v
Version Resolver
  |
  | resolve tool version and schema version
  v
Input Adapter
  |
  | old args -> canonical command
  v
Policy Gate
  |
  | permission, tenant, risk, deprecation state
  v
Handler
  |
  | canonical execution
  v
Output Adapter
  |
  | canonical result -> client visible result
  v
Telemetry and Replay
```

这里最重要的设计是 canonical command，也就是内部规范命令。不要让每个 handler 同时理解三代输入结构。Server 可以接收多个 schema 版本，但进入业务执行前要统一转换成内部结构。输出也是一样，handler 返回内部规范结果，再由 output adapter 按调用方版本降级或补充字段。这样业务逻辑只维护一份，兼容逻辑集中在边界层。

以 `repo.search` 为例，早期版本只支持关键字搜索：

```json
{
  "query": "handler timeout",
  "pathPrefix": "services/"
}
```

新版本需要明确搜索模式、最大结果数、证据要求和大小写策略：

```json
{
  "query": "handler timeout",
  "scope": {
    "pathPrefix": "services/",
    "includeTests": true
  },
  "mode": "literal",
  "limit": 20,
  "evidence": {
    "includeCommit": true,
    "includeLineNumbers": true
  }
}
```

内部 canonical command 可以这样表达：

```go
type RepoSearchCommand struct {
    Query        string
    PathPrefix   string
    IncludeTests bool
    Mode         SearchMode
    Limit        int
    Evidence     EvidenceOptions
    Caller       CallerContext
    SourceSchema string
}

type EvidenceOptions struct {
    IncludeCommit      bool
    IncludeLineNumbers bool
    RedactionLevel     string
}
```

旧输入适配时，不是简单把缺失字段补零，而是明确业务默认值：

```go
func AdaptRepoSearchV1(args RepoSearchV1Args, ctx CallerContext) (RepoSearchCommand, []VersionWarning, error) {
    if strings.TrimSpace(args.Query) == "" {
        return RepoSearchCommand{}, nil, ErrInvalidInput("query_required")
    }
    limit := 10
    if ctx.HostCapability.SupportsLargeResult {
        limit = 20
    }
    return RepoSearchCommand{
        Query:        args.Query,
        PathPrefix:   args.PathPrefix,
        IncludeTests: false,
        Mode:         SearchModeLiteral,
        Limit:        limit,
        Evidence: EvidenceOptions{
            IncludeCommit:      false,
            IncludeLineNumbers: true,
            RedactionLevel:     "standard",
        },
        Caller:       ctx,
        SourceSchema: "repo.search.input.v1",
    }, []VersionWarning{
        {Code: "schema_deprecated", Message: "repo.search input v1 will be removed after 2026-06-30"},
    }, nil
}
```

这个例子里有几个细节。第一，默认值不是散落在 handler 里，而是在适配器里。第二，适配器返回 warning，Server 可以把 warning 放进结构化结果或 telemetry，不必污染主要业务字段。第三，`SourceSchema` 被写入内部命令，后续指标可以按版本聚合，知道旧 schema 还剩多少真实调用。

工具注册表可以用文件、数据库或代码声明维护，关键是每个 descriptor 都有稳定 ID。一个简化的数据结构如下：

```yaml
name: repo.search
descriptor_id: repo.search@2026-03-31.2
tool_version: 2.1.0
input_schema_id: repo.search.input.v2
output_schema_id: repo.search.output.v2
lifecycle:
  state: active
  introduced_at: 2026-03-31
  deprecated_after:
  removed_after:
compatibility:
  accepts:
    - repo.search.input.v1
    - repo.search.input.v2
  returns:
    default: repo.search.output.v2
    downgrade:
      repo.search.output.v1: supported
annotations:
  side_effect: read_only
  auth_scope: repo.read
  max_result_bytes: 65536
```

当 Host 调用 `tools/list` 时，Server 可以按 Host 能力、租户策略和灰度配置返回不同 descriptor。灰度不是在 handler 里随机，而是在 descriptor 层决定“这个会话看见哪一版工具”。这样同一个会话内工具列表稳定，模型不会前一次看到旧描述、后一次看到新描述。

## 工程实现

工程上我会先建立四个模块：`registry`、`resolver`、`adapter`、`contract_tests`。`registry` 管工具元数据，`resolver` 根据调用上下文决定版本，`adapter` 负责输入输出转换，`contract_tests` 固化兼容样本。不要一开始就把版本逻辑写进所有 handler，否则每次改动都要读完整业务代码。

工具注册表的关键字段包括：工具名、显示描述、输入 schema、输出 schema、生命周期、兼容窗口、权限 scope、风险等级、结果大小上限、默认超时、是否幂等。这里建议把自然语言描述也纳入版本指纹。很多团队只对 JSON Schema 做 hash，结果描述变化导致模型行为变了，却没有任何版本记录。可以把 descriptor 规范化后计算 `descriptor_hash`，写进 trace 和评测样本。

| 字段 | 是否进入 hash | 原因 |
| --- | --- | --- |
| name | 是 | 影响模型选择和路由 |
| description | 是 | 直接影响模型调用倾向 |
| inputSchema | 是 | 影响参数生成和校验 |
| outputSchema | 是 | 影响 Agent 解析结果 |
| annotations | 是 | 影响风险和确认策略 |
| cache_ttl | 否 | 运行策略，不一定改变接口语义 |
| rollout_percent | 否 | 灰度控制，不是契约 |

输入 schema 的兼容检查要自动化。每次 PR 改工具 schema 时，CI 应该比较旧 schema 和新 schema，给出变更分类。新增 required 字段直接标记 breaking；删除属性标记 breaking；新增可选属性标记 additive；枚举缩小标记 breaking；枚举扩大标记 risky additive；字段 description 改变标记 behavior risk。自动检查不能替代人工判断，但能阻止“顺手改一下”直接进主干。

输出 schema 也要做契约测试。很多 MCP 工具返回的是给模型看的结构化文本，开发者容易把输出当成展示层，随手调整字段名和排序。建议输出结果至少分成 `data`、`evidence`、`warnings`、`meta` 四块。`data` 放业务结果，`evidence` 放可引用证据，`warnings` 放版本和截断提示，`meta` 放 schema、trace、分页和统计信息。这样升级时可以在 `meta` 和 `warnings` 里承载版本信息，不打断主数据。

下面是一个具体输出例子：

```json
{
  "data": [
    {
      "path": "services/mcp/search.go",
      "line_start": 42,
      "line_end": 57,
      "snippet": "func Search(ctx context.Context, cmd RepoSearchCommand) ..."
    }
  ],
  "evidence": [
    {
      "id": "ev_01HZZ4",
      "kind": "source_line",
      "ref": "services/mcp/search.go:42"
    }
  ],
  "warnings": [
    {
      "code": "schema_deprecated",
      "message": "input schema v1 is deprecated",
      "remove_after": "2026-06-30"
    }
  ],
  "meta": {
    "tool": "repo.search",
    "descriptor_id": "repo.search@2026-03-31.2",
    "input_schema": "repo.search.input.v1",
    "output_schema": "repo.search.output.v2",
    "truncated": false
  }
}
```

如果旧 Host 只认识 `path` 和 `snippet`，output adapter 可以降级返回旧结构，同时把 warning 写入 telemetry。降级不要靠字符串拼接，而要有明确的转换函数和测试样本。对于模型来说，结果越稳定越好，字段顺序、命名和层级都不要频繁变化。

版本 resolver 需要处理四个输入来源。第一是 Host 初始化时声明的能力，例如是否支持 output schema、是否支持工具注解、是否支持结构化错误。第二是 `tools/list` 时 Server 返回给该会话的 descriptor。第三是 `tools/call` 时 Host 传回的 descriptor hint，如果协议或 Host 支持。第四是 Server 侧的租户配置和灰度规则。resolver 的输出应该是一个确定的 `ResolvedTool`，其中包含 handler、输入适配器、输出适配器、策略版本和生命周期状态。

| 决策点 | 推荐策略 |
| --- | --- |
| Host 没传 descriptor_id | 按 session 中最近一次 tools/list 快照解析 |
| 找不到 session 快照 | 使用兼容默认版本，并返回 `descriptor_unknown` warning |
| 工具处于 deprecated | 允许执行，记录指标，返回 warning |
| 工具处于 blocked | 拒绝执行，错误码 `tool_version_blocked` |
| 工具已 removed | 拒绝执行，错误码 `tool_version_removed`，提示刷新工具列表 |

如果 Server 支持多租户，还要把租户策略放进 resolver，而不是放到 handler 最后判断。原因很简单：同一个工具版本在不同租户里可能有不同能力。企业租户允许跨仓库搜索，个人租户只允许当前仓库；内部 Host 可以拿到调试字段，外部 Host 只能拿到脱敏摘要。resolver 如果只解析工具名，不解析策略版本，后面的 adapter 就不知道该返回哪一种 output schema。生产记录里最好同时写入 `tool_version`、`policy_version` 和 `result_profile`，这样排查“为什么这个租户看不到 commit 字段”时，不需要翻十几个配置文件。

我还会给每个适配器写一份迁移说明，放在代码旁边而不是只写在发布公告里。说明里包含旧字段到新字段的映射、默认值来源、哪些字段被废弃、哪些行为被收紧、哪些错误码会新增。这个文件不是给用户看的市场文档，而是给后续维护者看的工程备忘。半年后有人要删除 v1 adapter，只要看调用指标和迁移说明，就能判断删除是否安全。

```text
repo.search v1 -> v2 migration

query                  -> query
pathPrefix             -> scope.pathPrefix
missing includeTests   -> false, because v1 never searched tests by default
missing mode           -> literal, because v1 did not support semantic search
missing evidence       -> includeLineNumbers=true, includeCommit=false
limit absent           -> 10 for old hosts, 20 for hosts with large-result support
```

灰度发布时，不要只按请求随机。Agent 会话需要稳定性。同一个会话内，如果工具描述中途变化，模型可能在前半段计划中引用旧字段，后半段突然拿到新字段。比较稳的做法是按 `tenant_id + host_id + session_id` 做一致性哈希，决定这个会话进入哪个版本桶。灰度指标也要按版本拆开：调用量、校验失败率、模型重试率、人工确认拒绝率、工具错误率、结果截断率、用户修正率。

版本兼容期要有真实数据驱动。不要拍脑袋说“旧版本保留两周”。如果旧 schema 调用量每天仍有百分之三十，说明 Host 缓存、客户端升级或用户会话生命周期还没清干净。可以制定下线门槛：连续七天旧版本调用占比低于百分之一，且无高价值租户调用，且离线评测通过，才进入 blocked；blocked 保留一周后再 removed。这个策略比日期承诺更可靠。

自然语言描述的版本化要进入评测。工具 description、参数 description 和 examples 一变，模型选择率就可能变化。每个工具应该维护一组 golden prompts，覆盖应该调用、应该不调用、需要追问、需要拒绝、需要多工具组合的场景。描述改动后，跑一次工具选择评测：模型是否仍然选择正确工具，是否填对关键参数，是否错误触发写操作。这个评测不必完美，但必须持续存在。

## 测试评测

MCP 工具版本测试不能只测 handler 单元测试。handler 测试证明业务逻辑能跑，版本测试证明旧调用方不会被升级打断。建议建立五层测试：schema diff 测试、适配器测试、契约快照测试、Agent 选择评测、灰度观测回归。

Schema diff 测试在 CI 里跑，输入是旧 descriptor 和新 descriptor，输出是变更报告。如果 PR 声明是 additive，但 diff 发现删除字段或新增 required 字段，CI 应该失败。报告要给人看得懂，例如“`timeRange` 被加入 required，属于 breaking；请升级 major 或提供 v1 adapter”。不要只给 JSON patch，否则评审者很难判断风险。

适配器测试要用真实历史参数。可以从线上 telemetry 中抽样脱敏，保存为 fixtures。每个旧输入样本都要能转换成 canonical command，且默认值符合预期。对安全字段要特别测，例如旧版本没有 `includeDeleted` 字段时，默认必须是 false，而不是因为新版本默认 true 导致越权搜索。

契约快照测试关注输出结构。对每个工具版本保存一组期望输出快照，检查字段是否存在、错误码是否稳定、warning 是否按生命周期出现。快照测试不是让输出文本永远不能改，而是让每次改动都显式评审。对于模型可见文本，哪怕只是把“最多返回十条”改成“默认返回十条”，也可能影响调用行为，值得被看见。

Agent 选择评测是 MCP 版本化最容易被忽略的一层。工具 schema 没破，但模型行为可能破。评测样本应该包括：

| 样本类型 | 用户意图 | 期望行为 |
| --- | --- | --- |
| 正向调用 | “查找最近一次部署失败的日志” | 调用 `logs.search`，补齐时间范围 |
| 追问 | “帮我查错误”但没有项目和时间 | 不直接调用高成本工具，先追问 |
| 拒绝 | “删除所有过期记录”但无授权 | 不调用写工具，提示需要确认 |
| 多工具 | “找到 PR 失败原因并给出代码位置” | 先查 CI，再查仓库 |
| 反选择 | “解释 MCP 是什么” | 不调用内部工具 |

灰度观测回归是在生产流量里验证。新版本上线后，必须比较新旧版本的关键指标。比如新 schema 的参数校验失败率是否高于旧版本，模型重试次数是否上升，Host 取消率是否上升，用户是否更多地修正 Agent 结论。不要只看工具 handler 的错误率，因为很多版本问题表现为“成功返回了没用的结果”。

我还会为每个破坏性变更建立一次演练：模拟旧 Host 缓存旧 tools/list，直接调用旧参数；模拟新 Host 调用新参数；模拟 Host 没带 descriptor_id；模拟灰度回滚后会话继续调用；模拟工具 removed 后旧 Agent 继续重试。演练通过后才算版本策略可上线。

评测结果要能支持发布决策，而不是只给一个总分。一次版本升级至少要输出四类数字：调用选择准确率、关键参数完整率、错误恢复成功率、结果可用率。调用选择准确率回答模型是否选对工具；关键参数完整率回答模型是否填对必填和高风险字段；错误恢复成功率回答模型遇到结构化错误后能否追问或改参；结果可用率回答工具返回是否足够支撑最终答案。只要其中一项显著回退，就算 handler 全部通过，也不应该直接全量。

| 指标 | 采集方式 | 阻断条件 |
| --- | --- | --- |
| 工具选择准确率 | golden prompts 对比期望工具 | 高风险工具误选增加 |
| 参数完整率 | 检查模型生成参数和 schema | 必填字段缺失明显上升 |
| 错误恢复率 | 构造 permission、missing field、rate limit | Agent 进入重复调用 |
| 结果可用率 | 人工或规则判断答案证据 | 关键证据字段丢失 |

这些评测最好和版本号绑定。每条样本记录当时使用的工具描述、schema hash、模型版本和 Host 策略。否则几个月后看到某次升级导致回退，只知道“当时 repo.search 不好用”，却不知道是哪一版 description 让模型误解了参数含义。版本化的价值不只在运行时兼容，也在让历史评测可以被解释。

## 失败模式

第一类失败是隐式破坏兼容。开发者删除了一个“看起来没人用”的字段，但某个 Host 的提示词里仍要求模型读取该字段。因为模型不是编译型调用方，失败不会在构建阶段暴露，而是在某些任务中表现为答案变差。解决办法是 telemetry 中记录字段使用情况，输出字段废弃前先做 shadow 观测。

第二类失败是默认值漂移。同一个参数缺省时，v1 默认查最近一小时，v2 默认查最近一天。字段没变，schema diff 也看不出 breaking，但成本和结果语义完全不同。默认值必须写入 descriptor 或 adapter 测试，不能只存在代码里。

第三类失败是版本名污染工具选择。为了兼容，团队暴露 `search`、`search_v2`、`search_new`、`search_safe` 四个工具。模型看到相似描述后选错工具，或者在一个任务里混用。破坏性版本可以新建工具名，但旧版本进入 deprecated 后要减少在工具列表中的暴露，只给确实需要的 Host 返回。

第四类失败是错误码不稳定。旧版本返回 `permission_denied`，新版本返回 `access_error`，Host 的恢复逻辑失效。错误码需要像 schema 字段一样受版本管理。自然语言 message 可以优化，code 不要随便改。

第五类失败是 Host 缓存不可控。Server 已经 removed 某工具，但某些 Host 还持有旧工具列表。Server 必须在 `tools/call` 阶段处理未知或已删除版本，返回明确错误，并记录 Host 信息。不要假设 `tools/list` 是强一致的。

第六类失败是降级适配掩盖安全问题。为了兼容旧参数，Server 自动补默认权限或默认范围，结果让旧客户端绕过新安全要求。安全相关变更可以打破兼容，但要用 `security_override` 标记，并给用户可理解的错误。兼容性不能高于数据安全。

第七类失败是离线评测样本没有版本字段。几个月后团队重跑评测，只知道当时工具叫 `repo.search`，不知道具体 descriptor 和描述文本。结果评测无法复现，升级决策变成猜测。每个 replay 样本都要保存 descriptor hash、schema id、tool description 快照或引用。

第八类失败是输出变长导致截断。新增证据和元数据后，结果更完整，但模型实际看到的是被 Host 截断的尾部，关键字段丢失。版本升级必须评估结果大小，必要时引入分页、摘要和证据引用，而不是把所有字段一次塞回去。

## 上线 checklist

| 检查项 | 问题 | 通过标准 |
| --- | --- | --- |
| 变更分类 | 这次是 patch、additive、behavioral 还是 breaking | PR 中有明确分类和理由 |
| Descriptor | 工具描述、schema、annotations 是否有稳定 ID | 生成 descriptor hash 并写入记录 |
| 输入兼容 | 旧参数能否转换成 canonical command | 旧 fixtures 全部通过 |
| 输出兼容 | 旧消费者能否读取必要字段 | 契约快照通过，降级路径可测 |
| 错误结构 | 新旧错误码是否稳定 | Host 恢复逻辑测试通过 |
| 权限语义 | 默认值和权限是否被升级改变 | 安全评审确认，审计字段完整 |
| 评测 | 工具选择和参数生成是否漂移 | golden prompts 无明显回退 |
| 灰度 | 同一会话是否固定版本 | 灰度按 session 一致性哈希 |
| 可观测性 | 是否能按版本看调用和失败 | metrics 包含 descriptor_id 和 schema_id |
| 回滚 | 新版本失败时如何恢复 | 旧 descriptor、adapter 和策略仍可用 |
| 废弃 | 旧版本何时 warning、blocked、removed | 生命周期日期和门槛写清楚 |
| 文档 | Host 和 Agent 团队是否知道迁移方式 | changelog 有例子和错误码说明 |

发布前还要问几个具体问题。旧 Host 如果缓存工具列表七天，会发生什么？用户在长会话里开始时看到旧描述，结束前 Server 已经切到新版本，会发生什么？如果新字段让模型更频繁调用高成本工具，预算保护在哪里？如果旧版本继续运行，是否会绕过新审计要求？如果工具降级返回旧结构，是否还保留足够证据让 Agent 给出可信答案？

对破坏性变更，我的上线顺序通常是：先合入新 descriptor 和 adapter，但默认不暴露；再用离线评测验证描述和 schema；然后对内部 Host 灰度；接着对少量租户暴露新版本；同时旧版本开始返回 warning；当旧版本真实调用降到门槛以下，进入 blocked；最后 removed。任何一步指标异常，都回滚 descriptor 暴露，不需要回滚 handler 主逻辑。

对安全收紧，流程不同。比如某个工具过去允许无时间范围查日志，现在必须强制时间范围。这种变更可以直接让旧调用失败，但错误必须可恢复：`missing_time_range`、`retryable=false`、`recoverable_by_model=true`，并在 message 中说明需要补传的字段。这样 Agent 可以改为追问或重新调用，而不是盲目重试。

## 总结

MCP 工具版本化的核心，是承认工具接口面向的是模型和编排系统，而不是单一、可同步升级的 SDK。输入 schema、输出结构、自然语言描述、错误码、权限语义和默认值都会影响 Agent 行为，都应该被纳入版本契约。

落地时不要迷信一个 `v2` 后缀。更稳的做法是用工具注册表管理 descriptor，用 resolver 固定会话版本，用输入输出 adapter 维护兼容，用契约测试和 Agent 评测捕捉漂移，用 telemetry 观察真实迁移进度。这样版本升级就不是一次冒险发布，而是一条可度量的工程流程。

最重要的原则是：兼容不是永远保留旧行为，而是让旧行为的存在、风险、迁移和消失都有记录。MCP Server 一旦进入生产，工具就是 Agent 的操作面。把版本化做好，团队才能持续扩展工具能力，同时不把每次字段调整都变成线上事故。
