(function () {
  function configurePrism() {
    if (!window.Prism) {
      return;
    }

    if (window.Prism.plugins && window.Prism.plugins.autoloader) {
      window.Prism.plugins.autoloader.languages_path = "https://cdn.jsdelivr.net/npm/prismjs@1.29.0/components/";
    }

    document.body.setAttribute("data-prismjs-copy", "复制");
    document.body.setAttribute("data-prismjs-copy-success", "已复制");
    document.body.setAttribute("data-prismjs-copy-error", "复制失败");
    document.body.setAttribute("data-prismjs-copy-timeout", "1600");
  }

  function highlightCode() {
    if (!window.Prism) {
      return;
    }

    configurePrism();
    document.querySelectorAll(".code-block pre[class*='language-'] code").forEach(function (code) {
      window.Prism.highlightElement(code);
    });
  }

  function getMermaidSource(block) {
    var template = block.querySelector("template[data-mermaid-source]");
    if (template) {
      return template.content.textContent || "";
    }

    var legacy = block.querySelector(".mermaid");
    return legacy ? legacy.textContent || "" : "";
  }

  function setMermaidFailure(block) {
    var target = block.querySelector(".mermaid-render") || block;
    target.removeAttribute("aria-busy");
    target.textContent = "图表渲染失败";
    block.classList.add("mermaid-failed");
  }

  function renderMermaid() {
    var blocks = Array.prototype.slice.call(document.querySelectorAll("[data-mermaid-block]"));
    if (!blocks.length) {
      return;
    }

    if (!window.mermaid) {
      blocks.forEach(setMermaidFailure);
      return;
    }

    window.mermaid.initialize({
      startOnLoad: false,
      securityLevel: "strict",
      theme: "base",
      themeVariables: {
        background: "#fbfbf5",
        mainBkg: "#fbfbf5",
        primaryColor: "#f4f0e4",
        primaryTextColor: "#23342e",
        primaryBorderColor: "#9aa89f",
        lineColor: "#4f665d",
        secondaryColor: "#e8f0ea",
        tertiaryColor: "#f7f5ef",
        fontFamily: "-apple-system, BlinkMacSystemFont, Segoe UI, PingFang SC, Microsoft YaHei, Arial, sans-serif"
      }
    });

    blocks.forEach(function (block, index) {
      var source = getMermaidSource(block).trim();
      var target = block.querySelector(".mermaid-render");
      if (!source || !target) {
        setMermaidFailure(block);
        return;
      }

      window.mermaid.render("mermaid-diagram-" + index + "-" + Date.now(), source).then(function (result) {
        target.innerHTML = result.svg;
        target.removeAttribute("aria-busy");
        block.classList.add("mermaid-rendered");
        if (typeof result.bindFunctions === "function") {
          result.bindFunctions(target);
        }
      }).catch(function (error) {
        console.error("Mermaid render failed", error);
        setMermaidFailure(block);
      });
    });
  }

  function initArticleRendering() {
    highlightCode();
    renderMermaid();
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", initArticleRendering);
  } else {
    initArticleRendering();
  }
}());
