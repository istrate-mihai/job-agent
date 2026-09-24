// src/runtime/guard.ts
import type { SearchConfig } from "../config/searchConfig.js";

/** Thrown when the kill switch or daily budget blocks LLM calls; batch jobs stop instead of retrying. */
export class LlmBlockedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "LlmBlockedError";
  }
}

export function assertLlmAllowed(agent: SearchConfig["agent"], tokensUsedToday: number): void {
  if (!agent.llmEnabled) {
    throw new LlmBlockedError("LLM calls disabled in config (agent.llmEnabled=false)");
  }
  if (tokensUsedToday >= agent.dailyTokenBudget) {
    throw new LlmBlockedError(`Daily token budget reached (${tokensUsedToday}/${agent.dailyTokenBudget})`);
  }
}
