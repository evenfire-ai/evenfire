// sort-imports-ignore
// Import order matters: the base config loads the canonical env, and global-setup reads
// E2E_PROD_CONTEXT when it loads, so base comes first or the production block weakens.
import { defineConfig } from '@playwright/test'
import base from './playwright.config'
import { assertBranchOwnedContext } from './global-setup'

// Dedicated lane: it stops control-api on a branch profile, so it never runs with the
// default suite. Validate admission before the inherited global setup contacts anything.
if (process.env.E2E_SESSION_TEAM_UX !== '1') {
  throw new Error('Session team UX lane requires E2E_SESSION_TEAM_UX=1')
}
const context = process.env.E2E_K8S_CONTEXT?.trim()
if (!context) {
  throw new Error('Session team UX lane requires explicit E2E_K8S_CONTEXT')
}
assertBranchOwnedContext(context)
// The spec reads only this variable, while global setup also accepts two aliases: without
// it, the guard could validate a different URL than the lane uses.
if (!process.env.EXTERNAL_REST_API_BASE_URL?.trim()) {
  throw new Error('Session team UX lane requires explicit EXTERNAL_REST_API_BASE_URL')
}

export default defineConfig({
  ...base,
  timeout: 420_000,
  expect: { timeout: 30_000 },
  fullyParallel: false,
  forbidOnly: true,
  reporter: [['list']],
  ...(process.env.E2E_SESSION_TEAM_OUTPUT_DIR
    ? { outputDir: process.env.E2E_SESSION_TEAM_OUTPUT_DIR }
    : {}),
  use: { screenshot: 'only-on-failure', trace: 'on' },
  projects: [{ name: 'session-team-ux', testMatch: '**/session-team-ux.test.ts' }],
})
