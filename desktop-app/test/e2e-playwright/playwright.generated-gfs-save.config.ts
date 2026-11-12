import { defineConfig } from '@playwright/test'
import path from 'node:path'
import { requireImageCapabilitiesFixtureEnv } from './helpers/imageCapabilityEvidence'

// E2E_GUARDIAN_IPC_FLOW: this file only configures the runner. The spec owns
// visible IPC transitions and reads the external provider ledger as its wire oracle.

/*
 * Desktop App generated-gfs-save E2E lane.
 *
 * It reuses the image-capabilities fixture stack (derived Host image, provider
 * fixture, seeded catalog and login) with the contract of
 * playwright.attachment-gfs-save.config.ts:
 *
 *   - It loads NO env file. Every binding is exported by the runner
 *     (`make minikube-run-generated-gfs-save`) and a missing or inconsistent
 *     one fails here, at config load, before Playwright launches anything.
 *   - It matches only the generated-files journeys, so no recorder journey that
 *     talks to a real provider can run from this lane.
 *
 * The journeys save generated files, kept attachments and a workspace file to
 * a seeded EvenDrive folder, edit a saved text file in parts, list 100 kept
 * files and delete one after the approval card. The Electron video is recorded
 * by `recordVideo` inside `launchDesktopApp`; trace and failure screenshots
 * come from `use` below.
 */

const repoRoot = path.resolve(__dirname, '../../..')

if (process.env.NODE_ENV !== undefined && process.env.NODE_ENV !== 'test') {
  throw new Error(
    `NODE_ENV must be "test" (or unset) for the generated-gfs-save fixture lane; ` +
      `received "${process.env.NODE_ENV}".`
  )
}
process.env.NODE_ENV = 'test'

// Fail at config load, with every missing binding listed at once.
requireImageCapabilitiesFixtureEnv(process.env)

const recorderRoot = process.env.QA_RECORDER_ROOT
  ? path.resolve(process.env.QA_RECORDER_ROOT)
  : path.join(repoRoot, '.local-notes', 'qa-recorder')

export default defineConfig({
  testDir: '.',
  testMatch: /qa-recorder-generated-gfs-save\.spec\.ts/,
  // One Electron launch and sign-in in beforeAll, then eight serial tests.
  // The runner cuts Playwright at 900s for the whole lane.
  timeout: 180_000,
  expect: { timeout: 30_000 },
  retries: 0,
  workers: 1,
  reporter: [['list']],
  outputDir: path.join(recorderRoot, 'runs', 'desktop-app-generated-gfs-save'),
  preserveOutput: 'always',
  use: {
    trace: 'on',
    screenshot: 'only-on-failure',
  },
})
