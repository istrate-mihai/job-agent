// tests/router.test.ts
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import type { SearchConfig } from "../src/config/searchConfig.js";
import { errorResponse, jsonContentResponse, loadFixtureConfig, scriptedFetch, toolCallResponse } from "./helpers.js";

// No database in unit tests: usage logging and the daily budget are mocked
const usage = vi.hoisted(() => ({ tokensUsedToday: vi.fn(async () => 0), recordUsage: vi.fn(async () => undefined) }));
vi.mock("../src/llm/usage.js", () => usage);

const { generateStructured } = await import("../src/llm/router.js");
const { LlmBlockedError } = await import("../src/runtime/guard.js");

const schema = z.object({ ok: z.boolean(), note: z.string().min(3) });
const good = { ok: true, note: "fine" };
let config: SearchConfig;

beforeAll(async () => {
  config = await loadFixtureConfig();
});
afterEach(() => {
  vi.unstubAllGlobals();
  usage.tokensUsedToday.mockResolvedValue(0);
});

const request = () => ({ task: "scoring" as const, system: "s", user: "u", schema, toolName: "record", toolDescription: "d", maxTokens: 100, signal: AbortSignal.timeout(10_000) });
const modelOf = (body: Record<string, unknown>): unknown => body["model"];

describe("generateStructured", () => {
  it("returns validated data from the first route", async () => {
    const { fetchMock, calls } = scriptedFetch([() => toolCallResponse("record", good)]);
    vi.stubGlobal("fetch", fetchMock);
    const r = await generateStructured(config, request());
    expect(r).toEqual({ data: good, route: "groq/openai/gpt-oss-120b" });
    expect(calls[0]?.["tool_choice"]).toBeDefined();
    expect(calls[0]?.["reasoning_effort"]).toBe("low");
  });

  it("retries the same model in JSON mode after a broken tool call", async () => {
    const { fetchMock, calls } = scriptedFetch([
      () => errorResponse(400, "Tool choice is required, but model did not call a tool"),
      () => jsonContentResponse(good),
    ]);
    vi.stubGlobal("fetch", fetchMock);
    const r = await generateStructured(config, request());
    expect(r.route).toBe("groq/openai/gpt-oss-120b");
    expect(calls[1]?.["tools"]).toBeUndefined();
    expect(calls[1]?.["response_format"]).toEqual({ type: "json_object" });
  });

  it("waits for a short rate limit (wait parsed from the error body) and retries", async () => {
    const { fetchMock, calls } = scriptedFetch([() => errorResponse(429, "Rate limit reached. Please try again in 0.01s."), () => toolCallResponse("record", good)]);
    vi.stubGlobal("fetch", fetchMock);
    await generateStructured(config, request());
    expect(calls.map(modelOf)).toEqual(["openai/gpt-oss-120b", "openai/gpt-oss-120b"]);
  });

  it("moves to the next route on a long rate limit", async () => {
    const { fetchMock, calls } = scriptedFetch([(b) => (modelOf(b) === "openai/gpt-oss-120b" ? errorResponse(429, "Please try again in 2m10s.") : toolCallResponse("record", good))]);
    vi.stubGlobal("fetch", fetchMock);
    const r = await generateStructured(config, request());
    expect(r.route).toBe("groq/openai/gpt-oss-20b");
    expect(calls).toHaveLength(2);
  });

  it("retries an overloaded provider (503) when it says to", async () => {
    const { fetchMock, calls } = scriptedFetch([() => errorResponse(503, "high demand", { "retry-after": "0" }), () => toolCallResponse("record", good)]);
    vi.stubGlobal("fetch", fetchMock);
    await generateStructured(config, request());
    expect(calls).toHaveLength(2);
  });

  it("feeds validation errors back to the model for one repair", async () => {
    const { fetchMock, calls } = scriptedFetch([() => toolCallResponse("record", { ok: true, note: "x" }), () => toolCallResponse("record", good)]);
    vi.stubGlobal("fetch", fetchMock);
    await generateStructured(config, request());
    const messages = calls[1]?.["messages"] as { content: string }[];
    expect(messages[1]?.content).toContain("failed validation");
  });

  it("throws with every route's reason when all routes fail", async () => {
    const { fetchMock } = scriptedFetch([() => errorResponse(500, "boom")]);
    vi.stubGlobal("fetch", fetchMock);
    await expect(generateStructured(config, request())).rejects.toThrow(/All LLM routes failed for task "scoring"/);
  });

  it("stops before calling any provider when the daily budget is spent", async () => {
    usage.tokensUsedToday.mockResolvedValue(Number.MAX_SAFE_INTEGER);
    const spy = vi.fn();
    vi.stubGlobal("fetch", spy);
    await expect(generateStructured(config, request())).rejects.toBeInstanceOf(LlmBlockedError);
    expect(spy).not.toHaveBeenCalled();
  });
});
