import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import {
  ADMISSION_PACE_MS,
  LOGIN_LEDGER_FILE,
  PACE_MARGIN_MS,
  SOURCE_ATTEMPTS_PER_MINUTE,
  SOURCE_WINDOW_MS,
  loginLedgerPath,
  loginLedgerRootFromEnv,
  readLoginLedger,
  recordPasswordLogin,
  waitForLoginPace,
  waitMsForLoginPace,
} from './login-ledger.mjs'

// #1048 MS-B1: the lane's password logins must not land inside control-api's
// password admission policy (`control-api/src/services/auth/passwordAdmissionState.ts`):
// one verification per `paceMs` across every identity, and
// `sourceAttemptsPerMinute` attempts per source per minute. The ledger is the
// lane's own record of when it logged in, kept on disk because a Playwright
// worker restart loses module state.

const NOW = 1_800_000_000_000

function entry(at) {
  return { at, surface: 'desktop', inputChecks: 2 }
}

function directory() {
  return fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'login-ledger-')))
}

test('the policy numbers are the ones the parity test pins to control-api', () => {
  // `scripts/e2e/model-step-retry-constants-parity.test.mjs` compares these two
  // with the values it extracts from `PASSWORD_ADMISSION_POLICY`.
  assert.equal(ADMISSION_PACE_MS, 7_500)
  assert.equal(SOURCE_ATTEMPTS_PER_MINUTE, 5)
  // MS-B1: the wait is `paceMs + 1 s`, and one attempt is held back from the
  // per-source window so the next login stays inside `sourceAttemptsPerMinute`.
  assert.equal(PACE_MARGIN_MS, 1_000)
  assert.equal(SOURCE_WINDOW_MS, 60_000)
})

test('the wait is the pace since the last login, as MS-B1 states', () => {
  // Ledger entries at t-3 s and t-50 s: the global pace still has 5.5 s to run.
  const wait = waitMsForLoginPace([entry(NOW - 3_000), entry(NOW - 50_000)], NOW)
  assert.equal(wait, ADMISSION_PACE_MS + PACE_MARGIN_MS - 3_000)
  assert.ok(wait >= 5_500, `expected at least 5500 ms, got ${wait}`)
})

test('a fourth login in the window waits for the oldest entry to age out', () => {
  const four = [entry(NOW - 10_000), entry(NOW - 20_000), entry(NOW - 30_000), entry(NOW - 40_000)]
  // Three may stay in the window; the fourth-newest entry must leave it.
  assert.equal(waitMsForLoginPace(four, NOW), SOURCE_WINDOW_MS - 40_000)
  // A fifth entry changes nothing: the fourth-newest still owns the wait.
  const five = [...four, entry(NOW - 55_000)]
  assert.equal(waitMsForLoginPace(five, NOW), SOURCE_WINDOW_MS - 40_000)
})

test('nothing to wait for on an empty or fully aged ledger', () => {
  assert.equal(waitMsForLoginPace([], NOW), 0)
  const aged = [
    entry(NOW - 70_000),
    entry(NOW - 90_000),
    entry(NOW - 120_000),
    entry(NOW - 130_000),
  ]
  assert.equal(waitMsForLoginPace(aged, NOW), 0)
})

test('the ledger is one JSON line per password login, created 0600', () => {
  const root = directory()
  const desktop = recordPasswordLogin(root, { surface: 'desktop', inputChecks: 2, at: NOW })
  recordPasswordLogin(root, { surface: 'control-ui', inputChecks: 0, at: NOW + 20_000 })
  const file = loginLedgerPath(root)
  assert.equal(path.basename(file), LOGIN_LEDGER_FILE)
  assert.equal(fs.statSync(file).mode & 0o777, 0o600)
  const lines = fs.readFileSync(file, 'utf8').trimEnd().split('\n')
  assert.equal(lines.length, 2)
  assert.deepEqual(JSON.parse(lines[0]), desktop)
  assert.deepEqual(readLoginLedger(root), [
    { at: NOW, surface: 'desktop', inputChecks: 2 },
    { at: NOW + 20_000, surface: 'control-ui', inputChecks: 0 },
  ])
})

test('a lane without a run directory records and waits for nothing', () => {
  // The ledger belongs to the approved-tools lane: its runner sets
  // `APPROVED_TOOLS_EVIDENCE_DIR`. Other projects (`control-ui/*`) share
  // `loginControlUiVisible` and have no lane run directory, so the helpers stay
  // inert there instead of failing their runs.
  assert.equal(loginLedgerRootFromEnv({}), null)
  assert.equal(loginLedgerRootFromEnv({ APPROVED_TOOLS_EVIDENCE_DIR: '' }), null)
  assert.equal(loginLedgerRootFromEnv({ APPROVED_TOOLS_EVIDENCE_DIR: '/run/dir' }), '/run/dir')
  assert.equal(recordPasswordLogin(null, { surface: 'desktop', inputChecks: 2 }), null)
  assert.deepEqual(readLoginLedger(null), [])
})

test('a malformed ledger line fails loud instead of silently unpacing the lane', () => {
  const root = directory()
  fs.writeFileSync(loginLedgerPath(root), `${JSON.stringify(entry(NOW))}\n{"at":"yesterday"}\n`)
  assert.throws(() => readLoginLedger(root), /login-ledger\.jsonl line 2/)
  fs.writeFileSync(loginLedgerPath(root), 'not json\n')
  assert.throws(() => readLoginLedger(root), /login-ledger\.jsonl line 1/)
})

test('every Desktop login line carries both input-tamper comparisons (MS-B2 liveness)', () => {
  const root = directory()
  assert.throws(
    () => recordPasswordLogin(root, { surface: 'desktop', inputChecks: 0 }),
    /inputChecks must be 2 for a Desktop login/
  )
  assert.throws(
    () => recordPasswordLogin(root, { surface: 'desktop', inputChecks: 1 }),
    /inputChecks must be 2 for a Desktop login/
  )
  assert.throws(
    () => recordPasswordLogin(root, { surface: 'control-ui', inputChecks: 1 }),
    /inputChecks must be 0 for the Control UI login/
  )
  assert.throws(() => recordPasswordLogin(root, { surface: 'terminal', inputChecks: 0 }), /surface/)
  // The valid pair still writes, so the throws above are not the only outcome.
  assert.equal(
    recordPasswordLogin(root, { surface: 'desktop', inputChecks: 2, at: NOW }).surface,
    'desktop'
  )
  // The read side enforces the same pair, so a line that lost the counter cannot
  // pass as a paced login.
  fs.writeFileSync(
    loginLedgerPath(root),
    `${JSON.stringify({ at: NOW, surface: 'desktop', inputChecks: 0 })}\n`
  )
  assert.throws(() => readLoginLedger(root), /login-ledger\.jsonl line 1: inputChecks must be 2/)
})

test('the helper waits the computed time from the ledger on disk', async () => {
  const root = directory()
  recordPasswordLogin(root, { surface: 'desktop', inputChecks: 2, at: NOW - 50_000 })
  recordPasswordLogin(root, { surface: 'desktop', inputChecks: 2, at: NOW - 3_000 })
  const sleeps = []
  const result = await waitForLoginPace(root, {
    now: () => NOW,
    sleep: async ms => {
      sleeps.push(ms)
    },
  })
  assert.deepEqual(sleeps, [5_500])
  assert.deepEqual(result, { waitedMs: 5_500, paced: true })
})

test('the helper does not sleep when the lane is already clear', async () => {
  const root = directory()
  recordPasswordLogin(root, { surface: 'desktop', inputChecks: 2, at: NOW - 60_000 })
  const sleeps = []
  const result = await waitForLoginPace(root, {
    now: () => NOW,
    sleep: async ms => {
      sleeps.push(ms)
    },
  })
  assert.deepEqual(sleeps, [])
  assert.deepEqual(result, { waitedMs: 0, paced: true })
  assert.deepEqual(await waitForLoginPace(null, {}), { waitedMs: 0, paced: false })
})
