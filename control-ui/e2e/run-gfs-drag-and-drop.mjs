#!/usr/bin/env node
// control-ui/e2e/run-gfs-drag-and-drop.mjs
//
// Frontend-owned E2E gate for the EvenDrive drag-and-drop journeys.
//
// WHY THIS EXISTS. The journey suite in `e2e/gfs-drag-and-drop.spec.ts`
// mutates a shared dev environment, so it skips itself unless the operator
// sets the mutation opt-in and configures the admin credential. A skipped
// suite exits 0: "no setup" and "the journeys passed" look identical on the
// command line. That is exactly the failure this gate removes.
//
// THE CONTRACT.
//   1. Requesting the gate WITHOUT the required setup FAILS LOUD (exit 1)
//      with an actionable message. It never silently degrades to "skip".
//   2. The gate NEVER reports success for zero executed journeys, and never
//      reports success while any journey was skipped.
//   3. The live-fixture opt-in stays EXPLICIT. This gate is a separate,
//      named command; the ordinary unit/CI lanes never mutate the dev
//      environment, because nothing in `npm test` calls this file.
//
// Usage (from control-ui/):
//   QA_RECORDER_CONFIRM_MUTATIONS=1 \
//   E2E_ADMIN_USER=<admin> ADMIN_PASSWORD=<password> \
//   CONTROL_UI_URL=http://127.0.0.1:<port> \
//   CONTROL_API_URL=http://127.0.0.1:<port> \
//     npm run e2e:gfs-drag-and-drop
//
// Exit codes: 0 = every requested journey ran and passed. 1 = the gate
// refused to run, or the journey result was not a clean pass.
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const APP_ROOT = path.resolve(HERE, '..')
const REPO_ROOT = path.resolve(APP_ROOT, '..')

export const CONFIRM_MUTATIONS_FLAG = 'QA_RECORDER_CONFIRM_MUTATIONS'
export const ADMIN_USER_KEYS = ['E2E_ADMIN_USER', 'ADMIN_USER', 'ADMIN_USERNAME']
export const ADMIN_PASSWORD_KEYS = [
  'E2E_ADMIN_PASSWORD',
  'ADMIN_PASSWORD',
  'ADMIN_PASS',
  'TEST_ADMIN_PASSWORD',
]

const PROBE_TIMEOUT_MS = 10_000
const HEALTH_PATH = '/health'

/** First non-empty value among the candidate env names (never logged). */
export function firstConfiguredValue(env, keys) {
  for (const key of keys) {
    const value = env[key]
    if (typeof value === 'string' && value.trim()) return value.trim()
  }
  return ''
}

export function isLoopbackHostname(hostname) {
  return (
    hostname === '127.0.0.1' ||
    hostname === 'localhost' ||
    hostname === '[::1]' ||
    hostname === '::1'
  )
}

/**
 * The setup the journey suite needs. Returns the problems instead of
 * throwing so the caller can print all of them at once.
 */
export function collectGateProblems(env) {
  const problems = []

  if (env[CONFIRM_MUTATIONS_FLAG] !== '1') {
    problems.push(
      `${CONFIRM_MUTATIONS_FLAG}=1 is not set. The drag-and-drop journeys create, move and delete ` +
        'real GFS fixtures on the configured environment, so the live-fixture opt-in is required.'
    )
  }

  if (!firstConfiguredValue(env, ADMIN_USER_KEYS)) {
    problems.push(`No admin username configured. Set one of: ${ADMIN_USER_KEYS.join(', ')}.`)
  }

  if (!firstConfiguredValue(env, ADMIN_PASSWORD_KEYS)) {
    problems.push(`No admin password configured. Set one of: ${ADMIN_PASSWORD_KEYS.join(', ')}.`)
  }

  const controlUiUrl = env.CONTROL_UI_URL || 'http://localhost:3000'
  const controlApiUrl = env.CONTROL_API_URL || 'http://localhost:8090'
  for (const [label, rawUrl] of [
    ['CONTROL_UI_URL', controlUiUrl],
    ['CONTROL_API_URL', controlApiUrl],
  ]) {
    let parsed
    try {
      parsed = new URL(rawUrl)
    } catch {
      problems.push(`${label} must be an absolute URL; received "${rawUrl}".`)
      continue
    }
    if (!isLoopbackHostname(parsed.hostname) && env.QA_RECORDER_ALLOW_REMOTE !== '1') {
      problems.push(
        `${label} targets non-local host "${parsed.hostname}". Set QA_RECORDER_ALLOW_REMOTE=1 only ` +
          'when that environment is intentionally disposable.'
      )
    }
  }

  return problems
}

/**
 * The verdict of a Playwright JSON report. A run is a clean pass only when
 * at least one journey actually executed, nothing was skipped, and nothing
 * failed. A report that ran zero journeys is NOT a pass.
 */
export function evaluateGateReport(report) {
  const problems = []
  const stats = report && typeof report === 'object' ? (report.stats ?? {}) : {}
  const expected = Number(stats.expected ?? 0)
  const skipped = Number(stats.skipped ?? 0)
  const unexpected = Number(stats.unexpected ?? 0)
  const flaky = Number(stats.flaky ?? 0)

  if (!Number.isFinite(expected) || expected <= 0) {
    problems.push(
      'The journey suite executed zero journeys. A skipped suite is not a green result: ' +
        'check the mutation opt-in, the admin credential and the endpoint configuration.'
    )
  }
  if (skipped > 0) {
    problems.push(`${skipped} journey(s) were skipped. A skipped journey is not a green result.`)
  }
  if (unexpected > 0) {
    problems.push(`${unexpected} journey(s) failed.`)
  }

  return { problems, stats: { expected, skipped, unexpected, flaky } }
}

/** Bounded reachability probe. Never prints the response body. */
export async function probeReachable(url, timeoutMs = PROBE_TIMEOUT_MS) {
  try {
    const response = await fetch(url, {
      method: 'GET',
      redirect: 'manual',
      signal: AbortSignal.timeout(timeoutMs),
    })
    return { ok: response.status < 500, status: response.status }
  } catch (error) {
    return { ok: false, status: 0, error: error instanceof Error ? error.message : String(error) }
  }
}

function resolvePlaywrightBin() {
  const bin = path.join(
    APP_ROOT,
    'node_modules',
    '.bin',
    process.platform === 'win32' ? 'playwright.cmd' : 'playwright'
  )
  if (!fs.existsSync(bin)) {
    throw new Error(
      `Playwright is not installed at ${bin}. Run "npm ci" in control-ui before the E2E gate.`
    )
  }
  return bin
}

function artifactDir() {
  const dir = path.join(REPO_ROOT, '.local-notes', 'infra', 'runs', 'control-ui-gfs-drag-and-drop')
  fs.mkdirSync(dir, { recursive: true })
  return dir
}

async function main() {
  const env = process.env
  const problems = collectGateProblems(env)
  if (problems.length > 0) {
    process.stderr.write('[E2E-GATE] The EvenDrive drag-and-drop gate cannot run:\n')
    for (const problem of problems) process.stderr.write(`  - ${problem}\n`)
    process.stderr.write('[E2E-GATE] Nothing was executed. This is a FAILURE, not a skip.\n')
    return 1
  }

  const controlUiUrl = env.CONTROL_UI_URL || 'http://localhost:3000'
  const controlApiUrl = env.CONTROL_API_URL || 'http://localhost:8090'

  for (const [label, baseUrl] of [
    ['CONTROL_UI_URL', controlUiUrl],
    ['CONTROL_API_URL', controlApiUrl],
  ]) {
    const probe = await probeReachable(`${baseUrl.replace(/\/$/, '')}${HEALTH_PATH}`)
    if (!probe.ok) {
      process.stderr.write(
        `[E2E-GATE] ${label} is not reachable at ${baseUrl}${HEALTH_PATH}` +
          `${probe.error ? ` (${probe.error})` : ` (HTTP ${probe.status})`}. Nothing was executed.\n`
      )
      return 1
    }
  }

  const dir = artifactDir()
  const reportPath = path.join(dir, 'playwright-report.json')
  const playwrightBin = resolvePlaywrightBin()

  process.stdout.write(
    `[E2E-GATE] running the EvenDrive drag-and-drop journeys (report: ${reportPath})\n`
  )
  const run = spawnSync(
    playwrightBin,
    [
      'test',
      '--config=playwright.config.ts',
      '--project=chromium',
      'e2e/gfs-drag-and-drop.spec.ts',
      '--workers=1',
      '--reporter=list,json',
    ],
    {
      cwd: APP_ROOT,
      stdio: 'inherit',
      env: { ...env, PLAYWRIGHT_JSON_OUTPUT_NAME: reportPath },
    }
  )

  if (!fs.existsSync(reportPath)) {
    process.stderr.write(
      '[E2E-GATE] The Playwright JSON report was not written. The gate cannot certify the run.\n'
    )
    return 1
  }

  let report
  try {
    report = JSON.parse(fs.readFileSync(reportPath, 'utf8'))
  } catch (error) {
    process.stderr.write(
      `[E2E-GATE] The Playwright JSON report is unreadable: ${error instanceof Error ? error.message : String(error)}\n`
    )
    return 1
  }

  const verdict = evaluateGateReport(report)
  if (verdict.problems.length > 0) {
    process.stderr.write('[E2E-GATE] The EvenDrive drag-and-drop gate did NOT pass:\n')
    for (const problem of verdict.problems) process.stderr.write(`  - ${problem}\n`)
    return 1
  }

  process.stdout.write(
    `[E2E-GATE] PASS — ${verdict.stats.expected} journey(s) executed, 0 skipped, 0 failed.\n`
  )
  return run.status === 0 ? 0 : 1
}

const invokedDirectly =
  process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))

if (invokedDirectly) {
  main()
    .then(code => {
      process.exitCode = code
    })
    .catch(error => {
      process.stderr.write(`[E2E-GATE] ${error instanceof Error ? error.message : String(error)}\n`)
      process.exitCode = 1
    })
}
