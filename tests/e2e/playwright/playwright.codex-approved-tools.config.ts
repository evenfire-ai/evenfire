import { defineConfig, devices } from '@playwright/test'
import { localUrl, required } from './helpers/approved-tools-scenarios'

const mode = required('APPROVED_TOOLS_UPSTREAM_MODE')
if (!['deterministic', 'real'].includes(mode))
  throw new Error('APPROVED_TOOLS_UPSTREAM_MODE must be deterministic or real')

export default defineConfig({
  testDir: './desktop',
  fullyParallel: false,
  workers: 1,
  retries: 0,
  timeout: 480_000,
  expect: { timeout: 30_000 },
  forbidOnly: true,
  reporter: [['list'], ['json', { outputFile: required('APPROVED_TOOLS_REPORT') }]],
  outputDir: required('APPROVED_TOOLS_ARTIFACTS'),
  use: {
    ...devices['Desktop Chrome'],
    baseURL: localUrl(required('CONTROL_UI_URL')),
    screenshot: 'only-on-failure',
    video: 'retain-on-failure',
    // Login inputs must not be persisted in Playwright action traces.
    trace: 'off',
  },
  projects: [
    { name: 'approved-tools', testMatch: 'codex-subscription-approved-tools.spec.ts' },
    // #1044: the model-step retry cases reuse the agent the approved-tools
    // journey binds to the subscription model, so they run only after it and
    // never if it failed (a dependency failure skips them, which the runner
    // rejects). A real provider cannot be made to fail on a chosen step, so
    // the project exists only against the deterministic upstream.
    ...(mode === 'deterministic'
      ? [
          {
            name: 'model-step-retry',
            testMatch: 'model-step-retry-codex.spec.ts',
            dependencies: ['approved-tools'],
          },
        ]
      : []),
  ],
})
