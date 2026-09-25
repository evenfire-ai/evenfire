/// <reference path="../../src/renderer.d.ts" />
// E2E_GUARDIAN_IPC_FLOW: Desktop sends RPC and GFS calls through Electron's
// main-process IPC, so renderer page.waitForRequest cannot observe this journey.
import { type ElectronApplication, type Page, expect, test } from '@playwright/test'
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import path from 'node:path'
import {
  type AgentGfsFixtures,
  assertGfsInfraHealthy,
  seedAgentGfsFixtures,
} from './helpers/gfsFixtures'
import {
  EXTERNAL_REST_API_BASE_URL,
  RPC_PROXY_BASE_URL,
  assertAllowedTarget,
  desktopCredentials,
  launchDesktopApp,
  login,
  openAgentsPage,
} from './qa-recorder-helpers'

const STATELESS_HOST = process.env.E2E_STATELESS_HOST_REF || 'chatllm-stateless'
const STATEFUL_HOST = process.env.E2E_STATEFUL_HOST_REF || 'chatllm'
const STATEFUL_HOST_DISPLAY = process.env.E2E_STATEFUL_HOST_DISPLAY || 'chatLLM'
const KUBE_CONTEXT =
  process.env.E2E_K8S_CONTEXT || process.env.KUBECONTEXT || process.env.K8S_CONTEXT || ''
const HCC_DEPLOYMENT = 'host-context-controller'
const BASELINE_HCC_ENV = {
  CONTEXT_MAPPER_STATELESS_IDLE_MINUTES: '30',
  CONTEXT_MAPPER_STATELESS_IDLE_FLOOR_MINUTES: '15',
  CONTEXT_MAPPER_STATELESS_DRAIN_GRACE_MS: '60000',
  CONTEXT_MAPPER_HEARTBEAT_POLL_MS: '10000',
}
const ACCELERATED_HCC_ENV = {
  CONTEXT_MAPPER_STATELESS_IDLE_MINUTES: '1',
  CONTEXT_MAPPER_STATELESS_IDLE_FLOOR_MINUTES: '1',
  CONTEXT_MAPPER_STATELESS_DRAIN_GRACE_MS: '20000',
  CONTEXT_MAPPER_HEARTBEAT_POLL_MS: '5000',
}

type Json = Record<string, any>
type HostSnapshot = {
  hostUid: string
  lifecycle: { state: string; reason: string }
  replicas: number
  readyReplicas: number
  pods: string[]
  podUids: string[]
  imageIds: string[]
  templateHash: string
  parameterHash: string
  claimName: string
  pvcUid: string
  mountPath: string
  sqliteDir: string | null
}

function kubectl(args: readonly string[], timeout = 20_000): string {
  if (!KUBE_CONTEXT) throw new Error('E2E_K8S_CONTEXT is required')
  return execFileSync('kubectl', ['--context', KUBE_CONTEXT, ...args], {
    encoding: 'utf8',
    timeout,
    maxBuffer: 12 * 1024 * 1024,
  })
}

function json(args: readonly string[]): Json {
  return JSON.parse(kubectl(args)) as Json
}

function hash(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex')
}

function hostSnapshot(
  deploymentName: string,
  hostName: string,
  requireStatelessSqlite: boolean
): HostSnapshot {
  const deployment = json(['-n', 'mcp-host', 'get', `deployment/${deploymentName}`, '-o', 'json'])
  const host = json(['-n', 'mcp-host', 'get', `host/${hostName}`, '-o', 'json'])
  const podList = json(['-n', 'mcp-host', 'get', 'pods', '-l', `app=${hostName}`, '-o', 'json'])
  const container = deployment.spec?.template?.spec?.containers?.find(
    (item: Json) => item.name === 'mcp-host'
  )
  const workspace = container?.volumeMounts?.find((item: Json) => item.name === 'workspace')
  const volume = deployment.spec?.template?.spec?.volumes?.find(
    (item: Json) => item.name === workspace?.name
  )
  const claimName = volume?.persistentVolumeClaim?.claimName
  const sqliteDir = container?.env?.find(
    (item: Json) => item.name === 'CLERUM_SESSION_DB_DIR'
  )?.value
  if (!workspace?.mountPath || !claimName) {
    throw new Error(`${hostName} lost its workspace PVC declaration`)
  }
  if (requireStatelessSqlite) {
    const sqliteMount = container?.volumeMounts?.find(
      (item: Json) => item.name === workspace.name && item.mountPath === sqliteDir
    )
    if (!sqliteDir || sqliteMount?.subPath !== 'state') {
      throw new Error(`${hostName} lost its dedicated SQLite subPath mount`)
    }
  }
  const claim = json(['-n', 'mcp-host', 'get', `pvc/${claimName}`, '-o', 'json'])
  const livePods = (podList.items ?? []).filter((item: Json) => !item.metadata?.deletionTimestamp)

  return {
    hostUid: String(host.metadata?.uid ?? ''),
    lifecycle: {
      state: String(host.status?.lifecycle?.state ?? ''),
      reason: String(host.status?.lifecycle?.reason ?? ''),
    },
    replicas: Number(deployment.spec?.replicas ?? -1),
    readyReplicas: Number(deployment.status?.readyReplicas ?? 0),
    pods: livePods
      .map((item: Json) => item.metadata?.name)
      .filter(Boolean)
      .sort(),
    podUids: livePods
      .map((item: Json) => item.metadata?.uid)
      .filter(Boolean)
      .sort(),
    imageIds: livePods
      .flatMap((item: Json) =>
        (item.status?.containerStatuses ?? []).map((status: Json) => status.imageID)
      )
      .filter(Boolean)
      .sort(),
    templateHash: hash(deployment.spec?.template ?? {}),
    parameterHash: hash({
      personalization: host.spec?.personalization,
      model: host.spec?.model,
      contextRef: host.spec?.contextRef,
      workflowControl: host.spec?.workflowControl,
      approval: host.spec?.approval,
    }),
    claimName,
    pvcUid: String(claim.metadata?.uid ?? ''),
    mountPath: workspace.mountPath,
    sqliteDir: sqliteDir ?? null,
  }
}

function requireInheritedMutationLease(): void {
  const profile = process.env.T2_PROFILE ?? process.env.MINIKUBE_PROFILE ?? ''
  const leasedContext = process.env.T2_CONTEXT ?? process.env.CONTROL_API_REAL_PG_CONTEXT ?? profile
  if (!profile || KUBE_CONTEXT !== leasedContext || leasedContext !== profile) {
    throw new Error(
      `Kubernetes context must exactly match the inherited mutation lease: kubectl=${KUBE_CONTEXT}, lease=${leasedContext}, profile=${profile}`
    )
  }
  execFileSync(
    'bash',
    [path.resolve(__dirname, '../../../scripts/minikube/require-t2-mutation-lock.sh')],
    { env: process.env, encoding: 'utf8', timeout: 20_000 }
  )
}

function hccEnv(): Record<string, string> {
  const deployment = json([
    '-n',
    'control-plane',
    'get',
    `deployment/${HCC_DEPLOYMENT}`,
    '-o',
    'json',
  ])
  const env =
    deployment.spec?.template?.spec?.containers
      ?.find((item: Json) => item.name === 'host-context-controller')
      ?.env?.filter((item: Json) => item.name in BASELINE_HCC_ENV) ?? []
  return Object.fromEntries(env.map((item: Json) => [item.name, item.value]))
}

function setHccEnv(values: Record<string, string>): void {
  kubectl(
    [
      '-n',
      'control-plane',
      'set',
      'env',
      `deployment/${HCC_DEPLOYMENT}`,
      ...Object.entries(values).map(([key, value]) => `${key}=${value}`),
    ],
    30_000
  )
  kubectl(
    ['-n', 'control-plane', 'rollout', 'status', `deployment/${HCC_DEPLOYMENT}`, '--timeout=180s'],
    200_000
  )
  expect(hccEnv()).toEqual(values)
}

async function waitForStateless(
  desired: 'suspended' | 'ready',
  timeoutMs: number,
  shouldStop?: () => boolean
): Promise<{ snapshot: HostSnapshot; elapsedMs: number }> {
  const started = Date.now()
  for (;;) {
    if (shouldStop?.()) throw new Error(`Stopped waiting for ${STATELESS_HOST}=${desired}`)
    const snapshot = hostSnapshot(STATELESS_HOST, STATELESS_HOST, true)
    if (shouldStop?.()) throw new Error(`Stopped waiting for ${STATELESS_HOST}=${desired}`)
    const matched =
      desired === 'suspended'
        ? snapshot.lifecycle.state === 'suspended' &&
          snapshot.lifecycle.reason === 'idle' &&
          snapshot.replicas === 0 &&
          snapshot.readyReplicas === 0 &&
          snapshot.pods.length === 0
        : snapshot.replicas === 1 && snapshot.readyReplicas === 1 && snapshot.pods.length === 1
    if (matched) return { snapshot, elapsedMs: Date.now() - started }
    if (Date.now() - started >= timeoutMs) {
      throw new Error(
        `Timed out waiting for ${STATELESS_HOST}=${desired}: ${JSON.stringify(snapshot)}`
      )
    }
    await new Promise(resolve => setTimeout(resolve, 2_000))
  }
}

async function closeElectron(app: ElectronApplication | undefined): Promise<void> {
  const child = app?.process()
  await app?.close().catch(() => undefined)
  if (!child) return
  const deadline = Date.now() + 30_000
  while (Date.now() < deadline && child.exitCode === null && child.signalCode === null) {
    await new Promise(resolve => setTimeout(resolve, 200))
  }
  expect(child.exitCode !== null || child.signalCode !== null).toBe(true)
}

async function newChat(page: Page, hostName: string): Promise<void> {
  await openAgentsPage(page)
  await page.getByRole('button', { name: `More actions for ${hostName}`, exact: true }).click()
  const menu = page.getByRole('menu')
  const newChatAction = menu
    .getByRole('button', { name: /^New chat$/ })
    .or(menu.getByRole('menuitem', { name: /^New chat$/ }))
  await expect(newChatAction).toBeVisible({ timeout: 15_000 })
  await newChatAction.click()
  await expect(page.getByRole('textbox', { name: 'Agent message composer' })).toBeVisible({
    timeout: 30_000,
  })
  await expect(page.getByRole('button', { name: /^Switch chat agent$/ })).toContainText(hostName, {
    timeout: 30_000,
  })
}

async function renameByMarker(page: Page, marker: string, title: string): Promise<void> {
  await expect(page.getByTestId('agent-response').filter({ hasText: marker })).toBeVisible()
  const row = page.locator('.nav-latest-session.active')
  await expect(row).toBeVisible({ timeout: 30_000 })
  await row.getByRole('button', { name: /^Session options for / }).click()
  await page.getByRole('menuitem', { name: 'Rename', exact: true }).click()
  const input = page.getByRole('textbox', { name: 'Rename session', exact: true })
  await input.fill(title)
  await input.press('Enter')
  await expect(page.getByRole('button', { name: `Open ${title}`, exact: true })).toBeVisible({
    timeout: 30_000,
  })
}

async function openSession(page: Page, title: string, hostName: string): Promise<void> {
  await page.getByRole('button', { name: `Open ${title}`, exact: true }).click()
  await expect(page.getByRole('textbox', { name: 'Agent message composer' })).toBeVisible({
    timeout: 30_000,
  })
  await expect(page.getByRole('button', { name: /^Switch chat agent$/ })).toContainText(hostName, {
    timeout: 30_000,
  })
}

async function sendAndExpect(
  page: Page,
  prompt: string,
  marker: string,
  timeout = 180_000
): Promise<void> {
  const composer = page.getByRole('textbox', { name: 'Agent message composer' })
  await composer.fill(prompt)
  await expect(page.getByTestId('send-button')).toBeEnabled()
  await page.getByTestId('send-button').click()
  const response = page.getByTestId('agent-response').filter({ hasText: marker })
  await expect(response).toBeVisible({ timeout })
  await expect(composer).toHaveValue('', { timeout: 30_000 })
  await expect(page.getByTestId('send-button')).toBeDisabled({ timeout: 30_000 })
  await expect(page.getByTestId('send-button')).toHaveAttribute('aria-label', 'Send message', {
    timeout: 30_000,
  })
}

async function waitAuthenticatedWithoutLogin(page: Page): Promise<void> {
  await expect(page.locator('.boot-overlay')).toBeHidden({ timeout: 30_000 })
  await expect(page.getByTestId('nav-chat')).toBeVisible({ timeout: 30_000 })
  await expect(page.locator('#email-input')).toBeHidden({ timeout: 30_000 })
}

async function approveVisibleToolsUntilResponse(
  page: Page,
  response: import('@playwright/test').Locator,
  timeoutMs: number
): Promise<void> {
  await expect
    .poll(
      async () => {
        const approval = page
          .getByTestId('progress-stepper')
          .filter({ hasText: /GFS requires approval/i })
          .getByTestId('approval-approve-btn')
        const approvalCount = await approval.count()
        if (approvalCount === 1) {
          if (!(await approval.isEnabled().catch(() => false))) return 'waiting'
          await approval.click()
          return 'approved-one-tool'
        }
        if (approvalCount > 1) throw new Error('ambiguous GFS approval requests')
        return (await response.count()) > 0 ? 'response-visible' : 'waiting'
      },
      { timeout: timeoutMs, intervals: [250, 500, 1_000, 2_000] }
    )
    .toBe('response-visible')
}

test.skip(
  process.env.PR849_CONTROLLED_PARITY !== '1',
  'Set PR849_CONTROLLED_PARITY=1 for this real paid Desktop journey'
)

test('PR849 controlled parity across pending work, GFS, host switching, and cold wake', async ({}, testInfo) => {
  test.setTimeout(35 * 60_000)
  if (process.env.QA_RECORDER_CONFIRM_CHAT !== '1') {
    throw new Error('Set QA_RECORDER_CONFIRM_CHAT=1; this journey sends real model turns.')
  }
  if (!KUBE_CONTEXT || !/^clerum-[a-z0-9][a-z0-9-]*-[0-9a-f]{8}$/.test(KUBE_CONTEXT)) {
    throw new Error(`Refusing non-branch-owned context: ${KUBE_CONTEXT || '<empty>'}`)
  }
  if (
    process.env.E2E_ALLOW_STATELESS_CADENCE_ACCELERATION !== '1' ||
    process.env.E2E_GFS_AGENT_A !== STATELESS_HOST
  ) {
    throw new Error(
      `Set E2E_ALLOW_STATELESS_CADENCE_ACCELERATION=1 and E2E_GFS_AGENT_A=${STATELESS_HOST}`
    )
  }
  await assertAllowedTarget('EXTERNAL_REST_API_BASE_URL', EXTERNAL_REST_API_BASE_URL)
  await assertAllowedTarget('RPC_PROXY_BASE_URL', RPC_PROXY_BASE_URL)
  requireInheritedMutationLease()

  const runId = `pr849-${Date.now()}-${Math.random().toString(16).slice(2, 8)}`
  const statelessTitle = `PR849 S ${runId}`
  const statefulTitle = `PR849 F ${runId}`
  const statelessMarker = `PR849_S_${runId}`
  const statefulMarker = `PR849_F_${runId}`
  const statelessCode = `S-${Math.random().toString(16).slice(2, 9).toUpperCase()}`
  const statefulCode = `F-${Math.random().toString(16).slice(2, 9).toUpperCase()}`
  const statelessDraft = `stateless draft ${runId}`
  const statefulDraft = `stateful draft ${runId}`

  let app: ElectronApplication | undefined
  let fixtures: AgentGfsFixtures | undefined
  let lifecycleMutationActive = false
  let beforeStateless: HostSnapshot | undefined
  let beforeStateful: HostSnapshot | undefined
  let afterStateless: HostSnapshot | undefined
  let afterStateful: HostSnapshot | undefined
  let cancelReadinessObserver = false
  let readinessObserver: Promise<unknown> | undefined
  let firstPage: Page | undefined
  const cleanupErrors: string[] = []
  const metrics: Json = {
    runId,
    githubMcpConfigured: false,
    approvalPendingAcrossHostSwitch: false,
    draftPreservedAcrossHostSwitch: false,
    controlledSuspendMs: 0,
    hccRecoveryPending: false,
    secondLaunchToAuthenticatedMs: 0,
    secondLaunchToReadyMs: 0,
    secondLaunchToCachedTranscriptMs: 0,
    followUpToResponseMs: 0,
    effectiveIdentityFileHashesAsserted: false,
    statelessSessionId: '',
    statefulSessionId: '',
    reopenedSessionId: '',
  }

  try {
    await test.step('verify policy, seed GFS, and wake through Desktop catalog', async () => {
      expect(hccEnv()).toEqual(BASELINE_HCC_ENV)
      beforeStateful = hostSnapshot(STATEFUL_HOST, STATEFUL_HOST, false)
      expect(beforeStateful.readyReplicas).toBe(1)
      assertGfsInfraHealthy()
      fixtures = seedAgentGfsFixtures(desktopCredentials().email)
      expect(fixtures.agent.name).toBe(STATELESS_HOST)

      const launchStarted = Date.now()
      const first = await launchDesktopApp(testInfo, 'pr849-controlled-parity')
      app = first.app
      firstPage = first.page
      await login(firstPage, desktopCredentials())
      metrics.firstLaunchToAuthenticatedMs = Date.now() - launchStarted
      await openAgentsPage(firstPage)
      await expect(
        firstPage.getByRole('button', {
          name: `More actions for ${STATELESS_HOST}`,
          exact: true,
        })
      ).toBeVisible({ timeout: 30_000 })
      beforeStateless = (await waitForStateless('ready', 270_000)).snapshot
      expect(beforeStateless.readyReplicas).toBe(1)

      const mcpServers = json(['-n', 'mcp-server', 'get', 'mcpservers', '-o', 'json'])
      metrics.githubMcpConfigured = (mcpServers.items ?? []).some((item: Json) =>
        /github/i.test(String(item.metadata?.name ?? ''))
      )
    })

    await test.step('run pending stateless work and switch to the stateful Host', async () => {
      const page = firstPage!

      await newChat(page, STATELESS_HOST)
      await sendAndExpect(
        page,
        `Prepare the continuity case. Remember exactly code=${statelessCode}, owner=Lucia, limit=27. Reply exactly ${statelessMarker}. Do not use a tool yet.`,
        statelessMarker
      )
      metrics.statelessSessionId = await page.evaluate(
        hostRef => window.clerum.chat.getLastActive(hostRef),
        STATELESS_HOST
      )
      expect(metrics.statelessSessionId).toMatch(/^[0-9a-f-]{36}$/i)
      await renameByMarker(page, statelessMarker, statelessTitle)

      const gfsPath = `/${fixtures!.granted.name}/${fixtures!.granted.fileName}`
      const gfsPrompt =
        `Read the file at path "${gfsPath}" in GFS drive main and quote its contents verbatim. ` +
        'Use your Clerum GFS tools; do not answer from memory.'
      const composer = page.getByRole('textbox', { name: 'Agent message composer' })
      await composer.fill(gfsPrompt)
      await page.getByTestId('send-button').click()
      await expect(page.getByTestId('message-list')).toContainText(gfsPath, { timeout: 30_000 })
      const approvalStepper = page
        .getByTestId('progress-stepper')
        .filter({ hasText: /GFS requires approval/i })
      const approval = approvalStepper.getByTestId('approval-approve-btn')
      await expect(approval).toBeVisible({ timeout: 180_000 })
      await expect(approvalStepper).toContainText(/GFS requires approval/i)

      await newChat(page, STATEFUL_HOST_DISPLAY)
      await expect(page.getByTestId('message-list')).not.toContainText(gfsPath)
      await sendAndExpect(
        page,
        `Prepare the control case. Remember exactly code=${statefulCode}, owner=Mateo, limit=14. Reply exactly ${statefulMarker}.`,
        statefulMarker
      )
      metrics.statefulSessionId = await page.evaluate(
        hostRef => window.clerum.chat.getLastActive(hostRef),
        STATEFUL_HOST
      )
      expect(metrics.statefulSessionId).not.toBe(metrics.statelessSessionId)
      await renameByMarker(page, statefulMarker, statefulTitle)

      await openSession(page, statelessTitle, STATELESS_HOST)
      await expect(page.getByTestId('message-list')).toContainText(gfsPath)
      await expect(approval).toBeVisible({
        timeout: 30_000,
      })
      metrics.approvalPendingAcrossHostSwitch = true
      const sentinel = `E2E GFS file fixture: ${fixtures!.granted.name}`
      const response = page.getByTestId('agent-response').filter({ hasText: sentinel })
      await approveVisibleToolsUntilResponse(page, response, 240_000)
      await expect(response).toBeVisible({ timeout: 30_000 })
      await expect(response).not.toContainText(/not_mounted|gfsc 503|fetch failed/i)

      const expand = response.getByTestId('progress-expand-btn')
      await expect(expand).toBeVisible({ timeout: 30_000 })
      await expand.click()
      const readSteps = response
        .locator('.stepper-step')
        .filter({ has: page.locator('.stepper-step-fn', { hasText: 'gfs_read' }) })
      let openedGfsReadStep = false
      for (const readStep of await readSteps.all()) {
        await readStep.click()
        openedGfsReadStep = true
      }
      expect(openedGfsReadStep, 'the turn must contain a gfs_read step').toBe(true)
      await expect
        .poll(
          () =>
            readSteps.evaluateAll(
              (steps, expected) =>
                steps.some(step => {
                  if (
                    !step.querySelector('.stepper-step-icon.state-completed') ||
                    step.querySelector('.stepper-step-icon.state-error')
                  ) {
                    return false
                  }
                  let sibling = step.nextElementSibling
                  while (
                    sibling &&
                    !sibling.classList.contains('stepper-step') &&
                    !sibling.classList.contains('stepper-iteration-divider')
                  ) {
                    const output = sibling.querySelector(
                      '[data-testid="step-output-panel"] .stepper-step-output-code'
                    )
                    if (output?.textContent?.includes(expected) === true) return true
                    sibling = sibling.nextElementSibling
                  }
                  return false
                }),
              sentinel
            ),
          { timeout: 30_000 }
        )
        .toBe(true)

      await composer.fill(statelessDraft)
      await openSession(page, statefulTitle, STATEFUL_HOST_DISPLAY)
      await expect(composer).toHaveValue('')
      await composer.fill(statefulDraft)
      await openSession(page, statelessTitle, STATELESS_HOST)
      await expect(composer).toHaveValue(statelessDraft)
      await openSession(page, statefulTitle, STATEFUL_HOST_DISPLAY)
      await expect(composer).toHaveValue(statefulDraft)
      metrics.draftPreservedAcrossHostSwitch = true
    })

    await test.step('suspend through HCC and restore the 30-minute product policy', async () => {
      await closeElectron(app)
      app = undefined
      lifecycleMutationActive = true
      metrics.hccRecoveryPending = true
      setHccEnv(ACCELERATED_HCC_ENV)
      const suspended = await waitForStateless('suspended', 300_000)
      metrics.controlledSuspendMs = suspended.elapsedMs
      expect(suspended.snapshot.pods).toHaveLength(0)
      setHccEnv(BASELINE_HCC_ENV)
      lifecycleMutationActive = false
      metrics.hccRecoveryPending = false
      metrics.hccBaselineRestored = true
    })

    await test.step('reopen the same isolated profile and continue after wake', async () => {
      const relaunchBefore = hostSnapshot(STATELESS_HOST, STATELESS_HOST, true)
      expect(relaunchBefore.lifecycle.state).toBe('suspended')
      expect(relaunchBefore.pods).toHaveLength(0)
      let readyObservedAt: number | null = null
      let readinessFailure: unknown
      const launchStarted = Date.now()
      const secondLaunch = launchDesktopApp(testInfo, 'pr849-controlled-parity')
      readinessObserver = waitForStateless('ready', 270_000, () => cancelReadinessObserver)
        .then(snapshot => {
          readyObservedAt = Date.now()
          afterStateless = snapshot.snapshot
          return snapshot
        })
        .catch(error => {
          readinessFailure = error
          return undefined
        })
      const second = await secondLaunch
      app = second.app
      const page = second.page
      await waitAuthenticatedWithoutLogin(page)
      metrics.secondLaunchToAuthenticatedMs = Date.now() - launchStarted
      await openAgentsPage(page)
      await expect(
        page.getByRole('button', { name: `More actions for ${STATELESS_HOST}`, exact: true })
      ).toBeVisible({ timeout: 30_000 })

      const openStarted = Date.now()
      await openSession(page, statelessTitle, STATELESS_HOST)
      await expect(page.getByTestId('message-list')).toContainText(statelessCode)
      const sentinel = `E2E GFS file fixture: ${fixtures!.granted.name}`
      const retainedMarker = page.getByTestId('agent-response').filter({ hasText: statelessMarker })
      const retainedGfs = page.getByTestId('agent-response').filter({ hasText: sentinel })
      await expect(retainedMarker).toBeVisible({ timeout: 90_000 })
      await expect(retainedGfs).toBeVisible({ timeout: 90_000 })
      metrics.secondLaunchToCachedTranscriptMs = Date.now() - launchStarted
      const cachedVisibleAt = Date.now()
      await readinessObserver
      if (readinessFailure) throw readinessFailure
      if (!readyObservedAt || !afterStateless) {
        throw new Error(`${STATELESS_HOST} readiness observer completed without a Ready snapshot`)
      }
      afterStateful = hostSnapshot(STATEFUL_HOST, STATEFUL_HOST, false)
      metrics.secondLaunchToReadyMs = readyObservedAt - launchStarted
      metrics.cacheVisibleBeforeReadyObserved =
        readyObservedAt !== null && cachedVisibleAt < readyObservedAt
      metrics.reopenedSessionId = await page.evaluate(
        hostRef => window.clerum.chat.getLastActive(hostRef),
        STATELESS_HOST
      )
      expect(metrics.reopenedSessionId).toBe(metrics.statelessSessionId)

      const followStarted = Date.now()
      await sendAndExpect(
        page,
        'Continue the earlier continuity case. From the first turn only, return exactly three labeled fields in order: code=..., owner=..., limit=... Do not repeat control-case values.',
        statelessCode,
        240_000
      )
      metrics.followUpToResponseMs = Date.now() - followStarted
      const follow = page.getByTestId('agent-response').filter({ hasText: statelessCode })
      await expect(follow).toContainText(new RegExp(`code\\s*[:=]\\s*${statelessCode}`, 'i'))
      await expect(follow).toContainText(/owner\s*[:=]\s*Lucia/i)
      await expect(follow).toContainText(/limit\s*[:=]\s*27/i)
      await expect(follow).not.toContainText(statefulCode)
      await expect(follow).not.toContainText('Mateo')

      await openSession(page, statefulTitle, STATEFUL_HOST_DISPLAY)
      await expect(
        page.getByTestId('agent-response').filter({ hasText: statefulMarker })
      ).toBeVisible()
      await expect(page.getByTestId('message-list')).not.toContainText(statelessCode)
    })

    const checks = {
      hostUidStable: afterStateless!.hostUid === beforeStateless!.hostUid,
      templateStable: afterStateless!.templateHash === beforeStateless!.templateHash,
      declaredParametersStable: afterStateless!.parameterHash === beforeStateless!.parameterHash,
      pvcStable: afterStateless!.pvcUid === beforeStateless!.pvcUid,
      sqliteStable:
        afterStateless!.claimName === beforeStateless!.claimName &&
        afterStateless!.mountPath === beforeStateless!.mountPath &&
        afterStateless!.sqliteDir === beforeStateless!.sqliteDir,
      imageStable: afterStateless!.imageIds.join(',') === beforeStateless!.imageIds.join(','),
      statelessPodChanged: afterStateless!.podUids.join(',') !== beforeStateless!.podUids.join(','),
      statefulPodStable: afterStateful!.podUids.join(',') === beforeStateful!.podUids.join(','),
    }
    Object.assign(metrics, checks)
    expect(checks).toEqual({
      hostUidStable: true,
      templateStable: true,
      declaredParametersStable: true,
      pvcStable: true,
      sqliteStable: true,
      imageStable: true,
      statelessPodChanged: true,
      statefulPodStable: true,
    })
  } finally {
    cancelReadinessObserver = true
    await readinessObserver
    try {
      await closeElectron(app)
    } catch (error) {
      cleanupErrors.push(
        `Electron close: ${error instanceof Error ? error.message : String(error)}`
      )
    }
    if (lifecycleMutationActive) {
      try {
        setHccEnv(BASELINE_HCC_ENV)
        lifecycleMutationActive = false
        metrics.hccRecoveryPending = false
        metrics.hccBaselineRestored = true
      } catch (error) {
        cleanupErrors.push(
          `HCC baseline restoration: ${error instanceof Error ? error.message : String(error)}`
        )
      }
    }
    try {
      fixtures?.cleanup()
    } catch {
      cleanupErrors.push('GFS fixture cleanup failed')
    }
    metrics.cleanupErrors = cleanupErrors
    await testInfo.attach('pr849-controlled-parity-metrics', {
      body: JSON.stringify(metrics, null, 2),
      contentType: 'application/json',
    })
    console.log(`[PR849ControlledParity] ${JSON.stringify(metrics)}`)
    if (cleanupErrors.length > 0) throw new Error(cleanupErrors.join('; '))
  }
})
