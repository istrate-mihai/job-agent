// tests/helpers.ts
import { readFileSync } from "node:fs";
import { loadSearchConfig, type SearchConfig } from "../src/config/searchConfig.js";
import type { PostingRow } from "../src/db/schema.js";
import type { NormalizedPosting } from "../src/ingest/types.js";
import { MasterCvSchema, type MasterCv } from "../src/schemas/masterCv.js";

export const FIXTURE_CONFIG = "tests/fixtures/search-config.yaml";

export function loadFixtureCv(): MasterCv {
  return MasterCvSchema.parse(JSON.parse(readFileSync("tests/fixtures/sample-cv.json", "utf8")));
}

export function loadFixtureConfig(): Promise<SearchConfig> {
  return loadSearchConfig(FIXTURE_CONFIG);
}

export function normalizedPosting(overrides: Partial<NormalizedPosting> = {}): NormalizedPosting {
  return {
    source: "test",
    sourceId: "1",
    company: "Test Co",
    title: "Full Stack Developer",
    url: "https://example.com/job/1",
    locationText: "Brașov, Romania",
    workMode: "hybrid",
    remoteScope: null,
    description: "",
    postedAt: new Date(),
    raw: {},
    ...overrides,
  };
}

export function postingRow(overrides: Partial<PostingRow> = {}): PostingRow {
  const now = new Date();
  return {
    id: "00000000-0000-4000-8000-000000000001",
    source: "test",
    sourceId: "1",
    dedupeHash: "hash",
    company: "Test Co",
    title: "Full Stack Developer",
    url: "https://example.com/job/1",
    locationText: "Brașov, Romania",
    workMode: "hybrid",
    locationTier: "tierA",
    description: "",
    postedAt: now,
    status: "approved",
    filterReasons: [],
    flags: [],
    raw: {},
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

/** Scripted fetch: each call takes the next response; records the parsed request bodies. */
export function scriptedFetch(responses: Array<(body: Record<string, unknown>) => Response>) {
  const calls: Record<string, unknown>[] = [];
  const fetchMock = async (_input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const body = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
    calls.push(body);
    const next = responses[Math.min(calls.length - 1, responses.length - 1)];
    if (!next) throw new Error("scriptedFetch: no response configured");
    return next(body);
  };
  return { fetchMock, calls };
}

export function toolCallResponse(name: string, args: unknown): Response {
  return new Response(
    JSON.stringify({ choices: [{ message: { tool_calls: [{ function: { name, arguments: JSON.stringify(args) } }] } }], usage: { prompt_tokens: 100, completion_tokens: 50 } }),
    { status: 200, headers: { "content-type": "application/json" } },
  );
}

export function jsonContentResponse(args: unknown): Response {
  return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify(args) } }], usage: {} }), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

export function errorResponse(status: number, message: string, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify({ error: { message } }), { status, headers });
}
