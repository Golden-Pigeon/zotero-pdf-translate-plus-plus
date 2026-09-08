import { config } from "../../package.json";
import type Addon from "../addon";
import type { TranslateTask } from "./task";

export interface TranslationLifecycle {
  readonly owner: Addon;
  cancelled: boolean;
  readonly cancelHandlers: Set<() => void>;
}

const taskLifecycleKey = `${config.addonRef}-translation-lifecycle`;

export class TranslationCancelledError extends Error {
  constructor() {
    super("Translation was cancelled because the plugin stopped.");
    this.name = "TranslationCancelledError";
  }
}

export function captureTranslationLifecycle(
  owner: Addon | undefined = Reflect.get(Zotero, config.addonInstance),
) {
  if (!owner) throw new TranslationCancelledError();
  // Main and custom-element bundles must use the same cancellation registry.
  const data = owner.data as Addon["data"] & {
    translationLifecycle?: TranslationLifecycle;
  };
  return (data.translationLifecycle ??= {
    owner,
    cancelled: false,
    cancelHandlers: new Set(),
  });
}

export function isTranslationActive(lifecycle?: TranslationLifecycle) {
  if (!lifecycle) {
    const owner = Reflect.get(Zotero, config.addonInstance) as
      | Addon
      | undefined;
    if (!owner) return false;
    lifecycle = captureTranslationLifecycle(owner);
  }
  return (
    !lifecycle.cancelled &&
    lifecycle.owner.data.alive &&
    // A stopped generation must never resume work against its replacement.
    Reflect.get(Zotero, config.addonInstance) === lifecycle.owner
  );
}

export function assertTranslationActive(lifecycle: TranslationLifecycle) {
  if (!isTranslationActive(lifecycle)) throw new TranslationCancelledError();
}

export function getTaskLifecycle(task: TranslateTask) {
  let lifecycle = Reflect.get(task, taskLifecycleKey) as
    | TranslationLifecycle
    | undefined;
  if (!lifecycle) {
    lifecycle = captureTranslationLifecycle();
    bindTranslationTask(task, lifecycle);
  }
  return lifecycle;
}

export function bindTranslationTask(
  task: TranslateTask,
  lifecycle: TranslationLifecycle,
) {
  const previous = Reflect.get(task, taskLifecycleKey);
  if (previous && previous !== lifecycle) return false;
  if (!previous)
    Object.defineProperty(task, taskLifecycleKey, { value: lifecycle });
  return isTranslationActive(lifecycle);
}

export function cancelTranslationWork(
  owner = captureTranslationLifecycle().owner,
) {
  const lifecycle = captureTranslationLifecycle(owner);
  owner.data.alive = false;
  lifecycle.cancelled = true;
  owner.data.translate.refreshTick = "";
  for (const cancel of [...lifecycle.cancelHandlers]) {
    try {
      cancel();
    } catch (error) {
      Zotero.logError(error as Error);
    }
  }
  lifecycle.cancelHandlers.clear();
}

export async function runWhileTranslationActive<T>(
  lifecycle: TranslationLifecycle,
  operation: () => Promise<T> | T,
): Promise<T> {
  assertTranslationActive(lifecycle);
  let cancel!: () => void;
  const cancelled = new Promise<never>((_resolve, reject) => {
    cancel = () => reject(new TranslationCancelledError());
    lifecycle.cancelHandlers.add(cancel);
  });
  try {
    const result = await Promise.race([operation(), cancelled]);
    assertTranslationActive(lifecycle);
    return result;
  } catch (error) {
    assertTranslationActive(lifecycle);
    throw error;
  } finally {
    lifecycle.cancelHandlers.delete(cancel);
  }
}

export async function translationDelay(
  milliseconds: number,
  lifecycle: TranslationLifecycle,
) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await runWhileTranslationActive(
      lifecycle,
      () =>
        new Promise<void>(
          (resolve) => (timer = setTimeout(resolve, milliseconds)),
        ),
    );
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}
