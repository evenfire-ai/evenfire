// E2E_GUARDIAN_IPC_FLOW: collection admission is pure; physical runner verification happens before Electron launch.
import { defineConfig } from '@playwright/test'
import path from 'node:path'
import { requireSubscriptionImageRun } from './subscriptionImageRunContract.js'

// This must run before any fixture, setup, renderer probe, or network activity.
const run = requireSubscriptionImageRun()

export default defineConfig({
  testDir: '.',
  testMatch: '**/subscription-image-input.spec.ts',
  projects: [{ name: 'subscription-image-input' }],
  timeout: 240_000,
  expect: { timeout: 20_000 },
  retries: 0,
  workers: 1,
  fullyParallel: false,
  reporter: [['list']],
  outputDir: path.join(run.runRoot, 'playwright-results'),
  metadata: { mode: run.mode, runId: run.runId, profile: run.profile },
  // Playwright action traces retain the plaintext value supplied at visible login.
  // Keep private credentials in RAM; screenshots/video mask the password input.
  use: { screenshot: 'only-on-failure', trace: 'off', video: 'retain-on-failure' },
})
