import { defineConfig, devices } from '@playwright/test'
import path from 'node:path'

const port = Number(process.env.PROFILE_UI_RECOVERY_PORT || 31873)
const baseURL = `http://127.0.0.1:${port}`

export default defineConfig({
  testDir: path.join(__dirname, 'profile-ui-recovery'),
  testMatch: '**/*.spec.ts',
  timeout: 60_000,
  expect: { timeout: 15_000 },
  workers: 1,
  retries: 0,
  reporter: [['list']],
  outputDir: path.join(__dirname, 'test-results', 'profile-ui-recovery'),
  use: {
    ...devices['Desktop Chrome'],
    baseURL,
    screenshot: 'only-on-failure',
    video: 'retain-on-failure',
    trace: 'retain-on-failure',
  },
  webServer: {
    command: 'node profile-ui-recovery-fixture.mjs',
    url: `${baseURL}/invitations/synthetic-reset-proof`,
    reuseExistingServer: false,
    timeout: 120_000,
    env: { PROFILE_UI_RECOVERY_PORT: String(port) },
  },
})
