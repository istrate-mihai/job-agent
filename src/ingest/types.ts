// src/ingest/types.ts
export type WorkMode = "remote" | "hybrid" | "onsite" | "unknown";

export interface NormalizedPosting {
  source: string;
  sourceId: string;
  company: string;
  title: string;
  url: string;
  locationText: string;
  workMode: WorkMode;
  remoteScope: string | null; // e.g. "Worldwide", "Europe", "USA only"
  description: string; // plain text, never rendered as HTML
  postedAt: Date | null;
  raw: unknown;
}

export interface JobSource {
  readonly name: string;
  readonly timeoutMs?: number; // default 30s; sources that call an LLM need longer
  fetch(signal: AbortSignal): Promise<NormalizedPosting[]>;
  /** Called only after this run's postings are stored; persist source-side progress here. */
  commit?(): Promise<void>;
}
