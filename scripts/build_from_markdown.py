from __future__ import annotations

import html
import json
import re
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
CONTENT_DIR = ROOT / "content" / "articles"
NOTES_DIR = ROOT / "notes"
ARTICLES_JS = ROOT / "js" / "articles.js"
SITE_NAME = "Asta 的 AI 小站"
SITE_KEYWORDS = "Astaxie, astaxie, AI 小站, AI Agent, MCP, RAG, LLM 应用工程, AI Native, 本地 AI 工具, ThinkInAI, DeepChat, Go, beego, GopherChina"
I18N_VERSION = "20260524-lang6"
ARTICLE_RENDERING_VERSION = "20260524-render4"
SOCIAL_LINKS_HTML = """
      <div class="rail-social-links" aria-label="社交链接">
        <a class="rail-social-link" href="https://github.com/astaxie" aria-label="GitHub" title="GitHub" target="_blank" rel="noopener noreferrer"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 .5C5.65.5.5 5.65.5 12c0 5.08 3.29 9.39 7.86 10.91.58.11.79-.25.79-.56 0-.28-.01-1.02-.02-2-3.2.7-3.88-1.54-3.88-1.54-.52-1.33-1.28-1.69-1.28-1.69-1.05-.72.08-.7.08-.7 1.16.08 1.77 1.19 1.77 1.19 1.03 1.76 2.7 1.25 3.36.96.1-.75.4-1.25.73-1.54-2.55-.29-5.23-1.28-5.23-5.68 0-1.25.45-2.28 1.19-3.08-.12-.29-.52-1.46.11-3.04 0 0 .97-.31 3.18 1.18.92-.26 1.91-.39 2.9-.39.98 0 1.98.13 2.9.39 2.2-1.49 3.17-1.18 3.17-1.18.63 1.58.23 2.75.11 3.04.74.8 1.18 1.83 1.18 3.08 0 4.41-2.69 5.39-5.25 5.67.41.35.78 1.05.78 2.12 0 1.53-.01 2.76-.01 3.14 0 .31.21.67.8.56A10.99 10.99 0 0 0 23.5 12C23.5 5.65 18.35.5 12 .5Z"/></svg></a>
        <a class="rail-social-link" href="https://twitter.com/astaxie" aria-label="Twitter" title="Twitter" target="_blank" rel="noopener noreferrer"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M23.95 4.57c-.88.39-1.83.65-2.83.77a4.92 4.92 0 0 0 2.17-2.72 9.84 9.84 0 0 1-3.13 1.2A4.92 4.92 0 0 0 11.78 8.3 13.97 13.97 0 0 1 1.64 3.16a4.92 4.92 0 0 0 1.52 6.57 4.87 4.87 0 0 1-2.23-.62v.06a4.93 4.93 0 0 0 3.95 4.83 4.97 4.97 0 0 1-2.22.08 4.94 4.94 0 0 0 4.6 3.42A9.87 9.87 0 0 1 0 19.54a13.93 13.93 0 0 0 7.55 2.21c9.05 0 14-7.5 14-14v-.64a10 10 0 0 0 2.4-2.54Z"/></svg></a>
      </div>"""


CATEGORY_LINKS = [
    ("all", "全部文章", "/#article-browser"),
    ("agents", "AI Agent 设计", "/#agents"),
    ("mcp", "MCP 与工具协议", "/#mcp"),
    ("rag", "RAG 与知识系统", "/#rag"),
    ("llm-apps", "LLM 应用工程", "/#llm-apps"),
    ("evals", "评测、观测与成本", "/#evals"),
    ("workflow", "AI 工作流与工具", "/#workflow"),
]


def parse_articles_js() -> list[dict]:
    text = ARTICLES_JS.read_text(encoding="utf-8")
    match = re.search(r"window\.ASTAXIE_ARTICLES\s*=\s*(\[.*?\]);", text, re.S)
    if not match:
        raise ValueError("Cannot find window.ASTAXIE_ARTICLES in js/articles.js")
    return json.loads(match.group(1))


def split_front_matter(text: str) -> tuple[dict, str]:
    if not text.startswith("---\n"):
        return {}, text
    end = text.find("\n---\n", 4)
    if end == -1:
        return {}, text
    raw = text[4:end]
    body = text[end + 5 :]
    meta: dict[str, object] = {}
    current_list: str | None = None
    for line in raw.splitlines():
        if not line.strip():
            continue
        if line.startswith("  - ") and current_list:
            meta.setdefault(current_list, []).append(line[4:].strip())
            continue
        current_list = None
        if ":" not in line:
            continue
        key, value = line.split(":", 1)
        key = key.strip()
        value = value.strip()
        if value:
            meta[key] = value.strip('"').strip("'")
        else:
            meta[key] = []
            current_list = key
    return meta, body


def inline_md(text: str) -> str:
    text = html.escape(text, quote=False)
    text = re.sub(r"`([^`]+)`", r"<code>\1</code>", text)
    text = re.sub(r"\*\*([^*]+)\*\*", r"<strong>\1</strong>", text)
    text = re.sub(r"\[([^\]]+)\]\(([^)]+)\)", r'<a href="\2">\1</a>', text)
    return text


def slugify_heading(text: str) -> str:
    cleaned = re.sub(r"[^\w\u4e00-\u9fff -]", "", text).strip().lower()
    return re.sub(r"\s+", "-", cleaned) or "section"


def normalize_code_language(raw: str) -> str:
    language = (raw or "text").strip().split(maxsplit=1)[0].lower()
    language = re.sub(r"[^a-z0-9_+-]", "-", language)
    aliases = {
        "c++": "cpp",
        "golang": "go",
        "js": "javascript",
        "md": "markdown",
        "sh": "bash",
        "shell": "bash",
        "text": "plaintext",
        "ts": "typescript",
        "yml": "yaml",
    }
    return aliases.get(language, language or "plaintext")


def code_language_label(language: str) -> str:
    labels = {
        "bash": "Bash",
        "cpp": "C++",
        "css": "CSS",
        "diff": "Diff",
        "dockerfile": "Dockerfile",
        "go": "Go",
        "html": "HTML",
        "http": "HTTP",
        "ini": "INI",
        "java": "Java",
        "javascript": "JavaScript",
        "json": "JSON",
        "kotlin": "Kotlin",
        "makefile": "Makefile",
        "markdown": "Markdown",
        "plaintext": "Text",
        "python": "Python",
        "rust": "Rust",
        "sql": "SQL",
        "swift": "Swift",
        "toml": "TOML",
        "typescript": "TypeScript",
        "xml": "XML",
        "yaml": "YAML",
    }
    return labels.get(language, language.upper())


def is_table(lines: list[str], index: int) -> bool:
    if index + 1 >= len(lines):
        return False
    return "|" in lines[index] and re.fullmatch(r"\s*\|?[\s:-]+\|[\s|:-]+\s*", lines[index + 1]) is not None


def render_table(lines: list[str], index: int) -> tuple[str, int]:
    header = [cell.strip() for cell in lines[index].strip().strip("|").split("|")]
    rows: list[list[str]] = []
    cursor = index + 2
    while cursor < len(lines) and "|" in lines[cursor] and lines[cursor].strip():
        rows.append([cell.strip() for cell in lines[cursor].strip().strip("|").split("|")])
        cursor += 1
    head = "".join(f'<th scope="col">{inline_md(cell)}</th>' for cell in header)
    body = "".join(
        "<tr>" + "".join(f"<td>{inline_md(cell)}</td>" for cell in row) + "</tr>"
        for row in rows
    )
    return f"<div class=\"article-table-wrap\"><table class=\"article-data-table\"><thead><tr>{head}</tr></thead><tbody>{body}</tbody></table></div>", cursor


def render_markdown(markdown: str, title: str) -> str:
    lines = markdown.strip().splitlines()
    if lines and lines[0].strip().startswith("![标题图]"):
        leading_image = lines.pop(0)
    else:
        leading_image = ""
    while lines and not lines[0].strip():
        lines.pop(0)
    if lines and lines[0].strip() == f"# {title}":
        lines.pop(0)
    if leading_image:
        lines.insert(0, leading_image)

    rendered: list[str] = []
    paragraph: list[str] = []
    cursor = 0
    in_code = False
    code_lang = ""
    code_lines: list[str] = []

    def flush_paragraph() -> None:
        if paragraph:
            rendered.append(f"<p>{inline_md(' '.join(paragraph))}</p>")
            paragraph.clear()

    while cursor < len(lines):
        line = lines[cursor]
        stripped = line.strip()

        if stripped.startswith("```"):
            if in_code:
                code_text = html.escape(chr(10).join(code_lines))
                language = normalize_code_language(code_lang)
                if language == "mermaid":
                    rendered.append(
                        '<figure class="mermaid-block" data-mermaid-block>'
                        f'<template data-mermaid-source>{code_text}</template>'
                        '<div class="mermaid-render" role="img" aria-label="Mermaid 图表" aria-busy="true">图表加载中...</div>'
                        "</figure>"
                    )
                else:
                    escaped_language = html.escape(language)
                    escaped_label = html.escape(code_language_label(language))
                    rendered.append(
                        '<div class="code-block">'
                        f'<pre class="line-numbers language-{escaped_language}" data-language="{escaped_label}">'
                        f'<code class="language-{escaped_language}">{code_text}</code>'
                        "</pre>"
                        "</div>"
                    )
                in_code = False
                code_lang = ""
                code_lines = []
            else:
                flush_paragraph()
                in_code = True
                code_lang = stripped[3:].strip()
            cursor += 1
            continue

        if in_code:
            code_lines.append(line)
            cursor += 1
            continue

        if not stripped:
            flush_paragraph()
            cursor += 1
            continue

        if is_table(lines, cursor):
            flush_paragraph()
            table, cursor = render_table(lines, cursor)
            rendered.append(table)
            continue

        image_match = re.fullmatch(r"!\[([^\]]*)\]\(([^)]+)\)", stripped)
        if image_match:
            flush_paragraph()
            alt, src = image_match.groups()
            rendered.append(
                '<figure class="note-hero-visual">'
                f'<img src="{html.escape(src)}" alt="{html.escape(alt or title)}" loading="lazy">'
                f"<figcaption>{html.escape(title)} 的工程图示。</figcaption>"
                "</figure>"
            )
            cursor += 1
            continue

        heading = re.match(r"^(#{2,4})\s+(.+)$", stripped)
        if heading:
            flush_paragraph()
            level = len(heading.group(1))
            text = heading.group(2).strip()
            rendered.append(f'<h{level} id="{slugify_heading(text)}">{inline_md(text)}</h{level}>')
            cursor += 1
            continue

        if stripped.startswith("- "):
            flush_paragraph()
            items = []
            while cursor < len(lines) and lines[cursor].strip().startswith("- "):
                items.append(f"<li>{inline_md(lines[cursor].strip()[2:])}</li>")
                cursor += 1
            rendered.append("<ul>" + "".join(items) + "</ul>")
            continue

        ordered = re.match(r"^\d+\.\s+(.+)$", stripped)
        if ordered:
            flush_paragraph()
            items = []
            while cursor < len(lines):
                item = re.match(r"^\d+\.\s+(.+)$", lines[cursor].strip())
                if not item:
                    break
                items.append(f"<li>{inline_md(item.group(1))}</li>")
                cursor += 1
            rendered.append("<ol>" + "".join(items) + "</ol>")
            continue

        if stripped.startswith("> "):
            flush_paragraph()
            quotes = []
            while cursor < len(lines) and lines[cursor].strip().startswith("> "):
                quotes.append(lines[cursor].strip()[2:])
                cursor += 1
            rendered.append(f"<blockquote>{inline_md(' '.join(quotes))}</blockquote>")
            continue

        paragraph.append(stripped)
        cursor += 1

    flush_paragraph()
    return "\n".join(rendered)


def left_rail(active_category: str) -> str:
    category_html = "\n".join(
        f'<a class="rail-link rail-sub-link{" active" if key == active_category else ""}" href="{href}">{label}</a>'
        for key, label, href in CATEGORY_LINKS
    )
    return f"""
    <aside class="left-rail" aria-label="About me">
      <section class="rail-card about-me-card">
        <div class="rail-title">关于我</div>
        <div class="about-profile"><img src="/css/img/avatar-astaxie.jpg" alt="Asta Xie 的 GitHub 头像" width="460" height="460"><div><strong>Asta Xie</strong><span>astaxie</span></div></div>
        <p>我从 Go 开源生态一路做到 AI 开发者工具，长期写代码、写书、做社区，也持续整理真实项目里的工程经验。</p>
        <div class="rail-stats">
          <span><b>Go</b> GopherChina / beego / Go Web</span>
          <span><b>Book</b> 《Go Web 编程》</span>
          <span><b>AI</b> ThinkInAI / 星科实验室</span>
        </div>
        <div class="lang-toggle rail-lang-toggle" aria-label="Language"><button type="button" data-lang="zh">中</button><button type="button" data-lang="en">EN</button></div>
      </section>
      <section class="rail-card rail-nav-card"><nav class="rail-menu" aria-label="页面导航"><a class="rail-link rail-primary-link" href="/about/">关于我</a><a class="rail-link rail-primary-link" href="/projects/">开源项目</a><details class="rail-menu-group" open><summary class="rail-link rail-primary-link rail-menu-summary active">文章</summary><div class="article-menu rail-submenu" aria-label="文章分类">{category_html}</div></details></nav></section>
      {SOCIAL_LINKS_HTML}
    </aside>"""


def render_page(article: dict, body_html: str, index: int) -> str:
    tags = "".join(f"<span>{html.escape(tag)}</span>" for tag in article.get("tags", []))
    title = html.escape(article["title"])
    summary = html.escape(article["summary"])
    keywords = html.escape(SITE_KEYWORDS)
    source = html.escape(article["source"].replace("NOTES/", "NOTES / "))
    category = article["categoryKey"]
    number = f"{index + 1:03d}"
    return f"""<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>{title} | {html.escape(SITE_NAME)}</title>
  <meta name="author" content="Asta Xie">
  <meta name="description" content="{summary}">
  <meta name="keywords" content="{keywords}">
  <meta property="og:title" content="{title}">
  <meta property="og:description" content="{summary}">
  <meta property="og:site_name" content="{html.escape(SITE_NAME)}">
  <meta property="og:image" content="{html.escape(article["image"])}">
  <link href="/favicon.ico" rel="icon">
  <link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/prismjs@1.29.0/themes/prism-tomorrow.min.css">
  <link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/prismjs@1.29.0/plugins/toolbar/prism-toolbar.min.css">
  <link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/prismjs@1.29.0/plugins/line-numbers/prism-line-numbers.min.css">
  <link rel="stylesheet" href="/css/style.css">
</head>
<body class="docs-home note-page">
  <div class="docs-layout">
    {left_rail(category)}
    <main class="docs-main">
      <article class="note-detail article-rich-detail">
        <header>
          <nav class="note-breadcrumb" aria-label="文章路径"><a href="/#article-browser">全部文章</a><span>-></span><span>{title}</span></nav>
          <div class="note-kicker">{source} / {number}</div>
          <h1>{title}</h1>
          <p>{summary}</p>
          <div class="note-tag-row">{tags}</div>
        </header>
        {body_html}
      </article>
    </main>
  </div>
  <script>window.Prism = window.Prism || {{}}; window.Prism.manual = true;</script>
  <script src="https://cdn.jsdelivr.net/npm/prismjs@1.29.0/components/prism-core.min.js" defer></script>
  <script src="https://cdn.jsdelivr.net/npm/prismjs@1.29.0/plugins/autoloader/prism-autoloader.min.js" defer></script>
  <script src="https://cdn.jsdelivr.net/npm/prismjs@1.29.0/plugins/toolbar/prism-toolbar.min.js" defer></script>
  <script src="https://cdn.jsdelivr.net/npm/prismjs@1.29.0/plugins/show-language/prism-show-language.min.js" defer></script>
  <script src="https://cdn.jsdelivr.net/npm/prismjs@1.29.0/plugins/copy-to-clipboard/prism-copy-to-clipboard.min.js" defer></script>
  <script src="https://cdn.jsdelivr.net/npm/prismjs@1.29.0/plugins/line-numbers/prism-line-numbers.min.js" defer></script>
  <script src="/js/vendor/mermaid.min.js" defer></script>
  <script src="/js/article-rendering.js?v={ARTICLE_RENDERING_VERSION}" defer></script>
  <script src="/js/i18n.js?v={I18N_VERSION}" defer></script>
</body>
</html>
"""


def main() -> int:
    articles = parse_articles_js()
    for index, article in enumerate(articles):
        path = CONTENT_DIR / f"{article['slug']}.md"
        if not path.exists():
            continue
        meta, body = split_front_matter(path.read_text(encoding="utf-8"))
        body_html = render_markdown(body, str(meta.get("title", article["title"])))
        output_dir = NOTES_DIR / article["slug"]
        output_dir.mkdir(parents=True, exist_ok=True)
        (output_dir / "index.html").write_text(render_page(article, body_html, index), encoding="utf-8")
    print(f"built article pages from Markdown: {len(list(CONTENT_DIR.glob('*.md')))}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
