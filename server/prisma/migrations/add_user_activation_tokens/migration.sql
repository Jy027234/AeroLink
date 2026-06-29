-- User onboarding: activation link instead of shared temporary password
ALTER TABLE "users" ADD COLUMN "activationToken" TEXT;
ALTER TABLE "users" ADD COLUMN "activationTokenExpiresAt" TIMESTAMP(3);

CREATE UNIQUE INDEX "users_activationToken_key" ON "users"("activationToken");
