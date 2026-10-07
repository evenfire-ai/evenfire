import { defineConfig, devices } from '@playwright/test'
import { localUrl, required } from './helpers/approved-tools-scenarios'

export default defineConfig({
  testDir: './desktop',
  testMatch: 'codex-subscription-approved-tools.spec.ts',
  fullyParallel: false,
  workers: 1,
  retries: 0,
  // Eight serial tests at 480 s each can outlast the runner's outer deadline
  // (#715). Stopping at the first failure keeps a failing run inside it, so
  // the run still ends with its JSON report. The runner still requires all
  // eight titles to pass and zero skipped tests.
  maxFailures: 1,
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
