import assert from 'node:assert/strict'
import test from 'node:test'
import {
  ARIA_REDACTION_MARKER,
  C12_SIGN_IN_BUDGET_MS,
  C12_TEARDOWN_BUDGET_MS,
  DESKTOP_DIAGNOSTIC_PATTERNS,
  INPUT_TAMPERED,
  RETRY_LAYER,
  RETRY_OUTCOME_BUDGET_MS,
  assertUntamperedInputs,
  attachOrAnnotate,
  c12TestBudgetMs,
  clickRetryModelStep,
  createMainOutputBuffer,
  filterDesktopDiagnostics,
  firstDiagnosticLine,
  formatDiagnosticsAttachment,
  loginRefusedMessage,
  redactAriaSnapshot,
  retryPostRejectedMessage,
} from './desktop-diagnostics.mjs'

// #1048 MS-1/MS-B2/MS-C12: the helpers that make a Retry click name the layer
// that stopped, keep the capture from replacing the test error, redact the
// password the aria snapshot exposes, and give C12 a budget derived from its own
// waits. Every pure decision lives here so `node --test` can pin it; the
// Playwright helpers only pass real pages and evidence readers in.

function fakeClock(start = 1_000) {
  let current = start
  const sleeps = []
  return {
    sleeps,
    now: () => current,
    sleep: async ms => {
      sleeps.push(ms)
      current += ms
    },
  }
}

function fakePage({ alertTexts = [] } = {}) {
  const clicks = []
  const locator = kind => ({
    click: async () => clicks.push(kind),
    dblclick: async () => clicks.push(`${kind}:dblclick`),
    count: async () => (kind === 'alert' ? alertTexts.length : 1),
    textContent: async () => (kind === 'alert' ? (alertTexts[0] ?? null) : null),
    getByTestId: testId => locator(`${kind} > ${testId}`),
    getByRole: role => locator(role),
  })
  return { clicks, page: { getByTestId: testId => locator(`page > ${testId}`) } }
}

test('only the closed retry-layer pattern set survives the stderr filter', () => {
  const lines = [
    "Error occurred in handler for 'rpc:continueModelStep': Error: boom",
    'Continue model step failed (500): upstream said no',
    'Invalid model step continue response.taskId',
    'TypeError: fetch failed',
    'connect ECONNREFUSED 127.0.0.1:8094',
    'Error: ETIMEDOUT',
    'AbortError: The operation was aborted',
    // Dropped: the buffer can carry anything the app printed, fixture values
    // included, and MS-1 attaches nothing outside the set.
    'runner: model step retry probe c1-abc continued toolResults=1',
    'password=changeme123!',
    'Send message c4-def',
  ]
  const matched = filterDesktopDiagnostics(lines)
  assert.deepEqual(matched, lines.slice(0, DESKTOP_DIAGNOSTIC_PATTERNS.length))
  // Each pattern is exercised, so a deleted pattern fails here instead of in a lane.
  assert.equal(DESKTOP_DIAGNOSTIC_PATTERNS.length, 7)
  assert.equal(firstDiagnosticLine(lines), lines[0])
  assert.equal(firstDiagnosticLine(['password=changeme123!']), undefined)
})

test('the attachment says how many lines matched, and never attaches raw output', () => {
  assert.match(formatDiagnosticsAttachment([]), /\(no matching line\)/)
  const body = formatDiagnosticsAttachment(['Continue model step failed (404): not found'])
  assert.match(body, /Continue model step failed \(404\): not found/)
  assert.match(body, /Nothing outside that set is attached/)
})

test('the main output buffer assembles split lines and bounds itself', () => {
  const buffer = createMainOutputBuffer(3)
  // Two chunks of one line, then a whole line in a third.
  buffer.push('Continue model step fail')
  assert.deepEqual(buffer.lines(), [])
  buffer.push('ed (500): upstream\nsecond line\n')
  assert.deepEqual(buffer.lines(), ['Continue model step failed (500): upstream', 'second line'])
  // A trailing partial line is only a line once it ends (or the stream closes).
  buffer.push('third')
  assert.deepEqual(buffer.lines(), ['Continue model step failed (500): upstream', 'second line'])
  buffer.flush()
  assert.deepEqual(buffer.lines(), [
    'Continue model step failed (500): upstream',
    'second line',
    'third',
  ])
  // The bound drops the oldest line, and the filter still works on what is left.
  buffer.push('fourth\n')
  assert.deepEqual(buffer.lines(), ['second line', 'third', 'fourth'])
  assert.throws(() => createMainOutputBuffer(0), /positive line limit/)
})

test('a throwing capture keeps the original error and becomes an annotation', async () => {
  const original = new Error('continue failed')
  const capture = async () => {
    throw new Error('Target closed')
  }
  // The behaviour the guard replaces: a finally that awaits the capture lets the
  // capture's error win, which is how run16 lost C12's real failure.
  await assert.rejects(
    async () => {
      try {
        throw original
      } finally {
        await capture()
      }
    },
    error => error.message === 'Target closed'
  )
  const annotations = []
  await assert.rejects(
    async () => {
      try {
        throw original
      } finally {
        await attachOrAnnotate(capture, (type, description) => {
          annotations.push({ type, description })
        })
      }
    },
    error => error === original
  )
  assert.equal(annotations.length, 1)
  assert.equal(annotations[0].type, 'desktop-capture-failed')
  assert.match(annotations[0].description, /Target closed/)
  // A capture that succeeds annotates nothing.
  await attachOrAnnotate(
    async () => {},
    () => {
      throw new Error('must not annotate')
    }
  )
})

test('the aria snapshot loses the password value and keeps every other value', () => {
  const snapshot = [
    '- main:',
    '  - heading "Sign in" [level=1]',
    '  - textbox "Email": fixture@clerum.io',
    '  - textbox "Password": changeme123!',
    '  - button "Sign in"',
  ].join('\n')
  const { yaml, redacted } = redactAriaSnapshot(snapshot)
  assert.equal(redacted, 1)
  assert.equal(yaml.includes('changeme123!'), false)
  assert.equal(yaml.split('\n').includes(`  - textbox "Password": ${ARIA_REDACTION_MARKER}`), true)
  // Liveness: the snapshot still carries its other values, so the redaction
  // targeted the password field and not the document.
  assert.match(yaml, /textbox "Email": fixture@clerum\.io/)
  assert.match(yaml, /button "Sign in"/)
})

test('a snapshot without a password field is attached unchanged', () => {
  const snapshot = ['- main:', '  - textbox "Search chats": c4', '  - button "Send message"'].join(
    '\n'
  )
  const { yaml, redacted } = redactAriaSnapshot(snapshot)
  assert.equal(redacted, 0)
  assert.equal(yaml, snapshot)
  // An empty password textbox carries nothing to redact and is left alone.
  const empty = redactAriaSnapshot('- textbox "Password":')
  assert.equal(empty.redacted, 0)
  assert.equal(empty.yaml, '- textbox "Password":')
  // A password line in a shape this cannot read may hide a value: fail loud
  // rather than attach it.
  assert.throws(
    () => redactAriaSnapshot('- textbox "Password" [value=changeme123!]'),
    /ARIA_REDACTION_FAILED: 1 password textbox line/
  )
})

test('a field that changed between fill and click fails as tampering, without its value', () => {
  const expected = { email: 'fixture@clerum.io', password: 'changeme123!' }
  assert.equal(
    assertUntamperedInputs({
      email: { expected: expected.email, actual: expected.email },
      password: { expected: expected.password, actual: expected.password },
    }),
    2
  )
  const tampered = 'changeme123!typed'
  assert.throws(
    () =>
      assertUntamperedInputs({
        email: { expected: expected.email, actual: expected.email },
        password: { expected: expected.password, actual: tampered },
      }),
    error => {
      assert.match(error.message, new RegExp(`^${INPUT_TAMPERED}: the password field`))
      assert.equal(error.message.includes(tampered), false)
      assert.equal(error.message.includes(expected.password), false)
      return true
    }
  )
})

test('a refused login names the toast text and the captured Desktop main line', () => {
  assert.equal(
    loginRefusedMessage('!Login failed. Check your email and password.', []),
    'DESKTOP_LOGIN_REFUSED: "Login failed. Check your email and password."'
  )
  assert.equal(
    loginRefusedMessage('!Login failed. Check your email and password.', [
      'noise',
      'Continue model step failed (429): paced',
    ]),
    'DESKTOP_LOGIN_REFUSED: "Login failed. Check your email and password." (desktop main: Continue model step failed (429): paced)'
  )
  assert.equal(loginRefusedMessage(null), 'DESKTOP_LOGIN_REFUSED: "(no toast text)"')
})

test('the C12 budget is the sum of the waits it covers, not a literal', () => {
  const capNoticeMaxMs = 75_000
  const turnTimeoutMs = 120_000
  const budget = c12TestBudgetMs({ capNoticeMaxMs, turnTimeoutMs })
  // The four components the plan names, plus MS-1's own outcome poll and the
  // second turn timeout for the stage wait in front of the reply wait.
  assert.equal(
    budget,
    C12_SIGN_IN_BUDGET_MS +
      capNoticeMaxMs +
      RETRY_OUTCOME_BUDGET_MS +
      2 * turnTimeoutMs +
      C12_TEARDOWN_BUDGET_MS
  )
  assert.ok(budget >= capNoticeMaxMs + turnTimeoutMs + 60_000)
  // The run16 default that hid C12's capture is no longer reachable from here.
  assert.ok(budget > 180_000, `C12 budget ${budget} must exceed the 180000 ms that expired`)
  // It follows its inputs instead of pinning one answer.
  assert.equal(
    c12TestBudgetMs({ capNoticeMaxMs: capNoticeMaxMs + 1_000, turnTimeoutMs }) - budget,
    1_000
  )
  assert.throws(() => c12TestBudgetMs({ capNoticeMaxMs: 0, turnTimeoutMs }), /capNoticeMaxMs/)
  assert.throws(() => c12TestBudgetMs({ capNoticeMaxMs, turnTimeoutMs: 1.5 }), /turnTimeoutMs/)
  assert.throws(
    () => c12TestBudgetMs({ capNoticeMaxMs, turnTimeoutMs, outcomeBudgetMs: -1 }),
    /outcomeBudgetMs/
  )
})

test('a rendered alert fails the Retry click at once and names the stderr line', async () => {
  const { page } = fakePage({ alertTexts: ['The model step could not be retried. Try again.'] })
  const clock = fakeClock()
  await assert.rejects(
    clickRetryModelStep(page, {
      readCheckpoint: async () => ({ status: 'resumable' }),
      readStages: async () => [],
      firstContinuationStage: 'model_step_continued',
      diagnosticLines: () => ['noise', 'Continue model step failed (404): not found'],
      stageBudgetMs: 120_000,
      ...clock,
    }),
    error => error.message === 'RETRY_POST_REJECTED: Continue model step failed (404): not found'
  )
  // No wait: the alert is the outcome.
  assert.deepEqual(clock.sleeps, [])
  assert.equal(
    retryPostRejectedMessage(undefined),
    'RETRY_POST_REJECTED: no handler error captured'
  )
})

test('a claimed checkpoint is the HOST_CLAIMED witness once the stage appears', async () => {
  const { clicks, page } = fakePage()
  const clock = fakeClock()
  const stages = [['model_step_search'], ['model_step_search', 'model_step_approval_tool']]
  let reads = 0
  const result = await clickRetryModelStep(page, {
    readCheckpoint: async () => ({ status: 'claimed', continuationTaskId: 'task-1' }),
    readStages: async () => stages[Math.min(reads++, stages.length - 1)],
    firstContinuationStage: 'model_step_approval_tool',
    diagnosticLines: () => [],
    stageBudgetMs: 120_000,
    ...clock,
  })
  assert.deepEqual(result, {
    layer: RETRY_LAYER.claimed,
    status: 'claimed',
    continuationTaskId: 'task-1',
    stagesSinceClick: ['model_step_approval_tool'],
  })
  assert.deepEqual(clicks, ['page > model-step-retry-notice > model-step-retry-btn'])
})

test('a checkpoint that stays resumable for the whole budget names RETRY_NO_OUTCOME', async () => {
  const { page } = fakePage()
  const clock = fakeClock()
  await assert.rejects(
    clickRetryModelStep(page, {
      readCheckpoint: async () => ({ status: 'resumable' }),
      readStages: async () => [],
      firstContinuationStage: 'model_step_continued',
      diagnosticLines: () => [],
      stageBudgetMs: 120_000,
      ...clock,
    }),
    error => error.message === 'RETRY_NO_OUTCOME: status=resumable'
  )
  // The budget was spent polling, and it is the module's own 15 s budget.
  assert.ok(clock.sleeps.length > 0)
  assert.equal(
    clock.sleeps.reduce((total, ms) => total + ms, 0),
    RETRY_OUTCOME_BUDGET_MS
  )
})

test('a claimed checkpoint whose continuation never reaches upstream names the stage list', async () => {
  const { page } = fakePage()
  const clock = fakeClock()
  await assert.rejects(
    clickRetryModelStep(page, {
      readCheckpoint: async () => ({ status: 'claimed', continuationTaskId: 'task-1' }),
      readStages: async () => ['model_step_search'],
      firstContinuationStage: 'model_step_continued',
      diagnosticLines: () => [],
      stageBudgetMs: 5_000,
      ...clock,
    }),
    error => error.message === 'UPSTREAM_NO_CONTINUATION: stages since click=[]'
  )
})

test('a checkpoint retired before the first read still waits for the continuation stage', async () => {
  const { page } = fakePage()
  const clock = fakeClock()
  let reads = 0
  const result = await clickRetryModelStep(page, {
    readCheckpoint: async () => undefined,
    // The click's own evidence read sees the finished list; the baseline was
    // taken before it.
    readStages: async () =>
      reads++ === 0 ? ['model_step_search'] : ['model_step_search', 'model_step_continued'],
    firstContinuationStage: 'model_step_continued',
    diagnosticLines: () => [],
    stageBudgetMs: 120_000,
    ...clock,
  })
  assert.equal(result.status, 'absent')
  assert.deepEqual(result.stagesSinceClick, ['model_step_continued'])
})

test('a claimed checkpoint without its continuation task id fails loud', async () => {
  const { page } = fakePage()
  await assert.rejects(
    clickRetryModelStep(page, {
      readCheckpoint: async () => ({ status: 'claimed' }),
      readStages: async () => [],
      firstContinuationStage: 'model_step_continued',
      diagnosticLines: () => [],
      stageBudgetMs: 120_000,
      ...fakeClock(),
    }),
    error => error.message === 'RETRY_NO_OUTCOME: claimed checkpoint without continuationTaskId'
  )
})

test('the caller decides how the button is clicked, so C4 keeps its double click', async () => {
  const { clicks, page } = fakePage()
  let reads = 0
  const result = await clickRetryModelStep(page, {
    click: locator => locator.dblclick(),
    readCheckpoint: async () => ({ status: 'claimed', continuationTaskId: 'task-1' }),
    readStages: async () => (reads++ === 0 ? [] : ['model_step_continued']),
    firstContinuationStage: 'model_step_continued',
    diagnosticLines: () => [],
    stageBudgetMs: 120_000,
    ...fakeClock(),
  })
  assert.deepEqual(clicks, ['page > model-step-retry-notice > model-step-retry-btn:dblclick'])
  assert.equal(result.layer, RETRY_LAYER.claimed)
})

test('the helper refuses an option it cannot observe with', async () => {
  const { page } = fakePage()
  await assert.rejects(
    clickRetryModelStep(page, {
      readCheckpoint: async () => ({ status: 'claimed', continuationTaskId: 'task-1' }),
      readStages: async () => [],
      diagnosticLines: () => [],
      stageBudgetMs: 1_000,
      ...fakeClock(),
    }),
    /clickRetryModelStep needs firstContinuationStage/
  )
})
