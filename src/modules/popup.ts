import { SVGIcon } from "../utils/config";
import { config } from "../../package.json";
import { getString } from "../utils/locale";
import { getPref, setPref } from "../utils/prefs";
import {
  addTranslateTask,
  getLastTranslateTask,
  TranslateTask,
} from "../utils/task";
import { slice } from "../utils/str";
import {
  getMathOverlayState,
  renderMathInText,
  shouldRenderMath,
} from "../utils/mathRenderer";
import { ensureMathStyles, MATH_ROOT_CLASS } from "../utils/mathStyles";
import {
  captureTranslationLifecycle,
  isTranslationActive,
} from "../utils/lifecycle";

const popupMathOverlayFrames = new WeakMap<HTMLDivElement, number>();
const popupTaskMaxWidths = new Map<string, number>();
// Must stay in sync with the textarea/container minWidth in buildReaderPopup.
const POPUP_MIN_TEXT_WIDTH = 184;

export function updateReaderPopup() {
  const popup = addon.data.popup.currentPopup;
  if (!popup) {
    return;
  }
  const enablePopup = getPref("enablePopup");
  const hidePopupTextarea = getPref("enableHidePopupTextarea") as boolean;
  Array.from(popup.querySelectorAll(`.${config.addonRef}-readerpopup`)).forEach(
    (elem) => ((elem as HTMLElement).hidden = !enablePopup),
  );

  const idPrefix = popup?.getAttribute(`${config.addonRef}-prefix`);
  const makeId = (type: string) => `${idPrefix}-${type}`;
  const audiobox = popup?.querySelector(
    `#${makeId("audiobox")}`,
  ) as HTMLDivElement;
  const translateButton = popup?.querySelector(
    `#${makeId("translate")}`,
  ) as HTMLDivElement;
  const textContainer = popup?.querySelector(
    `#${makeId("text-container")}`,
  ) as HTMLDivElement;
  const textarea = popup?.querySelector(
    `#${makeId("text")}`,
  ) as HTMLTextAreaElement;
  const mathOverlay = popup?.querySelector(
    `#${makeId("math-overlay")}`,
  ) as HTMLDivElement;
  const addToNoteButton = popup?.querySelector(
    `#${makeId("addtonote")}`,
  ) as HTMLDivElement;
  const statusBox = popup?.querySelector(
    `#${makeId("status")}`,
  ) as HTMLDivElement;

  const updateHidden = (elem: HTMLElement, hidden: boolean) => {
    if (hidden) {
      elem.style.display = "none";
    } else {
      elem.style.removeProperty("display");
    }
  };

  if (!enablePopup) {
    cancelPopupMathOverlayRender(mathOverlay);
    mathOverlay.innerHTML = "";
    updateHidden(audiobox, true);
    updateHidden(translateButton, true);
    updateHidden(textContainer, true);
    updateHidden(textarea, true);
    updateHidden(mathOverlay, true);
    updateHidden(addToNoteButton, true);
    if (statusBox) {
      stopPopupStatusTimer(statusBox);
      updateHidden(statusBox, true);
    }
    return;
  }
  updateHidden(audiobox, false);
  updateHidden(translateButton, false);
  updateHidden(textContainer, false);
  updateHidden(textarea, false);
  updateHidden(mathOverlay, false);
  updateHidden(addToNoteButton, false);
  const task = getLastTranslateTask({ type: "text" });
  if (!task) {
    if (statusBox) {
      stopPopupStatusTimer(statusBox);
      updateHidden(statusBox, true);
    }
    return;
  }
  popup.setAttribute("translate-task-id", task.id);

  if (task.audio.length > 0 && getPref("showPlayBtn")) {
    audiobox.innerHTML = "";
    updateHidden(audiobox, false);
    ztoolkit.UI.appendElement(
      {
        tag: "fragment",
        children: task.audio.map((audioData) => ({
          tag: "button",
          namespace: "html",
          classList: ["toolbar-button", "wide-button"],
          attributes: {
            tabindex: "-1",
            title: audioData.text,
          },
          properties: {
            innerHTML: `🔊 ${audioData.text}`,
            onclick: () => {
              new (ztoolkit.getGlobal("Audio"))(audioData.url).play();
            },
          },
          styles: { whiteSpace: "nowrap", flexGrow: "1" },
        })),
      },
      audiobox,
    );
  }

  if (task.audio.length > 0 && getPref("showPlayBtn") && getPref("autoPlay")) {
    const firstAudio = task.audio[0];
    const audio = new (ztoolkit.getGlobal("Audio"))(firstAudio.url);
    audio.play();
  }

  const hideTranslateButton = task.status !== "waiting";
  updateHidden(translateButton, hideTranslateButton);

  switch (task.langto?.split("-")[0]) {
    case "ar":
    case "fa":
    case "he":
      textarea.style.direction = "rtl";
      break;
    default:
      textarea.style.direction = "ltr";
  }

  textarea.hidden = hidePopupTextarea || !hideTranslateButton;
  textarea.value = task.result || task.raw;
  textarea.style.fontSize = `${getPref("fontSize")}px`;
  textarea.style.lineHeight = `${
    Number(getPref("lineHeight")) * Number(getPref("fontSize"))
  }px`;
  updatePopupSize(
    popup,
    textarea,
    getPopupWidthTrackingTaskId(task.id, task.result),
  );
  syncPopupTextContainer(textContainer, textarea);
  updatePopupMathOverlay(mathOverlay, textContainer, textarea);

  const enableAddToNote = getPref("enableNote") as boolean;
  if (
    !Zotero.getMainWindow().ZoteroContextPane.activeEditor ||
    !enableAddToNote
  ) {
    updateHidden(addToNoteButton, true);
  }

  if (statusBox) {
    updatePopupStatus(statusBox, task);
  }
}

export function buildReaderPopup(
  event: _ZoteroTypes.Reader.EventParams<"renderTextSelectionPopup">,
) {
  const lifecycle = captureTranslationLifecycle();
  const { reader, doc, append } = event;
  const annotation = event.params.annotation;
  const popup = doc.querySelector(".selection-popup") as HTMLDivElement;
  addon.data.popup.currentPopup = popup;
  popup.style.maxWidth = "none";
  popup.setAttribute(
    `${config.addonRef}-prefix`,
    `${config.addonRef}-${reader._instanceID}`,
  );

  const ZoteroContextPane = Zotero.getMainWindow().ZoteroContextPane;

  const colors = popup.querySelector(".colors") as HTMLDivElement;
  colors.style.width = "100%";
  colors.style.justifyContent = "space-evenly";

  const keepSize = getPref("keepPopupSize") as boolean;

  const makeId = (type: string) =>
    `${config.addonRef}-${reader._instanceID}-${type}`;
  const onTextAreaCopy = getOnTextAreaCopy(popup, makeId("text"));

  const hidePopupTextarea = getPref("enableHidePopupTextarea") as boolean;
  append(
    ztoolkit.UI.createElement(doc, "fragment", {
      children: [
        {
          tag: "div",
          id: makeId("audiobox"),
          classList: [`${config.addonRef}-readerpopup`],
          styles: {
            display: "flex",
            width: "calc(100% - 4px)",
            marginLeft: "2px",
            justifyContent: "space-evenly",
          },
          ignoreIfExists: true,
        },
        {
          tag: "button",
          namespace: "html",
          id: makeId("translate"),
          classList: [
            "toolbar-button",
            "wide-button",
            `${config.addonRef}-readerpopup`,
          ],
          properties: {
            innerHTML: `${SVGIcon}${getString("readerpopup-translate-label")}`,
            hidden: getPref("enableAuto"),
          },
          listeners: [
            {
              type: "click",
              listener: (ev: Event) => {
                addon.hooks.onTranslate({
                  noCheckZoteroItemLanguage: true,
                  noCache: true,
                });
                const button = ev.target as HTMLDivElement;
                button.hidden = true;
                (
                  button.ownerDocument.querySelector(
                    `#${makeId("text")}`,
                  ) as HTMLTextAreaElement
                ).hidden = hidePopupTextarea;
              },
            },
          ],
          ignoreIfExists: true,
        },
        {
          tag: "div",
          namespace: "html",
          id: makeId("status"),
          classList: [
            `${config.addonRef}-popup-status`,
            `${config.addonRef}-readerpopup`,
          ],
          // Populated by updatePopupStatus; hidden until there is something
          // to show so the waiting-state popup keeps its original height.
          styles: {
            display: "none",
          },
          ignoreIfExists: true,
        },
        {
          tag: "div",
          namespace: "html",
          id: makeId("text-container"),
          classList: [
            `${config.addonRef}-popup-text-container`,
            `${config.addonRef}-readerpopup`,
          ],
          styles: {
            position: "relative",
            width: keepSize ? `${getPref("popupWidth")}px` : "-moz-available",
            minWidth: "184px",
            height: `${Math.max(
              keepSize ? Number(getPref("popupHeight")) : 30,
            )}px`,
            marginInline: "2px",
          },
          children: [
            {
              tag: "textarea",
              id: makeId("text"),
              attributes: {
                rows: "3",
                columns: "10",
              },
              classList: [`${config.addonRef}-popup-textarea`],
              styles: {
                fontSize: `${getPref("fontSize")}px`,
                fontFamily: "inherit",
                lineHeight: `${
                  Number(getPref("lineHeight")) * Number(getPref("fontSize"))
                }px`,
                width: keepSize
                  ? `${getPref("popupWidth")}px`
                  : "-moz-available",
                // Minimum width to prevent the textarea from being smaller than the popup
                minWidth: "184px",
                height: `${Math.max(
                  keepSize ? Number(getPref("popupHeight")) : 30,
                )}px`,
                border: "none",
                background: "var(--color-sidepane)",
                borderRadius: "6px",
                padding: "5px",
              },
              properties: {
                onpointerup: (e: Event) => e.stopPropagation(),
                ondragstart: (e: Event) => e.stopPropagation(),
                spellcheck: false,
                value: addon.data.translate.selectedText,
              },
              ignoreIfExists: true,
              listeners: [
                {
                  type: "mousedown",
                  listener: (_ev) => {
                    _ev.target?.addEventListener(
                      "mousemove",
                      onTextAreaResize as (ev: Event) => void,
                    );
                  },
                },
                {
                  type: "mouseup",
                  listener: (_ev) => {
                    onTextAreaResize(_ev as MouseEvent);
                    _ev.target?.removeEventListener(
                      "mousemove",
                      onTextAreaResize as (ev: Event) => void,
                    );
                  },
                },
                {
                  type: "keydown",
                  listener: onTextAreaCopy as (ev: Event) => void,
                },
                {
                  type: "dblclick",
                  listener: (_ev) => {
                    const textarea = popup.querySelector(
                      `#${makeId("text")}`,
                    ) as HTMLTextAreaElement;
                    textarea.selectionStart = 0;
                    textarea.selectionEnd = textarea.value.length;
                    const text = textarea.value.slice(
                      textarea.selectionStart,
                      textarea.selectionEnd,
                    );
                    new ztoolkit.Clipboard().addText(text, "text/plain").copy();
                    new ztoolkit.ProgressWindow("Copied to Clipboard")
                      .createLine({
                        text: slice(text, 50),
                        progress: 100,
                        type: "default",
                      })
                      .show();
                  },
                },
              ],
            },
            {
              tag: "div",
              namespace: "html",
              id: makeId("math-overlay"),
              classList: [
                `${config.addonRef}-popup-math-overlay`,
                MATH_ROOT_CLASS,
              ],
              styles: {
                display: "none",
                position: "absolute",
                inset: "0",
                boxSizing: "border-box",
                fontSize: `${getPref("fontSize")}px`,
                fontFamily: "inherit",
                lineHeight: `${
                  Number(getPref("lineHeight")) * Number(getPref("fontSize"))
                }px`,
                border: "none",
                background: "var(--color-sidepane)",
                borderRadius: "6px",
                padding: "5px",
                overflow: "auto",
                textAlign: "start",
              },
              properties: {
                onpointerup: (e: Event) => e.stopPropagation(),
                ondragstart: (e: Event) => e.stopPropagation(),
              },
              listeners: [
                {
                  type: "click",
                  listener: () => {
                    const overlay = popup.querySelector(
                      `#${makeId("math-overlay")}`,
                    ) as HTMLDivElement;
                    const textarea = popup.querySelector(
                      `#${makeId("text")}`,
                    ) as HTMLTextAreaElement;
                    cancelPopupMathOverlayRender(overlay);
                    overlay.style.display = "none";
                    textarea.style.removeProperty("visibility");
                    textarea.focus();
                  },
                },
              ],
              ignoreIfExists: true,
            },
          ],
          ignoreIfExists: true,
        },
        {
          tag: "button",
          namespace: "html",
          id: makeId("addtonote"),
          classList: [
            "toolbar-button",
            "wide-button",
            `${config.addonRef}-readerpopup`,
          ],
          styles: {
            marginTop: "8px",
          },
          properties: {
            innerHTML: `${SVGIcon}${getString("readerpopup-addToNote-label")}`,
          },
          ignoreIfExists: true,
          listeners: [
            {
              type: "click",
              listener: async (ev) => {
                if (!isTranslationActive(lifecycle)) return;
                const noteEditor =
                  ZoteroContextPane && ZoteroContextPane.activeEditor;
                if (!noteEditor) {
                  return;
                }
                const editorInstance = noteEditor.getCurrentInstance();
                if (!editorInstance) {
                  return;
                }
                const task = addTranslateTask(
                  addon.data.translate.selectedText,
                  reader.itemID,
                  "addtonote",
                );
                if (!task) {
                  return;
                }
                await lifecycle.owner.hooks.onTranslate(task, {
                  noCheckZoteroItemLanguage: true,
                  noDisplay: true,
                });
                if (
                  !isTranslationActive(lifecycle) ||
                  task.status !== "success"
                ) {
                  return;
                }
                const replaceMode = getPref("enableNoteReplaceMode") as boolean;
                if (replaceMode) {
                  annotation.text = task.result;
                } else {
                  annotation.comment = task.result;
                }
                // @ts-ignore should be fixed in the zotero-types
                reader._addToNote([annotation]);
              },
            },
          ],
        },
      ],
    }),
  );
}

function onTextAreaResize(ev: MouseEvent) {
  if (getPref("keepPopupSize")) {
    const textarea = ev.target as HTMLTextAreaElement;
    setPref("popupWidth", textarea.offsetWidth);
    setPref("popupHeight", textarea.offsetHeight);
    const container = textarea.closest(
      `.${config.addonRef}-popup-text-container`,
    ) as HTMLDivElement | null;
    if (container) {
      syncPopupTextContainer(container, textarea);
    }
  }
}

function getOnTextAreaCopy(selectionMenu: HTMLElement, targetId: string) {
  return (ev: KeyboardEvent) => {
    const textarea = selectionMenu.querySelector(
      `#${targetId}`,
    ) as HTMLTextAreaElement;
    const isMod = ev.ctrlKey || ev.metaKey;
    if (ev.key === "c" && isMod) {
      ztoolkit.getGlobal("setTimeout")(() => {
        new ztoolkit.Clipboard()
          .addText(
            textarea.value.slice(
              textarea.selectionStart,
              textarea.selectionEnd,
            ),
            "text/plain",
          )
          .copy();
      }, 10);
      ev.stopPropagation();
    } else if (ev.key === "a" && isMod) {
      textarea.selectionStart = 0;
      textarea.selectionEnd = textarea.value.length;
      ev.stopPropagation();
    } else if (ev.key === "x" && isMod) {
      new ztoolkit.Clipboard()
        .addText(
          textarea.value.slice(textarea.selectionStart, textarea.selectionEnd),
          "text/plain",
        )
        .copy();
      textarea.value = `${textarea.value.slice(
        0,
        textarea.selectionStart,
      )}${textarea.value.slice(textarea.selectionEnd)}`;
      ev.stopPropagation();
    }
  };
}

function updatePopupSize(
  selectionMenu: HTMLDivElement,
  textarea: HTMLTextAreaElement,
  taskId?: string,
  resetSize: boolean = true,
): void {
  const keepSize = getPref("keepPopupSize") as boolean;
  if (keepSize) {
    return;
  }
  if (resetSize) {
    // Start every measurement from the same fixed width. Resetting to
    // `-moz-available` made the measurement depend on the width the previous
    // cycle happened to leave behind, and the aspect-ratio test then flipped
    // between two stable states on alternate refreshes (visible flicker).
    textarea.style.width = `${POPUP_MIN_TEXT_WIDTH}px`;
    textarea.style.height = "30px";
  }
  const viewer = selectionMenu.ownerDocument.body;
  // Get current H & W
  const textHeight = textarea.scrollHeight;
  const textWidth = textarea.scrollWidth;
  const newWidth = textWidth + 20;
  // Check until H/W<0.75 and don't overflow viewer border
  if (
    textHeight / textWidth > 0.75 &&
    selectionMenu.offsetLeft + newWidth < viewer.offsetWidth
  ) {
    // Update width
    textarea.style.width = `${newWidth}px`;
    updatePopupSize(selectionMenu, textarea, taskId, false);
    return;
  }
  if (taskId) {
    textarea.style.width = `${getTaskScopedPopupWidth(
      taskId,
      textarea.offsetWidth,
    )}px`;
  }
  // Update height
  textarea.style.height = `${textHeight + 3}px`;
}

function getTaskScopedPopupWidth(taskId: string, width: number): number {
  const previousWidth = popupTaskMaxWidths.get(taskId) ?? 0;
  const nextWidth = Math.max(previousWidth, width);
  popupTaskMaxWidths.set(taskId, nextWidth);
  return nextWidth;
}

function getPopupWidthTrackingTaskId(
  taskId: string,
  result: string,
): string | undefined {
  const trimmedResult = result.trim();
  if (!trimmedResult || trimmedResult === getString("status-translating")) {
    return undefined;
  }
  return taskId;
}

function syncPopupTextContainer(
  container: HTMLDivElement,
  textarea: HTMLTextAreaElement,
): void {
  container.hidden = textarea.hidden;
  container.style.width = textarea.style.width;
  container.style.height = textarea.style.height;
}

function updatePopupMathOverlay(
  overlay: HTMLDivElement,
  container: HTMLDivElement,
  textarea: HTMLTextAreaElement,
): void {
  const enabled = (getPref("enableMathRendering") as boolean) === true;
  const state = getMathOverlayState({
    text: textarea.value,
    enabled,
    hiddenByPreference: container.hidden,
  });
  if (
    state.overlayDisplay === "none" ||
    !ensureMathStyles(overlay.ownerDocument)
  ) {
    cancelPopupMathOverlayRender(overlay);
    overlay.innerHTML = "";
    overlay.style.display = "none";
    textarea.style.removeProperty("visibility");
    return;
  }

  overlay.style.fontSize = textarea.style.fontSize;
  overlay.style.lineHeight = textarea.style.lineHeight;
  overlay.style.direction = textarea.style.direction;
  overlay.style.display = state.overlayDisplay;
  textarea.style.visibility = state.textareaVisibility;
  schedulePopupMathOverlayRender(overlay, container, textarea);
}

function schedulePopupMathOverlayRender(
  overlay: HTMLDivElement,
  container: HTMLDivElement,
  textarea: HTMLTextAreaElement,
): void {
  if (popupMathOverlayFrames.has(overlay)) {
    return;
  }
  const lifecycle = captureTranslationLifecycle();
  const render = () => {
    popupMathOverlayFrames.delete(overlay);
    if (!isTranslationActive(lifecycle)) return;
    if (
      !overlay.isConnected ||
      container.hidden ||
      !shouldRenderMath(
        textarea.value,
        getPref("enableMathRendering") === true,
      ) ||
      !ensureMathStyles(overlay.ownerDocument)
    ) {
      overlay.innerHTML = "";
      overlay.style.display = "none";
      textarea.style.removeProperty("visibility");
      return;
    }
    overlay.innerHTML = renderMathInText(overlay.ownerDocument, textarea.value);
    syncPopupRenderedTextContainer(container, textarea, overlay);
    // KaTeX fonts load asynchronously; the first measurement can run on
    // fallback-font metrics and under/over-report the formula width. Re-sync
    // once the document fonts settle.
    overlay.ownerDocument.fonts?.ready
      .then(() => {
        if (
          overlay.isConnected &&
          !container.hidden &&
          isTranslationActive(lifecycle)
        ) {
          syncPopupRenderedTextContainer(container, textarea, overlay);
        }
      })
      .catch(() => {});
  };
  const win = overlay.ownerDocument.defaultView;
  if (win?.requestAnimationFrame) {
    popupMathOverlayFrames.set(overlay, win.requestAnimationFrame(render));
    return;
  }
  render();
}

function syncPopupRenderedTextContainer(
  container: HTMLDivElement,
  textarea: HTMLTextAreaElement,
  overlay: HTMLDivElement,
): void {
  if (getPref("keepPopupSize")) {
    return;
  }
  const width = container.clientWidth || textarea.offsetWidth;
  if (!width) {
    return;
  }

  // The overlay already holds the live rendered content behind
  // `overflow: auto`, so its scroll width reports exactly how much room the
  // math needs — including the equation-number slot, which per-formula
  // scroll containers would swallow.
  const neededWidth = Math.ceil(overlay.scrollWidth);
  const targetWidth = Math.min(
    neededWidth,
    widenPopupForMath(container, neededWidth, width),
  );
  const finalWidth = Math.max(width, targetWidth);
  if (targetWidth > width) {
    container.style.width = `${finalWidth}px`;
    textarea.style.width = `${finalWidth}px`;
  }

  // The live overlay cannot report the content height: it is stretched to
  // the container's current height (`inset: 0`) and scrollHeight never
  // reports less than clientHeight, so a container left tall by the raw
  // LaTeX text would keep a blank strip under the rendered math. Measure
  // the height on an offscreen auto-height clone at the final width.
  const measurement = overlay.cloneNode(false) as HTMLDivElement;
  measurement.removeAttribute("id");
  measurement.innerHTML = overlay.innerHTML;
  measurement.style.position = "absolute";
  measurement.style.inset = "auto";
  measurement.style.left = "-100000px";
  measurement.style.top = "0";
  measurement.style.visibility = "hidden";
  measurement.style.pointerEvents = "none";
  measurement.style.width = `${finalWidth}px`;
  measurement.style.height = "auto";
  measurement.style.maxHeight = "none";
  measurement.style.overflow = "hidden";
  overlay.ownerDocument.body.appendChild(measurement);
  const renderedHeight = Math.max(30, Math.ceil(measurement.scrollHeight) + 2);
  measurement.remove();

  const height = `${renderedHeight}px`;
  container.style.height = height;
  textarea.style.height = height;
}

/**
 * How much horizontal room the rendered math can get inside the viewer.
 * When the popup's current position leaves too little room to the right,
 * the popup itself is shifted left (up to the viewer's left edge) so even
 * wide formulas fit without scrolling. The shift is applied through an
 * accumulated negative margin so it works no matter how Zotero positions
 * the selection popup (Zotero 7 does not use a pixel `style.left`).
 */
function widenPopupForMath(
  container: HTMLDivElement,
  neededWidth: number,
  currentWidth: number,
): number {
  const selectionMenu = container.closest(
    ".selection-popup",
  ) as HTMLElement | null;
  const viewer = selectionMenu?.ownerDocument.body;
  if (!selectionMenu || !viewer) {
    return currentWidth;
  }
  const margin = 12;
  // Zotero's own popup CSS can clamp the width; the reader popup is allowed
  // to span the whole viewer while math is rendered.
  selectionMenu.style.maxWidth = "none";
  const viewerRect = viewer.getBoundingClientRect();
  const popupRect = selectionMenu.getBoundingClientRect();
  let available = viewerRect.right - popupRect.left - margin;
  const leftInset = popupRect.left - viewerRect.left;
  if (neededWidth > available && leftInset > 1) {
    const shift = Math.min(leftInset, neededWidth - available);
    // Zotero 7 positions the selection popup without a pixel `style.left`,
    // so the shift is applied through margins, which move the box visually
    // regardless of how it was positioned. Accumulate across repeated syncs
    // by reading the computed margin first.
    const win = selectionMenu.ownerDocument.defaultView!;
    const computedStyle = win.getComputedStyle(selectionMenu);
    const currentMargin = parseFloat(computedStyle?.marginLeft ?? "0") || 0;
    selectionMenu.style.marginLeft = `${currentMargin - shift}px`;
    available += shift;
  }
  return Math.max(currentWidth, available);
}

function cancelPopupMathOverlayRender(overlay: HTMLDivElement): void {
  const frame = popupMathOverlayFrames.get(overlay);
  if (typeof frame === "undefined") {
    return;
  }
  overlay.ownerDocument.defaultView?.cancelAnimationFrame?.(frame);
  popupMathOverlayFrames.delete(overlay);
}

// ---- Translation status row (prefill / decode / token usage) ----

const popupStatusTimers = new WeakMap<HTMLDivElement, number>();

function ensurePopupStatusStyles(doc: Document): void {
  const css = buildPopupStatusStylesCss();
  const styleId = `${config.addonRef}-popup-status-styles`;
  const parent = doc.head ?? doc.documentElement;
  if (!parent) {
    return;
  }
  // Reader documents outlive plugin reloads (dev hot-reload) and upgrades, so
  // an older revision of this stylesheet may still be in the document. Match
  // on content and replace it whenever it no longer matches.
  const existing = doc.getElementById(styleId) as HTMLStyleElement | null;
  if (existing) {
    if (existing.textContent === css) {
      return;
    }
    existing.remove();
  }
  const style = doc.createElement("style");
  style.id = styleId;
  style.textContent = css;
  parent.appendChild(style);
}

function buildPopupStatusStylesCss(): string {
  const c = `${config.addonRef}-popup-status`;
  return `
.${c} { display: flex; align-items: center; justify-content: flex-start;
  gap: 6px; margin: 0 6px 2px; padding: 0 3px; min-height: 20px;
  font-size: 11.5px; color: var(--fill-secondary);
  font-variant-numeric: tabular-nums; white-space: nowrap; }
.${c} .stage { display: inline-flex; align-items: center; gap: 6px; min-width: 0; }
.${c} .stats { display: inline-flex; align-items: center; gap: 7px; }
.${c} .svc { opacity: 0.75; }
.${c} .sep { opacity: 0.45; }
.${c} .ok { color: var(--accent-green, #33a457); font-weight: 600; }
.${c} .err { color: var(--accent-red, #d5252a); font-weight: 600; }
.${c} .dots { display: inline-flex; gap: 3px; }
.${c} .dots i { width: 4px; height: 4px; border-radius: 50%;
  background: currentColor; opacity: 0.25;
  animation: ${config.addonRef}-dotpulse 1.1s ease-in-out infinite; }
.${c} .dots i:nth-child(2) { animation-delay: 0.18s; }
.${c} .dots i:nth-child(3) { animation-delay: 0.36s; }
.${c} .dots.fast i { animation-duration: 0.7s; }
@keyframes ${config.addonRef}-dotpulse {
  0%, 70%, 100% { opacity: 0.25; transform: scale(0.8); }
  35% { opacity: 1; transform: scale(1); }
}`;
}

function formatSeconds(ms: number): string {
  return `${(Math.max(ms, 0) / 1000).toFixed(1)}s`;
}

/**
 * Service display name for the status row. Unlike
 * `getServiceNameByID`, this omits the configuration-status emoji
 * (🗝️/📍), which is meaningful in settings lists but noise here.
 */
function getStatusServiceName(serviceId: string): string {
  return (
    (getPref(`renameServices.${serviceId}`) as string) ||
    getString(`service-${serviceId}`)
  );
}

function updatePopupStatus(
  statusBox: HTMLDivElement,
  task: TranslateTask,
): void {
  // The pref defaults to true; treat an unset value as enabled so the row
  // shows even before default prefs are applied.
  if (getPref("enablePopupStatus") === false) {
    stopPopupStatusTimer(statusBox);
    statusBox.replaceChildren();
    statusBox.dataset.statusMode = "hidden";
    statusBox.style.display = "none";
    return;
  }
  ensurePopupStatusStyles(statusBox.ownerDocument);
  const doc = statusBox.ownerDocument;

  const progress = task.progress;
  const now = Date.now();

  // The row is refreshed every ~200ms (timer) and on every stream chunk.
  // Rebuilding its DOM on each tick would restart the dot animation from
  // its first frame, so the structure is rebuilt only when the display
  // mode changes; per-tick values are patched into [data-dyn] spans.
  const dynamicText: Record<string, string> = {};
  type StagePart =
    | { kind: "dots"; fast: boolean }
    | { kind: "text"; text: string; cls?: string };
  type StatsPart = { text: string; cls?: string; dyn?: string };
  const stageParts: StagePart[] = [];
  const statsParts: StatsPart[] = [];
  let mode: string;
  let visible = true;

  switch (task.status) {
    case "processing": {
      const decoding = progress?.firstTokenAt !== undefined;
      mode = `processing-${decoding ? "decode" : "prefill"}${
        progress ? "" : "-empty"
      }`;
      stageParts.push({ kind: "dots", fast: decoding });
      stageParts.push({
        kind: "text",
        text: getString(decoding ? "status-decode" : "status-prefill"),
      });
      if (progress) {
        const elapsed = formatSeconds(now - progress.startAt);
        if (decoding) {
          const tokens = progress.outputTokens ?? progress.streamedChunks ?? 0;
          const decodeMs = Math.max(now - (progress.firstTokenAt ?? now), 100);
          dynamicText.tok = `${tokens} tok`;
          dynamicText.tps = `${Math.round(tokens / (decodeMs / 1000))} tok/s`;
          dynamicText.elapsed = elapsed;
          statsParts.push(
            { text: "", dyn: "tok" },
            { text: "·", cls: "sep" },
            { text: "", dyn: "tps" },
            { text: "·", cls: "sep" },
            { text: "", dyn: "elapsed" },
          );
        } else {
          dynamicText.elapsed = elapsed;
          statsParts.push({ text: "", dyn: "elapsed" });
        }
      }
      break;
    }
    case "success": {
      if (!progress) {
        // No progress info (e.g. cache hit); nothing to report.
        visible = false;
        mode = "hidden";
        break;
      }
      mode = `success-${task.service}-${progress.inputTokens ?? "x"}-${
        progress.outputTokens ?? "x"
      }`;
      stageParts.push({ kind: "text", text: "✓", cls: "ok" });
      if (task.service) {
        stageParts.push({
          kind: "text",
          text: getStatusServiceName(task.service),
          cls: "svc",
        });
      }
      const elapsed = formatSeconds((progress.endAt ?? now) - progress.startAt);
      if (
        typeof progress.inputTokens === "number" ||
        typeof progress.outputTokens === "number"
      ) {
        statsParts.push({
          text: `↑ ${progress.inputTokens ?? "?"} ↓ ${progress.outputTokens ?? "?"}`,
        });
        statsParts.push({ text: "·", cls: "sep" });
      }
      statsParts.push({ text: elapsed });
      break;
    }
    case "fail": {
      mode = "fail";
      stageParts.push({ kind: "text", text: "✗", cls: "err" });
      stageParts.push({ kind: "text", text: getString("status-fail") });
      if (progress) {
        statsParts.push({
          text: formatSeconds((progress.endAt ?? now) - progress.startAt),
        });
      }
      break;
    }
    default: {
      visible = false;
      mode = "hidden";
      break;
    }
  }

  if (!visible) {
    statusBox.replaceChildren();
    statusBox.dataset.statusMode = mode;
    statusBox.style.display = "none";
    ensurePopupStatusTimer(statusBox, task);
    return;
  }

  if (statusBox.dataset.statusMode !== mode) {
    statusBox.replaceChildren();
    const stage = doc.createElement("span");
    stage.className = "stage";
    for (const part of stageParts) {
      if (part.kind === "dots") {
        const dots = doc.createElement("span");
        dots.className = part.fast ? "dots fast" : "dots";
        for (let i = 0; i < 3; i++) {
          dots.appendChild(doc.createElement("i"));
        }
        stage.appendChild(dots);
      } else {
        const span = doc.createElement("span");
        if (part.cls) {
          span.className = part.cls;
        }
        span.textContent = part.text;
        stage.appendChild(span);
      }
    }
    const stats = doc.createElement("span");
    stats.className = "stats";
    for (const part of statsParts) {
      const span = doc.createElement("span");
      if (part.cls) {
        span.className = part.cls;
      }
      if (part.dyn) {
        span.dataset.dyn = part.dyn;
      }
      span.textContent = part.text;
      stats.appendChild(span);
    }
    statusBox.appendChild(stage);
    if (statsParts.length > 0) {
      const sep = doc.createElement("span");
      sep.className = "sep";
      sep.textContent = "·";
      statusBox.appendChild(sep);
    }
    statusBox.appendChild(stats);
    statusBox.dataset.statusMode = mode;
  }

  // Patch per-tick values without touching the animated dots.
  statusBox.querySelectorAll("[data-dyn]").forEach((span) => {
    const key = (span as HTMLElement).dataset.dyn!;
    if (dynamicText[key] !== undefined) {
      span.textContent = dynamicText[key];
    }
  });

  statusBox.style.removeProperty("display");
  ensurePopupStatusTimer(statusBox, task);
}

/**
 * Drive the elapsed-time display while the task is processing. Prefill has no
 * stream chunks to trigger refreshes, so a lightweight interval updates only
 * the status row (never the whole popup, which would re-measure its size).
 */
function ensurePopupStatusTimer(
  statusBox: HTMLDivElement,
  task: TranslateTask,
): void {
  const win = statusBox.ownerDocument.defaultView;
  if (!win) {
    return;
  }
  const running = popupStatusTimers.get(statusBox);
  if (task.status !== "processing") {
    if (running !== undefined) {
      win.clearInterval(running);
      popupStatusTimers.delete(statusBox);
    }
    return;
  }
  if (running !== undefined) {
    return;
  }
  const timer = win.setInterval(() => {
    if (!statusBox.isConnected || task.status !== "processing") {
      stopPopupStatusTimer(statusBox);
      if (statusBox.isConnected && task.status !== "processing") {
        updatePopupStatus(statusBox, task);
      }
      return;
    }
    updatePopupStatus(statusBox, task);
  }, 200);
  popupStatusTimers.set(statusBox, timer);
}

function stopPopupStatusTimer(statusBox: HTMLDivElement): void {
  const timer = popupStatusTimers.get(statusBox);
  if (timer === undefined) {
    return;
  }
  statusBox.ownerDocument.defaultView?.clearInterval(timer);
  popupStatusTimers.delete(statusBox);
}
