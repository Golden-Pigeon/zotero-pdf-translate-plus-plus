import { config } from "../package.json";
import { registerPrompt } from "../src/modules/prompt";
import {
  getCustomElementNames,
  mathTag,
  panelTag,
} from "../src/utils/elementNames";

describe("Independent plugin namespace", function () {
  it("registers and renders the namespaced panel and math textboxes", function () {
    const win = Zotero.getMainWindow();
    const registry = (win as unknown as Window).customElements;
    assert.isFunction(registry.get(panelTag));
    assert.isFunction(registry.get(mathTag));
    assert.notStrictEqual(
      registry.get(panelTag),
      registry.get("translator-plugin-panel"),
    );
    assert.notStrictEqual(registry.get(mathTag), registry.get("math-textbox"));

    const originalGet = Zotero.Prefs.get;
    Zotero.Prefs.get = ((key: string, global?: boolean) =>
      key === `${config.prefsPrefix}.enableMathRendering`
        ? true
        : originalGet.call(Zotero.Prefs, key, global)) as typeof originalGet;
    try {
      const panel = win.document.createXULElement(panelTag) as unknown as {
        content: DocumentFragment;
      };
      const content = panel.content;
      assert.lengthOf(content.querySelectorAll(mathTag), 2);
      assert.lengthOf(content.querySelectorAll("math-textbox"), 0);
    } finally {
      Zotero.Prefs.get = originalGet;
    }
  });

  it("uses distinct custom-element names for each release and prerelease", function () {
    const releases = ["2.4.9", "2.4.10", "2.4.10-beta.1", "2.4.10-beta-1"];
    const tags = releases.flatMap((release) =>
      Object.values(getCustomElementNames(release)),
    );
    assert.equal(new Set(tags).size, releases.length * 2);
    tags.forEach((tag) => {
      assert.match(tag, /^[a-z][a-z0-9-]+$/);
      assert.isTrue(tag.startsWith(`${config.addonRef}-`));
    });
  });

  it("reads the active service registry when a built component is reused", function () {
    type Panel = {
      readonly _addon: unknown;
      readonly content: DocumentFragment;
      connectedCallback(): void;
      _filterUnconfiguredServices(): void;
      _queryID(key: string): Element | null;
    };
    type Constructor = new () => Panel;
    const registered = new Map<string, Constructor>();
    const legacyConstructor = class {} as unknown as Constructor;
    registered.set(`${config.addonRef}-translator-panel`, legacyConstructor);
    const previousPanelTag = getCustomElementNames("2.4.9").panelTag;
    registered.set(previousPanelTag, legacyConstructor);
    const makePlugin = (serviceID: string) => ({
      data: {
        translate: {
          services: {
            getAllServicesWithType: () => [{ id: serviceID }],
            getServiceNameByID: () => serviceID,
            getUnconfiguredServiceIds: () => new Set([serviceID]),
          },
        },
      },
    });
    const firstPlugin = makePlugin("first-service");
    const secondPlugin = makePlugin("second-service");
    const fakeZotero = {
      [config.addonInstance]: firstPlugin,
      Prefs: { get: () => true },
      UIProperties: { registerRoot: () => {} },
    };
    const scope = {
      Zotero: fakeZotero,
      XULElementBase: class {
        connectedCallback() {}
      },
      MozXULElement: (Zotero.getMainWindow() as any).MozXULElement,
      customElements: {
        get: (tag: string) => registered.get(tag),
        define: (tag: string, constructor: Constructor) => {
          assert.isFalse(registered.has(tag));
          registered.set(tag, constructor);
        },
      },
    };
    const load = () =>
      Services.scriptloader.loadSubScript(
        `chrome://${config.addonRef}/content/scripts/customElements.js`,
        scope,
      );
    load();
    const firstConstructor = registered.get(panelTag)!;
    assert.isFunction(firstConstructor);
    assert.notStrictEqual(firstConstructor, legacyConstructor);
    assert.strictEqual(registered.get(previousPanelTag), legacyConstructor);
    const retainedPanel = new firstConstructor();
    retainedPanel.connectedCallback();
    assert.exists(
      retainedPanel.content.querySelector('menuitem[value="first-service"]'),
    );

    fakeZotero[config.addonInstance] = secondPlugin;
    load();
    assert.strictEqual(registered.get(panelTag), firstConstructor);
    assert.strictEqual(retainedPanel._addon, secondPlugin);
    for (const panel of [retainedPanel, new (registered.get(panelTag)!)()]) {
      const content = panel.content;
      assert.notExists(
        content.querySelector('menuitem[value="first-service"]'),
      );
      const serviceItem = content.querySelector(
        'menuitem[value="second-service"]',
      ) as HTMLElement;
      assert.exists(serviceItem);
      panel._queryID = (key) =>
        content.querySelector(`#${config.addonRef}-${key}`);
      panel._filterUnconfiguredServices();
      assert.isTrue(serviceItem.hidden);
    }
  });

  it("uses its own preferences and instance for the translation prompt", async function () {
    const addonDescriptor = Object.getOwnPropertyDescriptor(
      globalThis,
      "addon",
    );
    const toolkitDescriptor = Object.getOwnPropertyDescriptor(
      globalThis,
      "ztoolkit",
    );
    const originalGet = Zotero.Prefs.get;
    const stopBeforeRendering = new Error("Translation was invoked");
    const calls: string[] = [];
    let command:
      | Parameters<typeof ztoolkit.Prompt.register>[0][number]
      | undefined;
    const plugin = {
      data: { translate: { selectedText: "Selected text", queue: [] } },
      api: {
        translate: async (text: string) => {
          calls.push(text);
          throw stopBeforeRendering;
        },
      },
    };
    Object.defineProperty(globalThis, "addon", {
      configurable: true,
      value: plugin,
    });
    Object.defineProperty(globalThis, "ztoolkit", {
      configurable: true,
      value: {
        Prompt: {
          register: (
            commands: Parameters<typeof ztoolkit.Prompt.register>[0],
          ) => {
            command = commands[0];
          },
        },
      },
    });
    Zotero.Prefs.get = ((key: string, global?: boolean) => {
      assert.isTrue(global);
      if (key === `${config.prefsPrefix}.sourceLanguage`) return "en-US";
      if (key === `${config.prefsPrefix}.targetLanguage`) return "zh-CN";
      throw new Error(`Unexpected preference: ${key}`);
    }) as typeof originalGet;
    try {
      registerPrompt();
      assert.equal(command?.label, config.addonInstance);
      assert.isTrue(command?.when?.());
      plugin.data.translate.selectedText = "";
      assert.isFalse(command?.when?.());
      plugin.data.translate.selectedText = "Selected text";
      const callback = command!.callback;
      assert.isFunction(callback);
      if (typeof callback !== "function")
        throw new Error("Missing prompt callback");
      try {
        await callback({ showTip: () => {} } as unknown as Parameters<
          typeof callback
        >[0]);
        assert.fail("Expected the translation stub to stop rendering");
      } catch (error) {
        assert.strictEqual(error, stopBeforeRendering);
      }
      assert.deepEqual(calls, ["Selected text"]);
    } finally {
      Zotero.Prefs.get = originalGet;
      if (addonDescriptor) {
        Object.defineProperty(globalThis, "addon", addonDescriptor);
      } else {
        Reflect.deleteProperty(globalThis, "addon");
      }
      if (toolkitDescriptor) {
        Object.defineProperty(globalThis, "ztoolkit", toolkitDescriptor);
      } else {
        Reflect.deleteProperty(globalThis, "ztoolkit");
      }
    }
  });
});
