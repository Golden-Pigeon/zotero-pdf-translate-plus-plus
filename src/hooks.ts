import { config } from "../package.json";
import { initLocale } from "./utils/locale";
import {
  registerPrefsScripts,
  registerPrefsWindow,
} from "./modules/preferenceWindow";
import {
  registerReaderTabPanel,
  updateReaderTabPanels,
} from "./modules/tabpanel";
import { buildReaderPopup, updateReaderPopup } from "./modules/popup";
import { registerNotify } from "./modules/notify";
import { registerReaderInitializer } from "./modules/reader";
import { getPref } from "./utils/prefs";
import {
  addTranslateAnnotationTask,
  addTranslateTask,
  addTranslateTitleTask,
  getLastTranslateTask,
  TranslateTask,
} from "./utils/task";
import { setDefaultPrefSettings } from "./modules/defaultPrefs";
import Addon from "./addon";
import { registerMenu } from "./modules/menu";
import { registerExtraColumns } from "./modules/itemTree";
import { registerShortcuts } from "./modules/shortcuts";
import { registerItemPaneInfoRows } from "./modules/infoBox";
import { registerPrompt } from "./modules/prompt";
import { registerCustomFields } from "./modules/fields";
import {
  cancelTranslationWork,
  captureTranslationLifecycle,
  isTranslationActive,
  runWhileTranslationActive,
  translationDelay,
} from "./utils/lifecycle";
import { cleanupLegacyMathStyles, cleanupMathStyles } from "./utils/mathStyles";

const windowFocusListeners = new Map<Window, EventListener>();

function isOwnInstanceActive() {
  return isTranslationActive(captureTranslationLifecycle(addon));
}

function cleanupLegacyReaderStyles() {
  const visited = new Set<Document>();
  const visit = (doc?: Document | null) => {
    if (!doc || visited.has(doc)) return;
    visited.add(doc);
    cleanupLegacyMathStyles(doc);
    for (const frame of doc.querySelectorAll("iframe")) {
      try {
        visit((frame as HTMLIFrameElement).contentDocument);
      } catch {
        // Reader frames may disappear while tabs navigate or close.
      }
    }
  };
  for (const reader of Zotero.Reader._readers) {
    try {
      visit(reader._iframeWindow?.document);
    } catch {
      // An opening reader will be cleaned when its math styles are requested.
    }
  }
}

async function onStartup() {
  await Promise.all([
    Zotero.initializationPromise,
    Zotero.unlockPromise,
    Zotero.uiReadyPromise,
  ]);

  if (!isOwnInstanceActive()) return;

  cleanupLegacyReaderStyles();

  // TODO: Remove this after zotero#3387 is merged
  if (__env__ === "development") {
    // Keep in sync with the scripts/startup.mjs
    const loadDevToolWhen = `Plugin ${config.addonID} startup`;
    ztoolkit.log(loadDevToolWhen);
  }

  initLocale();

  setDefaultPrefSettings();

  registerCustomFields();

  registerReaderInitializer();

  registerShortcuts();

  registerNotify(["item"]);

  registerPrefsWindow();

  registerExtraColumns();

  registerItemPaneInfoRows();

  registerReaderTabPanel();

  await Promise.all(
    Zotero.getMainWindows().map((win) => onMainWindowLoad(win)),
  );
}

async function onMainWindowLoad(win: Window): Promise<void> {
  const lifecycle = captureTranslationLifecycle(addon);
  if (!isTranslationActive(lifecycle)) return;
  let onReady: EventListener | undefined;
  try {
    if (win.document.readyState !== "complete") {
      await runWhileTranslationActive(
        lifecycle,
        () =>
          new Promise<void>((resolve) => {
            onReady = () => {
              if (win.document.readyState === "complete") resolve();
            };
            win.document.addEventListener("readystatechange", onReady);
          }),
      );
    }
    await runWhileTranslationActive(lifecycle, () =>
      Promise.all([
        Zotero.initializationPromise,
        Zotero.unlockPromise,
        Zotero.uiReadyPromise,
      ]),
    );
  } catch (error) {
    if (!isTranslationActive(lifecycle)) return;
    throw error;
  } finally {
    if (onReady) win.document.removeEventListener("readystatechange", onReady);
  }

  if (!isTranslationActive(lifecycle)) return;
  cleanupLegacyMathStyles(win.document);

  Services.scriptloader.loadSubScript(
    `chrome://${config.addonRef}/content/scripts/customElements.js`,
    win,
  );

  (win as any).MozXULElement.insertFTLIfNeeded(
    `${config.addonRef}-mainWindow.ftl`,
  );

  registerMenu();
  registerPrompt();

  const previousListener = windowFocusListeners.get(win);
  if (previousListener)
    win.document.removeEventListener("focusout", previousListener);
  const onFocusOut: EventListener = (ev) => {
    if (!isTranslationActive(lifecycle) || ev.target !== win.document) {
      return;
    }
    lifecycle.owner.data.translate.concatKey = false;
  };
  windowFocusListeners.set(win, onFocusOut);
  win.document.addEventListener("focusout", onFocusOut);
}

async function onMainWindowUnload(win: Window): Promise<void> {
  const listener = windowFocusListeners.get(win);
  if (listener) win.document.removeEventListener("focusout", listener);
  windowFocusListeners.delete(win);
  cleanupMathStyles(win.document, addon);
  win.document
    .querySelector(`[href="${config.addonRef}-mainWindow.ftl"]`)
    ?.remove();
}

function onShutdown(): void {
  cancelTranslationWork(addon);
  cleanupMathStyles(undefined, addon);
  ztoolkit.unregisterAll();
  const windows = new Set([
    ...Zotero.getMainWindows(),
    ...windowFocusListeners.keys(),
  ]);
  for (const win of windows) {
    void onMainWindowUnload(win).catch((error) => Zotero.logError(error));
  }
  const standalone = addon.data.panel.windowPanel;
  addon.data.panel.windowPanel = null;
  if (standalone && !standalone.closed) standalone.close();
  addon.data.panel.activePanels = {};
  addon.data.popup.currentPopup = null;
  if (Reflect.get(Zotero, config.addonInstance) === addon) {
    Reflect.deleteProperty(Zotero, config.addonInstance);
  }
}

/**
 * This function is just an example of dispatcher for Notify events.
 * Any operations should be placed in a function to keep this function clear.
 */
function onNotify(
  event: string,
  type: string,
  ids: Array<string | number>,
  extraData: { [key: string]: any },
) {
  if (!isOwnInstanceActive()) return;
  if (event === "add" && type === "item") {
    if (
      !getPref("enableAnnotationFromSyncTranslation") &&
      extraData?.skipAutoSync
    )
      return;
    const annotationItems = Zotero.Items.get(ids as number[]).filter((item) =>
      item.isAnnotation(),
    );
    if (annotationItems.length === 0) {
      return;
    }
    if (getPref("enableComment")) {
      addon.hooks.onTranslateInBatch(
        annotationItems
          .map((item) => addTranslateAnnotationTask(item.id))
          .filter((task) => task) as TranslateTask[],
        { noDisplay: true },
      );
    }
  } else if (type === "tab" && ["select", "add", "close"].includes(event)) {
    addon.data.translate.concatKey = false;
  } else {
    return;
  }
}

function onPrefsLoad(event: Event) {
  if (!isOwnInstanceActive()) return;
  registerPrefsScripts((event.target as any).ownerGlobal);
}

function onShortcuts(type: string) {
  if (!isOwnInstanceActive()) return;
  switch (type) {
    case "library":
      {
        addon.hooks.onTranslateInBatch(
          Zotero.getActiveZoteroPane()
            .getSelectedItems(true)
            .map((id) => addTranslateTitleTask(id, true))
            .filter((task) => task) as TranslateTask[],
          { noDisplay: true, noCache: true },
        );
      }
      break;
    case "reader":
      {
        addon.hooks.onTranslate(undefined, {
          noCheckZoteroItemLanguage: true,
          noCache: true,
        });
      }
      break;
    default:
      break;
  }
}

async function onTranslate(): Promise<void>;
async function onTranslate(
  options: Parameters<
    Addon["data"]["translate"]["services"]["runTranslationTask"]
  >["1"],
): Promise<void>;
async function onTranslate(
  task: TranslateTask | undefined,
  options?: Parameters<
    Addon["data"]["translate"]["services"]["runTranslationTask"]
  >["1"],
): Promise<void>;
async function onTranslate(...data: any) {
  const lifecycle = captureTranslationLifecycle(addon);
  if (!isTranslationActive(lifecycle)) return;
  let task = undefined;
  let options = {};
  if (data.length === 1) {
    if (data[0]?.raw) {
      task = data[0];
    } else {
      options = data[0];
    }
  } else if (data.length === 2) {
    task = data[0];
    options = data[1];
  }
  await lifecycle.owner.data.translate.services.runTranslationTask(
    task,
    options,
  );
}

async function onTranslateInBatch(
  tasks: TranslateTask[],
  options: Parameters<
    Addon["data"]["translate"]["services"]["runTranslationTask"]
  >["1"] = {},
) {
  const lifecycle = captureTranslationLifecycle(addon);
  if (!isTranslationActive(lifecycle)) return;
  for (const task of tasks) {
    if (!isTranslationActive(lifecycle)) return;
    await lifecycle.owner.hooks.onTranslate(task, options);
    if (!isTranslationActive(lifecycle)) return;
    try {
      await translationDelay(
        lifecycle.owner.data.translate.batchTaskDelay,
        lifecycle,
      );
    } catch (error) {
      if (!isTranslationActive(lifecycle)) return;
      throw error;
    }
  }
}

function onReaderPopupShow(
  event: _ZoteroTypes.Reader.EventParams<"renderTextSelectionPopup">,
) {
  if (!isOwnInstanceActive()) return;
  const selection = addon.data.translate.selectedText;
  const task = getLastTranslateTask();
  if (task?.raw === selection) {
    buildReaderPopup(event);
    addon.hooks.onReaderPopupRefresh();
    return;
  }
  addTranslateTask(selection, event.reader.itemID);
  buildReaderPopup(event);
  addon.hooks.onReaderPopupRefresh();
  if (getPref("enableAuto")) {
    addon.hooks.onTranslate();
  }
}

function onReaderPopupRefresh() {
  if (!isOwnInstanceActive()) return;
  updateReaderPopup();
}

function onReaderTabPanelRefresh() {
  if (!isOwnInstanceActive()) return;
  updateReaderTabPanels();
}

// Add your hooks here. For element click, etc.
// Keep in mind hooks only do dispatch. Don't add code that does real jobs in hooks.
// Otherwise the code would be hard to read and maintain.

export default {
  onStartup,
  onMainWindowLoad,
  onMainWindowUnload,
  onShutdown,
  onNotify,
  onPrefsLoad,
  onShortcuts,
  onTranslate,
  onTranslateInBatch,
  onReaderPopupShow,
  onReaderPopupRefresh,
  onReaderTabPanelRefresh,
};
