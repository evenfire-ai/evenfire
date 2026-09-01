import { defineConfig, devices } from '@playwright/test'
import path from 'path'

const LOOPBACK_V4 = ['127', '0', '0', '1'].join('.')
const CONTROL_UI_URL =
  process.env.CONTROL_UI_URL ?? process.env.CONTROL_UI_BASE_URL ?? `http://${LOOPBACK_V4}:3000`

export default defineConfig({
  testDir: '.',
  globalSetup: path.join(__dirname, 'global-setup.ts'),
  timeout: 45_000,
  expect: { timeout: 15_000 },
  retries: 0,
  workers: 1,
  reporter: [['list']],
  use: {
    screenshot: 'only-on-failure',
    video: 'retain-on-failure',
    trace: 'retain-on-failure',
  },
  projects: [
    {
      name: 'control-ui',
      testMatch: 'control-ui/codex-subscription-*.spec.ts',
      use: {
        ...devices['Desktop Chrome'],
        baseURL: CONTROL_UI_URL,
      },
    },
    {
      name: 'desktop',
      testMatch: 'desktop/codex-subscription-*.spec.ts',
    },
  ],
  outputDir: path.join(__dirname, 'test-results-codex-subscription'),
})
