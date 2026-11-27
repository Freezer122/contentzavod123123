-- AlterTable
ALTER TABLE "source_contents" ADD COLUMN     "format" TEXT NOT NULL DEFAULT 'Не указан',
ADD COLUMN     "hook" TEXT NOT NULL DEFAULT 'Не указан',
ADD COLUMN     "topic" TEXT NOT NULL DEFAULT 'Не указана';

-- AlterTable
ALTER TABLE "generated_contents" ADD COLUMN     "cacheKey" TEXT,
ADD COLUMN     "validationErrors" TEXT[] DEFAULT ARRAY[]::TEXT[];

-- AlterTable
ALTER TABLE "publishing_batches" ADD COLUMN     "adaptation" TEXT NOT NULL DEFAULT 'PER_ACCOUNT',
ADD COLUMN     "cycleSeconds" INTEGER NOT NULL DEFAULT 7200,
ADD COLUMN     "intervalSeconds" DOUBLE PRECISION NOT NULL DEFAULT 0,
ADD COLUMN     "mode" TEXT NOT NULL DEFAULT 'ACCOUNT_SPECIFIC';

-- AlterTable
ALTER TABLE "publishing_jobs" ADD COLUMN     "commentNotBefore" TIMESTAMPTZ(3),
ADD COLUMN     "ctaUpdatedAt" TIMESTAMPTZ(3),
ADD COLUMN     "ctaUrl" TEXT,
ADD COLUMN     "ctaVersion" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "delayMs" DOUBLE PRECISION NOT NULL DEFAULT 0,
ADD COLUMN     "delayReason" TEXT,
ADD COLUMN     "lastAttemptAt" TIMESTAMPTZ(3),
ADD COLUMN     "plannedAt" TIMESTAMPTZ(3),
ADD COLUMN     "sequence" INTEGER NOT NULL DEFAULT 0;

-- AlterTable
ALTER TABLE "cta_templates" ADD COLUMN     "accountId" TEXT,
ADD COLUMN     "updatedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
ADD COLUMN     "url" TEXT NOT NULL DEFAULT '',
ADD COLUMN     "version" INTEGER NOT NULL DEFAULT 1;

-- AlterTable
ALTER TABLE "tracking_links" ADD COLUMN     "permanent" BOOLEAN NOT NULL DEFAULT false;

-- AlterTable
ALTER TABLE "telegram_invite_links" ADD COLUMN     "active" BOOLEAN NOT NULL DEFAULT false;

-- AlterTable
ALTER TABLE "telegram_membership_events" ADD COLUMN     "origin" TEXT NOT NULL DEFAULT 'UPDATE';

-- AlterTable
ALTER TABLE "ai_requests" ADD COLUMN     "accountIds" TEXT[] DEFAULT ARRAY[]::TEXT[];

-- CreateTable
CREATE TABLE "adaptation_cache" (
    "id" TEXT NOT NULL,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "text" TEXT NOT NULL,
    "model" TEXT NOT NULL,
    "instructionVersion" TEXT NOT NULL,
    "styleFingerprint" TEXT NOT NULL,
    "valid" BOOLEAN NOT NULL,

    CONSTRAINT "adaptation_cache_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "content_performance" (
    "id" TEXT NOT NULL,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "postId" TEXT NOT NULL,
    "sourceText" TEXT NOT NULL,
    "finalText" TEXT NOT NULL,
    "topic" TEXT NOT NULL,
    "format" TEXT NOT NULL,
    "hook" TEXT NOT NULL,
    "textLength" INTEGER NOT NULL,
    "hasQuestion" BOOLEAN NOT NULL,

    CONSTRAINT "content_performance_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "telegram_member_identities" (
    "id" TEXT NOT NULL,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "channelId" TEXT NOT NULL,
    "userHash" TEXT NOT NULL,
    "encryptedUserId" TEXT NOT NULL,

    CONSTRAINT "telegram_member_identities_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "telegram_member_cohorts" (
    "exitConfirmed" BOOLEAN NOT NULL DEFAULT false,
    "id" TEXT NOT NULL,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "joinEventId" TEXT NOT NULL,
    "channelId" TEXT NOT NULL,
    "userHash" TEXT NOT NULL,
    "accountId" TEXT,
    "joinedAt" TIMESTAMPTZ(3) NOT NULL,
    "leftAt" TIMESTAMPTZ(3),
    "d7Member" BOOLEAN,
    "d7MeasuredAt" TIMESTAMPTZ(3),
    "d7Status" TEXT NOT NULL DEFAULT 'PENDING',
    "d30Member" BOOLEAN,
    "d30MeasuredAt" TIMESTAMPTZ(3),
    "d30Status" TEXT NOT NULL DEFAULT 'PENDING',

    CONSTRAINT "telegram_member_cohorts_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "content_performance_postId_key" ON "content_performance"("postId");

-- CreateIndex
CREATE INDEX "content_performance_topic_format_idx" ON "content_performance"("topic", "format");

-- CreateIndex
CREATE UNIQUE INDEX "telegram_member_identities_channelId_userHash_key" ON "telegram_member_identities"("channelId", "userHash");

-- CreateIndex
CREATE INDEX "telegram_member_cohorts_channelId_userHash_joinedAt_idx" ON "telegram_member_cohorts"("channelId", "userHash", "joinedAt");

-- CreateIndex
CREATE INDEX "telegram_member_cohorts_accountId_joinedAt_idx" ON "telegram_member_cohorts"("accountId", "joinedAt");

-- CreateIndex
CREATE UNIQUE INDEX "telegram_member_cohorts_joinEventId_key" ON "telegram_member_cohorts"("joinEventId");

-- CreateIndex
CREATE UNIQUE INDEX "cta_templates_accountId_key" ON "cta_templates"("accountId");

-- AddForeignKey
ALTER TABLE "cta_templates" ADD CONSTRAINT "cta_templates_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "threads_accounts"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "content_performance" ADD CONSTRAINT "content_performance_postId_fkey" FOREIGN KEY ("postId") REFERENCES "published_posts"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "telegram_member_cohorts" ADD CONSTRAINT "telegram_member_cohorts_joinEventId_fkey" FOREIGN KEY ("joinEventId") REFERENCES "telegram_membership_events"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "telegram_member_cohorts" ADD CONSTRAINT "telegram_member_cohorts_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "threads_accounts"("id") ON DELETE RESTRICT ON UPDATE CASCADE;


-- Keep previous schedules and source/history rows intact while adding V1.1 invariants.
UPDATE "publishing_jobs" SET "plannedAt"="scheduledAt";
WITH ordered AS (SELECT "id",row_number() OVER(PARTITION BY "batchId" ORDER BY "scheduledAt","id")-1 AS seq FROM "publishing_jobs")
UPDATE "publishing_jobs" j SET "sequence"=ordered.seq FROM ordered WHERE j."id"=ordered."id";
INSERT INTO "cta_templates" ("id","createdAt","name","text","enabled","accountId","url","updatedAt","version")
SELECT 'cta-'||a."id",now(),'CTA '||a."name",COALESCE(c."text",'Больше разборов в моём Telegram.'),true,a."id",COALESCE(c."url",''),now(),1
FROM "threads_accounts" a LEFT JOIN "cta_templates" c ON c."id"=a."ctaId" ON CONFLICT DO NOTHING;
UPDATE "threads_accounts" SET "ctaId"='cta-'||"id" WHERE EXISTS(SELECT 1 FROM "cta_templates" c WHERE c."id"='cta-'||"threads_accounts"."id");
WITH chosen AS (SELECT "id",row_number() OVER(PARTITION BY "accountId" ORDER BY "createdAt","id") AS rank FROM "tracking_links")
UPDATE "tracking_links" l SET "permanent"=(chosen.rank=1) FROM chosen WHERE l."id"=chosen."id";
WITH chosen AS (SELECT "id",row_number() OVER(PARTITION BY "accountId" ORDER BY "createdAt","id") AS rank FROM "telegram_invite_links")
UPDATE "telegram_invite_links" i SET "active"=(chosen.rank=1) FROM chosen WHERE i."id"=chosen."id";
CREATE UNIQUE INDEX "tracking_links_one_permanent_per_account" ON "tracking_links"("accountId") WHERE "permanent";
CREATE UNIQUE INDEX "invite_one_active_per_account" ON "telegram_invite_links"("accountId") WHERE "active";
ALTER TABLE "cta_templates" ADD CONSTRAINT "owned_cta_enabled" CHECK ("accountId" IS NULL OR "enabled");
ALTER TABLE "publishing_jobs" DROP CONSTRAINT "comment_status_valid";
ALTER TABLE "publishing_jobs" ADD CONSTRAINT "comment_status_valid" CHECK ("commentStatus" IN ('PENDING','SENDING','PUBLISHED','FAILED','COMMENT_FAILED','UNCERTAIN','DISABLED'));
ALTER TABLE "publishing_batches" ADD CONSTRAINT "batch_mode_valid" CHECK ("mode" IN ('ACCOUNT_SPECIFIC','BROADCAST') AND "adaptation" IN ('COMMON','PER_ACCOUNT'));
