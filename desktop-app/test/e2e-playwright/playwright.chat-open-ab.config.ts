import { defineConfig } from '@playwright/test'
import { execFileSync } from 'node:child_process'
import path from 'node:path'
import base from './playwright.config'

// Only this config registers the opt-in benchmark; ordinary collection sees no test.
process.env.DESKTOP_CHAT_OPEN_AB_CONFIG = __filename
process.env.QA_RECORDER_SLOW_MO_MS = '0'
process.env.QA_RECORDER_VIDEO = '0'
const commonDir = execFileSync('git', ['rev-parse', '--git-common-dir'], {
  cwd: path.resolve(__dirname, '../../..'),
  encoding: 'utf8',
}).trim()
const repositoryRoot = path.resolve(__dirname, '../../..', commonDir, '..')
const phase = process.env.CHAT_OPEN_AB_PHASE
if (phase !== 'OL' && phase !== 'W') throw new Error('CHAT_OPEN_AB_PHASE must be OL or W.')

export default defineConfig({
  ...base,
  // The shared global setup stays off: its preflight login spends an attempt from the password
  // budget, it reads E2E_K8S_CONTEXT instead of CHAT_OPEN_AB_KUBE_CONTEXT, and its seed marker
  // ties the profile to this worktree's HEAD while BEFORE is another build. The spec runs the
  // same context guard (assertAllowedKubeContext) before its first kubectl call.
  globalSetup: undefined,
  projects: [{ name: 'chat-open-ab', testMatch: /chat-open-ab\.spec\.ts/ }],
  // Paced opens, 65 s rate-limit windows between launches and stateless suspension waits.
  timeout: 5_400_000,
  expect: { timeout: 30_000 },
  retries: 0,
  workers: 1,
  reporter: [['list']],
  // Playwright empties outputDir on every run; one directory per phase keeps the other's evidence.
  outputDir: path.join(repositoryRoot, `.local-notes/issue1091-evidence/v2/C3/runs-${phase}`),
  preserveOutput: 'always',
})
