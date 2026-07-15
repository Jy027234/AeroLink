import crypto from 'node:crypto';
import fs from 'node:fs';
import { PrismaClient } from '@prisma/client';

const ALGORITHM = 'aes-256-gcm';
const IV_LENGTH = 16;
const TAG_LENGTH = 16;
const ROTATION_CONFIRMATION = 'rotate-encryption-key';

type RotationUpdate = {
  model: 'emailAccount' | 'webhookEndpoint';
  id: string;
  field: 'authCode' | 'authToken' | 'secret';
  value: string;
};

function readKey(name: 'ENCRYPTION_KEY_OLD' | 'ENCRYPTION_KEY_NEW'): Buffer {
  const fileVariable = `${name}_FILE`;
  const filePath = process.env[fileVariable];
  const raw = filePath
    ? fs.readFileSync(filePath, 'utf8').trim()
    : process.env[name]?.trim();

  if (!raw || !/^[0-9a-f]{64}$/i.test(raw)) {
    throw new Error(`${name} must be a 64-character hexadecimal key or a *_FILE path`);
  }

  return Buffer.from(raw, 'hex');
}

function decryptWithKey(ciphertext: string, key: Buffer, label: string): string {
  try {
    const data = Buffer.from(ciphertext, 'hex');
    if (data.length <= IV_LENGTH + TAG_LENGTH) {
      throw new Error('ciphertext is too short');
    }

    const iv = data.subarray(0, IV_LENGTH);
    const authTag = data.subarray(data.length - TAG_LENGTH);
    const encrypted = data.subarray(IV_LENGTH, data.length - TAG_LENGTH);
    const decipher = crypto.createDecipheriv(ALGORITHM, key, iv);
    decipher.setAuthTag(authTag);
    return Buffer.concat([decipher.update(encrypted), decipher.final()]).toString('utf8');
  } catch (error) {
    throw new Error(`Unable to decrypt ${label}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function encryptWithKey(plaintext: string, key: Buffer): string {
  const iv = crypto.randomBytes(IV_LENGTH);
  const cipher = crypto.createCipheriv(ALGORITHM, key, iv);
  const encrypted = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  return `${iv.toString('hex')}${encrypted.toString('hex')}${cipher.getAuthTag().toString('hex')}`;
}

async function main() {
  const oldKey = readKey('ENCRYPTION_KEY_OLD');
  const newKey = readKey('ENCRYPTION_KEY_NEW');
  const prisma = new PrismaClient();

  try {
    const updates: RotationUpdate[] = [];
    const [emailAccounts, webhookEndpoints] = await Promise.all([
      prisma.emailAccount.findMany({ select: { id: true, authCode: true } }),
      prisma.webhookEndpoint.findMany({ select: { id: true, authToken: true, secret: true } }),
    ]);

    for (const account of emailAccounts) {
      if (account.authCode) {
        const plaintext = decryptWithKey(account.authCode, oldKey, `emailAccount:${account.id}:authCode`);
        updates.push({
          model: 'emailAccount',
          id: account.id,
          field: 'authCode',
          value: encryptWithKey(plaintext, newKey),
        });
      }
    }

    for (const endpoint of webhookEndpoints) {
      for (const field of ['authToken', 'secret'] as const) {
        const ciphertext = endpoint[field];
        if (ciphertext) {
          const plaintext = decryptWithKey(ciphertext, oldKey, `webhookEndpoint:${endpoint.id}:${field}`);
          updates.push({
            model: 'webhookEndpoint',
            id: endpoint.id,
            field,
            value: encryptWithKey(plaintext, newKey),
          });
        }
      }
    }

    console.log(`Encryption key rotation prepared ${updates.length} encrypted field(s).`);

    if (process.env.ROTATION_DRY_RUN !== 'false') {
      console.log('Dry run only; no database rows were modified. Set ROTATION_DRY_RUN=false and ROTATION_CONFIRM=rotate-encryption-key to apply.');
      return;
    }

    if (process.env.ROTATION_CONFIRM !== ROTATION_CONFIRMATION) {
      throw new Error(`Refusing to write without ROTATION_CONFIRM=${ROTATION_CONFIRMATION}`);
    }

    await prisma.$transaction(async (tx) => {
      for (const update of updates) {
        if (update.model === 'emailAccount') {
          await tx.emailAccount.update({ where: { id: update.id }, data: { authCode: update.value } });
        } else if (update.field === 'authToken') {
          await tx.webhookEndpoint.update({ where: { id: update.id }, data: { authToken: update.value } });
        } else {
          await tx.webhookEndpoint.update({ where: { id: update.id }, data: { secret: update.value } });
        }
      }
    });

    console.log(`Encryption key rotation committed ${updates.length} encrypted field(s).`);
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
