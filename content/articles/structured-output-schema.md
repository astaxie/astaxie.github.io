---
slug: structured-output-schema
url: /notes/structured-output-schema/
title: 结构化输出 Schema 设计
summary: Schema 是 LLM 应用里的接口，不是最后才加的格式要求。
categoryKey: llm-apps
category: LLM Apps
categoryLabel: LLM 应用工程
source: NOTES/LLM
date: 2026-03-28
image: /assets/article-visuals/structured-output-schema.svg
tags:
  - Schema
  - LLM
---

![标题图](/assets/article-visuals/structured-output-schema.svg)

## 问题背景

很多 LLM 应用最初都会经历一个阶段：先让模型输出自然语言，再在后面加一句“请用 JSON 返回”。这在 demo 里经常够用，因为输入简单，输出字段少，开发者就在旁边看着。到了生产环境，问题会迅速变复杂。模型可能多输出一段解释，少输出一个必填字段，把布尔值写成中文，把枚举值换成近义词，把数组变成对象，把数字单位写进字符串。更麻烦的是，JSON 解析通过了，业务语义却错了。下游程序拿到一个“合法对象”，执行了错误动作。

结构化输出 Schema 不是格式要求，而是 LLM 应用里的接口。它连接的是两个非常不同的世界：一边是概率模型，根据上下文生成最可能的内容；另一边是确定性程序，需要明确字段、类型、边界、版本和错误处理。没有 schema，模型输出只能给人读；有了粗糙 schema，下游会被迫猜；有了工程化 schema，系统才有机会验证、评测、回放和安全执行。

“让模型输出 JSON”解决的是语法问题，“设计 schema”解决的是契约问题。契约要说明字段代表什么、谁消费它、允许哪些值、缺信息时怎么办、不确定性如何表达、证据放在哪里、哪些动作可以自动执行、版本如何演进。很多事故不是模型不会写 JSON，而是 schema 把业务概念设计错了。比如把 `action` 设计成任意字符串，模型可能输出“建议联系用户并升级给支付团队”；下游既不知道这是一个建议还是一个待执行动作，也不知道是否需要确认。再比如把 `confidence` 设计成 0 到 1 的数字，却没有定义校准方式，最后它只是模型自我感觉良好的一串小数。

结构化输出也不是越细越好。过粗的 schema 会让下游猜，过细的 schema 会让模型填不稳、版本难演进、评测成本上升。好的 schema 应该贴近业务决策边界：哪些字段决定程序分支，哪些字段只用于人类解释，哪些字段是证据，哪些字段是可选补充。它要让模型少做自由发挥，让程序少做自然语言解析，让人工审核能快速看懂。

一个实际场景是知识库问答的“答案生成加引用”。最初可以让模型直接回答用户问题。后来产品希望展示引用、判断是否缺少资料、遇到高风险问题时拒答、把后续操作建议结构化给前端。此时如果只让模型输出一段 Markdown，前端无法稳定渲染，审核系统无法判断证据是否充分，评测也只能人工看。改成结构化输出后，可以把 `answer`、`citations`、`answerable`、`missing_info`、`risk_level`、`suggested_next_steps` 分开处理。用户看到的是自然语言答案，但系统内部消费的是稳定字段。

Schema 设计要从应用第一天开始，而不是等模型输出不稳定后才补救。早期 schema 可以很小，但要表达正确边界。它会倒逼团队澄清业务含义：到底什么叫“可回答”，引用需要精确到文档还是段落，低置信度是追问还是拒答，建议动作能不能自动执行，前端渲染需要哪些字段，日志里要记录哪些证据。澄清这些问题，比在 prompt 里堆更多形容词更有价值。

## 核心概念

结构化输出 Schema 至少包含六层设计：语法形状、字段语义、业务约束、不确定性表达、证据结构和版本演进。语法形状解决能否解析；字段语义解决每个字段是什么意思；业务约束解决哪些组合合法；不确定性表达解决模型不知道时如何说不知道；证据结构解决结论从哪里来；版本演进解决下游如何跟着变化。

| 层次 | 要回答的问题 | 典型手段 | 如果忽略会怎样 |
| --- | --- | --- | --- |
| 语法形状 | 输出能否被程序解析 | JSON Schema、类型、必填、数组限制 | 解析失败、重试增多 |
| 字段语义 | 字段代表哪个业务概念 | 命名、描述、示例、单位 | 合法 JSON 语义错误 |
| 业务约束 | 字段之间是否一致 | 规则校验、互斥、依赖、状态机 | 下游执行矛盾动作 |
| 不确定性 | 缺信息或低把握时怎么办 | `status`、`missing_info`、`needs_review` | 模型编造或假装确定 |
| 证据结构 | 结论依据在哪里 | 引用、来源、片段、置信原因 | 无法审计和评测 |
| 版本演进 | 新旧消费者如何兼容 | `schema_version`、废弃期、迁移 | 发布互相阻塞 |

字段命名要表达业务角色，而不是表达模型写作习惯。`text`、`result`、`note`、`data` 这类泛名会让下游不知道怎么消费。更好的命名是 `user_visible_answer`、`internal_reasoning_summary`、`required_follow_up_questions`、`risk_level`、`citations`。字段越接近消费者视角，越容易做校验和评测。需要注意的是，不要把隐藏推理链当成必须输出的字段。生产系统通常需要的是可审计的理由和证据摘要，而不是模型完整思考过程。

枚举是 schema 设计里的关键工具。只要字段会驱动程序分支，就应该优先考虑枚举，而不是任意字符串。例如 `risk_level` 可以是 `low`、`medium`、`high`、`blocked`；`answer_status` 可以是 `answered`、`insufficient_context`、`unsafe_request`、`needs_clarification`。枚举让下游逻辑稳定，也让评测更明确。枚举的风险是过度膨胀，团队把每个细微差别都加成新值，最后模型难选、下游难维护。好的枚举值应该对应不同处理路径，而不是对应文字风格。

可选字段必须有语义。很多 schema 把大部分字段都设成 optional，理由是“模型可能没有”。这会让消费者陷入困境：字段缺失是模型忘了填、信息不存在、业务不适用，还是 schema 版本不同？更好的做法是显式表达状态。例如 `answer_status=insufficient_context` 时，`missing_info` 必填；`needs_review=true` 时，`review_reason` 必填；`suggested_actions` 可以为空数组，但不能缺失。空值、缺失和不适用是三种不同语义，不要混在一起。

不确定性也要结构化。让模型输出一个 `confidence: 0.73` 通常意义有限，因为不同模型、不同任务、不同 prompt 下这个数字很难校准。更实用的是让模型说明不确定性的类型：缺少证据、证据冲突、问题超出范围、需要实时数据、需要人工权限。这样的字段可以直接驱动后续流程：缺少证据就检索更多，证据冲突就展示给人，超出范围就拒答，需要实时数据就调用工具。

证据结构决定系统能不能被复盘。对于问答、分类、抽取、审核类应用，输出里应该包含可追踪证据，而不是只有结论。证据可以是文档 ID、段落 ID、原文短引、字段来源、工具结果引用。引用不应该太长，也不应该被模型自由编造。工程上最好由上下文装配层给每个证据片段分配稳定 ID，模型只引用 ID 和必要短句，下游再回源展示。

版本演进是生产 schema 必须面对的问题。只要下游超过一个消费者，schema 改动就会有兼容性成本。新增可选字段通常安全，删除字段、改枚举含义、改变必填关系都可能破坏旧消费者。建议在输出里包含 `schema_version`，并为旧版本保留迁移层。不要让 prompt、schema 和前端同时无记录地变化，否则线上问题很难定位。

## 架构/流程图解说明

结构化输出在系统里应该处于一个明确的契约边界。模型不是直接把文本交给业务代码，而是先经过解析、校验、修复、业务规则检查，再决定是否进入后续动作。

```text
任务契约
  |
  v
Schema 设计：字段、枚举、状态、证据、版本
  |
  v
Prompt 绑定：告诉模型按 schema 输出，并解释字段语义
  |
  v
模型生成
  |
  v
语法解析：JSON 是否完整，类型是否匹配
  |
  v
Schema 校验：必填、枚举、长度、数组上限、格式
  |
  v
业务校验：状态组合、权限、证据、动作风险
  |
  v
修复或重试：只修可修错误，限制次数，记录原因
  |
  v
消费者：前端渲染、工具执行、审核队列、数据分析
```

这条链路里，Schema 校验和业务校验要分开。JSON Schema 适合检查类型、必填、枚举、长度、格式和简单结构；业务校验适合检查“高风险动作必须人工确认”“不可回答时不能给出确定答案”“引用 ID 必须来自本轮上下文”“创建工单前必须有客户 ID”。如果把所有规则都写进 prompt，系统无法稳定阻止错误；如果把所有规则都塞进 JSON Schema，schema 会变得难读且难维护。两层校验各做擅长的事。

还要注意修复链路。模型输出不合法时，可以让模型基于错误信息修复一次，但不能无限修复。修复适合处理语法错误、字段缺失、枚举拼写；不适合处理业务事实错误。如果模型说影响范围是全国，但证据里只提到华东，重试不一定能解决，应该进入业务规则失败或人工审核。修复链路必须记录原始输出、错误列表和修复次数，不能悄悄吞掉问题。

前端渲染和工具执行也应该消费不同字段。前端需要 `user_visible_answer`、`citations`、`warnings`；工具执行需要 `action_type`、`parameters`、`needs_confirmation`、`idempotency_key`；评测需要 `status`、`evidence`、`failure_reason`。如果一个字段同时服务所有用途，就会越来越含糊。Schema 设计时要明确消费者，不然字段会被不同团队解释成不同含义。

一个比较稳的架构是让模型只输出“计划和证据”，由确定性代码决定“是否执行”。例如模型可以输出 `suggested_actions`，每个动作包含类型、参数和理由；`BusinessGuard` 再根据权限、风险、状态和用户确认决定哪些动作进入工具层。这样做牺牲了一点自由度，但换来了审计、回滚和安全边界。LLM 应用进入生产后，宁可多一道确定性关口，也不要让模型直接决定所有副作用。

## 工程实现

下面设计一个知识库问答的结构化输出。目标是回答用户问题，给出引用，并在资料不足或风险过高时返回明确状态。这个例子不追求覆盖所有业务，而是展示 schema 如何表达状态、证据和下游动作。

先定义 JSON Schema 的核心部分：

```json
{
  "$id": "kb_answer_result.v1",
  "type": "object",
  "additionalProperties": false,
  "required": [
    "schema_version",
    "answer_status",
    "user_visible_answer",
    "citations",
    "missing_info",
    "risk_level",
    "needs_review",
    "suggested_next_steps"
  ],
  "properties": {
    "schema_version": {
      "type": "string",
      "const": "kb_answer_result.v1"
    },
    "answer_status": {
      "type": "string",
      "enum": [
        "answered",
        "insufficient_context",
        "needs_clarification",
        "unsafe_request"
      ]
    },
    "user_visible_answer": {
      "type": "string",
      "minLength": 0,
      "maxLength": 1200
    },
    "citations": {
      "type": "array",
      "maxItems": 6,
      "items": {
        "type": "object",
        "additionalProperties": false,
        "required": ["source_id", "quote", "supports"],
        "properties": {
          "source_id": {"type": "string", "pattern": "^ctx_[0-9]+$"},
          "quote": {"type": "string", "maxLength": 160},
          "supports": {"type": "string", "maxLength": 240}
        }
      }
    },
    "missing_info": {
      "type": "array",
      "maxItems": 5,
      "items": {"type": "string", "maxLength": 160}
    },
    "risk_level": {
      "type": "string",
      "enum": ["low", "medium", "high"]
    },
    "needs_review": {
      "type": "boolean"
    },
    "suggested_next_steps": {
      "type": "array",
      "maxItems": 4,
      "items": {
        "type": "object",
        "additionalProperties": false,
        "required": ["type", "label", "requires_confirmation"],
        "properties": {
          "type": {
            "type": "string",
            "enum": ["ask_user", "search_more", "create_ticket", "none"]
          },
          "label": {"type": "string", "maxLength": 120},
          "requires_confirmation": {"type": "boolean"}
        }
      }
    }
  }
}
```

这个 schema 有几个有意设计。第一，`additionalProperties=false`，防止模型随手加字段，让消费者以为有新语义。第二，所有数组有上限，避免输出膨胀。第三，`source_id` 使用上下文片段 ID，而不是让模型编文档路径。第四，`answer_status` 表达回答状态，不让模型在资料不足时硬答。第五，`suggested_next_steps` 只是建议动作，是否执行还要经过业务层。

Go 侧可以定义对应结构，并在解析后做业务校验：

```go
type KBAnswerResult struct {
    SchemaVersion      string          `json:"schema_version"`
    AnswerStatus       string          `json:"answer_status"`
    UserVisibleAnswer  string          `json:"user_visible_answer"`
    Citations          []Citation      `json:"citations"`
    MissingInfo        []string        `json:"missing_info"`
    RiskLevel          string          `json:"risk_level"`
    NeedsReview        bool            `json:"needs_review"`
    SuggestedNextSteps []SuggestedStep `json:"suggested_next_steps"`
}

type Citation struct {
    SourceID string `json:"source_id"`
    Quote    string `json:"quote"`
    Supports string `json:"supports"`
}

type SuggestedStep struct {
    Type                 string `json:"type"`
    Label                string `json:"label"`
    RequiresConfirmation bool   `json:"requires_confirmation"`
}

func ValidateBusinessRules(out KBAnswerResult, ctx ContextIndex) []error {
    var errs []error
    if out.AnswerStatus == "answered" && len(out.Citations) == 0 {
        errs = append(errs, errors.New("answered result requires at least one citation"))
    }
    if out.AnswerStatus != "answered" && out.UserVisibleAnswer != "" && len(out.Citations) == 0 {
        errs = append(errs, errors.New("non-answered response with content must explain limitation"))
    }
    for _, c := range out.Citations {
        if !ctx.Contains(c.SourceID) {
            errs = append(errs, fmt.Errorf("unknown citation source: %s", c.SourceID))
        }
    }
    for _, step := range out.SuggestedNextSteps {
        if step.Type == "create_ticket" && !step.RequiresConfirmation {
            errs = append(errs, errors.New("create_ticket requires confirmation"))
        }
    }
    if out.RiskLevel == "high" && !out.NeedsReview {
        errs = append(errs, errors.New("high risk answer requires review"))
    }
    return errs
}
```

业务校验里有些规则 JSON Schema 能勉强表达，但放在代码里更清楚，也更容易测试。比如引用 ID 是否来自本轮上下文，schema 只能检查格式，不能知道 `ctx_12` 是否真实存在。高风险是否需要审核，也可能依赖租户、用户角色、知识库范围和问题类型，适合放在业务层。

Prompt 绑定 schema 时，不要只贴一大段 JSON。要解释字段语义，尤其是不确定状态：

```text
如果上下文能回答用户问题，answer_status 设为 answered，并提供至少一条 citation。
如果上下文缺少关键事实，不要猜测；answer_status 设为 insufficient_context，并在 missing_info 写明缺少什么。
如果问题本身需要用户选择、补充时间范围或明确对象，answer_status 设为 needs_clarification。
如果用户要求绕过安全、泄露敏感信息或执行未授权动作，answer_status 设为 unsafe_request。
citations 只能引用提供的 ctx_x 编号，不能编造来源。
suggested_next_steps 是建议，不代表已经执行。
```

这段说明的价值在于把 schema 中看不出的业务语义告诉模型。Schema 控制形状，prompt 解释含义，业务代码做最终保护。三者不能互相替代。

还要设计错误处理。一个稳妥的策略如下：

1. 模型输出无法解析 JSON：用原始输出和解析错误重试一次。
2. JSON 可解析但 schema 校验失败：把字段错误发给模型修复一次。
3. 业务校验失败：不自动修复高风险错误，进入降级或人工审核。
4. 修复仍失败：返回稳定兜底结构，记录 `schema_validation_failed`。
5. 所有失败都写入 trace，并保留原始输出供评测样本回流。

兜底结构也要符合 schema。例如：

```json
{
  "schema_version": "kb_answer_result.v1",
  "answer_status": "insufficient_context",
  "user_visible_answer": "",
  "citations": [],
  "missing_info": ["系统未能生成可验证的结构化结果"],
  "risk_level": "medium",
  "needs_review": true,
  "suggested_next_steps": [
    {
      "type": "ask_user",
      "label": "请补充问题背景或稍后重试",
      "requires_confirmation": false
    }
  ]
}
```

不要在解析失败时直接返回模型原文给下游，也不要让前端自己猜。兜底结构让消费者始终面对同一种接口，错误被显式表达，而不是藏在异常路径里。

在多人协作的项目里，还要把 schema 当成代码审查对象。一次 schema 变更的 pull request 不应该只展示字段 diff，还要说明消费者影响、样本迁移、评测变化和回滚方式。比如新增 `risk_level=high` 的处理规则，就要同时补充高风险样本、前端展示状态、审核队列入口和工具网关限制。否则 schema 看起来只是多了一个枚举值，实际上已经改变了业务流向。我的经验是，为每个生产 schema 配一份简短变更记录，记录为什么加字段、谁消费、旧数据如何解释，会比事后翻 prompt 和聊天记录可靠得多。

## 测试评测

结构化输出的评测要分成“形状正确”和“语义正确”。形状正确可以高度自动化，语义正确则需要业务标注、规则和抽样人工审核。只看 JSON 通过率会造成错觉，因为一个完全合法的对象也可能给出错误分类、伪造引用或错误动作。

| 评测项 | 样本构造 | 通过标准 |
| --- | --- | --- |
| 解析稳定性 | 正常输入、长输入、混合语言、符号干扰 | 输出始终是可解析 JSON |
| Schema 合规 | 缺字段、错类型、额外字段、枚举近义词 | 校验器能拒绝非法结构 |
| 状态语义 | 可回答、缺资料、需追问、危险请求 | `answer_status` 与业务期望一致 |
| 引用真实性 | 上下文提供有限 `ctx_id` | citations 只能引用真实片段 |
| 业务保护 | 高风险、创建工单、外部动作 | 需要审核和确认的字段不能漏 |
| 兼容性 | 新旧 schema 同时存在 | 旧消费者不被破坏 |
| 修复链路 | 故意制造坏 JSON 和字段错误 | 修复次数有限，错误可观测 |

单元测试要覆盖 schema 本身。很多团队只测模型输出，不测 schema 定义，结果 schema 有漏洞也不知道。可以准备一组合法对象和非法对象，验证校验器行为。例如额外字段必须被拒绝，`source_id` 格式错误必须被拒绝，`suggested_next_steps` 超过上限必须被拒绝，`risk_level=critical` 这种未定义枚举必须被拒绝。Schema 文件变更时，这些测试应该快速运行。

语义评测要保存输入、上下文片段、期望输出和判断理由。对于知识库问答，可以把样本分成几类：有直接答案、需要综合两段资料、资料不足、资料冲突、请求超出知识库范围、包含提示注入、要求敏感信息。每类样本都应该检查不同字段。直接答案看 `answer_status` 和引用；资料不足看 `missing_info`；提示注入看 `unsafe_request` 或拒绝策略；资料冲突看是否进入审核或说明冲突。

引用评测尤其重要。模型很容易生成看起来合理的引用短句，但并不来自上下文。工程上可以检查 `source_id` 是否存在，也可以检查 `quote` 是否是对应片段的子串或近似子串。对于中文文本，近似匹配要谨慎，不能因为模型改写了句子就当成真实引用。更稳的做法是让模型引用片段 ID 和少量原文短引，由系统回源展示完整引用。

还要测试修复链路。修复不能成为无限重试，也不能把业务错误伪装成成功。可以构造模型输出少字段、错枚举、数组超长、引用未知 ID、创建工单但没有确认等案例，观察系统分别走 schema 修复、业务拒绝、人工审核还是兜底。每条路径都应该有 trace，方便线上统计。

兼容性评测也不能省。Schema v2 增加字段时，旧前端是否还能渲染？枚举增加新值时，旧消费者是否会崩？字段从 optional 变 required 时，历史样本能否迁移？这些问题和模型无关，但会决定生产稳定性。建议对每次 schema 变更生成兼容性报告，至少列出新增字段、删除字段、枚举变化、必填变化和迁移策略。

最后，评测要看成本。更复杂的 schema 会增加 prompt 长度和输出长度，也可能增加模型修复次数。某些场景下，把一个巨大 schema 拆成两个阶段更稳：第一阶段判断状态和路由，第二阶段只在需要时生成详细结构。Schema 设计不是为了展示严密，而是为了让系统以可接受成本稳定运行。

## 失败模式

第一种失败模式是把 schema 当作展示格式。字段按页面排版设计，而不是按业务决策设计。比如 `title`、`subtitle`、`body`、`footer` 对前端很方便，但后端不知道回答是否有证据、是否需要审核、是否可以执行下一步。展示字段可以存在，但核心决策字段必须独立。

第二种失败模式是任意字符串太多。`category` 是字符串，`action` 是字符串，`status` 也是字符串。模型输出“需要进一步确认”“needs_more_info”“不确定”都可能出现，下游只能写一堆脆弱映射。凡是驱动程序分支的字段，都应该优先用枚举，并在 prompt 里解释每个枚举的使用条件。

第三种失败模式是可选字段语义不清。消费者看到字段缺失，不知道该当作空、未生成、不适用还是旧版本。解决办法是减少无意义 optional，使用显式状态和空数组。比如没有引用就返回 `citations: []`，资料不足就设置 `answer_status=insufficient_context` 并填写 `missing_info`，而不是让字段随机消失。

第四种失败模式是证据由模型自由编造。Schema 有 `source` 字段，但允许任意字符串，模型就可能写出不存在的文档名。生产系统应该给上下文片段稳定 ID，并要求模型只能引用这些 ID。业务层还要验证 ID 是否存在，必要时检查短引是否来自原文。引用不是装饰，它是审计和评测的入口。

第五种失败模式是把业务规则全写进 schema。JSON Schema 很强，但不是业务规则引擎。复杂权限、租户配置、实时状态、跨字段条件和工具风险更适合放在业务代码里。Schema 太复杂会让 prompt 难读、模型难填、错误难解释。正确分层是：schema 管形状，业务校验管语义，工具网关管副作用。

第六种失败模式是修复循环过度乐观。模型输出非法，系统让模型修；修完又出现另一个错误，再修。最后延迟和成本飙升，用户只看到慢，工程师只看到偶发失败。修复应该有次数限制和错误分类。语法错误可以修，危险动作不能靠修复蒙混过关。

第七种失败模式是 schema 没有版本。前端、后端、评测和 prompt 同时隐式依赖某个字段含义，一改就连锁出问题。每个生产 schema 都应该有版本，变更要说明兼容性。枚举值含义变化比新增字段更危险，因为旧消费者可能继续运行但做错事。

第八种失败模式是过度嵌套。为了表达完整业务对象，schema 套了五六层，字段之间互相依赖。模型填起来不稳，人类评测也难读。可以把输出拆成阶段：先输出状态和路由，再按路由输出对应子结构。结构化输出不是数据库建模，重点是让本轮决策可验证。

第九种失败模式是把置信度当真。模型给出 `confidence=0.92`，团队就认为可靠。没有校准和验证的置信度只是文本。与其依赖一个数字，不如让模型输出不确定原因，并用规则检查证据数量、证据冲突和风险等级。需要数字时，也要通过离线评测做校准。

## 上线 checklist

上线结构化输出前，可以按下面清单逐项确认：

- Schema 有明确版本，版本号进入模型输出和 trace。
- 所有驱动程序分支的字段都有枚举或严格类型，不依赖任意字符串。
- `additionalProperties` 策略明确，默认拒绝未知字段。
- 必填字段、可选字段、空数组、空字符串和不适用状态有清楚语义。
- 数组有 `maxItems`，字符串有合理长度限制，避免输出膨胀。
- 状态字段能表达可回答、资料不足、需追问、拒绝或需审核等路径。
- 证据字段引用稳定上下文 ID，业务层验证 ID 真实存在。
- 高风险动作只作为建议输出，执行前经过业务规则和用户确认。
- JSON Schema 校验和业务校验分层实现，错误分类可观测。
- 修复重试次数有限，原始输出、错误列表和修复结果写入 trace。
- 有合法对象和非法对象的 schema 单元测试。
- 有语义评测样本，覆盖正常、缺资料、冲突、危险请求和提示注入。
- 前端、工具层、审核队列和数据分析各自消费哪些字段已经写清楚。
- Schema 变更有兼容性报告，列出新增、删除、枚举、必填关系变化。
- 兜底输出本身符合 schema，消费者不用处理另一套异常结构。

这份 checklist 的重点是让 schema 成为团队共同维护的接口，而不是某个 prompt 里的附属文本。只要下游程序依赖模型输出，就应该用接口的标准来审视它：能不能校验，能不能迁移，能不能测试，能不能定位错误。

## 总结

结构化输出 Schema 是 LLM 应用从“会回答”走向“可集成”的关键接口。它不只是让模型返回 JSON，而是把业务状态、证据、不确定性、动作建议和版本边界显式表达出来。好的 schema 会让模型少猜，让下游少解析，让评测更清楚，让线上事故更容易复盘。

设计 schema 时，要先问消费者是谁、哪些字段决定程序分支、缺信息时走哪条路径、证据如何验证、动作如何保护、版本如何演进。Schema 管形状，prompt 解释语义，业务代码守住规则，工具网关控制副作用。把这几层分清楚，LLM 应用才不会在一个看似合法的 JSON 对象里悄悄失控。

后续维护里，最重要的是保持 schema 和真实业务同步。业务规则变化时先改契约和评测，再改 prompt；线上失败出现时先补样本和校验，再讨论是否扩字段。这样 schema 才会沉淀成稳定接口，而不是随着模型输出习惯不断摇摆。
