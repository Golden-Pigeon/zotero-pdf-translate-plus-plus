import assert from "node:assert/strict";
import { cpSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import postcss from "postcss";
import selectorParser from "postcss-selector-parser";
import valueParser from "postcss-value-parser";
import {
  katexDisplayOverflowOverrides,
  scopeKatexCss,
  writeScopedKatexStyles,
} from "./scope-katex.mjs";

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

test("display math overrides size to content and only scroll when needed", () => {
  const root = `.${namespace}-math-root`;
  const rules = [];
  postcss.parse(katexDisplayOverflowOverrides(namespace)).walkRules((rule) => {
    rules.push(rule);
  });
  assert.equal(rules.length, 4);

  assert.equal(rules[0].selector, `${root} .katex-display`);
  assert.ok(
    rules[0].nodes.some(
      (decl) => decl.prop === "overflow-x" && decl.value === "auto",
    ),
  );
  assert.ok(
    rules[0].nodes.some(
      (decl) => decl.prop === "overflow-y" && decl.value === "hidden",
    ),
  );
  // Panning stays possible but no scrollbar is rendered.
  assert.ok(
    rules[0].nodes.some(
      (decl) => decl.prop === "scrollbar-width" && decl.value === "none",
    ),
  );

  assert.equal(rules[1].selector, `${root} .katex-display > .katex`);
  assert.ok(
    rules[1].nodes.some(
      (decl) => decl.prop === "width" && decl.value === "max-content",
    ),
  );
  // Full-width block for fitting formulas keeps the \tag number pinned to
  // the container's right edge instead of hugging the formula.
  assert.ok(
    rules[1].nodes.some(
      (decl) => decl.prop === "min-width" && decl.value === "100%",
    ),
  );

  // The \tag number gets its own slot so it never overlaps the formula.
  assert.equal(
    rules[2].selector,
    `${root} .katex-display > .katex > .katex-html`,
  );
  assert.ok(
    rules[2].nodes.some((decl) => decl.prop === "padding-right"),
  );

  assert.equal(
    rules[3].selector,
    `${root}.${namespace}-math-measure .katex-display`,
  );
  assert.ok(
    rules[3].nodes.some(
      (decl) => decl.prop === "overflow" && decl.value === "visible",
    ),
  );

  // The overrides must stay out of scopeKatexCss, whose output contract is a
  // 1:1 mapping of the source stylesheet's selectors.
  assert.ok(!scopeKatexCss(original, namespace).includes("math-measure"));
});

test("writeScopedKatexStyles appends the overrides after the scoped CSS", () => {
  const addonDir = mkdtempSync(join(tmpdir(), "scope-katex-"));
  try {
    cpSync(
      new URL("../addon/chrome/content/styles", import.meta.url),
      join(addonDir, "chrome/content/styles"),
      { recursive: true },
    );
    writeScopedKatexStyles(addonDir, namespace);
    const written = readFileSync(
      join(addonDir, "chrome/content/styles/katex.min.css"),
      "utf8",
    );
    assert.ok(written.startsWith(scopeKatexCss(original, namespace)));
    assert.ok(written.endsWith(katexDisplayOverflowOverrides(namespace)));
  } finally {
    rmSync(addonDir, { recursive: true, force: true });
  }
});
