import { defineConfig, devices } from '@playwright/test'
import {
  approvedToolsProvider,
  approvedToolsSuite,
  localUrl,
  required,
} from './helpers/approved-tools-scenarios'

const mode = required('APPROVED_TOOLS_UPSTREAM_MODE')
if (!['deterministic', 'real', 'real-hybrid'].includes(mode))
  throw new Error('APPROVED_TOOLS_UPSTREAM_MODE must be deterministic, real or real-hybrid')
const provider = approvedToolsProvider()
const suite = approvedToolsSuite()
if (provider === 'grok' && mode !== 'deterministic')
  throw new Error('The Grok approved-tools lane runs only in deterministic mode')
if (provider === 'grok' && suite !== 'model-step-retry')
  throw new Error('The Grok approved-tools lane runs only the model-step-retry suite')
if (suite === 'model-step-retry' && mode !== 'deterministic')
  throw new Error('The model-step-retry suite runs only in deterministic mode')
if (suite === 'native-workflow' && mode !== 'deterministic')
  throw new Error('The native-workflow suite runs only in deterministic mode')

// #1048: one suite per lane run, with no dependency between them.
// `approved-tools` runs the seven base journeys (or, in real-hybrid mode, the two
// hybrid cases); `native-workflow` runs the one workflow case, which owns the
// custom coordinator fixture; `model-step-retry` runs the visible setup once plus
// the retry cases it owns. Playwright matches `grep` against the joined
// project/file/title path, so the patterns are not anchored; the trailing colon
// keeps C10 and C11 apart from C1. The setup title is the one constant both retry
// suites exclude from their own project, so a setup failure skips them and the
// runner refuses the skip instead of repeating the grant capture in a fresh
// worker.
const setupGrep = /model step retry setup: /
const modelStepSetupProject = {
  name: 'model-step-retry-setup',
  testMatch: 'model-step-retry-codex.spec.ts',
  grep: setupGrep,
}
const grokProjects = [
  modelStepSetupProject,
  {
    name: 'model-step-retry-grok',
    testMatch: 'model-step-retry-codex.spec.ts',
    grep: /model step retry C(?:1|2|11): /,
    dependencies: ['model-step-retry-setup'],
  },
]
const modelStepProjects = [
  modelStepSetupProject,
  {
    name: 'model-step-retry',
    testMatch: 'model-step-retry-codex.spec.ts',
    grepInvert: setupGrep,
    dependencies: ['model-step-retry-setup'],
  },
]
const approvedToolsProjects =
  mode === 'real-hybrid'
    ? [
        {
          name: 'model-step-retry-hybrid',
          testMatch: 'model-step-retry-codex-hybrid.spec.ts',
        },
      ]
    : suite === 'native-workflow'
      ? [{ name: 'native-workflow', testMatch: 'codex-native-workflow.spec.ts' }]
      : [{ name: 'approved-tools', testMatch: 'codex-subscription-approved-tools.spec.ts' }]

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
    // This lane records the Control UI pages too, so a failure can be read from
    // the page that produced it (`e2e-recording-is-playwright-only`).
    video: 'on',
    // Login inputs must not be persisted in Playwright action traces.
    trace: 'off',
  },
  projects:
    provider === 'grok'
      ? grokProjects
      : suite === 'model-step-retry'
        ? modelStepProjects
        : approvedToolsProjects,
})
