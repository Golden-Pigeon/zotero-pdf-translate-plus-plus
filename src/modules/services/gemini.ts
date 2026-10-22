import { translationRequest } from "../../utils/http";
import { getPref, transformPromptWithContext } from "../../utils";
import {
  beginTaskProgress,
  markTaskStreamChunk,
  markTaskUsage,
} from "../../utils/task";
import { TranslateService } from "./base";
import type { TranslateTask } from "../../utils/task";
import { addReasoningSetting, getGeminiReasoningParams } from "./reasoning";

const translate = <TranslateService["translate"]>async function (data) {
  const apiURL = getPref("gemini.endPoint") as string;

  function transformContent(
    langFrom: string,
    langTo: string,
    sourceText: string,
  ) {
    return transformPromptWithContext(
      "gemini.prompt",
      langFrom,
      langTo,
      sourceText,
      data,
    );
  }

  function getGenContentAPI(data: Required<TranslateTask>) {
    const stream = getPref("gemini.stream") as boolean;
    if (stream) {
      return apiURL + `:streamGenerateContent?alt=sse&key=${data.secret}`;
    } else {
      return apiURL + `:generateContent?key=${data.secret}`;
    }
  }

  const refreshHandler = addon.api.getTemporaryRefreshHandler({ task: data });

  const xhr = await translationRequest(data, "POST", getGenContentAPI(data), {
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      contents: [
        {
          parts: [
            {
              text: transformContent(data.langfrom, data.langto, data.raw),
            },
          ],
        },
      ],
      ...getGeminiReasoningParams(apiURL, getPref("gemini.reasoningEffort")),
    }),
    responseType: "text",
    requestObserver: (xmlhttp: XMLHttpRequest) => {
      beginTaskProgress(data, true);
      let preLength = 0;
      let result = "";
      let reportedResult: string | null = null;
      xmlhttp.onprogress = (e: any) => {
        // The chunk loop below shadows `data` with each SSE fragment; keep an
        // explicit handle on the translate task for progress bookkeeping.
        const task = data;
        // Only concatenate the new strings
        const newResponse = e.target.response.slice(preLength);
        const dataArray = newResponse.split("data: ");

        for (const data of dataArray) {
          if (!data) {
            continue;
          }
          try {
            const obj = JSON.parse(data);
            const text = getResponseText(obj);
            if (text) {
              markTaskStreamChunk(task);
              result += text;
            }
            const usage = obj.usageMetadata;
            if (usage) {
              markTaskUsage(
                task,
                usage.promptTokenCount,
                usage.candidatesTokenCount,
              );
            }
          } catch {
            // Skip chunks that are not complete JSON objects
          }
        }

        // Clear timeouts caused by stream transfers
        if (e.target.timeout) {
          e.target.timeout = 0;
        }

        data.result = result;
        preLength = e.target.response.length;

        if (data.result !== reportedResult) {
          reportedResult = data.result;
          refreshHandler();
        }
      };
      if (!getPref("gemini.stream")) {
        xmlhttp.onload = () => {
          const response = JSON.parse(xmlhttp.responseText);
          data.result = getResponseText(response);
          if (response.usageMetadata) {
            markTaskUsage(
              data,
              response.usageMetadata.promptTokenCount,
              response.usageMetadata.candidatesTokenCount,
            );
          }
          refreshHandler();
        };
      }
    },
  });
  if (xhr?.status !== 200) {
    throw `Request error: ${xhr?.status}`;
  }
  // data.result = xhr.response.choices[0].message.content.substr(2);
};

function getResponseText(response: {
  candidates?: {
    content?: { parts?: { text?: string; thought?: boolean }[] };
  }[];
}) {
  return (response.candidates?.[0]?.content?.parts || [])
    .filter((part) => !part.thought && typeof part.text === "string")
    .map((part) => part.text)
    .join("");
}

export const Gemini: TranslateService = {
  id: "gemini",
  type: "sentence",
  helpUrl: "https://ai.google.dev/gemini-api/docs",

  defaultSecret: "",
  secretValidator(secret: string) {
    const flag = Boolean(secret);
    return {
      secret,
      status: flag,
      info: flag ? "" : "The secret is not set.",
    };
  },

  translate,

  config(settings) {
    settings
      .addTextSetting({
        prefKey: "gemini.endPoint",
        nameKey: "service-gemini-dialog-endPoint",
      })
      .addTextAreaSetting({
        prefKey: "gemini.prompt",
        nameKey: "service-gemini-dialog-prompt",
      })
      .addCheckboxSetting({
        prefKey: "gemini.stream",
        nameKey: "service-gemini-dialog-stream",
      });
    addReasoningSetting(settings, "gemini.reasoningEffort", "gemini");
  },
};
