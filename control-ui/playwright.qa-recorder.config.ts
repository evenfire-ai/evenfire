import { defineConfig } from '@playwright/test'
import path from 'node:path'
import { loadQaRecorderEnv } from '../scripts/qa-recorder/loadEnv'

const repoRoot = path.resolve(__dirname, '..')
loadQaRecorderEnv(repoRoot)

const recorderRoot = process.env.QA_RECORDER_ROOT
  ? path.resolve(process.env.QA_RECORDER_ROOT)
  : path.join(repoRoot, '.local-notes', 'qa-recorder')
const browserChannel = process.env.QA_RECORDER_BROWSER_CHANNEL?.trim()
const slowMo = Number(process.env.QA_RECORDER_SLOW_MO_MS || 75)

if (!Number.isFinite(slowMo) || slowMo < 0) {
  throw new Error('QA_RECORDER_SLOW_MO_MS must be a non-negative number.')
}

export default defineConfig({
  testDir: './e2e',
  // All Control UI recorder journeys share this config. Each journey lives in
  // its own qa-recorder-<journey>.spec.ts and is run via a namespaced
  // qa:recorder:<journey> command (see package.json). Stays isolated from the
  // normal Playwright/CI suite — only recorder specs match.
  testMatch: /qa-recorder-.*\.spec\.ts/,
  timeout: 300_000,
  expect: { timeout: 30_000 },
  reporter: [['list']],
  outputDir: path.join(recorderRoot, 'runs', 'control-ui'),
  preserveOutput: 'always',
  retries: 0,
  workers: 1,
  use: {
    baseURL: process.env.CONTROL_UI_URL || 'http://127.0.0.1:3000',
    headless: process.env.QA_RECORDER_HEADLESS === '1',
    screenshot: 'on',
    trace: 'retain-on-failure',
    video:
      process.env.QA_RECORDER_VIDEO === '0'
        ? 'off'
        : {
            mode: 'on',
            size: { width: 1280, height: 720 },
          },
    viewport: { width: 1280, height: 720 },
  },
  projects: [
    {
      name: 'qa-recorder-chromium',
      use: {
        browserName: 'chromium',
        ...(browserChannel ? { channel: browserChannel } : {}),
        launchOptions: { slowMo },
      },
    },
  ],
})
