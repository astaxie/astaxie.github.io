---
slug: deepchat-plugin-architecture
url: /notes/deepchat-plugin-architecture/
title: DeepChat 插件架构思路
summary: 桌面 AI 助手需要把模型、知识、工具和 UI 能力解耦。
categoryKey: llm-apps
category: LLM Apps
categoryLabel: LLM 应用工程
source: NOTES/LLM
date: 2026-03-21
image: /assets/article-visuals/deepchat-plugin-architecture.svg
tags:
  - DeepChat
  - Plugin
---

![标题图](/assets/article-visuals/deepchat-plugin-architecture.svg)

## 问题背景

桌面 AI 助手和网页聊天机器人不一样。网页聊天通常围绕一个服务端模型和一套知识库展开；桌面助手离用户的本地文件、浏览器、剪贴板、编辑器、数据库客户端、终端和私有模型更近。用户希望它能读本地资料、整理文件、调用内部系统、接入不同模型、打开专用 UI，还希望这些能力可以按团队或个人扩展。如果所有能力都写进主程序，应用会很快变成一个难以维护的巨型客户端。

DeepChat 这类桌面 AI 应用更适合走插件架构。插件不是简单的菜单扩展，也不是把几个 API key 塞到配置里。它要把模型提供方、知识连接器、工具执行器、提示词模板、会话面板、工作流、权限声明和观测事件都纳入同一个扩展体系。主程序负责稳定的宿主能力：会话、权限、渲染、模型路由、沙箱、安装和升级；插件负责把特定领域能力接进来，例如企业文档检索、代码仓库问答、设计稿分析、数据库只读查询、客服工单创建、本地图片处理等。

没有插件架构时，桌面助手常见的失败路径很直接。第一，模型适配层不断膨胀，每接一个模型服务都要改主程序发布。第二，工具能力没有统一权限声明，用户不知道某个能力会读哪些文件、发哪些请求。第三，知识连接器和 UI 绑定太死，某个团队想接 Confluence、另一个团队想接本地 Obsidian，最后都需要 fork。第四，社区扩展无法安全运行，要么完全不给能力，要么给过大的本地权限。第五，调试困难，插件失败后主程序只看到一段错误字符串，不知道是认证、网络、schema、沙箱还是模型调用出了问题。

一个好的插件架构要回答几个工程问题：插件如何声明能力，主程序如何发现和加载，插件能访问哪些资源，插件如何与模型上下文交互，UI 扩展如何避免污染主界面，长任务如何取消和恢复，插件版本如何兼容，出现恶意或失控插件时如何限制损害。把这些问题推给“约定”或 README，早期能跑，生态一旦扩大就会出事故。

我更倾向把 DeepChat 插件看成桌面应用里的受控能力包。它可以贡献模型、工具、资源、命令、面板和工作流，但所有贡献都要通过 manifest 声明，通过宿主的权限和生命周期管理进入系统。主程序不是插件的库，而是插件的操作系统。插件不能随意拿到全局对象，不能私自绕过权限调用文件系统，也不能把工具结果直接塞进会话历史。它必须走宿主提供的 API，让宿主能记录、撤销、观测和升级。

## 核心概念

插件架构的第一个概念是能力声明。插件要先说清楚自己提供什么，而不是安装后由主程序动态猜。能力可以分成几类：模型提供方、嵌入模型、知识源、工具、命令、UI 面板、会话增强器、导入导出器、评测器。每类能力都有不同契约。模型提供方关注流式输出、token 统计和错误映射；知识源关注索引、权限和引用；工具关注输入 schema、副作用和确认；UI 面板关注渲染边界和事件通信。

第二个概念是权限最小化。桌面插件最危险的地方是离本地资源太近。一个“读取 Markdown 笔记”的插件不应该默认获得整个家目录读权限；一个“创建工单”的插件不应该直接拥有发送邮件权限；一个“数据库问答”插件默认应该只读，并且查询超时、结果行数和脱敏规则要由宿主控制。权限需要在 manifest 里声明，在安装时展示，在运行时校验，在日志里记录。

第三个概念是生命周期。插件不是加载一次就永远运行。它有安装、启用、禁用、升级、迁移、启动、停止、任务执行、崩溃恢复和卸载。每个阶段都可能失败。比如升级时 manifest schema 变了，插件需要迁移本地索引；禁用时要停止后台任务；卸载时要处理用户数据保留策略。没有生命周期协议，插件生态会不断留下后台进程、坏索引和过期配置。

第四个概念是宿主 API 边界。插件应该通过明确 API 和主程序交互：读取授权文件、发起模型请求、注册工具、写入插件私有存储、发送 UI 事件、记录 trace。宿主 API 要尽量窄，返回结构化错误。不要把 Electron、Node、数据库连接或内部状态对象直接暴露给插件。暴露内部对象会让插件和主程序实现细节耦合，后续升级很痛苦。

第五个概念是可组合上下文。插件提供的能力最终往往要进入一次模型调用：知识源返回文档片段，工具返回外部状态，提示词插件提供角色说明，UI 插件提供用户选择。主程序要有统一的上下文装配层，决定哪些插件输出能进入上下文、如何引用、如何裁剪、如何标记来源。插件不能直接修改最终 prompt，否则不同插件之间会互相覆盖，安全策略也难以执行。

第六个概念是插件间隔离。插件可以协作，但不应该默认互相信任。一个知识插件返回的文本可能包含提示注入，不能让它影响另一个工具插件的权限。一个 UI 插件不能读取另一个插件的私有配置。插件之间的通信应该经过宿主事件总线或资源引用，带上权限和来源，而不是共享全局变量。

## 架构/流程图解说明

一个桌面 AI 助手的插件体系可以拆成宿主层、运行时层和插件能力层：

```text
DeepChat Host
  |-- Conversation Engine
  |-- Model Router
  |-- Context Assembler
  |-- Permission Manager
  |-- Plugin Registry
  |-- UI Shell
  |-- Observability
  |
  v
Plugin Runtime
  |-- Manifest Loader
  |-- Sandbox / Worker
  |-- Capability Broker
  |-- Event Bus
  |-- Storage Adapter
  |-- Version Migrator
  |
  v
Plugins
  |-- model providers
  |-- knowledge connectors
  |-- tools and workflows
  |-- prompt packs
  |-- UI panels
  |-- import/export adapters
```

主程序启动时不应该直接执行所有插件代码。更稳的流程是先扫描 manifest，建立能力目录，再按需加载插件运行时。比如用户打开某个会话时，宿主根据会话配置启用相关知识源；用户选择某个模型时，才启动对应模型 provider；模型计划调用某个工具时，宿主先检查权限，再把调用转发给插件。这样可以降低启动成本，也减少不必要权限暴露。

能力注册流程可以画成这样：

```text
scan plugin directory
  -> read manifest
  -> validate manifest schema
  -> check host compatibility
  -> show permission changes
  -> create registry entries
  -> lazy start plugin runtime
  -> plugin registers capabilities
  -> host verifies declared capability
  -> capability becomes available
```

运行一次工具调用时，流程更严格：

```text
model proposes tool_call
  -> host resolves tool id in registry
  -> validate input against tool schema
  -> check conversation policy and plugin permission
  -> if high risk, request user confirmation
  -> invoke plugin in sandbox with timeout
  -> normalize result and errors
  -> write trace event
  -> pass summarized result to context assembler
```

这条链路的要点是模型从不直接调用插件。模型只能提出结构化工具意图，宿主负责解释、校验和执行。插件也不直接把结果写回模型上下文，而是返回结构化结果，由宿主统一裁剪、引用和脱敏。这样才能保证不同插件的行为在同一套权限和观测体系下运行。

UI 插件也要走类似边界。它可以贡献一个侧边栏、设置页、文件预览或操作按钮，但它的事件要通过宿主定义的 channel。比如一个知识库插件展示检索结果，用户点击“加入上下文”，UI 插件发出 `resource.select` 事件，宿主检查该资源是否允许进入当前会话，再由上下文装配层生成引用。不要让 UI 插件直接操作会话消息数组。

## 工程实现

插件的核心入口是 manifest。它既是安装时展示给用户的说明，也是宿主运行时的契约。一个简化示例如下：

```json
{
  "id": "com.example.crm",
  "name": "CRM 助手",
  "version": "1.4.0",
  "host": {
    "minVersion": "0.9.0",
    "apiVersion": "2026-03"
  },
  "entry": "dist/index.js",
  "capabilities": {
    "tools": [
      {
        "id": "crm.search_customer",
        "title": "查询客户",
        "inputSchema": "schemas/search_customer.json",
        "sideEffect": "read",
        "timeoutMs": 5000
      },
      {
        "id": "crm.create_followup",
        "title": "创建跟进任务",
        "inputSchema": "schemas/create_followup.json",
        "sideEffect": "write-remote",
        "requiresConfirmation": true
      }
    ],
    "knowledgeSources": [
      {
        "id": "crm.customer_notes",
        "title": "客户备注",
        "supportsIncrementalIndex": true
      }
    ],
    "panels": [
      {
        "id": "crm.customer_panel",
        "placement": "side"
      }
    ]
  },
  "permissions": {
    "network": ["https://crm.internal.example.com"],
    "storage": ["plugin-private"],
    "secrets": ["crm_api_token"]
  }
}
```

这个 manifest 有几个关键点。`host.apiVersion` 用来做宿主 API 兼容；`sideEffect` 决定工具风险等级；`requiresConfirmation` 让宿主在模型调用工具前插入确认；`permissions.network` 限制插件请求域名；`secrets` 表示插件只能通过宿主 secret broker 读取指定凭据，不能自己扫描环境变量。插件实际代码注册能力时，宿主还要校验注册内容是否超出 manifest 声明。

宿主侧可以用一组接口抽象插件贡献：

```ts
type CapabilityKind = "model" | "tool" | "knowledge" | "panel" | "prompt";

interface PluginRuntime {
  start(ctx: PluginContext): Promise<void>;
  stop(reason: string): Promise<void>;
  invoke(req: PluginInvocation): Promise<PluginResult>;
}

interface ToolCapability {
  id: string;
  pluginId: string;
  inputSchema: JsonSchema;
  sideEffect: "read" | "write-local" | "write-remote" | "irreversible";
  requiresConfirmation: boolean;
  timeoutMs: number;
}

interface PluginContext {
  pluginId: string;
  apiVersion: string;
  storage: PluginStorage;
  secrets: SecretBroker;
  events: PluginEventBus;
  host: HostBridge;
}
```

这里要特别注意 `HostBridge` 的大小。它应该提供高层能力，而不是底层对象。比如提供 `readAuthorizedFile(ref)`，不要提供 Node 的 `fs`；提供 `requestModel(req)`，不要暴露内部模型客户端；提供 `emitTrace(event)`，不要让插件写宿主日志文件。桥越窄，宿主升级越容易，安全审计也越清楚。

插件运行时可以有几种实现。最轻的是同进程模块加载，开发快但隔离差。更稳的是 worker 或独立进程，通过 RPC 通信。对桌面应用来说，可以按风险分层：纯 prompt 包和 UI 配置可以同进程加载；会访问网络或本地文件的插件放到 worker；高风险工具放到独立进程并限制环境变量、文件系统和网络。不要为了架构纯洁让所有插件都付出最高成本，但也不要让任意插件共享主进程权限。

能力目录是插件系统的核心数据结构：

| 字段 | 说明 |
| --- | --- |
| `capability_id` | 全局唯一，例如 `crm.search_customer` |
| `plugin_id` | 来源插件 |
| `kind` | tool、model、knowledge、panel |
| `declared_version` | manifest 中的能力版本 |
| `risk_level` | read、write、remote、irreversible |
| `permission_refs` | 运行需要的权限 |
| `schema_hash` | 输入输出 schema 的 hash |
| `enabled_scope` | 全局、工作区、会话或用户 |
| `health` | healthy、disabled、crashed、migrating |

模型路由也可以插件化，但要避免把模型 provider 和业务工具混在一起。模型 provider 插件需要实现流式输出、取消、token 计费、错误归一化和能力描述。例如某个模型支持图片输入，另一个模型支持长上下文，主程序应该通过 provider 的能力描述选择，而不是靠硬编码名字判断。知识插件则要实现资源枚举、增量索引、检索、引用生成和权限过滤。工具插件实现 schema 驱动调用和结果归一化。每类插件的接口不同，统一在能力目录里管理即可。

上下文装配层要给插件输出定义统一格式：

```ts
interface ContextItem {
  id: string;
  sourcePluginId: string;
  sourceCapabilityId: string;
  kind: "document" | "tool_result" | "user_selection" | "system_fact";
  trustLevel: "user" | "system" | "plugin" | "untrusted_text";
  title: string;
  content: string;
  citations?: Citation[];
  expiresAt?: string;
}
```

`trustLevel` 很重要。知识插件返回的文档内容要按不可信文本处理，不能覆盖系统指令；工具返回的结构化系统事实可以给更高可信等级，但仍要绑定工具调用和时间。上下文装配层根据 trust level 选择模板，把外部文本包在清楚的边界里，减少提示注入风险。

再补一个插件调用的完整例子。用户在会话里问：“查一下 ACME 的续费记录，如果下周到期就给客户成功团队建一个跟进任务。”模型不应该直接访问 CRM，也不应该自己决定创建任务。它只能产生一个候选计划：先调用 `crm.search_customer`，再根据返回的到期时间决定是否调用 `crm.create_followup`。宿主解析计划后，发现第一个工具是只读，权限已授予，于是把调用转发给 CRM 插件。插件返回结构化结果：客户 ID、续费日期、客户成功负责人、引用链接和数据更新时间。宿主把结果写入 trace，并以 `tool_result` 形式进入上下文。

第二步模型提出创建跟进任务。宿主发现 `crm.create_followup` 是 `write-remote`，manifest 要求确认，于是生成确认卡片。卡片内容不是模型随口总结，而是由工具参数和插件 schema 渲染：客户名、负责人、任务标题、截止日期、写入系统、引用来源。用户确认后，宿主计算参数 hash，并把确认记录与本次 action 绑定。插件执行成功后返回远端任务 ID，宿主再把结果写入会话。这个流程里插件、模型和 UI 都参与了，但只有宿主拥有最终执行权。

```text
用户意图
  -> 模型提出 read 工具调用
  -> 宿主校验并调用 crm.search_customer
  -> 插件返回结构化客户事实
  -> 模型提出 write 工具调用
  -> 宿主生成确认卡片
  -> 用户确认 action fingerprint
  -> 宿主调用 crm.create_followup
  -> 插件返回 remote_task_id
  -> 宿主写 trace 和会话摘要
```

这个例子看起来步骤多，但每一步都有明确价值。读操作和写操作风险不同，不能走同一条快捷路径。确认卡片由宿主生成，避免插件把风险藏在自定义 UI 里。远端任务 ID 由插件返回，但进入会话前由宿主归一化，避免不同插件各自发明结果格式。未来如果要做企业审计，只要读取 trace 就能知道哪个插件在什么时候用哪个权限写了哪个系统。

插件 SDK 也要围绕这些边界设计。SDK 的目标不是让插件绕过宿主少写代码，而是让插件作者自然地走正确路径。比如 `registerTool` 默认要求输入 schema；`invokeNetwork` 自动检查 manifest 域名；`getSecret` 只返回授权 secret；`emitResult` 自动附带 trace id；`createPanel` 默认运行在隔离 frame。SDK 里每个便捷函数都应该强化宿主边界，而不是暴露内部对象。

```ts
export default definePlugin({
  async activate(ctx) {
    ctx.tools.register({
      id: "crm.search_customer",
      schema: searchCustomerSchema,
      sideEffect: "read",
      async run(input, runCtx) {
        const token = await ctx.secrets.get("crm_api_token");
        const res = await ctx.network.fetch("/customers/search", {
          token,
          body: input,
          traceId: runCtx.traceId
        });
        return ctx.results.ok({
          kind: "customer_record",
          data: normalizeCustomer(res),
          citations: [{ title: "CRM", url: res.url }]
        });
      }
    });
  }
});
```

这段代码里没有直接文件访问、没有全局 fetch、没有主进程对象。插件作者仍然能完成业务，但每次访问 secret、网络和结果输出都经过宿主 API。这样的 SDK 会比纯约定更可靠。

配置和数据迁移也要纳入插件工程实现。桌面插件经常保存本地索引、用户授权、字段映射和 UI 设置。升级时如果只替换代码，不迁移数据，用户会遇到索引损坏、旧 secret 名称找不到、工具 schema 与历史会话不兼容等问题。宿主可以要求插件提供 `migrations` 列表，每个迁移从一个插件数据版本升级到下一个版本，并且只能访问插件私有存储。迁移运行前生成备份，运行后写入迁移事件；失败时禁用插件能力，但保留用户数据和恢复入口。对于知识源插件，迁移还要区分“必须重建索引”和“可以后台增量修复”，避免升级后长时间阻塞主程序。

```json
{
  "dataVersion": 3,
  "migrations": [
    {"from": 1, "to": 2, "kind": "settings"},
    {"from": 2, "to": 3, "kind": "index", "rebuild": "background"}
  ]
}
```

多工作区也是桌面助手必须面对的问题。个人知识库、公司项目和客户项目往往需要不同插件配置。一个插件在个人工作区可以读取本地笔记，在公司工作区可能只能访问批准目录；同一个 CRM 插件在不同租户使用不同 token。能力目录里的 `enabled_scope` 不应该只是全局开关，而要支持用户、工作区、会话三层覆盖。模型在某个会话里看到的工具列表，应该是当前作用域计算后的结果，而不是所有已安装插件的全集。

## 测试评测

插件系统的测试不只是“插件能不能跑”。它要覆盖契约、权限、隔离、兼容、性能和用户体验。最基础的是 manifest schema 测试。每个插件包在安装前必须通过 schema 校验，能力 ID 不能冲突，权限声明必须和能力风险匹配。比如一个声明只读工具的插件，如果请求写远端权限，安装器应该提示或拒绝。

第二层是能力契约测试。工具的输入 schema 要能拦住无效参数，输出要符合宿主规范，错误要归一化。模型 provider 要通过流式、取消、超时、token 统计和重试测试。知识源要通过增量索引、删除同步、引用回源和权限过滤测试。UI 面板要通过事件权限测试，确认它不能直接改会话状态。

第三层是沙箱测试。构造恶意或失控插件，尝试读取未授权路径、访问未声明域名、读取其他插件存储、发送未声明事件、长时间占用 CPU、返回超大结果。宿主要验证这些行为被阻止并产生可读错误。桌面应用尤其要测试离线场景、代理配置、证书错误和用户取消。

第四层是组合评测。插件单独正确，不代表组合正确。一个知识插件返回的文档里可能包含“忽略之前所有规则”的文本；另一个工具插件提供删除文件能力；模型在同一轮看到两者，宿主必须确保知识文本不能提升工具权限。组合评测要覆盖提示注入、工具选择错误、上下文污染和权限提升。

第五层是开发者体验测试。插件生态不是只给核心团队用，第三方作者能不能快速定位问题很重要。测试 harness 应该允许插件作者在不启动完整桌面应用的情况下运行 manifest 校验、工具契约测试、权限模拟和 trace 预览。一个常见做法是提供 `deepchat plugin test`：读取插件目录，启动最小宿主，注入模拟 secret 和网络响应，执行一组 fixture，然后输出能力注册、权限判断、调用耗时和错误分类。这样插件问题在发布前就能暴露。

第六层是用户体验回归。插件安装、禁用、升级、授权失败、secret 过期、网络离线、后台索引中断，都要有清楚 UI。桌面应用的用户不会接受一堆开发者异常栈。评测可以录制关键路径：安装 CRM 插件、授权 token、启用会话、调用只读工具、触发写操作确认、禁用插件、重新打开会话。每一步都检查 UI 是否显示能力来源、权限状态和可恢复操作。

可以用下面的矩阵管理测试：

| 测试类型 | 目标 | 自动化方式 |
| --- | --- | --- |
| manifest 校验 | 防止坏包进入系统 | JSON Schema、签名和兼容检查 |
| 契约测试 | 能力输入输出稳定 | 插件测试 harness |
| 权限测试 | 阻止越权访问 | 模拟未授权文件和网络 |
| 沙箱测试 | 限制崩溃和资源耗尽 | 独立进程、超时、内存限制 |
| 组合评测 | 多插件交互安全 | 注入样本和工具调用回放 |
| 升级测试 | 版本迁移可靠 | 安装旧版、写数据、升级新版 |
| 观测测试 | 失败可定位 | trace 字段完整性断言 |

评测还要关注延迟。插件系统容易把一次用户请求拆成很多小调用：知识检索、权限检查、模型路由、工具执行、UI 更新。如果每一层都没有预算，桌面体验会变慢。宿主应该给插件调用设置超时、并发限制和结果大小限制，并在 trace 里记录每个插件耗时。慢插件不能拖垮整个会话。

还有一项容易忽略的评测是降级能力。插件不可用时，主程序不应该整体不可用。模型 provider 插件崩溃时，路由器应能切换到其他模型或提示用户；知识插件索引损坏时，会话仍应能普通聊天；工具插件授权失效时，只禁用相关工具并保留只读说明。降级评测可以故意让插件返回 `auth_required`、`plugin_crashed`、`schema_mismatch`、`timeout`，观察宿主是否给出可操作恢复路径，而不是让模型编造结果。

## 失败模式

第一类失败是插件越权。表现为插件读取未授权目录、访问未声明网络、拿到其他插件 secret，或者通过 UI 事件绕过宿主策略。根因通常是宿主 API 太宽，或者插件运行在主进程里拥有默认权限。解决办法是 manifest 权限、运行时沙箱、secret broker 和调用前策略检查一起做，不能只靠插件作者自觉。

第二类失败是能力污染。插件直接拼 prompt、直接改会话消息、直接写模型上下文，导致多个插件互相覆盖。比如一个 prompt 插件要求“用专家口吻”，另一个安全插件要求“高风险动作必须确认”，最后顺序不同结果不同。主程序必须统一上下文装配和策略层，插件只能贡献结构化片段。

第三类失败是版本耦合。插件依赖宿主内部对象，宿主升级后大量插件坏掉。解决办法是稳定 API 版本、能力契约和迁移机制。宿主内部怎么存会话不应该暴露给插件；插件只面对 `PluginContext` 和声明过的 API。

第四类失败是错误不可诊断。用户只看到“插件失败”，开发者不知道是认证失效、schema 错误、超时、网络不通、权限拒绝还是插件崩溃。插件调用结果要有统一错误模型，例如 `permission_denied`、`invalid_input`、`auth_required`、`timeout`、`rate_limited`、`plugin_crashed`。每次失败写入 trace，并能在 UI 上给出可操作信息。

第五类失败是后台任务失控。知识插件在后台索引大目录，CPU 和磁盘占用很高；用户禁用插件后索引还在跑；升级时旧 worker 没停。生命周期管理必须包含取消、心跳、资源预算和卸载清理。后台任务要向宿主报告进度和可取消点。

第六类失败是插件生态分裂。每个插件自己实现模型调用、存储、设置页和日志，用户体验不一致，安全边界也不一致。宿主要提供统一 SDK 和组件，但 SDK 不能成为绕过权限的后门。好的 SDK 应该让正确做法更容易，例如自动带 trace id、自动校验 schema、自动走 secret broker。

第七类失败是供应链风险。插件可能来自社区、企业内部或个人目录。安装包需要签名、来源展示、hash 校验和权限差异提示。自动更新要谨慎，尤其是权限增加时必须重新确认。企业环境还需要插件 allowlist 和版本锁定。

## 上线 checklist

- manifest schema 是否稳定，是否包含能力、版本、入口、权限、兼容范围和风险等级。
- 插件安装时是否展示新增权限，升级时是否展示权限 diff。
- 能力注册是否校验不得超出 manifest 声明。
- 模型是否只能提出工具意图，不能直接执行插件代码。
- 工具调用是否经过 schema 校验、权限检查、风险确认、超时和结果归一化。
- 知识插件返回的文本是否按不可信上下文处理，避免提示注入提升权限。
- UI 插件是否只能通过宿主事件通道交互，不能直接修改会话核心状态。
- secret 是否只能通过宿主 broker 获取，是否支持撤销和轮换。
- 插件私有存储是否隔离，卸载时是否有数据保留和清理策略。
- 插件运行时是否有崩溃隔离、心跳、取消、并发限制和资源预算。
- trace 是否记录插件 ID、能力 ID、schema hash、权限判断、耗时、错误类型和结果大小。
- 企业部署是否支持 allowlist、禁用社区插件、固定版本和审计导出。

## 总结

DeepChat 这类桌面 AI 助手要想长期扩展，插件架构不是锦上添花，而是把模型、知识、工具和 UI 解耦的基本结构。主程序要成为稳定宿主，提供会话、权限、上下文、运行时和观测；插件要成为受控能力包，通过 manifest 声明能力，通过宿主 API 访问资源，通过统一契约参与模型流程。

最关键的工程取舍是边界。插件越自由，早期扩展越快，但权限、兼容和诊断成本会急剧上升；宿主边界越清楚，生态发展越慢一些，却能支撑真实用户把本地资料、企业系统和高风险动作接进来。桌面 AI 助手最终比拼的不只是模型接得多，而是谁能让第三方能力安全、可观测、可升级地进入用户每天工作的环境。
