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

export default defineConfig({
  ...base,
  globalSetup: undefined,
  projects: [{ name: 'chat-open-ab', testMatch: /chat-open-ab\.spec\.ts/ }],
  // Paced opens, 65 s rate-limit windows between launches and stateless suspension waits.
  timeout: 5_400_000,
  expect: { timeout: 30_000 },
  retries: 0,
  workers: 1,
  reporter: [['list']],
  outputDir: path.join(repositoryRoot, '.local-notes/issue1091-evidence/v2/C3/runs'),
  preserveOutput: 'always',
})
