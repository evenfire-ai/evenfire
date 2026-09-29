import { defineConfig } from '@playwright/test'
import path from 'node:path'
import { requireImageCapabilitiesFixtureEnv } from './helpers/imageCapabilityEvidence'

// E2E_GUARDIAN_IPC_FLOW: this file only configures the runner. The spec owns
// visible IPC transitions and reads the external provider ledger as its wire oracle.

/*
 * Desktop App document-upload E2E lane (issue #678).
 *
 * It reuses the image-capabilities fixture stack (derived Host image, provider
 * fixture, seeded catalog and login), so it has the same contract as
 * playwright.image-capabilities.config.ts and for the same reasons:
 *
 *   - It loads NO env file. Every binding is exported by the runner
 *     (`make minikube-run-document-upload`) and a missing or inconsistent one
 *     fails here, at config load, before Playwright launches anything.
 *   - It matches only the document-upload journey, so no recorder journey that
 *     talks to a real provider can run from this lane.
 *
 * The journey attaches a text document through the visible composer picker and
 * asserts, through the provider fixture's ledger, that the document text reached
 * the model through the `clerum__attachment_read` tool and not through the prompt.
 */

const repoRoot = path.resolve(__dirname, '../../..')

if (process.env.NODE_ENV !== undefined && process.env.NODE_ENV !== 'test') {
  throw new Error(
    `NODE_ENV must be "test" (or unset) for the document-upload fixture lane; ` +
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
  testMatch: /qa-recorder-document-upload\.spec\.ts/,
  // One real Electron launch, one sign-in and one chat with two provider turns.
  timeout: 300_000,
  expect: { timeout: 30_000 },
  retries: 0,
  workers: 1,
  reporter: [['list']],
  outputDir: path.join(recorderRoot, 'runs', 'desktop-app-document-upload'),
  preserveOutput: 'always',
})
