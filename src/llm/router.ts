// src/llm/router.ts
import { setTimeout as sleep } from "node:timers/promises";
import { z } from "zod";
import type { SearchConfig } from "../config/searchConfig.js";
import { assertLlmAllowed } from "../runtime/guard.js";
import { anthropicProvider } from "./providers/anthropic.js";
import { openAiCompatibleProvider } from "./providers/openaiCompatible.js";
import { LlmHttpError, type LlmProvider, type LlmTask } from "./types.js";
import { recordUsage, tokensUsedToday } from "./usage.js";

export interface StructuredRequest<T> {
  task: LlmTask;
  system: string;
  user: string;
  schema: z.ZodType<T>;
  toolName: string;
  toolDescription: string;
  maxTokens: number;
  signal: AbortSignal;
}

export interface StructuredResult<T> {
  data: T;
  route: string; // "provider/model" that produced it
}

type ProviderConfig = SearchConfig["llm"]["providers"][string];
const providerCache = new Map<string, LlmProvider | null>();

function getProvider(name: string, cfg: ProviderConfig): LlmProvider | null {
  if (providerCache.has(name)) return providerCache.get(name) ?? null;
  const apiKey = cfg.apiKeyEnv ? (process.env[cfg.apiKeyEnv] ?? "") : null;
  let provider: LlmProvider | null = null;
  if (apiKey === "") {
    provider = null; // key env var configured but empty: route is skipped
  } else if (cfg.kind === "anthropic") {
    provider = apiKey ? anthropicProvider(apiKey) : null;
  } else {
    provider = openAiCompatibleProvider({ id: name, baseUrl: cfg.baseUrl, apiKey, toolMode: cfg.toolMode });
  }
  providerCache.set(name, provider);
  return provider;
}

/**
 * Zod → JSON Schema sent to providers.
 * - io "input": transforms (e.g. truncation) are applied locally after the call, not demanded from the model
 * - drops $schema / additionalProperties (Gemini rejects them)
 * - drops maxLength / maxItems: Groq enforces the tool schema server-side and fails the whole call
 *   on an over-long string; length limits are enforced locally by Zod instead
 */
export function toToolSchema(schema: z.ZodType): Record<string, unknown> {
  const DROPPED = new Set(["$schema", "additionalProperties", "maxLength", "maxItems"]);
  const strip = (node: unknown): unknown => {
    if (Array.isArray(node)) return node.map(strip);
    if (node === null || typeof node !== "object") return node;
    const out: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(node)) {
      if (DROPPED.has(key)) continue;
      if ((key === "maximum" || key === "minimum") && typeof value === "number" && Math.abs(value) >= Number.MAX_SAFE_INTEGER) continue;
      out[key] = strip(value);
    }
    return out;
  };
  return strip(z.toJSONSchema(schema, { io: "input" })) as Record<string, unknown>;
}

function summarizeIssues(error: z.ZodError): string {
  return error.issues
    .slice(0, 5)
    .map((i) => `${i.path.map(String).join(".") || "(root)"}: ${i.message}`)
    .join("; ");
}

/**
 * Tries each configured route for the task in order (e.g. Groq → Gemini → Ollama → Anthropic).
 * Per route: short 429 waits are retried once, invalid output gets one repair attempt, anything else falls through.
 */
export async function generateStructured<T>(config: SearchConfig, req: StructuredRequest<T>): Promise<StructuredResult<T>> {
  const jsonSchema = toToolSchema(req.schema);
  const failures: string[] = [];

  for (const route of config.llm.tasks[req.task]) {
    const providerCfg = config.llm.providers[route.provider];
    if (!providerCfg) {
      failures.push(`${route.provider}: provider not configured`);
      continue;
    }
    const provider = getProvider(route.provider, providerCfg);
    if (!provider) {
      failures.push(`${route.provider}: ${providerCfg.apiKeyEnv ?? "api key"} not set`);
      continue;
    }

    const label = `${route.provider}/${route.model}`;
    let user = req.user;
    for (let attempt = 1; attempt <= 2; attempt += 1) {
      assertLlmAllowed(config.agent, await tokensUsedToday()); // outside try: budget/kill switch aborts the whole task
      try {
        const result = await provider.callTool({
          model: route.model,
          system: req.system,
          user,
          toolName: req.toolName,
          toolDescription: req.toolDescription,
          jsonSchema,
          maxTokens: req.maxTokens,
          signal: req.signal,
        });
        await recordUsage(req.task, label, result.usage);

        const parsed = req.schema.safeParse(result.input);
        if (parsed.success) return { data: parsed.data, route: label };

        failures.push(`${label}: invalid output (${summarizeIssues(parsed.error)})`);
        user = `${req.user}\n\nYour previous output failed validation: ${summarizeIssues(parsed.error)}. Return corrected output.`;
      } catch (err: unknown) {
        // Provider-side schema validation (e.g. Groq "Tool call validation failed"): repairable like a local failure
        if (attempt === 1 && err instanceof LlmHttpError && err.status === 400 && /validat|tool_use_failed|did not call a tool/i.test(err.message)) {
          failures.push(`${label}: provider rejected output (${err.message.slice(0, 160)})`);
          user = `${req.user}\n\nYour previous output was rejected by schema validation: ${err.message.slice(0, 300)}. Return corrected output.`;
          continue;
        }
        const waitSec = err instanceof LlmHttpError && err.status === 429 ? err.retryAfterSec : null;
        if (attempt === 1 && waitSec !== null && waitSec <= config.llm.maxRetryWaitSec) {
          await sleep(Math.ceil(waitSec * 1000), undefined, { signal: req.signal });
          continue;
        }
        failures.push(`${label}: ${err instanceof Error ? err.message.slice(0, 200) : String(err)}`);
        break; // provider error or long rate limit: next route
      }
    }
  }

  throw new Error(`All LLM routes failed for task "${req.task}":\n  - ${failures.join("\n  - ")}`);
}
