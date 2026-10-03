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
    // Reasoning models (Groq gpt-oss) spend max_tokens on hidden thinking; "low" leaves room for the JSON answer
    reasoningEffort: z.enum(["low", "medium", "high"]).optional(),
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
    jobicy: z
      .object({
        enabled: z.boolean(),
        geos: TermList.min(1),
        count: z.number().int().min(1).max(200).default(100),
      })
      .default({ enabled: false, geos: ["romania"], count: 100 }),
    smartrecruiters: z
      .array(
        z.object({
          company: z.string().min(1),
          companyId: z.string().min(1), // from careers.smartrecruiters.com/<companyId>
          country: z.string().length(2).nullable().default("ro"), // ISO code; null = all countries
        }),
      )
      .default([]),
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
    // Slug from a careers link: apply.workable.com/<slug>/
    workable: z.array(z.object({ company: z.string().min(1), slug: z.string().min(1) })).default([]),
    // Slug from a careers link: <slug>.recruitee.com
    recruitee: z.array(z.object({ company: z.string().min(1), slug: z.string().min(1) })).default([]),
    // Slug from a careers link: <slug>.jobs.personio.de (or .com)
    personio: z
      .array(z.object({ company: z.string().min(1), slug: z.string().min(1), domain: z.enum(["de", "com"]).default("de") }))
      .default([]),
    // Public listing pages of job boards (Juniors.ro, Hipo.ro, …), see src/ingest/sources/webBoard.ts
    boards: z
      .array(
        z
          .object({
            name: z.string().regex(/^[a-z0-9-]{2,20}$/, "lowercase letters, digits, dashes; max 20"),
            enabled: z.boolean().default(true),
            urls: z.array(z.url()).min(1).max(10), // ⚡ Perf/politeness: a handful of filtered listing pages per board
            linkPattern: z.string().min(1), // regex an absolute posting URL must match
            extract: z.enum(["auto", "json-ld", "llm"]).default("auto"), // auto: JSON-LD if present, else LLM
          })
          .superRefine((b, ctx) => {
            try {
              new RegExp(b.linkPattern);
            } catch {
              ctx.addIssue({ code: "custom", path: ["linkPattern"], message: "invalid regular expression" });
            }
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
  // Company career pages (ATS): a listed role is an open role, so no age limit, just a "long-open" flag
  ageExemptSources: TermList.default(["smartrecruiters", "greenhouse", "lever", "workable", "recruitee", "personio"]),
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
  enrich: z
    .object({
      enabled: z.boolean(),
      // Reads LinkedIn's public logged-out job pages. LinkedIn's terms disallow automated access;
      // volume is tiny and no account is used, but set false to rely on other sources only.
      linkedin: z.boolean(),
      maxPerRun: z.number().int().min(1).max(100),
      delaySeconds: z.number().min(1).max(30),
    })
    .default({ enabled: true, linkedin: true, maxPerRun: 30, delaySeconds: 3 }),
  tailoring: z.object({
    outputDir: z.string().min(1),
    batchSize: z.number().int().min(1).max(20),
    maxPages: z.number().int().min(1).max(3),
    maxProjects: z.number().int().min(2).max(5),
    minBullets: z.number().int().min(6).max(40), // below this the PDF looks half-empty; refilled by relevance
    maxDescriptionChars: z.number().int().min(500).max(30_000),
    photoPath: z.string().min(1).nullable(), // null = CV without photo
    fileNamePrefix: z.string().min(1).nullable().default(null), // null = "<Surname> <Given names>" from master-cv.json
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
