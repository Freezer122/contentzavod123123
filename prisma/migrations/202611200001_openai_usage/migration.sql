ALTER TABLE "ai_requests" ADD COLUMN "providerResponseId" TEXT, ADD COLUMN "cachedInputTokens" INTEGER NOT NULL DEFAULT 0, ADD COLUMN "cacheWriteTokens" INTEGER NOT NULL DEFAULT 0, ADD COLUMN "reasoningTokens" INTEGER NOT NULL DEFAULT 0, ADD COLUMN "reasoningEffort" TEXT, ADD COLUMN "usageJson" TEXT;
CREATE UNIQUE INDEX "ai_requests_providerResponseId_key" ON "ai_requests" ("providerResponseId");
