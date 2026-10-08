CREATE TYPE "public"."outreach_kind" AS ENUM('connect', 'message', 'email', 'followup');--> statement-breakpoint
CREATE TYPE "public"."outreach_status" AS ENUM('drafted', 'sent', 'replied');--> statement-breakpoint
CREATE TABLE "outreach" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"posting_id" uuid NOT NULL,
	"kind" "outreach_kind" NOT NULL,
	"status" "outreach_status" DEFAULT 'drafted' NOT NULL,
	"recipient_name" text,
	"recipient_role" varchar(32),
	"recipient_email" text,
	"subject" text,
	"body" text NOT NULL,
	"gmail_draft_id" varchar(64),
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"sent_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "outreach" ADD CONSTRAINT "outreach_posting_id_postings_id_fk" FOREIGN KEY ("posting_id") REFERENCES "public"."postings"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "outreach_posting_id_idx" ON "outreach" USING btree ("posting_id");