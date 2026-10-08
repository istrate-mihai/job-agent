// src/db/schema.ts
import { index, integer, jsonb, pgEnum, pgTable, text, timestamp, uniqueIndex, uuid, varchar } from "drizzle-orm/pg-core";

export const locationTier = pgEnum("location_tier", ["remote", "tierA", "tierB"]);
export const workMode = pgEnum("work_mode", ["remote", "hybrid", "onsite", "unknown"]);
export const postingStatus = pgEnum("posting_status", [
  "new",
  "filtered_out",
  "scored",
  "tailored",
  "approved",
  "applied",
  "responded",
  "interview",
  "offer",
  "rejected",
  "skipped",
]);

export const postings = pgTable(
  "postings",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    source: varchar("source", { length: 32 }).notNull(),
    sourceId: text("source_id").notNull(),
    dedupeHash: varchar("dedupe_hash", { length: 64 }).notNull().unique(), // same job across sources collapses
    company: text("company").notNull(),
    title: text("title").notNull(),
    url: text("url").notNull(),
    locationText: text("location_text").notNull(),
    workMode: workMode("work_mode").notNull(),
    locationTier: locationTier("location_tier"), // null when filtered out on location
    description: text("description").notNull(),
    postedAt: timestamp("posted_at", { withTimezone: true }),
    status: postingStatus("status").notNull().default("new"),
    filterReasons: jsonb("filter_reasons").$type<string[]>().notNull().default([]),
    flags: jsonb("flags").$type<string[]>().notNull().default([]),
    raw: jsonb("raw").$type<unknown>().notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (t) => [uniqueIndex("postings_source_source_id_idx").on(t.source, t.sourceId)],
);

export type PostingRow = typeof postings.$inferSelect;
export type NewPostingRow = typeof postings.$inferInsert;

// Alert emails already processed: prevents re-extraction (and re-paying the LLM) on every run
export const gmailMessages = pgTable("gmail_messages", {
  id: varchar("id", { length: 64 }).primaryKey(),
  subject: text("subject").notNull(),
  jobCount: integer("job_count").notNull(),
  processedAt: timestamp("processed_at", { withTimezone: true }).notNull().defaultNow(),
});

// Every LLM call is logged: feeds the daily token budget and the real cost numbers for your CV bullet
export const llmUsage = pgTable(
  "llm_usage",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    purpose: varchar("purpose", { length: 32 }).notNull(), // "gmail-extract" | "score" | "tailor"
    model: varchar("model", { length: 64 }).notNull(),
    inputTokens: integer("input_tokens").notNull(),
    outputTokens: integer("output_tokens").notNull(),
    cacheReadTokens: integer("cache_read_tokens").notNull().default(0),
    cacheWriteTokens: integer("cache_write_tokens").notNull().default(0),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("llm_usage_created_at_idx").on(t.createdAt)],
);

export const recommendation = pgEnum("recommendation", ["apply", "maybe", "skip"]);
export const scoreConfidence = pgEnum("score_confidence", ["high", "low"]);
export const decisionKind = pgEnum("decision_kind", ["approve", "skip"]);

export interface ScoreComponents {
  mustHaveCoverage: number; // 0-40, LLM
  stackOverlap: number; // 0-20, LLM
  seniorityFit: number; // 0-15, LLM
  goalAlignment: number; // 0-10, LLM
  locationFit: number; // 0-15, computed from location tier
  penalties: string[]; // deterministic caps applied in code
}

// One score per posting; re-scoring overwrites. profileHash shows which CV version produced it.
export const postingScores = pgTable("posting_scores", {
  postingId: uuid("posting_id")
    .primaryKey()
    .references(() => postings.id, { onDelete: "cascade" }),
  total: integer("total").notNull(),
  components: jsonb("components").$type<ScoreComponents>().notNull(),
  recommendation: recommendation("recommendation").notNull(),
  confidence: scoreConfidence("confidence").notNull(),
  seniorityMatch: varchar("seniority_match", { length: 8 }).notNull(),
  primaryStack: text("primary_stack").notNull(),
  matchedSkills: jsonb("matched_skills").$type<string[]>().notNull(),
  mustHaveGaps: jsonb("must_have_gaps").$type<string[]>().notNull(),
  reasoning: text("reasoning").notNull(),
  route: varchar("route", { length: 128 }).notNull(),
  profileHash: varchar("profile_hash", { length: 64 }).notNull(),
  scoredAt: timestamp("scored_at", { withTimezone: true }).notNull().defaultNow(),
});

// Your approve/skip calls: the ground truth used to calibrate scoring weights later
export const decisions = pgTable(
  "decisions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    postingId: uuid("posting_id")
      .notNull()
      .references(() => postings.id, { onDelete: "cascade" }),
    decision: decisionKind("decision").notNull(),
    reason: text("reason"),
    scoreAtDecision: integer("score_at_decision"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("decisions_posting_id_idx").on(t.postingId)],
);

export type PostingScoreRow = typeof postingScores.$inferSelect;

export interface TailoringSelection {
  roleFocus: string;
  experienceFactIds: string[]; // ordered; every id exists in master-cv.json
  projectIds: string[];
  projectFactIds: string[];
  prioritySkills: string[];
}

// One tailored application per posting; re-tailoring overwrites. The PDF lives on disk at outputDir.
export const tailorings = pgTable("tailorings", {
  postingId: uuid("posting_id")
    .primaryKey()
    .references(() => postings.id, { onDelete: "cascade" }),
  selection: jsonb("selection").$type<TailoringSelection>().notNull(),
  summary: text("summary").notNull(),
  coverNote: text("cover_note").notNull(),
  language: varchar("language", { length: 2 }).notNull(),
  warnings: jsonb("warnings").$type<string[]>().notNull(),
  route: varchar("route", { length: 128 }).notNull(),
  profileHash: varchar("profile_hash", { length: 64 }).notNull(),
  outputDir: text("output_dir").notNull(),
  pdfPages: integer("pdf_pages").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

// Application history (applied → responded → interview → offer/rejected): feeds follow-ups and metrics
export const statusEvents = pgTable(
  "status_events",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    postingId: uuid("posting_id")
      .notNull()
      .references(() => postings.id, { onDelete: "cascade" }),
    fromStatus: postingStatus("from_status").notNull(),
    toStatus: postingStatus("to_status").notNull(),
    note: text("note"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("status_events_posting_id_idx").on(t.postingId)],
);

// Recruiter / hiring-manager outreach and follow-ups. Messages are drafted here and sent by YOU (never automatically):
// "drafted" → you copy/send it → `npm run outreach -- sent <id>` → "sent" → "replied" when they answer.
export const outreachKind = pgEnum("outreach_kind", ["connect", "message", "email", "followup"]);
export const outreachStatus = pgEnum("outreach_status", ["drafted", "sent", "replied"]);

export const outreach = pgTable(
  "outreach",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    postingId: uuid("posting_id")
      .notNull()
      .references(() => postings.id, { onDelete: "cascade" }),
    kind: outreachKind("kind").notNull(),
    status: outreachStatus("status").notNull().default("drafted"),
    recipientName: text("recipient_name"),
    recipientRole: varchar("recipient_role", { length: 32 }),
    recipientEmail: text("recipient_email"),
    subject: text("subject"),
    body: text("body").notNull(),
    gmailDraftId: varchar("gmail_draft_id", { length: 64 }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    sentAt: timestamp("sent_at", { withTimezone: true }),
  },
  (t) => [index("outreach_posting_id_idx").on(t.postingId)],
);

export type OutreachRow = typeof outreach.$inferSelect;
