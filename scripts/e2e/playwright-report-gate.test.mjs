import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import { playwrightStatsPass } from './playwright-report-gate.mjs'

const REPO_ROOT = fileURLToPath(new URL('../..', import.meta.url))
const GATE = fileURLToPath(new URL('./playwright-report-gate.mjs', import.meta.url))
const GREEN = { expected: 2, unexpected: 0, skipped: 0, flaky: 0 }

test('passes only a report that executed tests with no unexpected, skipped or flaky one', () => {
  assert.equal(playwrightStatsPass(GREEN), true)
  assert.equal(playwrightStatsPass({ ...GREEN, expected: 0 }), false)
  assert.equal(playwrightStatsPass({ ...GREEN, unexpected: 1 }), false)
  assert.equal(playwrightStatsPass({ ...GREEN, skipped: 1 }), false)
  assert.equal(playwrightStatsPass({ ...GREEN, flaky: 1 }), false)
  assert.throws(() => playwrightStatsPass({ expected: 1 }), /stats\.unexpected is not an integer/)
  assert.throws(() => playwrightStatsPass(undefined), /stats\.expected is not an integer/)
})

test('the CLI prints the labelled counters and exits by the verdict', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'playwright-report-gate-'))
  try {
    const run = stats => {
      const report = path.join(dir, 'report.json')
      writeFileSync(report, JSON.stringify({ stats }))
      return spawnSync(process.execPath, [GATE, 'LANE_STATS', report], { encoding: 'utf8' })
    }
    const green = run(GREEN)
    assert.equal(green.status, 0, green.stderr)
    assert.equal(green.stdout.trim(), 'LANE_STATS expected=2 unexpected=0 skipped=0 flaky=0')

    const skippedOnly = run({ expected: 0, unexpected: 0, skipped: 3, flaky: 0 })
    assert.equal(skippedOnly.status, 1)
    assert.match(skippedOnly.stdout, /LANE_STATS expected=0 unexpected=0 skipped=3 flaky=0/)

    const missing = spawnSync(process.execPath, [GATE, 'LANE_STATS', path.join(dir, 'absent.json')], {
      encoding: 'utf8',
    })
    assert.notEqual(missing.status, 0)
    assert.match(missing.stderr, /ENOENT/)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

function runDesktopTarget(context, extraEnv = {}) {
  const env = {
    PATH: process.env.PATH,
    HOME: process.env.HOME,
    KUBECONTEXT: context,
    E2E_DEV_LOGIN_EMAIL: 'admin@evenfire.local',
    CONTROL_API_BASE_URL: 'http://127.0.0.1:1',
    EXTERNAL_REST_API_BASE_URL: 'http://127.0.0.1:2',
    RPC_PROXY_BASE_URL: 'http://127.0.0.1:3',
    ...extraEnv,
  }
  return spawnSync('make', ['--no-print-directory', '-C', REPO_ROOT, 'test-e2e-825-desktop-continuity'], {
    encoding: 'utf8',
    env,
    timeout: 60_000,
  })
}

test('make test-e2e-hcc-storage-layout-switch keeps the caller KUBECONTEXT', () => {
  const env = {
    PATH: process.env.PATH,
    HOME: process.env.HOME,
    KUBECONTEXT: 'clerum-fix-issue-825-gate-test-0123abcd',
    E2E_PROFILE_PORTS_ENV: path.join(tmpdir(), 'playwright-report-gate-no-such-ports.env'),
  }
  const run = spawnSync(
    'make',
    ['--no-print-directory', '-C', REPO_ROOT, 'test-e2e-hcc-storage-layout-switch'],
    { encoding: 'utf8', env, timeout: 60_000 }
  )
  assert.notEqual(run.status, 0)
  // The caller's branch context passes the context check (the Makefile
  // default MINIKUBE_PROFILE would not) and the run stops at the ports.env
  // check, before any cluster call.
  const out = `${run.stdout}${run.stderr}`
  assert.doesNotMatch(out, /select an explicit branch-scoped Minikube context/)
  assert.match(out, /provide E2E_PROFILE_PORTS_ENV from the owned branch profile/)
})

test('make test-e2e-825-desktop-continuity refuses a context that is not a branch profile', () => {
  const shared = runDesktopTarget('minikube')
  assert.notEqual(shared.status, 0)
  assert.match(
    shared.stderr,
    /Refusing #825 Desktop E2E: context 'minikube' is not a branch-scoped Minikube profile/
  )
  assert.doesNotMatch(`${shared.stdout}${shared.stderr}`, /verify:electron/)

  // Witness: a branch-scoped context passes the context check and reaches the
  // ports.env check, which still refuses before any Desktop build.
  const branch = runDesktopTarget('clerum-fix-issue-825-gate-test-0123abcd', {
    E2E_PROFILE_PORTS_ENV: path.join(tmpdir(), 'playwright-report-gate-no-such-ports.env'),
  })
  assert.notEqual(branch.status, 0)
  assert.doesNotMatch(branch.stderr, /is not a branch-scoped Minikube profile/)
  assert.match(branch.stderr, /profile ports\.env is missing/)
  assert.doesNotMatch(`${branch.stdout}${branch.stderr}`, /verify:electron/)
})
