import { defineConfig } from '@playwright/test'
import path from 'node:path'
import { requireImageCapabilitiesFixtureEnv } from './helpers/imageCapabilityEvidence'

// E2E_GUARDIAN_IPC_FLOW: this file only configures the runner. The spec owns
// visible IPC transitions and reads the external provider ledger as its wire oracle.

/*
 * Desktop App image-capability E2E lane (issue #654).
 *
 * This config is deliberately separate from playwright.qa-recorder.config.ts:
 *
 *   - It loads NO env file. The sibling recorder config calls
 *     loadQaRecorderEnv(), which reads .env.qa-recorder into process.env; this
 *     lane must never inherit a developer's recorder identity, a paid opt-in, or
 *     a stray QA_RECORDER_ALLOW_REMOTE escape hatch. Every binding it needs is
 *     exported by the runner that starts it, and a missing or inconsistent
 *     binding fails here, at config load, before Playwright launches anything.
 *   - It matches only the image-capabilities journey, so no other recorder
 *     journey can run from this lane.
 *
 * The journey is a real end-to-end run against the branch-owned local stack:
 * real Electron app, real sign-in through the visible form, real IPC, real
 * host, real database, real RPC proxy. The only simulated party is the external
 * ZAI origin, which the derived in-cluster fixture answers (see
 * tests/e2e/fixtures/image-capabilities). That fixture is what makes the run
 * deterministic and free, and its ledger is the journey's business oracle.
 */

const repoRoot = path.resolve(__dirname, '../../..')

// NODE_ENV=test is this lane's contract, and it is safe here: no code under
// desktop-app branches on NODE_ENV (verified), so pinning it cannot change
// product behavior. An ambient non-test value is a misconfiguration, not
// something to overwrite silently.
if (process.env.NODE_ENV !== undefined && process.env.NODE_ENV !== 'test') {
  throw new Error(
    `NODE_ENV must be "test" (or unset) for the image-capabilities fixture lane; ` +
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
  // Only the image-capability journey: every other qa-recorder spec talks to a
  // real provider, which this lane must never do.
  testMatch: /qa-recorder-image-capabilities\.spec\.ts/,
  // Three chats (unknown-capability gate, visual answer, remove-image text
  // answer) plus one real Electron launch and one real sign-in.
  timeout: 300_000,
  expect: { timeout: 30_000 },
  retries: 0,
  workers: 1,
  reporter: [['list']],
  outputDir: path.join(recorderRoot, 'runs', 'desktop-app-image-capabilities'),
  preserveOutput: 'always',
})
