import type { TranslateTask } from "./task";
import {
  assertTranslationActive,
  getTaskLifecycle,
  isTranslationActive,
  runWhileTranslationActive,
  TranslationLifecycle,
} from "./lifecycle";

type RequestArguments = Parameters<typeof Zotero.HTTP.request>;

/** Track only this plugin's requests, preserving each service's observers. */
export async function translationRequest(
  taskOrLifecycle: TranslateTask | TranslationLifecycle,
  method: RequestArguments[0],
  url: RequestArguments[1],
  options: RequestArguments[2] = {},
) {
  const lifecycle =
    "owner" in taskOrLifecycle
      ? taskOrLifecycle
      : getTaskLifecycle(taskOrLifecycle);
  assertTranslationActive(lifecycle);
  let request: XMLHttpRequest | undefined;
  let cancelRequest: (() => void) | undefined;
  const abort = () => {
    if (cancelRequest) cancelRequest();
    else request?.abort();
  };
  lifecycle.cancelHandlers.add(abort);
  try {
    return await runWhileTranslationActive(lifecycle, () =>
      Zotero.HTTP.request(method, url, {
        ...options,
        requestObserver: function (xhr: XMLHttpRequest, ...args: unknown[]) {
          request = xhr;
          if (!isTranslationActive(lifecycle)) {
            abort();
            assertTranslationActive(lifecycle);
          }
          return options.requestObserver?.call(this, xhr, ...args);
        },
        cancellerReceiver: function (cancel: () => void, ...args: unknown[]) {
          cancelRequest = cancel;
          if (!isTranslationActive(lifecycle)) cancel();
          return options.cancellerReceiver?.call(this, cancel, ...args);
        },
      }),
    );
  } finally {
    lifecycle.cancelHandlers.delete(abort);
  }
}
