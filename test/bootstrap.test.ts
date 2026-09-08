import { config } from "../package.json";

describe("Independent plugin startup guard", function () {
  const legacyID = "zoteropdftranslate@euclpts.com";
  const startupData = {
    id: config.addonID,
    version: "2.4.9",
    rootURI: "resource://translate-plus-plus-test/",
  };
  let bootstrapURI: string;

  before(async function () {
    const { AddonManager } = ChromeUtils.importESModule(
      "resource://gre/modules/AddonManager.sys.mjs",
    );
    const installed = await AddonManager.getAddonByID(config.addonID);
    assert.exists(installed);
    bootstrapURI = installed!.getResourceURI("bootstrap.js").spec;
  });

  function createHarness(
    legacy: Record<string, unknown> | null,
    legacyLookup?: () => Promise<Record<string, unknown> | null>,
    initializationPromise = Promise.resolve(),
  ) {
    const calls = {
      lookups: [] as string[],
      listeners: [] as any[],
      removed: [] as any[],
      chrome: [] as any[],
      scripts: [] as string[],
      notices: [] as string[],
      errors: [] as unknown[],
      shutdowns: 0,
      ownDisables: 0,
      oldDisables: 0,
      chromeDestructions: 0,
      bundleFlushes: 0,
    };
    const oldPlugin = legacy && {
      id: legacyID,
      userDisabled: false,
      appDisabled: false,
      disable: () => {
        calls.oldDisables++;
        return Promise.resolve();
      },
      ...legacy,
    };
    const fakeZotero: any = {
      initializationPromise,
      uiReadyPromise: Promise.resolve(),
      getMainWindow: () => null,
      alert: (_window: unknown, _title: string, message: string) => {
        calls.notices.push(message);
      },
      logError: (error: unknown) => calls.errors.push(error),
    };
    const addonManager = {
      getAddonByID: (id: string) => {
        calls.lookups.push(id);
        if (id === legacyID)
          return legacyLookup ? legacyLookup() : Promise.resolve(oldPlugin);
        assert.equal(id, config.addonID);
        return Promise.resolve({
          disable: () => {
            calls.ownDisables++;
            return Promise.resolve();
          },
        });
      },
      addAddonListener: (listener: any) => calls.listeners.push(listener),
      removeAddonListener: (listener: any) => {
        calls.removed.push(listener);
        calls.listeners.splice(calls.listeners.indexOf(listener), 1);
      },
    };
    const scope: any = {
      Zotero: fakeZotero,
      APP_SHUTDOWN: 2,
      ChromeUtils: {
        importESModule: (uri: string) => {
          assert.equal(uri, "resource://gre/modules/AddonManager.sys.mjs");
          return { AddonManager: addonManager };
        },
      },
      Components: {
        interfaces: {},
        classes: {
          "@mozilla.org/addons/addon-manager-startup;1": {
            getService: () => ({
              registerChrome: (...args: any[]) => {
                calls.chrome.push(args);
                return {
                  destruct: () => calls.chromeDestructions++,
                };
              },
            }),
          },
        },
      },
      Services: {
        io: { newURI: (spec: string) => ({ spec }) },
        scriptloader: {
          loadSubScript: (uri: string) => {
            calls.scripts.push(uri);
            fakeZotero[config.addonInstance] = {
              hooks: { onShutdown: () => calls.shutdowns++ },
            };
          },
        },
      },
      Cc: {
        "@mozilla.org/intl/stringbundle;1": {
          getService: () => ({ flushBundles: () => calls.bundleFlushes++ }),
        },
      },
    };
    // Load the installed bootstrap with isolated services; its main script is mocked.
    Services.scriptloader.loadSubScript(bootstrapURI, scope);
    return {
      calls,
      oldPlugin,
      start: () => scope.startup(startupData, 1),
      stop: (reason = 1) => scope.shutdown(startupData, reason),
    };
  }

  it("blocks an enabled original plugin before loading any plugin code", async function () {
    const harness = createHarness({});
    await harness.start();
    const listener = harness.calls.listeners[0];
    listener.onEnabled(harness.oldPlugin);
    listener.onInstalled(harness.oldPlugin);
    await Promise.resolve();

    assert.isEmpty(harness.calls.chrome);
    assert.isEmpty(harness.calls.scripts);
    assert.lengthOf(harness.calls.notices, 1);
    assert.equal(harness.calls.ownDisables, 0);
    assert.equal(harness.calls.oldDisables, 0);
    harness.stop();
    assert.isEmpty(harness.calls.listeners);
    assert.deepEqual(harness.calls.removed, [listener]);
    assert.equal(harness.calls.shutdowns, 0);
  });

  for (const [description, legacy] of [
    ["disabled", { userDisabled: true }],
    ["incompatible", { appDisabled: true }],
    ["absent", null],
  ] as const) {
    it(`loads when the original plugin is ${description}`, async function () {
      const harness = createHarness(legacy);
      await harness.start();

      assert.lengthOf(harness.calls.chrome, 1);
      assert.lengthOf(harness.calls.scripts, 1);
      assert.include(
        harness.calls.scripts[0],
        `/chrome/content/scripts/${config.addonRef}.js`,
      );
      assert.isEmpty(harness.calls.notices);
      const listener = harness.calls.listeners[0];
      harness.stop();
      assert.deepEqual(harness.calls.removed, [listener]);
      assert.isEmpty(harness.calls.listeners);
      assert.equal(harness.calls.shutdowns, 1);
      assert.equal(harness.calls.chromeDestructions, 1);
    });
  }

  for (const event of ["onEnabling", "onEnabled", "onInstalled"]) {
    it(`stops and disables only itself on ${event} for the original plugin`, async function () {
      const harness = createHarness({ userDisabled: true });
      await harness.start();
      const listener = harness.calls.listeners[0];
      const enabled = { ...harness.oldPlugin, userDisabled: false };
      listener[event](enabled);
      listener.onEnabled(enabled);
      await Promise.resolve();
      await Promise.resolve();

      assert.equal(harness.calls.shutdowns, 1);
      assert.equal(harness.calls.ownDisables, 1);
      assert.equal(harness.calls.oldDisables, 0);
      assert.lengthOf(harness.calls.notices, 1);
      assert.isEmpty(harness.calls.errors);
      harness.stop();
      assert.isEmpty(harness.calls.listeners);
      assert.equal(harness.calls.chromeDestructions, 1);
    });
  }

  it("ignores unrelated, disabled, or incompatible plugin events", async function () {
    const harness = createHarness(null);
    await harness.start();
    const listener = harness.calls.listeners[0];
    for (const plugin of [
      { id: "unrelated@example.invalid" },
      { id: legacyID, userDisabled: true },
      { id: legacyID, appDisabled: true },
    ]) {
      listener.onEnabled(plugin);
      listener.onInstalled(plugin);
    }
    await Promise.resolve();
    assert.equal(harness.calls.shutdowns, 0);
    assert.equal(harness.calls.ownDisables, 0);
    assert.isEmpty(harness.calls.notices);
    harness.stop();
  });

  it("removes its listener during application shutdown", async function () {
    const harness = createHarness(null);
    await harness.start();
    const listener = harness.calls.listeners[0];
    harness.stop(2);

    assert.isEmpty(harness.calls.listeners);
    assert.deepEqual(harness.calls.removed, [listener]);
    listener.onEnabled({ id: legacyID });
    await Promise.resolve();
    assert.equal(harness.calls.ownDisables, 0);
    assert.isEmpty(harness.calls.notices);
  });

  it("cannot resume startup after shutdown during the original plugin lookup", async function () {
    let resolveLegacy!: (value: null) => void;
    const pendingLegacy = new Promise<null>((resolve) => {
      resolveLegacy = resolve;
    });
    const harness = createHarness(null, () => pendingLegacy);
    const startup = harness.start();
    await Promise.resolve();
    assert.deepEqual(harness.calls.lookups, [legacyID]);
    const listener = harness.calls.listeners[0];
    harness.stop();
    resolveLegacy(null);
    await startup;

    assert.isEmpty(harness.calls.chrome);
    assert.isEmpty(harness.calls.scripts);
    assert.isEmpty(harness.calls.listeners);
    assert.deepEqual(harness.calls.removed, [listener]);
  });

  it("cannot register listeners after shutdown while Zotero initializes", async function () {
    let finishInitialization!: () => void;
    const initialization = new Promise<void>((resolve) => {
      finishInitialization = resolve;
    });
    const harness = createHarness(null, undefined, initialization);
    const startup = harness.start();
    harness.stop();
    finishInitialization();
    await startup;

    assert.isEmpty(harness.calls.lookups);
    assert.isEmpty(harness.calls.listeners);
    assert.isEmpty(harness.calls.chrome);
    assert.isEmpty(harness.calls.scripts);
    assert.isEmpty(harness.calls.notices);
  });
});
