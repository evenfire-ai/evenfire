import { defineConfig } from '@playwright/test'
import './playwright.config'

// Dedicated lane: it stops control-api on a branch profile, so it never runs with the default suite.
export default defineConfig({
  testDir: __dirname,
  testMatch: 'session-team-ux.test.ts',
  timeout: 420_000,
  expect: { timeout: 30_000 },
  retries: 0,
  workers: 1,
  fullyParallel: false,
  forbidOnly: true,
  reporter: [['list']],
  outputDir: process.env.E2E_SESSION_TEAM_OUTPUT_DIR,
  use: { screenshot: 'only-on-failure', trace: 'on' },
})
