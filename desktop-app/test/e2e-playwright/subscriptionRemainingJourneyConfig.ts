// E2E_GUARDIAN_IPC_FLOW: independent opt-in config, no legacy global setup or network action during collection.
import { defineConfig } from '@playwright/test'
import path from 'node:path'
import { requireSubscriptionImageRun } from './subscriptionImageRunContract.js'
import {
  type RemainingJourneySuite,
  requireRemainingJourney,
} from './subscriptionRemainingJourneysContract.js'

export function remainingJourneyConfig(suite: RemainingJourneySuite, specFile: string) {
  const run = requireSubscriptionImageRun()
  requireRemainingJourney(suite, run)
  return defineConfig({
    testDir: '.',
    testMatch: `**/${specFile}`,
    projects: [{ name: suite }],
    timeout: 240_000,
    expect: { timeout: 20_000 },
    retries: 0,
    workers: 1,
    fullyParallel: false,
    reporter: [['list']],
    outputDir: path.join(run.runRoot, `playwright-${suite}-results`),
    metadata: { mode: run.mode, runId: run.runId, profile: run.profile, suite },
    // Automatic tracing would retain the real login password fill. Main may
    // start an owned trace only after the visible login fixture has completed.
    use: { screenshot: 'only-on-failure', trace: 'off', video: 'retain-on-failure' },
  })
}
