CREATE TABLE "answers_seen" (
	"user_id" uuid NOT NULL,
	"question" text NOT NULL,
	"answer" text DEFAULT '' NOT NULL,
	"source" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "answers_seen_user_id_question_pk" PRIMARY KEY("user_id","question")
);
--> statement-breakpoint
CREATE TABLE "api_tokens" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"name" text NOT NULL,
	"prefix" text NOT NULL,
	"token_hash" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_used_at" timestamp with time zone,
	"revoked_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "applications" (
	"user_id" uuid NOT NULL,
	"job_id" text NOT NULL,
	"status" text NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"resume_artifact_id" uuid,
	"backend" text,
	"started_at" timestamp with time zone,
	"finished_at" timestamp with time zone,
	"error" text,
	"block_kind" text,
	"tokens_in" integer DEFAULT 0 NOT NULL,
	"tokens_out" integer DEFAULT 0 NOT NULL,
	"cost_usd" double precision DEFAULT 0 NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "applications_user_id_job_id_pk" PRIMARY KEY("user_id","job_id"),
	CONSTRAINT "applications_status_ck" CHECK ("applications"."status" in ('queued', 'tailoring', 'ready', 'filling', 'verifying', 'ready_to_submit', 'submitted', 'submitted_unconfirmed', 'needs_human', 'failed', 'skipped'))
);
--> statement-breakpoint
CREATE TABLE "artifacts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"job_id" text NOT NULL,
	"kind" text NOT NULL,
	"name" text NOT NULL,
	"content_type" text NOT NULL,
	"size" integer NOT NULL,
	"data" "bytea" NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "artifacts_kind_ck" CHECK ("artifacts"."kind" in ('resume_pdf', 'screenshot', 'record', 'tailor'))
);
--> statement-breakpoint
CREATE TABLE "auth_sessions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"token_hash" text NOT NULL,
	"user_agent" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "auth_throttle" (
	"key" text PRIMARY KEY NOT NULL,
	"failures" integer DEFAULT 0 NOT NULL,
	"window_start" timestamp with time zone DEFAULT now() NOT NULL,
	"locked_until" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "board_map" (
	"user_id" uuid NOT NULL,
	"job_id" text NOT NULL,
	"board_id" text NOT NULL,
	"last_stage" text,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "board_map_user_id_job_id_pk" PRIMARY KEY("user_id","job_id")
);
--> statement-breakpoint
CREATE TABLE "board_outbox" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"user_id" uuid NOT NULL,
	"job_id" text NOT NULL,
	"payload" jsonb NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "browser_sessions" (
	"user_id" uuid NOT NULL,
	"key" text NOT NULL,
	"ciphertext" text NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "browser_sessions_user_id_key_pk" PRIMARY KEY("user_id","key")
);
--> statement-breakpoint
CREATE TABLE "events" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"user_id" uuid NOT NULL,
	"job_id" text NOT NULL,
	"ts" timestamp with time zone DEFAULT now() NOT NULL,
	"type" text NOT NULL,
	"payload" jsonb
);
--> statement-breakpoint
CREATE TABLE "jobs" (
	"user_id" uuid NOT NULL,
	"id" text NOT NULL,
	"source" text NOT NULL,
	"source_url" text,
	"title" text NOT NULL,
	"company" text NOT NULL,
	"location" text,
	"description" text DEFAULT '' NOT NULL,
	"apply_url" text NOT NULL,
	"apply_target" text NOT NULL,
	"posted_at" text,
	"fetched_at" timestamp with time zone NOT NULL,
	"match_score" integer,
	CONSTRAINT "jobs_user_id_id_pk" PRIMARY KEY("user_id","id"),
	CONSTRAINT "jobs_source_ck" CHECK ("jobs"."source" in ('indeed', 'linkedin', 'glassdoor')),
	CONSTRAINT "jobs_apply_target_ck" CHECK ("jobs"."apply_target" in ('board_native', 'greenhouse', 'workday', 'company_site'))
);
--> statement-breakpoint
CREATE TABLE "llm_cache" (
	"user_id" uuid NOT NULL,
	"key" text NOT NULL,
	"task" text NOT NULL,
	"response" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "llm_cache_user_id_key_pk" PRIMARY KEY("user_id","key")
);
--> statement-breakpoint
CREATE TABLE "llm_usage" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"user_id" uuid NOT NULL,
	"job_id" text,
	"task" text NOT NULL,
	"model" text NOT NULL,
	"tokens_in" integer DEFAULT 0 NOT NULL,
	"tokens_out" integer DEFAULT 0 NOT NULL,
	"cost_usd" double precision DEFAULT 0 NOT NULL,
	"cached" boolean DEFAULT false NOT NULL,
	"ts" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "metrics" (
	"user_id" uuid NOT NULL,
	"job_id" text NOT NULL,
	"site_type" text NOT NULL,
	"backend" text NOT NULL,
	"duration_ms" integer NOT NULL,
	"steps" integer DEFAULT 0 NOT NULL,
	"fields_total" integer DEFAULT 0 NOT NULL,
	"fields_rule" integer DEFAULT 0 NOT NULL,
	"fields_bank" integer DEFAULT 0 NOT NULL,
	"fields_model" integer DEFAULT 0 NOT NULL,
	"verify" text NOT NULL,
	"outcome" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "metrics_user_id_job_id_pk" PRIMARY KEY("user_id","job_id")
);
--> statement-breakpoint
CREATE TABLE "profile_files" (
	"user_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"content" text DEFAULT '' NOT NULL,
	"revision" integer DEFAULT 1 NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "profile_files_user_id_kind_pk" PRIMARY KEY("user_id","kind"),
	CONSTRAINT "profile_files_kind_ck" CHECK ("profile_files"."kind" in ('resume', 'titles', 'projects', 'answers'))
);
--> statement-breakpoint
CREATE TABLE "shadow_runs" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"user_id" uuid NOT NULL,
	"job_id" text NOT NULL,
	"backend" text NOT NULL,
	"ok" boolean NOT NULL,
	"error" text,
	"fields_compared" integer DEFAULT 0 NOT NULL,
	"diff_count" integer DEFAULT 0 NOT NULL,
	"duration_ms" integer DEFAULT 0 NOT NULL,
	"diffs" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "task_logs" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"task_id" uuid NOT NULL,
	"ts" timestamp with time zone DEFAULT now() NOT NULL,
	"level" text DEFAULT 'info' NOT NULL,
	"message" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "tasks" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"type" text NOT NULL,
	"payload" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"status" text DEFAULT 'queued' NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"locked_by" text,
	"heartbeat_at" timestamp with time zone,
	"cancel_requested" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"started_at" timestamp with time zone,
	"finished_at" timestamp with time zone,
	"error" text,
	"result" jsonb,
	CONSTRAINT "tasks_type_ck" CHECK ("tasks"."type" in ('intake', 'run')),
	CONSTRAINT "tasks_status_ck" CHECK ("tasks"."status" in ('queued', 'running', 'succeeded', 'failed', 'canceled'))
);
--> statement-breakpoint
CREATE TABLE "user_secrets" (
	"user_id" uuid NOT NULL,
	"name" text NOT NULL,
	"ciphertext" text NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "user_secrets_user_id_name_pk" PRIMARY KEY("user_id","name")
);
--> statement-breakpoint
CREATE TABLE "user_settings" (
	"user_id" uuid PRIMARY KEY NOT NULL,
	"settings" jsonb NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "users" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"email" text NOT NULL,
	"name" text,
	"password_hash" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"disabled_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "answers_seen" ADD CONSTRAINT "answers_seen_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "api_tokens" ADD CONSTRAINT "api_tokens_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "applications" ADD CONSTRAINT "applications_user_id_job_id_jobs_user_id_id_fk" FOREIGN KEY ("user_id","job_id") REFERENCES "public"."jobs"("user_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "artifacts" ADD CONSTRAINT "artifacts_user_id_job_id_jobs_user_id_id_fk" FOREIGN KEY ("user_id","job_id") REFERENCES "public"."jobs"("user_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "auth_sessions" ADD CONSTRAINT "auth_sessions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "board_map" ADD CONSTRAINT "board_map_user_id_job_id_jobs_user_id_id_fk" FOREIGN KEY ("user_id","job_id") REFERENCES "public"."jobs"("user_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "board_outbox" ADD CONSTRAINT "board_outbox_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "browser_sessions" ADD CONSTRAINT "browser_sessions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "events" ADD CONSTRAINT "events_user_id_job_id_jobs_user_id_id_fk" FOREIGN KEY ("user_id","job_id") REFERENCES "public"."jobs"("user_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "jobs" ADD CONSTRAINT "jobs_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "llm_cache" ADD CONSTRAINT "llm_cache_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "llm_usage" ADD CONSTRAINT "llm_usage_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "metrics" ADD CONSTRAINT "metrics_user_id_job_id_jobs_user_id_id_fk" FOREIGN KEY ("user_id","job_id") REFERENCES "public"."jobs"("user_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "profile_files" ADD CONSTRAINT "profile_files_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "shadow_runs" ADD CONSTRAINT "shadow_runs_user_id_job_id_jobs_user_id_id_fk" FOREIGN KEY ("user_id","job_id") REFERENCES "public"."jobs"("user_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "task_logs" ADD CONSTRAINT "task_logs_task_id_tasks_id_fk" FOREIGN KEY ("task_id") REFERENCES "public"."tasks"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tasks" ADD CONSTRAINT "tasks_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_secrets" ADD CONSTRAINT "user_secrets_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_settings" ADD CONSTRAINT "user_settings_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "api_tokens_hash_uq" ON "api_tokens" USING btree ("token_hash");--> statement-breakpoint
CREATE INDEX "api_tokens_user_idx" ON "api_tokens" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "applications_user_status_idx" ON "applications" USING btree ("user_id","status");--> statement-breakpoint
CREATE UNIQUE INDEX "artifacts_job_kind_name_uq" ON "artifacts" USING btree ("user_id","job_id","kind","name");--> statement-breakpoint
CREATE INDEX "artifacts_user_job_idx" ON "artifacts" USING btree ("user_id","job_id");--> statement-breakpoint
CREATE UNIQUE INDEX "auth_sessions_token_uq" ON "auth_sessions" USING btree ("token_hash");--> statement-breakpoint
CREATE INDEX "auth_sessions_user_idx" ON "auth_sessions" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "board_outbox_user_idx" ON "board_outbox" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "events_job_idx" ON "events" USING btree ("user_id","job_id","id");--> statement-breakpoint
CREATE INDEX "jobs_user_company_idx" ON "jobs" USING btree ("user_id","company","title");--> statement-breakpoint
CREATE INDEX "jobs_user_apply_url_idx" ON "jobs" USING btree ("user_id","apply_url");--> statement-breakpoint
CREATE INDEX "llm_usage_user_ts_idx" ON "llm_usage" USING btree ("user_id","ts");--> statement-breakpoint
CREATE INDEX "metrics_user_site_idx" ON "metrics" USING btree ("user_id","site_type");--> statement-breakpoint
CREATE INDEX "shadow_runs_user_idx" ON "shadow_runs" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "task_logs_task_idx" ON "task_logs" USING btree ("task_id","id");--> statement-breakpoint
CREATE INDEX "tasks_status_idx" ON "tasks" USING btree ("status","created_at");--> statement-breakpoint
CREATE INDEX "tasks_user_idx" ON "tasks" USING btree ("user_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "tasks_one_running_per_user" ON "tasks" USING btree ("user_id") WHERE "tasks"."status" = 'running';--> statement-breakpoint
CREATE UNIQUE INDEX "tasks_one_queued_per_type" ON "tasks" USING btree ("user_id","type") WHERE "tasks"."status" = 'queued';--> statement-breakpoint
CREATE UNIQUE INDEX "users_email_uq" ON "users" USING btree ("email");