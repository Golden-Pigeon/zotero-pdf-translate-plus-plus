import { config } from "../package.json";
import { registerPrompt } from "../src/modules/prompt";

describe("Independent plugin namespace", function () {
  it("registers and renders the namespaced panel and math textboxes", function () {
    const win = Zotero.getMainWindow();
    const registry = (win as unknown as Window).customElements;
    const panelTag = `${config.addonRef}-translator-panel`;
    const mathTag = `${config.addonRef}-math-textbox`;
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
