-- CreateSchema
CREATE SCHEMA IF NOT EXISTS "public";

-- CreateTable
CREATE TABLE "users" (
    "id" TEXT NOT NULL,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "telegramId" TEXT NOT NULL,
    "timezone" TEXT NOT NULL,

    CONSTRAINT "users_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "browser_profiles" (
    "id" TEXT NOT NULL,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "provider" TEXT NOT NULL,
    "externalId" TEXT NOT NULL,
    "name" TEXT NOT NULL,

    CONSTRAINT "browser_profiles_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "account_style_profiles" (
    "id" TEXT NOT NULL,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "name" TEXT NOT NULL,
    "instruction" TEXT NOT NULL,
    "maxLength" INTEGER NOT NULL,
    "maxParagraphs" INTEGER NOT NULL,
    "punctuation" TEXT NOT NULL,
    "emoji" BOOLEAN NOT NULL,
    "slang" BOOLEAN NOT NULL,
    "profanity" BOOLEAN NOT NULL,
    "forbidden" TEXT[],
    "opening" TEXT NOT NULL,
    "ending" TEXT NOT NULL,
    "extra" TEXT NOT NULL,

    CONSTRAINT "account_style_profiles_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "style_examples" (
    "id" TEXT NOT NULL,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "styleId" TEXT NOT NULL,
    "text" TEXT NOT NULL,

    CONSTRAINT "style_examples_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "threads_accounts" (
    "id" TEXT NOT NULL,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "username" TEXT NOT NULL,
    "profileUrl" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "profileId" TEXT NOT NULL,
    "styleId" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'PAUSED',
    "autoApprove" BOOLEAN NOT NULL DEFAULT false,
    "followers" INTEGER,
    "lastPublishedAt" TIMESTAMPTZ(3),
    "ctaId" TEXT,
    "insightsUserId" TEXT,

    CONSTRAINT "threads_accounts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "source_contents" (
    "id" TEXT NOT NULL,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "url" TEXT,
    "fingerprint" TEXT NOT NULL,
    "text" TEXT NOT NULL,
    "author" TEXT,
    "rights" TEXT NOT NULL DEFAULT 'REVIEW',

    CONSTRAINT "source_contents_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "generated_contents" (
    "id" TEXT NOT NULL,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "sourceId" TEXT NOT NULL,
    "styleId" TEXT NOT NULL,
    "accountId" TEXT NOT NULL,
    "text" TEXT NOT NULL,
    "version" INTEGER NOT NULL,
    "valid" BOOLEAN NOT NULL,
    "approved" BOOLEAN NOT NULL DEFAULT false,

    CONSTRAINT "generated_contents_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "publishing_batches" (
    "id" TEXT NOT NULL,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "name" TEXT NOT NULL,
    "approval" TEXT NOT NULL,

    CONSTRAINT "publishing_batches_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "publishing_jobs" (
    "id" TEXT NOT NULL,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "batchId" TEXT NOT NULL,
    "accountId" TEXT NOT NULL,
    "generatedId" TEXT NOT NULL,
    "scheduledAt" TIMESTAMPTZ(3) NOT NULL,
    "status" TEXT NOT NULL,
    "postStatus" TEXT NOT NULL,
    "commentStatus" TEXT NOT NULL,
    "ctaText" TEXT,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "lastError" TEXT,
    "startedAt" TIMESTAMPTZ(3),
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,
    "revision" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "publishing_jobs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "published_posts" (
    "id" TEXT NOT NULL,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "jobId" TEXT NOT NULL,
    "accountId" TEXT NOT NULL,
    "generatedId" TEXT NOT NULL,
    "url" TEXT NOT NULL,
    "externalId" TEXT,
    "publishedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "published_posts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "published_comments" (
    "id" TEXT NOT NULL,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "postId" TEXT NOT NULL,
    "text" TEXT NOT NULL,
    "url" TEXT,
    "status" TEXT NOT NULL,

    CONSTRAINT "published_comments_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "post_metrics_snapshots" (
    "id" TEXT NOT NULL,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "postId" TEXT NOT NULL,
    "measuredAt" TIMESTAMPTZ(3) NOT NULL,
    "targetHours" INTEGER,
    "source" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "views" INTEGER,
    "likes" INTEGER,
    "replies" INTEGER,
    "reposts" INTEGER,
    "quotes" INTEGER,

    CONSTRAINT "post_metrics_snapshots_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "account_metrics_snapshots" (
    "id" TEXT NOT NULL,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "accountId" TEXT NOT NULL,
    "measuredAt" TIMESTAMPTZ(3) NOT NULL,
    "followers" INTEGER,
    "source" TEXT NOT NULL,

    CONSTRAINT "account_metrics_snapshots_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "cta_templates" (
    "id" TEXT NOT NULL,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "name" TEXT NOT NULL,
    "text" TEXT NOT NULL,
    "enabled" BOOLEAN NOT NULL,

    CONSTRAINT "cta_templates_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "tracking_links" (
    "id" TEXT NOT NULL,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "code" TEXT NOT NULL,
    "accountId" TEXT NOT NULL,
    "postId" TEXT,
    "ctaId" TEXT,
    "destination" TEXT NOT NULL,

    CONSTRAINT "tracking_links_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "tracking_clicks" (
    "id" TEXT NOT NULL,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "linkId" TEXT NOT NULL,
    "visitorHash" TEXT NOT NULL,

    CONSTRAINT "tracking_clicks_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "telegram_invite_links" (
    "id" TEXT NOT NULL,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "accountId" TEXT NOT NULL,
    "linkId" TEXT,
    "inviteUrl" TEXT NOT NULL,
    "channelId" TEXT NOT NULL,

    CONSTRAINT "telegram_invite_links_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "telegram_membership_events" (
    "id" TEXT NOT NULL,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "eventKey" TEXT NOT NULL,
    "channelId" TEXT NOT NULL,
    "userHash" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "inviteId" TEXT,
    "occurredAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "telegram_membership_events_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "attributed_conversions" (
    "id" TEXT NOT NULL,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "eventId" TEXT NOT NULL,
    "linkId" TEXT NOT NULL,
    "accountId" TEXT NOT NULL,
    "postId" TEXT,

    CONSTRAINT "attributed_conversions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ai_requests" (
    "id" TEXT NOT NULL,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "accountId" TEXT NOT NULL,
    "model" TEXT NOT NULL,
    "inputTokens" INTEGER NOT NULL,
    "outputTokens" INTEGER NOT NULL,
    "costUsd" DOUBLE PRECISION NOT NULL,
    "status" TEXT NOT NULL,
    "reservedUsd" DOUBLE PRECISION NOT NULL,

    CONSTRAINT "ai_requests_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "system_events" (
    "id" TEXT NOT NULL,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "level" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "message" TEXT NOT NULL,

    CONSTRAINT "system_events_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "audit_logs" (
    "id" TEXT NOT NULL,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "actor" TEXT NOT NULL,
    "action" TEXT NOT NULL,
    "entityId" TEXT NOT NULL,
    "detail" TEXT NOT NULL,

    CONSTRAINT "audit_logs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "profile_leases" (
    "id" TEXT NOT NULL,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "token" TEXT NOT NULL,
    "expiresAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "profile_leases_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "system_settings" (
    "id" TEXT NOT NULL,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "value" TEXT NOT NULL,

    CONSTRAINT "system_settings_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "users_telegramId_key" ON "users"("telegramId");

-- CreateIndex
CREATE UNIQUE INDEX "browser_profiles_provider_externalId_key" ON "browser_profiles"("provider", "externalId");

-- CreateIndex
CREATE INDEX "style_examples_styleId_idx" ON "style_examples"("styleId");

-- CreateIndex
CREATE UNIQUE INDEX "threads_accounts_username_key" ON "threads_accounts"("username");

-- CreateIndex
CREATE UNIQUE INDEX "threads_accounts_profileId_key" ON "threads_accounts"("profileId");

-- CreateIndex
CREATE INDEX "threads_accounts_status_idx" ON "threads_accounts"("status");

-- CreateIndex
CREATE INDEX "threads_accounts_styleId_idx" ON "threads_accounts"("styleId");

-- CreateIndex
CREATE INDEX "threads_accounts_ctaId_idx" ON "threads_accounts"("ctaId");

-- CreateIndex
CREATE UNIQUE INDEX "source_contents_url_key" ON "source_contents"("url");

-- CreateIndex
CREATE UNIQUE INDEX "source_contents_fingerprint_key" ON "source_contents"("fingerprint");

-- CreateIndex
CREATE INDEX "generated_contents_sourceId_idx" ON "generated_contents"("sourceId");

-- CreateIndex
CREATE INDEX "generated_contents_styleId_idx" ON "generated_contents"("styleId");

-- CreateIndex
CREATE INDEX "generated_contents_accountId_idx" ON "generated_contents"("accountId");

-- CreateIndex
CREATE UNIQUE INDEX "generated_contents_sourceId_accountId_version_key" ON "generated_contents"("sourceId", "accountId", "version");

-- CreateIndex
CREATE INDEX "publishing_jobs_status_scheduledAt_idx" ON "publishing_jobs"("status", "scheduledAt");

-- CreateIndex
CREATE INDEX "publishing_jobs_batchId_idx" ON "publishing_jobs"("batchId");

-- CreateIndex
CREATE INDEX "publishing_jobs_accountId_idx" ON "publishing_jobs"("accountId");

-- CreateIndex
CREATE INDEX "publishing_jobs_generatedId_idx" ON "publishing_jobs"("generatedId");

-- CreateIndex
CREATE UNIQUE INDEX "publishing_jobs_batchId_accountId_key" ON "publishing_jobs"("batchId", "accountId");

-- CreateIndex
CREATE UNIQUE INDEX "published_posts_jobId_key" ON "published_posts"("jobId");

-- CreateIndex
CREATE UNIQUE INDEX "published_posts_url_key" ON "published_posts"("url");

-- CreateIndex
CREATE INDEX "published_posts_accountId_publishedAt_idx" ON "published_posts"("accountId", "publishedAt");

-- CreateIndex
CREATE INDEX "published_posts_accountId_idx" ON "published_posts"("accountId");

-- CreateIndex
CREATE INDEX "published_posts_generatedId_idx" ON "published_posts"("generatedId");

-- CreateIndex
CREATE UNIQUE INDEX "published_comments_postId_key" ON "published_comments"("postId");

-- CreateIndex
CREATE INDEX "post_metrics_snapshots_postId_measuredAt_idx" ON "post_metrics_snapshots"("postId", "measuredAt");

-- CreateIndex
CREATE INDEX "post_metrics_snapshots_postId_idx" ON "post_metrics_snapshots"("postId");

-- CreateIndex
CREATE UNIQUE INDEX "post_metrics_snapshots_postId_targetHours_key" ON "post_metrics_snapshots"("postId", "targetHours");

-- CreateIndex
CREATE INDEX "account_metrics_snapshots_accountId_measuredAt_idx" ON "account_metrics_snapshots"("accountId", "measuredAt");

-- CreateIndex
CREATE INDEX "account_metrics_snapshots_accountId_idx" ON "account_metrics_snapshots"("accountId");

-- CreateIndex
CREATE UNIQUE INDEX "tracking_links_code_key" ON "tracking_links"("code");

-- CreateIndex
CREATE INDEX "tracking_links_accountId_idx" ON "tracking_links"("accountId");

-- CreateIndex
CREATE INDEX "tracking_links_postId_idx" ON "tracking_links"("postId");

-- CreateIndex
CREATE INDEX "tracking_links_ctaId_idx" ON "tracking_links"("ctaId");

-- CreateIndex
CREATE INDEX "tracking_clicks_linkId_createdAt_idx" ON "tracking_clicks"("linkId", "createdAt");

-- CreateIndex
CREATE INDEX "tracking_clicks_visitorHash_createdAt_idx" ON "tracking_clicks"("visitorHash", "createdAt");

-- CreateIndex
CREATE INDEX "tracking_clicks_linkId_idx" ON "tracking_clicks"("linkId");

-- CreateIndex
CREATE UNIQUE INDEX "telegram_invite_links_inviteUrl_key" ON "telegram_invite_links"("inviteUrl");

-- CreateIndex
CREATE INDEX "telegram_invite_links_accountId_idx" ON "telegram_invite_links"("accountId");

-- CreateIndex
CREATE INDEX "telegram_invite_links_linkId_idx" ON "telegram_invite_links"("linkId");

-- CreateIndex
CREATE UNIQUE INDEX "telegram_membership_events_eventKey_key" ON "telegram_membership_events"("eventKey");

-- CreateIndex
CREATE INDEX "telegram_membership_events_channelId_occurredAt_idx" ON "telegram_membership_events"("channelId", "occurredAt");

-- CreateIndex
CREATE INDEX "telegram_membership_events_inviteId_idx" ON "telegram_membership_events"("inviteId");

-- CreateIndex
CREATE UNIQUE INDEX "attributed_conversions_eventId_key" ON "attributed_conversions"("eventId");

-- CreateIndex
CREATE INDEX "attributed_conversions_linkId_idx" ON "attributed_conversions"("linkId");

-- CreateIndex
CREATE INDEX "attributed_conversions_accountId_idx" ON "attributed_conversions"("accountId");

-- CreateIndex
CREATE INDEX "attributed_conversions_postId_idx" ON "attributed_conversions"("postId");

-- CreateIndex
CREATE INDEX "ai_requests_createdAt_status_idx" ON "ai_requests"("createdAt", "status");

-- CreateIndex
CREATE INDEX "ai_requests_accountId_idx" ON "ai_requests"("accountId");

-- CreateIndex
CREATE INDEX "system_events_createdAt_level_idx" ON "system_events"("createdAt", "level");

-- CreateIndex
CREATE INDEX "audit_logs_createdAt_idx" ON "audit_logs"("createdAt");

-- AddForeignKey
ALTER TABLE "style_examples" ADD CONSTRAINT "style_examples_styleId_fkey" FOREIGN KEY ("styleId") REFERENCES "account_style_profiles"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "threads_accounts" ADD CONSTRAINT "threads_accounts_profileId_fkey" FOREIGN KEY ("profileId") REFERENCES "browser_profiles"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "threads_accounts" ADD CONSTRAINT "threads_accounts_styleId_fkey" FOREIGN KEY ("styleId") REFERENCES "account_style_profiles"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "threads_accounts" ADD CONSTRAINT "threads_accounts_ctaId_fkey" FOREIGN KEY ("ctaId") REFERENCES "cta_templates"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "generated_contents" ADD CONSTRAINT "generated_contents_sourceId_fkey" FOREIGN KEY ("sourceId") REFERENCES "source_contents"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "generated_contents" ADD CONSTRAINT "generated_contents_styleId_fkey" FOREIGN KEY ("styleId") REFERENCES "account_style_profiles"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "generated_contents" ADD CONSTRAINT "generated_contents_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "threads_accounts"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "publishing_jobs" ADD CONSTRAINT "publishing_jobs_batchId_fkey" FOREIGN KEY ("batchId") REFERENCES "publishing_batches"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "publishing_jobs" ADD CONSTRAINT "publishing_jobs_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "threads_accounts"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "publishing_jobs" ADD CONSTRAINT "publishing_jobs_generatedId_fkey" FOREIGN KEY ("generatedId") REFERENCES "generated_contents"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "published_posts" ADD CONSTRAINT "published_posts_jobId_fkey" FOREIGN KEY ("jobId") REFERENCES "publishing_jobs"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "published_posts" ADD CONSTRAINT "published_posts_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "threads_accounts"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "published_posts" ADD CONSTRAINT "published_posts_generatedId_fkey" FOREIGN KEY ("generatedId") REFERENCES "generated_contents"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "published_comments" ADD CONSTRAINT "published_comments_postId_fkey" FOREIGN KEY ("postId") REFERENCES "published_posts"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "post_metrics_snapshots" ADD CONSTRAINT "post_metrics_snapshots_postId_fkey" FOREIGN KEY ("postId") REFERENCES "published_posts"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "account_metrics_snapshots" ADD CONSTRAINT "account_metrics_snapshots_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "threads_accounts"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "tracking_links" ADD CONSTRAINT "tracking_links_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "threads_accounts"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "tracking_links" ADD CONSTRAINT "tracking_links_postId_fkey" FOREIGN KEY ("postId") REFERENCES "published_posts"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "tracking_links" ADD CONSTRAINT "tracking_links_ctaId_fkey" FOREIGN KEY ("ctaId") REFERENCES "cta_templates"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "tracking_clicks" ADD CONSTRAINT "tracking_clicks_linkId_fkey" FOREIGN KEY ("linkId") REFERENCES "tracking_links"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "telegram_invite_links" ADD CONSTRAINT "telegram_invite_links_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "threads_accounts"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "telegram_invite_links" ADD CONSTRAINT "telegram_invite_links_linkId_fkey" FOREIGN KEY ("linkId") REFERENCES "tracking_links"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "telegram_membership_events" ADD CONSTRAINT "telegram_membership_events_inviteId_fkey" FOREIGN KEY ("inviteId") REFERENCES "telegram_invite_links"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "attributed_conversions" ADD CONSTRAINT "attributed_conversions_eventId_fkey" FOREIGN KEY ("eventId") REFERENCES "telegram_membership_events"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "attributed_conversions" ADD CONSTRAINT "attributed_conversions_linkId_fkey" FOREIGN KEY ("linkId") REFERENCES "tracking_links"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "attributed_conversions" ADD CONSTRAINT "attributed_conversions_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "threads_accounts"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "attributed_conversions" ADD CONSTRAINT "attributed_conversions_postId_fkey" FOREIGN KEY ("postId") REFERENCES "published_posts"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ai_requests" ADD CONSTRAINT "ai_requests_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "threads_accounts"("id") ON DELETE RESTRICT ON UPDATE CASCADE;


-- Domain invariants also protect direct database writes.
ALTER TABLE "threads_accounts" ADD CONSTRAINT "account_status_valid" CHECK ("status" IN ('ACTIVE','PAUSED','AUTH_REQUIRED','ERROR','RESTRICTED'));
ALTER TABLE "browser_profiles" ADD CONSTRAINT "browser_provider_valid" CHECK ("provider" IN ('ADSPOWER','DOLPHIN','MOCK'));
ALTER TABLE "source_contents" ADD CONSTRAINT "content_rights_valid" CHECK ("rights" IN ('OWN','PERMITTED','REVIEW'));
ALTER TABLE "publishing_batches" ADD CONSTRAINT "batch_approval_valid" CHECK ("approval" IN ('MANUAL_APPROVAL','AUTO_APPROVED'));
ALTER TABLE "publishing_jobs" ADD CONSTRAINT "job_status_valid" CHECK ("status" IN ('QUEUED','RUNNING','PAUSED','COMPLETED','FAILED','CANCELLED','NEEDS_REVIEW'));
ALTER TABLE "publishing_jobs" ADD CONSTRAINT "post_status_valid" CHECK ("postStatus" IN ('PENDING','SENDING','PUBLISHED','FAILED','UNCERTAIN','DISABLED'));
ALTER TABLE "publishing_jobs" ADD CONSTRAINT "comment_status_valid" CHECK ("commentStatus" IN ('PENDING','SENDING','PUBLISHED','FAILED','UNCERTAIN','DISABLED'));
ALTER TABLE "publishing_jobs" ADD CONSTRAINT "attempts_nonnegative" CHECK ("attempts" >= 0 AND "revision" >= 0);
ALTER TABLE "post_metrics_snapshots" ADD CONSTRAINT "metrics_nonnegative" CHECK (("views" IS NULL OR "views">=0) AND ("likes" IS NULL OR "likes">=0) AND ("replies" IS NULL OR "replies">=0) AND ("reposts" IS NULL OR "reposts">=0) AND ("quotes" IS NULL OR "quotes">=0));
ALTER TABLE "account_style_profiles" ADD CONSTRAINT "style_bounds" CHECK ("maxLength" BETWEEN 1 AND 500 AND "maxParagraphs">0);
ALTER TABLE "ai_requests" ADD CONSTRAINT "ai_cost_nonnegative" CHECK ("costUsd">=0 AND "reservedUsd">=0 AND "inputTokens">=0 AND "outputTokens">=0);
