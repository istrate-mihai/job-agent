CREATE TABLE "status_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"posting_id" uuid NOT NULL,
	"from_status" "posting_status" NOT NULL,
	"to_status" "posting_status" NOT NULL,
	"note" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "tailorings" (
	"posting_id" uuid PRIMARY KEY NOT NULL,
	"selection" jsonb NOT NULL,
	"summary" text NOT NULL,
	"cover_note" text NOT NULL,
	"language" varchar(2) NOT NULL,
	"warnings" jsonb NOT NULL,
	"route" varchar(128) NOT NULL,
	"profile_hash" varchar(64) NOT NULL,
	"output_dir" text NOT NULL,
	"pdf_pages" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "status_events" ADD CONSTRAINT "status_events_posting_id_postings_id_fk" FOREIGN KEY ("posting_id") REFERENCES "public"."postings"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tailorings" ADD CONSTRAINT "tailorings_posting_id_postings_id_fk" FOREIGN KEY ("posting_id") REFERENCES "public"."postings"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "status_events_posting_id_idx" ON "status_events" USING btree ("posting_id");