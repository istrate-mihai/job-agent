// src/ingest/gmail/message.ts
import type { gmail_v1 } from "googleapis";
import { extractLinks, type PageLink } from "../html/links.js";
import { htmlToText } from "../text.js";

export type EmailLink = PageLink;

export interface ParsedEmail {
  id: string;
  subject: string;
  from: string;
  receivedAt: Date | null;
  text: string;
  links: EmailLink[];
}

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
