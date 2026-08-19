-- Migration: Standardize all ID columns to use UUID v4
-- Existing rows retain their current ID values; only the DEFAULT changes.

CREATE EXTENSION IF NOT EXISTS "pgcrypto";

ALTER TABLE "users"                 ALTER COLUMN "id" SET DEFAULT gen_random_uuid();
ALTER TABLE "projects"              ALTER COLUMN "id" SET DEFAULT gen_random_uuid();
ALTER TABLE "contributions"         ALTER COLUMN "id" SET DEFAULT gen_random_uuid();
ALTER TABLE "milestones"            ALTER COLUMN "id" SET DEFAULT gen_random_uuid();
ALTER TABLE "reputation_history"    ALTER COLUMN "id" SET DEFAULT gen_random_uuid();
ALTER TABLE "categories"            ALTER COLUMN "id" SET DEFAULT gen_random_uuid();
ALTER TABLE "refresh_tokens"        ALTER COLUMN "id" SET DEFAULT gen_random_uuid();
ALTER TABLE "ledger_cursors"        ALTER COLUMN "id" SET DEFAULT gen_random_uuid();
ALTER TABLE "processed_events"      ALTER COLUMN "id" SET DEFAULT gen_random_uuid();
ALTER TABLE "quarantined_events"    ALTER COLUMN "id" SET DEFAULT gen_random_uuid();
ALTER TABLE "indexer_logs"          ALTER COLUMN "id" SET DEFAULT gen_random_uuid();
ALTER TABLE "notification_settings" ALTER COLUMN "id" SET DEFAULT gen_random_uuid();
ALTER TABLE "notifications"         ALTER COLUMN "id" SET DEFAULT gen_random_uuid();
ALTER TABLE "email_outbox"          ALTER COLUMN "id" SET DEFAULT gen_random_uuid();
ALTER TABLE "idempotency_keys"      ALTER COLUMN "id" SET DEFAULT gen_random_uuid();
