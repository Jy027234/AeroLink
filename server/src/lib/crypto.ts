/**
 * AeroLink 数据加密工具 - AES-256-GCM
 * 用于敏感字段（如邮箱授权码）的加密存储
 */
import crypto from 'crypto';
import fs from 'fs';

const ALGORITHM = 'aes-256-gcm';
const IV_LENGTH = 16;
const TAG_LENGTH = 16;
const DOCKER_SECRET_PATH = '/run/secrets/encryption_key';

function getEncryptionKey(): Buffer {
  // 1. 优先从 Docker Secret 读取（生产环境）
  if (fs.existsSync(DOCKER_SECRET_PATH)) {
    const key = fs.readFileSync(DOCKER_SECRET_PATH, 'utf8').trim();
    const buf = Buffer.from(key, 'hex');
    if (buf.length === 32) {
      return buf;
    }
    console.warn('Docker Secret 中的 ENCRYPTION_KEY 格式不正确，fallback 到环境变量');
  }

  // 2. 从环境变量读取（开发/本地环境）
  const key = process.env.ENCRYPTION_KEY;
  if (!key) {
    throw new Error('FATAL: ENCRYPTION_KEY environment variable must be set (32-byte hex string)');
  }
  const buf = Buffer.from(key, 'hex');
  if (buf.length !== 32) {
    throw new Error('FATAL: ENCRYPTION_KEY must be a 64-character hex string (32 bytes)');
  }
  return buf;
}

/**
 * 加密明文，返回 hex 格式的密文（含IV和authTag）
 */
export function encrypt(plaintext: string): string {
  const key = getEncryptionKey();
  const iv = crypto.randomBytes(IV_LENGTH);
  const cipher = crypto.createCipheriv(ALGORITHM, key, iv);

  let encrypted = cipher.update(plaintext, 'utf8', 'hex');
  encrypted += cipher.final('hex');
  const authTag = cipher.getAuthTag();

  // 格式: iv(hex) + encrypted(hex) + authTag(hex)
  return iv.toString('hex') + encrypted + authTag.toString('hex');
}

/**
 * 解密密文，密文格式为 encrypt() 的输出
 */
export function decrypt(ciphertext: string): string {
  const key = getEncryptionKey();
  const data = Buffer.from(ciphertext, 'hex');

  const iv = data.subarray(0, IV_LENGTH);
  const authTag = data.subarray(data.length - TAG_LENGTH);
  const encrypted = data.subarray(IV_LENGTH, data.length - TAG_LENGTH);

  const decipher = crypto.createDecipheriv(ALGORITHM, key, iv);
  decipher.setAuthTag(authTag);

  let decrypted = decipher.update(encrypted);
  decrypted = Buffer.concat([decrypted, decipher.final()]);

  return decrypted.toString('utf8');
}
