import { defineConfig } from '@playwright/test'
import path from 'node:path'

// Seeded production-component identity journey. No cluster login/global setup.
// From desktop-app: npx playwright test --config test/e2e-playwright/playwright.agent-identity.config.ts
// Covers presentation/navigation contracts, not native IPC or suspend/wake lifecycle.
export default defineConfig({
  testDir: '.',
  testMatch: /agent-identity\.seeded\.spec\.ts/,
  timeout: 30_000,
  retries: 0,
  workers: 1,
  reporter: [['list']],
  outputDir: path.resolve(__dirname, 'test-results/agent-identity'),
  use: {
    browserName: 'chromium',
    headless: true,
    viewport: { width: 1440, height: 1000 },
    screenshot: 'only-on-failure',
  },
})
