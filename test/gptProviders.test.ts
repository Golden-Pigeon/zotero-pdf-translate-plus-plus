import { config } from "../package.json";
import type Addon from "../src/addon";
import { TranslationServices } from "../src/modules/services";
import {
  azureGPT,
  ChatGPT,
  customGPT1,
  customGPT2,
  customGPT3,
  DeepSeek,
  GLM,
} from "../src/modules/services/gpt";
import { Claude } from "../src/modules/services/claude";
import { Gemini } from "../src/modules/services/gemini";
import { cancelTranslationWork } from "../src/utils/lifecycle";
import type { AllowedSettingsMethods } from "../src/utils/settingsDialog";
import { TranslateTask, TranslateTaskRunner } from "../src/utils/task";

const providers = [GLM, DeepSeek];
const configurations = [
  { service: GLM, prefix: "glm", temperature: 0.4, maxTokens: 71 },
  { service: DeepSeek, prefix: "deepseek", temperature: 0.8, maxTokens: 83 },
  { service: ChatGPT, prefix: "chatGPT", temperature: 1.7, maxTokens: 97 },
  { service: customGPT1, prefix: "customGPT1", temperature: 1, maxTokens: 97 },
  { service: customGPT2, prefix: "customGPT2", temperature: 1, maxTokens: 97 },
  { service: customGPT3, prefix: "customGPT3", temperature: 1, maxTokens: 97 },
  { service: azureGPT, prefix: "azureGPT", temperature: 1, maxTokens: 97 },
];

function task(service: string): TranslateTask {
  return {
    id: Zotero.Utilities.randomString(),
    type: "text",
    raw: "Source text",
    result: "",
    audio: [],
    service,
    candidateServices: [],
    itemId: undefined,
    langfrom: "en-US",
    langto: "zh-CN",
    status: "waiting",
    extraTasks: [],
  };
}

async function withProviderFixture(
  run: (fixture: {
    prefs: Record<string, unknown>;
    manager: TranslationServices;
  }) => Promise<void> | void,
) {
  const descriptors = [
    [globalThis, "addon"],
    [globalThis, "ztoolkit"],
    [Zotero, config.addonInstance],
  ].map(
    ([object, key]) =>
      [
        object as object,
        key as string,
        Object.getOwnPropertyDescriptor(object, key as string),
      ] as const,
  );
  const originalGet = Zotero.Prefs.get;
  const originalSet = Zotero.Prefs.set;
  const originalRequest = Zotero.HTTP.request;
  const prefs: Record<string, unknown> = {
    attachPaperContext: false,
    secretObj: JSON.stringify({
      glm: "glm.test-key",
      deepseek: "deepseek-test-key",
      chatgpt: `sk-${"c".repeat(40)}`,
      claude: "claude-test-key",
      gemini: "gemini-test-key",
      azuregpt: "azure-test-key",
    }),
  };
  for (const { service, prefix, temperature, maxTokens } of configurations) {
    Object.assign(prefs, {
      [`${prefix}.endPoint`]: `https://${service.id}.example.invalid/chat/completions`,
      [`${prefix}.model`]: `${service.id}-test-model`,
      [`${prefix}.prompt`]: `${service.id}: ${"${langFrom}"} -> ${"${langTo}"}: ${"${sourceText}"}`,
      [`${prefix}.temperature`]: String(temperature),
      [`${prefix}.stream`]: true,
      [`${prefix}.reasoningEffort`]: "default",
      [`${prefix}.customParams`]: JSON.stringify({ max_tokens: maxTokens }),
    });
  }
  Object.assign(prefs, {
    "azureGPT.apiVersion": "2025-04-01-preview",
    "claude.endPoint": "https://claude.example.invalid/v1/messages",
    "claude.model": "claude-3-7-sonnet-20250219",
    "claude.temperature": "0.3",
    "claude.maxTokens": "4000",
    "claude.prompt": "${sourceText}",
    "claude.stream": true,
    "gemini.endPoint": "https://gemini.example.invalid/models/gemini-2.5-flash",
    "gemini.prompt": "${sourceText}",
    "gemini.stream": true,
  });
  const manager = new TranslationServices();
  const toolkit = { log: () => {} };
  const owner = {
    data: {
      alive: true,
      ztoolkit: toolkit,
      translate: { queue: [], refreshTick: "", services: manager },
    },
    api: { getTemporaryRefreshHandler: () => () => {} },
  } as unknown as Addon;
  try {
    for (const [object, key] of descriptors) {
      Object.defineProperty(object, key, {
        configurable: true,
        value: key === "ztoolkit" ? toolkit : owner,
      });
    }
    const branch = `${config.prefsPrefix}.`;
    Zotero.Prefs.get = ((key: string, global?: boolean) =>
      key.startsWith(branch)
        ? prefs[key.slice(branch.length)]
        : originalGet.call(Zotero.Prefs, key, global)) as typeof originalGet;
    Zotero.Prefs.set = ((key: string, value: unknown, global?: boolean) => {
      if (key.startsWith(branch)) prefs[key.slice(branch.length)] = value;
      else Reflect.apply(originalSet, Zotero.Prefs, [key, value, global]);
    }) as typeof originalSet;
    // Every request must be stubbed explicitly; no test may reach a paid API.
    Zotero.HTTP.request = (() => {
      throw new Error("Unexpected network request");
    }) as typeof originalRequest;
    await run({ prefs, manager });
  } finally {
    cancelTranslationWork(owner);
    Zotero.Prefs.get = originalGet;
    Zotero.Prefs.set = originalSet;
    Zotero.HTTP.request = originalRequest;
    for (const [object, key, descriptor] of descriptors) {
      if (descriptor) Object.defineProperty(object, key, descriptor);
      else Reflect.deleteProperty(object, key);
    }
  }
}

function stubResponses() {
  const requests: {
    method: string;
    url: string;
    options: Parameters<typeof Zotero.HTTP.request>[2];
    body: Record<string, unknown>;
  }[] = [];
  Zotero.HTTP.request = (async (method, url, options) => {
    const body = JSON.parse(String(options?.body));
    requests.push({ method, url: String(url), options, body });
    const xhr = {
      status: 200,
      response: "",
      responseText: "",
      abort: () => {},
    } as XMLHttpRequest;
    options?.requestObserver?.(xhr);
    const usage = { prompt_tokens: 19, completion_tokens: 7 };
    const claude = String(url).includes("claude.example.invalid");
    const gemini = Boolean(body.contents);
    const responses = Boolean(body.input);
    const stream = gemini
      ? String(url).includes(":streamGenerateContent")
      : body.stream;
    if (stream) {
      const chunks = claude
        ? [
            {
              type: "content_block_delta",
              delta: { type: "thinking_delta", thinking: "Private reasoning" },
            },
            {
              type: "content_block_delta",
              delta: { type: "text_delta", text: "Translated " },
            },
            {
              type: "content_block_delta",
              delta: { type: "text_delta", text: "text" },
            },
            { type: "message_delta", usage: { output_tokens: 7 } },
          ]
        : gemini
          ? [
              {
                candidates: [
                  {
                    content: {
                      parts: [{ thought: true, text: "Private reasoning" }],
                    },
                  },
                ],
              },
              {
                candidates: [
                  {
                    content: {
                      parts: [{ text: "Translated " }, { text: "text" }],
                    },
                  },
                ],
                usageMetadata: {
                  promptTokenCount: 19,
                  candidatesTokenCount: 7,
                },
              },
            ]
          : responses
            ? [
                {
                  type: "response.reasoning_text.delta",
                  delta: "Private reasoning",
                },
                {
                  type: "response.output_text.delta",
                  delta: "Translated text",
                },
                {
                  type: "response.completed",
                  response: { usage: { input_tokens: 19, output_tokens: 7 } },
                },
              ]
            : [
                {
                  choices: [
                    { delta: { reasoning_content: "Private reasoning" } },
                  ],
                },
                { choices: [{ delta: { content: "Translated " } }] },
                // GLM/DeepSeek can attach usage to the final normal completion chunk.
                {
                  choices: [
                    { delta: { content: "text" }, finish_reason: "stop" },
                  ],
                  usage,
                },
              ];
      for (const chunk of chunks) {
        Object.defineProperty(xhr, "response", {
          configurable: true,
          value: xhr.response + `data: ${JSON.stringify(chunk)}\n\n`,
        });
        xhr.onprogress?.({
          target: xhr,
        } as unknown as ProgressEvent<XMLHttpRequestEventTarget>);
      }
    } else {
      Object.defineProperty(xhr, "responseText", {
        value: JSON.stringify(
          claude
            ? {
                content: [
                  { type: "thinking", thinking: "Private reasoning" },
                  { type: "text", text: "Translated " },
                  { type: "text", text: "text" },
                ],
                usage: { input_tokens: 19, output_tokens: 7 },
              }
            : gemini
              ? {
                  candidates: [
                    {
                      content: {
                        parts: [
                          { thought: true, text: "Private reasoning" },
                          { text: "Translated " },
                          { text: "text" },
                        ],
                      },
                    },
                  ],
                  usageMetadata: {
                    promptTokenCount: 19,
                    candidatesTokenCount: 7,
                  },
                }
              : responses
                ? {
                    output: [
                      { type: "reasoning", summary: [] },
                      {
                        type: "message",
                        content: [
                          { type: "output_text", text: "Translated text" },
                        ],
                      },
                    ],
                    usage: { input_tokens: 19, output_tokens: 7 },
                  }
                : {
                    choices: [
                      {
                        message: {
                          content: "Translated text",
                          reasoning_content: "Private reasoning",
                        },
                      },
                    ],
                    usage,
                  },
        ),
      });
      xhr.onload?.({
        target: xhr,
      } as unknown as ProgressEvent<XMLHttpRequestEventTarget>);
    }
    return xhr;
  }) as typeof Zotero.HTTP.request;
  return requests;
}

describe("Independent GLM and DeepSeek providers", function () {
  for (const provider of providers) {
    for (const stream of [false, true]) {
      it(`uses isolated ${provider.id} preferences and task secrets (${stream ? "stream" : "non-stream"})`, async function () {
        await withProviderFixture(async ({ prefs }) => {
          for (const { prefix } of configurations)
            prefs[`${prefix}.stream`] = !stream;
          prefs[`${provider.id}.stream`] = stream;
          const requests = stubResponses();
          const data = task(provider.id);
          await new TranslateTaskRunner(provider.translate).run(data);
          assert.equal(data.status, "success", data.result);
          assert.lengthOf(requests, 1);
          const { method, url, options, body } = requests[0];
          const expected = configurations.find(
            ({ service }) => service === provider,
          )!;
          assert.equal(method, "POST");
          assert.equal(url, prefs[`${provider.id}.endPoint`]);
          assert.equal(options?.responseType, "text");
          assert.equal(
            options?.headers?.Authorization,
            `Bearer ${JSON.parse(String(prefs.secretObj))[provider.id]}`,
          );
          assert.equal(body.model, `${provider.id}-test-model`);
          assert.deepEqual(body.messages, [
            {
              role: "user",
              content: `${provider.id}: en-US -> zh-CN: Source text`,
            },
          ]);
          assert.equal(body.temperature, expected.temperature);
          assert.equal(body.max_tokens, expected.maxTokens);
          assert.strictEqual(body.stream, stream);
          if (stream && provider === DeepSeek)
            assert.deepEqual(body.stream_options, { include_usage: true });
          else assert.notProperty(body, "stream_options");
          assert.equal(data.service, provider.id);
          assert.equal(data.result, "Translated text");
          assert.equal(data.progress?.inputTokens, 19);
          assert.equal(data.progress?.outputTokens, 7);
          if (stream) assert.equal(data.progress?.streamedChunks, 2);
        });
      });
    }
  }

  it("retains ChatGPT usage requests and allows each provider to override stream_options", async function () {
    await withProviderFixture(async ({ prefs }) => {
      const requests = stubResponses();
      const chat = task(ChatGPT.id);
      await new TranslateTaskRunner(ChatGPT.translate).run(chat);
      assert.equal(chat.status, "success", chat.result);
      assert.deepEqual(requests.pop()!.body.stream_options, {
        include_usage: true,
      });
      const override = { include_usage: false, custom_option: "test" };
      for (const { service, prefix } of configurations) {
        prefs[`${prefix}.customParams`] = JSON.stringify({
          stream_options: override,
        });
        const data = task(service.id);
        await new TranslateTaskRunner(service.translate).run(data);
        assert.equal(data.status, "success", data.result);
        assert.deepEqual(requests.pop()!.body.stream_options, override);
      }
    });
  });

  it("does not borrow ChatGPT's secret when either provider has no key", async function () {
    await withProviderFixture(async ({ prefs }) => {
      prefs.secretObj = JSON.stringify({ chatgpt: `sk-${"c".repeat(40)}` });
      const requests = stubResponses();
      for (const provider of providers) {
        const data = task(provider.id);
        await new TranslateTaskRunner(provider.translate).run(data);
        assert.equal(data.status, "success", data.result);
        assert.equal(data.service, provider.id);
        assert.strictEqual(data.secret, "");
        assert.equal(
          requests.pop()!.options?.headers?.Authorization,
          "Bearer ",
        );
      }
    });
  });

  it("accepts any nonblank provider key and sets independent configuration fields and temperature limits", async function () {
    await withProviderFixture(() => {
      for (const provider of providers) {
        assert.isFunction(provider.secretValidator);
        for (const secret of ["", " \t\n"])
          assert.isFalse(provider.secretValidator!(secret).status);
        for (const secret of ["x", " vendor.token "])
          assert.isTrue(provider.secretValidator!(secret).status);
      }
      for (const provider of [GLM, DeepSeek, ChatGPT, customGPT1, azureGPT]) {
        const fields: { prefKey: string; min?: number; max?: number }[] = [];
        const add = (field: (typeof fields)[number]) => {
          fields.push(field);
          return settings;
        };
        const settings = {
          addTextSetting: add,
          addNumberSetting: add,
          addTextAreaSetting: add,
          addCheckboxSetting: add,
          addSelectSetting: add,
          addCustomParamsSetting: add,
          addStaticRow: () => settings,
          onSave: () => settings,
        };
        provider.config!(settings as unknown as AllowedSettingsMethods);
        const prefix = provider.id.replace("gpt", "GPT");
        assert.sameMembers(
          fields.map(({ prefKey }) => prefKey),
          [
            "endPoint",
            "model",
            "temperature",
            "reasoningEffort",
            "prompt",
            "stream",
            "customParams",
            ...(provider === azureGPT ? ["apiVersion"] : []),
          ].map((key) => `${prefix}.${key}`),
        );
        const temperature = fields.find(
          ({ prefKey }) => prefKey === `${prefix}.temperature`,
        )!;
        assert.equal(temperature.min, 0);
        assert.equal(temperature.max, provider === GLM ? 1 : 2);
      }
    });
  });

  it("registers both providers and marks their unconfigured entries for hiding independently", async function () {
    await withProviderFixture(({ manager, prefs }) => {
      for (const provider of providers) {
        assert.strictEqual(manager.getServiceById(provider.id), provider);
        assert.include(manager.getAllServicesWithType("sentence"), provider);
      }
      prefs.secretObj = JSON.stringify({ chatgpt: `sk-${"c".repeat(40)}` });
      for (const provider of providers)
        assert.isTrue(manager.getUnconfiguredServiceIds().has(provider.id));
      prefs.secretObj = JSON.stringify({
        glm: " \t",
        deepseek: "vendor.token",
      });
      assert.isTrue(manager.getUnconfiguredServiceIds().has("glm"));
      assert.isFalse(manager.getUnconfiguredServiceIds().has("deepseek"));
      prefs.secretObj = JSON.stringify({ glm: "x", deepseek: "vendor.token" });
      for (const provider of providers)
        assert.isFalse(manager.getUnconfiguredServiceIds().has(provider.id));
    });
  });
});

describe("Provider thinking effort", function () {
  it("leaves defaults and unset preferences unchanged for every GPT provider", async function () {
    await withProviderFixture(async ({ prefs }) => {
      const requests = stubResponses();
      for (const { service, prefix, temperature } of configurations) {
        for (const effort of [undefined, "default", "invalid"]) {
          prefs[`${prefix}.reasoningEffort`] = effort;
          const data = task(service.id);
          await new TranslateTaskRunner(service.translate).run(data);
          assert.equal(data.status, "success", data.result);
          const { body } = requests.pop()!;
          assert.equal(body.temperature, temperature);
          for (const key of ["reasoning", "reasoning_effort", "thinking"])
            assert.notProperty(body, key);
        }
      }
    });
  });

  for (const stream of [false, true]) {
    it(`maps thinking effort to each GPT API (${stream ? "stream" : "non-stream"})`, async function () {
      await withProviderFixture(async ({ prefs }) => {
        const requests = stubResponses();
        for (const { service, prefix } of configurations) {
          const levels =
            service === GLM
              ? ["none", "enabled", "low", "high", "max"]
              : service === DeepSeek
                ? ["none", "low", "high", "max"]
                : ["none", "minimal", "low", "medium", "high", "xhigh", "max"];
          // Azure builds a Chat Completions URL itself; GLM uses its native API.
          const apis =
            service === azureGPT || service === GLM ? [false] : [false, true];
          for (const responses of apis) {
            prefs[`${prefix}.endPoint`] =
              `https://${service.id}.example.invalid/${responses ? "responses" : "chat/completions"}`;
            prefs[`${prefix}.stream`] = stream;
            for (const effort of levels) {
              prefs[`${prefix}.reasoningEffort`] = effort;
              const data = task(service.id);
              await new TranslateTaskRunner(service.translate).run(data);
              assert.equal(data.status, "success", data.result);
              assert.equal(data.result, "Translated text");
              const { body } = requests.pop()!;
              if (responses) {
                assert.deepEqual(body.reasoning, { effort });
                assert.notProperty(body, "reasoning_effort");
                assert.notProperty(body, "thinking");
              } else if (service === GLM || service === DeepSeek) {
                assert.deepEqual(body.thinking, {
                  type: effort === "none" ? "disabled" : "enabled",
                });
                if (effort === "none" || effort === "enabled")
                  assert.notProperty(body, "reasoning_effort");
                else assert.equal(body.reasoning_effort, effort);
              } else {
                assert.equal(body.reasoning_effort, effort);
                assert.notProperty(body, "reasoning");
                assert.notProperty(body, "thinking");
              }
              if (service !== GLM && service !== DeepSeek)
                assert.notProperty(body, "temperature");
              assert.equal(data.progress?.outputTokens, 7);
            }
          }
        }
      });
    });
  }

  it("lets custom parameters override thinking settings independently", async function () {
    await withProviderFixture(async ({ prefs }) => {
      const requests = stubResponses();
      for (const { service, prefix } of configurations) {
        prefs[`${prefix}.reasoningEffort`] = "high";
        const override =
          service === GLM || service === DeepSeek
            ? { thinking: { type: "disabled" }, reasoning_effort: "low" }
            : { reasoning_effort: "low" };
        prefs[`${prefix}.customParams`] = JSON.stringify(override);
        const data = task(service.id);
        await new TranslateTaskRunner(service.translate).run(data);
        assert.equal(data.status, "success", data.result);
        const { body } = requests.pop()!;
        for (const [key, value] of Object.entries(override))
          assert.deepEqual(body[key], value);
      }
      prefs["chatGPT.endPoint"] = "https://chatgpt.example.invalid/responses";
      prefs["chatGPT.customParams"] = JSON.stringify({
        reasoning: { effort: "low", summary: "auto" },
      });
      const data = task(ChatGPT.id);
      await new TranslateTaskRunner(ChatGPT.translate).run(data);
      assert.equal(data.status, "success", data.result);
      assert.deepEqual(requests.pop()!.body.reasoning, {
        effort: "low",
        summary: "auto",
      });
    });
  });

  for (const stream of [false, true]) {
    it(`handles Claude thinking blocks and Gemini thought parts (${stream ? "stream" : "non-stream"})`, async function () {
      await withProviderFixture(async ({ prefs }) => {
        const requests = stubResponses();
        prefs["claude.stream"] = stream;
        prefs["gemini.stream"] = stream;
        for (const effort of ["default", "none", "low", "medium", "high"]) {
          prefs["claude.reasoningEffort"] = effort;
          const data = task(Claude.id);
          await new TranslateTaskRunner(Claude.translate).run(data);
          assert.equal(data.status, "success", data.result);
          assert.equal(data.result, "Translated text");
          const { body } = requests.pop()!;
          assert.equal(body.max_tokens, 4000);
          if (effort === "default") {
            assert.notProperty(body, "thinking");
            assert.equal(body.temperature, 0.3);
          } else if (effort === "none") {
            assert.deepEqual(body.thinking, { type: "disabled" });
            assert.notProperty(body, "temperature");
          } else {
            assert.deepEqual(body.thinking, {
              type: "enabled",
              budget_tokens: { low: 1024, medium: 2000, high: 3000 }[
                effort as "low" | "medium" | "high"
              ],
            });
            assert.notProperty(body, "temperature");
            assert.notProperty(body, "output_config");
          }
        }
        for (const model of [
          "claude-opus-4-20250514",
          "claude-sonnet-4-5-20250929",
          "claude-sonnet-4-6",
          "claude-opus-4-7",
          "claude-sonnet-5",
        ]) {
          prefs["claude.model"] = model;
          prefs["claude.reasoningEffort"] = "medium";
          const data = task(Claude.id);
          await new TranslateTaskRunner(Claude.translate).run(data);
          assert.equal(data.status, "success", data.result);
          const { body } = requests.pop()!;
          if (
            ["claude-opus-4-20250514", "claude-sonnet-4-5-20250929"].includes(
              model,
            )
          )
            assert.deepEqual(body.thinking, {
              type: "enabled",
              budget_tokens: 2000,
            });
          else {
            assert.deepEqual(body.thinking, { type: "adaptive" });
            assert.deepEqual(body.output_config, { effort: "medium" });
          }
        }
        for (const model of ["gemini-2.5-flash", "gemini-3-flash"]) {
          prefs["gemini.endPoint"] =
            `https://gemini.example.invalid/models/${model}`;
          for (const effort of [
            "default",
            "minimal",
            "low",
            "medium",
            "high",
            ...(model.includes("2.5") ? ["none"] : []),
          ]) {
            prefs["gemini.reasoningEffort"] = effort;
            const data = task(Gemini.id);
            await new TranslateTaskRunner(Gemini.translate).run(data);
            assert.equal(data.status, "success", data.result);
            assert.equal(data.result, "Translated text");
            const { body } = requests.pop()!;
            if (effort === "default")
              assert.notProperty(body, "generationConfig");
            else
              assert.deepEqual(body.generationConfig, {
                thinkingConfig: model.includes("2.5")
                  ? {
                      thinkingBudget: {
                        none: 0,
                        minimal: 512,
                        low: 1024,
                        medium: 4096,
                        high: 8192,
                      }[effort as "low"],
                    }
                  : { thinkingLevel: effort },
              });
            assert.equal(data.progress?.inputTokens, 19);
          }
        }
      });
    });
  }

  it("rejects an insufficient Claude budget and unsupported Gemini off mode before requesting", async function () {
    await withProviderFixture(async ({ prefs }) => {
      const requests = stubResponses();
      prefs["claude.maxTokens"] = "1024";
      prefs["claude.reasoningEffort"] = "high";
      const claude = task(Claude.id);
      await new TranslateTaskRunner(Claude.translate).run(claude);
      assert.equal(claude.status, "fail");
      for (const model of ["gemini-2.5-pro", "gemini-3-flash"]) {
        prefs["gemini.endPoint"] =
          `https://gemini.example.invalid/models/${model}`;
        prefs["gemini.reasoningEffort"] = "none";
        const gemini = task(Gemini.id);
        await new TranslateTaskRunner(Gemini.translate).run(gemini);
        assert.equal(gemini.status, "fail");
      }
      assert.isEmpty(requests);
    });
  });
});
