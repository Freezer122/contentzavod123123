-- AlterTable
ALTER TABLE "account_style_profiles" ADD COLUMN     "ownerAccountId" TEXT;

-- AlterTable
ALTER TABLE "threads_accounts" ADD COLUMN     "templateId" TEXT;

-- AlterTable
ALTER TABLE "generated_contents" ADD COLUMN     "aiRequestId" TEXT,
ADD COLUMN     "inputTokens" INTEGER,
ADD COLUMN     "model" TEXT,
ADD COLUMN     "outputTokens" INTEGER,
ADD COLUMN     "promptVersion" TEXT,
ADD COLUMN     "styleSnapshot" TEXT,
ADD COLUMN     "templateId" TEXT,
ADD COLUMN     "templateSnapshot" TEXT,
ADD COLUMN     "tokenScope" TEXT NOT NULL DEFAULT 'UNKNOWN';

-- AlterTable
ALTER TABLE "publishing_jobs" ADD COLUMN     "ctaCapturedAt" TIMESTAMPTZ(3),
ADD COLUMN     "ctaEnabled" BOOLEAN;

-- AlterTable
ALTER TABLE "adaptation_cache" ADD COLUMN     "aiRequestId" TEXT,
ADD COLUMN     "inputTokens" INTEGER,
ADD COLUMN     "outputTokens" INTEGER,
ADD COLUMN     "tokenScope" TEXT NOT NULL DEFAULT 'UNKNOWN';

-- AlterTable
ALTER TABLE "content_performance" ADD COLUMN     "templateId" TEXT,
ADD COLUMN     "templateSnapshot" TEXT;

-- CreateTable
CREATE TABLE "content_templates" (
    "id" TEXT NOT NULL,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "name" TEXT NOT NULL,
    "instruction" TEXT NOT NULL,
    "version" INTEGER NOT NULL DEFAULT 1,
    "enabled" BOOLEAN NOT NULL DEFAULT true,

    CONSTRAINT "content_templates_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "content_template_examples" (
    "id" TEXT NOT NULL,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "templateId" TEXT NOT NULL,
    "text" TEXT NOT NULL,

    CONSTRAINT "content_template_examples_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "generation_feedback" (
    "id" TEXT NOT NULL,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "ratedAt" TIMESTAMPTZ(3) NOT NULL,
    "generatedId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "rating" TEXT NOT NULL,
    "sourceText" TEXT NOT NULL,
    "finalText" TEXT NOT NULL,
    "accountId" TEXT NOT NULL,
    "styleId" TEXT NOT NULL,
    "styleSnapshot" TEXT,
    "templateId" TEXT,
    "templateSnapshot" TEXT,
    "promptVersion" TEXT,
    "model" TEXT,
    "aiRequestId" TEXT,
    "inputTokens" INTEGER,
    "outputTokens" INTEGER,
    "tokenScope" TEXT NOT NULL,

    CONSTRAINT "generation_feedback_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "content_template_examples_templateId_idx" ON "content_template_examples"("templateId");

-- CreateIndex
CREATE INDEX "generation_feedback_rating_ratedAt_idx" ON "generation_feedback"("rating", "ratedAt");

-- CreateIndex
CREATE UNIQUE INDEX "generation_feedback_generatedId_userId_key" ON "generation_feedback"("generatedId", "userId");

-- CreateIndex
CREATE UNIQUE INDEX "account_style_profiles_ownerAccountId_key" ON "account_style_profiles"("ownerAccountId");

-- AddForeignKey
ALTER TABLE "account_style_profiles" ADD CONSTRAINT "account_style_profiles_ownerAccountId_fkey" FOREIGN KEY ("ownerAccountId") REFERENCES "threads_accounts"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "threads_accounts" ADD CONSTRAINT "threads_accounts_templateId_fkey" FOREIGN KEY ("templateId") REFERENCES "content_templates"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "generated_contents" ADD CONSTRAINT "generated_contents_templateId_fkey" FOREIGN KEY ("templateId") REFERENCES "content_templates"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "generated_contents" ADD CONSTRAINT "generated_contents_aiRequestId_fkey" FOREIGN KEY ("aiRequestId") REFERENCES "ai_requests"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "content_performance" ADD CONSTRAINT "content_performance_templateId_fkey" FOREIGN KEY ("templateId") REFERENCES "content_templates"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "content_template_examples" ADD CONSTRAINT "content_template_examples_templateId_fkey" FOREIGN KEY ("templateId") REFERENCES "content_templates"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "generation_feedback" ADD CONSTRAINT "generation_feedback_generatedId_fkey" FOREIGN KEY ("generatedId") REFERENCES "generated_contents"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "generation_feedback" ADD CONSTRAINT "generation_feedback_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "threads_accounts"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "generation_feedback" ADD CONSTRAINT "generation_feedback_styleId_fkey" FOREIGN KEY ("styleId") REFERENCES "account_style_profiles"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "generation_feedback" ADD CONSTRAINT "generation_feedback_templateId_fkey" FOREIGN KEY ("templateId") REFERENCES "content_templates"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "generation_feedback" ADD CONSTRAINT "generation_feedback_aiRequestId_fkey" FOREIGN KEY ("aiRequestId") REFERENCES "ai_requests"("id") ON DELETE RESTRICT ON UPDATE CASCADE;


-- CTA can be disabled without deleting its single account-owned record.
ALTER TABLE "cta_templates" DROP CONSTRAINT "owned_cta_enabled";
-- A queued task captures the current CTA on first execution, not at enqueue time.
UPDATE "publishing_jobs" SET "ctaCapturedAt"=COALESCE("startedAt","createdAt"),"ctaEnabled"=("commentStatus"<>'DISABLED')
WHERE "startedAt" IS NOT NULL OR "postStatus"<>'PENDING' OR "status" IN ('COMPLETED','CANCELLED','NEEDS_REVIEW','FAILED');
INSERT INTO "account_style_profiles" ("id","createdAt","name","instruction","maxLength","maxParagraphs","punctuation","emoji","slang","profanity","forbidden","opening","ending","extra","ownerAccountId")
SELECT 'style-account-'||a."id",now(),s."name",s."instruction",s."maxLength",s."maxParagraphs",s."punctuation",s."emoji",s."slang",s."profanity",s."forbidden",s."opening",s."ending",s."extra",a."id"
FROM "threads_accounts" a JOIN "account_style_profiles" s ON s."id"=a."styleId" ON CONFLICT DO NOTHING;
INSERT INTO "style_examples" ("id","createdAt","styleId","text")
SELECT 'owned-'||a."id"||'-'||e."id",e."createdAt",'style-account-'||a."id",e."text" FROM "threads_accounts" a JOIN "style_examples" e ON e."styleId"=a."styleId" ON CONFLICT DO NOTHING;
UPDATE "threads_accounts" a SET "styleId"='style-account-'||a."id" WHERE EXISTS(SELECT 1 FROM "account_style_profiles" s WHERE s."ownerAccountId"=a."id" AND s."id"='style-account-'||a."id");
ALTER TABLE "generation_feedback" ADD CONSTRAINT "feedback_rating_valid" CHECK ("rating" IN ('GOOD','BAD'));
ALTER TABLE "content_templates" ADD CONSTRAINT "template_version_positive" CHECK ("version">0);
