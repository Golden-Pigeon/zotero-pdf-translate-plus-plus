import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import postcss from "postcss";
import selectorParser from "postcss-selector-parser";
import valueParser from "postcss-value-parser";
import { scopeKatexCss } from "./scope-katex.mjs";

const namespace = "zoteropdftranslateplusplus";
const original = readFileSync(
  new URL("../addon/chrome/content/styles/katex.min.css", import.meta.url),
  "utf8",
);

test("scopes every KaTeX selector, including selector lists", () => {
  const source = postcss.parse(original);
  const scoped = postcss.parse(scopeKatexCss(original, namespace));
  let count = 0;
  scoped.walkRules((rule) => {
    selectorParser((selectors) => {
      selectors.each((selector) => {
        assert.equal(selector.first.type, "class");
        assert.equal(selector.first.value, `${namespace}-math-root`);
        assert.equal(selector.nodes[1].type, "combinator");
        assert.equal(selector.nodes[1].value, " ");
        selector.first.remove();
        selector.first.remove();
        count++;
      });
    }).processSync(rule.selector);
  });
  assert.ok(count > 100, "the full bundled stylesheet was checked");
  const originalSelectors = [];
  const scopedSelectors = [];
  source.walkRules((rule) => originalSelectors.push(rule.selector));
  scoped.walkRules((rule) => scopedSelectors.push(rule.selector));
  assert.equal(scopedSelectors.length, originalSelectors.length);
});

test("isolates every font reference while retaining font asset URLs", () => {
  const originalRoot = postcss.parse(original);
  const scoped = postcss.parse(scopeKatexCss(original, namespace));
  const originalSources = [];
  const scopedSources = [];
  originalRoot.walkDecls("src", (declaration) =>
    originalSources.push(declaration.value),
  );
  scoped.walkDecls("src", (declaration) =>
    scopedSources.push(declaration.value),
  );
  assert.deepEqual(scopedSources, originalSources);
  let references = 0;
  scoped.walkDecls((declaration) => {
    if (!["font", "font-family"].includes(declaration.prop)) return;
    valueParser(declaration.value).walk((node) => {
      if (node.type !== "word" && node.type !== "string") return;
      assert.ok(!node.value.startsWith("KaTeX_"), node.value);
      if (node.value.startsWith(`${namespace}-KaTeX_`)) references++;
    });
  });
  assert.ok(references > 30);
});

test("preserves quoted values, fallback fonts and nested selectors", () => {
  const scoped = scopeKatexCss(
    `@font-face { font-family: "KaTeX_Main"; src: url(fonts/KaTeX_Main.woff2) }
     @media print { .katex:is(.a, .b), .katex-display {
       font: italic 12px "KaTeX_Main", serif;
       font-family: KaTeX_Script, "Times New Roman", serif;
       content: "KaTeX_Main";
     } }`,
    namespace,
  );
  assert.ok(scoped.includes(`font-family: "${namespace}-KaTeX_Main"`));
  assert.ok(scoped.includes(`italic 12px "${namespace}-KaTeX_Main", serif`));
  assert.ok(
    scoped.includes(`${namespace}-KaTeX_Script, "Times New Roman", serif`),
  );
  assert.ok(scoped.includes('content: "KaTeX_Main"'));
  const root = postcss.parse(scoped);
  root.walkRules((rule) => {
    assert.equal(
      rule.selector.trim(),
      `.${namespace}-math-root .katex:is(.a, .b), .${namespace}-math-root .katex-display`,
    );
  });
});
