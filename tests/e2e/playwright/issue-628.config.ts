import { defineConfig, devices } from '@playwright/test'

export default defineConfig({
  testDir: './issue-628',
  workers: 1,
  retries: 0,
  // One hour caps test/setup; per-operation limits are independent maxima.
  // Playwright 1.58.2 gives afterEach max(project timeout, test timeout).
  // Keep that teardown budget above the longest command (1_530_000 ms) plus cleanup.
  timeout: 3_600_000,
  expect: { timeout: 30_000 },
  reporter: [['list'], ['json', { outputFile: process.env.E2E_REPORT_PATH }]],
  use: {
    ...devices['Desktop Chrome'],
    actionTimeout: 30_000,
    navigationTimeout: 60_000,
    baseURL: process.env.E2E_CONTROL_UI_URL,
    trace: 'off',
    screenshot: 'off',
    video: 'off',
  },
})
