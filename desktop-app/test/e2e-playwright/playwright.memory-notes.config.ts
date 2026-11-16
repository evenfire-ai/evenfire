import { defineConfig } from '@playwright/test'
import path from 'node:path'
import { requireImageCapabilitiesFixtureEnv } from './helpers/imageCapabilityEvidence'

// E2E_GUARDIAN_IPC_FLOW: this file only configures the runner. The spec owns
// visible IPC transitions and reads the external provider ledger as its wire oracle.

/*
 * Desktop App memory-notes E2E lane.
 *
 * It reuses the image-capabilities fixture stack (derived Host image, provider
 * fixture, seeded catalog and login), so it has the same contract as
 * playwright.attachment-gfs-save.config.ts:
 *
 *   - It loads NO env file. Every binding is exported by the runner
 *     (`make minikube-run-memory-notes`) and a missing or inconsistent one
 *     fails here, at config load, before Playwright launches anything.
 *   - It matches only the memory-notes journey, so no recorder journey that
 *     talks to a real provider can run from this lane.
 *
 * The journey asks the agent to remember a fact, to save a named note, and to
 * recall both in a new conversation, and checks the files, the record row and
 * the fixture ledger. The Electron video is recorded by `recordVideo` inside
 * `launchDesktopApp`; trace and failure screenshots come from `use` below.
 */

const repoRoot = path.resolve(__dirname, '../../..')

if (process.env.NODE_ENV !== undefined && process.env.NODE_ENV !== 'test') {
  throw new Error(
    `NODE_ENV must be "test" (or unset) for the memory-notes fixture lane; ` +
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
  testMatch: /qa-recorder-memory-notes\.spec\.ts/,
  // One Electron launch and sign-in in beforeAll, then three serial tests.
  // The runner cuts Playwright at 900s, so each test stays within 180s.
  timeout: 180_000,
  expect: { timeout: 30_000 },
  retries: 0,
  workers: 1,
  reporter: [['list']],
  outputDir: path.join(recorderRoot, 'runs', 'desktop-app-memory-notes'),
  preserveOutput: 'always',
  use: {
    trace: 'on',
    screenshot: 'only-on-failure',
  },
})
