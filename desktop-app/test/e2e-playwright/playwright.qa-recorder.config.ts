import { defineConfig } from '@playwright/test'
import path from 'node:path'
import { loadQaRecorderEnv } from '../../../scripts/qa-recorder/loadEnv'

const repoRoot = path.resolve(__dirname, '../../..')
loadQaRecorderEnv(repoRoot)

const recorderRoot = process.env.QA_RECORDER_ROOT
  ? path.resolve(process.env.QA_RECORDER_ROOT)
  : path.join(repoRoot, '.local-notes', 'qa-recorder')

export default defineConfig({
  testDir: '.',
  // All Desktop App recorder journeys share this config. Each journey lives in
  // its own qa-recorder-<journey>.spec.ts and is run via a namespaced
  // qa:recorder:<journey> command (see package.json). This stays isolated from
  // the normal Playwright/CI suite — only recorder specs match.
  testMatch: /qa-recorder-.*\.spec\.ts/,
  timeout: 240_000,
  expect: { timeout: 30_000 },
  retries: 0,
  workers: 1,
  reporter: [['list']],
  outputDir: path.join(recorderRoot, 'runs', 'desktop-app'),
  preserveOutput: 'always',
})
