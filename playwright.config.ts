import { defineConfig, devices } from '@playwright/test';

const backendPort = Number(process.env.PLAYWRIGHT_BACKEND_PORT || '3000');
const frontendPort = Number(process.env.PLAYWRIGHT_FRONTEND_PORT || '5173');
const localApiOrigin = `http://127.0.0.1:${backendPort}`;
const apiOrigin = process.env.PLAYWRIGHT_API_ORIGIN || localApiOrigin;
const baseURL = process.env.PLAYWRIGHT_BASE_URL || `http://127.0.0.1:${frontendPort}`;
const externalServer = process.env.PLAYWRIGHT_EXTERNAL === 'true';
const nodeCommand = process.platform === 'win32' ? `"${process.execPath}"` : process.execPath;

const webServer = externalServer
  ? undefined
  : [
      {
        command: `${nodeCommand} --import tsx src/index.ts`,
        cwd: './server',
        env: { ...process.env, PORT: String(backendPort), ENABLE_INLINE_WORKER: 'true' },
        url: `${localApiOrigin}/api/health`,
        reuseExistingServer: !process.env.CI,
        timeout: 120000,
      },
      {
        command: `${nodeCommand} node_modules/vite/bin/vite.js --host 127.0.0.1 --port ${frontendPort}`,
        env: { ...process.env, VITE_API_URL: `${apiOrigin}/api` },
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
