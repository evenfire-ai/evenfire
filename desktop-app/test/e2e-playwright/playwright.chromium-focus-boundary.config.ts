import { defineConfig } from '@playwright/test'
import path from 'node:path'

// Static-page probe of Chromium's focus and pointer-event behaviour. It builds
// nothing and contacts no service, so it does not inherit the shared global
// setup (which logs into a cluster).
export default defineConfig({
  testDir: '.',
  testMatch: /chromium-focus-boundary\.spec\.ts/,
  timeout: 30_000,
  retries: 0,
  workers: 1,
  reporter: [['list']],
  outputDir: path.resolve(__dirname, 'test-results/chromium-focus-boundary'),
  use: { browserName: 'chromium', headless: true, viewport: { width: 800, height: 600 } },
})
