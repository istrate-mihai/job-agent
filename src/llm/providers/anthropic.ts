// src/llm/providers/anthropic.ts
import Anthropic from "@anthropic-ai/sdk";
import { LlmHttpError, type LlmProvider, type ProviderCall, type ProviderResult } from "../types.js";

export function anthropicProvider(apiKey: string): LlmProvider {
  const client = new Anthropic({ apiKey });

  return {
    id: "anthropic",
    async callTool(call: ProviderCall): Promise<ProviderResult> {
      let response: Anthropic.Message;
      try {
        response = await client.messages.create(
          {
            model: call.model,
            max_tokens: call.maxTokens,
            system: call.system,
            tools: [
              { name: call.toolName, description: call.toolDescription, input_schema: call.jsonSchema as Anthropic.Tool.InputSchema },
            ],
            tool_choice: { type: "tool", name: call.toolName },
            messages: [{ role: "user", content: call.user }],
          },
          { signal: call.signal },
        );
      } catch (err: unknown) {
        if (err instanceof Anthropic.APIError) {
          throw new LlmHttpError("anthropic", err.status ?? 0, err.message.slice(0, 300), null);
        }
        throw err;
      }

      const toolUse = response.content.find((b): b is Anthropic.ToolUseBlock => b.type === "tool_use");
      if (!toolUse) throw new Error("anthropic: no tool_use block in response");

      return {
        input: toolUse.input,
        usage: {
          inputTokens: response.usage.input_tokens,
          outputTokens: response.usage.output_tokens,
          cacheReadTokens: response.usage.cache_read_input_tokens ?? 0,
          cacheWriteTokens: response.usage.cache_creation_input_tokens ?? 0,
        },
      };
    },
  };
}
