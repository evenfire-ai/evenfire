/// <reference path="../../src/renderer.d.ts" />
// E2E_GUARDIAN_IPC_FLOW: Desktop sends RPC and GFS calls through Electron's
// main-process IPC, so renderer page.waitForRequest cannot observe this journey.
import { type ElectronApplication, type Page, expect, test } from '@playwright/test'
import { execFile, execFileSync } from 'node:child_process'
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
const EXPECTED_STATELESS_MODEL_PROVIDER = process.env.E2E_EXPECTED_STATELESS_MODEL_PROVIDER || ''
const EXPECTED_STATELESS_MODEL_NAME = process.env.E2E_EXPECTED_STATELESS_MODEL_NAME || ''
const REQUIRE_IDENTITY_FILES = process.env.E2E_REQUIRE_IDENTITY_FILES === '1'
const KUBE_CONTEXT =
  process.env.E2E_K8S_CONTEXT || process.env.KUBECONTEXT || process.env.K8S_CONTEXT || ''
const HCC_DEPLOYMENT = 'host-context-controller'
const RUNTIME_TOKEN_REVISION_ANNOTATION = 'clerum.io/runtime-token-revision'
const RUNTIME_TOKEN_SECRET_REVISION_ANNOTATION = 'clerum.io/runtime-token-secret-revision'
const RUNTIME_TOKEN_BOOTSTRAP_STATE_ANNOTATION = 'clerum.io/runtime-token-bootstrap-state'
const RUNTIME_TOKEN_ROLLOUT_REQUIRED_ANNOTATION = 'clerum.io/runtime-token-rollout-required'
const RUNTIME_TOKEN_ISSUED_AT_ANNOTATION = 'clerum.io/runtime-token-issued-at'
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
const IDENTITY_FILES = ['IDENTITY.md', 'SOUL.md', 'AGENTS.md', 'USER.md'] as const
const EMPTY_FILE_SHA256 = createHash('sha256').update('').digest('hex')
type IdentityFileName = (typeof IDENTITY_FILES)[number]
const HCC_RUNTIME_PROBE_ANNOTATION = 'clerum.io/pr849-hcc-runtime-probe'

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
  rawTemplateHash: string
  runtimeTokenRevision: string
  parameterHash: string
  claimName: string
  pvcUid: string
  mountPath: string
  sqliteDir: string | null
  declaredIdentityFiles: string[]
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

function kubectlAsync(args: readonly string[], timeout = 20_000): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(
      'kubectl',
      ['--context', KUBE_CONTEXT, ...args],
      { encoding: 'utf8', timeout, maxBuffer: 12 * 1024 * 1024 },
      (error, stdout, stderr) => {
        if (error) {
          reject(new Error(`${error.message}: ${stderr}`))
          return
        }
        resolve(stdout)
      }
    )
  })
}

async function jsonAsync(args: readonly string[]): Promise<Json> {
  return JSON.parse(await kubectlAsync(args)) as Json
}

function hash(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex')
}

function functionalWorkloadTemplate(template: Json | undefined): Json | undefined {
  if (!template?.metadata?.annotations) return template
  const functional = structuredClone(template)
  const annotations = { ...(functional.metadata?.annotations ?? {}) }
  delete annotations[RUNTIME_TOKEN_REVISION_ANNOTATION]
  functional.metadata.annotations = annotations
  return functional
}

async function hostSnapshot(
  deploymentName: string,
  hostName: string,
  requireStatelessSqlite: boolean
): Promise<HostSnapshot> {
  const [deployment, host, podList] = await Promise.all([
    jsonAsync(['-n', 'mcp-host', 'get', `deployment/${deploymentName}`, '-o', 'json']),
    jsonAsync(['-n', 'mcp-host', 'get', `host/${hostName}`, '-o', 'json']),
    jsonAsync(['-n', 'mcp-host', 'get', 'pods', '-l', `app=${hostName}`, '-o', 'json']),
  ])
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
  const claim = await jsonAsync(['-n', 'mcp-host', 'get', `pvc/${claimName}`, '-o', 'json'])
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
    templateHash: hash(functionalWorkloadTemplate(deployment.spec?.template)),
    rawTemplateHash: hash(deployment.spec?.template ?? {}),
    runtimeTokenRevision: String(
      deployment.spec?.template?.metadata?.annotations?.[RUNTIME_TOKEN_REVISION_ANNOTATION] ?? ''
    ),
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
    declaredIdentityFiles: host.spec?.personalization == null ? [] : [...IDENTITY_FILES],
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

function identityFileSnapshot(
  podName: string
): Record<IdentityFileName, { exists: boolean; sha256: string | null }> {
  const script = [
    'set -eu',
    ...IDENTITY_FILES.map(file => {
      const path = `/workspace/${file}`
      return `if test -f "${path}"; then sha256sum "${path}"; else printf 'ABSENT ${file}\\n'; fi`
    }),
  ].join('\n')
  const output = kubectl(['-n', 'mcp-host', 'exec', podName, '--', 'sh', '-c', script])
  const snapshot: Record<IdentityFileName, { exists: boolean; sha256: string | null }> = {
    'IDENTITY.md': { exists: false, sha256: null },
    'SOUL.md': { exists: false, sha256: null },
    'AGENTS.md': { exists: false, sha256: null },
    'USER.md': { exists: false, sha256: null },
  }
  const observedFiles = new Set<IdentityFileName>()
  for (const line of output.trim().split('\n')) {
    const absentMatch = /^ABSENT (IDENTITY\.md|SOUL\.md|AGENTS\.md|USER\.md)$/.exec(line.trim())
    const absentFile = absentMatch?.[1] as IdentityFileName | undefined
    if (absentFile) {
      if (observedFiles.has(absentFile)) {
        throw new Error(`Duplicate identity output for ${absentFile} on ${podName}`)
      }
      observedFiles.add(absentFile)
      snapshot[absentFile] = { exists: false, sha256: null }
      continue
    }
    const presentMatch =
      /^([0-9a-f]{64})\s+\/workspace\/(IDENTITY\.md|SOUL\.md|AGENTS\.md|USER\.md)$/.exec(
        line.trim()
      )
    const digest = presentMatch?.[1]
    const fileName = presentMatch?.[2] as IdentityFileName | undefined
    if (!digest || !fileName) {
      throw new Error(`Unexpected identity hash output for ${podName}`)
    }
    if (observedFiles.has(fileName)) {
      throw new Error(`Duplicate identity output for ${fileName} on ${podName}`)
    }
    observedFiles.add(fileName)
    snapshot[fileName] = { exists: true, sha256: digest }
  }
  expect([...observedFiles].sort()).toEqual([...IDENTITY_FILES].sort())
  return snapshot
}

type IdentityFileSnapshot = ReturnType<typeof identityFileSnapshot>

function proveStatelessRuntimeModel(
  podName: string,
  sinceTime: string
): { toolStartEvents: number; matchingEvents: number; otherModelEvents: number } {
  const logs = kubectl(['-n', 'mcp-host', 'logs', podName, '--since-time', sinceTime])
  let toolStartEvents = 0
  let matchingEvents = 0
  let otherModelEvents = 0

  for (const line of logs.trim().split('\n')) {
    if (!line.trim()) continue
    let event: Json
    try {
      event = JSON.parse(line) as Json
    } catch {
      continue
    }
    if (event.msg !== 'LLM tool completion started') continue
    toolStartEvents += 1
    if (
      event.provider === EXPECTED_STATELESS_MODEL_PROVIDER &&
      event.model === EXPECTED_STATELESS_MODEL_NAME
    ) {
      matchingEvents += 1
    } else {
      otherModelEvents += 1
    }
  }

  if (matchingEvents === 0 || otherModelEvents > 0) {
    throw new Error(
      `Expected ${EXPECTED_STATELESS_MODEL_PROVIDER}/${EXPECTED_STATELESS_MODEL_NAME} ` +
        `to serve every tool-capable LLM call; events=${toolStartEvents}, ` +
        `matching=${matchingEvents}, other=${otherModelEvents}`
    )
  }
  return { toolStartEvents, matchingEvents, otherModelEvents }
}

async function waitForStateless(
  desired: 'suspended' | 'ready',
  timeoutMs: number,
  shouldStop?: () => boolean
): Promise<{ snapshot: HostSnapshot; elapsedMs: number }> {
  const started = Date.now()
  for (;;) {
    if (shouldStop?.()) throw new Error(`Stopped waiting for ${STATELESS_HOST}=${desired}`)
    const snapshot = await hostSnapshot(STATELESS_HOST, STATELESS_HOST, true)
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

async function waitForSingleCurrentPod(deploymentName: string): Promise<void> {
  const deadline = Date.now() + 180_000
  for (;;) {
    const [deployment, podList] = await Promise.all([
      jsonAsync(['-n', 'mcp-host', 'get', `deployment/${deploymentName}`, '-o', 'json']),
      jsonAsync(['-n', 'mcp-host', 'get', 'pods', '-l', `app=${deploymentName}`, '-o', 'json']),
    ])
    const generation = Number(deployment.metadata?.generation ?? 0)
    const observedGeneration = Number(deployment.status?.observedGeneration ?? 0)
    const desired = Number(deployment.spec?.replicas ?? -1)
    const updated = Number(deployment.status?.updatedReplicas ?? 0)
    const ready = Number(deployment.status?.readyReplicas ?? 0)
    const available = Number(deployment.status?.availableReplicas ?? 0)
    const livePods = (podList.items ?? []).filter((item: Json) => !item.metadata?.deletionTimestamp)
    const pod = livePods[0]
    const containerStatus = (pod?.status?.containerStatuses ?? []).find(
      (status: Json) => status.name === 'mcp-host'
    )
    const podReadyCondition = (pod?.status?.conditions ?? []).find(
      (condition: Json) => condition.type === 'Ready'
    )
    const currentPodReady =
      livePods.length === 1 &&
      pod?.status?.phase === 'Running' &&
      containerStatus?.ready === true &&
      podReadyCondition?.status === 'True'
    if (
      observedGeneration >= generation &&
      desired === 1 &&
      updated === 1 &&
      ready === 1 &&
      available === 1 &&
      currentPodReady
    ) {
      return
    }
    if (Date.now() >= deadline) {
      throw new Error(`Timed out waiting for one current Ready pod for ${deploymentName}`)
    }
    await new Promise(resolve => setTimeout(resolve, 2_000))
  }
}

function readCredentialAnnotation(hostName: string, annotation: string): string {
  const value = kubectl([
    '-n',
    'mcp-host',
    'get',
    'secret',
    `host-${hostName}-mcp-host-runtime-tokens`,
    '-o',
    `go-template={{index .metadata.annotations "${annotation}"}}`,
  ]).trim()
  return value === '<no value>' || value === '<nil>' ? '' : value
}

function credentialMetadata(hostName: string): {
  revision: string
  bootstrapState: string
  rolloutRequired: string
  issuedAt: string
} {
  const metadata = {
    revision: readCredentialAnnotation(hostName, RUNTIME_TOKEN_SECRET_REVISION_ANNOTATION),
    bootstrapState: readCredentialAnnotation(hostName, RUNTIME_TOKEN_BOOTSTRAP_STATE_ANNOTATION),
    rolloutRequired: readCredentialAnnotation(hostName, RUNTIME_TOKEN_ROLLOUT_REQUIRED_ANNOTATION),
    issuedAt: readCredentialAnnotation(hostName, RUNTIME_TOKEN_ISSUED_AT_ANNOTATION),
  }
  if (Object.values(metadata).some(value => value === '')) {
    throw new Error(`Incomplete runtime credential metadata for ${hostName}`)
  }
  return metadata
}

function deploymentRevisionMetadata(deployment: Json): {
  revision: string
  restartedAt: string
} {
  const annotations = deployment.spec?.template?.metadata?.annotations ?? {}
  return {
    revision: String(annotations[RUNTIME_TOKEN_REVISION_ANNOTATION] ?? ''),
    restartedAt: String(annotations['kubectl.kubernetes.io/restartedAt'] ?? ''),
  }
}

function runtimeStateAllowsPaidTurn(
  runtime: ReturnType<typeof credentialMetadata>,
  deployment: ReturnType<typeof deploymentRevisionMetadata>
): boolean {
  if (runtime.revision === '' || deployment.revision === '') return false
  if (runtime.rolloutRequired !== 'false') return false

  const issuedAt = Date.parse(runtime.issuedAt)
  if (!Number.isFinite(issuedAt)) return false
  if (deployment.restartedAt !== '') {
    const restartedAt = Date.parse(deployment.restartedAt)
    if (!Number.isFinite(restartedAt) || restartedAt > issuedAt) return false
  }

  if (runtime.bootstrapState === 'consumed') {
    return deployment.revision === runtime.revision
  }
  if (runtime.bootstrapState !== 'fresh') return false
  return true
}

async function settleHccRuntimeIdentity(hostName: string): Promise<void> {
  const sinceTime = new Date().toISOString()
  kubectl([
    '-n',
    'mcp-host',
    'annotate',
    `host/${hostName}`,
    `${HCC_RUNTIME_PROBE_ANNOTATION}=${sinceTime}`,
    '--overwrite',
  ])
  const deadline = Date.now() + 180_000
  for (;;) {
    const [deployment, runtime] = await Promise.all([
      jsonAsync(['-n', 'mcp-host', 'get', `deployment/${hostName}`, '-o', 'json']),
      (async () => credentialMetadata(hostName))(),
    ])
    const deploymentRuntime = deploymentRevisionMetadata(deployment)
    if (runtimeStateAllowsPaidTurn(runtime, deploymentRuntime)) {
      break
    }
    if (Date.now() >= deadline) {
      throw new Error(
        `Timed out waiting for settled HCC runtime state for ${hostName}: ` +
          `revision=${runtime.revision || 'missing'}, ` +
          `deploymentRevision=${deploymentRuntime.revision || 'missing'}, ` +
          `bootstrap=${runtime.bootstrapState || 'missing'}, ` +
          `rolloutRequired=${runtime.rolloutRequired || 'missing'}, ` +
          `issuedAt=${runtime.issuedAt || 'missing'}, ` +
          `restartedAt=${deploymentRuntime.restartedAt || 'missing'}`
      )
    }
    await new Promise(resolve => setTimeout(resolve, 2_000))
  }
  await waitForSingleCurrentPod(hostName)
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
  await expect(
    page.getByRole('navigation', { name: 'Chat breadcrumb' }).getByText(hostName, { exact: true })
  ).toBeVisible({ timeout: 30_000 })
}

async function assertEffectiveStatelessModel(page: Page): Promise<void> {
  const selector = page.getByTestId('model-selector-up')
  await expect(selector).toHaveAttribute('data-host-ref', STATELESS_HOST, { timeout: 30_000 })
  await expect(selector).toHaveAttribute('data-provider', EXPECTED_STATELESS_MODEL_PROVIDER, {
    timeout: 30_000,
  })
  await expect(selector).toHaveAttribute('data-model', EXPECTED_STATELESS_MODEL_NAME, {
    timeout: 30_000,
  })
  await expect(page.getByTestId('selected-chat-model')).toHaveAttribute(
    'data-model-id',
    EXPECTED_STATELESS_MODEL_NAME,
    { timeout: 30_000 }
  )
}

async function probeHostModels(
  page: Page,
  hostRef: string
): Promise<{ error: string | null; modelCount: number | null }> {
  return page.evaluate(async targetHostRef => {
    try {
      const result = await window.clerum.rpc.getHostModels(targetHostRef, '')
      const models = (result as unknown as { models?: unknown[] } | null)?.models
      return { error: null, modelCount: Array.isArray(models) ? models.length : null }
    } catch (error) {
      return {
        error: error instanceof Error ? error.message : String(error),
        modelCount: null,
      }
    }
  }, hostRef)
}

async function terminateRunOwnedShellTask(
  page: Page,
  marker: string
): Promise<'cancelled' | 'response'> {
  const response = page.getByTestId('agent-response').filter({ hasText: marker })
  const cancel = page.getByTestId('progress-cancel-btn')
  await expect
    .poll(
      async () => {
        if (await response.isVisible().catch(() => false)) return 'response'
        if (await cancel.isVisible().catch(() => false)) return 'cancel'
        return 'waiting'
      },
      { timeout: 60_000, intervals: [250, 500, 1_000, 2_000, 5_000] }
    )
    .toMatch(/^(?:response|cancel)$/)

  if (await response.isVisible().catch(() => false)) return 'response'

  await expect(cancel).toBeVisible({ timeout: 10_000 })
  await cancel.click()
  await expect(page.locator('.stepper-cancelled-badge')).toBeVisible({ timeout: 30_000 })
  return 'cancelled'
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
  if (!EXPECTED_STATELESS_MODEL_PROVIDER || !EXPECTED_STATELESS_MODEL_NAME) {
    throw new Error(
      'Set E2E_EXPECTED_STATELESS_MODEL_PROVIDER and E2E_EXPECTED_STATELESS_MODEL_NAME so the effective session model cannot drift silently'
    )
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
  let beforeIdentityFileSnapshot: IdentityFileSnapshot | undefined
  let afterIdentityFileSnapshot: IdentityFileSnapshot | undefined
  let shellTaskActive = false
  let shellTaskPage: Page | undefined
  let shellTaskTitle = ''
  let shellTaskMarker = ''
  const runtimeProbeHosts = new Set<string>()
  const cleanupErrors: string[] = []
  let primaryError: unknown
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
    identityFileCoverage: 'unknown',
    statelessRuntimeModelLogAsserted: false,
    initialRuntimeModelProof: null,
    postWakeRuntimeModelProof: null,
    effectiveStatelessModelAsserted: false,
    statelessModelRpcAsserted: false,
    statefulModelRpcAsserted: false,
    postWakeStatelessModelRpcAsserted: false,
    runOwnedShellCleanup: 'not-required',
    statelessSessionId: '',
    statefulSessionId: '',
    reopenedSessionId: '',
    statelessRawTemplateHashBefore: '',
    statelessRawTemplateHashAfter: '',
    statelessRuntimeTokenRevisionBefore: '',
    statelessRuntimeTokenRevisionAfter: '',
  }

  try {
    await test.step('verify policy, seed GFS, and wake through Desktop catalog', async () => {
      expect(hccEnv()).toEqual(BASELINE_HCC_ENV)
      runtimeProbeHosts.add(STATEFUL_HOST)
      await settleHccRuntimeIdentity(STATEFUL_HOST)
      beforeStateful = await hostSnapshot(STATEFUL_HOST, STATEFUL_HOST, false)
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
      runtimeProbeHosts.add(STATELESS_HOST)
      await settleHccRuntimeIdentity(STATELESS_HOST)
      beforeStateless = (await waitForStateless('ready', 270_000)).snapshot
      expect(beforeStateless.readyReplicas).toBe(1)
      beforeIdentityFileSnapshot = identityFileSnapshot(beforeStateless.pods[0]!)

      const mcpServers = json(['-n', 'mcp-server', 'get', 'mcpservers', '-o', 'json'])
      metrics.githubMcpConfigured = (mcpServers.items ?? []).some((item: Json) =>
        /github/i.test(String(item.metadata?.name ?? ''))
      )
    })

    await test.step('run pending stateless work and switch to the stateful Host', async () => {
      const page = firstPage!

      await newChat(page, STATELESS_HOST)
      await assertEffectiveStatelessModel(page)
      metrics.effectiveStatelessModelAsserted = true
      const statelessModels = await probeHostModels(page, STATELESS_HOST)
      expect(
        statelessModels.error,
        `stateless model RPC failed before the first paid turn: ${statelessModels.error}`
      ).toBeNull()
      expect(statelessModels.modelCount ?? 0).toBeGreaterThan(0)
      metrics.statelessModelRpcAsserted = true
      const initialModelLogSince = new Date().toISOString()
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
      const sentinel = `E2E GFS file fixture: ${fixtures!.granted.name}`
      const gfsAck = `PR849_GFS_${runId}`
      const gfsPrompt =
        `Read the file at path "${gfsPath}" in GFS drive main. Its resourceId is ` +
        `${fixtures!.granted.fileResourceId}. Call clerum__gfs_read directly with drive main and ` +
        `that resourceId, then quote its contents verbatim. Begin your final reply with exactly ` +
        `${gfsAck}. Do not answer from memory.`
      const composer = page.getByRole('textbox', { name: 'Agent message composer' })
      await sendAndExpect(page, gfsPrompt, gfsAck)

      const gfsResponse = page.getByTestId('agent-response').filter({ hasText: gfsAck })
      await expect(gfsResponse).toBeVisible({ timeout: 240_000 })
      await expect(gfsResponse).not.toContainText(/not_mounted|gfsc 503|fetch failed/i)
      const expand = gfsResponse.getByTestId('progress-expand-btn')
      await expect(expand).toBeVisible({ timeout: 30_000 })
      await expand.click()
      const readSteps = gfsResponse
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
                    const output = sibling.matches('[data-testid="step-output-panel"]')
                      ? sibling.querySelector('.stepper-step-output-code')
                      : sibling.querySelector(
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
      metrics.initialRuntimeModelProof = proveStatelessRuntimeModel(
        beforeStateless!.pods[0]!,
        initialModelLogSince
      )
      metrics.statelessRuntimeModelLogAsserted = true

      const shellMarker = `PR849_SHELL_${runId}`
      const shellCommand = `printf '${shellMarker}'`
      const shellPrompt =
        `Use the shell tool to run exactly this command: ${shellCommand}. ` +
        `Then reply with exactly ${shellMarker}.`
      await composer.fill(shellPrompt)
      await page.getByTestId('send-button').click()
      shellTaskActive = true
      shellTaskPage = page
      shellTaskTitle = statelessTitle
      shellTaskMarker = shellMarker
      await expect(page.getByTestId('message-list')).toContainText(shellCommand, {
        timeout: 30_000,
      })
      const approvalStepper = page
        .getByTestId('progress-stepper')
        .filter({ hasText: /Shell.*requires approval/i })
      const approval = approvalStepper.getByTestId('approval-approve-btn')
      await expect(approval).toBeVisible({ timeout: 180_000 })
      await expect(approvalStepper).toContainText(/Shell.*requires approval/i)

      await newChat(page, STATEFUL_HOST_DISPLAY)
      const statefulSelector = page.getByTestId('model-selector-up')
      await expect(statefulSelector).toHaveAttribute('data-provider', 'openai', {
        timeout: 30_000,
      })
      await expect(statefulSelector).toHaveAttribute('data-model', 'gpt-5.4-mini', {
        timeout: 30_000,
      })
      const statefulModels = await probeHostModels(page, STATEFUL_HOST)
      expect(
        statefulModels.error,
        `stateful model RPC failed before the control turn: ${statefulModels.error}`
      ).toBeNull()
      expect(statefulModels.modelCount ?? 0).toBeGreaterThan(0)
      metrics.statefulModelRpcAsserted = true
      await expect(page.getByTestId('message-list')).not.toContainText(gfsPath)
      await expect(page.getByTestId('message-list')).not.toContainText(shellCommand)
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
      await expect(page.getByTestId('message-list')).toContainText(shellCommand)
      await expect(approval).toBeVisible({
        timeout: 30_000,
      })
      metrics.approvalPendingAcrossHostSwitch = true
      await approval.click()
      const shellResponse = page.getByTestId('agent-response').filter({ hasText: shellMarker })
      await expect(shellResponse).toBeVisible({ timeout: 240_000 })
      await expect(approval).toBeHidden({ timeout: 30_000 })
      await expect(composer).toHaveValue('', { timeout: 30_000 })
      await expect(page.getByTestId('send-button')).toBeDisabled({ timeout: 30_000 })

      const shellExpand = shellResponse.getByTestId('progress-expand-btn')
      await expect(shellExpand).toBeVisible({ timeout: 30_000 })
      await shellExpand.click()
      const shellSteps = shellResponse
        .locator('.stepper-step')
        .filter({ has: page.locator('.stepper-step-fn', { hasText: 'shell_exec' }) })
      let openedShellStep = false
      for (const shellStep of await shellSteps.all()) {
        await shellStep.click()
        openedShellStep = true
      }
      expect(openedShellStep, 'the turn must contain a shell_exec step').toBe(true)
      await expect
        .poll(
          () =>
            shellSteps.evaluateAll(
              (steps, expected) =>
                steps.some(step => {
                  if (
                    !step.querySelector('.stepper-step-icon.state-completed') ||
                    step.querySelector('.stepper-step-icon.state-error')
                  ) {
                    return false
                  }
                  let sibling = step.nextElementSibling
                  let inputMatches = false
                  let outputMatches = false
                  while (
                    sibling &&
                    !sibling.classList.contains('stepper-step') &&
                    !sibling.classList.contains('stepper-iteration-divider')
                  ) {
                    const input = sibling.matches('[data-testid="step-input-preview"]')
                      ? sibling
                      : sibling.querySelector('[data-testid="step-input-preview"]')
                    const output = sibling.matches('[data-testid="step-output-panel"]')
                      ? sibling.querySelector('.stepper-step-output-code')
                      : sibling.querySelector(
                          '[data-testid="step-output-panel"] .stepper-step-output-code'
                        )
                    if (input?.textContent?.includes(expected.command) === true) {
                      inputMatches = true
                    }
                    if (output?.textContent?.includes(expected.marker) === true) {
                      outputMatches = true
                    }
                    sibling = sibling.nextElementSibling
                  }
                  return inputMatches && outputMatches
                }),
              { command: shellCommand, marker: shellMarker }
            ),
          { timeout: 30_000 }
        )
        .toBe(true)
      shellTaskActive = false
      shellTaskPage = undefined

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
      const relaunchBefore = await hostSnapshot(STATELESS_HOST, STATELESS_HOST, true)
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
      const retainedMarker = page.getByTestId('agent-response').filter({ hasText: statelessMarker })
      const retainedGfs = page
        .getByTestId('agent-response')
        .filter({ hasText: `PR849_GFS_${runId}` })
      await expect(retainedMarker).toBeVisible({ timeout: 90_000 })
      await expect(retainedGfs).toBeVisible({ timeout: 90_000 })
      metrics.secondLaunchToCachedTranscriptMs = Date.now() - launchStarted
      const cachedVisibleAt = Date.now()
      await readinessObserver
      if (readinessFailure) throw readinessFailure
      if (!readyObservedAt || !afterStateless) {
        throw new Error(`${STATELESS_HOST} readiness observer completed without a Ready snapshot`)
      }
      afterStateful = await hostSnapshot(STATEFUL_HOST, STATEFUL_HOST, false)
      metrics.secondLaunchToReadyMs = readyObservedAt - launchStarted
      metrics.cacheVisibleBeforeReadyObserved =
        readyObservedAt !== null && cachedVisibleAt < readyObservedAt
      await assertEffectiveStatelessModel(page)
      metrics.effectiveStatelessModelAsserted = true
      const postWakeModels = await probeHostModels(page, STATELESS_HOST)
      expect(
        postWakeModels.error,
        `stateless model RPC failed after wake: ${postWakeModels.error}`
      ).toBeNull()
      expect(postWakeModels.modelCount ?? 0).toBeGreaterThan(0)
      metrics.postWakeStatelessModelRpcAsserted = true
      metrics.reopenedSessionId = await page.evaluate(
        hostRef => window.clerum.chat.getLastActive(hostRef),
        STATELESS_HOST
      )
      expect(metrics.reopenedSessionId).toBe(metrics.statelessSessionId)

      const followStarted = Date.now()
      const postWakeModelLogSince = new Date().toISOString()
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
      metrics.postWakeRuntimeModelProof = proveStatelessRuntimeModel(
        afterStateless!.pods[0]!,
        postWakeModelLogSince
      )
      metrics.statelessRuntimeModelLogAsserted = true

      await openSession(page, statefulTitle, STATEFUL_HOST_DISPLAY)
      await expect(
        page.getByTestId('agent-response').filter({ hasText: statefulMarker })
      ).toBeVisible()
      await expect(page.getByTestId('message-list')).not.toContainText(statelessCode)
    })

    const checks = {
      hostUidStable: afterStateless!.hostUid === beforeStateless!.hostUid,
      templateStable: afterStateless!.templateHash === beforeStateless!.templateHash,
      rawTemplateChanged: afterStateless!.rawTemplateHash !== beforeStateless!.rawTemplateHash,
      runtimeTokenRevisionChanged:
        afterStateless!.runtimeTokenRevision !== beforeStateless!.runtimeTokenRevision,
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
    afterIdentityFileSnapshot = identityFileSnapshot(afterStateless!.pods[0]!)
    expect(afterIdentityFileSnapshot).toEqual(beforeIdentityFileSnapshot)
    const identityAndSoulNonEmpty = (['IDENTITY.md', 'SOUL.md'] as const).every(
      (file: IdentityFileName) =>
        beforeIdentityFileSnapshot?.[file].exists === true &&
        beforeIdentityFileSnapshot[file].sha256 !== EMPTY_FILE_SHA256
    )
    const anyIdentityFilePresent = Object.values(beforeIdentityFileSnapshot ?? {}).some(
      state => state.exists
    )
    metrics.identityFileCoverage = !anyIdentityFilePresent
      ? 'empty-config-only'
      : identityAndSoulNonEmpty
        ? 'nonempty-config'
        : 'empty-or-partial-config'
    if (REQUIRE_IDENTITY_FILES) {
      expect(metrics.identityFileCoverage).toBe('nonempty-config')
    }
    metrics.effectiveIdentityFileHashesAsserted = true
    Object.assign(metrics, checks)
    expect(checks).toEqual({
      hostUidStable: true,
      templateStable: true,
      rawTemplateChanged: true,
      runtimeTokenRevisionChanged: true,
      declaredParametersStable: true,
      pvcStable: true,
      sqliteStable: true,
      imageStable: true,
      statelessPodChanged: true,
      statefulPodStable: true,
    })
    metrics.statelessRawTemplateHashBefore = beforeStateless!.rawTemplateHash
    metrics.statelessRawTemplateHashAfter = afterStateless!.rawTemplateHash
    metrics.statelessRuntimeTokenRevisionBefore = beforeStateless!.runtimeTokenRevision
    metrics.statelessRuntimeTokenRevisionAfter = afterStateless!.runtimeTokenRevision
  } catch (error) {
    primaryError = error
    throw error
  } finally {
    cancelReadinessObserver = true
    await readinessObserver
    for (const hostName of runtimeProbeHosts) {
      try {
        kubectl([
          '-n',
          'mcp-host',
          'annotate',
          `host/${hostName}`,
          `${HCC_RUNTIME_PROBE_ANNOTATION}-`,
        ])
      } catch (error) {
        cleanupErrors.push(
          `HCC runtime probe cleanup ${hostName}: ${
            error instanceof Error ? error.message : String(error)
          }`
        )
      }
    }
    if (shellTaskActive && shellTaskPage && app) {
      try {
        await openSession(shellTaskPage, shellTaskTitle, STATELESS_HOST)
        metrics.runOwnedShellCleanup = await terminateRunOwnedShellTask(
          shellTaskPage,
          shellTaskMarker
        )
        shellTaskActive = false
      } catch (error) {
        cleanupErrors.push(
          `Run-owned Shell task termination: ${
            error instanceof Error ? error.message : String(error)
          }`
        )
      }
    }
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
    if (cleanupErrors.length > 0) {
      await testInfo.attach('pr849-controlled-parity-cleanup-errors', {
        body: cleanupErrors.join('\n'),
        contentType: 'text/plain',
      })
      if (!primaryError) throw new Error(cleanupErrors.join('; '))
    }
  }
})
