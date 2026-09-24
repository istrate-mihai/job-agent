// src/llm/providers/openaiCompatible.ts
// One adapter for every OpenAI-compatible API: Groq, Gemini, OpenRouter, Mistral, Ollama, ...
import { z } from "zod";
import { LlmHttpError, parseRetryAfter, type LlmProvider, type ProviderCall, type ProviderResult } from "../types.js";

export interface OpenAiCompatibleOptions {
  id: string;
  baseUrl: string;
  apiKey: string | null; // null for local Ollama
  toolMode: "forced" | "json"; // "json" for models/hosts without reliable forced tool calls
}

const ChatResponseSchema = z.object({
  choices: z
    .array(
      z.object({
        message: z.object({
          content: z.string().nullish(),
          tool_calls: z
            .array(z.object({ function: z.object({ name: z.string(), arguments: z.string() }) }))
            .nullish(),
        }),
      }),
    )
    .min(1),
  usage: z.object({ prompt_tokens: z.number().optional(), completion_tokens: z.number().optional() }).nullish(),
});

/** Accepts raw JSON, JSON in ```fences```, or JSON surrounded by prose (common with small open models). */
export function parseJsonLoose(text: string): unknown {
  const unfenced = text.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");
  const start = unfenced.indexOf("{");
  const end = unfenced.lastIndexOf("}");
  if (start === -1 || end <= start) throw new Error("model output contains no JSON object");
  return JSON.parse(unfenced.slice(start, end + 1));
}

export function openAiCompatibleProvider(opts: OpenAiCompatibleOptions): LlmProvider {
  const endpoint = `${opts.baseUrl.replace(/\/+$/, "")}/chat/completions`;

  return {
    id: opts.id,
    async callTool(call: ProviderCall): Promise<ProviderResult> {
      const system =
        opts.toolMode === "json"
          ? `${call.system}\n\nRespond with ONLY a JSON object (no prose, no code fences) that matches this JSON Schema:\n${JSON.stringify(call.jsonSchema)}`
          : call.system;

      const body: Record<string, unknown> = {
        model: call.model,
        max_tokens: call.maxTokens,
        temperature: 0, // extraction/scoring should be deterministic
        messages: [
          { role: "system", content: system },
          { role: "user", content: call.user },
        ],
      };
      if (opts.toolMode === "forced") {
        body["tools"] = [
          { type: "function", function: { name: call.toolName, description: call.toolDescription, parameters: call.jsonSchema } },
        ];
        body["tool_choice"] = { type: "function", function: { name: call.toolName } };
      } else {
        body["response_format"] = { type: "json_object" };
      }

      const headers: Record<string, string> = { "Content-Type": "application/json" };
      if (opts.apiKey) headers["Authorization"] = `Bearer ${opts.apiKey}`;

      const response = await fetch(endpoint, { method: "POST", headers, body: JSON.stringify(body), signal: call.signal });
      if (!response.ok) {
        const detail = (await response.text()).slice(0, 300);
        throw new LlmHttpError(opts.id, response.status, detail, parseRetryAfter(response.headers.get("retry-after")));
      }

      const data = ChatResponseSchema.parse(await response.json());
      const message = data.choices[0]?.message;
      const toolArgs = message?.tool_calls?.find((t) => t.function.name === call.toolName)?.function.arguments;
      const input: unknown = toolArgs !== undefined ? JSON.parse(toolArgs) : parseJsonLoose(message?.content ?? "");

      return {
        input,
        usage: {
          inputTokens: data.usage?.prompt_tokens ?? 0,
          outputTokens: data.usage?.completion_tokens ?? 0,
          cacheReadTokens: 0,
          cacheWriteTokens: 0,
        },
      };
    },
  };
}
