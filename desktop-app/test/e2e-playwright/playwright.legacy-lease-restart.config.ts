import { defineConfig } from '@playwright/test'
import path from 'node:path'
import { requireImageCapabilitiesFixtureEnv } from './helpers/imageCapabilityEvidence'
import { requireLegacyLeaseLaneEnv } from './helpers/legacyLeaseRestart'

// E2E_GUARDIAN_IPC_FLOW: this file only configures the runner. The spec owns
// visible IPC transitions and reads the external provider ledger as its wire oracle.

/*
 * Desktop App legacy processing-lease restart lane (issue #1022).
 *
 * It reuses the image-capabilities fixture stack (derived Host image, provider
 * fixture, seeded catalog and login) and adds the cluster side: before each
 * scenario the Host and HCC are stopped, one legacy foreign processing lease is
 * seeded on the Host PVC, the scenario's restarts run, and the Desktop journey
 * (approved `shell_exec`, then `clerum__gfs_download`) must succeed on the Host
 * that booted on that ledger.
 *
 *   - It loads NO env file. Every binding is exported by the runner
 *     (`make minikube-run-legacy-lease-restart` or the -vacuity target) and a
 *     missing or inconsistent one fails here, at config load.
 *   - The runner selects the scenarios with --grep: the fixed lane runs the five
 *     `legacy-lease-restart fixture:` tests, the vacuity lane runs the one
 *     `legacy-lease-restart vacuity:` test against the pre-fix Host.
 */

const repoRoot = path.resolve(__dirname, '../../..')

if (process.env.NODE_ENV !== undefined && process.env.NODE_ENV !== 'test') {
  throw new Error(
    `NODE_ENV must be "test" (or unset) for the legacy-lease-restart fixture lane; ` +
      `received "${process.env.NODE_ENV}".`
  )
}
process.env.NODE_ENV = 'test'

// Fail at config load, with every missing binding listed at once.
requireImageCapabilitiesFixtureEnv(process.env)
requireLegacyLeaseLaneEnv(process.env)

const recorderRoot = process.env.QA_RECORDER_ROOT
  ? path.resolve(process.env.QA_RECORDER_ROOT)
  : path.join(repoRoot, '.local-notes', 'qa-recorder')

export default defineConfig({
  testDir: '.',
  testMatch: /qa-recorder-legacy-lease-restart\.spec\.ts/,
  // Per scenario: HCC and Host stop, seed pod, the scenario's own rollouts
  // (S-update replaces GFS, WRC, HCC and the Host), one Electron launch and a
  // two-tool journey with an approval.
  timeout: 660_000,
  expect: { timeout: 30_000 },
  retries: 0,
  workers: 1,
  fullyParallel: false,
  reporter: [['list']],
  outputDir: path.join(recorderRoot, 'runs', 'desktop-app-legacy-lease-restart'),
  preserveOutput: 'always',
})
