// src/llm/usage.ts
import { gte, sql } from "drizzle-orm";
import { db } from "../db/client.js";
import { llmUsage } from "../db/schema.js";
import type { LlmUsage } from "./types.js";

export async function tokensUsedToday(): Promise<number> {
  const startOfDay = new Date();
  startOfDay.setUTCHours(0, 0, 0, 0);
  const [row] = await db
    .select({
      total: sql<string>`coalesce(sum(${llmUsage.inputTokens} + ${llmUsage.outputTokens} + ${llmUsage.cacheReadTokens} + ${llmUsage.cacheWriteTokens}), 0)`,
    })
    .from(llmUsage)
    .where(gte(llmUsage.createdAt, startOfDay));
  return Number(row?.total ?? 0); // pg returns bigint sums as strings
}

export async function recordUsage(purpose: string, model: string, usage: LlmUsage): Promise<void> {
  await db.insert(llmUsage).values({ purpose, model, ...usage });
}
