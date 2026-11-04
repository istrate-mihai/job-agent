CREATE TYPE "public"."rejection_status" AS ENUM('pending', 'auto', 'confirmed', 'ignored', 'undone', 'unmatched');--> statement-breakpoint
CREATE TABLE "rejection_candidates" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"message_id" varchar(64) NOT NULL,
	"thread_id" varchar(64),
	"posting_id" uuid,
	"confidence" varchar(8) DEFAULT 'low' NOT NULL,
	"status" "rejection_status" DEFAULT 'pending' NOT NULL,
	"subject" text NOT NULL,
	"sender" text NOT NULL,
	"snippet" text DEFAULT '' NOT NULL,
	"reason" text DEFAULT '' NOT NULL,
	"previous_status" "posting_status",
	"received_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"resolved_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "rejection_candidates" ADD CONSTRAINT "rejection_candidates_posting_id_postings_id_fk" FOREIGN KEY ("posting_id") REFERENCES "public"."postings"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "rejection_candidates_message_id_idx" ON "rejection_candidates" USING btree ("message_id");--> statement-breakpoint
CREATE INDEX "rejection_candidates_posting_id_idx" ON "rejection_candidates" USING btree ("posting_id");--> statement-breakpoint
CREATE UNIQUE INDEX "rejection_candidates_message_posting_idx" ON "rejection_candidates" USING btree ("message_id","posting_id");