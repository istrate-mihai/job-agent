CREATE TYPE "public"."decision_kind" AS ENUM('approve', 'skip');--> statement-breakpoint
CREATE TYPE "public"."recommendation" AS ENUM('apply', 'maybe', 'skip');--> statement-breakpoint
CREATE TYPE "public"."score_confidence" AS ENUM('high', 'low');--> statement-breakpoint
CREATE TABLE "decisions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"posting_id" uuid NOT NULL,
	"decision" "decision_kind" NOT NULL,
	"reason" text,
	"score_at_decision" integer,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "posting_scores" (
	"posting_id" uuid PRIMARY KEY NOT NULL,
	"total" integer NOT NULL,
	"components" jsonb NOT NULL,
	"recommendation" "recommendation" NOT NULL,
	"confidence" "score_confidence" NOT NULL,
	"seniority_match" varchar(8) NOT NULL,
	"primary_stack" text NOT NULL,
	"matched_skills" jsonb NOT NULL,
	"must_have_gaps" jsonb NOT NULL,
	"reasoning" text NOT NULL,
	"route" varchar(128) NOT NULL,
	"profile_hash" varchar(64) NOT NULL,
	"scored_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "decisions" ADD CONSTRAINT "decisions_posting_id_postings_id_fk" FOREIGN KEY ("posting_id") REFERENCES "public"."postings"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "posting_scores" ADD CONSTRAINT "posting_scores_posting_id_postings_id_fk" FOREIGN KEY ("posting_id") REFERENCES "public"."postings"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "decisions_posting_id_idx" ON "decisions" USING btree ("posting_id");