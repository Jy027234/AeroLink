import prisma from '../lib/prisma.js';
import { isPrivilegedRole } from '../lib/accessControl.js';

async function main() {
  const activeUsers = await prisma.user.findMany({
    where: { isActive: true },
    select: { role: true },
  });
  const activeAdminCount = activeUsers.filter((user) => isPrivilegedRole(user.role)).length;

  if (activeAdminCount === 0) {
    throw new Error(
      'No active privileged user found. Run npm run db:bootstrap-admin with a one-time activation link before starting the service.'
    );
  }

  console.log(`Active privileged user check passed (${activeAdminCount} account(s)).`);
}

main()
  .catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
