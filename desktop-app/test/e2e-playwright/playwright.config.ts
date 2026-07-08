// desktop-app/test/e2e-playwright/playwright.config.ts
import { defineConfig } from '@playwright/test'
import fs from 'node:fs'
import path from 'node:path'

// Load .env.e2e for Playwright (vitest helpers load it separately)
const envPath = path.resolve(__dirname, '../../.env.e2e')
if (fs.existsSync(envPath)) {
  const lines = fs.readFileSync(envPath, 'utf8').split('\n')
  for (const line of lines) {
    const trimmed = line.trim()
    if (!trimmed || trimmed.startsWith('#')) continue
    const eqIndex = trimmed.indexOf('=')
    if (eqIndex === -1) continue
    const key = trimmed.slice(0, eqIndex).trim()
    const value = trimmed.slice(eqIndex + 1).trim()
    if (!process.env[key]) process.env[key] = value
  }
}

export default defineConfig({
  testDir: '.',
  // 240s: T1 in the cross-device suite can take 1–2m when the LLM cold-starts
  // and runs through multiple MCP tool approvals before producing the final
  // assistant response. 120s raced the outer test timeout against the 120s
  // waitFor inside the test.
  timeout: 240_000,
  retries: 0,
  workers: 1,
  reporter: 'list',
  globalSetup: path.resolve(__dirname, 'global-setup.ts'),
})
