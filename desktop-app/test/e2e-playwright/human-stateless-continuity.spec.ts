import { type ElectronApplication, type Locator, type Page, expect, test } from '@playwright/test'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import {
  EXTERNAL_REST_API_BASE_URL,
  RPC_PROXY_BASE_URL,
  assertAllowedTarget,
  desktopCredentials,
  finalizeRecording,
  launchDesktopApp,
  login,
  openAgentsPage,
  requireRecorderConfirm,
  screenshotAndLog,
} from './qa-recorder-helpers'

const execFileAsync = promisify(execFile)

const KUBE_CONTEXT = process.env.HUMAN_E2E_KUBE_CONTEXT?.trim() || ''
const STATEFUL_HOST = process.env.HUMAN_E2E_STATEFUL_HOST?.trim() || 'chatLLM'
const STATELESS_HOST = process.env.HUMAN_E2E_STATELESS_HOST?.trim() || 'chatllm-stateless'
const STATEFUL_HOST_RESOURCE = process.env.HUMAN_E2E_STATEFUL_HOST_RESOURCE?.trim() || 'chatllm'
const STATELESS_HOST_RESOURCE =
  process.env.HUMAN_E2E_STATELESS_HOST_RESOURCE?.trim() || 'chatllm-stateless'
const HCC_DEPLOYMENT = 'host-context-controller'
const HCC_NAMESPACE = 'control-plane'
const STATELESS_NAMESPACE = 'mcp-host'
const STATELESS_DEPLOYMENT = 'chatllm-stateless'
const STATEFUL_DEPLOYMENT = 'chatllm'
const SUSPEND_TIMEOUT_MS = 240_000

// E2E_GUARDIAN_IPC_FLOW: Desktop sends RPC through Electron's main process.
// Renderer page.waitForResponse cannot observe those requests. The visible
// assistant response, known conversation marker, and Host CRD/pod state are
// the business signals for this recorded journey.

type HostSnapshot = {
  lifecycleState: string
  lifecycleReason: string
  replicas: number
  readyReplicas: number
  podNames: string[]
  imageIds: string[]
  pullPolicyRejection: string | null
}

type JourneyMetrics = {
  hcc_idle_minutes: number
  hcc_idle_floor_minutes: number
  hcc_drain_grace_ms: number
  hcc_heartbeat_poll_ms: number
  first_profile_path: string
  second_profile_path: string
  stateful_pod_before: string[]
  stateless_pod_before: string[]
  stateless_initial_lifecycle_state: string
  stateless_initial_lifecycle_reason: string
  stateless_image_ids_before: string[]
  stateless_image_ids_after_reopen: string[]
  stateless_image_ids_after_cold_send: string[]
  stateless_pull_policy_warning: string | null
  first_close_ms: number | null
  first_suspend_ms: number
  second_launch_to_window_ms: number
  second_launch_to_authenticated_ms: number
  second_launch_to_stateless_ready_ms: number
  draft_preserved_while_switching_hosts: boolean
  draft_preserved_across_restart: boolean
  second_suspend_ms: number
  cold_send_to_waking_visible_ms: number | null
  cold_send_pre_click_ready_replicas: number
  cold_send_first_outcome: 'response' | 'waking' | null
  cold_send_to_user_message_visible_ms: number | null
  cold_send_to_task_acknowledged_ms: number | null
  cold_send_to_ready_observed_ms: number | null
  cold_send_to_response_ms: number
  cold_send_to_composer_idle_ms: number
  cold_send_retries: number
  initial_stateless_send_retries: number
  stateless_pod_after_cold_send: string[]
  stateful_pod_after: string[]
  markers: {
    stateful_initial: string
    stateless_initial: string
    stateless_follow_up: string
    stateful_follow_up: string
  }
}

async function kubectl(args: string[], timeoutMs = 20_000): Promise<string> {
  const { stdout } = await execFileAsync('kubectl', ['--context', KUBE_CONTEXT, ...args], {
    timeout: timeoutMs,
    maxBuffer: 8 * 1024 * 1024,
  })
  return stdout.toString()
}

async function jsonKubectl(resource: string, namespace: string): Promise<any> {
  return JSON.parse(await kubectl(['-n', namespace, 'get', resource, '-o', 'json']))
}

async function readHostSnapshot(deployment: string, hostName: string): Promise<HostSnapshot> {
  const [deploymentJson, hostJson, podsJson] = await Promise.all([
    jsonKubectl(`deployment.apps/${deployment}`, STATELESS_NAMESPACE),
    jsonKubectl(`host/${hostName}`, STATELESS_NAMESPACE),
    kubectl(['-n', STATELESS_NAMESPACE, 'get', 'pods', '-l', `app=${hostName}`, '-o', 'json']),
  ])
  const pods = JSON.parse(podsJson).items ?? []
  const spec = deploymentJson.spec ?? {}
  const status = deploymentJson.status ?? {}
  const lifecycle = hostJson.status?.lifecycle ?? {}
  const pullPolicyRejection = (hostJson.status?.conditions ?? []).find(
    (condition: { type?: string; status?: string }) =>
      condition.type === 'StatelessPullPolicyRejected' && condition.status === 'True'
  )
  return {
    lifecycleState: String(lifecycle.state ?? ''),
    lifecycleReason: String(lifecycle.reason ?? ''),
    replicas: Number(spec.replicas ?? -1),
    readyReplicas: Number(status.readyReplicas ?? 0),
    podNames: pods
      .map((pod: { metadata?: { name?: string } }) => pod.metadata?.name)
      .filter(Boolean)
      .sort(),
    imageIds: [
      ...new Set<string>(
        pods.flatMap((pod: { status?: { containerStatuses?: Array<{ imageID?: string }> } }) =>
          (pod.status?.containerStatuses ?? [])
            .map(container => container.imageID)
            .filter((id): id is string => typeof id === 'string' && id.length > 0)
        )
      ),
    ].sort(),
    pullPolicyRejection: pullPolicyRejection?.reason ?? null,
  }
}

async function waitForStatelessSuspended(timeoutMs: number): Promise<{
  snapshot: HostSnapshot
  elapsedMs: number
}> {
  const started = Date.now()
  let last = await readHostSnapshot(STATELESS_DEPLOYMENT, STATELESS_HOST_RESOURCE)
  while (Date.now() - started < timeoutMs) {
    last = await readHostSnapshot(STATELESS_DEPLOYMENT, STATELESS_HOST_RESOURCE)
    if (
      last.lifecycleState === 'suspended' &&
      last.replicas === 0 &&
      last.readyReplicas === 0 &&
      last.podNames.length === 0
    ) {
      expect(last.lifecycleReason, 'stateless suspension must be caused by idle timeout').toBe(
        'idle'
      )
      return { snapshot: last, elapsedMs: Date.now() - started }
    }
    await new Promise(resolve => setTimeout(resolve, 5_000))
  }
  throw new Error(
    `Stateless host did not reach verified replicas-0 suspension: ${JSON.stringify(last)}`
  )
}

async function waitForStatelessReady(timeoutMs: number): Promise<{
  snapshot: HostSnapshot
  elapsedMs: number
}> {
  const started = Date.now()
  let last = await readHostSnapshot(STATELESS_DEPLOYMENT, STATELESS_HOST_RESOURCE)
  while (Date.now() - started < timeoutMs) {
    last = await readHostSnapshot(STATELESS_DEPLOYMENT, STATELESS_HOST_RESOURCE)
    if (last.replicas >= 1 && last.readyReplicas >= 1 && last.podNames.length > 0) {
      return { snapshot: last, elapsedMs: Date.now() - started }
    }
    await new Promise(resolve => setTimeout(resolve, 2_000))
  }
  throw new Error(`Stateless host did not become Ready: ${JSON.stringify(last)}`)
}

async function readHccCadences(): Promise<{
  idleMinutes: number
  idleFloorMinutes: number
  drainGraceMs: number
  heartbeatPollMs: number
}> {
  const deployment = await jsonKubectl(`deployment.apps/${HCC_DEPLOYMENT}`, HCC_NAMESPACE)
  const env = deployment.spec?.template?.spec?.containers?.[0]?.env ?? []
  const value = (key: string, fallback: number): number => {
    const found = env.find((item: { name?: string }) => item.name === key)
    return typeof found?.value === 'string' ? Number(found.value) : fallback
  }
  return {
    idleMinutes: value('CONTEXT_MAPPER_STATELESS_IDLE_MINUTES', 30),
    idleFloorMinutes: value('CONTEXT_MAPPER_STATELESS_IDLE_FLOOR_MINUTES', 15),
    drainGraceMs: value('CONTEXT_MAPPER_STATELESS_DRAIN_GRACE_MS', 60_000),
    heartbeatPollMs: value('CONTEXT_MAPPER_HEARTBEAT_POLL_MS', 10_000),
  }
}

async function desktopProfilePath(app: ElectronApplication): Promise<string> {
  return app.evaluate(({ app: electronApp }) => electronApp.getPath('userData'))
}

async function newChatFromAgentsPage(page: Page, hostName: string): Promise<void> {
  await openAgentsPage(page)
  await page.getByRole('button', { name: `More actions for ${hostName}`, exact: true }).click()
  const menu = page.getByRole('menu')
  await expect(menu).toBeVisible({ timeout: 15_000 })
  const newChat = menu
    .getByRole('button', { name: /^New chat$/ })
    .or(menu.getByRole('menuitem', { name: /^New chat$/ }))
  await expect(newChat).toBeVisible()
  await newChat.click()
  const composer = page.getByRole('textbox', { name: 'Agent message composer' })
  await expect(composer).toBeVisible({ timeout: 30_000 })
  await expect(page.getByRole('button', { name: /^Switch chat agent$/ })).toContainText(hostName, {
    timeout: 30_000,
  })
}

async function openExactSession(page: Page, title: string, hostName: string): Promise<void> {
  await page.getByRole('button', { name: `Open ${title}`, exact: true }).click()
  const composer = page.getByRole('textbox', { name: 'Agent message composer' })
  await expect(composer).toBeVisible({ timeout: 30_000 })
  await expect(page.getByRole('button', { name: /^Switch chat agent$/ })).toContainText(hostName, {
    timeout: 30_000,
  })
}

async function renameSessionByMarker(page: Page, marker: string, title: string): Promise<void> {
  await expect(page.getByTestId('agent-response').filter({ hasText: marker })).toBeVisible()
  const row = page.locator('.nav-latest-session.active')
  await expect(row).toBeVisible({ timeout: 30_000 })
  const options = row.getByRole('button', { name: /^Session options for / })
  await options.click()
  await page.getByRole('menuitem', { name: 'Rename', exact: true }).click()
  const input = page.getByRole('textbox', { name: 'Rename session', exact: true })
  await expect(input).toBeVisible()
  await input.fill(title)
  await input.press('Enter')
  await expect(page.getByRole('button', { name: `Open ${title}`, exact: true })).toBeVisible({
    timeout: 30_000,
  })
}

async function humanType(locator: Locator, text: string): Promise<void> {
  await locator.fill('')
  await locator.pressSequentially(text, { delay: 90 })
}

async function sendMarker(page: Page, marker: string, prompt: string): Promise<void> {
  const composer = page.getByRole('textbox', { name: 'Agent message composer' })
  const response = page.getByTestId('agent-response').filter({ hasText: marker })
  await humanType(composer, prompt)
  await expect(page.getByTestId('send-button')).toBeEnabled()
  await page.getByTestId('send-button').click()
  await expect(page.getByTestId('message-list')).toContainText(marker, { timeout: 30_000 })
  await expect(response).toBeVisible({ timeout: 150_000 })
  await expect(response).toContainText(marker, { timeout: 150_000 })
  await expect(composer).toHaveValue('', { timeout: 150_000 })
  await expect(page.getByTestId('send-button')).toHaveAttribute('aria-label', 'Send message', {
    timeout: 150_000,
  })
  await expect(page.getByTestId('send-button')).toBeDisabled({ timeout: 150_000 })
}

async function authenticatedWithoutRelogin(page: Page): Promise<void> {
  await expect(page.locator('.boot-overlay')).toBeHidden({ timeout: 30_000 })
  const emailInput = page.locator('#email-input')
  const authenticatedShell = page.getByTestId('nav-chat')
  await expect(authenticatedShell).toBeVisible({ timeout: 30_000 })
  await expect(emailInput).toBeHidden({ timeout: 30_000 })
}

async function resolveColdSend(
  page: Page,
  responseMarker: string,
  contextMarker: string
): Promise<{
  wakingVisibleMs: number | null
  retries: number
  firstOutcome: 'response' | 'waking'
}> {
  const started = Date.now()
  const response = page.getByTestId('agent-response').filter({ hasText: responseMarker })
  const waking = page.getByTestId('waking-state')
  let firstOutcome: 'response' | 'waking' | null = null
  await expect
    .poll(
      async () => {
        if (await response.isVisible()) return (firstOutcome = 'response')
        if (await waking.isVisible()) return (firstOutcome = 'waking')
        return null
      },
      { timeout: 270_000 }
    )
    .not.toBeNull()
  let wakingVisibleMs: number | null = null
  let retries = 0
  if (firstOutcome === null) {
    throw new Error('Cold send ended without an observable first outcome')
  }
  if (firstOutcome === 'waking') {
    wakingVisibleMs = Date.now() - started
    // The retry is a user action. Wait for the observed Host to become Ready
    // before taking it; a fast click can fail while the pod is still waking.
    await waitForStatelessReady(270_000)
    const retry = waking.getByRole('button', { name: /retry last send/i })
    await expect(retry).toBeEnabled({ timeout: 150_000 })
    await retry.click()
    retries += 1
  }
  await expect(response).toBeVisible({ timeout: 270_000 })
  await expect(response).toContainText(contextMarker, { timeout: 150_000 })
  return {
    wakingVisibleMs,
    retries,
    firstOutcome,
  }
}

async function closeElectron(app: ElectronApplication | undefined): Promise<number | null> {
  const child = app?.process()
  const pid = child?.pid ?? null
  await app?.close().catch(() => undefined)
  if (!child) return null
  const deadline = Date.now() + 30_000
  while (Date.now() < deadline && child.exitCode === null && child.signalCode === null) {
    await new Promise(resolve => setTimeout(resolve, 250))
  }
  expect(
    child.exitCode !== null || child.signalCode !== null,
    `Electron process ${pid ?? 'unknown'} must exit; window close alone is not app exit on macOS`
  ).toBe(true)
  return pid
}

test('human journey — two Hosts, restart, cache, and two verified stateless wake episodes', async ({}, testInfo) => {
  test.setTimeout(1_800_000)

  if (!KUBE_CONTEXT) {
    throw new Error('HUMAN_E2E_KUBE_CONTEXT is required for the recorded stateless journey.')
  }
  const setupContext =
    process.env.E2E_K8S_CONTEXT ||
    process.env.KUBECONTEXT ||
    process.env.K8S_CONTEXT ||
    'clerum-test'
  if (KUBE_CONTEXT !== setupContext) {
    throw new Error(
      `HUMAN_E2E_KUBE_CONTEXT must match the global-setup context: expected ${setupContext}, got ${KUBE_CONTEXT}.`
    )
  }
  requireRecorderConfirm(
    'QA_RECORDER_CONFIRM_CHAT',
    'This journey sends four real model turns and may incur model cost.'
  )

  await assertAllowedTarget('EXTERNAL_REST_API_BASE_URL', EXTERNAL_REST_API_BASE_URL)
  await assertAllowedTarget('RPC_PROXY_BASE_URL', RPC_PROXY_BASE_URL)

  const runId = `${Date.now()}-${Math.random().toString(16).slice(2, 8)}`
  const statefulTitle = `HUMAN_STATEFUL_${runId}`
  const statelessTitle = `HUMAN_STATELESS_${runId}`
  const statefulMarker = `HUMAN_A_${runId}`
  const statelessMarker = `HUMAN_B_${runId}`
  const statelessFollowMarker = `HUMAN_B2_${runId}`
  const statefulFollowMarker = `HUMAN_A2_${runId}`

  let app: ElectronApplication | undefined
  let page: Page | undefined

  const metrics: JourneyMetrics = {
    hcc_idle_minutes: 0,
    hcc_idle_floor_minutes: 0,
    hcc_drain_grace_ms: 0,
    hcc_heartbeat_poll_ms: 0,
    first_profile_path: '',
    second_profile_path: '',
    stateful_pod_before: [],
    stateless_pod_before: [],
    stateless_initial_lifecycle_state: '',
    stateless_initial_lifecycle_reason: '',
    stateless_image_ids_before: [],
    stateless_image_ids_after_reopen: [],
    stateless_image_ids_after_cold_send: [],
    stateless_pull_policy_warning: null,
    first_close_ms: null,
    first_suspend_ms: 0,
    second_launch_to_window_ms: 0,
    second_launch_to_authenticated_ms: 0,
    second_launch_to_stateless_ready_ms: 0,
    draft_preserved_while_switching_hosts: false,
    draft_preserved_across_restart: false,
    second_suspend_ms: 0,
    cold_send_to_waking_visible_ms: null,
    cold_send_pre_click_ready_replicas: 0,
    cold_send_first_outcome: null,
    cold_send_to_user_message_visible_ms: null,
    cold_send_to_task_acknowledged_ms: null,
    cold_send_to_ready_observed_ms: null,
    cold_send_to_response_ms: 0,
    cold_send_to_composer_idle_ms: 0,
    cold_send_retries: 0,
    initial_stateless_send_retries: 0,
    stateless_pod_after_cold_send: [],
    stateful_pod_after: [],
    markers: {
      stateful_initial: statefulMarker,
      stateless_initial: statelessMarker,
      stateless_follow_up: statelessFollowMarker,
      stateful_follow_up: statefulFollowMarker,
    },
  }

  try {
    await test.step('verify both Hosts and the branch-owned runtime baseline', async () => {
      const [statefulBefore, statelessBefore, cadences] = await Promise.all([
        readHostSnapshot(STATEFUL_DEPLOYMENT, STATEFUL_HOST_RESOURCE),
        readHostSnapshot(STATELESS_DEPLOYMENT, STATELESS_HOST_RESOURCE),
        readHccCadences(),
      ])
      expect(
        statefulBefore.readyReplicas,
        'stateful control Host must start Ready'
      ).toBeGreaterThan(0)
      if (statelessBefore.lifecycleState === 'suspended') {
        expect(statelessBefore.lifecycleReason).toBe('idle')
        expect(statelessBefore.replicas).toBe(0)
        expect(statelessBefore.readyReplicas).toBe(0)
        expect(statelessBefore.podNames).toHaveLength(0)
      } else {
        expect(
          statelessBefore.readyReplicas,
          'active stateless Host must start Ready'
        ).toBeGreaterThan(0)
      }
      const estimatedSuspendMs =
        Math.max(cadences.idleMinutes, cadences.idleFloorMinutes) * 60_000 +
        cadences.drainGraceMs +
        cadences.heartbeatPollMs * 2
      expect(
        Object.values(cadences).every(value => Number.isFinite(value) && value > 0) &&
          estimatedSuspendMs < SUSPEND_TIMEOUT_MS,
        'HCC idle/floor/drain/poll cadences must permit a bounded natural suspension; configure the owned profile before recording'
      ).toBe(true)
      metrics.hcc_idle_minutes = cadences.idleMinutes
      metrics.hcc_idle_floor_minutes = cadences.idleFloorMinutes
      metrics.hcc_drain_grace_ms = cadences.drainGraceMs
      metrics.hcc_heartbeat_poll_ms = cadences.heartbeatPollMs
      metrics.stateful_pod_before = statefulBefore.podNames
      metrics.stateless_initial_lifecycle_state = statelessBefore.lifecycleState
      metrics.stateless_initial_lifecycle_reason = statelessBefore.lifecycleReason
      metrics.stateless_pull_policy_warning = statelessBefore.pullPolicyRejection
    })

    await test.step('first Desktop session: create, name, and exercise both Host conversations', async () => {
      const launched = await launchDesktopApp(testInfo)
      app = launched.app
      page = launched.page
      metrics.first_profile_path = await desktopProfilePath(app)
      await login(page, desktopCredentials())
      await openAgentsPage(page)
      await expect(
        page.getByRole('button', { name: `More actions for ${STATEFUL_HOST}`, exact: true })
      ).toBeVisible({ timeout: 30_000 })
      await expect(
        page.getByRole('button', { name: `More actions for ${STATELESS_HOST}`, exact: true })
      ).toBeVisible({ timeout: 30_000 })
      await screenshotAndLog(page, testInfo, '01-authenticated-fleet')

      await newChatFromAgentsPage(page, STATELESS_HOST)
      const statelessComposer = page.getByRole('textbox', { name: 'Agent message composer' })
      await humanType(
        statelessComposer,
        `Reply with exactly: ${statelessMarker}. Remember this token for a later question.`
      )
      const statelessSend = page.getByTestId('send-button')
      await expect(statelessSend).toBeEnabled()
      await statelessSend.click()
      const firstOutcome = await resolveColdSend(page, statelessMarker, statelessMarker)
      metrics.initial_stateless_send_retries = firstOutcome.retries
      await expect(statelessComposer).toHaveValue('', { timeout: 150_000 })
      await expect(statelessSend).toHaveAttribute('aria-label', 'Send message', {
        timeout: 150_000,
      })
      await expect(statelessSend).toBeDisabled({ timeout: 150_000 })
      const firstReady = await waitForStatelessReady(270_000)
      expect(
        firstReady.snapshot.imageIds,
        'record the actual stateless container imageID after the first UI response'
      ).not.toHaveLength(0)
      metrics.stateless_pod_before = firstReady.snapshot.podNames
      metrics.stateless_image_ids_before = firstReady.snapshot.imageIds
      await renameSessionByMarker(page, statelessMarker, statelessTitle)
      await screenshotAndLog(page, testInfo, '02-stateless-initial-turn')

      await newChatFromAgentsPage(page, STATEFUL_HOST)
      await sendMarker(
        page,
        statefulMarker,
        `Reply with exactly: ${statefulMarker}. Remember this token for a later question.`
      )
      await renameSessionByMarker(page, statefulMarker, statefulTitle)
      await screenshotAndLog(page, testInfo, '03-stateful-initial-turn')

      const composer = page.getByRole('textbox', { name: 'Agent message composer' })
      await openExactSession(page, statelessTitle, STATELESS_HOST)
      await humanType(composer, `Unsent stateless draft ${runId}`)
      await openExactSession(page, statefulTitle, STATEFUL_HOST)
      await expect(composer).toHaveValue('')
      await openExactSession(page, statelessTitle, STATELESS_HOST)
      await expect(composer).toHaveValue(`Unsent stateless draft ${runId}`)
      metrics.draft_preserved_while_switching_hosts = true
      await screenshotAndLog(page, testInfo, '04-draft-preserved-across-host-switch')
    })

    await test.step('exit Electron and prove a real replicas-0 suspension', async () => {
      const closeStarted = Date.now()
      await finalizeRecording(app, page)
      await closeElectron(app)
      metrics.first_close_ms = Date.now() - closeStarted
      app = undefined
      page = undefined

      const suspended = await waitForStatelessSuspended(SUSPEND_TIMEOUT_MS)
      metrics.first_suspend_ms = suspended.elapsedMs
      expect(suspended.snapshot.lifecycleState).toBe('suspended')
      expect(suspended.snapshot.replicas).toBe(0)
      expect(suspended.snapshot.podNames).toHaveLength(0)
    })

    await test.step('reopen the same Desktop profile while the stateless Host is suspended', async () => {
      const launchStarted = Date.now()
      const launched = await launchDesktopApp(testInfo)
      metrics.second_launch_to_window_ms = Date.now() - launchStarted
      app = launched.app
      page = launched.page
      metrics.second_profile_path = await desktopProfilePath(app)
      expect(metrics.second_profile_path).toBe(metrics.first_profile_path)
      await authenticatedWithoutRelogin(page)
      metrics.second_launch_to_authenticated_ms = Date.now() - launchStarted

      const ready = await waitForStatelessReady(270_000)
      metrics.second_launch_to_stateless_ready_ms = Date.now() - launchStarted
      metrics.stateless_image_ids_after_reopen = ready.snapshot.imageIds
      expect(ready.snapshot.readyReplicas).toBeGreaterThan(0)
      expect(ready.snapshot.podNames.join(',')).not.toBe(metrics.stateless_pod_before.join(','))
      expect(ready.snapshot.imageIds).toEqual(metrics.stateless_image_ids_before)

      await openExactSession(page, statelessTitle, STATELESS_HOST)
      await expect(page.getByTestId('message-list')).toContainText(statelessMarker, {
        timeout: 30_000,
      })
      const composer = page.getByRole('textbox', { name: 'Agent message composer' })
      // Drafts are currently renderer-memory scoped. Record this observation;
      // PR A requires draft continuity during transient errors in a live app.
      metrics.draft_preserved_across_restart =
        (await composer.inputValue()) === `Unsent stateless draft ${runId}`
      await screenshotAndLog(page, testInfo, '05-reopened-stateless-transcript')

      await openExactSession(page, statefulTitle, STATEFUL_HOST)
      await expect(page.getByTestId('message-list')).toContainText(statefulMarker, {
        timeout: 30_000,
      })
      await screenshotAndLog(page, testInfo, '06-reopened-stateful-transcript')
    })

    await test.step('prepare and send from a second verified cold stateless state', async () => {
      await openExactSession(page, statelessTitle, STATELESS_HOST)
      const composer = page.getByRole('textbox', { name: 'Agent message composer' })
      await composer.fill('')
      const secondSuspended = await waitForStatelessSuspended(SUSPEND_TIMEOUT_MS)
      metrics.second_suspend_ms = secondSuspended.elapsedMs
      expect(secondSuspended.snapshot.lifecycleState).toBe('suspended')
      expect(secondSuspended.snapshot.replicas).toBe(0)
      expect(secondSuspended.snapshot.podNames).toHaveLength(0)

      const followPrompt = `Earlier I gave you a token. Reply with exactly that token followed by ${statelessFollowMarker}.`
      await humanType(composer, followPrompt)
      await expect(page.getByTestId('send-button')).toBeEnabled()
      // The catalog prewarm after reopen is measured separately by
      // second_launch_to_stateless_ready_ms. This fresh snapshot proves that
      // the second send is itself a cold wake intent, not a continuation of
      // that earlier prewarm window.
      const preClick = await readHostSnapshot(STATELESS_DEPLOYMENT, STATELESS_HOST_RESOURCE)
      metrics.cold_send_pre_click_ready_replicas = preClick.readyReplicas
      expect(preClick.lifecycleState).toBe('suspended')
      expect(preClick.replicas).toBe(0)
      expect(preClick.readyReplicas).toBe(0)
      expect(preClick.podNames).toHaveLength(0)

      const sendStarted = Date.now()
      await page.getByTestId('send-button').click()
      await expect(page.getByTestId('message-list')).toContainText(statelessFollowMarker, {
        timeout: 30_000,
      })
      metrics.cold_send_to_user_message_visible_ms = Date.now() - sendStarted

      const followResponse = page
        .getByTestId('agent-response')
        .filter({ hasText: statelessFollowMarker })
      const taskStepper = page.getByTestId('progress-stepper')
      const stepperWatch = expect
        .poll(
          async () => {
            if (
              metrics.cold_send_to_task_acknowledged_ms === null &&
              (await taskStepper.isVisible().catch(() => false))
            ) {
              metrics.cold_send_to_task_acknowledged_ms = Date.now() - sendStarted
            }
            return (
              metrics.cold_send_to_task_acknowledged_ms !== null ||
              (await followResponse.isVisible().catch(() => false))
            )
          },
          {
            timeout: 270_000,
            message: 'Cold send must expose either a task acknowledgement or a final response',
          }
        )
        .toBe(true)
      const readyObservation = waitForStatelessReady(270_000).then(result => ({
        result,
        observedAt: Date.now(),
      }))
      const outcome = await resolveColdSend(page, statelessFollowMarker, statelessMarker)
      metrics.cold_send_to_waking_visible_ms = outcome.wakingVisibleMs
      metrics.cold_send_first_outcome = outcome.firstOutcome
      metrics.cold_send_to_response_ms = Date.now() - sendStarted
      metrics.cold_send_retries = outcome.retries
      await expect(composer).toHaveValue('', { timeout: 150_000 })
      await expect(page.getByTestId('send-button')).toHaveAttribute('aria-label', 'Send message', {
        timeout: 150_000,
      })
      await expect(page.getByTestId('send-button')).toBeDisabled({ timeout: 150_000 })
      metrics.cold_send_to_composer_idle_ms = Date.now() - sendStarted
      await stepperWatch

      const readyAfterSend = await readyObservation
      metrics.cold_send_to_ready_observed_ms = readyAfterSend.observedAt - sendStarted
      metrics.stateless_pod_after_cold_send = readyAfterSend.result.snapshot.podNames
      metrics.stateless_image_ids_after_cold_send = readyAfterSend.result.snapshot.imageIds
      expect(readyAfterSend.result.snapshot.readyReplicas).toBeGreaterThan(0)
      expect(readyAfterSend.result.snapshot.imageIds).toEqual(metrics.stateless_image_ids_before)
      await expect(
        page.getByTestId('agent-response').filter({ hasText: statelessFollowMarker })
      ).toContainText(statelessFollowMarker, { timeout: 30_000 })
      await screenshotAndLog(page, testInfo, '07-stateless-context-continuity-after-cold-send')
    })

    await test.step('stateful control remains continuous and responsive', async () => {
      await openExactSession(page, statefulTitle, STATEFUL_HOST)
      await expect(page.getByTestId('message-list')).toContainText(statefulMarker, {
        timeout: 30_000,
      })
      await sendMarker(
        page,
        statefulFollowMarker,
        `What was the earlier token in this conversation? Reply with that token followed by ${statefulFollowMarker}.`
      )
      await expect(
        page.getByTestId('agent-response').filter({ hasText: statefulFollowMarker })
      ).toContainText(statefulMarker)
      const statefulAfter = await readHostSnapshot(STATEFUL_DEPLOYMENT, STATEFUL_HOST_RESOURCE)
      metrics.stateful_pod_after = statefulAfter.podNames
      expect(statefulAfter.readyReplicas).toBeGreaterThan(0)
      expect(statefulAfter.podNames.join(',')).toBe(metrics.stateful_pod_before.join(','))
      await screenshotAndLog(page, testInfo, '08-stateful-control-continuity')
    })
  } finally {
    await finalizeRecording(app, page).catch(() => undefined)
    await testInfo.attach('human-stateless-continuity-metrics', {
      body: JSON.stringify(metrics, null, 2),
      contentType: 'application/json',
    })
    console.log(`[HumanStatelessContinuity] ${JSON.stringify(metrics)}`)
  }
})
