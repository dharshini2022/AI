import { ChatOpenAI } from "@langchain/openai";
import { settings } from "./config.ts";
import { startTimer } from "./timing.ts";

function timingCallbacks(label: string) {
  const timers = new Map<string, (detail?: string) => void>();
  const finish = (runId: string, detail: string) => {
    timers.get(runId)?.(detail);
    timers.delete(runId);
  };
  return [
    {
      handleChatModelStart: (_llm: unknown, _messages: unknown, runId: string) => {
        timers.set(runId, startTimer(`llm ${label}`));
      },
      handleLLMEnd: (output: any, runId: string) => {
        finish(runId, `tool_calls=${output?.generations?.[0]?.[0]?.message?.tool_calls?.length ?? 0}`);
      },
      handleLLMError: (_err: unknown, runId: string) => finish(runId, "error"),
    },
  ];
}

// Provider is chosen purely by .env: LLM_API_BASE points at an OpenAI-compatible gateway (e.g. a LiteLLM proxy).
export function getChatModel({
  temperature,
  model,
  label = "llm",
}: { temperature?: number | null; model?: string | null; label?: string } = {}): ChatOpenAI {
  return new ChatOpenAI({
    model: model || settings.llmModel,
    apiKey: settings.llmApiKey || "placeholder",
    temperature: temperature ?? settings.llmTemperature,
    configuration: { baseURL: settings.llmApiBase || undefined },
    // Lets one model turn request several tool calls, which LangChain then runs concurrently.
    modelKwargs: settings.llmParallelToolCalls ? { parallel_tool_calls: true } : undefined,
    callbacks: settings.timing ? timingCallbacks(label) : undefined,
  });
}
