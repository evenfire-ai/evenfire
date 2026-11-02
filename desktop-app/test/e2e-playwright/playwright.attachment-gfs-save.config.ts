import { defineConfig } from '@playwright/test'
import path from 'node:path'
import { requireImageCapabilitiesFixtureEnv } from './helpers/imageCapabilityEvidence'

// E2E_GUARDIAN_IPC_FLOW: this file only configures the runner. The spec owns
// visible IPC transitions and reads the external provider ledger as its wire oracle.

/*
 * Desktop App attachment-gfs-save E2E lane.
 *
 * It reuses the image-capabilities fixture stack (derived Host image, provider
 * fixture, seeded catalog and login), so it has the same contract as
 * playwright.document-upload.config.ts and for the same reasons:
 *
 *   - It loads NO env file. Every binding is exported by the runner
 *     (`make minikube-run-attachment-gfs-save`) and a missing or inconsistent
 *     one fails here, at config load, before Playwright launches anything.
 *   - It matches only the attachment-save journey, so no recorder journey that
 *     talks to a real provider can run from this lane.
 *
 * The journey attaches an image and a binary file through the visible composer
 * picker, asks the agent to save each into a seeded EvenDrive folder by name,
 * and proves byte equality through the Desktop download and the fixture ledger.
 * The Electron video is recorded by `recordVideo` inside `launchDesktopApp`;
 * trace and failure screenshots come from `use` below.
 */

const repoRoot = path.resolve(__dirname, '../../..')

if (process.env.NODE_ENV !== undefined && process.env.NODE_ENV !== 'test') {
  throw new Error(
    `NODE_ENV must be "test" (or unset) for the attachment-gfs-save fixture lane; ` +
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
  testMatch: /qa-recorder-attachment-gfs-save\.spec\.ts/,
  // One Electron launch and sign-in in beforeAll, then three serial tests.
  // The runner cuts Playwright at 900s, so each test stays within 180s.
  timeout: 180_000,
  expect: { timeout: 30_000 },
  retries: 0,
  workers: 1,
  reporter: [['list']],
  outputDir: path.join(recorderRoot, 'runs', 'desktop-app-attachment-gfs-save'),
  preserveOutput: 'always',
  use: {
    trace: 'on',
    screenshot: 'only-on-failure',
  },
})
