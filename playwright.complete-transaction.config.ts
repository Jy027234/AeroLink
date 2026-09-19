import { defineConfig } from '@playwright/test';
import settlementConfig from './playwright.settlement.config';

// Inherits the exact 41-migration local DB guard, separate object storage,
// fixed ports and disabled worker. No existing services are reused.
if (process.env.AEROLINK_COMPLETE_TRANSACTION_UI_INTEGRATION !== 'true'
  || process.env.AEROLINK_PROCUREMENT_UI_INTEGRATION !== 'true') {
  throw new Error('Complete transaction UI requires both explicit integration flags');
}

export default defineConfig({
  ...settlementConfig,
  testMatch: 'procurement-ui.spec.ts',
  timeout: 240_000,
  outputDir: process.env.AEROLINK_COMPLETE_TRANSACTION_UI_OUTPUT || 'test-results/complete-transaction',
});
