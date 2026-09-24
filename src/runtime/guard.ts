// src/runtime/guard.ts
import type { SearchConfig } from "../config/searchConfig.js";

export function assertLlmAllowed(agent: SearchConfig["agent"], tokensUsedToday: number): void {
  if (!agent.llmEnabled) {
    throw new Error("LLM calls disabled in config (agent.llmEnabled=false)");
  }
  if (tokensUsedToday >= agent.dailyTokenBudget) {
    throw new Error(`Daily token budget reached (${tokensUsedToday}/${agent.dailyTokenBudget})`);
  }
}
