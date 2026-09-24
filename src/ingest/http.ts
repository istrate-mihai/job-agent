// src/ingest/http.ts
const USER_AGENT = "job-agent/0.1 (personal job search; github.com/istrate-mihai)";

export async function fetchJson(url: string, signal: AbortSignal): Promise<unknown> {
  const response = await fetch(url, {
    signal,
    headers: { "User-Agent": USER_AGENT, Accept: "application/json" },
  });
  if (!response.ok) {
    throw new Error(`GET ${url} → ${response.status} ${response.statusText}`);
  }
  return response.json();
}
