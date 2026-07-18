import { Router } from 'express';
import { getProductFeatureStatuses } from '../lib/productFeatures.js';

const router = Router();

/**
 * Returns the server-authoritative availability of experimental product areas.
 * Clients may use this only for presentation; feature-specific server routes
 * remain responsible for enforcing their own flags.
 */
router.get('/', (_req, res) => {
  res.json({
    success: true,
    data: getProductFeatureStatuses(),
  });
});

export default router;
