// src/ingest/html/robots.ts
// Minimal robots.txt support for listing-page sources: groups for "*" (or our agent token),
// Allow/Disallow prefixes with "*" and "$", longest match wins (RFC 9309).

export interface RobotsRules {
  allow: string[];
  disallow: string[];
}

const AGENT_TOKEN = "job-agent";

function groupApplies(agents: string[], token: string): "exact" | "wildcard" | null {
  if (agents.some((a) => a.toLowerCase() === token)) return "exact";
  if (agents.includes("*")) return "wildcard";
  return null;
}

export function parseRobots(body: string, token = AGENT_TOKEN): RobotsRules {
  const groups: { agents: string[]; rules: RobotsRules }[] = [];
  let current: { agents: string[]; rules: RobotsRules } | null = null;
  let lastWasAgent = false;

  for (const rawLine of body.split(/\r?\n/)) {
    const line = rawLine.replace(/#.*$/, "").trim();
    const m = /^([a-z-]+)\s*:\s*(.*)$/i.exec(line);
    if (!m) continue;
    const key = (m[1] ?? "").toLowerCase();
    const value = (m[2] ?? "").trim();
    if (key === "user-agent") {
      if (!current || !lastWasAgent) {
        current = { agents: [], rules: { allow: [], disallow: [] } };
        groups.push(current);
      }
      current.agents.push(value);
      lastWasAgent = true;
      continue;
    }
    lastWasAgent = false;
    if (!current || value === "") continue; // "Disallow:" (empty) = allow everything
    if (key === "allow") current.rules.allow.push(value);
    if (key === "disallow") current.rules.disallow.push(value);
  }

  const exact = groups.filter((g) => groupApplies(g.agents, token) === "exact");
  const chosen = exact.length > 0 ? exact : groups.filter((g) => groupApplies(g.agents, token) === "wildcard");
  return {
    allow: chosen.flatMap((g) => g.rules.allow),
    disallow: chosen.flatMap((g) => g.rules.disallow),
  };
}

function patternLength(pattern: string, path: string): number {
  const anchored = pattern.endsWith("$");
  const body = (anchored ? pattern.slice(0, -1) : pattern)
    .split("*")
    .map((part) => part.replace(/[.+?^${}()|[\]\\]/g, "\\$&"))
    .join(".*");
  return new RegExp(`^${body}${anchored ? "$" : ""}`).test(path) ? pattern.length : -1;
}

/** `pathAndQuery` like "/jobs?page=2". */
export function isAllowed(rules: RobotsRules, pathAndQuery: string): boolean {
  const best = (patterns: string[]): number => Math.max(-1, ...patterns.map((p) => patternLength(p, pathAndQuery)));
  const allow = best(rules.allow);
  const disallow = best(rules.disallow);
  return disallow < 0 || allow >= disallow;
}
