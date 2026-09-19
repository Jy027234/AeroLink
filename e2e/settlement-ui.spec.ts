import { test } from '@playwright/test';
import { createSettlementUiFixture, SETTLEMENT_UI_PASSWORD } from './helpers/settlementFixture';
import { runSettlementWorkflow } from './helpers/settlementWorkflow';

test.skip(process.env.AEROLINK_SETTLEMENT_UI_INTEGRATION !== 'true', 'Use the isolated settlement config and explicit opt-in');

test('finance records external vouchers and reversals; sales sees receivables only', async ({ page, browser }, testInfo) => {
  const fixture = await createSettlementUiFixture();
  await runSettlementWorkflow({ page, browser, testInfo, fixture, password: SETTLEMENT_UI_PASSWORD,
    apiOrigin: 'http://127.0.0.1:3190' });
});
