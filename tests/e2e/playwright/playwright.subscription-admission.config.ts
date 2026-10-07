// Selection-only config. The negative spec owns waitForResponse on the real unauthenticated auth probe.
import { defineConfig, devices } from '@playwright/test'
import { requireSubscriptionAdmissionGuardEnv } from './helpers/subscription-admission-guard'

// Pure admission before setup/browser/network; this lane has no global setup or login preflight.
const target = requireSubscriptionAdmissionGuardEnv()
export default defineConfig({
  testDir: '.',
  testMatch: 'control-ui/codex-subscription-admission.spec.ts',
  grep: /unauthenticated/,
  timeout: 45_000,
  expect: { timeout: 20_000 },
  retries: 0,
  workers: 1,
  fullyParallel: false,
  reporter: [['list']],
  outputDir: target.outputDir,
  metadata: { context: target.context, lane: 'subscription-admission-negative-guards' },
  projects: [{ name: 'control-ui', use: { ...devices['Desktop Chrome'], baseURL: target.url } }],
  use: { screenshot: 'only-on-failure', trace: 'retain-on-failure', video: 'retain-on-failure' },
})
