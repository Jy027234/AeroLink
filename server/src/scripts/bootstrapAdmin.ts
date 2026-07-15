import bcrypt from 'bcryptjs';
import { randomBytes } from 'node:crypto';
import prisma from '../lib/prisma.js';
import { buildActivationLink } from '../lib/authEmailService.js';
import { generateAuthToken, getActivationExpiryDate } from '../lib/authFlow.js';
import { isPrivilegedRole } from '../lib/accessControl.js';

const SALT_ROUNDS = 12;

function requiredEnv(name: string) {
  const value = process.env[name]?.trim();
  if (!value) {
    throw new Error(`${name} is required for one-time administrator bootstrap.`);
  }
  return value;
}

async function main() {
  const email = requiredEnv('BOOTSTRAP_ADMIN_EMAIL').toLowerCase();
  const name = requiredEnv('BOOTSTRAP_ADMIN_NAME');
  const department = process.env.BOOTSTRAP_ADMIN_DEPARTMENT?.trim() || null;

  const activeUsers = await prisma.user.findMany({
    where: { isActive: true },
    select: { email: true, role: true },
  });
  if (activeUsers.some((user) => isPrivilegedRole(user.role))) {
    throw new Error('An active privileged user already exists; refusing to create another bootstrap administrator.');
  }

  const existing = await prisma.user.findUnique({ where: { email } });
  if (existing) {
    throw new Error(`A user with ${email} already exists; refusing to overwrite an existing account.`);
  }

  const activationToken = generateAuthToken();
  const activationExpiresAt = getActivationExpiryDate();
  const password = await bcrypt.hash(randomBytes(32).toString('hex'), SALT_ROUNDS);
  const user = await prisma.user.create({
    data: {
      email,
      name,
      department,
      role: 'ADMIN',
      password,
      isActive: false,
      activationToken,
      activationTokenExpiresAt: activationExpiresAt,
    },
    select: { id: true, email: true, name: true, role: true },
  });

  console.log('Bootstrap administrator created in an inactive state.');
  console.log(`User: ${user.name} <${user.email}> (${user.role})`);
  console.log(`Activation link (share once over a secure channel): ${buildActivationLink(activationToken)}`);
  console.log(`Activation expires at: ${activationExpiresAt.toISOString()}`);
  console.log('The administrator must set a password through the activation page. No default password was stored.');
}

main()
  .catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
