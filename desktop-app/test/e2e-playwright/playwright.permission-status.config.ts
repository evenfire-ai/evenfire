import { defineConfig, devices } from '@playwright/test'

export default defineConfig({
  testDir: __dirname,
  testMatch: 'permission-status-reduced-motion.spec.ts',
  fullyParallel: false,
  reporter: 'list',
  projects: [
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'] },
    },
  ],
})
