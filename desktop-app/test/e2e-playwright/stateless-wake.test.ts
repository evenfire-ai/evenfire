// Desktop prewarm and recovery UX for a suspended stateless host.
//
// This spec is the final Playwright phase of scripts/e2e/e2e-stateless-suspend-wake.sh.
// It drives the real Desktop app through the existing authenticated route and
// verifies catalog-time prewarm, conversation continuity, branch-aware wake/retry
// handling, and composer recovery. The bash phase owns the Kubernetes
// suspended-host precondition before Electron starts; this spec must run through
// that combined gate rather than being reported as a standalone cold-start test.
import { expect, test } from './fixtures.js'
import { openAgentsPage } from './navigationHelpers.js'

const HOST_REF =
  process.env.E2E_STATELESS_HOST_REF || process.env.E2E_HOST_REF || 'chatllm-stateless'

// A defensive wake/retry can still occur if readiness changes during a send.
// Give that visible state and response one bounded deadline; never poll.
const WAKE_VISIBLE_TIMEOUT = 270_000
// A single LLM turn (after the host is warm) — used for retry-then-reply and
// composer-recovery waits so a targeted assertion fails before the outer
// test.setTimeout, giving a precise failure rather than a blanket timeout.
const TURN_TIMEOUT = 120_000
const CATALOG_PREWARM_TIMEOUT = 90_000

test.describe.configure({ mode: 'serial' })

type HostRuntimeSignal = {
  hostRef: string
  ready: boolean
  agentState: string | null
  observedAt: string | null
  error: string | null
}

async function openStatelessAgent(appPage: import('@playwright/test').Page): Promise<void> {
  await openAgentsPage(appPage)
  const chatInput = appPage.getByTestId('chat-input')
  const agentLink = appPage.locator('.agents-table-row-clickable', { hasText: HOST_REF })
  const emptyState = appPage.locator('text=No agents available')
  await expect(agentLink.first().or(emptyState)).toBeVisible({ timeout: 20_000 })
  if (await emptyState.isVisible()) {
    throw new Error(
      `[stateless-wake] No agents available for the E2E user — the stateless host "${HOST_REF}" ` +
        `is not associated. Run scripts/e2e/seed-stateless-host.sh before this spec.`
    )
  }

  const agentRow = agentLink.first()
  await expect(
    agentRow,
    `[stateless-wake] Expected authorized agent row for "${HOST_REF}" in Desktop Agents.`
  ).toBeVisible({ timeout: 20_000 })

  await agentRow.getByRole('button', { name: `More actions for ${HOST_REF}` }).click()
  const actionsMenu = appPage.getByRole('menu')
  await expect(actionsMenu).toBeVisible({ timeout: 10_000 })
  const newChatAction = actionsMenu
    .getByRole('button', { name: /^New chat$/ })
    .or(actionsMenu.getByRole('menuitem', { name: /^New chat$/ }))
  await expect(newChatAction).toBeVisible({ timeout: 10_000 })
  await newChatAction.click()

  await chatInput.waitFor({ state: 'visible', timeout: 30_000 })
  await expect(appPage.getByRole('button', { name: /^Switch chat agent$/ })).toContainText(
    HOST_REF,
    { timeout: 30_000 }
  )
}

// The bash phase establishes the suspended-host precondition before Electron
// starts. We do not sleep or query Kubernetes from this user-journey spec:
// E2E_STATELESS_SUSPENDED is set only after the enclosing bash gate has proved
// state=suspended, replicas=0, and no running host pod. Desktop then proves
// catalog prewarm before the user selects the agent.
function requireSuspendPrecondition(): void {
  if (process.env.E2E_STATELESS_SUSPENDED !== '1') {
    throw new Error(
      '[stateless-wake] E2E_STATELESS_SUSPENDED!=1 — the bash phase must scale the stateless ' +
        'host to 0 and confirm the >=1-minute idle floor before this measured journey runs. ' +
        'Refusing to run a journey that would race the idle floor and silently take a warm path.'
    )
  }
}

async function visibleAgentNames(appPage: import('@playwright/test').Page): Promise<string[]> {
  return appPage
    .locator('.agents-table-row-clickable')
    .evaluateAll(rows =>
      rows.map(row => row.querySelector('strong')?.textContent?.trim() || '').filter(Boolean)
    )
}

async function readHostRuntimeSignal(
  appPage: import('@playwright/test').Page,
  hostRef: string,
  hostRefs: string[]
): Promise<HostRuntimeSignal> {
  return appPage.evaluate(
    async args => {
      try {
        const status = await window.clerum.rpc.getHostStatus(args.hostRef, args.hostRefs)
        const observedAt = typeof status.observedAt === 'string' ? status.observedAt : null
        const agentState = typeof status.agent?.state === 'string' ? status.agent.state : null
        const matchesRequestedHost = status.hostRef === args.hostRef
        return {
          hostRef: status.hostRef || args.hostRef,
          ready: Boolean(matchesRequestedHost && observedAt),
          agentState,
          observedAt,
          error: matchesRequestedHost
            ? null
            : `unexpected status hostRef=${status.hostRef || '<empty>'}`,
        }
      } catch (error) {
        return {
          hostRef: args.hostRef,
          ready: false,
          agentState: null,
          observedAt: null,
          error: error instanceof Error ? error.message : String(error),
        }
      }
    },
    { hostRef, hostRefs }
  )
}

test('Scenario 0 — authenticated catalog prewarms every visible agent before selection', async ({
  appPage,
}, testInfo) => {
  test.setTimeout(150_000)
  requireSuspendPrecondition()

  const agentNames = await test.step('open Agents without selecting a stateless chat', async () => {
    await openAgentsPage(appPage)
    await expect(appPage.getByRole('heading', { name: /^Agents$/ })).toBeVisible({
      timeout: 20_000,
    })
    await expect(
      appPage.locator('.agents-table-row-clickable', { hasText: HOST_REF }).first(),
      `[stateless-wake] Expected authorized agent row for "${HOST_REF}" before any stateless chat interaction.`
    ).toBeVisible({ timeout: 20_000 })
    const names = await visibleAgentNames(appPage)
    expect(names, 'Agents page should expose at least one visible authorized agent').toContain(
      HOST_REF
    )
    return names
  })

  const signals = new Map<string, HostRuntimeSignal>()
  await test.step('assert catalog prewarm made every visible host runtime reachable', async () => {
    await expect
      .poll(
        async () => {
          const latest = await Promise.all(
            agentNames.map(agentName => readHostRuntimeSignal(appPage, agentName, agentNames))
          )
          latest.forEach(signal => signals.set(signal.hostRef, signal))
          const blocked = latest.filter(signal => !signal.ready)
          if (blocked.length === 0) return 'ready'
          return blocked
            .map(signal => `${signal.hostRef}:${signal.error || signal.agentState || 'not-ready'}`)
            .join('|')
        },
        {
          timeout: CATALOG_PREWARM_TIMEOUT,
          intervals: [500, 1_000, 2_000],
          message:
            'Desktop login/catalog must make every visible authorized host reachable before the user selects the stateless agent.',
        }
      )
      .toBe('ready')
  })

  expect(
    signals.get(HOST_REF)?.ready,
    `Catalog prewarm must make the requested stateless host "${HOST_REF}" reachable before selection.`
  ).toBe(true)

  const payload = { host_ref: HOST_REF, agentNames, signals: Array.from(signals.values()) }
  console.log(`[StatelessCatalogPrewarm] ${JSON.stringify(payload)}`)
  await testInfo.attach('stateless-catalog-prewarm', {
    body: JSON.stringify(payload, null, 2),
    contentType: 'application/json',
  })
})

// A send exercises exactly one of two real branches. We resolve which one by
// racing the delivered-response signal against the waking-state affordance,
// then — on the failed branch — clicking "Retry last send" and awaiting the
// delivered response. Returns the mode actually taken so the caller can record
// it (the journey must not be silently bimodal about which path it measured).
async function resolveWakeOutcome(
  appPage: import('@playwright/test').Page,
  marker: string
): Promise<'warm' | 'cold'> {
  const wakingState = appPage.getByTestId('waking-state')
  const markerResponse = appPage.getByTestId('agent-response').filter({ hasText: marker }).last()

  // Race the two mutually-exclusive first outcomes under a single bound.
  const outcome = await Promise.race([
    markerResponse
      .waitFor({ state: 'visible', timeout: WAKE_VISIBLE_TIMEOUT })
      .then(() => 'warm' as const),
    wakingState
      .waitFor({ state: 'visible', timeout: WAKE_VISIBLE_TIMEOUT })
      .then(() => 'cold' as const),
  ])

  if (outcome === 'cold') {
    // Failed wake: waking-state is up, the message was NOT delivered. The reply
    // only lands after a manual retry (no auto-retry exists). Scope the button
    // to the waking-state block — the non-waking error branch renders its own
    // "Retry last send", so an unscoped name lookup would be ambiguous.
    const retry = wakingState.getByRole('button', { name: /retry last send/i })
    await expect(retry).toBeEnabled({ timeout: TURN_TIMEOUT })
    await retry.click()
    await expect(markerResponse).toBeVisible({ timeout: WAKE_VISIBLE_TIMEOUT })
  }

  await expect(markerResponse).toContainText(marker, { timeout: TURN_TIMEOUT })
  return outcome
}

async function recordMode(
  testInfo: import('@playwright/test').TestInfo,
  scenario: string,
  mode: 'warm' | 'cold'
): Promise<void> {
  // Observability only — this records which branch the journey actually took
  // so a reviewer can see the run was not silently bimodal. It is NOT a gate.
  const line = { scenario, host_ref: HOST_REF, mode }
  console.log(`[StatelessWakeJourney] ${JSON.stringify(line)}`)
  await testInfo.attach(`stateless-wake-${scenario}-mode`, {
    body: JSON.stringify(line, null, 2),
    contentType: 'application/json',
  })
}

async function expectComposerIdleReady(
  appPage: import('@playwright/test').Page,
  chatInput: import('@playwright/test').Locator
) {
  const idleSendButton = appPage.getByRole('button', { name: /^send message$/i })

  await expect(chatInput).toBeVisible({ timeout: TURN_TIMEOUT })
  await expect(chatInput).toBeEnabled({ timeout: TURN_TIMEOUT })
  await expect(idleSendButton).toBeVisible({ timeout: TURN_TIMEOUT })
  await expect(idleSendButton).toBeDisabled()

  return idleSendButton
}

async function expectComposerAcceptsFreshInput(
  appPage: import('@playwright/test').Page,
  chatInput: import('@playwright/test').Locator,
  draft: string
) {
  const idleSendButton = await expectComposerIdleReady(appPage, chatInput)
  await chatInput.fill(draft)
  await expect(idleSendButton).toBeEnabled()
  return idleSendButton
}

test('Scenario 1 — catalog-prewarmed stateless conversation continues after selection', async ({
  appPage,
}, testInfo) => {
  test.setTimeout(360_000)

  // Attach the dialog listener BEFORE any send so no unhandled dialog can slip
  // past between opening the agent and the first interaction.
  const dialogs: string[] = []
  appPage.on('dialog', dialog => {
    dialogs.push(dialog.message())
    void dialog.dismiss()
  })

  await openStatelessAgent(appPage)
  requireSuspendPrecondition()

  const chatInput = appPage.getByTestId('chat-input')
  const sendButton = appPage.getByRole('button', { name: /send message/i })

  const wakeMarker = `WAKE_S1_${Date.now()}`
  await chatInput.fill(`Reply with exactly: ${wakeMarker}`)

  // Business signal — the user's message lands in the thread.
  await sendButton.click()
  await expect(
    appPage.getByTestId('message-list').getByText(`Reply with exactly: ${wakeMarker}`).first()
  ).toBeVisible({ timeout: 30_000 })

  // Resolve warm/hold-success vs failed-then-retry; either way the marker reply
  // must ultimately render. recordMode makes the branch explicit in the report.
  const mode = await resolveWakeOutcome(appPage, wakeMarker)
  await recordMode(testInfo, 'scenario-1', mode)

  // Composer returns to idle and accepts fresh input. Empty drafts intentionally
  // keep the send button disabled; filling a real draft is the user-visible
  // signal that the composer recovered.
  await expectComposerAcceptsFreshInput(appPage, chatInput, 'Recovered after wake')

  expect(dialogs).toHaveLength(0)
})

test('Scenario 2 — wake/retry branch handling is safe; composer never gets stuck', async ({
  appPage,
}, testInfo) => {
  test.setTimeout(360_000)

  // Attach the dialog listener BEFORE the first send.
  const dialogs: string[] = []
  appPage.on('dialog', dialog => {
    dialogs.push(dialog.message())
    void dialog.dismiss()
  })

  await openStatelessAgent(appPage)
  requireSuspendPrecondition()

  const chatInput = appPage.getByTestId('chat-input')
  const sendButton = appPage.getByRole('button', { name: /send message/i })

  const firstMarker = `WAKE_S2_A_${Date.now()}`
  await chatInput.fill(`Reply with exactly: ${firstMarker}`)
  await sendButton.click()

  // The invariant that holds on BOTH branches: the composer must never surface
  // an unhandled error dialog, and the marker reply must ultimately render —
  // directly on the warm branch, or after the manual "Retry last send" on the
  // failed branch (resolveWakeOutcome performs the click). If the failed branch
  // is taken, this is exactly the assertion that the waking-state affordance is
  // usable rather than a dead end.
  const firstMode = await resolveWakeOutcome(appPage, firstMarker)
  await recordMode(testInfo, 'scenario-2-first', firstMode)
  expect(dialogs).toHaveLength(0)

  // The composer must recover and accept a second send on the SAME thread.
  const recoveryMarker = `WAKE_S2_B_${Date.now()}`
  await expectComposerAcceptsFreshInput(appPage, chatInput, `Reply with exactly: ${recoveryMarker}`)
  await sendButton.click()

  const secondMode = await resolveWakeOutcome(appPage, recoveryMarker)
  await recordMode(testInfo, 'scenario-2-second', secondMode)

  await expectComposerIdleReady(appPage, chatInput)
  expect(dialogs).toHaveLength(0)
})

test('Scenario 3 — end-to-end wake journey (observability probe, not a latency gate)', async ({
  appPage,
}, testInfo) => {
  test.setTimeout(360_000)

  // Attach the dialog listener BEFORE the send.
  const dialogs: string[] = []
  appPage.on('dialog', dialog => {
    dialogs.push(dialog.message())
    void dialog.dismiss()
  })

  await openStatelessAgent(appPage)
  requireSuspendPrecondition()

  const chatInput = appPage.getByTestId('chat-input')
  const sendButton = appPage.getByRole('button', { name: /send message/i })

  const marker = `WAKE_S3_${Date.now()}`
  const prompt = `Reply with exactly: ${marker}`
  await chatInput.fill(prompt)

  // t0 = the user's send click. All timings are measured from this instant,
  // mirroring what a human perceives.
  //
  // NOTE: these timings are an OBSERVABILITY PROBE, not a latency gate. A wake
  // turn is ~99% LLM-provider latency (cold pod start + a full model turn), so
  // a hard time budget would flake on provider variance. We emit the numbers
  // for trend-watching (log line + report attachment) and only hard-assert the
  // ORDERING and the business/UI signals below.
  const t0 = Date.now()
  await sendButton.click()

  // (1) send -> waking-state visible, IF it appears. Absent on the warm branch
  // BY DESIGN (a 200 arrives, waking-state never renders). This watcher records
  // its own timestamp and resolves silently on the warm branch — it is a
  // conditional observation, not an error being masked. It is bounded by the
  // same deadline as the journey and intentionally not awaited; the load-bearing
  // waits are resolveWakeOutcome's hard-failing assertions.
  const wakingState = appPage.getByTestId('waking-state')
  let sendToWakingVisibleMs: number | null = null
  void wakingState.waitFor({ state: 'visible', timeout: WAKE_VISIBLE_TIMEOUT }).then(
    () => {
      sendToWakingVisibleMs = Date.now() - t0
    },
    () => {
      // waking-state never rendered inside the bound: warm-host journey.
    }
  )

  // UI signal — the user's message lands in the thread (web-first, bounded).
  await expect(appPage.getByTestId('message-list').getByText(prompt).first()).toBeVisible({
    timeout: 30_000,
  })

  // Resolve the branch and (on the failed branch) drive the manual retry, then
  // assert the marker reply. This is the load-bearing, hard-failing wait.
  const mode = await resolveWakeOutcome(appPage, marker)
  const sendToFirstContentMs = Date.now() - t0

  // (3) send -> response complete: the composer returns to its idle state,
  // which is the moment the user can act again. Hard-bounded.
  await expectComposerIdleReady(appPage, chatInput)
  const sendToCompleteMs = Date.now() - t0
  await chatInput.fill('Recovered after wake')
  await expect(sendButton).toBeEnabled()

  // Error-toast policy is branch-specific. Error toasts auto-dismiss after
  // ERROR_TOAST_DURATION_MS (6s), so an end-of-journey snapshot check is
  // defeated by timing and would be vacuous — we do NOT make that claim here.
  //   * warm branch: the controller pushes no error toast, so any error toast
  //     appearing WOULD be a real regression. We cannot reliably catch a
  //     6s-lived toast at the end, so instead we assert the failed-send error
  //     REGION never rendered at all across the resolved journey — a durable
  //     signal (it stays until dismissed/retried), unlike the toast.
  //   * cold branch: an error toast ("Agent is waking up — message not sent
  //     yet.") is expected and correct, so no "no error toast" claim applies.
  if (mode === 'warm') {
    await expect(appPage.getByTestId('waking-state')).toHaveCount(0)
  }

  expect(dialogs).toHaveLength(0)

  // Sanity on the measured ordering: content cannot render after "complete".
  expect(sendToFirstContentMs).toBeGreaterThan(0)
  expect(sendToCompleteMs).toBeGreaterThanOrEqual(sendToFirstContentMs)

  const journey = {
    scenario: 'scenario-3',
    marker,
    host_ref: HOST_REF,
    mode,
    send_to_waking_visible_ms: sendToWakingVisibleMs,
    send_to_first_content_ms: sendToFirstContentMs,
    send_to_complete_ms: sendToCompleteMs,
  }
  // Machine-parseable line for log scrapers + a structured attachment for the
  // Playwright report. Observational only (see the probe note above).
  console.log(`[StatelessWakeJourney] ${JSON.stringify(journey)}`)
  await testInfo.attach('stateless-wake-journey', {
    body: JSON.stringify(journey, null, 2),
    contentType: 'application/json',
  })
})
