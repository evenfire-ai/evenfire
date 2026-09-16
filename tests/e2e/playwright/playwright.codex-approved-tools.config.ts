import { defineConfig, devices } from '@playwright/test'
import { localUrl, required } from './helpers/approved-tools-scenarios'

export default defineConfig({
  testDir: './desktop',
  testMatch: 'codex-subscription-approved-tools.spec.ts',
  fullyParallel: false,
  workers: 1,
  retries: 0,
  timeout: 480_000,
  expect: { timeout: 30_000 },
  forbidOnly: true,
  reporter: [['list'], ['json', { outputFile: required('APPROVED_TOOLS_REPORT') }]],
  outputDir: required('APPROVED_TOOLS_ARTIFACTS'),
  use: {
    ...devices['Desktop Chrome'],
    baseURL: localUrl(required('CONTROL_UI_URL')),
    screenshot: 'only-on-failure',
    video: 'retain-on-failure',
    // Login inputs must not be persisted in Playwright action traces.
    trace: 'off',
  },
})
