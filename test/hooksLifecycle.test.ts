import { config } from "../package.json";
import type Addon from "../src/addon";
import hooks from "../src/hooks";
import { cancelTranslationWork } from "../src/utils/lifecycle";
import type { TranslateTask } from "../src/utils/task";

describe("Plugin shutdown integration", function () {
  let owner: Addon;
  let originalOwner: unknown;
  let addonDescriptor: PropertyDescriptor | undefined;
  let toolkitDescriptor: PropertyDescriptor | undefined;
  let originalWindows: typeof Zotero.getMainWindows;
  let calls: number;
  let cleaned: number;
  let closed: boolean;

  beforeEach(function () {
    originalOwner = Reflect.get(Zotero, config.addonInstance);
    addonDescriptor = Object.getOwnPropertyDescriptor(globalThis, "addon");
    toolkitDescriptor = Object.getOwnPropertyDescriptor(globalThis, "ztoolkit");
    originalWindows = Zotero.getMainWindows;
    calls = 0;
    cleaned = 0;
    closed = false;
    owner = {
      data: {
        alive: true,
        translate: { batchTaskDelay: 0, refreshTick: "old", queue: [] },
        panel: {
          activePanels: {},
          windowPanel: {
            closed: false,
            close() {
              closed = true;
            },
          },
        },
        popup: { currentPopup: null },
      },
      hooks: { ...hooks },
    } as unknown as Addon;
    Reflect.set(Zotero, config.addonInstance, owner);
    Object.defineProperty(globalThis, "addon", {
      configurable: true,
      value: owner,
    });
    Object.defineProperty(globalThis, "ztoolkit", {
      configurable: true,
      value: {
        unregisterAll() {
          cleaned++;
        },
      },
    });
    Zotero.getMainWindows = () => [];
  });

  afterEach(function () {
    cancelTranslationWork(owner);
    Reflect.set(Zotero, config.addonInstance, originalOwner);
    Zotero.getMainWindows = originalWindows;
    for (const [key, descriptor] of [
      ["addon", addonDescriptor],
      ["ztoolkit", toolkitDescriptor],
    ] as const) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    }
  });

  const tasks = () => [{}, {}] as TranslateTask[];

  it("stops a batch after the pending task and closes owned UI", async function () {
    let finish!: () => void;
    const pending = new Promise<void>((resolve) => {
      finish = resolve;
    });
    owner.hooks.onTranslate = async () => {
      calls++;
      await pending;
    };
    const batch = hooks.onTranslateInBatch(tasks());
    assert.equal(calls, 1);
    hooks.onShutdown();
    finish();
    await batch;
    assert.equal(calls, 1);
    assert.isFalse(owner.data.alive);
    assert.equal(owner.data.translate.refreshTick, "");
    assert.isTrue(closed);
    assert.isNull(owner.data.panel.windowPanel);
    assert.equal(cleaned, 1);
    assert.isUndefined(Reflect.get(Zotero, config.addonInstance));
  });

  it("cancels the delay between batch tasks promptly", async function () {
    owner.data.translate.batchTaskDelay = 60000;
    owner.hooks.onTranslate = async () => {
      calls++;
    };
    const batch = hooks.onTranslateInBatch(tasks());
    await new Promise((resolve) => setTimeout(resolve, 0));
    hooks.onShutdown();
    await batch;
    assert.equal(calls, 1);
  });

  it("does not continue an old batch or delete its replacement", async function () {
    let finish!: () => void;
    const pending = new Promise<void>((resolve) => {
      finish = resolve;
    });
    owner.hooks.onTranslate = async () => {
      calls++;
      await pending;
    };
    const batch = hooks.onTranslateInBatch(tasks());
    const replacement = { data: { alive: true } };
    Reflect.set(Zotero, config.addonInstance, replacement);
    finish();
    await batch;
    hooks.onShutdown();
    assert.equal(calls, 1);
    assert.strictEqual(Reflect.get(Zotero, config.addonInstance), replacement);
    assert.isTrue(replacement.data.alive);
  });

  it("removes pending document listeners when startup is cancelled", async function () {
    const listeners = new Map<string, EventListener>();
    const win = {
      document: {
        readyState: "loading",
        addEventListener(type: string, listener: EventListener) {
          listeners.set(type, listener);
        },
        removeEventListener(type: string, listener: EventListener) {
          if (listeners.get(type) === listener) listeners.delete(type);
        },
      },
    } as unknown as Window;
    const startup = hooks.onMainWindowLoad(win);
    assert.isTrue(listeners.has("readystatechange"));
    hooks.onShutdown();
    await startup;
    assert.equal(listeners.size, 0);
  });

  it("ignores translation and UI entry points after shutdown", async function () {
    owner.data.translate.services = {
      runTranslationTask: async () => {
        calls++;
        return true;
      },
    } as unknown as Addon["data"]["translate"]["services"];
    hooks.onShutdown();
    await hooks.onTranslate(tasks()[0]);
    await hooks.onTranslateInBatch(tasks());
    hooks.onShortcuts("library");
    hooks.onReaderPopupRefresh();
    hooks.onReaderTabPanelRefresh();
    assert.equal(calls, 0);
  });
});
