// Playwright: the end-to-end smoke test (e2e/) against the built app in fake
// mode. Run with `npm run test:e2e` (builds first). Screenshots and traces go
// to e2e-artifacts/ (gitignored).
import { defineConfig, devices } from '@playwright/test';

export default defineConfig({
  testDir: 'e2e',
  outputDir: 'e2e-artifacts/test-results',
  fullyParallel: false,
  workers: 1,
  timeout: 120_000,
  expect: { timeout: 15_000 },
  reporter: [['list']],
  use: {
    ...devices['Desktop Chrome'],
    viewport: { width: 1440, height: 900 },
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
});
