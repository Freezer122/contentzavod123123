ALTER TABLE "publishing_jobs"
  ADD COLUMN "post_submit_at" TIMESTAMPTZ(3),
  ADD COLUMN "post_confirmed_at" TIMESTAMPTZ(3),
  ADD COLUMN "cta_scheduled_at" TIMESTAMPTZ(3),
  ADD COLUMN "cta_submit_at" TIMESTAMPTZ(3),
  ADD COLUMN "cta_confirmed_at" TIMESTAMPTZ(3),
  ADD COLUMN "cta_delay_notified_at" TIMESTAMPTZ(3);
