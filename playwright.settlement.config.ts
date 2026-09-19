import { defineConfig, devices } from '@playwright/test';
import os from 'node:os';
import path from 'node:path';

const databaseUrl = new URL(process.env.DATABASE_URL || 'file:///missing');
const expectedDatabase = '/aerolink_settlement_test_20260910';
if (process.env.AEROLINK_SETTLEMENT_UI_INTEGRATION !== 'true'
  || !['localhost', '127.0.0.1'].includes(databaseUrl.hostname)
  || databaseUrl.port !== '55970'
  || databaseUrl.pathname !== expectedDatabase) {
  throw new Error('Settlement UI requires explicit opt-in and the local settlement integration database');
}

const backendPort = 3190;
const frontendPort = 5290;
const apiOrigin = `http://127.0.0.1:${backendPort}`;
const clientUrl = `http://127.0.0.1:${frontendPort}`;
const uploadRoot = process.env.AEROLINK_SETTLEMENT_UI_UPLOADS_DIR
  || path.join(os.tmpdir(), 'aerolink-settlement-ui-uploads-20260910');
const nodeCommand = process.platform === 'win32' ? `"${process.execPath}"` : process.execPath;

export default defineConfig({
  testDir: './e2e',
  testMatch: 'settlement-ui.spec.ts',
  fullyParallel: false,
  workers: 1,
  retries: 0,
  forbidOnly: true,
  timeout: 180_000,
  expect: { timeout: 15_000 },
  reporter: 'list',
  outputDir: process.env.AEROLINK_SETTLEMENT_UI_OUTPUT || 'test-results/settlement',
  use: {
    baseURL: clientUrl,
    actionTimeout: 15_000,
    navigationTimeout: 30_000,
    screenshot: 'only-on-failure',
    trace: 'retain-on-failure',
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
  webServer: [
    {
      command: `${nodeCommand} --import tsx src/index.ts`,
      cwd: './server',
      env: {
        ...process.env,
        PORT: String(backendPort),
        NODE_ENV: 'test',
        ENABLE_INLINE_WORKER: 'false',
        CLIENT_URL: clientUrl,
        UPLOADS_DIR: uploadRoot,
        UPLOAD_STAGING_DIR: path.join(uploadRoot, 'staging'),
      },
      url: `${apiOrigin}/api/health`,
      reuseExistingServer: false,
      timeout: 120_000,
    },
    {
      command: `${nodeCommand} node_modules/vite/bin/vite.js --host 127.0.0.1 --port ${frontendPort} --strictPort`,
      env: { ...process.env, VITE_API_URL: `${apiOrigin}/api` },
      url: clientUrl,
      reuseExistingServer: false,
      timeout: 120_000,
    },
  ],
});
