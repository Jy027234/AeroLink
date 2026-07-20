import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    include: ['src/**/*.test.ts'],
    // Dynamic route imports are materially slower on the supported Node 22
    // clean-environment path; keep the default strict enough to catch hangs
    // while avoiding false failures during cold module loading.
    testTimeout: 15_000,
  },
});
