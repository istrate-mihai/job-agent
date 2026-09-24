CREATE TYPE "public"."location_tier" AS ENUM('remote', 'tierA', 'tierB');--> statement-breakpoint
CREATE TYPE "public"."posting_status" AS ENUM('new', 'filtered_out', 'scored', 'tailored', 'approved', 'applied', 'responded', 'interview', 'offer', 'rejected', 'skipped');--> statement-breakpoint
CREATE TYPE "public"."work_mode" AS ENUM('remote', 'hybrid', 'onsite', 'unknown');--> statement-breakpoint
CREATE TABLE "postings" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"source" varchar(32) NOT NULL,
	"source_id" text NOT NULL,
	"dedupe_hash" varchar(64) NOT NULL,
	"company" text NOT NULL,
	"title" text NOT NULL,
	"url" text NOT NULL,
	"location_text" text NOT NULL,
	"work_mode" "work_mode" NOT NULL,
	"location_tier" "location_tier",
	"description" text NOT NULL,
	"posted_at" timestamp with time zone,
	"status" "posting_status" DEFAULT 'new' NOT NULL,
	"filter_reasons" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"flags" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"raw" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "postings_dedupe_hash_unique" UNIQUE("dedupe_hash")
);
--> statement-breakpoint
CREATE UNIQUE INDEX "postings_source_source_id_idx" ON "postings" USING btree ("source","source_id");