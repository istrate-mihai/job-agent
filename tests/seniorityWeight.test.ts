// tests/seniorityWeight.test.ts
import { describe, expect, it } from "vitest";
import { weightSeniorityFit } from "../src/scoring/scorePosting.js";

describe("weightSeniorityFit", () => {
  it("weight 1 keeps the raw LLM score (old behaviour)", () => {
    expect(weightSeniorityFit(6, 1)).toBe(6);
    expect(weightSeniorityFit(15, 1)).toBe(15);
  });

  it("weight 0.5 halves the deficit, not the score", () => {
    expect(weightSeniorityFit(5, 0.5)).toBe(10); // deficit 10 → 5
    expect(weightSeniorityFit(15, 0.5)).toBe(15); // a perfect fit is never lowered
  });

  it("weight 0 removes the seniority penalty entirely", () => {
    expect(weightSeniorityFit(0, 0)).toBe(15);
  });

  it("clamps out-of-range model output", () => {
    expect(weightSeniorityFit(-3, 1)).toBe(0);
    expect(weightSeniorityFit(20, 0.5)).toBe(15);
  });
});
