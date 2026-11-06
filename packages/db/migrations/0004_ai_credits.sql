CREATE TABLE "ai_credit_purchases" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"stripe_session_id" text NOT NULL,
	"credits" integer NOT NULL,
	"amount_cents" integer,
	"currency" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "ai_credits" (
	"user_id" uuid PRIMARY KEY NOT NULL,
	"balance" integer DEFAULT 0 NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "ai_credits_balance_ck" CHECK ("ai_credits"."balance" >= 0)
);
--> statement-breakpoint
CREATE TABLE "platform_ai_jobs" (
	"user_id" uuid NOT NULL,
	"job_id" text NOT NULL,
	"source" text NOT NULL,
	"at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "platform_ai_jobs_user_id_job_id_pk" PRIMARY KEY("user_id","job_id"),
	CONSTRAINT "platform_ai_jobs_source_ck" CHECK ("platform_ai_jobs"."source" in ('free', 'credit'))
);
--> statement-breakpoint
ALTER TABLE "ai_credit_purchases" ADD CONSTRAINT "ai_credit_purchases_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ai_credits" ADD CONSTRAINT "ai_credits_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "platform_ai_jobs" ADD CONSTRAINT "platform_ai_jobs_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "ai_credit_purchases_session_uq" ON "ai_credit_purchases" USING btree ("stripe_session_id");--> statement-breakpoint
CREATE INDEX "ai_credit_purchases_user_idx" ON "ai_credit_purchases" USING btree ("user_id","created_at");--> statement-breakpoint
CREATE INDEX "platform_ai_jobs_user_at_idx" ON "platform_ai_jobs" USING btree ("user_id","at");