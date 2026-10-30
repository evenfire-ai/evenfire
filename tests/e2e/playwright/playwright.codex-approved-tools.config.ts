import { defineConfig, devices } from '@playwright/test'
import { approvedToolsProvider, localUrl, required } from './helpers/approved-tools-scenarios'

const mode = required('APPROVED_TOOLS_UPSTREAM_MODE')
if (!['deterministic', 'real', 'real-hybrid'].includes(mode))
  throw new Error('APPROVED_TOOLS_UPSTREAM_MODE must be deterministic, real or real-hybrid')
const provider = approvedToolsProvider()
if (provider === 'grok' && mode !== 'deterministic')
  throw new Error('The Grok approved-tools lane runs only in deterministic mode')

// #1044: the Grok lane runs C1, C2 and C11 only, with its own visible setup in the
// spec, so it has no dependency on the Codex approved-tools journey. Playwright
// matches `grep` against the joined project/file/title path, so the pattern is
// not anchored; the trailing colon keeps C10 and C11 apart from C1.
const grokProjects = [
  {
    name: 'model-step-retry-grok',
    testMatch: 'model-step-retry-codex.spec.ts',
    grep: /model step retry C(?:1|2|11): /,
  },
]

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
  projects:
    provider === 'grok'
      ? grokProjects
      : [
          ...(mode === 'real-hybrid'
            ? [
                {
                  name: 'model-step-retry-hybrid',
                  testMatch: 'model-step-retry-codex-hybrid.spec.ts',
                },
              ]
            : [{ name: 'approved-tools', testMatch: 'codex-subscription-approved-tools.spec.ts' }]),
          // #1044: the model-step retry cases reuse the agent the approved-tools
          // journey binds to the subscription model, so they run only after it and
          // never if it failed (a dependency failure skips them, which the runner
          // rejects). The hybrid project uses an already prepared real grant and
          // its own test-only proxy image to inject one 503 after a tool result.
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
