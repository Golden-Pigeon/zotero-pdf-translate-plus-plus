import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import postcss from "postcss";
import selectorParser from "postcss-selector-parser";
import valueParser from "postcss-value-parser";

export function scopeKatexCss(css, namespace) {
  const root = postcss.parse(css);
  const fontFamilies = new Map();

  root.walkAtRules("font-face", (rule) => {
    rule.walkDecls("font-family", (declaration) => {
      const nodes = valueParser(declaration.value).nodes.filter(
        (node) => node.type !== "space" && node.type !== "comment",
      );
      if (nodes.length !== 1 || !["word", "string"].includes(nodes[0].type)) {
        throw new Error(`Unsupported KaTeX font family: ${declaration.value}`);
      }
      const family = nodes[0].value;
      fontFamilies.set(family, `${namespace}-${family}`);
    });
  });

  root.walkRules((rule) => {
    rule.selector = selectorParser((selectors) => {
      selectors.each((selector) => {
        const scope = selectorParser.className({
          value: `${namespace}-math-root`,
        });
        scope.spaces.before = selector.first.spaces.before;
        selector.first.spaces.before = "";
        selector.prepend(selectorParser.combinator({ value: " " }));
        selector.prepend(scope);
      });
    }).processSync(rule.selector);
  });

  root.walkDecls((declaration) => {
    if (!["font-family", "font"].includes(declaration.prop)) return;
    const value = valueParser(declaration.value);
    value.walk((node) => {
      if (node.type === "function") return false;
      if (node.type !== "word" && node.type !== "string") return;
      const family =
        fontFamilies.get(node.value) ??
        (node.value.startsWith("KaTeX_")
          ? `${namespace}-${node.value}`
          : undefined);
      if (family) node.value = family;
    });
    declaration.value = value.toString();
  });

  return root.toString();
}

export function writeScopedKatexStyles(addonDir, namespace) {
  const path = join(addonDir, "chrome/content/styles/katex.min.css");
  writeFileSync(path, scopeKatexCss(readFileSync(path, "utf8"), namespace));
}
