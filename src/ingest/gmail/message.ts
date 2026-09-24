// src/ingest/gmail/message.ts
import type { gmail_v1 } from "googleapis";
import { decodeEntities, htmlToText } from "../text.js";

export interface EmailLink {
  href: string;
  text: string;
}

export interface ParsedEmail {
  id: string;
  subject: string;
  from: string;
  receivedAt: Date | null;
  text: string;
  links: EmailLink[];
}

const MAX_LINKS = 200;
const SKIP_LINK_RE = /unsubscribe|dezabonare|preferences|settings|privacy|help|support|\/legal|facebook\.com|twitter\.com|x\.com\/|instagram\.com|youtube\.com|apps\.apple\.com|play\.google\.com/i;

function decodeBody(data: string | null | undefined): string {
  return data ? Buffer.from(data, "base64url").toString("utf8") : "";
}

function findPart(part: gmail_v1.Schema$MessagePart | undefined, mimeType: string): string | null {
  if (!part) return null;
  if (part.mimeType === mimeType && part.body?.data) return decodeBody(part.body.data);
  for (const child of part.parts ?? []) {
    const found = findPart(child, mimeType);
    if (found !== null) return found;
  }
  return null;
}

function header(message: gmail_v1.Schema$Message, name: string): string {
  const h = message.payload?.headers?.find((x) => x.name?.toLowerCase() === name.toLowerCase());
  return h?.value ?? "";
}

function extractLinks(html: string): EmailLink[] {
  const links = new Map<string, EmailLink>();
  const anchorRe = /<a\s[^>]*?href\s*=\s*["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi;
  for (const match of html.matchAll(anchorRe)) {
    const href = decodeEntities(match[1] ?? "").trim();
    const text = htmlToText(match[2] ?? "").replace(/\s+/g, " ").trim();
    if (!/^https?:\/\//i.test(href) || text.length < 2 || SKIP_LINK_RE.test(href)) continue;
    const existing = links.get(href);
    if (!existing || text.length > existing.text.length) links.set(href, { href, text }); // keep the most descriptive anchor
    if (links.size >= MAX_LINKS) break;
  }
  return [...links.values()];
}

export function parseMessage(message: gmail_v1.Schema$Message): ParsedEmail {
  const html = findPart(message.payload ?? undefined, "text/html");
  const plain = findPart(message.payload ?? undefined, "text/plain");
  const internalDate = message.internalDate ? new Date(Number(message.internalDate)) : null;
  return {
    id: message.id ?? "",
    subject: header(message, "Subject"),
    from: header(message, "From"),
    receivedAt: internalDate && !Number.isNaN(internalDate.getTime()) ? internalDate : null,
    text: html !== null ? htmlToText(html) : (plain ?? ""),
    links: html !== null ? extractLinks(html) : [],
  };
}
