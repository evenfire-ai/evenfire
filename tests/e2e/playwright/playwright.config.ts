import { defineConfig, devices } from '@playwright/test'
import path from 'path'

const CONTROL_UI_URL = process.env.CONTROL_UI_URL ?? 'http://127.0.0.1:3000'

export default defineConfig({
  testDir: '.',
  timeout: 30_000,
  expect: { timeout: 10_000 },
  retries: process.env.CI ? 2 : 0,
  workers: 1, // sequential — tests share cluster state
  reporter: [['html', { open: 'never', outputFolder: 'playwright-report' }], ['list']],
  globalSetup: './global-setup.ts',

  use: {
    screenshot: 'only-on-failure',
    video: 'retain-on-failure',
    trace: 'retain-on-failure',
  },

  projects: [
    {
      name: 'control-ui',
      testMatch: 'control-ui/**/*.spec.ts',
      use: {
        ...devices['Desktop Chrome'],
        baseURL: CONTROL_UI_URL,
        // storageState is applied per-test via the authedPage fixture, NOT here.
        // Applying it project-wide would break auth.spec.ts (needs clean state).
      },
    },
    {
      name: 'desktop',
      testMatch: 'desktop/**/*.spec.ts',
      // Electron tests use the _electron launcher — no browser device needed
    },
  ],

  // Output dirs
  outputDir: path.join(__dirname, 'test-results'),
})
