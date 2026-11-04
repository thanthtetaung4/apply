ALTER TABLE "browser_sessions" ADD COLUMN "status" text DEFAULT 'connected' NOT NULL;--> statement-breakpoint
ALTER TABLE "browser_sessions" ADD COLUMN "status_at" timestamp with time zone DEFAULT now() NOT NULL;--> statement-breakpoint
ALTER TABLE "browser_sessions" ADD CONSTRAINT "browser_sessions_status_ck" CHECK ("browser_sessions"."status" in ('connected', 'expired'));