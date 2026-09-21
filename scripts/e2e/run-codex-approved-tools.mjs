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
export const toolCallLimitTitle =
  'tool call limit: Desktop shows Too Many Tool Calls without retry or connector call'
export const toolCallLimitBoundaryTitle =
  'tool call limit boundary: Desktop completes a turn of exactly 256 tool calls'

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
  ]
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
    const matches = specs.filter(
      spec =>
        spec.title === title &&
        [specFile, `desktop/${specFile}`, path.join(playwright, 'desktop', specFile)].includes(
          spec.file
        )
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

function main() {
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
        'tests/e2e/playwright/helpers/approved-tools-scenarios.ts',
        'tests/e2e/playwright/helpers/approved-tools-workflow.ts',
        'tests/e2e/playwright/helpers/approved-tools-subscription.ts',
      ],
      { cwd: repo, env, stdio: 'inherit', timeout: APPROVED_TOOLS_STATIC_AUDIT_TIMEOUT_MS }
    )
    if (audit.error || audit.signal || audit.status !== 0)
      throw new Error('E2E Guardian audit failed')
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
    process.stdout.write(
      `${JSON.stringify({ lane: 'Playwright', upstream: mode, ...verified, report })}\n`
    )
  } finally {
    fs.closeSync(reportFile.fd)
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    main()
  } catch (error) {
    process.stderr.write(`${error.message}\n`)
    process.exitCode = 1
  }
}
