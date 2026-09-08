import { TranslatorPanel } from "../elements/panel";
import { MathTextboxElement } from "../elements/mathTextbox";
import { mathTag, panelTag } from "../utils/elementNames";

const elements = {
  [panelTag]: TranslatorPanel,
  [mathTag]: MathTextboxElement,
} as unknown as Record<string, CustomElementConstructor>;

for (const [key, constructor] of Object.entries(elements)) {
  if (!customElements.get(key)) {
    customElements.define(key, constructor);
  }
}
