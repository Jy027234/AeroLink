import { Router } from 'express';
import { requireCapability } from '../middleware/capability.js';
import {
  storeCertificate,
  verifyCertificate,
  verifyChain,
  getBlockchainStats,
  hashCertificateContent,
} from '../lib/blockchain.js';
import prisma from '../lib/prisma.js';

const router = Router();

/**
 * POST /api/blockchain/store/:certificateId
 * Store a certificate in the blockchain
 */
router.post('/store/:certificateId', requireCapability('certificate', 'issue'), async (req, res, next) => {
  try {
    const { certificateId } = req.params;

    const certificate = await prisma.certificate.findUnique({
      where: { id: certificateId },
    });

    if (!certificate) {
      return res.status(404).json({
        success: false,
        error: 'Certificate not found',
      });
    }

    const block = await storeCertificate(certificate);

    res.json({
      success: true,
      data: block,
    });
  } catch (err) {
    next(err);
  }
});

/**
 * GET /api/blockchain/verify/:certificateId
 * Verify a certificate's blockchain record
 */
router.get('/verify/:certificateId', requireCapability('blockchain', 'read'), async (req, res, next) => {
  try {
    const { certificateId } = req.params;

    const result = await verifyCertificate(certificateId);

    res.json({
      success: true,
      data: result,
    });
  } catch (err) {
    next(err);
  }
});

/**
 * GET /api/blockchain/chain/verify
 * Verify the entire blockchain integrity
 */
router.get('/chain/verify', requireCapability('blockchain', 'read'), async (req, res, next) => {
  try {
    const result = await verifyChain();

    res.json({
      success: true,
      data: result,
    });
  } catch (err) {
    next(err);
  }
});

/**
 * GET /api/blockchain/stats
 * Get blockchain statistics
 */
router.get('/stats', requireCapability('blockchain', 'read'), async (req, res, next) => {
  try {
    const stats = await getBlockchainStats();

    res.json({
      success: true,
      data: stats,
    });
  } catch (err) {
    next(err);
  }
});

/**
 * GET /api/blockchain/records
 * List all blockchain records
 */
router.get('/records', requireCapability('blockchain', 'read'), async (req, res, next) => {
  try {
    const { page = '1', limit = '20' } = req.query;
    const pageNum = parseInt(page as string, 10);
    const limitNum = parseInt(limit as string, 10);
    const skip = (pageNum - 1) * limitNum;

    const [records, total] = await Promise.all([
      prisma.blockchainRecord.findMany({
        orderBy: { index: 'asc' },
        skip,
        take: limitNum,
      }),
      prisma.blockchainRecord.count(),
    ]);

    res.json({
      success: true,
      data: {
        records,
        total,
        page: pageNum,
        limit: limitNum,
        totalPages: Math.ceil(total / limitNum),
      },
    });
  } catch (err) {
    next(err);
  }
});

/**
 * GET /api/blockchain/hash/:certificateId
 * Get the hash of a certificate
 */
router.get('/hash/:certificateId', requireCapability('blockchain', 'read'), async (req, res, next) => {
  try {
    const { certificateId } = req.params;

    const certificate = await prisma.certificate.findUnique({
      where: { id: certificateId },
    });

    if (!certificate) {
      return res.status(404).json({
        success: false,
        error: 'Certificate not found',
      });
    }

    const hash = hashCertificateContent(certificate);

    res.json({
      success: true,
      data: {
        certificateId,
        hash,
      },
    });
  } catch (err) {
    next(err);
  }
});

export default router;
