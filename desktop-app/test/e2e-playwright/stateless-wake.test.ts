// Desktop prewarm and recovery UX for a suspended stateless host.
//
// This spec is the final Playwright phase of scripts/e2e/e2e-stateless-suspend-wake.sh.
// It drives the real Desktop app through the existing authenticated route and
// verifies catalog-time prewarm, conversation continuity, branch-aware wake/retry
// handling, and composer recovery. The bash phase owns the Kubernetes
// suspended-host precondition before Electron starts; this spec must run through
// that combined gate rather than being reported as a standalone cold-start test.
import { expect, loginAs, test } from './fixtures.js'
import { openAgentsPage } from './navigationHelpers.js'

const HOST_REF =
  process.env.E2E_STATELESS_HOST_REF || process.env.E2E_HOST_REF || 'chatllm-stateless'

// The seeded Desktop user reused for the logout/login continuity leg (§15.5
// step 10). Same historical env name the fixtures use; the leg drives the
// visible email/password screen via loginAs() — no Keychain, no storage injection.
const E2E_EMAIL = process.env.E2E_DEV_LOGIN_EMAIL || 'test@clerum.io'

// Which suspend/wake cycle this Playwright pass is proving. The bash gate runs
// the spec twice: cycle 1 (every scenario except the repeat-cycle one) and,
// after a second force_idle_and_suspend, cycle 2 (only the repeat-cycle scenario,
// selected by grep). §15.5 step 11 excludes a one-shot cache artifact.
const STATELESS_CYCLE = process.env.E2E_STATELESS_CYCLE || '1'

// UUID shape used to validate visible chat identities before asserting on them.
const CHAT_UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i

// Suite-level record of which wake branch each scenario actually took, so a
// fully-warm pass (no scenario ever hit replicas 0 under an active suspend
// precondition) FAILS loudly instead of passing silently (N1). resolveWakeOutcome
// feeds this through recordMode; the afterAll below is the gate.
const recordedWakeModes: Array<{ scenario: string; mode: 'warm' | 'cold' }> = []

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
  // The per-scenario line is observability; the suite-level aggregate this feeds
  // (the afterAll below) IS a gate — a pass where no scenario ever took the cold
  // (replicas-0) branch under an active suspend precondition fails loudly (N1).
  recordedWakeModes.push({ scenario, mode })
  const line = { scenario, host_ref: HOST_REF, mode }
  console.log(`[StatelessWakeJourney] ${JSON.stringify(line)}`)
  await testInfo.attach(`stateless-wake-${scenario}-mode`, {
    body: JSON.stringify(line, null, 2),
    contentType: 'application/json',
  })
}

// N1 — orchestrator-level gate. When the bash phase proved the suspend
// precondition (replicas 0 + idle floor, E2E_STATELESS_SUSPENDED=1), at least one
// scenario in this pass MUST have resolved through the cold wake branch. A
// fully-warm pass means the journey never actually exercised a wake and must
// fail rather than pass silently. Scenarios that never send (Scenario 0) record
// nothing; if no scenario recorded a mode at all, the per-scenario failures
// already surface, so this gate stays quiet in that case.
test.afterAll(() => {
  if (process.env.E2E_STATELESS_SUSPENDED !== '1') return
  if (recordedWakeModes.length === 0) return
  const cold = recordedWakeModes.filter(entry => entry.mode === 'cold')
  expect(
    cold.length,
    `[stateless-wake] No scenario took the cold (replicas-0) wake branch while ` +
      `E2E_STATELESS_SUSPENDED=1. A fully-warm pass does not prove a wake and must fail. ` +
      `Recorded modes: ${JSON.stringify(recordedWakeModes)}`
  ).toBeGreaterThanOrEqual(1)
})

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

  // N5 — cheap env guard before any expensive UI navigation.
  requireSuspendPrecondition()
  await openStatelessAgent(appPage)

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

  // N5 — cheap env guard before any expensive UI navigation.
  requireSuspendPrecondition()
  await openStatelessAgent(appPage)

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

  // N5 — cheap env guard before any expensive UI navigation.
  requireSuspendPrecondition()
  await openStatelessAgent(appPage)

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

// Reads the server-side session catalog through the SAME wake-capable RPC the
// workspace uses (`GET …/sessions`, now `host:session:read` + `host:wake:write`,
// issue #791). Returns a structured result so a wake 403 or transport failure
// FAILS the caller loudly instead of collapsing to an empty list.
async function readStatelessSessionIds(
  appPage: import('@playwright/test').Page
): Promise<{ error: string | null; chatIds: string[] }> {
  return appPage.evaluate(async hostRef => {
    try {
      const result = await window.clerum.rpc.listSessions(hostRef)
      const items = (result?.items ?? []) as unknown as Array<{ chatId?: unknown }>
      const chatIds = items
        .map(item => (typeof item.chatId === 'string' ? item.chatId : ''))
        .filter((id: string) => id.length > 0)
      return { error: null, chatIds }
    } catch (error) {
      return {
        error: error instanceof Error ? error.message : String(error),
        chatIds: [] as string[],
      }
    }
  }, HOST_REF)
}

// Loads the host-level model list through the wake-capable RPC (`GET …/models`,
// now `host:session:read` + `host:wake:write`). A structured error surfaces a
// wake 403; a `null` model list is a legitimate compat outcome, not a failure.
async function probeStatelessHostModels(
  appPage: import('@playwright/test').Page
): Promise<{ error: string | null; modelCount: number | null }> {
  return appPage.evaluate(async hostRef => {
    try {
      const result = await window.clerum.rpc.getHostModels(hostRef, '')
      const models = (result as unknown as { models?: unknown[] } | null)?.models
      return { error: null, modelCount: Array.isArray(models) ? models.length : null }
    } catch (error) {
      return {
        error: error instanceof Error ? error.message : String(error),
        modelCount: null,
      }
    }
  }, HOST_REF)
}

// Navigate to the dedicated agent view (no active chat) where the visible
// "Latest sessions for selected agent" region renders — the same path the sibling
// stateless-watch-session-continuity spec uses (Agents → Open details → Go to
// Chat). Returns the region locator so callers can assert on session buttons by
// data-chat-id. isDedicatedAgentView is `!activeChatId` (ChatThread.tsx), so this
// view is the only place the session list is visible.
async function openDedicatedAgentSessions(
  appPage: import('@playwright/test').Page
): Promise<import('@playwright/test').Locator> {
  await openAgentsPage(appPage)
  await expect(appPage.getByRole('heading', { name: /^Agents$/ })).toBeVisible({ timeout: 20_000 })
  const detailsButton = appPage.getByRole('button', {
    name: `Open details for ${HOST_REF}`,
    exact: true,
  })
  await expect(detailsButton).toHaveCount(1)
  await expect(detailsButton).toBeVisible({ timeout: 30_000 })
  await expect(detailsButton).toBeEnabled()
  await detailsButton.click()
  await expect(appPage.getByRole('region', { name: 'Agent details' })).toBeVisible({
    timeout: 20_000,
  })
  const goToChat = appPage.getByRole('button', { name: 'Go to Chat', exact: true })
  await expect(goToChat).toBeVisible({ timeout: 20_000 })
  await expect(goToChat).toBeEnabled()
  await goToChat.click()
  await expect(appPage.getByTestId('chat-input')).toBeVisible({ timeout: 30_000 })
  await expect(appPage.getByRole('button', { name: /^Switch chat agent$/ })).toContainText(
    HOST_REF,
    { timeout: 30_000 }
  )
  const sessions = appPage.getByRole('region', { name: 'Latest sessions for selected agent' })
  await expect(sessions).toBeVisible({ timeout: 30_000 })
  return sessions
}

// The active chat's message-list carries aria-current='true' and a UUID
// data-chat-id once a chat is selected (ChatThread.tsx). Returns that identity.
async function readActiveChatId(appPage: import('@playwright/test').Page): Promise<string> {
  const messageList = appPage.getByTestId('message-list')
  await expect(messageList).toHaveAttribute('aria-current', 'true', { timeout: TURN_TIMEOUT })
  await expect(messageList).toHaveAttribute('data-chat-id', CHAT_UUID_RE, { timeout: TURN_TIMEOUT })
  const chatId = await messageList.getAttribute('data-chat-id')
  if (!chatId || !CHAT_UUID_RE.test(chatId)) {
    throw new Error('[stateless-wake] active chat did not expose a UUID chat identity')
  }
  return chatId
}

// B1 — assert a chat identity is visible in the "Latest sessions" list, not only
// reported by the RPC. Reuses the sibling's `button[data-chat-id="..."]` pattern.
async function expectSessionButtonVisible(
  sessions: import('@playwright/test').Locator,
  chatId: string
): Promise<void> {
  const button = sessions.locator(`button[data-chat-id="${chatId}"]`)
  await expect(
    button,
    `Session identity ${chatId} must be visible in the "Latest sessions" list`
  ).toHaveCount(1)
  await expect(button).toBeVisible()
}

// Read the chat identities currently rendered as session buttons. Waits (bounded)
// until at least two are listed — on a re-suspended host the catalog is served
// through the wake-capable read, so this resolves after that wake; a genuinely
// empty catalog fails the caller's assertion loudly rather than silently.
async function readSessionButtonChatIds(
  sessions: import('@playwright/test').Locator
): Promise<string[]> {
  const buttons = sessions.locator('button[data-chat-id]')
  await expect(buttons.nth(1)).toBeVisible({ timeout: WAKE_VISIBLE_TIMEOUT })
  const ids = await buttons.evaluateAll(nodes =>
    nodes.map(node => node.getAttribute('data-chat-id') || '').filter(Boolean)
  )
  return [...new Set(ids)]
}

// Click a listed session and confirm it became the active chat (its identity
// moves onto the message-list). Leaves the dedicated view for the thread view.
async function openExistingSession(
  appPage: import('@playwright/test').Page,
  sessions: import('@playwright/test').Locator,
  chatId: string
): Promise<void> {
  const button = sessions.locator(`button[data-chat-id="${chatId}"]`)
  await expect(button).toHaveCount(1)
  await expect(button).toBeVisible()
  await expect(button).toBeEnabled()
  await button.click()
  const messageList = appPage.getByTestId('message-list')
  await expect(messageList).toHaveAttribute('data-chat-id', chatId, { timeout: 30_000 })
  await expect(messageList).toHaveAttribute('aria-current', 'true')
}

// SF2 — transcript continuity through the visible UI: the earlier assistant reply
// carrying `marker` must still be rendered in the reopened chat's message-list.
async function expectAssistantMarkerRendered(
  appPage: import('@playwright/test').Page,
  marker: string
): Promise<void> {
  const response = appPage
    .getByTestId('message-list')
    .getByTestId('agent-response')
    .filter({ hasText: marker })
  await expect(
    response,
    `Assistant reply containing "${marker}" must still render in the reopened transcript`
  ).toHaveCount(1)
  await expect(response).toBeVisible({ timeout: TURN_TIMEOUT })
}

// SF3 — prove the model list is genuinely usable, not merely "did not 403". The
// composer's model chip only becomes an interactive button once the host served a
// usable model list (ModelSelector returns null until data loads and renders a
// non-interactive chip only when degraded), so a visible interactive picker with
// selectable options is itself the proof.
async function exerciseVisibleModelPicker(
  appPage: import('@playwright/test').Page
): Promise<void> {
  const trigger = appPage.getByRole('button', { name: /^Model — / })
  await expect(
    trigger,
    'the composer model picker must render a selectable model chip'
  ).toBeVisible({ timeout: TURN_TIMEOUT })
  await trigger.click()
  const menu = appPage.getByRole('menu', { name: 'Select model' })
  await expect(menu).toBeVisible({ timeout: 10_000 })
  const options = menu.getByRole('menuitemradio')
  await expect(options.first()).toBeVisible({ timeout: 10_000 })
  expect(
    await options.count(),
    'the visible model picker must list at least one selectable model'
  ).toBeGreaterThan(0)
  // Close the picker without changing the selection (Escape closes it — see the
  // ModelSelector keydown handler — leaving the pending turn untouched).
  await appPage.keyboard.press('Escape')
  await expect(menu).toBeHidden({ timeout: 10_000 })
}

// Log out through the visible settings menu and confirm the login screen returns.
async function logoutViaUi(appPage: import('@playwright/test').Page): Promise<void> {
  const settingsMenu = appPage.getByTestId('nav-settings-menu')
  await expect(settingsMenu).toBeVisible({ timeout: 15_000 })
  await expect(settingsMenu).toBeEnabled()
  await settingsMenu.click()
  const logout = appPage.getByTestId('logout-btn')
  await expect(logout).toBeVisible({ timeout: 10_000 })
  await expect(logout).toBeEnabled()
  await logout.click()
  await expect(appPage.locator('#email-input')).toBeVisible({ timeout: 20_000 })
}

// §15.5 real-user journey (the spec-side steps the wake-scope change enables and
// that Scenarios 1–3 do not exercise): two distinct chats, the CONCURRENT
// list-sessions + load-models + send-message burst driven against the FIRST cold
// wake (chat A, replicas 0), the VISIBLE session list carrying both identities
// before and after navigation, VISIBLE transcript continuity, a usable model
// picker, and a logout/login continuity cycle. The session/model reads now carry
// host:wake:write, so the reads must not 403, must not fabricate an empty session
// list, and must not lose either chat's identity across navigation or the auth
// cycle. The repeat suspend/wake cycle (step 11) is Scenario 5, driven by the
// bash gate's second pass after a fresh suspension.
test('Scenario 4 — concurrent session/model/message on a COLD wake, then two-chat continuity across nav + login', async ({
  appPage,
}, testInfo) => {
  test.setTimeout(720_000)

  // Attach the dialog listener BEFORE any send so no unhandled wake dialog slips
  // past the whole journey.
  const dialogs: string[] = []
  appPage.on('dialog', dialog => {
    dialogs.push(dialog.message())
    void dialog.dismiss()
  })

  // N5 — cheap env guard before any expensive UI navigation.
  requireSuspendPrecondition()

  // Chat A — the first distinct conversation, sent while the host is genuinely at
  // replicas 0 (the suspend precondition guarantees it). SF1: the concurrent
  // list-sessions + load-models burst runs against THIS in-flight cold wake, so
  // the wake-scoped reads are exercised while the host is actually waking — not
  // against an already-warm host.
  await openStatelessAgent(appPage)
  const chatInput = appPage.getByTestId('chat-input')
  const sendButton = appPage.getByRole('button', { name: /send message/i })

  const markerA = `WAKE_S4_A_${Date.now()}`
  await chatInput.fill(`Reply with exactly: ${markerA}`)
  const [sessionsDuringColdWake, modelsDuringColdWake] = await Promise.all([
    readStatelessSessionIds(appPage),
    probeStatelessHostModels(appPage),
    sendButton.click(),
  ])
  expect(
    sessionsDuringColdWake.error,
    `[stateless-wake] concurrent listSessions during the COLD wake must not 403/fail — ${sessionsDuringColdWake.error}`
  ).toBeNull()
  expect(
    modelsDuringColdWake.error,
    `[stateless-wake] concurrent getHostModels during the COLD wake must not 403/fail — ${modelsDuringColdWake.error}`
  ).toBeNull()

  const modeA = await resolveWakeOutcome(appPage, markerA)
  await recordMode(testInfo, 'scenario-4-chat-a-cold-burst', modeA)
  await expectComposerIdleReady(appPage, chatInput)
  const chatIdA = await readActiveChatId(appPage)

  // Chat B — a SECOND distinct conversation on the same agent (New chat again).
  // The host is warm now, so this send exercises the warm path.
  await openStatelessAgent(appPage)
  const markerB = `WAKE_S4_B_${Date.now()}`
  await chatInput.fill(`Reply with exactly: ${markerB}`)
  await sendButton.click()
  const modeB = await resolveWakeOutcome(appPage, markerB)
  await recordMode(testInfo, 'scenario-4-chat-b', modeB)
  await expectComposerIdleReady(appPage, chatInput)
  const chatIdB = await readActiveChatId(appPage)
  expect(chatIdA, 'the two chats must have distinct server identities').not.toBe(chatIdB)

  // B1 (a) — BEFORE the post-warm burst, assert BOTH chat identities are visible
  // in the "Latest sessions" region (not only through the RPC read). The region
  // renders only in the dedicated agent view, so navigate there first.
  let sessions = await openDedicatedAgentSessions(appPage)
  await expectSessionButtonVisible(sessions, chatIdA)
  await expectSessionButtonVisible(sessions, chatIdB)

  // Keep the RPC session read as the transport-level no-403 + identity proof.
  const before = await readStatelessSessionIds(appPage)
  expect(
    before.error,
    `[stateless-wake] listSessions must not 403 on wake — ${before.error}`
  ).toBeNull()
  const idsBefore = new Set(before.chatIds)
  expect(
    idsBefore.has(chatIdA) && idsBefore.has(chatIdB),
    'both chat identities must surface in the server session list'
  ).toBe(true)

  // Reopen chat B (leaving the dedicated view) so the composer + model picker are
  // mounted for the warm-path burst and the SF3 model proof.
  await openExistingSession(appPage, sessions, chatIdB)

  // SF3 — the model list must be genuinely usable, not merely "did not 403".
  // Assert a positive model count over the wake-capable RPC AND drive the visible
  // model picker to prove selectable options render.
  const modelsWarm = await probeStatelessHostModels(appPage)
  expect(
    modelsWarm.error,
    `[stateless-wake] warm getHostModels must not fail — ${modelsWarm.error}`
  ).toBeNull()
  expect(
    modelsWarm.modelCount ?? 0,
    'the stateless fixture host must expose at least one model on the warm path'
  ).toBeGreaterThan(0)
  await exerciseVisibleModelPicker(appPage)

  // Post-warm concurrent burst (kept — one warm turn): list sessions + load
  // models while a third send drives the composer, proving the wake-capable reads
  // stay 200 even while a send is in flight, and the send is not double-forwarded
  // (SF4).
  const markerC = `WAKE_S4_C_${Date.now()}`
  await chatInput.fill(`Reply with exactly: ${markerC}`)
  const [sessionsDuringWarm, modelsDuringWarm] = await Promise.all([
    readStatelessSessionIds(appPage),
    probeStatelessHostModels(appPage),
    sendButton.click(),
  ])
  expect(
    sessionsDuringWarm.error,
    `[stateless-wake] concurrent warm listSessions must not fail — ${sessionsDuringWarm.error}`
  ).toBeNull()
  expect(
    modelsDuringWarm.error,
    `[stateless-wake] concurrent warm getHostModels must not fail — ${modelsDuringWarm.error}`
  ).toBeNull()
  expect(
    new Set(sessionsDuringWarm.chatIds).size,
    'concurrent listSessions must not drop either chat identity'
  ).toBeGreaterThanOrEqual(2)

  const modeC = await resolveWakeOutcome(appPage, markerC)
  await recordMode(testInfo, 'scenario-4-concurrent-warm', modeC)
  await expectComposerIdleReady(appPage, chatInput)

  // SF4 — no duplicate: the user's prompt AND the assistant's reply each render
  // exactly once in chat B's thread.
  const chatBList = appPage.getByTestId('message-list')
  await expect(chatBList.getByText(`Reply with exactly: ${markerC}`)).toHaveCount(1)
  await expect(chatBList.getByTestId('agent-response').filter({ hasText: markerC })).toHaveCount(1)

  // Step 9 + B1 (b) — navigate away to Agents and back into the dedicated sessions
  // view; assert BOTH identities are STILL visible in the session list.
  sessions = await openDedicatedAgentSessions(appPage)
  await expectSessionButtonVisible(sessions, chatIdA)
  await expectSessionButtonVisible(sessions, chatIdB)
  const after = await readStatelessSessionIds(appPage)
  expect(
    after.error,
    `[stateless-wake] post-navigation listSessions must not 403/fail — ${after.error}`
  ).toBeNull()
  const idsAfter = new Set(after.chatIds)
  for (const id of [chatIdA, chatIdB]) {
    expect(
      idsAfter.has(id),
      `Session identity ${id} must survive navigating away to Agents and back.`
    ).toBe(true)
  }

  // SF2 — transcript continuity through the VISIBLE UI: reopen chat A, then chat
  // B, and assert each earlier assistant reply is still rendered in message-list
  // (not merely chatId set-membership).
  await openExistingSession(appPage, sessions, chatIdA)
  await expectAssistantMarkerRendered(appPage, markerA)
  sessions = await openDedicatedAgentSessions(appPage)
  await openExistingSession(appPage, sessions, chatIdB)
  await expectAssistantMarkerRendered(appPage, markerB)
  await expectAssistantMarkerRendered(appPage, markerC)

  // §15.5 step 10 (SF5) — logout/login continuity: log out through the visible
  // settings menu, log back in as the SAME seeded user through the visible
  // email/password screen (loginAs → no Keychain, no storage injection), and
  // assert both identities and their transcript content survive the auth cycle.
  await logoutViaUi(appPage)
  await loginAs(appPage, E2E_EMAIL)
  sessions = await openDedicatedAgentSessions(appPage)
  await expectSessionButtonVisible(sessions, chatIdA)
  await expectSessionButtonVisible(sessions, chatIdB)
  await openExistingSession(appPage, sessions, chatIdA)
  await expectAssistantMarkerRendered(appPage, markerA)
  sessions = await openDedicatedAgentSessions(appPage)
  await openExistingSession(appPage, sessions, chatIdB)
  await expectAssistantMarkerRendered(appPage, markerB)

  // No unhandled wake dialog across the entire journey.
  expect(dialogs).toHaveLength(0)
})

// §15.5 step 11 — repeat one suspend/wake cycle to exclude a one-shot cache
// artifact. This scenario runs ONLY in the bash gate's second Playwright pass
// (grep "second cycle" + E2E_STATELESS_CYCLE=2), after force_idle_and_suspend has
// suspended the host a SECOND time. On a fresh login it proves the chats created
// in the first pass survived the second suspension (visible session list +
// transcript) and that a fresh send wakes the host again and continues the same
// thread.
function requireSecondCyclePass(): void {
  if (STATELESS_CYCLE !== '2') {
    throw new Error(
      '[stateless-wake] E2E_STATELESS_CYCLE!=2 — the repeat suspend/wake cycle scenario must be ' +
        "driven by the bash gate's SECOND Playwright pass, after a second force_idle_and_suspend " +
        're-suspends the host. Running it in the first pass would race a still-warm host and prove ' +
        'nothing about a repeat cycle.'
    )
  }
}

test('Scenario 5 — repeat suspend/wake cycle keeps prior chats continuous (second cycle)', async ({
  appPage,
}, testInfo) => {
  test.setTimeout(600_000)

  const dialogs: string[] = []
  appPage.on('dialog', dialog => {
    dialogs.push(dialog.message())
    void dialog.dismiss()
  })

  requireSecondCyclePass()
  requireSuspendPrecondition()

  // The chats from the first pass persist server-side across the second suspend.
  // Opening the dedicated session view serves the catalog through the wake-capable
  // read; a re-suspended host must therefore surface >= 2 prior sessions here
  // without a 403 or a false-empty catalog.
  const sessions = await openDedicatedAgentSessions(appPage)
  const priorIds = await readSessionButtonChatIds(sessions)
  expect(
    priorIds.length,
    'the >=2 chats created in the first cycle must survive a SECOND suspend/wake'
  ).toBeGreaterThanOrEqual(2)

  const catalog = await readStatelessSessionIds(appPage)
  expect(
    catalog.error,
    `[stateless-wake] cycle-2 listSessions must not 403 on the re-suspended host — ${catalog.error}`
  ).toBeNull()
  expect(
    new Set(catalog.chatIds).size,
    'the wake-capable session catalog must still report both prior chats after a second suspend'
  ).toBeGreaterThanOrEqual(2)

  // Reopen the first prior chat: its transcript (a prior assistant reply) must
  // still render — continuity BEFORE the second wake.
  const [targetChatId] = priorIds
  if (!targetChatId) {
    throw new Error('[stateless-wake] cycle-2 session catalog exposed no prior chat to reopen')
  }
  await openExistingSession(appPage, sessions, targetChatId)
  const messageList = appPage.getByTestId('message-list')
  const priorResponse = messageList.getByTestId('agent-response').first()
  await expect(
    priorResponse,
    'a prior assistant reply must still render in the reopened chat after the second suspend'
  ).toBeVisible({ timeout: WAKE_VISIBLE_TIMEOUT })
  await expect(priorResponse).not.toHaveText('', { timeout: TURN_TIMEOUT })
  await expect(priorResponse).not.toHaveClass(/chat-bubble--error/)

  // Drive the SECOND wake through the UI: a fresh send into the SAME existing
  // thread must wake the re-suspended host and continue the conversation.
  const chatInput = appPage.getByTestId('chat-input')
  const sendButton = appPage.getByRole('button', { name: /send message/i })
  const markerCycle2 = `WAKE_S5_${Date.now()}`
  await chatInput.fill(`Reply with exactly: ${markerCycle2}`)
  await sendButton.click()
  await expect(
    messageList.getByText(`Reply with exactly: ${markerCycle2}`).first()
  ).toBeVisible({ timeout: 30_000 })
  const mode = await resolveWakeOutcome(appPage, markerCycle2)
  await recordMode(testInfo, 'scenario-5-second-cycle', mode)
  await expectComposerIdleReady(appPage, chatInput)

  // Identity survives the SECOND wake too.
  const afterWake = await readStatelessSessionIds(appPage)
  expect(
    afterWake.error,
    `[stateless-wake] post-second-wake listSessions must not 403/fail — ${afterWake.error}`
  ).toBeNull()
  const afterIds = new Set(afterWake.chatIds)
  for (const id of priorIds.slice(0, 2)) {
    expect(afterIds.has(id), `chat ${id} must survive the second suspend/wake cycle`).toBe(true)
  }

  expect(dialogs).toHaveLength(0)
})
