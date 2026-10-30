#!/usr/bin/env node
// desktop-app/test/e2e-playwright/run-gfs-drag-and-drop.mjs
//
// Frontend-owned E2E gate for the EvenDrive drag-and-drop journeys.
//
// WHY THIS EXISTS. The Desktop drag-and-drop spec used to assert an
// `aria-current="page"` attribute the Files surface never renders, so BOTH
// journeys failed before they reached a gesture. A suite that cannot run is
// indistinguishable from a suite that passed when the only signal is the
// exit code of a broad `playwright test` invocation. This gate is the
// explicit, repeatable entry point for the lane:
//
//   1. Requesting the gate WITHOUT the required setup FAILS LOUD (exit 1)
//      with an actionable message — it never degrades into "skip".
//   2. The gate NEVER reports success for zero executed journeys, and never
//      reports success while a journey was skipped.
//   3. The live-fixture opt-in stays EXPLICIT. Nothing in `npm test` calls
//      this file; the journeys mutate a shared dev environment, so only this
//      named command runs them.
//
// Usage (from desktop-app/):
//   E2E_K8S_CONTEXT=dev \
//   E2E_ALLOWED_CONTEXTS=dev \
//   E2E_DEV_LOGIN_EMAIL=<user> E2E_DESKTOP_PASSWORD=<password> \
//   EXTERNAL_REST_API_BASE_URL=http://127.0.0.1:<port> \
//   RPC_PROXY_BASE_URL=http://127.0.0.1:<port> \
//     npm run test:e2e:playwright:gfs-drag-and-drop
//
// Exit codes: 0 = every requested journey ran and passed. 1 = the gate
// refused to run, or the journey result was not a clean pass.
import { execFileSync, spawnSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const APP_ROOT = path.resolve(HERE, '..', '..')
const REPO_ROOT = path.resolve(APP_ROOT, '..')

export const DESKTOP_PASSWORD_KEYS = [
  'E2E_DESKTOP_PASSWORD',
  'E2E_TEST_PASSWORD',
  'ADMIN_PASSWORD',
  'TEST_ADMIN_PASSWORD',
]
export const DESKTOP_EMAIL_KEYS = [
  'E2E_DEV_LOGIN_EMAIL',
  'TEST_USER_EMAIL',
  'CLERUM_TEST_USER_EMAIL',
]

const PROBE_TIMEOUT_MS = 10_000
const PLAYWRIGHT_ARGS = [
  'test',
  '--config=test/e2e-playwright/playwright.config.ts',
  'gfs-drag-and-drop-desktop.test.ts',
  '--project=default',
  '--workers=1',
]

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
 * The setup the Desktop lane needs. Returns the problems instead of
 * throwing so the caller can print all of them at once.
 */
export function collectGateProblems(env) {
  const problems = []

  const context = (env.E2E_K8S_CONTEXT || env.KUBECONTEXT || env.K8S_CONTEXT || '').trim()
  if (!context) {
    problems.push(
      'No Kubernetes context configured. Set E2E_K8S_CONTEXT (or KUBECONTEXT / K8S_CONTEXT) to the ' +
        'owned dev context the journeys read their fixtures from.'
    )
  } else if (/(^|[-_])(prod|production)([-_]|$)/i.test(context)) {
    problems.push(
      `Refusing a production context ("${context}"). E2E against prod is never allowed.`
    )
  } else {
    const allowed = (env.E2E_ALLOWED_CONTEXTS || '')
      .split(',')
      .map(value => value.trim())
      .filter(Boolean)
    if (allowed.length > 0 && !allowed.includes(context)) {
      problems.push(
        `E2E_K8S_CONTEXT="${context}" is not in E2E_ALLOWED_CONTEXTS (${allowed.join(', ')}).`
      )
    }
  }

  if (!firstConfiguredValue(env, DESKTOP_PASSWORD_KEYS)) {
    problems.push(
      `No Desktop password configured. Set one of: ${DESKTOP_PASSWORD_KEYS.join(', ')}.`
    )
  }

  const endpoints = [
    ['EXTERNAL_REST_API_BASE_URL', env.EXTERNAL_REST_API_BASE_URL || 'http://127.0.0.1:8091'],
    ['RPC_PROXY_BASE_URL', env.RPC_PROXY_BASE_URL || 'http://127.0.0.1:8094'],
  ]
  for (const [label, rawUrl] of endpoints) {
    let parsed
    try {
      parsed = new URL(rawUrl)
    } catch {
      problems.push(`${label} must be an absolute URL; received "${rawUrl}".`)
      continue
    }
    if (!isLoopbackHostname(parsed.hostname) && env.E2E_ALLOW_REMOTE !== '1') {
      problems.push(
        `${label} targets non-local host "${parsed.hostname}". Set E2E_ALLOW_REMOTE=1 only when ` +
          'that environment is intentionally disposable.'
      )
    }
  }

  const buildOutputs = ['dist/main.js', 'dist/preload.js', 'ui-dist/index.html']
  const missing = buildOutputs.filter(output => !fs.existsSync(path.join(APP_ROOT, output)))
  if (missing.length > 0) {
    problems.push(
      `The Desktop build output is missing (${missing.join(', ')}). Run "npm run build" in desktop-app first.`
    )
  }

  return problems
}

/**
 * The counters a Playwright JSON report must carry. A report without them is
 * INCOMPLETE: a missing counter is not "zero journeys", it is unknown, and
 * an unknown count can never certify a run.
 */
export const REQUIRED_REPORT_COUNTERS = ['expected', 'skipped', 'unexpected', 'flaky']

/**
 * Every journey a Playwright JSON report lists, with the outcome Playwright
 * recorded for it.
 *
 * The inventory is what makes a report verifiable: the counters are only a
 * summary of it, and a summary that does not match the detail it summarises
 * is not evidence. A journey with no recorded outcome is an incomplete
 * report.
 */
export function collectReportJourneys(report) {
  const journeys = []
  const walk = (suite, path) => {
    const title = typeof suite?.title === 'string' ? suite.title : ''
    const file = typeof suite?.file === 'string' ? suite.file : ''
    // The file-level suite repeats the file name; it is not part of a test's
    // title path.
    const nextPath = title && title !== file ? [...path, title] : path
    for (const spec of suite?.specs ?? []) {
      for (const test of spec?.tests ?? []) {
        const specTitle = String(spec?.title ?? '')
        journeys.push({
          identity: `${String(spec?.file ?? '')}::${[...nextPath, specTitle].join(' › ')}`,
          title: specTitle,
          file: String(spec?.file ?? ''),
          outcome: typeof test?.status === 'string' ? test.status : null,
          results: Array.isArray(test?.results) ? test.results.length : 0,
        })
      }
    }
    for (const child of suite?.suites ?? []) walk(child, nextPath)
  }
  for (const suite of report?.suites ?? []) walk(suite, [])
  return journeys
}

/**
 * The outcome tally of a report's inventory, computed the way Playwright
 * computes it (a journey with no result counts as skipped). A journey with an
 * outcome Playwright does not report is INCOMPLETE.
 */
export function tallyReportJourneys(journeys) {
  const tally = { expected: 0, skipped: 0, unexpected: 0, flaky: 0, incomplete: 0 }
  for (const journey of journeys) {
    const outcome = journey.results === 0 ? 'skipped' : journey.outcome
    if (
      outcome === 'expected' ||
      outcome === 'skipped' ||
      outcome === 'unexpected' ||
      outcome === 'flaky'
    ) {
      tally[outcome] += 1
      continue
    }
    tally.incomplete += 1
  }
  return tally
}

/**
 * The verdict of a Playwright JSON report. A run is a clean pass only when
 * the report is COMPLETE, at least one journey actually executed, nothing
 * was skipped, and nothing failed.
 *
 * `selectedJourneys` is the inventory Playwright selected before the run (the
 * `--list` pass). When it is supplied, the report must describe exactly that
 * set: a report that lists fewer journeys than were selected is not evidence
 * for the run.
 */
export function evaluateGateReport(report, run = { status: 0 }, selectedJourneys = null) {
  const problems = []
  if (run.error || run.signal || run.status !== 0) {
    problems.push('Playwright did not exit successfully. The report cannot certify this run.')
  }
  if (Array.isArray(report?.errors) && report.errors.length > 0) {
    problems.push('Playwright reported a run-level error. The report cannot certify this run.')
  }
  const stats = report && typeof report === 'object' ? (report.stats ?? {}) : {}
  const counters = {}
  for (const key of REQUIRED_REPORT_COUNTERS) {
    const value = stats[key]
    if (!Number.isInteger(value) || value < 0) {
      problems.push(
        `The journey report has invalid result counts: "${key}" is missing or not a non-negative integer. ` +
          'An incomplete report cannot certify this run.'
      )
      counters[key] = null
      continue
    }
    counters[key] = value
  }
  const expected = counters.expected ?? 0
  const skipped = counters.skipped ?? 0
  const unexpected = counters.unexpected ?? 0
  const flaky = counters.flaky ?? 0

  const journeys = collectReportJourneys(report)
  const tally = tallyReportJourneys(journeys)
  if (journeys.length === 0) {
    problems.push(
      'The journey report lists no journeys. A report without its inventory cannot certify this run.'
    )
  }
  if (tally.incomplete > 0) {
    problems.push(
      `${tally.incomplete} journey(s) in the report carry no outcome. The report is incomplete.`
    )
  }
  const mismatched = REQUIRED_REPORT_COUNTERS.filter(
    key => counters[key] !== null && counters[key] !== tally[key]
  )
  if (mismatched.length > 0) {
    problems.push(
      `The journey report does not reconcile with its own inventory: ${mismatched.join(', ')} ` +
        `(report ${expected}/${skipped}/${unexpected}/${flaky}, ` +
        `inventory ${tally.expected}/${tally.skipped}/${tally.unexpected}/${tally.flaky}).`
    )
  }
  if (selectedJourneys) {
    const selected = new Set(selectedJourneys.map(journey => journey.identity))
    const reported = new Set(journeys.map(journey => journey.identity))
    const missing = [...selected].filter(identity => !reported.has(identity))
    const extra = [...reported].filter(identity => !selected.has(identity))
    if (missing.length > 0) {
      problems.push(
        `The journey report is missing ${missing.length} selected journey(s): ${missing.join(', ')}`
      )
    }
    if (extra.length > 0) {
      problems.push(
        `The journey report contains ${extra.length} journey(s) that were not selected: ${extra.join(', ')}`
      )
    }
  }

  if (expected <= 0) {
    problems.push(
      'The journey suite executed zero journeys. A skipped suite is not a green result: ' +
        'check the Kubernetes context, the Desktop credential and the endpoint configuration.'
    )
  }
  if (skipped > 0) {
    problems.push(`${skipped} journey(s) were skipped. A skipped journey is not a green result.`)
  }
  if (unexpected > 0) {
    problems.push(`${unexpected} journey(s) failed.`)
  }
  if (flaky > 0) {
    problems.push(`${flaky} journey(s) were flaky. The run was not a clean pass.`)
  }

  return { problems, stats: { expected, skipped, unexpected, flaky } }
}

/**
 * The SANITIZED evidence file for this run: the tested revision, the
 * selected journeys, their outcomes and the process exit.
 *
 * The raw Playwright report carries error text, stdout and attachments, so
 * it stays private under the ignored artifact directory. This file is the
 * part a reviewer can read: no credentials, no cookies, no auth headers, no
 * request or response bodies — only what certifies WHICH journeys ran, on
 * WHICH revision, with WHICH exit code.
 */
export function writeSanitizedRunSummary({
  lane,
  revision,
  branch,
  command,
  report,
  run,
  selectedJourneys,
  verdict,
  filePath,
}) {
  const journeys = collectReportJourneys(report).map(journey => ({
    title: journey.title,
    status: journey.outcome ?? 'incomplete',
  }))
  const summary = {
    lane,
    revision,
    branch,
    command,
    processExit: typeof run?.status === 'number' ? run.status : null,
    signal: run?.signal ?? null,
    verdict,
    counts: {
      expected: Number(report?.stats?.expected ?? 0),
      skipped: Number(report?.stats?.skipped ?? 0),
      unexpected: Number(report?.stats?.unexpected ?? 0),
      flaky: Number(report?.stats?.flaky ?? 0),
    },
    selected: (selectedJourneys ?? []).map(journey => journey.title),
    journeys,
  }
  fs.writeFileSync(filePath, `${JSON.stringify(summary, null, 2)}\n`)
  return summary
}

/**
 * Remove every artifact a PREVIOUS attempt left behind, before this attempt
 * can fail ahead of writing its own.
 *
 * The raw report and selection were already cleared at run start; the
 * SANITIZED SUMMARY was not. A previous PASS summary that survives a launch
 * which then fails early — refused setup, unreachable endpoint, missing or
 * unreadable report — reads as evidence for a run that never happened.
 */
export function invalidatePreviousAttemptArtifacts(dir) {
  fs.rmSync(path.join(dir, 'playwright-summary.json'), { force: true })
  fs.rmSync(path.join(dir, 'playwright-report.json'), { force: true })
  fs.rmSync(path.join(dir, 'playwright-selection.json'), { force: true })
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

/** The revision the lane ran against (never a branch guess). */
export function readTestedRevision(repoRoot) {
  try {
    return execFileSync('git', ['-C', repoRoot, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim()
  } catch {
    return 'unknown'
  }
}

/** The branch the lane ran on. */
export function readTestedBranch(repoRoot) {
  try {
    return execFileSync('git', ['-C', repoRoot, 'rev-parse', '--abbrev-ref', 'HEAD'], {
      encoding: 'utf8',
    }).trim()
  } catch {
    return 'unknown'
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
      `Playwright is not installed at ${bin}. Run "npm ci" in desktop-app before the E2E gate.`
    )
  }
  return bin
}

function artifactDir() {
  const dir = path.join(REPO_ROOT, '.local-notes', 'infra', 'runs', 'desktop-gfs-drag-and-drop')
  fs.mkdirSync(dir, { recursive: true })
  return dir
}

async function main() {
  const env = process.env
  // A previous attempt's artifacts must not outlive the start of this one,
  // whichever way it ends: an old PASS summary left behind by an early
  // failure would read as evidence for a run that never happened.
  invalidatePreviousAttemptArtifacts(artifactDir())
  const problems = collectGateProblems(env)
  if (problems.length > 0) {
    process.stderr.write('[E2E-GATE] The EvenDrive drag-and-drop gate cannot run:\n')
    for (const problem of problems) process.stderr.write(`  - ${problem}\n`)
    process.stderr.write('[E2E-GATE] Nothing was executed. This is a FAILURE, not a skip.\n')
    return 1
  }

  const externalRest = env.EXTERNAL_REST_API_BASE_URL || 'http://127.0.0.1:8091'
  const rpcProxy = env.RPC_PROXY_BASE_URL || 'http://127.0.0.1:8094'
  for (const [label, baseUrl] of [
    ['EXTERNAL_REST_API_BASE_URL', externalRest],
    ['RPC_PROXY_BASE_URL', rpcProxy],
  ]) {
    const probe = await probeReachable(`${baseUrl.replace(/\/$/, '')}/health`)
    if (!probe.ok) {
      process.stderr.write(
        `[E2E-GATE] ${label} is not reachable at ${baseUrl}/health` +
          `${probe.error ? ` (${probe.error})` : ` (HTTP ${probe.status})`}. Nothing was executed.\n`
      )
      return 1
    }
  }

  const dir = artifactDir()
  const reportPath = path.join(dir, 'playwright-report.json')
  const selectionPath = path.join(dir, 'playwright-selection.json')
  const playwrightBin = resolvePlaywrightBin()

  // Enumerate the journeys Playwright SELECTS before running them. The run's
  // report is reconciled against this inventory, so a report that describes
  // fewer journeys than were selected cannot certify the run.
  process.stdout.write('[E2E-GATE] enumerating the selected journeys\n')
  const selection = spawnSync(playwrightBin, [...PLAYWRIGHT_ARGS, '--list', '--reporter=json'], {
    cwd: APP_ROOT,
    stdio: 'inherit',
    timeout: 10 * 60_000,
    env: { ...env, PLAYWRIGHT_JSON_OUTPUT_NAME: selectionPath },
  })
  if (selection.status !== 0 || !fs.existsSync(selectionPath)) {
    process.stderr.write(
      '[E2E-GATE] Playwright could not enumerate the selected journeys. ' +
        'The gate cannot certify this run.\n'
    )
    return 1
  }
  let selectedJourneys
  try {
    selectedJourneys = collectReportJourneys(JSON.parse(fs.readFileSync(selectionPath, 'utf8')))
  } catch (error) {
    process.stderr.write(
      `[E2E-GATE] The Playwright selection report is unreadable: ${error instanceof Error ? error.message : String(error)}\n`
    )
    return 1
  }
  if (selectedJourneys.length === 0) {
    process.stderr.write(
      '[E2E-GATE] Playwright selected no journeys. The gate cannot certify this run.\n'
    )
    return 1
  }
  process.stdout.write(
    `[E2E-GATE] ${selectedJourneys.length} journey(s) selected: ${selectedJourneys
      .map(journey => journey.title)
      .join(' | ')}\n`
  )

  process.stdout.write(
    `[E2E-GATE] running the EvenDrive drag-and-drop journeys (report: ${reportPath})\n`
  )
  const run = spawnSync(playwrightBin, [...PLAYWRIGHT_ARGS, '--reporter=list,json'], {
    cwd: APP_ROOT,
    stdio: 'inherit',
    timeout: 75 * 60_000,
    env: { ...env, PLAYWRIGHT_JSON_OUTPUT_NAME: reportPath },
  })

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

  const verdict = evaluateGateReport(report, run, selectedJourneys)
  const summaryPath = path.join(dir, 'playwright-summary.json')
  writeSanitizedRunSummary({
    lane: 'desktop-app',
    revision: readTestedRevision(REPO_ROOT),
    branch: readTestedBranch(REPO_ROOT),
    command: 'npm run test:e2e:playwright:gfs-drag-and-drop',
    report,
    run,
    selectedJourneys,
    verdict: verdict.problems.length > 0 ? 'fail' : 'pass',
    filePath: summaryPath,
  })
  process.stdout.write(`[E2E-GATE] sanitized summary: ${summaryPath}\n`)
  if (verdict.problems.length > 0) {
    process.stderr.write('[E2E-GATE] The EvenDrive drag-and-drop gate did NOT pass:\n')
    for (const problem of verdict.problems) process.stderr.write(`  - ${problem}\n`)
    return 1
  }

  process.stdout.write(
    `[E2E-GATE] PASS — ${verdict.stats.expected} journey(s) executed, 0 skipped, 0 failed.\n`
  )
  return 0
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
