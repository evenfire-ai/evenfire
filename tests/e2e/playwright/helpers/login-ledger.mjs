/**
 * #1048 MS-B1 — the lane's password-login ledger.
 *
 * control-api verifies every password under one global pace (`paceMs`) across
 * all identities and under `sourceAttemptsPerMinute` attempts per source per
 * minute (`control-api/src/services/auth/passwordAdmissionState.ts`,
 * `PASSWORD_ADMISSION_POLICY`). A lane of short Desktop journeys can issue two
 * logins inside that pace, and the second one is refused with control-api's
 * generic failure text, which reads like a wrong password.
 *
 * The lane therefore records every password login it performs — the Control UI
 * admin login of the setup test and every Desktop login — in the run directory
 * and waits before the next one. The record lives on disk because Playwright may
 * restart a worker between cases, and a module variable does not survive that.
 *
 * The two policy numbers are restated here because the Playwright lane does not
 * ship the control-api TypeScript sources; `scripts/e2e/model-step-retry-constants-parity.test.mjs`
 * extracts them from the policy object and fails when the two drift apart.
 */
import fs from 'node:fs'
import path from 'node:path'

/** `PASSWORD_ADMISSION_POLICY.paceMs`: one password verification per 7.5 s globally. */
export const ADMISSION_PACE_MS = 7_500
/** `PASSWORD_ADMISSION_POLICY.sourceAttemptsPerMinute`. */
export const SOURCE_ATTEMPTS_PER_MINUTE = 5
/** MS-B1: the wait clears `paceMs` plus one second of scheduling margin. */
export const PACE_MARGIN_MS = 1_000
/** The window the per-source attempt counter looks at. */
export const SOURCE_WINDOW_MS = 60_000
/**
 * Entries the lane leaves inside the window before a login: MS-B1 asks for
 * "fewer than `sourceAttemptsPerMinute - 1`", so at most three, and the login
 * about to happen makes the fourth of the five the policy allows.
 */
export const RETAINED_SOURCE_ATTEMPTS = SOURCE_ATTEMPTS_PER_MINUTE - 2
/** Ledger file inside the lane's run directory. */
export const LOGIN_LEDGER_FILE = 'login-ledger.jsonl'

const SURFACES = new Set(['desktop', 'control-ui'])
/** Desktop login comparisons: one per login field (email, password), MS-B2. */
const DESKTOP_INPUT_CHECKS = 2
const CONTROL_UI_INPUT_CHECKS = 0

/**
 * The tamper-check count a ledger line must carry for its surface. A Desktop
 * login always compared both fields; the Control UI login runs no such check.
 *
 * The rule is enforced on read as well as on write: the counter is MS-B2's
 * liveness evidence, so a line that lost it must not silently pass as a paced
 * login.
 */
function validateInputChecks(surface, inputChecks, where) {
  if (!Number.isSafeInteger(inputChecks) || inputChecks < 0)
    throw new Error(`${where}: inputChecks must be a non-negative integer`)
  if (surface === 'desktop' && inputChecks !== DESKTOP_INPUT_CHECKS)
    throw new Error(
      `${where}: inputChecks must be ${DESKTOP_INPUT_CHECKS} for a Desktop login (MS-B2 checks both fields)`
    )
  if (surface === 'control-ui' && inputChecks !== CONTROL_UI_INPUT_CHECKS)
    throw new Error(`${where}: inputChecks must be 0 for the Control UI login`)
  return inputChecks
}

/**
 * The lane's run directory, or `null` outside the approved-tools lane. Only that
 * lane's runner sets `APPROVED_TOOLS_EVIDENCE_DIR`; the Control UI suites share
 * `loginControlUiVisible` and have no lane run directory, so the helpers stay
 * inert there rather than failing a run that owns no admission budget.
 */
export function loginLedgerRootFromEnv(env = process.env) {
  const root = env.APPROVED_TOOLS_EVIDENCE_DIR
  return typeof root === 'string' && root.length > 0 ? root : null
}

export function loginLedgerPath(root) {
  if (typeof root !== 'string' || root.length === 0)
    throw new Error('loginLedgerPath needs the lane run directory')
  return path.join(root, LOGIN_LEDGER_FILE)
}

function parseEntry(line, index) {
  let entry
  try {
    entry = JSON.parse(line)
  } catch {
    throw new Error(`${LOGIN_LEDGER_FILE} line ${index + 1} is not JSON; delete the run directory`)
  }
  if (entry === null || typeof entry !== 'object' || Array.isArray(entry))
    throw new Error(`${LOGIN_LEDGER_FILE} line ${index + 1} is not an object`)
  if (!Number.isSafeInteger(entry.at) || entry.at <= 0)
    throw new Error(`${LOGIN_LEDGER_FILE} line ${index + 1} has no integer timestamp`)
  if (!SURFACES.has(entry.surface))
    throw new Error(`${LOGIN_LEDGER_FILE} line ${index + 1} has an unknown surface`)
  validateInputChecks(entry.surface, entry.inputChecks, `${LOGIN_LEDGER_FILE} line ${index + 1}`)
  return { at: entry.at, surface: entry.surface, inputChecks: entry.inputChecks }
}

/**
 * Every password login this lane performed, oldest first. A malformed line is an
 * error: silently dropping it would unpaced the lane without saying so.
 */
export function readLoginLedger(root) {
  if (root === null) return []
  const file = loginLedgerPath(root)
  if (!fs.existsSync(file)) return []
  const text = fs.readFileSync(file, 'utf8')
  const lines = text.split('\n')
  // A trailing newline is the normal end of the file, not an empty entry.
  if (lines.length > 0 && lines[lines.length - 1] === '') lines.pop()
  return lines.map((line, index) => parseEntry(line, index))
}

/**
 * Milliseconds to wait before the next password verification.
 *
 * Two independent constraints: `paceMs + margin` since the most recent login,
 * and fewer than `SOURCE_ATTEMPTS_PER_MINUTE - 1` entries inside the last minute
 * — so the login about to happen leaves the source allowance one attempt spare.
 * The blocking entry for the second constraint is the
 * `RETAINED_SOURCE_ATTEMPTS + 1`-th newest one.
 */
export function waitMsForLoginPace(entries, now = Date.now()) {
  const timestamps = entries.map(entry => entry.at).sort((a, b) => b - a)
  if (timestamps.length === 0) return 0
  let wait = Math.max(0, timestamps[0] + ADMISSION_PACE_MS + PACE_MARGIN_MS - now)
  if (timestamps.length > RETAINED_SOURCE_ATTEMPTS) {
    const blocking = timestamps[RETAINED_SOURCE_ATTEMPTS]
    wait = Math.max(wait, blocking + SOURCE_WINDOW_MS - now)
  }
  return wait
}

async function sleepMs(ms) {
  await new Promise(resolve => setTimeout(resolve, ms))
}

/**
 * Waits for the lane's own pace. `{ paced: false }` says the caller has no lane
 * run directory, so nothing was recorded or waited for.
 */
export async function waitForLoginPace(root, { now = Date.now, sleep = sleepMs } = {}) {
  if (root === null) return { waitedMs: 0, paced: false }
  const waitedMs = waitMsForLoginPace(readLoginLedger(root), now())
  if (waitedMs > 0) await sleep(waitedMs)
  return { waitedMs, paced: true }
}

/**
 * Appends one login. Called immediately before the click, so a login that dies
 * mid-flight still counts and can only lengthen the next wait. Never records a
 * field value: the ledger carries a timestamp, the surface and the number of
 * input-tamper comparisons that ran.
 */
export function recordPasswordLogin(root, { surface, inputChecks, at = Date.now() }) {
  if (root === null) return null
  if (!SURFACES.has(surface))
    throw new Error(`recordPasswordLogin got an unknown surface: ${String(surface)}`)
  validateInputChecks(surface, inputChecks, 'recordPasswordLogin')
  if (!Number.isSafeInteger(at) || at <= 0)
    throw new Error('recordPasswordLogin needs an integer timestamp')
  const entry = { at, surface, inputChecks }
  fs.appendFileSync(loginLedgerPath(root), `${JSON.stringify(entry)}\n`, { mode: 0o600 })
  return entry
}
