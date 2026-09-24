// src/scripts/llmModels.ts
// Lists the model IDs each configured provider actually serves to your key, and checks every route against them.
import { z } from "zod";
import { loadSearchConfig } from "../config/searchConfig.js";

const ModelListSchema = z.object({ data: z.array(z.object({ id: z.string() })) });

async function listModels(baseUrl: string, apiKey: string | null): Promise<string[]> {
  const headers: Record<string, string> = {};
  if (apiKey) headers["Authorization"] = `Bearer ${apiKey}`;
  const response = await fetch(`${baseUrl.replace(/\/+$/, "")}/models`, { headers, signal: AbortSignal.timeout(15_000) });
  if (!response.ok) throw new Error(`HTTP ${response.status}: ${(await response.text()).slice(0, 150)}`);
  // Gemini returns "models/<id>"; normalize so it compares with the config
  return ModelListSchema.parse(await response.json()).data.map((m) => m.id.replace(/^models\//, "")).sort();
}

const config = await loadSearchConfig();
const available = new Map<string, Set<string> | null>(); // null = could not check

for (const [name, provider] of Object.entries(config.llm.providers)) {
  if (provider.kind !== "openai-compatible") {
    console.log(`\n${name}: skipped (${provider.kind} provider; check its console)`);
    available.set(name, null);
    continue;
  }
  const apiKey = provider.apiKeyEnv ? (process.env[provider.apiKeyEnv] ?? "") : null;
  if (apiKey === "") {
    console.log(`\n${name}: skipped (${provider.apiKeyEnv} not set)`);
    available.set(name, null);
    continue;
  }
  try {
    const models = await listModels(provider.baseUrl, apiKey);
    available.set(name, new Set(models));
    console.log(`\n${name}: ${models.length} models\n  ${models.join("\n  ")}`);
  } catch (err: unknown) {
    console.log(`\n${name}: unreachable (${err instanceof Error ? err.message : String(err)})`);
    available.set(name, null);
  }
}

console.log("\nRoute check:");
for (const [task, routes] of Object.entries(config.llm.tasks)) {
  for (const route of routes) {
    const models = available.get(route.provider);
    const status = models === null || models === undefined ? "? unchecked" : models.has(route.model) ? "✔ available" : "✖ NOT AVAILABLE";
    console.log(`  ${task.padEnd(10)} ${route.provider}/${route.model}  ${status}`);
  }
}
