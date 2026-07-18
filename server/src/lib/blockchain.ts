import crypto from 'crypto';
import prisma from './prisma.js';
import { logger } from './logger.js';

export interface BlockRecord {
  index: number;
  timestamp: string;
  certificateId: string;
  certificateHash: string;
  previousHash: string;
  hash: string;
  nonce: number;
}

export interface IntegrityCheckMetadata {
  method: 'sha256_linked_records';
  storageScope: 'internal_database';
  externalTrustAnchor: false;
  decisionBoundary: string;
}

/**
 * This system keeps linked SHA-256 records in the same business database.
 * It can help detect ordinary data inconsistencies, but it is not an
 * independent ledger, third-party timestamp, or airworthiness evidence.
 */
export function getIntegrityCheckMetadata(): IntegrityCheckMetadata {
  return {
    method: 'sha256_linked_records',
    storageScope: 'internal_database',
    externalTrustAnchor: false,
    decisionBoundary: '用于业务库内的证书数据完整性核验；不构成第三方存证、独立不可篡改证明或最终适航依据。',
  };
}

/**
 * 计算证书内容的 SHA-256 哈希
 */
export function hashCertificateContent(certificate: {
  id: string;
  certificateNumber: string;
  partNumber: string;
  serialNumber?: string | null;
  conditionCode: string | null;
  issueDate: Date;
  expiryDate?: Date | null;
  issuedBy: string;
  [key: string]: unknown;
}): string {
  const content = JSON.stringify({
    id: certificate.id,
    certificateNumber: certificate.certificateNumber,
    partNumber: certificate.partNumber,
    serialNumber: certificate.serialNumber,
    conditionCode: certificate.conditionCode,
    issueDate: certificate.issueDate.toISOString(),
    expiryDate: certificate.expiryDate?.toISOString(),
    issuedBy: certificate.issuedBy,
  });
  return crypto.createHash('sha256').update(content).digest('hex');
}

/**
 * 计算关联记录哈希（历史兼容的简化 PoW 格式）
 */
function calculateBlockHash(
  index: number,
  timestamp: string,
  certificateHash: string,
  previousHash: string,
  nonce: number
): string {
  const data = `${index}${timestamp}${certificateHash}${previousHash}${nonce}`;
  return crypto.createHash('sha256').update(data).digest('hex');
}

/**
 * 生成满足历史格式的 nonce。
 * 这不是外部共识、挖矿或可信时间戳机制。
 */
function mineBlock(
  index: number,
  timestamp: string,
  certificateHash: string,
  previousHash: string,
  difficulty: number = 4
): { hash: string; nonce: number } {
  let nonce = 0;
  const target = '0'.repeat(difficulty);

  while (true) {
    const hash = calculateBlockHash(index, timestamp, certificateHash, previousHash, nonce);
    if (hash.startsWith(target)) {
      return { hash, nonce };
    }
    nonce++;

    // 防止无限循环，限制最大尝试次数
    if (nonce > 1000000) {
      return { hash, nonce };
    }
  }
}

/**
 * 获取最后一条完整性记录
 */
async function getLastBlock(): Promise<BlockRecord | null> {
  const lastBlock = await prisma.blockchainRecord.findFirst({
    orderBy: { index: 'desc' },
  });

  if (!lastBlock) return null;

  return {
    index: lastBlock.index,
    timestamp: lastBlock.timestamp.toISOString(),
    certificateId: lastBlock.certificateId,
    certificateHash: lastBlock.certificateHash,
    previousHash: lastBlock.previousHash,
    hash: lastBlock.hash,
    nonce: lastBlock.nonce,
  };
}

/**
 * 创建初始完整性记录
 */
export async function createGenesisBlock(): Promise<BlockRecord> {
  const existing = await getLastBlock();
  if (existing) {
    return existing;
  }

  const timestamp = new Date().toISOString();
  const certificateHash = '0'.repeat(64);
  const previousHash = '0'.repeat(64);

  const { hash, nonce } = mineBlock(0, timestamp, certificateHash, previousHash);

  const block = await prisma.blockchainRecord.create({
    data: {
      index: 0,
      timestamp: new Date(timestamp),
      certificateId: 'genesis',
      certificateHash,
      previousHash,
      hash,
      nonce,
    },
  });

  logger.info({ blockIndex: 0, hash }, 'Integrity-chain anchor record created');

  return {
    index: block.index,
    timestamp: block.timestamp.toISOString(),
    certificateId: block.certificateId,
    certificateHash: block.certificateHash,
    previousHash: block.previousHash,
    hash: block.hash,
    nonce: block.nonce,
  };
}

/**
 * 写入证书完整性关联记录
 */
export async function storeCertificate(
  certificate: {
    id: string;
    certificateNumber: string;
    partNumber: string;
    serialNumber?: string | null;
    conditionCode: string | null;
    issueDate: Date;
    expiryDate?: Date | null;
    issuedBy: string;
  }
): Promise<BlockRecord> {
  // 确保证书未被重复存证
  const existing = await prisma.blockchainRecord.findUnique({
    where: { certificateId: certificate.id },
  });

  if (existing) {
    throw new Error(`Certificate ${certificate.id} already has an integrity record`);
  }

  // 获取上一个区块
  let lastBlock = await getLastBlock();
  if (!lastBlock) {
    lastBlock = await createGenesisBlock();
  }

  const index = lastBlock.index + 1;
  const timestamp = new Date().toISOString();
  const certificateHash = hashCertificateContent(certificate);
  const previousHash = lastBlock.hash;

  // 生成历史兼容的关联哈希
  const { hash, nonce } = mineBlock(index, timestamp, certificateHash, previousHash);

  // 保存区块
  const block = await prisma.blockchainRecord.create({
    data: {
      index,
      timestamp: new Date(timestamp),
      certificateId: certificate.id,
      certificateHash,
      previousHash,
      hash,
      nonce,
    },
  });

  logger.info({
    blockIndex: index,
    certificateId: certificate.id,
    hash,
    previousHash,
  }, 'Certificate integrity record created');

  return {
    index: block.index,
    timestamp: block.timestamp.toISOString(),
    certificateId: block.certificateId,
    certificateHash: block.certificateHash,
    previousHash: block.previousHash,
    hash: block.hash,
    nonce: block.nonce,
  };
}

/**
 * 验证完整性关联记录链
 */
export async function verifyChain(): Promise<{
  valid: boolean;
  blocksChecked: number;
  invalidBlocks: Array<{ index: number; reason: string }>;
}> {
  const blocks = await prisma.blockchainRecord.findMany({
    orderBy: { index: 'asc' },
  });

  const invalidBlocks: Array<{ index: number; reason: string }> = [];

  for (let i = 0; i < blocks.length; i++) {
    const block = blocks[i];

    // 验证索引连续性
    if (block.index !== i) {
      invalidBlocks.push({ index: block.index, reason: 'Index discontinuity' });
      continue;
    }

    // 验证哈希
    const expectedHash = calculateBlockHash(
      block.index,
      block.timestamp.toISOString(),
      block.certificateHash,
      block.previousHash,
      block.nonce
    );

    if (expectedHash !== block.hash) {
      invalidBlocks.push({ index: block.index, reason: 'Hash mismatch' });
    }

    // 验证前向链接（创世区块除外）
    if (i > 0) {
      const previousBlock = blocks[i - 1];
      if (block.previousHash !== previousBlock.hash) {
        invalidBlocks.push({ index: block.index, reason: 'Previous hash mismatch' });
      }
    }
  }

  return {
    valid: invalidBlocks.length === 0,
    blocksChecked: blocks.length,
    invalidBlocks,
  };
}

/**
 * 验证单个证书完整性关联记录
 */
export async function verifyCertificate(
  certificateId: string
): Promise<{
  verified: boolean;
  block?: BlockRecord;
  certificateHash?: string;
  reason?: string;
}> {
  const block = await prisma.blockchainRecord.findUnique({
    where: { certificateId },
  });

  if (!block) {
    return { verified: false, reason: 'Certificate integrity record not found' };
  }

  // 获取证书数据
  const certificate = await prisma.certificate.findUnique({
    where: { id: certificateId },
  });

  if (!certificate) {
    return { verified: false, reason: 'Certificate not found in database' };
  }

  // 重新计算哈希
  const currentHash = hashCertificateContent(certificate);

  if (currentHash !== block.certificateHash) {
    return {
      verified: false,
      reason: 'Certificate data has been tampered with',
      block: {
        index: block.index,
        timestamp: block.timestamp.toISOString(),
        certificateId: block.certificateId,
        certificateHash: block.certificateHash,
        previousHash: block.previousHash,
        hash: block.hash,
        nonce: block.nonce,
      },
      certificateHash: currentHash,
    };
  }

  // 验证区块哈希
  const expectedHash = calculateBlockHash(
    block.index,
    block.timestamp.toISOString(),
    block.certificateHash,
    block.previousHash,
    block.nonce
  );

  if (expectedHash !== block.hash) {
    return {
      verified: false,
      reason: 'Block hash mismatch',
      block: {
        index: block.index,
        timestamp: block.timestamp.toISOString(),
        certificateId: block.certificateId,
        certificateHash: block.certificateHash,
        previousHash: block.previousHash,
        hash: block.hash,
        nonce: block.nonce,
      },
    };
  }

  return {
    verified: true,
    block: {
      index: block.index,
      timestamp: block.timestamp.toISOString(),
      certificateId: block.certificateId,
      certificateHash: block.certificateHash,
      previousHash: block.previousHash,
      hash: block.hash,
      nonce: block.nonce,
    },
    certificateHash: currentHash,
  };
}

/**
 * 获取完整性关联记录统计
 */
export async function getBlockchainStats(): Promise<{
  totalBlocks: number;
  totalCertificates: number;
  lastBlockTime: string | null;
  chainValid: boolean;
}> {
  const totalBlocks = await prisma.blockchainRecord.count();
  const totalCertificates = await prisma.blockchainRecord.count({
    where: { certificateId: { not: 'genesis' } },
  });

  const lastBlock = await prisma.blockchainRecord.findFirst({
    orderBy: { index: 'desc' },
  });

  const verification = await verifyChain();

  return {
    totalBlocks,
    totalCertificates,
    lastBlockTime: lastBlock?.timestamp.toISOString() || null,
    chainValid: verification.valid,
  };
}
