import { defineConfig, devices } from '@playwright/test';

const baseURL = process.env.PLAYWRIGHT_BASE_URL || 'http://127.0.0.1:5173';
const externalServer = process.env.PLAYWRIGHT_EXTERNAL === 'true';
const nodeCommand = process.platform === 'win32' ? `"${process.execPath}"` : process.execPath;

const webServer = externalServer
  ? undefined
  : [
      {
        command: `${nodeCommand} --import tsx src/index.ts`,
        cwd: './server',
        url: 'http://127.0.0.1:3000/api/health',
        reuseExistingServer: !process.env.CI,
        timeout: 120000,
      },
      {
        command: `${nodeCommand} node_modules/vite/bin/vite.js --host 127.0.0.1 --port 5173`,
        url: baseURL,
        reuseExistingServer: !process.env.CI,
        timeout: 120000,
      },
    ];

export default defineConfig({
  testDir: './e2e',
  fullyParallel: false,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 0,
  workers: 1,
  reporter: 'list',
  use: {
    baseURL,
    trace: 'on-first-retry',
  },
  ...(webServer ? { webServer } : {}),
  projects: [
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'] },
    },
  ],
});
