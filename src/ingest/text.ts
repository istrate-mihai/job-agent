// src/ingest/text.ts
import { createHash } from "node:crypto";
import type { NormalizedPosting, WorkMode } from "./types.js";

const NAMED_ENTITIES: Readonly<Record<string, string>> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: " ",
};

export function decodeEntities(input: string): string {
  return input.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (match: string, entity: string) => {
    if (entity.startsWith("#")) {
      const isHex = entity[1]?.toLowerCase() === "x";
      const code = Number.parseInt(entity.slice(isHex ? 2 : 1), isHex ? 16 : 10);
      return Number.isInteger(code) && code >= 0 && code <= 0x10ffff ? String.fromCodePoint(code) : match;
    }
    return NAMED_ENTITIES[entity.toLowerCase()] ?? match;
  });
}

// ⚠ Security: text extraction only, NOT sanitization. Output must never be injected as HTML.
export function htmlToText(html: string): string {
  const unescaped = decodeEntities(html); // Greenhouse returns entity-escaped HTML
  const text = unescaped
    .replace(/<(script|style)[^>]*>[\s\S]*?<\/\1>/gi, "")
    .replace(/<li[^>]*>/gi, "\n- ")
    .replace(/<(p|div|tr|h[1-6])(\s[^>]*)?>/gi, "\n") // block starts: keeps "Title" and "Company" on separate lines
    .replace(/<(br|\/p|\/li|\/div|\/h[1-6]|\/ul|\/ol)\s*\/?>/gi, "\n")
    .replace(/<[^>]+>/g, "");
  return decodeEntities(text)
    .replace(/[ \t\u00a0]+/g, " ")
    .replace(/ *\n */g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/** Lowercase, strip diacritics (ș→s, ă→a), treat separators as spaces. */
export function normalizeText(input: string): string {
  return input
    .normalize("NFD")
    .replace(/\p{Diacritic}/gu, "")
    .toLowerCase()
    .replace(/[-_/|,;:()[\]]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

const escapeRegex = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** Whole-term match on normalized text, so "intern" does not match "internal". */
export function hasTerm(normalizedHaystack: string, term: string): boolean {
  const needle = normalizeText(term);
  if (needle.length === 0) return false;
  return new RegExp(`(^|[^a-z0-9])${escapeRegex(needle)}($|[^a-z0-9])`).test(normalizedHaystack);
}

export function inferWorkMode(...texts: string[]): WorkMode {
  const haystack = normalizeText(texts.join(" "));
  if (hasTerm(haystack, "hybrid")) return "hybrid"; // "hybrid/remote" → treat as the stricter option
  if (hasTerm(haystack, "remote") || hasTerm(haystack, "work from home")) return "remote";
  if (hasTerm(haystack, "on site") || hasTerm(haystack, "onsite") || hasTerm(haystack, "in office")) return "onsite";
  return "unknown";
}

export function parseDate(value: string | number | null | undefined): Date | null {
  if (value === null || value === undefined || value === "") return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

export function dedupeHash(p: Pick<NormalizedPosting, "company" | "title" | "locationText">): string {
  const key = [p.company, p.title, p.locationText].map(normalizeText).join("|");
  return createHash("sha256").update(key).digest("hex");
}
