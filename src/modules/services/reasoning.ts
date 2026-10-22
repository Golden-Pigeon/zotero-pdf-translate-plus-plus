import type { AllowedSettingsMethods } from "../../utils/settingsDialog";
import type { PrefKeysWithStringValue } from "../../utils/prefs";
import { getString } from "../../utils/locale";

type ReasoningProvider = "openai" | "glm" | "deepseek" | "gemini" | "claude";

const efforts = {
  openai: [
    "default",
    "none",
    "minimal",
    "low",
    "medium",
    "high",
    "xhigh",
    "max",
  ],
  glm: ["default", "none", "enabled", "low", "high", "max"],
  deepseek: ["default", "none", "low", "high", "max"],
  gemini: ["default", "none", "minimal", "low", "medium", "high"],
  claude: ["default", "none", "low", "medium", "high"],
} as const;

export function addReasoningSetting(
  settings: AllowedSettingsMethods,
  prefKey: PrefKeysWithStringValue,
  provider: ReasoningProvider,
) {
  settings.addSelectSetting({
    prefKey,
    nameKey: "service-dialog-reasoning-effort",
    options: efforts[provider].map((value) => ({
      value,
      label: getString(`service-dialog-reasoning-${value}`),
    })),
  });
  // Select fields don't render descriptions, so use an explicit hint row.
  settings.addStaticRow("", {
    tag: "div",
    namespace: "html",
    styles: {
      color: "var(--fill-secondary)",
      fontSize: "0.9em",
      maxWidth: "400px",
    },
    properties: {
      textContent: getString(`service-dialog-reasoning-hint-${provider}`),
    },
  });
}

/** Keep the default request unchanged, including for preferences not yet set. */
function hasEffort(
  provider: ReasoningProvider,
  effort: unknown,
): effort is string {
  return (
    typeof effort === "string" &&
    effort !== "default" &&
    (efforts[provider] as readonly string[]).includes(effort)
  );
}

// https://developers.openai.com/api/docs/guides/reasoning
// https://api-docs.deepseek.com/guides/thinking_mode/
// https://docs.bigmodel.cn/api-reference/模型-api/对话补全
export function getGPTReasoningParams(
  prefix: string,
  effort: unknown,
  useResponsesApi: boolean,
): Record<string, unknown> {
  const provider =
    prefix === "glm" || prefix === "deepseek" ? prefix : "openai";
  if (!hasEffort(provider, effort)) return {};

  if (provider === "glm") {
    return {
      thinking: { type: effort === "none" ? "disabled" : "enabled" },
      ...(effort === "none" || effort === "enabled"
        ? {}
        : { reasoning_effort: effort }),
    };
  }

  if (useResponsesApi)
    return {
      reasoning: { effort },
      ...(provider === "openai" ? { temperature: undefined } : {}),
    };
  if (provider === "deepseek") {
    return {
      thinking: { type: effort === "none" ? "disabled" : "enabled" },
      ...(effort === "none" ? {} : { reasoning_effort: effort }),
    };
  }
  // Reasoning models may reject temperature; let the model use its default.
  return { reasoning_effort: effort, temperature: undefined };
}

// https://ai.google.dev/gemini-api/docs/generate-content/thinking
export function getGeminiReasoningParams(
  endpoint: string,
  effort: unknown,
): Record<string, unknown> {
  if (!hasEffort("gemini", effort)) return {};
  const usesBudget = /gemini-2\.5(?:-|\b)/i.test(endpoint);
  if (
    effort === "none" &&
    (!usesBudget || /gemini-2\.5-pro(?:-|\b)/i.test(endpoint))
  )
    throw new Error(getString("service-dialog-reasoning-gemini-off-error"));
  const budgets: Record<string, number> = {
    none: 0,
    minimal: 512,
    low: 1024,
    medium: 4096,
    high: 8192,
  };
  return {
    generationConfig: {
      thinkingConfig: usesBudget
        ? { thinkingBudget: budgets[effort] }
        : { thinkingLevel: effort },
    },
  };
}

// https://platform.claude.com/docs/en/build-with-claude/extended-thinking
// https://platform.claude.com/docs/en/build-with-claude/adaptive-thinking
export function getClaudeReasoningParams(
  model: string,
  effort: unknown,
  maxTokens: number,
): Record<string, unknown> {
  if (!hasEffort("claude", effort)) return {};
  if (effort === "none")
    return { thinking: { type: "disabled" }, temperature: undefined };

  const legacy =
    /claude-3-7-/i.test(model) ||
    /claude-(?:opus|sonnet|haiku)-4(?:-[0-5](?=-|$)|(?=-\d{8}|$))/i.test(model);
  if (legacy) {
    const shares: Record<string, number> = {
      low: 0.25,
      medium: 0.5,
      high: 0.75,
    };
    const budget = Math.max(1024, Math.floor(maxTokens * shares[effort]));
    if (budget >= maxTokens)
      throw new Error(
        getString("service-dialog-reasoning-claude-budget-error"),
      );
    return {
      thinking: { type: "enabled", budget_tokens: budget },
      temperature: undefined,
    };
  }
  return {
    thinking: { type: "adaptive" },
    output_config: { effort },
    temperature: undefined,
  };
}
