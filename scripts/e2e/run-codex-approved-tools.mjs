import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import {
  APPROVED_TOOLS_ELECTRON_CHECK_TIMEOUT_MS,
  APPROVED_TOOLS_PLAYWRIGHT_SPAWN_GRACE_MS,
  APPROVED_TOOLS_PLAYWRIGHT_TIMEOUT_MS,
  APPROVED_TOOLS_RUNNER_KILL_GRACE_SECONDS,
  APPROVED_TOOLS_STATIC_AUDIT_TIMEOUT_MS,
  openOwnedFile,
  readOwnedDescriptor,
  validateRunDirectory,
} from './prepare-codex-approved-tools.mjs'

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const playwright = path.join(repo, 'tests/e2e/playwright')
const specFile = 'codex-subscription-approved-tools.spec.ts'
const modelStepSpecFile = 'model-step-retry-codex.spec.ts'
export const toolCallLimitTitle =
  'tool call limit: Desktop shows Too Many Tool Calls without retry or connector call'
export const toolCallLimitBoundaryTitle =
  'tool call limit boundary: Desktop completes a turn of exactly 256 tool calls'
// #1044: the model-step retry cases, run by their own Playwright project after
// the approved-tools spec, against the deterministic upstream only.
export const modelStepRetryTitles = [
  'model step retry C1: a 503 after a confirmed tool continues once without re-running the tool',
  'model step retry C2: a 503 before any tool offers only Resend, which answers the turn',
  'model step retry C3: a new message instead of the retry abandons the checkpoint',
  'model step retry C4: a double click on Retry model step runs one continuation',
  'model step retry C5: a continuation that meets a 503 again is offered for retry again',
  'model step retry C8: the checkpoint survives a Host restart between the 503 and the retry',
]
// What the six cases together must leave in the 83-tool scenario's upstream
// evidence (`codex-llm-proxy/test/approvedToolsUpstream.ts`, `modelStepRetry`):
// six turns, one search each except the zero-tool turn, seven 503s (one per
// turn plus the second one of C5), four answered continuations each carrying
// the one search result, one Resend, one follow-up, and no retry the Host must
// never make.
export const modelStepRetryExpectedDelta = Object.freeze({
  turns: 6,
  markerSearches: 5,
  unavailableResponses: 7,
  zeroToolUnavailable: 1,
  continuationUnavailable: 1,
  continuations: 4,
  toolResults: 4,
  resends: 1,
  followUps: 1,
  unexpectedRetries: 0,
})

// The tool-call limit cases exist only in deterministic mode: only the
// deterministic upstream can emit more function calls than the contract allows,
// or exactly that many. validateReport compares this registry against the report
// by count as well as by title, so a case the spec declares and this list omits
// fails the entire lane without ever naming it.
export function expectedTitles(mode) {
  if (!['deterministic', 'real'].includes(mode))
    throw new Error('Select deterministic or real upstream mode explicitly')
  return [
    'unauthenticated agent route guard prevents connector use',
    'authenticated user without agent access cannot select the protected agents',
    'native workflow: visible approval, trigger, status and result artifact',
    ...[83, 150, 250].map(
      size => `approved tools ${size}: ordinary discovery, reuse, approval decisions and revocation`
    ),
    ...(mode === 'deterministic' ? [toolCallLimitTitle, toolCallLimitBoundaryTitle] : []),
    ...(mode === 'deterministic' ? modelStepRetryTitles : []),
  ]
}

// The spec file that owns each registered title: a title found in another file
// is not the registered case.
export function specFileFor(title) {
  return modelStepRetryTitles.includes(title) ? modelStepSpecFile : specFile
}

/**
 * Compares the upstream model-step evidence read before and after Playwright
 * against the expected change of every counter. A counter missing from either
 * read fails, so an upstream that stopped reporting the block cannot pass.
 */
export function validateModelStepEvidence(before, after) {
  const delta = {}
  for (const [field, expected] of Object.entries(modelStepRetryExpectedDelta)) {
    const from = before?.modelStepRetry?.[field]
    const to = after?.modelStepRetry?.[field]
    if (!Number.isSafeInteger(from) || !Number.isSafeInteger(to) || from < 0 || to < from)
      throw new Error(`Model-step retry evidence missing or reset: ${field}`)
    delta[field] = to - from
    if (delta[field] !== expected)
      throw new Error(
        `Model-step retry evidence ${field} moved by ${delta[field]}, expected ${expected}`
      )
  }
  return delta
}

function modelStepEvidenceUrl() {
  const parsed = JSON.parse(required('APPROVED_TOOLS_SCENARIOS'))
  if (!Array.isArray(parsed)) throw new Error('APPROVED_TOOLS_SCENARIOS must be an array')
  const rows = parsed.filter(row => row?.catalogSize === 83)
  if (rows.length !== 1) throw new Error('Exactly one 83-tool approved-tools scenario required')
  const url = new URL('/approved-tools/evidence', rows[0].upstreamEvidenceUrl)
  if (!['localhost', '127.0.0.1', '[::1]'].includes(url.hostname) || !url.port)
    throw new Error('Upstream evidence must be a profile-owned loopback origin with port')
  return url
}

async function readModelStepEvidence(url) {
  const response = await fetch(url, { signal: AbortSignal.timeout(10_000) })
  if (!response.ok) throw new Error(`Upstream evidence returned ${response.status}`)
  return response.json()
}

export function runPhaseTimeouts() {
  return {
    playwright: APPROVED_TOOLS_PLAYWRIGHT_TIMEOUT_MS,
    electronCheck: APPROVED_TOOLS_ELECTRON_CHECK_TIMEOUT_MS,
    staticAudit: APPROVED_TOOLS_STATIC_AUDIT_TIMEOUT_MS,
    playwrightSpawnGrace: APPROVED_TOOLS_PLAYWRIGHT_SPAWN_GRACE_MS,
  }
}

export function validateReport(report, mode) {
  const titles = expectedTitles(mode)
  const specs = []
  function collect(suites) {
    if (!Array.isArray(suites)) throw new Error('Incomplete Playwright suites')
    for (const suite of suites) {
      specs.push(...(suite.specs ?? []))
      collect(suite.suites ?? [])
    }
  }
  collect(report.suites)
  if (
    report.errors?.length ||
    report.stats?.unexpected !== 0 ||
    report.stats?.skipped !== 0 ||
    report.stats?.flaky !== 0 ||
    report.stats?.expected !== titles.length ||
    specs.length !== titles.length
  ) {
    throw new Error('Incomplete, failed, flaky or skipped approved-tools report')
  }
  for (const title of titles) {
    const file = specFileFor(title)
    const matches = specs.filter(
      spec =>
        spec.title === title &&
        [file, `desktop/${file}`, path.join(playwright, 'desktop', file)].includes(spec.file)
    )
    if (matches.length !== 1) throw new Error(`Required case missing or duplicated: ${title}`)
    const spec = matches[0]
    if (!spec.ok || spec.tests?.length !== 1) throw new Error(`Case not green: ${title}`)
    const test = spec.tests[0]
    if (
      test.expectedStatus !== 'passed' ||
      test.status !== 'expected' ||
      test.results?.length !== 1 ||
      test.results[0].status !== 'passed' ||
      test.results[0].errors?.length
    ) {
      throw new Error(`Case did not pass once without retries: ${title}`)
    }
  }
  return { tests: specs.length, skipped: 0, failed: 0 }
}

function required(name) {
  const value = process.env[name]?.trim()
  if (!value) throw new Error(`Missing required precondition: ${name}`)
  return value
}

function runNode(args, cwd, env, timeout) {
  if (
    !Number.isSafeInteger(timeout) ||
    timeout < 1000 ||
    timeout > APPROVED_TOOLS_PLAYWRIGHT_TIMEOUT_MS
  )
    throw new Error('Invalid browser deadline')
  const result = spawnSync(
    process.execPath,
    [
      path.join(repo, 'scripts/minikube/run-with-deadline.mjs'),
      '--timeout-seconds',
      String(Math.ceil(timeout / 1000)),
      '--kill-grace-seconds',
      String(APPROVED_TOOLS_RUNNER_KILL_GRACE_SECONDS),
      '--label',
      'approved-tools-playwright',
      '--',
      process.execPath,
      ...args,
    ],
    {
      cwd,
      env,
      stdio: 'inherit',
      timeout: timeout + APPROVED_TOOLS_PLAYWRIGHT_SPAWN_GRACE_MS,
      killSignal: 'SIGTERM',
    }
  )
  if (result.error || result.signal || result.status !== 0)
    throw new Error('Approved-tools process failed, timed out or was interrupted')
}

async function main() {
  if (process.versions.node.split('.')[0] !== '24')
    throw new Error('Desktop certification requires Node 24')
  for (const key of [
    'MINIKUBE_PROFILE',
    'CONTROL_API_REAL_PG_CONTEXT',
    'CONTROL_UI_URL',
    'EXTERNAL_REST_API_BASE_URL',
    'RPC_PROXY_BASE_URL',
    'APPROVED_TOOLS_SCENARIOS',
    'APPROVED_TOOLS_WORKFLOW_SCENARIO',
    'APPROVED_TOOLS_UNAUTHORIZED_EMAIL',
    'APPROVED_TOOLS_UNAUTHORIZED_PASSWORD',
  ])
    required(key)
  const mode = required('APPROVED_TOOLS_UPSTREAM_MODE')
  if (!['deterministic', 'real'].includes(mode))
    throw new Error('Select deterministic or real upstream mode explicitly')
  if (mode === 'real' && process.env.CODEX_REAL_UPSTREAM_CONFIRM !== '1')
    throw new Error('Real subscription use requires explicit confirmation')
  const evidence = validateRunDirectory(
    required('APPROVED_TOOLS_CANONICAL_ROOT'),
    required('APPROVED_TOOLS_EVIDENCE_DIR')
  )
  const report = path.join(evidence, `approved-tools-${mode}.json`)
  const artifacts = path.join(evidence, `artifacts-${mode}`)
  process.umask(0o077)
  // Playwright's JSON reporter writes this reserved inode with writeFile. Keep
  // the descriptor until verification; a replacement path cannot supply proof.
  const reportFile = openOwnedFile(evidence, path.basename(report), {
    create: true,
    maxBytes: 16 * 1024 * 1024,
  })
  try {
    fs.mkdirSync(artifacts, { mode: 0o700 })
    const env = {
      ...process.env,
      PATH: `${path.dirname(process.execPath)}${path.delimiter}${process.env.PATH ?? ''}`,
      PLAYWRIGHT_DESKTOP_BUILT: 'true',
      APPROVED_TOOLS_REPORT: report,
      APPROVED_TOOLS_ARTIFACTS: artifacts,
    }
    // Run the repository invariant; a dependency install exit code is insufficient.
    const electronCheck = spawnSync('npm', ['run', 'verify:electron'], {
      cwd: path.join(repo, 'desktop-app'),
      env,
      stdio: 'inherit',
      timeout: APPROVED_TOOLS_ELECTRON_CHECK_TIMEOUT_MS,
    })
    if (electronCheck.error || electronCheck.signal || electronCheck.status !== 0)
      throw new Error('Desktop Electron verification failed')
    if (!fs.statSync(path.join(repo, 'desktop-app/dist/main.js')).isFile())
      throw new Error('Desktop build missing')
    const audit = spawnSync(
      'python3',
      [
        'tools/e2e_static_audit.py',
        `tests/e2e/playwright/desktop/${specFile}`,
        `tests/e2e/playwright/desktop/${modelStepSpecFile}`,
        'tests/e2e/playwright/helpers/approved-tools-chat.ts',
        'tests/e2e/playwright/helpers/approved-tools-scenarios.ts',
        'tests/e2e/playwright/helpers/approved-tools-workflow.ts',
        'tests/e2e/playwright/helpers/approved-tools-subscription.ts',
      ],
      { cwd: repo, env, stdio: 'inherit', timeout: APPROVED_TOOLS_STATIC_AUDIT_TIMEOUT_MS }
    )
    if (audit.error || audit.signal || audit.status !== 0)
      throw new Error('E2E Guardian audit failed')
    const evidenceUrl = mode === 'deterministic' ? modelStepEvidenceUrl() : undefined
    const evidenceBefore = evidenceUrl ? await readModelStepEvidence(evidenceUrl) : undefined
    runNode(
      [
        path.join(playwright, 'node_modules/@playwright/test/cli.js'),
        'test',
        '--config=playwright.codex-approved-tools.config.ts',
      ],
      playwright,
      env,
      APPROVED_TOOLS_PLAYWRIGHT_TIMEOUT_MS
    )
    const verified = validateReport(JSON.parse(readOwnedDescriptor(reportFile)), mode)
    const modelStepRetry = evidenceUrl
      ? validateModelStepEvidence(evidenceBefore, await readModelStepEvidence(evidenceUrl))
      : undefined
    process.stdout.write(
      `${JSON.stringify({ lane: 'Playwright', upstream: mode, ...verified, modelStepRetry, report })}\n`
    )
  } finally {
    fs.closeSync(reportFile.fd)
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(error => {
    process.stderr.write(`${error.message}\n`)
    process.exitCode = 1
  })
}
