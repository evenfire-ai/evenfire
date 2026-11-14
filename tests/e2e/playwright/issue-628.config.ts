import { defineConfig, devices } from '@playwright/test'

export default defineConfig({
  testDir: './issue-628',
  workers: 1,
  retries: 0,
  timeout: 3_600_000,
  expect: { timeout: 30_000 },
  reporter: [['list'], ['json', { outputFile: process.env.E2E_REPORT_PATH }]],
  use: {
    ...devices['Desktop Chrome'],
    baseURL: process.env.E2E_CONTROL_UI_URL,
    trace: 'off',
    screenshot: 'off',
    video: 'off',
  },
})
