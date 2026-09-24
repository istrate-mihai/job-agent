// src/db/schema.ts
import { jsonb, pgEnum, pgTable, text, timestamp, uniqueIndex, uuid, varchar } from "drizzle-orm/pg-core";

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
