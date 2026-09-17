CREATE TABLE "account" (
	"id" text PRIMARY KEY NOT NULL,
	"issuer" text NOT NULL,
	"account_id" text NOT NULL,
	"provider_id" text NOT NULL,
	"user_id" text NOT NULL,
	"access_token" text,
	"refresh_token" text,
	"id_token" text,
	"access_token_expires_at" timestamp,
	"refresh_token_expires_at" timestamp,
	"scope" text,
	"password" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp NOT NULL
);
--> statement-breakpoint
CREATE TABLE "session" (
	"id" text PRIMARY KEY NOT NULL,
	"expires_at" timestamp NOT NULL,
	"token" text NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp NOT NULL,
	"ip_address" text,
	"user_agent" text,
	"user_id" text NOT NULL,
	CONSTRAINT "session_token_unique" UNIQUE("token")
);
--> statement-breakpoint
CREATE TABLE "user" (
	"id" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"email" text NOT NULL,
	"email_verified" boolean DEFAULT false NOT NULL,
	"image" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "user_email_unique" UNIQUE("email")
);
--> statement-breakpoint
CREATE TABLE "verification" (
	"id" text PRIMARY KEY NOT NULL,
	"identifier" text NOT NULL,
	"value" text NOT NULL,
	"expires_at" timestamp NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "audience" (
	"id" text PRIMARY KEY NOT NULL,
	"workspace_id" text NOT NULL,
	"name" text NOT NULL,
	"filter" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "contact" (
	"id" text PRIMARY KEY NOT NULL,
	"workspace_id" text NOT NULL,
	"email" text NOT NULL,
	"user_id" text,
	"properties" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"subscribed" boolean DEFAULT true NOT NULL,
	"unsubscribed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "contact_event" (
	"id" text PRIMARY KEY NOT NULL,
	"workspace_id" text NOT NULL,
	"contact_id" text NOT NULL,
	"name" text NOT NULL,
	"properties" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"idempotency_key" text,
	"occurred_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "email_delivery" (
	"id" text PRIMARY KEY NOT NULL,
	"send_id" text NOT NULL,
	"type" text NOT NULL,
	"url" text,
	"raw" jsonb,
	"occurred_at" timestamp with time zone NOT NULL,
	"provider_event_id" text
);
--> statement-breakpoint
CREATE TABLE "email_send" (
	"id" text PRIMARY KEY NOT NULL,
	"workspace_id" text NOT NULL,
	"contact_id" text NOT NULL,
	"template_id" text,
	"journey_id" text,
	"journey_run_id" text,
	"instance_id" text,
	"node_id" text,
	"to_email" text NOT NULL,
	"subject" text NOT NULL,
	"provider" text NOT NULL,
	"provider_message_id" text,
	"status" text NOT NULL,
	"error" text,
	"idempotency_key" text NOT NULL,
	"sent_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "email_template" (
	"id" text PRIMARY KEY NOT NULL,
	"workspace_id" text NOT NULL,
	"name" text NOT NULL,
	"subject" text NOT NULL,
	"html" text NOT NULL,
	"text_body" text,
	"from_name" text,
	"from_email" text,
	"reply_to" text,
	"source" text DEFAULT 'html' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "wf_dlq" (
	"id" text PRIMARY KEY NOT NULL,
	"data" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "wf_event" (
	"id" text PRIMARY KEY NOT NULL,
	"instance_id" text NOT NULL,
	"workflow_id" text NOT NULL,
	"event_type" text NOT NULL,
	"timestamp" bigint NOT NULL,
	"payload" jsonb,
	"metadata" jsonb
);
--> statement-breakpoint
CREATE TABLE "wf_event_wait" (
	"instance_id" text NOT NULL,
	"node_id" text NOT NULL,
	"event_type" text NOT NULL,
	"deadline" bigint,
	"data" jsonb NOT NULL,
	CONSTRAINT "wf_event_wait_instance_id_node_id_pk" PRIMARY KEY("instance_id","node_id")
);
--> statement-breakpoint
CREATE TABLE "wf_heartbeat" (
	"instance_id" text NOT NULL,
	"node_id" text NOT NULL,
	"deadline" bigint NOT NULL,
	"data" jsonb NOT NULL,
	CONSTRAINT "wf_heartbeat_instance_id_node_id_pk" PRIMARY KEY("instance_id","node_id")
);
--> statement-breakpoint
CREATE TABLE "wf_instance" (
	"instance_id" text PRIMARY KEY NOT NULL,
	"workflow_id" text NOT NULL,
	"status" text NOT NULL,
	"parent_instance_id" text,
	"version" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL,
	"data" jsonb NOT NULL
);
--> statement-breakpoint
CREATE TABLE "wf_node_metric" (
	"instance_id" text NOT NULL,
	"node_id" text NOT NULL,
	"workflow_id" text NOT NULL,
	"node_type" text,
	"status" text,
	"start_time" bigint,
	"end_time" bigint,
	"duration" integer,
	"retry_count" integer DEFAULT 0 NOT NULL,
	"data" jsonb NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "wf_node_metric_instance_id_node_id_pk" PRIMARY KEY("instance_id","node_id")
);
--> statement-breakpoint
CREATE TABLE "wf_webhook" (
	"id" text PRIMARY KEY NOT NULL,
	"kind" text NOT NULL,
	"data" jsonb NOT NULL
);
--> statement-breakpoint
CREATE TABLE "wf_workflow" (
	"workflow_id" text PRIMARY KEY NOT NULL,
	"definition" jsonb NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "wf_workflow_meta" (
	"workflow_id" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"version" integer NOT NULL,
	"data" jsonb NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "wf_workflow_version" (
	"workflow_id" text NOT NULL,
	"version" integer NOT NULL,
	"data" jsonb NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	CONSTRAINT "wf_workflow_version_workflow_id_version_pk" PRIMARY KEY("workflow_id","version")
);
--> statement-breakpoint
CREATE TABLE "api_key" (
	"id" text PRIMARY KEY NOT NULL,
	"workspace_id" text NOT NULL,
	"name" text NOT NULL,
	"prefix" text NOT NULL,
	"hash" text NOT NULL,
	"scopes" text[] DEFAULT '{"ingest"}' NOT NULL,
	"last_used_at" timestamp with time zone,
	"revoked_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "workspace" (
	"id" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"slug" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "workspace_slug_unique" UNIQUE("slug")
);
--> statement-breakpoint
CREATE TABLE "workspace_member" (
	"id" text PRIMARY KEY NOT NULL,
	"workspace_id" text NOT NULL,
	"user_id" text NOT NULL,
	"role" text DEFAULT 'member' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "journey" (
	"id" text PRIMARY KEY NOT NULL,
	"workspace_id" text NOT NULL,
	"name" text NOT NULL,
	"status" text DEFAULT 'draft' NOT NULL,
	"published_version" integer,
	"workflow_id" text NOT NULL,
	"trigger" jsonb NOT NULL,
	"reentry" text DEFAULT 'once' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "journey_workflow_id_unique" UNIQUE("workflow_id")
);
--> statement-breakpoint
CREATE TABLE "journey_run" (
	"id" text PRIMARY KEY NOT NULL,
	"workspace_id" text NOT NULL,
	"journey_id" text NOT NULL,
	"journey_version" integer NOT NULL,
	"contact_id" text NOT NULL,
	"instance_id" text NOT NULL,
	"status" text NOT NULL,
	"entered_at" timestamp with time zone DEFAULT now() NOT NULL,
	"exited_at" timestamp with time zone,
	"exit_reason" text,
	CONSTRAINT "journey_run_instance_id_unique" UNIQUE("instance_id")
);
--> statement-breakpoint
CREATE TABLE "journey_version" (
	"journey_id" text NOT NULL,
	"version" integer NOT NULL,
	"graph" jsonb NOT NULL,
	"compiled" jsonb NOT NULL,
	"published_at" timestamp with time zone,
	"created_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "journey_version_journey_id_version_pk" PRIMARY KEY("journey_id","version")
);
--> statement-breakpoint
CREATE TABLE "timer" (
	"timer_key" text PRIMARY KEY NOT NULL,
	"instance_id" text NOT NULL,
	"node_id" text NOT NULL,
	"workflow_id" text NOT NULL,
	"event_type" text NOT NULL,
	"trigger_at" timestamp with time zone NOT NULL,
	"payload" jsonb NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"locked_until" timestamp with time zone,
	"last_error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"fired_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "account" ADD CONSTRAINT "account_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "session" ADD CONSTRAINT "session_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "audience" ADD CONSTRAINT "audience_workspace_id_workspace_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspace"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "contact" ADD CONSTRAINT "contact_workspace_id_workspace_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspace"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "contact_event" ADD CONSTRAINT "contact_event_workspace_id_workspace_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspace"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "contact_event" ADD CONSTRAINT "contact_event_contact_id_contact_id_fk" FOREIGN KEY ("contact_id") REFERENCES "public"."contact"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "email_delivery" ADD CONSTRAINT "email_delivery_send_id_email_send_id_fk" FOREIGN KEY ("send_id") REFERENCES "public"."email_send"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "email_send" ADD CONSTRAINT "email_send_workspace_id_workspace_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspace"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "email_send" ADD CONSTRAINT "email_send_contact_id_contact_id_fk" FOREIGN KEY ("contact_id") REFERENCES "public"."contact"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "email_send" ADD CONSTRAINT "email_send_journey_id_journey_id_fk" FOREIGN KEY ("journey_id") REFERENCES "public"."journey"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "email_send" ADD CONSTRAINT "email_send_journey_run_id_journey_run_id_fk" FOREIGN KEY ("journey_run_id") REFERENCES "public"."journey_run"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "email_template" ADD CONSTRAINT "email_template_workspace_id_workspace_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspace"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "api_key" ADD CONSTRAINT "api_key_workspace_id_workspace_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspace"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workspace_member" ADD CONSTRAINT "workspace_member_workspace_id_workspace_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspace"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workspace_member" ADD CONSTRAINT "workspace_member_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "journey" ADD CONSTRAINT "journey_workspace_id_workspace_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspace"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "journey_run" ADD CONSTRAINT "journey_run_workspace_id_workspace_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspace"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "journey_run" ADD CONSTRAINT "journey_run_journey_id_journey_id_fk" FOREIGN KEY ("journey_id") REFERENCES "public"."journey"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "journey_run" ADD CONSTRAINT "journey_run_contact_id_contact_id_fk" FOREIGN KEY ("contact_id") REFERENCES "public"."contact"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "journey_version" ADD CONSTRAINT "journey_version_journey_id_journey_id_fk" FOREIGN KEY ("journey_id") REFERENCES "public"."journey"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "account_issuer_accountId_uidx" ON "account" USING btree ("issuer","account_id");--> statement-breakpoint
CREATE INDEX "account_userId_idx" ON "account" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "session_userId_idx" ON "session" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "verification_identifier_idx" ON "verification" USING btree ("identifier");--> statement-breakpoint
CREATE UNIQUE INDEX "contact_ws_email_uidx" ON "contact" USING btree ("workspace_id",lower("email"));--> statement-breakpoint
CREATE UNIQUE INDEX "contact_ws_userid_uidx" ON "contact" USING btree ("workspace_id","user_id") WHERE "contact"."user_id" is not null;--> statement-breakpoint
CREATE INDEX "contact_props_gin" ON "contact" USING gin ("properties");--> statement-breakpoint
CREATE INDEX "contact_event_contact_time_idx" ON "contact_event" USING btree ("contact_id","occurred_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "contact_event_ws_name_time_idx" ON "contact_event" USING btree ("workspace_id","name","occurred_at" DESC NULLS LAST);--> statement-breakpoint
CREATE UNIQUE INDEX "contact_event_idem_uidx" ON "contact_event" USING btree ("workspace_id","idempotency_key") WHERE "contact_event"."idempotency_key" is not null;--> statement-breakpoint
CREATE UNIQUE INDEX "email_delivery_provider_evt_uidx" ON "email_delivery" USING btree ("provider_event_id") WHERE "email_delivery"."provider_event_id" is not null;--> statement-breakpoint
CREATE INDEX "email_delivery_send_idx" ON "email_delivery" USING btree ("send_id","occurred_at");--> statement-breakpoint
CREATE UNIQUE INDEX "email_send_idem_uidx" ON "email_send" USING btree ("workspace_id","idempotency_key");--> statement-breakpoint
CREATE UNIQUE INDEX "email_send_provider_msg_uidx" ON "email_send" USING btree ("provider","provider_message_id") WHERE "email_send"."provider_message_id" is not null;--> statement-breakpoint
CREATE INDEX "email_send_journey_idx" ON "email_send" USING btree ("journey_id","created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "email_send_contact_idx" ON "email_send" USING btree ("contact_id","created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "wf_event_instance_ts_idx" ON "wf_event" USING btree ("instance_id","timestamp" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "wf_event_type_ts_idx" ON "wf_event" USING btree ("event_type","timestamp" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "wf_event_wait_type_idx" ON "wf_event_wait" USING btree ("event_type");--> statement-breakpoint
CREATE INDEX "wf_heartbeat_deadline_idx" ON "wf_heartbeat" USING btree ("deadline");--> statement-breakpoint
CREATE INDEX "wf_instance_wf_created_idx" ON "wf_instance" USING btree ("workflow_id","created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "wf_instance_status_created_idx" ON "wf_instance" USING btree ("status","created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "wf_instance_parent_idx" ON "wf_instance" USING btree ("parent_instance_id");--> statement-breakpoint
CREATE INDEX "wf_instance_created_idx" ON "wf_instance" USING btree ("created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "wf_instance_updated_idx" ON "wf_instance" USING btree ("updated_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "wf_node_metric_wf_node_idx" ON "wf_node_metric" USING btree ("workflow_id","node_id","status");--> statement-breakpoint
CREATE UNIQUE INDEX "api_key_hash_uidx" ON "api_key" USING btree ("hash");--> statement-breakpoint
CREATE INDEX "api_key_ws_idx" ON "api_key" USING btree ("workspace_id");--> statement-breakpoint
CREATE UNIQUE INDEX "workspace_member_ws_user_uidx" ON "workspace_member" USING btree ("workspace_id","user_id");--> statement-breakpoint
CREATE INDEX "workspace_member_user_idx" ON "workspace_member" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "journey_ws_status_idx" ON "journey" USING btree ("workspace_id","status");--> statement-breakpoint
CREATE UNIQUE INDEX "journey_run_active_uidx" ON "journey_run" USING btree ("journey_id","contact_id") WHERE "journey_run"."status" = 'running';--> statement-breakpoint
CREATE INDEX "journey_run_contact_idx" ON "journey_run" USING btree ("contact_id","status");--> statement-breakpoint
CREATE INDEX "journey_run_journey_status_idx" ON "journey_run" USING btree ("journey_id","status");--> statement-breakpoint
CREATE INDEX "timer_due_idx" ON "timer" USING btree ("trigger_at") WHERE "timer"."status" = 'pending';--> statement-breakpoint
CREATE INDEX "timer_instance_idx" ON "timer" USING btree ("instance_id","node_id");