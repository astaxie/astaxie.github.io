# Article Source Rules

Write article sources as Markdown files under `content/articles/`.

Each file must be authored prose, not generated from a loop or reusable paragraph template. A build script may later convert Markdown to HTML, but it must not generate the article body.

Front matter:

```yaml
---
slug: example-slug
title: 文章标题
summary: 一句话摘要
categoryKey: rag
category: RAG
categoryLabel: RAG 与知识系统
source: NOTES/RAG
date: 2026-05-22
image: /assets/article-visuals/example-slug.svg
tags:
  - GraphRAG
  - RAG
---
```

Writing requirements:

- Chinese long-form technical article.
- At least 5000 Chinese characters in the body, excluding front matter.
- Use deep, practical engineering analysis instead of slogans.
- Include a local image reference near the top: `![标题图](/assets/article-visuals/<slug>.svg)`.
- Use headings, tables, lists, and concrete engineering checklists.
- Keep the voice like astaxie: Go/AI builder, pragmatic, community-facing, hands-on.
- Cover real implementation decisions, failure modes, observability, testing, and operational tradeoffs.
- Do not use filler, lorem ipsum, or repeated boilerplate paragraphs.
