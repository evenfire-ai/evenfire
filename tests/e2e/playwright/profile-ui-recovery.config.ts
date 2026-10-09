import { defineConfig, devices } from '@playwright/test'
import path from 'node:path'

const port = Number(process.env.PROFILE_UI_RECOVERY_PORT || 31873)
const baseURL = `http://127.0.0.1:${port}`
const scratchRoot = process.env.CODEX_SCRATCH_ROOT

if (!scratchRoot) {
  throw new Error('CODEX_SCRATCH_ROOT is required for Profile UI recovery browser artifacts')
}

export default defineConfig({
  testDir: path.join(__dirname, 'profile-ui-recovery'),
  testMatch: '**/*.spec.ts',
  timeout: 60_000,
  expect: { timeout: 15_000 },
  workers: 1,
  retries: 0,
  reporter: [['list']],
  outputDir: path.join(scratchRoot, 'evenfire', 'pr1056-profile-ui-recovery-results'),
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
