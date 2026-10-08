import { config } from "../../package.json";
import { getPref } from "./prefs";
import { KATEX_SCOPED_CSS } from "./katexScopedCss.gen";

export const MATH_ROOT_CLASS = `${config.addonRef}-math-root`;
const MATH_STYLES_ID = `${config.addonRef}-math-styles`;
const MATH_STYLES_URL = `chrome://${config.addonRef}/content/styles/katex.min.css`;
const HTML_NS = "http://www.w3.org/1999/xhtml";

interface MathStyleRecord {
  style: HTMLStyleElement;
  dispose: () => void;
}

export interface MathStyleOwner {
  data: {
    alive: boolean;
    mathStyles?: Map<Document, MathStyleRecord>;
  };
}

function getOwner(): MathStyleOwner | undefined {
  return (Zotero as unknown as Record<string, MathStyleOwner>)[
    config.addonInstance
  ];
}

export function ensureMathStyles(doc: Document): HTMLStyleElement | null {
  cleanupLegacyMathStyles(doc);
  const owner = getOwner();
  if (!owner?.data.alive || getPref("enableMathRendering") !== true) {
    return null;
  }
  // The addon and custom elements are separate bundles, so share ownership on
  // the addon instance rather than keeping a module-local registry.
  const registry = (owner.data.mathStyles ??= new Map());
  const existing = registry.get(doc);
  if (existing?.style.isConnected) return existing.style;
  existing?.dispose();

  const parent = doc.head ?? doc.documentElement;
  if (!parent) return null;
  // Reader documents are served from resource://, which blocks chrome://
  // stylesheet links, so the scoped KaTeX CSS must be injected inline.
  const style = doc.createElementNS(HTML_NS, "style") as HTMLStyleElement;
  style.id = MATH_STYLES_ID;
  style.textContent = KATEX_SCOPED_CSS;
  const win = doc.defaultView;
  const dispose = () => {
    style.remove();
    win?.removeEventListener("unload", dispose);
    registry.delete(doc);
  };
  registry.set(doc, { style, dispose });
  win?.addEventListener("unload", dispose, { once: true });
  parent.appendChild(style);
  return style;
}

export function cleanupMathStyles(
  doc?: Document,
  owner: MathStyleOwner | undefined = getOwner(),
): void {
  const registry = owner?.data.mathStyles;
  if (!registry) return;
  if (doc) {
    registry.get(doc)?.dispose();
    return;
  }
  for (const entry of registry.values()) entry.dispose();
}

export function cleanupLegacyMathStyles(doc: Document): void {
  const links = Array.from(
    doc.querySelectorAll(
      `link[id="${config.addonRef}-popup-math-styles"], link[id="${MATH_STYLES_ID}"]`,
    ),
  ) as HTMLLinkElement[];
  for (const link of links) {
    if (link.rel === "stylesheet" && link.href === MATH_STYLES_URL) {
      link.remove();
    }
  }
}
