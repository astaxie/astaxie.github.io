from __future__ import annotations

import argparse
import json
import re
import sys
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
CONTENT_DIR = ROOT / "content" / "articles"
ARTICLES_JS = ROOT / "js" / "articles.js"
HAN_RE = re.compile(r"[\u4e00-\u9fff]")
ARTICLE_RENDERING_SCRIPT = "/js/article-rendering.js"


def parse_articles_js() -> dict[str, dict]:
    text = ARTICLES_JS.read_text(encoding="utf-8")
    match = re.search(r"window\.ASTAXIE_ARTICLES\s*=\s*(\[.*?\]);", text, re.S)
    if not match:
        raise ValueError("Cannot find window.ASTAXIE_ARTICLES in js/articles.js")
    articles = json.loads(match.group(1))
    return {article["slug"]: article for article in articles}


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


def count_han(body: str) -> int:
    return len(HAN_RE.findall(body))


def fenced_code_languages(body: str) -> list[str]:
    languages: list[str] = []
    in_code = False
    for line in body.splitlines():
        stripped = line.strip()
        if not stripped.startswith("```"):
            continue
        if in_code:
            in_code = False
            continue
        language = stripped[3:].strip().split(maxsplit=1)[0].lower() or "text"
        languages.append(language)
        in_code = True
    return languages


def has_markdown_table(body: str) -> bool:
    lines = body.splitlines()
    for index, line in enumerate(lines[:-1]):
        if "|" not in line:
            continue
        if re.fullmatch(r"\s*\|?[\s:-]+\|[\s|:-]+\s*", lines[index + 1]):
            return True
    return False


def check_one(path: Path, expected: dict | None, min_han: int) -> list[str]:
    errors: list[str] = []
    text = path.read_text(encoding="utf-8")
    meta, body = split_front_matter(text)
    slug = path.stem
    if meta.get("slug") != slug:
        errors.append(f"{path}: front matter slug must be {slug!r}")
    if expected:
        for key in [
            "url",
            "title",
            "summary",
            "categoryKey",
            "category",
            "categoryLabel",
            "source",
            "date",
            "image",
        ]:
            if str(meta.get(key, "")) != str(expected.get(key, "")):
                errors.append(f"{path}: {key} mismatch")
        if list(meta.get("tags", [])) != list(expected.get("tags", [])):
            errors.append(f"{path}: tags mismatch")
    han = count_han(body)
    if han < min_han:
        errors.append(f"{path}: body has {han} Han chars, expected >= {min_han}")
    image = str(meta.get("image", ""))
    if image and f"![标题图]({image})" not in body:
        errors.append(f"{path}: missing title image reference {image}")
    for section in [
        "## 问题背景",
        "## 核心概念",
        "## 架构/流程图解说明",
        "## 工程实现",
        "## 测试评测",
        "## 失败模式",
        "## 上线 checklist",
        "## 总结",
    ]:
        if section not in body:
            errors.append(f"{path}: missing section {section}")

    languages = fenced_code_languages(body)
    if expected and languages:
        rendered_path = ROOT / str(expected.get("url", "")).strip("/") / "index.html"
        if rendered_path.exists():
            rendered = rendered_path.read_text(encoding="utf-8")
            if ARTICLE_RENDERING_SCRIPT not in rendered:
                errors.append(f"{rendered_path}: missing article rendering script")
            if "mermaid" in languages and "/js/vendor/mermaid.min.js" not in rendered:
                errors.append(f"{rendered_path}: mermaid page is missing the local Mermaid renderer")
            if "mermaid" in languages:
                if 'data-mermaid-block' not in rendered:
                    errors.append(f"{rendered_path}: mermaid fence was not rendered as a diagram container")
                if 'data-mermaid-source' not in rendered or 'class="mermaid-render"' not in rendered:
                    errors.append(f"{rendered_path}: mermaid fence is missing source/template render targets")
                if "language-mermaid" in rendered:
                    errors.append(f"{rendered_path}: mermaid fence is still rendered as a code block")
                if 'class="code-block"><pre class="line-numbers language-mermaid"' in rendered:
                    errors.append(f"{rendered_path}: mermaid fence is still using the code block renderer")
            if any(language != "mermaid" for language in languages) and 'class="code-block"' not in rendered:
                errors.append(f"{rendered_path}: fenced code was not rendered as a code block container")
            if any(language != "mermaid" for language in languages) and "prism-copy-to-clipboard" not in rendered:
                errors.append(f"{rendered_path}: fenced code page is missing the Prism copy plugin")
            if any(language != "mermaid" for language in languages) and "line-numbers language-" not in rendered:
                errors.append(f"{rendered_path}: fenced code block is missing Prism block classes")
    if expected and has_markdown_table(body):
        rendered_path = ROOT / str(expected.get("url", "")).strip("/") / "index.html"
        if rendered_path.exists():
            rendered = rendered_path.read_text(encoding="utf-8")
            if 'class="article-table-wrap"' not in rendered or 'class="article-data-table"' not in rendered:
                errors.append(f"{rendered_path}: markdown table was not rendered as an article table")
    return errors


def main() -> int:
    parser = argparse.ArgumentParser(description="Validate AI-authored Markdown articles.")
    parser.add_argument("--min-han", type=int, default=5000)
    parser.add_argument("--require-all", action="store_true")
    parser.add_argument("slugs", nargs="*", help="Optional slugs or markdown paths to validate.")
    args = parser.parse_args()

    expected = parse_articles_js()
    if args.slugs:
        paths = []
        for item in args.slugs:
            path = Path(item)
            if path.suffix != ".md":
                path = CONTENT_DIR / f"{item}.md"
            if not path.is_absolute():
                path = ROOT / path
            paths.append(path)
    else:
        paths = sorted(CONTENT_DIR.glob("*.md"))
    errors: list[str] = []

    if args.require_all and len(paths) != len(expected):
        errors.append(f"expected {len(expected)} markdown files, found {len(paths)}")

    for slug in expected:
        path = CONTENT_DIR / f"{slug}.md"
        if args.require_all and not path.exists():
            errors.append(f"missing {path}")

    for path in paths:
        if not path.exists():
            errors.append(f"missing {path}")
            continue
        errors.extend(check_one(path, expected.get(path.stem), args.min_han))

    if errors:
        for error in errors:
            print(error, file=sys.stderr)
        return 1

    print(f"ok: {len(paths)} markdown files pass validation")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
