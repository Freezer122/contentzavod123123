ALTER TABLE "cta_templates" ADD COLUMN "mediaPath" TEXT, ADD COLUMN "mediaSha256" TEXT;
ALTER TABLE "ai_requests" ADD COLUMN "purpose" TEXT NOT NULL DEFAULT 'POST';
ALTER TABLE "ai_requests" ADD CONSTRAINT "ai_requests_purpose_check" CHECK ("purpose" IN ('POST','BIO','REPLY'));
CREATE INDEX "ai_requests_account_purpose_created_idx" ON "ai_requests" ("accountId","purpose","createdAt");
