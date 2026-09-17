DROP INDEX "journey_run_active_uidx";--> statement-breakpoint
ALTER TABLE "journey_run" ADD COLUMN "active_lock" boolean;--> statement-breakpoint
CREATE UNIQUE INDEX "journey_run_active_uidx" ON "journey_run" USING btree ("journey_id","contact_id") WHERE "journey_run"."active_lock" = true AND "journey_run"."status" = 'running';