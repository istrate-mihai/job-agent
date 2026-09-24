// src/config/searchConfig.ts
import { readFile } from "node:fs/promises";
import { parse } from "yaml";
import { z } from "zod";

const CitySchema = z.object({
  name: z.string().min(1),
  aliases: z.array(z.string().min(1)).default([]),
});

const TermList = z.array(z.string().min(1));

const ProviderSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("openai-compatible"),
    baseUrl: z.url(),
    apiKeyEnv: z.string().min(1).nullable(), // null = no auth (local Ollama)
    toolMode: z.enum(["forced", "json"]),
  }),
  z.object({
    kind: z.literal("anthropic"),
    apiKeyEnv: z.string().min(1),
  }),
]);

const RouteList = z.array(z.object({ provider: z.string().min(1), model: z.string().min(1) })).min(1);

export const SearchConfigSchema = z.object({
  agent: z.object({
    enabled: z.boolean(),
    llmEnabled: z.boolean(),
    dailyTokenBudget: z.number().int().positive(),
  }),
  llm: z
    .object({
      maxRetryWaitSec: z.number().int().min(0).max(120),
      providers: z.record(z.string(), ProviderSchema),
      tasks: z.object({ extraction: RouteList, scoring: RouteList, tailoring: RouteList }),
    })
    .superRefine((llm, ctx) => {
      for (const [task, routes] of Object.entries(llm.tasks)) {
        routes.forEach((route, i) => {
          if (!(route.provider in llm.providers)) {
            ctx.addIssue({ code: "custom", path: ["tasks", task, i, "provider"], message: `unknown provider "${route.provider}"` });
          }
        });
      }
    }),
  sources: z.object({
    gmail: z.object({
      enabled: z.boolean(),
      query: z.string().min(1),
      lookbackDays: z.number().int().min(1).max(30),
      maxMessages: z.number().int().min(1).max(100),
    }),
    remotive: z.object({
      enabled: z.boolean(),
      categories: TermList.min(1),
    }),
    greenhouse: z.array(z.object({ company: z.string().min(1), boardToken: z.string().min(1) })).default([]),
    lever: z
      .array(
        z.object({
          company: z.string().min(1),
          slug: z.string().min(1),
          region: z.enum(["global", "eu"]).default("global"),
        }),
      )
      .default([]),
  }),
  locations: z.object({
    remoteScopeAllow: TermList.min(1),
    countryFallback: z.string().min(1),
    tierA: z.array(CitySchema).min(1),
    tierB: z.array(CitySchema),
  }),
  titles: z.object({ include: TermList.min(1), exclude: TermList }),
  seniority: z.object({ target: z.string().min(1), allow: TermList.min(1) }),
  maxPostingAgeDays: z.number().int().positive(),
  stackWeights: z.record(z.string(), z.number().min(0).max(1)),
  languageFlags: TermList,
  companies: z.object({ allowlist: TermList, blocklist: TermList }),
  limits: z.object({
    dailyApprovals: z.number().int().positive(),
    perCompanyCooldownDays: z.number().int().nonnegative(),
  }),
  scoring: z.object({
    tailorThreshold: z.number().int().min(0).max(100),
    reviewThreshold: z.number().int().min(0).max(100),
    batchSize: z.number().int().min(1).max(200),
    maxDescriptionChars: z.number().int().min(500).max(30_000),
    careerGoals: z.string().min(10).max(500),
  }),
  digest: z.object({
    limit: z.number().int().min(1).max(50),
  }),
});

export type SearchConfig = z.infer<typeof SearchConfigSchema>;

export async function loadSearchConfig(path = "config/search-config.yaml"): Promise<SearchConfig> {
  const raw: unknown = parse(await readFile(path, "utf8")); // re-read every run: edits apply without restart
  const result = SearchConfigSchema.safeParse(raw);
  if (!result.success) {
    const details = result.error.issues.map((i) => `  - ${i.path.join(".")}: ${i.message}`).join("\n");
    throw new Error(`Invalid ${path}:\n${details}`);
  }
  return result.data;
}
