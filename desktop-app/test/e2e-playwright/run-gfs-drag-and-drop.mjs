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
import { spawnSync } from 'node:child_process'
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
        'check the Kubernetes context, the Desktop credential and the endpoint configuration.'
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
  const playwrightBin = resolvePlaywrightBin()

  process.stdout.write(
    `[E2E-GATE] running the EvenDrive drag-and-drop journeys (report: ${reportPath})\n`
  )
  const run = spawnSync(
    playwrightBin,
    [
      'test',
      '--config=test/e2e-playwright/playwright.config.ts',
      'gfs-drag-and-drop-desktop.test.ts',
      '--project=default',
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
