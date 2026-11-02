/**
 * #1048 MS-1 / MS-B2 / MS-C12 — the decisions behind the Desktop helpers.
 *
 * Every function here is pure or takes its page, evidence reader, clock and
 * sleep as arguments, so `node --test` can pin the behaviour without a cluster
 * and the Playwright helpers stay thin wiring.
 *
 * MS-1 exists because run16's ten failed Retry clicks left no evidence of where
 * the continuation stopped: the rendered alert says only "could not be retried",
 * the Desktop main process output was not kept, and the capture in `finally`
 * could replace the test error. The pieces below name the layer instead.
 */
import { ADMISSION_PACE_MS, PACE_MARGIN_MS } from './login-ledger.mjs'

/**
 * The only Desktop main output MS-1 ever attaches.
 *
 * stdout/stderr is an unbounded surface — the app echoes prompt text there, and
 * nothing about that output is treated as safe to publish — so the filter is a
 * closed set of the lines that name the continuation's layer, and nothing
 * outside it leaves the helper.
 */
export const DESKTOP_DIAGNOSTIC_PATTERNS = Object.freeze([
  /Error occurred in handler for 'rpc:continueModelStep'/,
  /Continue model step failed \(\d{3}\)/,
  /Invalid model step continue response/,
  /fetch failed/,
  /ECONNREFUSED/,
  /ETIMEDOUT/,
  /AbortError/,
])

/** Test annotation used when the pre-teardown capture throws. */
export const CAPTURE_ANNOTATION = 'desktop-capture-failed'

export function filterDesktopDiagnostics(lines) {
  return lines.filter(line => DESKTOP_DIAGNOSTIC_PATTERNS.some(pattern => pattern.test(line)))
}

/**
 * Line buffer for the Desktop main process output.
 *
 * stdout/stderr arrive in arbitrary chunks, so a line can span two of them; the
 * buffer keeps the trailing partial line until its newline (or `flush`), and
 * bounds the memory it may hold. Only the filtered lines ever leave the helper.
 */
export function createMainOutputBuffer(limit) {
  if (!Number.isSafeInteger(limit) || limit <= 0)
    throw new Error('createMainOutputBuffer needs a positive line limit')
  const kept = []
  let pending = ''
  const keep = line => {
    kept.push(line)
    if (kept.length > limit) kept.splice(0, kept.length - limit)
  }
  return {
    push(chunk) {
      pending += chunk
      const parts = pending.split('\n')
      pending = parts.pop() ?? ''
      for (const line of parts) keep(line)
    },
    flush() {
      if (pending.length > 0) keep(pending)
      pending = ''
    },
    lines() {
      return [...kept]
    },
  }
}

export function firstDiagnosticLine(lines) {
  return filterDesktopDiagnostics(lines)[0]
}

/** Attachment body for the filtered lines; states the filter so a reader knows. */
export function formatDiagnosticsAttachment(matched) {
  return [
    '# Desktop main stdout/stderr, filtered to the closed retry-layer pattern set',
    '# (helpers/desktop-diagnostics.mjs). Nothing outside that set is attached.',
    ...(matched.length > 0 ? matched : ['(no matching line)']),
    '',
  ].join('\n')
}

function captureFailureText(error) {
  const text = error instanceof Error ? `${error.name}: ${error.message}` : String(error)
  return text.slice(0, 500)
}

/**
 * MS-1 item 4 — the capture never replaces the journey's error.
 *
 * Runs the capture, and on failure records a test annotation instead of
 * throwing, so the `finally` that calls it cannot mask the error the body is
 * already unwinding with. Returns the capture error for a caller that wants it.
 * `label` names the piece that failed, because the pre-teardown capture is
 * several attachments and one failing must not hide the others.
 */
export async function attachOrAnnotate(attach, annotate, label = 'capture') {
  try {
    await attach()
    return null
  } catch (error) {
    await annotate(CAPTURE_ANNOTATION, `${label}: ${captureFailureText(error)}`)
    return error
  }
}

/** Marker that replaces a password value in an attached aria snapshot. */
export const ARIA_REDACTION_MARKER = '[redacted]'

const PASSWORD_TEXTBOX_NAME = /\btextbox\s+"Password"/
const PASSWORD_TEXTBOX_VALUE = /^(\s*-\s*textbox\s+"Password"[^:\n]*):[ \t]*(.*)$/

/**
 * F-SECRET: `attachDesktopBeforeTeardown` used to claim that a password field
 * exposes no value in an aria snapshot. It does, and run16's report carried the
 * fixture password in clear. Every password textbox loses its value here.
 *
 * A password textbox line whose shape this does not recognise fails loud: it may
 * be carrying a value, so attaching it silently is the one outcome to avoid.
 */
export function redactAriaSnapshot(yaml) {
  const lines = String(yaml).split('\n')
  const unrecognised = lines.filter(
    line => PASSWORD_TEXTBOX_NAME.test(line) && !PASSWORD_TEXTBOX_VALUE.test(line)
  )
  if (unrecognised.length > 0)
    throw new Error(
      `ARIA_REDACTION_FAILED: ${unrecognised.length} password textbox line(s) in a shape this redaction cannot read`
    )
  let redacted = 0
  const output = lines.map(line => {
    const match = PASSWORD_TEXTBOX_VALUE.exec(line)
    if (!match || match[2].trim().length === 0) return line
    redacted += 1
    return `${match[1]}: ${ARIA_REDACTION_MARKER}`
  })
  return { yaml: output.join('\n'), redacted }
}

/** Failure token of MS-B2: the headed window took external input. */
export const INPUT_TAMPERED = 'DESKTOP_INPUT_TAMPERED'

/**
 * MS-B2 — the headed window accepts keystrokes from the operator's desktop, and
 * run16 C11's 401 came from three characters typed into the password field
 * between `fill` and `click`. The check compares both fields by equality and
 * never prints a value.
 */
export function assertUntamperedInputs(fields) {
  let checked = 0
  for (const [name, field] of Object.entries(fields)) {
    checked += 1
    if (field.actual !== field.expected)
      throw new Error(`${INPUT_TAMPERED}: the ${name} field changed between fill and click`)
  }
  return checked
}

/** Failure token of MS-B1: the Desktop login was refused, and by what. */
export const LOGIN_REFUSED = 'DESKTOP_LOGIN_REFUSED'

/**
 * MS-B1 item 3 — a refused login names the message the user saw, so a paced or
 * rate-limited login stops looking like a wrong password (issue #1273). The
 * toast prefixes its text with an aria-hidden glyph (`!` for an error); the
 * message keeps only the text. A captured Desktop main line, when there is one,
 * is appended as the MS-1 excerpt.
 */
export function loginRefusedMessage(toastText, diagnosticLines = []) {
  const text = String(toastText ?? '')
    .replace(/^[^A-Za-z]+/, '')
    .trim()
  const line = firstDiagnosticLine(diagnosticLines)
  const excerpt = line ? ` (desktop main: ${line})` : ''
  return `${LOGIN_REFUSED}: ${JSON.stringify(text || '(no toast text)')}${excerpt}`
}

/** `signInDesktop`'s post-click wait for the signed-in nav or the refusal toast. */
export const SIGN_IN_RESULT_TIMEOUT_MS = 30_000
/** First window, signed-out check and the two fills. */
export const SIGN_IN_LAUNCH_BUDGET_MS = 15_000
/** Longest pace wait `signInDesktop` performs before its click. */
export const SIGN_IN_PACE_BUDGET_MS = ADMISSION_PACE_MS + PACE_MARGIN_MS
/** Pre-teardown capture and sign-out at the end of a journey. */
export const C12_TEARDOWN_BUDGET_MS = 30_000
/**
 * MS-C12 — C12 covers its own waits: the sign-in it performs, the 60 s cap
 * notice, the Retry click's own outcome and continuation-stage polls (MS-1), the
 * reply it renders, and the capture/sign-out in `finally`. run16 ended C12 at the
 * 180 s default with no capture at all.
 */
export const C12_SIGN_IN_BUDGET_MS =
  SIGN_IN_LAUNCH_BUDGET_MS + SIGN_IN_PACE_BUDGET_MS + SIGN_IN_RESULT_TIMEOUT_MS

export function c12TestBudgetMs({
  capNoticeMaxMs,
  turnTimeoutMs,
  outcomeBudgetMs = RETRY_OUTCOME_BUDGET_MS,
}) {
  for (const [name, value] of Object.entries({ capNoticeMaxMs, turnTimeoutMs, outcomeBudgetMs })) {
    if (!Number.isSafeInteger(value) || value <= 0)
      throw new Error(`c12TestBudgetMs needs a positive integer of milliseconds for ${name}`)
  }
  return (
    C12_SIGN_IN_BUDGET_MS +
    capNoticeMaxMs +
    outcomeBudgetMs +
    // Two turn timeouts: the continuation stage wait, then the reply wait.
    2 * turnTimeoutMs +
    C12_TEARDOWN_BUDGET_MS
  )
}

/**
 * The layer tokens of MS-1. One per Retry case: either the POST was refused, the
 * Host never took the checkpoint, the Host took it and never called the model,
 * or the renderer never showed the answer.
 */
export const RETRY_LAYER = Object.freeze({
  postRejected: 'RETRY_POST_REJECTED',
  noOutcome: 'RETRY_NO_OUTCOME',
  claimed: 'HOST_CLAIMED',
  noContinuation: 'UPSTREAM_NO_CONTINUATION',
  noReply: 'RENDER_NO_REPLY',
})

/** MS-1 (b): the click's own outcome budget. */
export const RETRY_OUTCOME_BUDGET_MS = 15_000
export const RETRY_OUTCOME_POLL_MS = 500
/** MS-1 (f): how often the fixture evidence is read for the continuation stage. */
export const RETRY_STAGE_POLL_MS = 1_000

export function retryPostRejectedMessage(diagnosticLine) {
  return `${RETRY_LAYER.postRejected}: ${diagnosticLine ?? 'no handler error captured'}`
}

async function sleepMs(ms) {
  await new Promise(resolve => setTimeout(resolve, ms))
}

/**
 * MS-1 (f) — after the Host claimed the checkpoint, the continuation must reach
 * the deterministic upstream. Returns the stages that arrived after the click.
 */
export async function awaitContinuationStage({
  readStages,
  baselineLength,
  stage,
  budgetMs,
  pollMs = RETRY_STAGE_POLL_MS,
  now = Date.now,
  sleep = sleepMs,
}) {
  const deadline = now() + budgetMs
  for (;;) {
    const sinceClick = (await readStages()).slice(baselineLength)
    if (sinceClick.includes(stage)) return sinceClick
    if (now() >= deadline)
      throw new Error(
        `${RETRY_LAYER.noContinuation}: stages since click=[${sinceClick.join(', ')}]`
      )
    await sleep(pollMs)
  }
}

/**
 * MS-1 (a)–(f) — one Retry click, and the layer that stopped it when it stops.
 *
 * (a) clicks; (b) polls up to 15 s for the rendered alert or a checkpoint that
 * is no longer `resumable`; (c) the alert fails at once with the matched Desktop
 * main line; (d) a `claimed` checkpoint with its continuation task id is the
 * HOST_CLAIMED witness; (e) neither within the budget is RETRY_NO_OUTCOME;
 * (f) the case's first continuation stage must then appear upstream.
 *
 * The caller keeps its own UI waits afterwards: with the layer already named,
 * a missing reply there can only be the renderer (RENDER_NO_REPLY).
 */
export async function clickRetryModelStep(page, options) {
  const {
    click = locator => locator.click(),
    readCheckpoint,
    readStages,
    firstContinuationStage,
    diagnosticLines,
    outcomeBudgetMs = RETRY_OUTCOME_BUDGET_MS,
    outcomePollMs = RETRY_OUTCOME_POLL_MS,
    stageBudgetMs,
    stagePollMs = RETRY_STAGE_POLL_MS,
    now = Date.now,
    sleep = sleepMs,
  } = options
  for (const [name, value] of Object.entries({
    readCheckpoint,
    readStages,
    firstContinuationStage,
    diagnosticLines,
    stageBudgetMs,
  })) {
    if (!value) throw new Error(`clickRetryModelStep needs ${name}`)
  }

  const notice = page.getByTestId('model-step-retry-notice')
  const alert = notice.getByRole('alert')
  // The evidence baseline is read before the click: a fast continuation can
  // write its first stage before this process reads the list again.
  const baselineLength = (await readStages()).length
  await click(notice.getByTestId('model-step-retry-btn'))

  const deadline = now() + outcomeBudgetMs
  let checkpoint
  for (;;) {
    // The rendered alert is the Desktop's own failure report; it wins over the
    // checkpoint read, which can still show the pre-click row for a moment.
    if ((await alert.count()) > 0)
      throw new Error(retryPostRejectedMessage(firstDiagnosticLine(diagnosticLines())))
    checkpoint = await readCheckpoint()
    if (!checkpoint || checkpoint.status !== 'resumable') break
    if (now() >= deadline) throw new Error(`${RETRY_LAYER.noOutcome}: status=${checkpoint.status}`)
    await sleep(outcomePollMs)
  }

  const continuationTaskId =
    checkpoint && checkpoint.status === 'claimed' ? checkpoint.continuationTaskId : undefined
  if (checkpoint && checkpoint.status === 'claimed' && !continuationTaskId)
    throw new Error(`${RETRY_LAYER.noOutcome}: claimed checkpoint without continuationTaskId`)

  const stagesSinceClick = await awaitContinuationStage({
    readStages,
    baselineLength,
    stage: firstContinuationStage,
    budgetMs: stageBudgetMs,
    pollMs: stagePollMs,
    now,
    sleep,
  })
  return {
    layer: RETRY_LAYER.claimed,
    status: checkpoint ? checkpoint.status : 'absent',
    continuationTaskId,
    stagesSinceClick,
  }
}
