// src/llm/types.ts
export type LlmTask = "extraction" | "scoring" | "tailoring";

export interface LlmUsage {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
}

export interface ProviderCall {
  model: string;
  system: string;
  user: string;
  toolName: string;
  toolDescription: string;
  jsonSchema: Record<string, unknown>;
  maxTokens: number;
  signal: AbortSignal;
}

export interface ProviderResult {
  input: unknown; // raw structured output, validated by the router with Zod
  usage: LlmUsage;
}

export interface LlmProvider {
  readonly id: string;
  callTool(call: ProviderCall): Promise<ProviderResult>;
}

export class LlmHttpError extends Error {
  constructor(
    readonly provider: string,
    readonly status: number,
    detail: string,
    readonly retryAfterSec: number | null,
  ) {
    super(`${provider} HTTP ${status}: ${detail}`);
    this.name = "LlmHttpError";
  }
}

export function parseRetryAfter(value: string | null | undefined): number | null {
  if (!value) return null;
  const seconds = Number(value);
  if (Number.isFinite(seconds)) return Math.max(0, seconds);
  const date = Date.parse(value); // HTTP-date form
  return Number.isNaN(date) ? null : Math.max(0, (date - Date.now()) / 1000);
}
