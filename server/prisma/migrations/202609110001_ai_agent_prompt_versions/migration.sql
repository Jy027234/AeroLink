-- AI agent draft metadata and immutable published prompt snapshots.
-- Existing agent rows remain untouched; startup initialization only adds
-- missing built-in rows and their first version.
ALTER TABLE "ai_agents"
  ADD COLUMN "builtinKey" TEXT,
  ADD COLUMN "draftRevision" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "publishedVersion" INTEGER;

CREATE UNIQUE INDEX "ai_agents_builtinKey_key"
  ON "ai_agents"("builtinKey");

CREATE TABLE "ai_agent_versions" (
    "id" TEXT NOT NULL,
    "agentId" TEXT NOT NULL,
    "version" INTEGER NOT NULL,
    "prompts" TEXT NOT NULL,
    "config" TEXT NOT NULL,
    "createdBy" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ai_agent_versions_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "ai_agent_versions_agentId_version_key"
  ON "ai_agent_versions"("agentId", "version");
CREATE INDEX "ai_agent_versions_agentId_createdAt_idx"
  ON "ai_agent_versions"("agentId", "createdAt");

ALTER TABLE "ai_agent_versions"
  ADD CONSTRAINT "ai_agent_versions_agentId_fkey"
  FOREIGN KEY ("agentId") REFERENCES "ai_agents"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;
