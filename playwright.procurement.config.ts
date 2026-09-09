import { defineConfig, devices } from '@playwright/test';

// Isolated, opt-in integration run. Never starts the outbox worker on a clone
// that deliberately retains historical and negative test fixtures.
const db = new URL(process.env.DATABASE_URL || 'file:///missing');
if (process.env.AEROLINK_PROCUREMENT_UI_INTEGRATION !== 'true'
  || !['localhost', '127.0.0.1'].includes(db.hostname) || db.port !== '55970'
  || db.pathname !== '/aerolink_procurement_test_direct_20260909') {
  throw new Error('Procurement UI requires explicit opt-in and the local direct integration database');
}
const node = `"${process.execPath}"`;
export default defineConfig({
  testDir: './e2e', testMatch: 'procurement-ui.spec.ts', workers: 1, retries: 0,
  timeout: 180_000, expect: { timeout: 15_000 }, reporter: 'list',
  outputDir: process.env.AEROLINK_PROCUREMENT_UI_OUTPUT || 'test-results/procurement',
  use: { baseURL: 'http://127.0.0.1:5289', screenshot: 'only-on-failure', trace: 'retain-on-failure' },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
  webServer: [
    { command: `${node} --import tsx src/index.ts`, cwd: './server',
      env: { ...process.env, PORT: '3189', NODE_ENV: 'test', ENABLE_INLINE_WORKER: 'false', CLIENT_URL: 'http://127.0.0.1:5289' },
      url: 'http://127.0.0.1:3189/api/health', reuseExistingServer: false, timeout: 120_000 },
    { command: `${node} node_modules/vite/bin/vite.js --host 127.0.0.1 --port 5289 --strictPort`,
      env: { ...process.env, VITE_API_URL: 'http://127.0.0.1:3189/api' },
      url: 'http://127.0.0.1:5289', reuseExistingServer: false, timeout: 120_000 },
  ],
});
