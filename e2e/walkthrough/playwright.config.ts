// Playwright: the screenshot walkthrough (docs/WALKTHROUGH.md). Not part of
// `npm run test:e2e`: its file is *.shots.ts, which the main config does not
// match. Run with `npm run docs:screenshots` (builds first); the pictures go
// to docs/images/walkthrough/.
import { defineConfig, devices } from '@playwright/test';

export default defineConfig({
  testDir: '.',
  testMatch: '*.shots.ts',
  outputDir: '../../e2e-artifacts/walkthrough-results',
  fullyParallel: false,
  workers: 1,
  timeout: 240_000,
  expect: { timeout: 15_000 },
  reporter: [['list']],
  use: {
    ...devices['Desktop Chrome'],
    viewport: { width: 1440, height: 900 },
    deviceScaleFactor: 1,
    colorScheme: 'light',
    locale: 'en-US',
    timezoneId: 'UTC',
    actionTimeout: 15_000,
    trace: 'retain-on-failure',
  },
});
