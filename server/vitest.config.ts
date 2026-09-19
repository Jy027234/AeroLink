import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    // Route/service imports validate auth configuration eagerly. Keep unit
    // tests independent of developer .env files and test execution order.
    // These values exist only inside Vitest workers, never in app startup.
    env: {
      JWT_SECRET: 'aerolink-unit-test-access-only',
      JWT_REFRESH_SECRET: 'aerolink-unit-test-refresh-only',
    },
    include: ['src/**/*.test.ts'],
    // Dynamic route imports are materially slower on the supported Node 22
    // clean-environment path; keep the default strict enough to catch hangs
    // while avoiding false failures during cold module loading.
    testTimeout: 15_000,
  },
});
