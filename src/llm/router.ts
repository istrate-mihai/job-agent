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

const MAX_ATTEMPTS_PER_ROUTE = 4;

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
    provider = openAiCompatibleProvider({
      id: name,
      baseUrl: cfg.baseUrl,
      apiKey,
      toolMode: cfg.toolMode,
      ...(cfg.reasoningEffort ? { reasoningEffort: cfg.reasoningEffort } : {}),
    });
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
    let mode: "forced" | "json" | undefined;
    let waitedSec = 0;
    let repairs = 0;
    for (let attempt = 1; attempt <= MAX_ATTEMPTS_PER_ROUTE; attempt += 1) {
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
          ...(mode ? { mode } : {}),
        });
        await recordUsage(req.task, label, result.usage);

        const parsed = req.schema.safeParse(result.input);
        if (parsed.success) return { data: parsed.data, route: label };

        failures.push(`${label}: invalid output (${summarizeIssues(parsed.error)})`);
        user = `${req.user}\n\nYour previous output failed validation: ${summarizeIssues(parsed.error)}. Return corrected output.`;
      } catch (err: unknown) {
        if (!(err instanceof LlmHttpError)) {
          failures.push(`${label}: ${err instanceof Error ? err.message.slice(0, 200) : String(err)}`);
          if (err instanceof SyntaxError && mode !== "json") mode = "json"; // unparseable tool args: try plain JSON mode
          else break;
          continue;
        }
        // Model produced no/broken tool call: retry the same model in plain JSON mode (no tool calling)
        if (err.status === 400 && /validat|tool_use_failed|did not call a tool|parse tool call|generate json/i.test(err.message)) {
          failures.push(`${label}: provider rejected output (${err.message.slice(0, 120)})`);
          repairs += 1;
          if (repairs > 1) break; // forced + JSON both failed: stop burning the per-minute token quota on this model
          mode = "json";
          continue;
        }
        // Rate limit (429) or overload (502/503/504): wait and retry, within a per-route wait budget
        const transient = err.status === 429 || err.status === 502 || err.status === 503 || err.status === 504;
        const waitSec = err.retryAfterSec ?? (err.status === 429 ? 20 : 8 * attempt);
        if (transient && waitedSec + waitSec <= config.llm.maxRetryWaitSec * 2 && waitSec <= config.llm.maxRetryWaitSec) {
          waitedSec += waitSec;
          await sleep(Math.ceil(waitSec * 1000), undefined, { signal: req.signal });
          continue;
        }
        failures.push(`${label}: ${err.message.slice(0, 200)}`);
        break; // long rate limit or hard error: next route
      }
    }
  }

  throw new Error(`All LLM routes failed for task "${req.task}":\n  - ${failures.join("\n  - ")}`);
}
