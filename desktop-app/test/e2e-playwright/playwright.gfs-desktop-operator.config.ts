import { defineConfig } from '@playwright/test'
import path from 'node:path'
import {
  gfsOperatorEvidenceDirectory,
  requireGfsOperatorRunId,
} from './gfsDesktopOperatorParityContract'
import baseConfig from './playwright.config'

const runId = requireGfsOperatorRunId()
const evidenceDirectory = gfsOperatorEvidenceDirectory(runId)

export default defineConfig({
  ...baseConfig,
  testDir: __dirname,
  testMatch: 'gfs-desktop-operator-parity.test.ts',
  timeout: 240_000,
  retries: 0,
  workers: 1,
  fullyParallel: false,
  forbidOnly: true,
  globalSetup: path.resolve(__dirname, 'gfs-desktop-operator-parity.global-setup.ts'),
  outputDir: path.join(evidenceDirectory, 'test-results'),
  reporter: [
    ['list'],
    [path.resolve(__dirname, 'gfs-desktop-operator-parity.reporter.ts')],
    ['html', { open: 'never', outputFolder: path.join(evidenceDirectory, 'playwright-report') }],
  ],
  use: {
    ...baseConfig.use,
    screenshot: 'only-on-failure',
    trace: 'retain-on-failure',
    video: 'retain-on-failure',
  },
})
