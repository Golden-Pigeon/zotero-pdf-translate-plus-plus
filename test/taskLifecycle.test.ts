import { config } from "../package.json";
import type Addon from "../src/addon";
import api from "../src/api";
import { TranslationServices } from "../src/modules/services";
import type { TranslateService } from "../src/modules/services/base";
import { getToken } from "../src/modules/services/cnki";
import { Mtranserver } from "../src/modules/services/mtranserver";
import { translationRequest } from "../src/utils/http";
import { mathTag, panelTag } from "../src/utils/elementNames";
import {
  cancelTranslationWork,
  captureTranslationLifecycle,
  getTaskLifecycle,
  isTranslationActive,
  TranslationCancelledError,
} from "../src/utils/lifecycle";
import {
  addTranslateTask,
  TranslateError,
  TranslateTask,
  TranslateTaskRunner,
} from "../src/utils/task";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function task(type: TranslateTask["type"] = "text"): TranslateTask {
  return {
    id: Zotero.Utilities.randomString(),
    type,
    raw: "Source text",
    result: "",
    audio: [],
    service: "test-primary",
    candidateServices: [],
    itemId: 123456789,
    langfrom: "en-US",
    langto: "zh-CN",
    status: "waiting",
    extraTasks: [],
  };
}

const runOptions = { noCache: true, noCheckZoteroItemLanguage: true };

async function withLifecycleFixture(
  run: (fixture: ReturnType<typeof createFixture>) => Promise<void>,
) {
  const addonDescriptor = Object.getOwnPropertyDescriptor(globalThis, "addon");
  const toolkitDescriptor = Object.getOwnPropertyDescriptor(
    globalThis,
    "ztoolkit",
  );
  const instanceDescriptor = Object.getOwnPropertyDescriptor(
    Zotero,
    config.addonInstance,
  );
  const originalGet = Zotero.Items.get;
  const originalPrefGet = Zotero.Prefs.get;
  const originalPrefSet = Zotero.Prefs.set;
  const originalRequest = Zotero.HTTP.request;
  const fixture = createFixture();
  const prefs: Record<string, unknown> = {
    secretObj: "{}",
    splitChar: "",
    stripEmptyLines: false,
    resultRegex: "",
    annotationTranslationPosition: "comment",
    annotationTranslationPositionInBody: "after",
    enableAutoTagAnnotation: false,
    cnkiToken: JSON.stringify({ token: "test-token", t: Date.now() }),
    cnkiUseSplit: false,
    cnkiSplitSecond: 1,
    cnkiRegex: "",
    "mtranserver.endpoint": "https://example.invalid/translate",
    "mtranserver.versionlabel": false,
  };
  Zotero.Items.get = ((id: number) =>
    id === 123456789
      ? fixture.item
      : Reflect.apply(originalGet, Zotero.Items, [
          id,
        ])) as unknown as typeof originalGet;
  Zotero.Prefs.get = ((key: string, global?: boolean) => {
    const name = key.slice(`${config.prefsPrefix}.`.length);
    if (key.startsWith(`${config.prefsPrefix}.`) && name in prefs)
      return prefs[name];
    return originalPrefGet.call(Zotero.Prefs, key, global);
  }) as typeof originalPrefGet;
  Zotero.Prefs.set = ((key: string, value: unknown, global?: boolean) => {
    const name = key.slice(`${config.prefsPrefix}.`.length);
    if (key.startsWith(`${config.prefsPrefix}.`) && name in prefs) {
      prefs[name] = value;
      return;
    }
    return Reflect.apply(originalPrefSet, Zotero.Prefs, [key, value, global]);
  }) as typeof originalPrefSet;
  try {
    fixture.install();
    await run(fixture);
  } finally {
    cancelTranslationWork(fixture.owner);
    const current = Reflect.get(globalThis, "addon") as Addon;
    if (current && current !== fixture.owner) cancelTranslationWork(current);
    Zotero.Items.get = originalGet;
    Zotero.Prefs.get = originalPrefGet;
    Zotero.Prefs.set = originalPrefSet;
    Zotero.HTTP.request = originalRequest;
    for (const [object, name, descriptor] of [
      [globalThis, "addon", addonDescriptor],
      [globalThis, "ztoolkit", toolkitDescriptor],
      [Zotero, config.addonInstance, instanceDescriptor],
    ] as const) {
      if (descriptor) Object.defineProperty(object, name, descriptor);
      else Reflect.deleteProperty(object, name);
    }
  }
}

function createFixture() {
  const calls = { saves: 0, fields: 0, refreshes: 0 };
  const serviceMap: Record<string, TranslateService> = {};
  const manager = new TranslationServices();
  manager.getServiceById = (id) => serviceMap[id];
  const item = {
    annotationComment: "Original comment",
    annotationText: "Original annotation",
    saveTx: async () => {
      calls.saves++;
    },
  };
  const toolkit = {
    log: () => {},
    ExtraField: {
      setExtraField: () => {
        calls.fields++;
      },
    },
  };
  const owner = {
    data: {
      alive: true,
      ztoolkit: toolkit,
      translate: { queue: [], refreshTick: "", services: manager },
    },
    api,
    hooks: {
      onReaderPopupRefresh: () => {
        calls.refreshes++;
      },
      onReaderTabPanelRefresh: () => {
        calls.refreshes++;
      },
    },
  } as unknown as Addon;
  return {
    owner,
    manager,
    calls,
    item,
    serviceMap,
    install() {
      Object.defineProperty(globalThis, "addon", {
        configurable: true,
        value: owner,
      });
      Object.defineProperty(globalThis, "ztoolkit", {
        configurable: true,
        value: toolkit,
      });
      Object.defineProperty(Zotero, config.addonInstance, {
        configurable: true,
        value: owner,
      });
    },
  };
}

describe("Translation lifecycle isolation", function () {
  it("creates tasks and schedules math from the built window bundle without an addon global", function () {
    const listeners = new Map<string, (event?: unknown) => void>();
    const control = (name: string) => ({
      value: "Text from the window panel",
      style: { flex: "" },
      addEventListener: (event: string, callback: (event?: unknown) => void) =>
        listeners.set(`${name}:${event}`, callback),
    });
    const controls = new Map([
      ["translate", control("translate")],
      ["raw-text", control("raw-text")],
      ["result-text", control("result-text")],
    ]);
    let translated = 0;
    const owner = {
      data: {
        alive: true,
        panel: { windowPanel: null },
        translate: {
          queue: [] as TranslateTask[],
          maximumQueueLength: 100,
          refreshTick: "",
          services: { getAllServices: () => [{ id: "window-service" }] },
        },
      },
      hooks: {
        onTranslate: () => {
          translated++;
        },
      },
    } as unknown as Addon;
    const registered = new Map<string, new () => any>();
    const scope = {
      Zotero: {
        [config.addonInstance]: owner,
        Utilities: { randomString: () => "window-task" },
        Prefs: { get: () => false },
      },
      XULElementBase: class {
        toggleAttribute() {}
      },
      customElements: {
        get: (name: string) => registered.get(name),
        define: (name: string, constructor: new () => any) =>
          registered.set(name, constructor),
      },
    };
    assert.isFalse("addon" in scope);
    Services.scriptloader.loadSubScript(
      `chrome://${config.addonRef}/content/scripts/customElements.js`,
      scope,
    );
    const Panel = registered.get(panelTag)!;
    const panel = new Panel();
    panel._queryID = (name: string) => controls.get(name) ?? null;
    panel.init();
    listeners.get("translate:command")!();
    assert.lengthOf(owner.data.translate.queue, 1);
    const data = owner.data.translate.queue[0];
    assert.equal(data.raw, "Text from the window panel");
    assert.equal(data.service, "window-service");
    assert.strictEqual(getTaskLifecycle(data).owner, owner);
    assert.equal(translated, 1);

    let frame: (() => void) | undefined;
    const MathTextbox = registered.get(mathTag)!;
    const math = new MathTextbox();
    math.ownerDocument = {
      defaultView: {
        requestAnimationFrame: (callback: () => void) => {
          frame = callback;
          return 1;
        },
      },
    };
    math._overlay = { innerHTML: "Existing math" };
    math._scheduleOverlayRender();
    assert.isFunction(frame);
    cancelTranslationWork(owner);
    frame!();
    assert.equal(math._overlay.innerHTML, "Existing math");
  });

  it("handles a missing window owner and keeps a retained main API bound to its sandbox owner", async function () {
    await withLifecycleFixture(async (fixture) => {
      let serviceCalls = 0;
      fixture.manager.getAllServices = () => [
        {
          id: "saved-service",
          type: "sentence",
          translate: () => {
            serviceCalls++;
          },
        },
      ];
      const savedService = api.getServices()[0];
      await savedService.translate(task() as Required<TranslateTask>);
      assert.equal(serviceCalls, 1);
      const ownerDescriptor = Object.getOwnPropertyDescriptor(
        Zotero,
        config.addonInstance,
      )!;
      Reflect.deleteProperty(Zotero, config.addonInstance);
      assert.isFalse(isTranslationActive());
      assert.isUndefined(addTranslateTask("After uninstall"));
      assert.throws(
        () => captureTranslationLifecycle(),
        TranslationCancelledError,
      );
      Object.defineProperty(Zotero, config.addonInstance, ownerDescriptor);
      const replacement = createFixture();
      Object.defineProperty(Zotero, config.addonInstance, {
        configurable: true,
        value: replacement.owner,
      });
      // The main sandbox still contains the old addon while the window registry changes.
      assert.strictEqual(addon, fixture.owner);
      assert.isFalse(
        await fixture.manager.runTranslationTask(task(), runOptions),
      );
      const refresh = api.getTemporaryRefreshHandler();
      refresh();
      assert.equal(replacement.calls.refreshes, 0);
      try {
        await api.translate("Stale API", { pluginID: "test" });
        assert.fail("The old API must not use the replacement plugin");
      } catch (error) {
        assert.instanceOf(error, TranslationCancelledError);
      }
      assert.throws(
        () => savedService.translate(task() as Required<TranslateTask>),
        TranslationCancelledError,
      );
      assert.throws(() => api.getServices(), TranslationCancelledError);
      assert.equal(serviceCalls, 1);
    });
  });

  it("keeps fallback translation and item storage working while enabled", async function () {
    await withLifecycleFixture(async (fixture) => {
      let fallbackCalls = 0;
      fixture.serviceMap["test-primary"] = {
        id: "test-primary",
        type: "sentence",
        translate: () => {
          throw new TranslateError("Try fallback");
        },
      };
      fixture.serviceMap["test-fallback"] = {
        id: "test-fallback",
        type: "sentence",
        translate: (data) => {
          fallbackCalls++;
          data.result = "Fallback result";
        },
      };
      const data = task("title");
      data.candidateServices.push("test-fallback");
      assert.isTrue(await fixture.manager.runTranslationTask(data, runOptions));
      assert.equal(data.result, "Fallback result");
      assert.equal(fallbackCalls, 1);
      assert.equal(fixture.calls.fields, 1);
      assert.equal(fixture.calls.saves, 1);
      assert.isAbove(fixture.calls.refreshes, 0);
    });
  });

  for (const type of ["annotation", "title", "abstract"] as const) {
    it(`does not save a late ${type} result or start extra translations after shutdown`, async function () {
      await withLifecycleFixture(async (fixture) => {
        const result = deferred<void>();
        let extraCalls = 0;
        fixture.serviceMap["test-primary"] = {
          id: "test-primary",
          type: "sentence",
          translate: async (data) => {
            await result.promise;
            data.result = "Late result";
          },
        };
        fixture.serviceMap["test-extra"] = {
          id: "test-extra",
          type: "sentence",
          translate: () => {
            extraCalls++;
          },
        };
        const data = task(type);
        data.extraTasks.push({
          ...task(),
          service: "test-extra",
          extraTasks: [],
        });
        const running = fixture.manager.runTranslationTask(data, runOptions);
        const refreshes = fixture.calls.refreshes;
        cancelTranslationWork(fixture.owner);
        assert.isFalse(await running);
        assert.equal(data.status, "cancelled");
        result.resolve();
        await Promise.resolve();
        await Promise.resolve();
        assert.equal(fixture.calls.saves, 0);
        assert.equal(fixture.calls.fields, 0);
        assert.equal(fixture.item.annotationComment, "Original comment");
        assert.equal(fixture.item.annotationText, "Original annotation");
        assert.equal(fixture.calls.refreshes, refreshes);
        assert.equal(extraCalls, 0);
      });
    });
  }

  it("does not fall back on a late failure, and permits only the new generation to run", async function () {
    await withLifecycleFixture(async (fixture) => {
      const result = deferred<void>();
      let fallbackCalls = 0;
      fixture.serviceMap["test-primary"] = {
        id: "test-primary",
        type: "sentence",
        translate: () => result.promise,
      };
      fixture.serviceMap["test-fallback"] = {
        id: "test-fallback",
        type: "sentence",
        translate: () => {
          fallbackCalls++;
        },
      };
      const data = task();
      data.candidateServices.push("test-fallback");
      const oldRefresh = api.getTemporaryRefreshHandler();
      const running = fixture.manager.runTranslationTask(data, runOptions);
      cancelTranslationWork(fixture.owner);
      assert.isFalse(await running);
      assert.isUndefined(addTranslateTask("After shutdown"));
      let stoppedProcessorCalls = 0;
      await new TranslateTaskRunner(() => {
        stoppedProcessorCalls++;
      }).run(task());
      assert.equal(stoppedProcessorCalls, 0);
      try {
        await api.translate("After shutdown", { pluginID: "test" });
        assert.fail("A stopped API must reject new work");
      } catch (error) {
        assert.instanceOf(error, TranslationCancelledError);
      }

      const replacement = createFixture();
      replacement.serviceMap["test-primary"] = {
        id: "test-primary",
        type: "sentence",
        translate: (next) => {
          next.result = "Fresh result";
        },
      };
      replacement.install();
      result.reject(new Error("Late failure"));
      await Promise.resolve();
      await Promise.resolve();
      oldRefresh();
      assert.equal(replacement.calls.refreshes, 0);
      assert.equal(fallbackCalls, 0);
      assert.isFalse(
        await replacement.manager.runTranslationTask(data, runOptions),
      );
      assert.isFalse(
        await fixture.manager.runTranslationTask(task(), runOptions),
      );
      const freshTask = task("title");
      assert.isTrue(
        await replacement.manager.runTranslationTask(freshTask, runOptions),
      );
      assert.equal(freshTask.result, "Fresh result");
      assert.equal(replacement.calls.fields, 1);
    });
  });

  it("suppresses the completion refresh of already running extra translations", async function () {
    await withLifecycleFixture(async (fixture) => {
      const extraStarted = deferred<void>();
      const result = deferred<void>();
      fixture.serviceMap["test-primary"] = {
        id: "test-primary",
        type: "sentence",
        translate: (data) => {
          data.result = "Primary result";
        },
      };
      fixture.serviceMap["test-extra"] = {
        id: "test-extra",
        type: "sentence",
        translate: async () => {
          extraStarted.resolve();
          await result.promise;
        },
      };
      const data = task();
      data.extraTasks.push({
        ...task(),
        service: "test-extra",
        extraTasks: [],
      });
      const running = fixture.manager.runTranslationTask(data, runOptions);
      await extraStarted.promise;
      cancelTranslationWork(fixture.owner);
      const refreshes = fixture.calls.refreshes;
      await running;
      result.resolve();
      for (let index = 0; index < 8; index++) await Promise.resolve();
      assert.equal(fixture.calls.refreshes, refreshes);
    });
  });

  it("aborts only owned HTTP requests and preserves streaming observers and options", async function () {
    await withLifecycleFixture(async (fixture) => {
      const requests: {
        xhr: XMLHttpRequest;
        aborted: number;
        result: ReturnType<typeof deferred<XMLHttpRequest>>;
        options: Parameters<typeof Zotero.HTTP.request>[2];
      }[] = [];
      let originalObserverCalls = 0;
      let receiverCalls = 0;
      let streamed = "";
      const requestStub: typeof Zotero.HTTP.request = function (
        this: typeof Zotero.HTTP,
        method,
        url,
        options,
      ) {
        assert.strictEqual(this, Zotero.HTTP);
        assert.equal(method, "POST");
        assert.equal(url, "https://example.invalid/translate");
        const result = deferred<XMLHttpRequest>();
        const record = {
          xhr: undefined as unknown as XMLHttpRequest,
          aborted: 0,
          result,
          options,
        };
        record.xhr = {
          responseText: "Partial response",
          abort: () => {
            record.aborted++;
            result.reject(new Error("Aborted"));
          },
        } as unknown as XMLHttpRequest;
        requests.push(record);
        options?.cancellerReceiver?.(() => record.xhr.abort());
        options?.requestObserver?.(record.xhr);
        return result.promise;
      };
      Zotero.HTTP.request = requestStub;
      const foreign = Zotero.HTTP.request(
        "POST",
        "https://example.invalid/translate",
      );
      const headers = { Authorization: "Test token" };
      const pending = translationRequest(
        task(),
        "POST",
        "https://example.invalid/translate",
        {
          body: "Request body",
          headers,
          responseType: "text",
          timeout: 123,
          errorDelayIntervals: [10, 20],
          requestObserver: (xhr: XMLHttpRequest) => {
            originalObserverCalls++;
            xhr.onprogress = () => {
              streamed = xhr.responseText;
            };
          },
          cancellerReceiver: () => {
            receiverCalls++;
          },
        },
      ).catch((error) => error);
      requests[1].xhr.onprogress?.(
        {} as ProgressEvent<XMLHttpRequestEventTarget>,
      );
      assert.equal(streamed, "Partial response");
      assert.equal(originalObserverCalls, 1);
      assert.equal(receiverCalls, 1);
      assert.strictEqual(requests[1].options?.headers, headers);
      assert.equal(requests[1].options?.body, "Request body");
      assert.equal(requests[1].options?.timeout, 123);
      assert.deepEqual(requests[1].options?.errorDelayIntervals, [10, 20]);
      cancelTranslationWork(fixture.owner);
      assert.instanceOf(await pending, TranslationCancelledError);
      assert.equal(requests[1].aborted, 1);
      assert.equal(requests[0].aborted, 0);
      assert.strictEqual(Zotero.HTTP.request, requestStub);
      requests[0].result.resolve(requests[0].xhr);
      assert.strictEqual(await foreign, requests[0].xhr);
      assert.equal(
        captureTranslationLifecycle(fixture.owner).cancelHandlers.size,
        0,
      );
    });
  });

  it("rejects stopped requests before transport and aborts XHR when no canceller is supplied", async function () {
    await withLifecycleFixture(async (fixture) => {
      let requests = 0;
      let aborts = 0;
      Zotero.HTTP.request = ((_method, _url, options) => {
        requests++;
        options?.requestObserver?.({
          abort: () => {
            aborts++;
          },
        });
        return new Promise<XMLHttpRequest>(() => {});
      }) as typeof Zotero.HTTP.request;
      const data = task();
      const pending = translationRequest(
        data,
        "GET",
        "https://example.invalid/translate",
      ).catch((error) => error);
      cancelTranslationWork(fixture.owner);
      assert.instanceOf(await pending, TranslationCancelledError);
      assert.equal(aborts, 1);
      const replacement = createFixture();
      replacement.install();
      const rejected = await translationRequest(
        data,
        "GET",
        "https://example.invalid/translate",
      ).catch((error) => error);
      assert.instanceOf(rejected, TranslationCancelledError);
      assert.equal(requests, 1);
    });
  });

  it("cancels a real service transport and keeps its replacement usable", async function () {
    await withLifecycleFixture(async (fixture) => {
      fixture.serviceMap["test-primary"] = Mtranserver;
      let aborts = 0;
      Zotero.HTTP.request = ((_method, _url, options) => {
        options?.requestObserver?.({
          abort: () => {
            aborts++;
          },
        });
        return new Promise<XMLHttpRequest>(() => {});
      }) as typeof Zotero.HTTP.request;
      const running = fixture.manager.runTranslationTask(
        task("title"),
        runOptions,
      );
      cancelTranslationWork(fixture.owner);
      assert.isFalse(await running);
      assert.equal(aborts, 1);
      assert.equal(fixture.calls.saves, 0);
      const replacement = createFixture();
      replacement.serviceMap["test-primary"] = Mtranserver;
      replacement.install();
      Zotero.HTTP.request = (async (_method, _url, options) => {
        const xhr = {
          status: 200,
          response: { result: "Fresh HTTP result" },
        } as XMLHttpRequest;
        options?.requestObserver?.(xhr);
        return xhr;
      }) as typeof Zotero.HTTP.request;
      const next = task();
      assert.isTrue(
        await replacement.manager.runTranslationTask(next, runOptions),
      );
      assert.equal(next.result, "Fresh HTTP result");
      assert.equal(
        captureTranslationLifecycle(replacement.owner).cancelHandlers.size,
        0,
      );
    });
  });

  it("cancels a service retry delay while retaining retries for an enabled replacement", async function () {
    await withLifecycleFixture(async (fixture) => {
      const tokenService: TranslateService = {
        id: "cnki-token-test",
        type: "sentence",
        translate: async (data) => {
          data.result = await getToken(true, getTaskLifecycle(data));
        },
      };
      fixture.serviceMap["test-primary"] = tokenService;
      const failed = deferred<void>();
      let requests = 0;
      Zotero.HTTP.request = (async () => {
        requests++;
        failed.resolve();
        throw new Error("Temporary request failure");
      }) as typeof Zotero.HTTP.request;
      const data = task();
      data.silent = true;
      const running = fixture.manager.runTranslationTask(data, runOptions);
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        await Promise.race([
          failed.promise,
          running.then(() => {
            throw new Error(
              `CNKI task finished before making a request: ${data.result}`,
            );
          }),
          new Promise<never>((_resolve, reject) => {
            timer = setTimeout(
              () => reject(new Error("CNKI did not start its first request")),
              1000,
            );
          }),
        ]);
      } finally {
        if (timer !== undefined) clearTimeout(timer);
      }
      for (let index = 0; index < 20; index++) await Promise.resolve();
      cancelTranslationWork(fixture.owner);
      assert.isFalse(await running);
      await new Promise((resolve) => setTimeout(resolve, 350));
      assert.equal(requests, 1);

      const replacement = createFixture();
      replacement.serviceMap["test-primary"] = tokenService;
      replacement.install();
      let freshRequests = 0;
      Zotero.HTTP.request = (async () => {
        freshRequests++;
        if (freshRequests === 1) throw new Error("Temporary request failure");
        return {
          status: 200,
          response: { code: 200, data: "Retried result" },
        } as XMLHttpRequest;
      }) as typeof Zotero.HTTP.request;
      const next = task();
      next.silent = true;
      assert.isTrue(
        await replacement.manager.runTranslationTask(next, runOptions),
      );
      assert.equal(freshRequests, 2);
      assert.equal(next.result, "Retried result");
    });
  });
});
