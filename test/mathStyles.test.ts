import { config } from "../package.json";
import { mathTag } from "../src/utils/elementNames";
import { renderMathInText } from "../src/utils/mathRenderer";
import {
  cleanupLegacyMathStyles,
  cleanupMathStyles,
  ensureMathStyles,
  MATH_ROOT_CLASS,
} from "../src/utils/mathStyles";

describe("Isolated math styles", function () {
  const HTML_NS = "http://www.w3.org/1999/xhtml";
  const stylesheetSelector = `#${config.addonRef}-math-styles`;
  let originalGet: typeof Zotero.Prefs.get;
  let enabled: boolean;
  let doc: Document;
  let host: HTMLDivElement;
  let hadMathStyles: boolean;

  function createHTML<K extends keyof HTMLElementTagNameMap>(tag: K) {
    return doc.createElementNS(HTML_NS, tag) as HTMLElementTagNameMap[K];
  }

  async function waitForStyles(link: HTMLLinkElement) {
    if (link.sheet) return;
    await new Promise<void>((resolve, reject) => {
      link.addEventListener("load", () => resolve(), { once: true });
      link.addEventListener(
        "error",
        () => reject(new Error("KaTeX stylesheet failed to load")),
        { once: true },
      );
    });
  }

  beforeEach(function () {
    let step = "installing the preference stub";
    try {
      originalGet = Zotero.Prefs.get;
      enabled = true;
      Zotero.Prefs.get = ((key: string, global?: boolean) =>
        key === `${config.prefsPrefix}.enableMathRendering`
          ? enabled
          : originalGet.call(Zotero.Prefs, key, global)) as typeof originalGet;
      step = "reading the main window document";
      doc = Zotero.getMainWindow().document;
      hadMathStyles = Boolean(doc.querySelector(stylesheetSelector));
      cleanupMathStyles(doc);
      step = "creating the HTML test host";
      host = createHTML("div");
      host.id = `${config.addonRef}-math-style-test-host`;
      host.style.cssText =
        "position: fixed; left: -10000px; width: 400px; height: 200px;";
      step = "attaching the HTML test host";
      doc.documentElement.appendChild(host);
    } catch (error) {
      throw new Error(
        `Math test fixture failed while ${step}: ${String(error)}`,
      );
    }
  });

  afterEach(function () {
    cleanupMathStyles(doc);
    host?.remove();
    Zotero.Prefs.get = originalGet;
    if (hadMathStyles) ensureMathStyles(doc);
  });

  it("does not load styles when formula rendering is disabled", function () {
    enabled = false;
    assert.isNull(ensureMathStyles(doc));
    assert.lengthOf(doc.querySelectorAll(stylesheetSelector), 0);

    const textbox = Zotero.getMainWindow().document.createXULElement(
      mathTag,
    ) as unknown as HTMLElement & {
      content: DocumentFragment;
      value: string;
      destroy: () => void;
    };
    try {
      assert.lengthOf(
        textbox.content.querySelectorAll('link[href$="/katex.min.css"]'),
        0,
      );
      host.append(textbox);
      textbox.value = "$x$";
      assert.lengthOf(doc.querySelectorAll(stylesheetSelector), 0);
      assert.isNull(textbox.querySelector(".katex"));
    } finally {
      textbox.destroy();
      textbox.remove();
    }
  });

  it("shares one stylesheet per document and removes only owned resources", function () {
    const foreign = createHTML("link");
    foreign.id = "another-plugin-math-styles";
    host.append(foreign);
    const first = ensureMathStyles(doc);
    assert.exists(first);
    assert.strictEqual(ensureMathStyles(doc), first);
    assert.lengthOf(doc.querySelectorAll(stylesheetSelector), 1);

    first!.remove();
    const replacement = ensureMathStyles(doc);
    assert.exists(replacement);
    assert.notStrictEqual(replacement, first);
    assert.lengthOf(doc.querySelectorAll(stylesheetSelector), 1);
    cleanupMathStyles(doc);
    assert.lengthOf(doc.querySelectorAll(stylesheetSelector), 0);
    assert.isTrue(foreign.isConnected);
    assert.exists(ensureMathStyles(doc));
  });

  it("styles its own rendered formulas without changing foreign KaTeX", async function () {
    const foreign = createHTML("div");
    foreign.innerHTML =
      '<span class="katex"><span class="base">x</span></span>';
    const own = createHTML("div");
    own.className = MATH_ROOT_CLASS;
    own.innerHTML = renderMathInText(doc, "A formula: $x^2 + 1$");
    host.append(foreign, own);
    const foreignMath = foreign.querySelector(".katex")!;
    const foreignBase = foreign.querySelector(".base")!;
    const ownMath = own.querySelector(".katex")!;
    const getStyle = (element: Element) =>
      doc.defaultView!.getComputedStyle(element)!;
    const before = {
      family: getStyle(foreignMath).fontFamily,
      size: getStyle(foreignMath).fontSize,
      display: getStyle(foreignBase).display,
    };
    const link = ensureMathStyles(doc)!;
    await waitForStyles(link);
    assert.deepEqual(
      {
        family: getStyle(foreignMath).fontFamily,
        size: getStyle(foreignMath).fontSize,
        display: getStyle(foreignBase).display,
      },
      before,
    );
    assert.include(
      getStyle(ownMath).fontFamily,
      `${config.addonRef}-KaTeX_Main`,
    );
    assert.equal(getStyle(own.querySelector(".base")!).display, "inline-block");
    assert.include(own.textContent, "A formula:");
    assert.exists(own.querySelector(".katex-mathml"));
    const fonts = Array.from((link.sheet as CSSStyleSheet).cssRules).filter(
      (rule) => rule.type === 5,
    ) as CSSFontFaceRule[];
    assert.isAbove(fonts.length, 0);
    for (const font of fonts) {
      assert.include(
        font.style.getPropertyValue("font-family"),
        `${config.addonRef}-KaTeX_`,
      );
    }
  });

  it("renders formulas in the connected main-window custom element", async function () {
    const textbox = Zotero.getMainWindow().document.createXULElement(
      mathTag,
    ) as unknown as HTMLElement & { value: string; destroy: () => void };
    host.append(textbox);
    try {
      assert.exists(textbox.querySelector("#inner-textbox"));
      textbox.value = "A formula: $x^2 + 1$";
      await new Promise<void>((resolve) => {
        doc.defaultView!.requestAnimationFrame(() => resolve());
      });
      const overlay = textbox.querySelector(`.${MATH_ROOT_CLASS}`);
      assert.exists(overlay);
      assert.exists(overlay!.querySelector(".katex"));
      assert.isTrue(textbox.hasAttribute("overlay-visible"));
      const link = doc.querySelector(stylesheetSelector) as HTMLLinkElement;
      assert.exists(link);
      await waitForStyles(link);
      assert.include(
        doc.defaultView!.getComputedStyle(overlay!.querySelector(".katex")!)!
          .fontFamily,
        `${config.addonRef}-KaTeX_Main`,
      );
      assert.strictEqual(ensureMathStyles(doc), link);
      assert.lengthOf(doc.querySelectorAll(stylesheetSelector), 1);
    } finally {
      textbox.destroy();
      textbox.remove();
    }
  });

  it("cleans styles from detached documents", function () {
    const detached = doc.implementation.createHTMLDocument("Detached reader");
    const link = ensureMathStyles(detached)!;
    assert.exists(link);
    assert.strictEqual(link.ownerDocument, detached);
    cleanupMathStyles(detached);
    assert.isNull(link.parentNode);
  });

  it("removes legacy owned styles while preserving foreign links", function () {
    const addLink = (id: string, href: string) => {
      const link = createHTML("link");
      link.id = id;
      link.href = href;
      link.rel = "stylesheet";
      host.append(link);
      return link;
    };
    const legacyID = `${config.addonRef}-popup-math-styles`;
    const ownedURL = `chrome://${config.addonRef}/content/styles/katex.min.css`;
    const legacy = addLink(legacyID, ownedURL);
    const upstream = addLink(
      "zoteropdftranslate-popup-math-styles",
      "chrome://zoteropdftranslate/content/styles/katex.min.css",
    );
    const foreignID = addLink("another-plugin-math-styles", ownedURL);
    const foreignURL = addLink(legacyID, "about:blank");
    cleanupLegacyMathStyles(doc);
    assert.isNull(legacy.parentNode);
    assert.isTrue(upstream.isConnected);
    assert.isTrue(foreignID.isConnected);
    assert.isTrue(foreignURL.isConnected);

    const secondLegacy = addLink(legacyID, ownedURL);
    enabled = false;
    assert.isNull(ensureMathStyles(doc));
    assert.isNull(secondLegacy.parentNode);
    assert.isTrue(upstream.isConnected);
    assert.isTrue(foreignID.isConnected);
    assert.isTrue(foreignURL.isConnected);
    assert.lengthOf(doc.querySelectorAll(stylesheetSelector), 0);
  });

  it("keeps a replacement instance's styles during late old-instance cleanup", function () {
    const plugins = Zotero as unknown as Record<string, unknown>;
    const originalPlugin = plugins[config.addonInstance];
    const previous = { data: { alive: true } };
    const current = { data: { alive: true } };
    const detached = doc.implementation.createHTMLDocument("Reader");
    try {
      plugins[config.addonInstance] = previous;
      const previousMainLink = ensureMathStyles(doc)!;
      const previousReaderLink = ensureMathStyles(detached)!;
      plugins[config.addonInstance] = current;
      const currentMainLink = ensureMathStyles(doc)!;
      const currentReaderLink = ensureMathStyles(detached)!;
      previous.data.alive = false;
      cleanupMathStyles(doc, previous);
      assert.isNull(previousMainLink.parentNode);
      assert.isTrue(currentMainLink.isConnected);
      assert.exists(previousReaderLink.parentNode);
      cleanupMathStyles(undefined, previous);
      assert.isNull(previousReaderLink.parentNode);
      assert.isTrue(currentMainLink.isConnected);
      assert.exists(currentReaderLink.parentNode);
      assert.strictEqual(ensureMathStyles(doc), currentMainLink);
      assert.strictEqual(ensureMathStyles(detached), currentReaderLink);
      assert.lengthOf(doc.querySelectorAll(stylesheetSelector), 1);
    } finally {
      cleanupMathStyles(undefined, previous);
      cleanupMathStyles(undefined, current);
      plugins[config.addonInstance] = originalPlugin;
    }
  });

  it("removes all owned styles after the plugin has stopped", function () {
    const plugins = Zotero as unknown as Record<string, unknown>;
    const originalPlugin = plugins[config.addonInstance];
    const owner = { data: { alive: true } };
    const detached = doc.implementation.createHTMLDocument("Closed reader");
    plugins[config.addonInstance] = owner;
    try {
      const readerLink = ensureMathStyles(doc)!;
      const detachedLink = ensureMathStyles(detached)!;
      assert.exists(readerLink);
      assert.exists(detachedLink);
      owner.data.alive = false;
      cleanupMathStyles();
      assert.isNull(readerLink.parentNode);
      assert.isNull(detachedLink.parentNode);
      assert.isNull(ensureMathStyles(doc));
    } finally {
      cleanupMathStyles();
      plugins[config.addonInstance] = originalPlugin;
    }
  });
});
