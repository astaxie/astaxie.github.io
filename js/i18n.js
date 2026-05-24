(function () {
  var storageKey = "astaxie.lang";
  var preferenceKey = "astaxie.lang.preference";
  var sourceKey = "astaxie.lang.source";
  var currentLang = getStoredLang() || getBrowserLang();
  var applying = false;
  var scheduled = false;

  function normalizeLang(value) {
    return value === "en" ? "en" : "zh";
  }

  function getStoredLang() {
    try {
      var preferred = localStorage.getItem(preferenceKey);
      if (preferred === "en" || preferred === "zh") {
        return preferred;
      }

      var legacy = localStorage.getItem(storageKey);
      if (legacy === "en") {
        return legacy;
      }
      if (legacy === "zh" && localStorage.getItem(sourceKey) === "manual") {
        return legacy;
      }
      return "";
    } catch (error) {
      return "";
    }
  }

  function storeLang(lang) {
    try {
      var normalized = normalizeLang(lang);
      localStorage.setItem(preferenceKey, normalized);
      localStorage.setItem(storageKey, normalized);
      localStorage.setItem(sourceKey, "manual");
    } catch (error) {
      // Ignore storage failures so language switching still works in private modes.
    }
  }

  function getBrowserLang() {
    var languages = navigator.languages && navigator.languages.length ? navigator.languages : [navigator.language || navigator.userLanguage || ""];
    for (var i = 0; i < languages.length; i += 1) {
      var lang = String(languages[i]).toLowerCase();
      if (lang.indexOf("en") === 0) {
        return "en";
      }
      if (lang.indexOf("zh") === 0) {
        return "zh";
      }
    }
    return "zh";
  }

  var pairs = [
    ["Asta 的 AI 小站", "Asta's AI Site"],
    ["Asta 的 AI 小站：记录 AI Agent、MCP、RAG、LLM 应用工程、本地 AI 工具和 Go 开源实践。", "Asta's AI site: notes on AI Agents, MCP, RAG, LLM application engineering, local AI tooling, and Go open-source practice."],
    ["Asta 的 AI 小站，整理 AI Agent、MCP、RAG、LLM 应用工程、本地工具、Go 开源和社区实践。", "Asta's AI site, collecting notes on AI Agents, MCP, RAG, LLM application engineering, local tooling, Go open source, and community practice."],
    ["Astaxie, astaxie, AI 小站, AI Agent, MCP, RAG, LLM 应用工程, AI Native, 本地 AI 工具, ThinkInAI, DeepChat, Go, beego, GopherChina", "Astaxie, astaxie, AI site, AI Agent, MCP, RAG, LLM application engineering, AI Native, local AI tools, ThinkInAI, DeepChat, Go, beego, GopherChina"],
    ["复制", "Copy"],
    ["已复制", "Copied"],
    ["复制失败", "Copy failed"],
    ["复制代码", "Copy code"],
    ["Asta Xie 的 GitHub 头像", "Asta Xie's GitHub avatar"],
    ["关于我 | Asta 的 AI 小站", "About Me | Asta's AI Site"],
    ["项目 | Asta 的 AI 小站", "Projects | Asta's AI Site"],
    ["技术探索 | Asta 的 AI 小站", "Technical Explorations | Asta's AI Site"],
    ["2014 年归档 | Asta 的 AI 小站", "2014 Archive | Asta's AI Site"],
    ["2014 年 2 月归档 | Asta 的 AI 小站", "February 2014 Archive | Asta's AI Site"],
    ["API / beego | Asta 的 AI 小站", "API / beego | Asta's AI Site"],
    ["astaxie | AI 知识库与个人主页", "astaxie | AI Knowledge Base and Personal Homepage"],
    ["AI 知识库与个人主页", "AI Knowledge Base and Personal Homepage"],
    ["关于我 | 个人主页", "About Me | Personal Homepage"],
    ["项目 | astaxie", "Projects | astaxie"],
    ["技术探索 | astaxie", "Technical Explorations | astaxie"],
    ["2014 年归档 | astaxie", "2014 Archive | astaxie"],
    ["2014 年 2 月归档 | astaxie", "February 2014 Archive | astaxie"],
    ["API / beego | astaxie", "API / beego | astaxie"],
    ["Asta 的 AI 小站和知识分类入口：Go 布道、GopherChina、beego、ThinkInAI 与 AI 工程实践。", "Asta's AI site and knowledge index: Go evangelism, GopherChina, beego, ThinkInAI, and AI engineering practice."],
    ["关于我：从 Go 社区、beego、Go Web 编程，到 ThinkInAI、星科实验室和 AI 开发者社区。", "About me: from the Go community, beego, and Go Web Programming to ThinkInAI, X-Lab, and the AI developer community."],
    ["关于我：从 Go 早期开源生态、GopherChina、beego、《Go Web 编程》，到 ThinkInAI、星科实验室和 AI 工程实践。", "About me: from the early Go open-source ecosystem, GopherChina, beego, and Go Web Programming to ThinkInAI, X-Lab, and AI engineering practice."],
    ["astaxie 参与和关注的开源项目：DeepChat、clawdhome、go-mcp、beego、Go Web 编程等。", "Open-source projects astaxie participates in and follows: DeepChat, clawdhome, go-mcp, beego, Go Web Programming, and more."],
    ["从 Go 早期开源生态、GopherChina、beego、《Go Web 编程》，到 ThinkInAI、星科实验室和 AI 开发者社区。", "From the early Go open-source ecosystem, GopherChina, beego, and Go Web Programming to ThinkInAI, X-Lab, and the AI developer community."],
    ["Overview", "Overview"],
    ["AI Knowledge", "AI Knowledge"],
    ["Projects", "Projects"],
    ["Notes", "Notes"],
    ["首页", "Overview"],
    ["AI 知识", "AI Knowledge"],
    ["项目", "Projects"],
    ["笔记", "Notes"],
    ["索引", "Index"],
    ["联系", "Contact"],
    ["完整介绍", "Full profile"],
    ["阅读文章", "Read notes"],
    ["About Me", "About Me"],
    ["Articles", "Articles"],
    ["Project Links", "Project Links"],
    ["All projects", "All projects"],
    ["菜单", "Menu"],
    ["文章", "Articles"],
    ["全部文章", "All notes"],
    ["开源项目", "Open Source"],
    ["页面导航", "Page navigation"],
    ["文章路径", "Breadcrumb"],
    ["AI Agent 设计", "AI Agent Design"],
    ["MCP 与工具协议", "MCP and Tool Protocols"],
    ["RAG 与知识系统", "RAG and Knowledge Systems"],
    ["LLM 应用工程", "LLM Application Engineering"],
    ["评测、观测与成本", "Evals, Observability and Cost"],
    ["AI 工作流与工具", "AI Workflow and Tools"],
    ["关于我", "About Me"],
    ["个人介绍", "Profile"],
    ["开源项目列表", "Open Source Projects"],
    ["GitHub stars · 2026-05-22", "GitHub stars · 2026-05-22"],
    ["查看全部项目", "View all projects"],
    ["文章列表", "Notes"],
    ["上一页", "Prev"],
    ["下一页", "Next"],
    ["Category", "Category"],
    ["ARTICLE", "ARTICLE"],
    ["SUMMARY", "SUMMARY"],
    ["CATEGORY", "CATEGORY"],
    ["SOURCE", "SOURCE"],
    ["PROJECT", "PROJECT"],
    ["STACK", "STACK"],
    ["GO / AI BUILDER", "GO / AI BUILDER"],
    ["PROJECTS / GO / AI", "PROJECTS / GO / AI"],
    ["EXPLORATIONS / ARCHIVE", "EXPLORATIONS / ARCHIVE"],
    ["ARCHIVE / 2014", "ARCHIVE / 2014"],
    ["ARCHIVE / 2014-02", "ARCHIVE / 2014-02"],
    ["TAG / API / BEEGO", "TAG / API / BEEGO"],
    ["我从 Go 开源生态一路做到 AI 开发者工具，长期写代码、写书、做社区，也持续整理真实项目里的工程经验。", "I work across the Go open-source ecosystem and AI developer tooling: writing code, writing books, building communities, and documenting engineering lessons from real projects."],
    ["GopherChina / beego / Go Web", "GopherChina / beego / Go Web"],
    ["《Go Web 编程》", "Go Web Programming"],
    ["ThinkInAI / 星科实验室", "ThinkInAI / X-Lab"],
    ["从 Go 早期开源生态，到 AI 开发者社区的一线 Builder。", "From the early Go open-source ecosystem to the AI developer community."],
    ["一线实战派 AI Engineer。", "A hands-on AI Engineer in the field."],
    ["成长路径", "Path"],
    ["中国最早一批 Go 实践者", "One of China's earliest Go practitioners"],
    ["Go 布道者", "Go Evangelist"],
    ["GopherChina / Go Web / beego", "GopherChina / Go Web / beego"],
    ["ThinkInAI / Agent 工程 / AI Native 应用", "ThinkInAI / Agent Engineering / AI-native Apps"],
    ["AI 工程实践", "AI Engineering Practice"],
    ["ThinkInAI / 星科实验室 / 人才培养", "ThinkInAI / X-Lab / Talent Training"],
    ["我是中国最早一批 Gopher 和 Go 布道师之一，创立了 GopherChina 社区，长期推动 Go 在中国开发者中的传播和落地，也希望帮助更多 Go 开发者学习和实践 Go。", "I am one of China's earliest Gophers and Go evangelists. I founded the GopherChina community, have long helped Go spread and land in real engineering teams, and hope to help more Go developers learn and practice Go."],
    ["我是中国最早一批 Gopher 和 Go 布道师之一，创立了 GopherChina 社区，长期推动 Go 在中国开发者中的传播、协作和工程落地，也希望帮助更多 Go 开发者学习和实践 Go。", "I am one of China's earliest Gophers and Go evangelists. I founded GopherChina, have long worked on Go adoption, collaboration, and engineering practice, and hope to help more Go developers learn and practice Go."],
    ["我写过《Go Web 编程》，创建了国际上最早一批 Go Web 框架 beego，也做过早期 Go ORM 系统 beedb 等开源项目。进入 AI 时代后，我创立 ThinkInAI 社区，持续连接 AI 开发者、工具实践和真实产品构建。", "I wrote Go Web Programming, created beego, one of the earliest Go web frameworks internationally, and built early Go ORM work such as beedb. In the AI era, I founded ThinkInAI to connect AI developers, tool practice, and real product building."],
    ["我写过《Go Web 编程》，创建了国际上最早一批 Go Web 框架 beego，也做过早期 Go ORM 系统 beedb 等开源项目。对我来说，开源不是展示代码，而是把一个新技术变成更多开发者能学习、能使用、能继续参与的公共基础设施。", "I wrote Go Web Programming, created beego, one of the earliest Go web frameworks internationally, and built early Go ORM work such as beedb. For me, open source is not code display; it is public infrastructure that lets more developers learn, use, and participate in a new technology."],
    ["我更像一个持续动手的 Builder：用实战项目沉淀方法论，把开发者社区里的经验带回产品和工程实践。现在的重点放在 AI Native 应用、开发者工具、Agent 工作流，以及通过星科实验室培养应届毕业生进入 AI 工程实践。", "I work as a hands-on builder: using real projects to refine methods and bringing developer-community experience back into products and engineering practice. My current focus is AI-native applications, developer tools, Agent workflows, and training new graduates for AI engineering through X-Lab."],
    ["进入 AI 时代后，我创立 ThinkInAI 社区，继续围绕 AI Native 应用、开发者工具、Agent 工作流和工程实践做建设。我也创立了星科实验室，专门培养应届毕业生进入真实 AI 项目。", "In the AI era, I founded ThinkInAI and continue building around AI-native applications, developer tools, Agent workflows, and engineering practice. I also founded X-Lab to train new graduates through real AI projects."],
    ["早期 Gopher", "Early Gopher"],
    ["中国 Go 社区的先行者", "A pioneer in China's Go community"],
    ["上百万开发者", "1M+ developers"],
    ["通过社区、开源和写作沉淀 Go 学习路径", "Documenting Go learning paths through community, open source, and writing"],
    ["beego / beedb", "beego / beedb"],
    ["Go Web 与 ORM 早期开源实践", "Early open-source Go Web and ORM practice"],
    ["ThinkInAI", "ThinkInAI"],
    ["面向 AI 开发者的社区与实践网络", "A community and practice network for AI developers"],
    ["实战 + 工程实践", "Practice + Engineering"],
    ["从代码、框架、书籍、社区到 AI 人才培养，核心始终是把新技术变成开发者能学、能用、能参与的真实系统。", "From code, frameworks, books, and communities to AI talent training, the core has always been turning new technology into real systems developers can learn, use, and join."],
    ["Go 布道师", "Go evangelist"],
    ["中国最早一批 Gopher，推动 Go 工程实践落地", "One of China's earliest Gophers, helping Go engineering practice land"],
    ["Builder", "Builder"],
    ["持续构建：写代码、写书、做社区、做产品、培养新人。", "Sustained building: writing code, writing books, building communities, products, and new talent."],
    ["实战、社区和工程实践", "Practice, Community and Engineering"],
    ["Go 社区与布道", "Go Community and Evangelism"],
    ["作为中国最早一批 Gopher，我通过 GopherChina、技术写作、开源项目和持续分享，推动 Go 进入更多工程团队。", "As one of China's earliest Gophers, I helped bring Go into more engineering teams through GopherChina, technical writing, open-source projects, and continuous sharing."],
    ["早期开源项目", "Early Open Source"],
    ["beego、beedb 和《Go Web 编程》代表了早期 Go Web 生态的工程探索，也让大量开发者从可运行的项目开始学习。", "beego, beedb, and Go Web Programming represent early Go Web engineering exploration and helped many developers learn from runnable projects."],
    ["AI Builder", "AI Builder"],
    ["通过 ThinkInAI 和星科实验室，把 AI 工程实践落到产品、工作流和人才培养上，强调真实项目里的工程能力。", "Through ThinkInAI and X-Lab, I bring AI engineering practice into products, workflows, and talent training, emphasizing engineering ability in real projects."],
    ["技术线索", "Technical Throughline"],
    ["中国最早一批 Gopher", "One of China's Earliest Gophers"],
    ["持续布道 Go，创立 GopherChina 社区，连接开发者、企业实践和开源生态。", "I have continued sharing Go practice, founded GopherChina, and connected developers, company practice, and the open-source ecosystem."],
    ["beego、beedb 与《Go Web 编程》", "beego, beedb and Go Web Programming"],
    ["创建早期 Go Web 框架和 ORM 实践，通过开源书把 Go Web 开发经验系统化。", "I created early Go Web framework and ORM practice, and systematized Go Web development experience through an open-source book."],
    ["ThinkInAI 与星科实验室", "ThinkInAI and X-Lab"],
    ["建设 AI 开发者社区，探索 Agent、MCP、AI Native 应用和人才培养。", "Building an AI developer community and exploring Agents, MCP, AI-native applications, and talent training."],
    ["从 Go Web 生态到 AI Native 工具。", "From the Go Web ecosystem to AI-native tools."],
    ["这些项目有些服务于早期 Go 生态，有些服务于 AI 时代的新工作流。共同点是：它们都来自真实工程问题，也都希望让更多开发者可以直接上手。", "Some of these projects served the early Go ecosystem; others serve new AI-era workflows. What they share is that they come from real engineering problems and are meant to be usable by developers directly."],
    ["《Go Web 编程》开源书，帮助大量开发者系统学习 Go Web 开发。", "The open-source book Go Web Programming, helping many developers learn Go Web development systematically."],
    ["国际上最早一批 Go Web 框架，围绕 Web、API、ORM 和工程工具链沉淀实践。", "One of the earliest Go web frameworks internationally, collecting practice around Web, APIs, ORM, and engineering toolchains."],
    ["ThinkInAI 体系下的桌面 AI 助手，连接多模型、本地知识和个人工作流。", "A desktop AI assistant in the ThinkInAI ecosystem, connecting multiple models, local knowledge, and personal workflows."],
    ["围绕 Go 实战项目和最佳实践的长期整理，覆盖不同类型的工程场景。", "A long-running collection of Go practice projects and best practices across different engineering scenarios."],
    ["用 Go 实现的类 cURL 命令行工具，探索面向开发者的 CLI 体验。", "A cURL-like command-line tool implemented in Go, exploring CLI experiences for developers."],
    ["Go package 功能示例集合，帮助开发者理解标准库与常用包的使用方式。", "A collection of Go package examples that help developers understand the standard library and common packages."],
    ["beego 应用开发工具，支持项目创建、运行、热更新和工程化开发流程。", "The beego application development tool, supporting project creation, running, hot reload, and engineering workflows."],
    ["面向 Model Context Protocol 的 Go SDK，连接外部系统与 AI 应用。", "A Go SDK for the Model Context Protocol, connecting external systems with AI applications."],
    ["安全隔离和管理 Mac 上多个 OpenClaw gateway 实例，服务本地 AI 工具运行环境。", "Securely isolates and manages multiple OpenClaw gateway instances on a Mac for local AI tooling environments."],
    ["ThinkInAI 体系下的桌面 AI 助手，探索多模型、本地知识和个人工作流。", "A desktop AI assistant in the ThinkInAI ecosystem, exploring multiple models, local knowledge, and personal workflows."],
    ["面向 Model Context Protocol 的 Go SDK 与工具协议实践。", "A Go SDK and tool-protocol practice for the Model Context Protocol."],
    ["国际上最早一批 Go Web 框架，影响了大量 Go Web 开发者的工程实践。", "One of the earliest Go web frameworks internationally, influencing many Go Web developers' engineering practice."],
    ["《Go Web 编程》开源书，覆盖 Web 服务、数据库、部署和安全，帮助大量开发者入门 Go Web。", "The open-source book Go Web Programming, covering web services, databases, deployment, and security, helping many developers get started with Go Web."],
    ["《Go Web 编程》开源书，帮助大量开发者入门 Go Web。", "The open-source book Go Web Programming, helping many developers get started with Go Web."],
    ["项目背后的工程偏好", "Engineering Preferences Behind the Projects"],
    ["先把边界画清楚", "Draw Clear Boundaries First"],
    ["协议、模块和依赖边界越清楚，越容易测试，也越容易让工具和人类协同。", "The clearer the protocol, module, and dependency boundaries, the easier a system is to test and the easier tools and humans can collaborate."],
    ["用示例解释设计", "Explain Design with Examples"],
    ["一个能跑的例子，往往比抽象说明更能暴露问题。文档和示例应该跟代码一起演进。", "A runnable example often exposes problems better than abstract explanation. Docs and examples should evolve with the code."],
    ["保持实现可替换", "Keep Implementations Replaceable"],
    ["模型、存储、UI 和外部服务都会变化。架构要允许局部替换，而不是把选择固定在核心里。", "Models, storage, UI, and external services all change. Architecture should allow local replacement rather than fixing every choice in the core."],
    ["把技术实验、设计判断和复盘沉淀成知识库。", "Turn technical experiments, design judgments, and retrospectives into a knowledge base."],
    ["这里会记录平常遇到的问题、做过的实验、项目里的设计判断，以及一些值得反复回看的工程笔记。", "This records daily problems, experiments, project design decisions, and engineering notes worth revisiting."],
    ["旧站保留下来的 API-first Web 应用和 beego 技术文章。", "An archived note about API-first web applications and beego."],
    ["旧站保留下来的 beego 技术文章。", "An archived beego technical note from the old site."],
    ["准备补上的笔记", "Notes to Write"],
    ["DeepChat 的本地知识设计", "DeepChat Local Knowledge Design"],
    ["如何在桌面 AI 应用里处理本地文件、会话上下文和多模型调用之间的关系。", "How a desktop AI app should handle local files, session context, and multi-model calls."],
    ["MCP Server 的测试策略", "MCP Server Testing Strategy"],
    ["协议实现如何做集成测试、契约测试和错误回放，避免工具调用成为黑盒。", "How protocol implementations can use integration tests, contract tests, and error replay to keep tool calls from becoming black boxes."],
    ["从 beego 回看 Go Web", "Looking Back at Go Web from beego"],
    ["经过多年生态演进后，再看框架、约定、代码生成和工程化工具的取舍。", "After years of ecosystem evolution, revisiting tradeoffs around frameworks, conventions, code generation, and engineering tools."],
    ["旧站保留下来的 beego 技术文章。", "An archived beego technical note from the old site."],
    ["API-first 与 beego 文章。", "API-first and beego notes."],
    ["与 API-first Web 应用和 beego 相关的旧文章。", "Archived notes related to API-first web applications and beego."],
    ["使用 beego 构建 API-first Web 应用的早期记录。", "An early note on building API-first web applications with beego."],
    ["Agent 工具调用从 demo 到生产要补哪些边界？", "What Boundaries Do Agent Tool Calls Need from Demo to Production?"],
    ["从权限、上下文、回放和人工确认四个边界看 Agent 工具调用。", "Tool calls viewed through permission, context, replay, and human-confirmation boundaries."],
    ["demo 阶段只要模型能调用工具就足够兴奋；进入真实场景后，真正决定系统是否可靠的，是工具调用周围的边界。", "In the demo stage, it is exciting enough that a model can call tools. In real scenarios, reliability depends on the boundaries around those calls."],
    ["权限边界", "Permission Boundaries"],
    ["每个工具都应该明确它能读什么、能写什么、会不会触发外部副作用。读操作、写操作、网络请求、文件修改和敏感数据发送应该分层处理。", "Every tool should make clear what it can read, what it can write, and whether it triggers external side effects. Reads, writes, network calls, file edits, and sensitive-data transmission should be handled in layers."],
    ["上下文边界", "Context Boundaries"],
    ["工具不应该拿到无限上下文。更好的方式是给工具输入稳定 schema，并把模型推理、用户意图、系统状态和执行参数拆开。", "Tools should not receive unlimited context. A better pattern is stable tool-input schemas that separate model reasoning, user intent, system state, and execution parameters."],
    ["回放边界", "Replay Boundaries"],
    ["生产里的 Agent 需要能解释它做过什么。工具调用参数、返回值、错误、重试和人工确认都应该能被记录和回放。", "Production Agents need to explain what they did. Tool parameters, returns, errors, retries, and human confirmations should all be recorded and replayable."],
    ["人工确认", "Human Confirmation"],
    ["越靠近真实世界副作用，越需要确认机制。确认不是降低自动化，而是把风险从隐式行为变成显式决策。", "The closer an action gets to real-world side effects, the more it needs confirmation. Confirmation does not reduce automation; it turns risk from implicit behavior into explicit decisions."],
    ["Go 里实现 MCP Server 的接口设计和测试策略", "Interface Design and Testing Strategy for MCP Servers in Go"],
    ["梳理 MCP Server 的资源、工具、错误语义和契约测试。", "A look at resources, tools, error semantics, and contract tests for MCP Servers."],
    ["MCP Server 的质量，不只在于能否响应请求，也在于资源、工具和错误语义是否稳定可测。", "MCP Server quality is not only whether it can respond to requests, but whether resources, tools, and error semantics are stable and testable."],
    ["接口形状", "Interface Shape"],
    ["Go 里适合用清晰的小接口表达资源读取、工具执行和会话状态。实现层可以替换，但协议层的输入输出需要稳定。", "In Go, small clear interfaces work well for resource reads, tool execution, and session state. Implementations can be replaced, but protocol-layer inputs and outputs should remain stable."],
    ["错误语义", "Error Semantics"],
    ["工具执行失败、参数非法、权限不足和外部依赖不可用应该有不同错误语义，避免客户端只能得到一段不可处理的字符串。", "Tool execution failures, invalid arguments, insufficient permissions, and unavailable dependencies should have distinct error semantics, so clients are not left with an unprocessable string."],
    ["测试策略", "Testing Strategy"],
    ["单元测试覆盖 handler，契约测试覆盖协议输入输出，集成测试覆盖真实传输层和典型客户端行为。", "Unit tests cover handlers, contract tests cover protocol inputs and outputs, and integration tests cover real transports and typical client behavior."],
    ["回放与诊断", "Replay and Diagnosis"],
    ["保留请求、参数、结果和耗时信息，可以让一次工具调用失败从“模型不稳定”变成可定位的问题。", "Keeping requests, parameters, results, and timing data turns a failed tool call from \"the model is unstable\" into a diagnosable problem."],
    ["个人知识库里的 RAG 工作流", "RAG Workflows in a Personal Knowledge Base"],
    ["从文档切分、索引、引用和更新机制看 RAG 的日常使用。", "Daily RAG practice through document chunking, indexing, citation, and update mechanisms."],
    ["个人知识库的 RAG 不只是向量检索，它需要和写作、代码、项目记录、Issue 和复盘一起工作。", "RAG for a personal knowledge base is more than vector search. It needs to work with writing, code, project records, issues, and retrospectives."],
    ["文档切分", "Document Chunking"],
    ["切分策略要尊重文档结构。标题、列表、代码块和引用关系比固定 token 长度更重要。", "Chunking should respect document structure. Headings, lists, code blocks, and references matter more than fixed token lengths."],
    ["检索与重排", "Retrieval and Reranking"],
    ["向量检索适合召回语义相关内容，关键词和结构过滤适合保证范围，重排用于提升最终上下文质量。", "Vector retrieval works for semantic recall, keywords and structural filters help scope the search, and reranking improves final context quality."],
    ["引用与可信度", "Citation and Trust"],
    ["回答应尽量保留来源路径和片段边界，让用户知道结论来自哪里，也方便回到原文继续编辑。", "Answers should preserve source paths and snippet boundaries when possible, so users know where conclusions came from and can return to the original text."],
    ["知识更新", "Knowledge Updates"],
    ["知识库需要增量更新、失效处理和重复内容合并，否则检索质量会随着时间下降。", "Knowledge bases need incremental updates, invalidation, and duplicate merging, or retrieval quality will degrade over time."],
    ["LLM 应用工程循环", "The LLM Application Engineering Loop"],
    ["把 prompt、结构化输出、工具调用和评测放进同一个迭代闭环。", "Putting prompts, structured outputs, tool calls, and evals into one iteration loop."],
    ["模型能力是起点，稳定产品来自 prompt、数据、工具、评测和观测的持续迭代。", "Model capability is the starting point; stable products come from continuous iteration on prompts, data, tools, evals, and observability."],
    ["Prompt 是接口", "Prompt Is an Interface"],
    ["Prompt 应该像接口一样被版本化、被测试，并且明确输入、输出、约束和失败处理。", "Prompts should be versioned and tested like interfaces, with clear inputs, outputs, constraints, and failure handling."],
    ["结构化输出", "Structured Outputs"],
    ["尽量用 schema 收敛模型输出，把自然语言不确定性隔离在可处理的边界内。", "Use schemas where possible to constrain model output and isolate natural-language uncertainty within manageable boundaries."],
    ["工具调用", "Tool Calling"],
    ["工具让模型接触真实系统，也带来权限、安全和可观测性的要求。", "Tools connect models to real systems, which also brings requirements around permissions, safety, and observability."],
    ["迭代闭环", "Iteration Loop"],
    ["每次线上反馈都应该能进入样本、评测和实现改进，而不是只靠人工感觉调 prompt。", "Every production feedback signal should feed samples, evals, and implementation improvements, rather than relying only on human intuition to tune prompts."],
    ["评测、观测与成本控制", "Evals, Observability and Cost Control"],
    ["用 trace、回归集和成本指标让 AI 应用持续变好。", "Using traces, regression sets, and cost metrics to keep improving AI applications."],
    ["AI 应用不能只看单次回答好不好，还要看长期质量、延迟、成本和失败模式。", "AI applications cannot only judge one answer at a time; they need to track long-term quality, latency, cost, and failure modes."],
    ["评测集", "Eval Sets"],
    ["从真实用户问题、失败案例和关键业务路径里沉淀评测集，避免每次修改都靠人工抽样判断。", "Build eval sets from real user questions, failures, and critical paths, so every change is not judged only by manual sampling."],
    ["一次请求里的模型调用、检索、工具执行和后处理都应该能被串起来看。", "Model calls, retrieval, tool execution, and post-processing inside one request should be visible as a connected trace."],
    ["成本", "Cost"],
    ["成本不是最后优化项。模型选择、上下文长度、缓存策略和重试策略都会影响单位任务成本。", "Cost is not a final optimization item. Model choice, context length, caching, and retry strategy all affect per-task cost."],
    ["质量闭环", "Quality Loop"],
    ["观测数据需要能回到开发流程，形成样本、评测、修复和发布的闭环。", "Observability data should flow back into development, forming a loop of samples, evals, fixes, and releases."],
    ["AI 工作流与本地工具组合", "AI Workflows and Local Tooling"],
    ["DeepChat、CLI、编辑器和浏览器自动化如何进入日常研发流程。", "How DeepChat, CLIs, editors, and browser automation enter daily development workflows."],
    ["真正有用的 AI 工具，应该能和代码、浏览器、文档、终端和个人知识系统一起工作。", "Truly useful AI tools should work with code, browsers, documents, terminals, and personal knowledge systems."],
    ["桌面 AI", "Desktop AI"],
    ["桌面应用适合承载本地文件、多个模型、长期会话和个人上下文。", "Desktop apps are well-suited for local files, multiple models, long-running sessions, and personal context."],
    ["CLI 与自动化", "CLI and Automation"],
    ["CLI 工具让 AI 能进入开发流程，也让任务更容易被脚本化、复现和审计。", "CLI tools let AI enter the development flow and make tasks easier to script, reproduce, and audit."],
    ["浏览器工作流", "Browser Workflows"],
    ["浏览器自动化适合处理网页信息、验证 UI 和连接仍然以 Web 为入口的系统。", "Browser automation is useful for handling web information, verifying UI, and connecting systems that still use the web as their entry point."],
    ["工作习惯", "Working Habits"],
    ["稳定的 AI 工作流来自小步迭代：收集素材、形成问题、让工具执行、再把结果沉淀回知识库。", "Stable AI workflows come from small iterations: collect material, form questions, let tools execute, and fold results back into the knowledge base."]
  ];

  var sourceEnglishToZh = {
    "Overview": "首页",
    "AI Knowledge": "AI 知识",
    "Projects": "项目",
    "Notes": "笔记",
    "About Me": "关于我",
    "Menu": "菜单",
    "Articles": "文章",
    "Project Links": "项目链接",
    "All projects": "全部项目",
    "Open Source": "开源项目",
    "Page navigation": "页面导航",
    "Breadcrumb": "文章路径",
    "Path": "成长路径",
    "Go Evangelist": "Go 布道者",
    "AI Engineering Practice": "AI 工程实践",
    "Index": "索引",
    "Contact": "联系",
    "Archive": "归档",
    "Read notes": "阅读文章",
    "Full profile": "完整介绍",
    "Prev": "上一页",
    "Next": "下一页",
    "PROJECT": "项目",
    "SUMMARY": "摘要",
    "STACK": "技术栈",
    "SOURCE": "来源",
    "ARTICLE": "文章",
    "CATEGORY": "分类",
    "Category": "分类",
    "GITHUB": "GitHub",
    "AI App": "AI 应用",
    "Go / MCP": "Go / MCP",
    "Go / Web": "Go / Web",
    "Book / Go": "书籍 / Go",
    "AI Agent": "AI Agent",
    "MCP": "MCP",
    "RAG": "RAG",
    "LLM Apps": "LLM 应用",
    "Evaluation": "评测",
    "Workflow": "工作流"
  };

  var enMap = {};
  var zhMap = {};
  pairs.forEach(function (pair) {
    enMap[pair[0]] = pair[1];
    if (!zhMap[pair[1]]) {
      zhMap[pair[1]] = pair[0];
    }
  });
  Object.keys(sourceEnglishToZh).forEach(function (key) {
    zhMap[key] = sourceEnglishToZh[key];
  });

  function preserveSpace(original, replacement) {
    var prefix = original.match(/^\s*/)[0];
    var suffix = original.match(/\s*$/)[0];
    return prefix + replacement + suffix;
  }

  function translateValue(value, lang) {
    var trimmed = value.trim();
    if (!trimmed) {
      return value;
    }
    var map = lang === "en" ? enMap : zhMap;
    if (Object.prototype.hasOwnProperty.call(map, trimmed)) {
      return preserveSpace(value, map[trimmed]);
    }
    return value;
  }

  function shouldSkip(node) {
    var el = node.nodeType === 1 ? node : node.parentElement;
    if (!el) {
      return true;
    }
    return !!el.closest("script, style, noscript, code, pre, kbd, .mermaid-block, .lang-toggle, .brand-mark, .brand-name");
  }

  function translateTextNodes(root, lang) {
    var walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
      acceptNode: function (node) {
        return shouldSkip(node) ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT;
      }
    });
    var nodes = [];
    var node;
    while ((node = walker.nextNode())) {
      nodes.push(node);
    }
    nodes.forEach(function (textNode) {
      var next = translateValue(textNode.nodeValue, lang);
      if (next !== textNode.nodeValue) {
        textNode.nodeValue = next;
      }
    });
  }

  function translateAttributes(root, lang) {
    var attrs = ["aria-label", "alt", "title", "placeholder", "content"];
    root.querySelectorAll("*").forEach(function (el) {
      if (shouldSkip(el)) {
        return;
      }
      attrs.forEach(function (attr) {
        if (el.hasAttribute(attr)) {
          var current = el.getAttribute(attr);
          var next = translateValue(current, lang);
          if (next !== current) {
            el.setAttribute(attr, next);
          }
        }
      });
    });
  }

  function updateChrome(lang) {
    document.documentElement.lang = lang === "en" ? "en" : "zh-CN";
    document.body.setAttribute("data-lang", lang);
    document.title = translateValue(document.title, lang);
    document.querySelectorAll(".lang-toggle button").forEach(function (button) {
      button.classList.toggle("active", getToggleLang(button) === lang);
      button.setAttribute("aria-pressed", button.classList.contains("active") ? "true" : "false");
    });
  }

  function applyLanguage(lang, shouldStore) {
    applying = true;
    currentLang = normalizeLang(lang);
    if (shouldStore) {
      storeLang(currentLang);
    }
    translateTextNodes(document.body, currentLang);
    translateAttributes(document, currentLang);
    updateChrome(currentLang);
    applying = false;
  }

  function scheduleApply() {
    if (applying || scheduled) {
      return;
    }
    scheduled = true;
    window.requestAnimationFrame(function () {
      scheduled = false;
      applyLanguage(currentLang, false);
    });
  }

  function getToggleLang(button) {
    return button.getAttribute("data-lang-toggle") || button.getAttribute("data-lang") || "zh";
  }

  function createToggle(className) {
    var wrap = document.createElement("div");
    wrap.className = "lang-toggle " + (className || "");
    wrap.setAttribute("role", "group");
    wrap.setAttribute("aria-label", "Language");
    wrap.innerHTML = '<button type="button" data-lang-toggle="zh">中</button><button type="button" data-lang-toggle="en">EN</button>';
    return wrap;
  }

  function installToggles() {
    document.querySelectorAll(".topbar-actions").forEach(function (actions) {
      if (!actions.querySelector(".lang-toggle")) {
        actions.appendChild(createToggle("topbar-lang-toggle"));
      }
    });
    document.querySelectorAll(".about-me-card").forEach(function (card) {
      if (!card.querySelector(".rail-lang-toggle")) {
        card.appendChild(createToggle("rail-lang-toggle"));
      }
    });
  }

  document.addEventListener("DOMContentLoaded", function () {
    installToggles();
    document.addEventListener("click", function (event) {
      var button = event.target.closest(".lang-toggle button");
      if (button) {
        applyLanguage(getToggleLang(button), true);
      }
    });
    applyLanguage(currentLang, false);
    new MutationObserver(scheduleApply).observe(document.body, {
      childList: true,
      characterData: true,
      subtree: true
    });
  });
}());
