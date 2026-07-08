/**
 * Desktop App + Control UI -- Custom Coordinator SDK Happy Path
 *
 * Proves the Layer 3B user flow:
 *   control-ui admin installs a WorkflowRecipe with coordinatorImage
 *     -> admin grants test@clerum.io trigger access
 *     -> Desktop App user sees the granted workflow
 *     -> Desktop App user triggers it with custom inputs
 *     -> WRC creates a per-run child WorkflowRecipe
 *     -> the child coordinator pod uses clerum/workflow-custom-sdk-e2e:test
 *     -> the custom coordinator reports status.artifacts[]
 *     -> Desktop App and Control UI download the run-scoped artifact
 */
import { type Locator, type Page, expect, test } from '@playwright/test'
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
  E2E_EMAIL,
  EXT_API,
  K8S_CONTEXT,
  apiListWorkflowRuns,
  apiRequest,
  clearSession,
  launchAndLogin,
  loginAs,
  openWorkflowsPage,
  selectWorkflow,
  workflowRow,
} from './workflowUi'

const CONTROL_API = process.env.CONTROL_API_BASE_URL || 'http://127.0.0.1:8090'
const CONTROL_UI =
  process.env.CONTROL_UI_BASE_URL || process.env.CONTROL_UI_URL || 'http://127.0.0.1:3000'
const ADMIN_USERNAME = process.env.E2E_ADMIN_USERNAME || process.env.ADMIN_USER || 'admin'
const ADMIN_PASSWORD =
  process.env.E2E_ADMIN_PASSWORD || process.env.ADMIN_PASSWORD || process.env.ADMIN_PASS
const RECIPE_NS = 'sandbox-recipes'
const MCP_SERVER_NS = 'mcp-server'
const CUSTOM_IMAGE = 'clerum/workflow-custom-sdk-e2e:test'
const MCP_HOST_IMAGE = 'clerum/mcp-host:test'
const RECIPE_NAME = `e2e-ui-custom-coord-${Date.now()}`
const ARTIFACT_NAME = 'custom-sdk-result.json'
const BROKER_RECIPE_NAME = `e2e-ui-custom-coord-broker-${Date.now()}`
const RWO_AFFINITY_RECIPE_NAME = `e2e-ui-output-rwo-${Date.now()}`
const SUMMARY_ARTIFACT_NAME = 'custom-risk-summary.md'
const WORKFLOW_OUTPUT_CLAIM_LABEL = 'clerum.io/workflow-output-claim'
const WORKFLOW_OUTPUT_SCOPE_LABEL = 'clerum.io/workflow-output-scope'
const WORKFLOW_OUTPUT_ANCHOR_COMPONENT = 'workflow-output-anchor'
const WORKFLOW_OUTPUT_PREPARE_COMPONENT = 'workflow-output-prepare'
const WORKFLOW_OUTPUT_ROOT_MOUNT_PATH = '/workflow-output-root'
const RUN_MAX_DURATION_SECONDS = 600
const RUN_TTL_SECONDS_AFTER_FINISHED = 7200
const KUBECTL_MAX_BUFFER = 16 * 1024 * 1024

type WrcEnvSnapshot = Record<string, string | undefined>
type K8sEnvVar = {
  name?: string
  value?: string
  valueFrom?: { secretKeyRef?: { name?: string; key?: string } }
}
type K8sVolumeMount = {
  name?: string
  mountPath?: string
  readOnly?: boolean
  subPath?: string
}
type K8sSecurityContext = {
  runAsUser?: number
  runAsGroup?: number
  runAsNonRoot?: boolean
  readOnlyRootFilesystem?: boolean
  allowPrivilegeEscalation?: boolean
  capabilities?: { drop?: string[]; add?: string[] }
  seccompProfile?: { type?: string }
}
type K8sPod = {
  metadata?: { name?: string; labels?: Record<string, string> }
  spec?: {
    automountServiceAccountToken?: boolean
    enableServiceLinks?: boolean
    hostNetwork?: boolean
    hostPID?: boolean
    hostIPC?: boolean
    nodeName?: string
    securityContext?: K8sSecurityContext
    affinity?: {
      podAffinity?: {
        requiredDuringSchedulingIgnoredDuringExecution?: Array<{
          labelSelector?: {
            matchExpressions?: Array<{ key?: string; operator?: string; values?: string[] }>
          }
          topologyKey?: string
        }>
      }
    }
    containers?: Array<{
      image?: string
      env?: K8sEnvVar[]
      volumeMounts?: K8sVolumeMount[]
      securityContext?: K8sSecurityContext
    }>
    volumes?: Array<{
      name?: string
      secret?: { secretName?: string; defaultMode?: number }
      persistentVolumeClaim?: { claimName?: string }
    }>
  }
  status?: { phase?: string }
}
type K8sPvc = {
  metadata?: {
    name?: string
    annotations?: Record<string, string>
    labels?: Record<string, string>
  }
  spec?: {
    accessModes?: string[]
    resources?: { requests?: { storage?: string } }
    storageClassName?: string
  }
}
type K8sWorkflowRecipe = {
  spec?: { contextRef?: string }
  status?: {
    phase?: string
    workflowExecution?: { phase?: string; message?: string }
    workloadInstances?: Record<string, string>
  }
}
type K8sCondition = {
  type?: string
  status?: string
  observedGeneration?: number
  reason?: string
  message?: string
}
type K8sMcpServer = {
  metadata?: { generation?: number }
  spec?: { contextRef?: string }
  status?: { conditions?: K8sCondition[] }
}
type K8sContext = {
  spec?: { mcpServers?: string[] }
}
type K8sEndpoints = {
  subsets?: Array<{ addresses?: unknown[] }>
}
type CustomArtifactPayload = {
  workflowName?: string
  coordinatorImage?: string
  orderedStepIds?: string[]
  previousOutputKeys?: string[]
  tokenRotationProbe?: {
    tokenRotationProbe?: boolean
    waitedMs?: number
    finalStatusUsesCurrentTokenFile?: boolean
  }
  unsafeArtifactAttempted?: boolean
  businessDecision?: {
    requestId?: string
    approvalThreshold?: number
    publicHttp?: {
      attempted?: boolean
      host?: string
      api?: string
      status?: number
      repoFullName?: string
      private?: boolean
    }
    declaredWorkload?: {
      attempted?: boolean
      workloadId?: string
      status?: number
      bodyStatus?: string
      tools?: string[]
    }
    highRiskAccounts?: string[]
    outstandingAmount?: number
    weightedRiskScore?: number
    manualReviewRequired?: boolean
  }
  brokerBacked?: {
    modelUsed?: string
    mcpDataUsed?: boolean
    tools?: Array<{ serverName?: string; toolName?: string; args?: Record<string, unknown> }>
    outputExcerpt?: string
  }
}
type WorkflowRunArtifactDto = { name: string; format?: string; path?: unknown }
type WorkflowRunSummary = {
  id: string
  phase: string
  actor: { type?: string; userId?: string; hostRef?: string } | null
  executionRef: { namespace: string; name: string } | null
}
type RunRetentionPolicy = {
  maxDurationSeconds: number | null
  ttlSecondsAfterFinished: number | null
}

const EXPECTED_DATA_ARTIFACTS = [
  { name: ARTIFACT_NAME, format: 'json' },
  { name: SUMMARY_ARTIFACT_NAME, format: 'md' },
] as const

const WRC_POLICY_ENV_NAMES = [
  'WRC_ENABLE_CUSTOM_COORDINATOR_IMAGE',
  'WRC_ALLOWED_COORDINATOR_IMAGE_PREFIXES',
  'WRC_REQUIRE_COORDINATOR_IMAGE_DIGEST',
]

function requireAdminPassword(): string {
  if (!ADMIN_PASSWORD) {
    throw new Error(
      'E2E_ADMIN_PASSWORD is required for Control UI recipe installation. Set E2E_ADMIN_PASSWORD or ADMIN_PASSWORD.'
    )
  }
  return ADMIN_PASSWORD
}

function sqlLiteral(value: string): string {
  return `'${value.replace(/'/g, "''")}'`
}

function kubectl(args: string[], input?: string, timeout = 30_000): string {
  return execFileSync('kubectl', ['--context', K8S_CONTEXT, ...args], {
    encoding: 'utf-8',
    input,
    maxBuffer: KUBECTL_MAX_BUFFER,
    timeout,
  })
}

function kubectlJson<T>(args: string[], timeout = 30_000): T {
  return JSON.parse(kubectl(args, undefined, timeout)) as T
}

function privateWorkflowContextName(recipeName: string): string {
  const base = `wf-${recipeName}`
  if (base.length <= 63) return base

  const hash = createHash('sha256').update(base).digest('hex').slice(0, 8)
  const maxStemLength = 63 - hash.length - 1
  const stem = base.slice(0, maxStemLength).replace(/-+$/g, '') || 'wf'
  return `${stem}-${hash}`
}

function conditionIsTrue(
  resource: { metadata?: { generation?: number }; status?: { conditions?: K8sCondition[] } },
  type: string
): boolean {
  const generation = resource.metadata?.generation
  return (resource.status?.conditions ?? []).some(condition => {
    if (condition.type !== type || condition.status !== 'True') return false
    return (
      typeof generation !== 'number' ||
      typeof condition.observedGeneration !== 'number' ||
      condition.observedGeneration >= generation
    )
  })
}

function readyEndpointAddressCount(name: string): number {
  const endpoints = kubectlJson<K8sEndpoints>([
    '-n',
    'mcp-server',
    'get',
    'endpoints',
    name,
    '-o',
    'json',
  ])
  return (endpoints.subsets ?? []).reduce(
    (count, subset) => count + (subset.addresses?.length ?? 0),
    0
  )
}

function runProfilesSql(sql: string, timeout = 20_000): void {
  kubectl(
    [
      '-n',
      'control-plane',
      'exec',
      'deploy/control-postgres',
      '--',
      'psql',
      '-v',
      'ON_ERROR_STOP=1',
      '-U',
      'postgres',
      '-d',
      'profiles',
      '-c',
      sql,
    ],
    undefined,
    timeout
  )
}

function runProfilesScalar(sql: string, timeout = 20_000): string {
  return kubectl(
    [
      '-n',
      'control-plane',
      'exec',
      'deploy/control-postgres',
      '--',
      'psql',
      '-t',
      '-A',
      '-v',
      'ON_ERROR_STOP=1',
      '-U',
      'postgres',
      '-d',
      'profiles',
      '-c',
      sql,
    ],
    undefined,
    timeout
  ).trim()
}

function readRunRetentionPolicy(runId: string): RunRetentionPolicy {
  const raw = runProfilesScalar(
    `SELECT json_build_object(
       'maxDurationSeconds', max_duration_seconds,
       'ttlSecondsAfterFinished', ttl_seconds_after_finished
     )::text
       FROM workflow_runs
      WHERE run_id = ${sqlLiteral(runId)};`
  )
  expect(raw, `workflow_runs row should exist for ${runId}`).toBeTruthy()
  return JSON.parse(raw) as RunRetentionPolicy
}

function readRunIdentity(runId: string): {
  actorType: string
  usageTeamId: string | null
  approvalRequestId: string | null
} {
  const raw = runProfilesScalar(
    `SELECT json_build_object(
       'actorType', actor_type,
       'usageTeamId', usage_team_id,
       'approvalRequestId', approval_request_id
     )::text
       FROM workflow_runs
      WHERE run_id = ${sqlLiteral(runId)};`
  )
  expect(raw, `workflow_runs row should exist for ${runId}`).toBeTruthy()
  return JSON.parse(raw) as {
    actorType: string
    usageTeamId: string | null
    approvalRequestId: string | null
  }
}

function assertRunRetentionPolicy(runId: string): void {
  expect(readRunRetentionPolicy(runId)).toEqual({
    maxDurationSeconds: RUN_MAX_DURATION_SECONDS,
    ttlSecondsAfterFinished: RUN_TTL_SECONDS_AFTER_FINISHED,
  })
}

function captureWrcPolicyEnv(): WrcEnvSnapshot {
  const deploy = kubectlJson<{
    spec?: { template?: { spec?: { containers?: Array<{ name?: string; env?: unknown[] }> } } }
  }>(['-n', 'control-plane', 'get', 'deploy/workflow-recipes', '-o', 'json'])
  const container = deploy.spec?.template?.spec?.containers?.find(
    c => c.name === 'workflow-recipes'
  )
  const env = Array.isArray(container?.env)
    ? (container?.env as Array<Record<string, unknown>>)
    : []
  return Object.fromEntries(
    WRC_POLICY_ENV_NAMES.map(name => {
      const item = env.find(e => e.name === name)
      return [name, typeof item?.value === 'string' ? item.value : undefined]
    })
  )
}

function wrcPolicyPodState(): string {
  const pods = kubectlJson<{
    items?: Array<{
      metadata?: { deletionTimestamp?: string }
      status?: { phase?: string }
      spec?: { containers?: Array<{ name?: string; env?: K8sEnvVar[] }> }
    }>
  }>(['-n', 'control-plane', 'get', 'pods', '-l', 'app=workflow-recipes', '-o', 'json'])
  const activePods = (pods.items ?? []).filter(
    pod => pod.status?.phase === 'Running' && !pod.metadata?.deletionTimestamp
  )
  if (activePods.length !== 1) return `pods=${activePods.length}`
  const envVars = activePods[0].spec?.containers?.find(
    container => container.name === 'workflow-recipes'
  )?.env
  const envByName = new Map((envVars ?? []).map(env => [env.name, env.value ?? '']))
  return WRC_POLICY_ENV_NAMES.map(name => `${name}=${envByName.get(name) ?? ''}`).join(';')
}

async function waitForWrcPolicyEnv(snapshot: WrcEnvSnapshot): Promise<void> {
  const expectedState = WRC_POLICY_ENV_NAMES.map(name => `${name}=${snapshot[name] ?? ''}`).join(
    ';'
  )
  await expect
    .poll(wrcPolicyPodState, {
      timeout: 60_000,
      intervals: [500, 1_000, 2_000],
      message:
        'workflow-recipes running pod should reflect the requested custom coordinator policy',
    })
    .toBe(expectedState)
}

async function setWrcPolicyEnv(
  enabled: boolean,
  prefixes: string,
  requireDigest: boolean
): Promise<void> {
  applyWrcPolicyEnv(enabled, prefixes, requireDigest)
  await waitForWrcPolicyEnv({
    WRC_ENABLE_CUSTOM_COORDINATOR_IMAGE: String(enabled),
    WRC_ALLOWED_COORDINATOR_IMAGE_PREFIXES: prefixes,
    WRC_REQUIRE_COORDINATOR_IMAGE_DIGEST: String(requireDigest),
  })
}

function applyWrcPolicyEnv(enabled: boolean, prefixes: string, requireDigest: boolean): void {
  kubectl([
    '-n',
    'control-plane',
    'set',
    'env',
    'deployment/workflow-recipes',
    `WRC_ENABLE_CUSTOM_COORDINATOR_IMAGE=${String(enabled)}`,
    `WRC_ALLOWED_COORDINATOR_IMAGE_PREFIXES=${prefixes}`,
    `WRC_REQUIRE_COORDINATOR_IMAGE_DIGEST=${String(requireDigest)}`,
  ])
  kubectl(
    ['-n', 'control-plane', 'rollout', 'status', 'deployment/workflow-recipes', '--timeout=180s'],
    undefined,
    190_000
  )
}

async function restoreWrcPolicyEnv(snapshot: WrcEnvSnapshot): Promise<void> {
  const args = WRC_POLICY_ENV_NAMES.map(name =>
    snapshot[name] === undefined ? `${name}-` : `${name}=${snapshot[name]}`
  )
  kubectl(['-n', 'control-plane', 'set', 'env', 'deployment/workflow-recipes', ...args])
  kubectl(
    ['-n', 'control-plane', 'rollout', 'status', 'deployment/workflow-recipes', '--timeout=180s'],
    undefined,
    190_000
  )
  await waitForWrcPolicyEnv(snapshot)
}

function buildRecipeManifest(
  name: string,
  options: { brokerBacked?: boolean; outputAffinityProbe?: boolean } = {}
): Record<string, unknown> {
  const workloads = [
    {
      id: 'business-api',
      type: 'deployment',
      image: 'clerum/mock-mcp-server:test',
      port: 3001,
      healthCheck: { type: 'tcp', port: 3001 },
      resources: {
        requests: { cpu: '50m', memory: '64Mi' },
        limits: { cpu: '200m', memory: '128Mi' },
      },
    },
    ...(options.brokerBacked || options.outputAffinityProbe
      ? [
          {
            id: 'mock-tools',
            type: 'deployment',
            image: 'clerum/mock-mcp-server:test',
            port: 3000,
            transport: { type: 'streamableHttp', path: '/mcp' },
            healthCheck: { type: 'tcp', port: 3001 },
            resources: {
              requests: { cpu: '50m', memory: '64Mi' },
              limits: { cpu: '200m', memory: '128Mi' },
            },
          },
        ]
      : []),
  ]
  const steps = options.outputAffinityProbe
    ? [
        {
          id: 'wait-for-token-rotation',
          agent: { provider: 'zai', model: 'glm-4.7' },
          mcpServers: ['mock-tools'],
          allowedTools: { include: ['mock-tools__add'] },
        },
        { id: 'emit', dependsOn: ['wait-for-token-rotation'] },
      ]
    : options.brokerBacked
      ? [
          { id: 'prepare' },
          {
            id: 'broker-review',
            dependsOn: ['prepare'],
            instruction:
              'Use the mock-tools add tool exactly once with a=40 and b=2. Return a concise JSON summary that includes the requestId and the tool result. Prepared data: {{prepare:output}}',
            agent: { provider: 'zai', model: 'glm-4.7' },
            mcpServers: ['mock-tools'],
            allowedTools: { include: ['mock-tools__add'] },
            maxIterations: 6,
          },
          { id: 'emit', dependsOn: ['broker-review'] },
        ]
      : [
          { id: 'prepare' },
          { id: 'transform', dependsOn: ['prepare'] },
          { id: 'emit', dependsOn: ['transform'] },
        ]

  return {
    apiVersion: 'clerum.io/v1alpha1',
    kind: 'WorkflowRecipe',
    metadata: { name },
    spec: {
      coordinatorImage: CUSTOM_IMAGE,
      runtimeEgress: {
        http: {
          allowedHosts: ['api.github.com'],
        },
      },
      workloads,
      inputContract: {
        type: 'object',
        properties: {
          requestId: {
            type: 'string',
            default: 'ui-custom-default',
          },
          approvalThreshold: {
            type: 'number',
            default: 1000,
          },
          scenario: {
            type: 'string',
            default: 'receivables-risk-reconciliation',
          },
        },
      },
      triggers: {
        onDemand: {
          requiresApproval: false,
          allowedActors: ['user'],
        },
      },
      runRetention: {
        maxRunDurationSeconds: RUN_MAX_DURATION_SECONDS,
        ttlSecondsAfterFinished: RUN_TTL_SECONDS_AFTER_FINISHED,
      },
      output: {
        destination: 'pvc',
        format: 'json',
        storageSize: '128Mi',
      },
      ...(options.outputAffinityProbe
        ? {
            inputs: {
              tokenRotationInitialDelayMs: 2500,
              tokenRotationProjectionDelayMs: 90000,
            },
          }
        : {}),
      steps,
    },
  }
}

async function waitForDesktopTriggerSuccess(page: Page): Promise<void> {
  const success = page.getByRole('status').filter({ hasText: 'Workflow triggered.' })
  const failure = page.getByRole('alert').filter({ hasText: /Trigger failed:/ })
  let observed: 'pending' | 'success' | 'failure' = 'pending'

  try {
    await expect
      .poll(
        async () => {
          if (await success.isVisible().catch(() => false)) {
            observed = 'success'
          } else if (await failure.isVisible().catch(() => false)) {
            observed = 'failure'
          } else {
            observed = 'pending'
          }
          return observed
        },
        {
          timeout: 10_000,
          intervals: [250, 500, 1_000],
          message: 'Desktop App should show either trigger success or trigger failure',
        }
      )
      .not.toBe('pending')
  } catch (error) {
    const bodyText = await page
      .locator('body')
      .innerText({ timeout: 1_000 })
      .catch(() => '')
    const message = error instanceof Error ? error.message : String(error)
    throw new Error(
      [
        `Desktop trigger did not surface success or failure: ${message}`,
        bodyText ? `visibleBody=${bodyText.slice(0, 2000)}` : '',
      ]
        .filter(Boolean)
        .join('\n')
    )
  }

  if (observed === 'failure') {
    const failureText = await failure
      .first()
      .innerText()
      .catch(() => 'Trigger failed')
    throw new Error(`Desktop trigger failed visibly: ${failureText}`)
  }
}

async function controlUiLogin(page: Page): Promise<string> {
  const password = requireAdminPassword()
  await page.goto(CONTROL_UI)
  const usernameInput = page.getByLabel('Username')
  const passwordInput = page.getByLabel('Password')
  await expect(usernameInput).toBeVisible({ timeout: 20_000 })
  await expect(passwordInput).toBeVisible({ timeout: 20_000 })
  await usernameInput.fill(ADMIN_USERNAME)
  await passwordInput.fill(password)
  const signInButton = page.getByRole('button', { name: /^Sign in$/ })
  await expect(signInButton).toBeEnabled({ timeout: 10_000 })
  await signInButton.click()
  await expect(page.getByText('Workflow Recipes', { exact: false })).toBeVisible({
    timeout: 25_000,
  })
  const token = await page.evaluate(() => localStorage.getItem('controlUiAdminToken') ?? '')
  expect(token, 'Control UI should persist admin token after login').toBeTruthy()
  return token
}

async function installRecipeFromControlUi(
  page: Page,
  recipeName: string,
  userEmail: string,
  options: { brokerBacked?: boolean } = {}
): Promise<string> {
  const adminToken = await controlUiLogin(page)
  await page.goto(`${CONTROL_UI}/workflow-recipes`)
  await page.getByRole('button', { name: 'Install Recipe' }).click()

  const editor = page.locator('textarea').first()
  await expect(editor).toBeVisible({ timeout: 15_000 })
  await editor.fill(JSON.stringify(buildRecipeManifest(recipeName, options), null, 2))
  await page.getByRole('button', { name: 'Validate' }).click()
  await expect(page.getByText(/Validation passed/i)).toBeVisible({ timeout: 15_000 })

  const userPicker = page.getByLabel('Pick a user to grant trigger access')
  await expect(userPicker).toBeVisible({ timeout: 20_000 })
  const optionValue = await userPicker
    .locator('option')
    .filter({ hasText: userEmail })
    .first()
    .getAttribute('value')
  expect(optionValue, `${userEmail} should be selectable in Control UI grants panel`).toBeTruthy()
  await userPicker.selectOption(optionValue!)
  await page.getByRole('button', { name: 'Grant user' }).click()
  await expect(page.getByTestId('workflow-access-trigger-users')).toContainText(userEmail, {
    timeout: 10_000,
  })

  await page.getByRole('button', { name: 'Deploy Recipe' }).click()
  await expect(page.locator('textarea')).toHaveCount(0, { timeout: 45_000 })
  await expect(page.getByRole('link', { name: `Open ${recipeName}` })).toBeVisible({
    timeout: 45_000,
  })
  return adminToken
}

async function openControlUiRecipeDetail(page: Page, recipeName: string): Promise<void> {
  await page.goto(
    `${CONTROL_UI}/workflow-recipes/${encodeURIComponent(RECIPE_NS)}/${encodeURIComponent(recipeName)}`
  )
  await expect(page.getByRole('heading', { name: recipeName })).toBeVisible({ timeout: 30_000 })
}

async function triggerControlUiOperatorRun(
  page: Page,
  recipeName: string,
  inputs: { requestId: string; approvalThreshold: string; scenario: string },
  adminToken: string
): Promise<string> {
  await openControlUiRecipeDetail(page, recipeName)
  const previousRunIds = new Set(
    (await apiListAdminWorkflowRuns(adminToken, recipeName, 20)).items.map(item => item.id)
  )

  const runButton = page.getByRole('button', { name: /^Run/ }).first()
  await expect(runButton).toBeEnabled({ timeout: 90_000 })
  await runButton.click()

  const dialog = page.getByRole('dialog')
  await expect(dialog).toBeVisible({ timeout: 15_000 })
  await expect(
    dialog.getByRole('heading', { name: new RegExp(`Run .*${recipeName}`) })
  ).toBeVisible()
  await expect(dialog.getByText(/Starts an on-demand operator run in/i)).toBeVisible()

  await dialog.getByLabel('requestId', { exact: true }).fill(inputs.requestId)
  await dialog.getByLabel('approvalThreshold', { exact: true }).fill(inputs.approvalThreshold)
  await dialog.getByLabel('scenario', { exact: true }).fill(inputs.scenario)
  await dialog.getByRole('button', { name: /^Run as operator$/ }).click()

  let runId = ''
  await expect
    .poll(
      async () => {
        const runs = await apiListAdminWorkflowRuns(adminToken, recipeName, 20)
        const fresh = runs.items.find(item => !previousRunIds.has(item.id))
        runId = fresh?.id ?? ''
        return runId || null
      },
      {
        timeout: 60_000,
        intervals: [500, 1_000, 2_000],
        message: 'Control UI operator trigger should create an admin workflow run',
      }
    )
    .not.toBeNull()

  await page.goto(
    `${CONTROL_UI}/workflow-recipes/${encodeURIComponent(RECIPE_NS)}/${encodeURIComponent(recipeName)}/runs/${encodeURIComponent(runId)}`
  )
  await expect(page).toHaveURL(new RegExp(`/runs/${runId}$`), { timeout: 30_000 })
  await expect(page.getByRole('heading', { name: `Run ${runId.slice(0, 8)}` })).toBeVisible({
    timeout: 30_000,
  })
  return runId
}

async function waitForRecipeWorkflowPhase(
  name: string,
  expected: string,
  timeoutMs: number
): Promise<K8sWorkflowRecipe> {
  let last: K8sWorkflowRecipe = {}
  await expect
    .poll(
      () => {
        try {
          last = kubectlJson<K8sWorkflowRecipe>([
            '-n',
            RECIPE_NS,
            'get',
            'workflowrecipe',
            name,
            '-o',
            'json',
          ])
          const phase = last.status?.workflowExecution?.phase ?? ''
          if (phase === 'failed' && expected !== 'failed') {
            return `failed:${last.status?.workflowExecution?.message ?? ''}`
          }
          return phase
        } catch {
          return ''
        }
      },
      {
        timeout: timeoutMs,
        intervals: [2_000, 5_000],
        message: `WorkflowRecipe ${RECIPE_NS}/${name} should reach workflowExecution.phase=${expected}`,
      }
    )
    .toBe(expected)
  return last
}

async function waitForAdminRecipeActive(adminToken: string, name: string): Promise<void> {
  await expect
    .poll(
      async () => {
        const res = await apiRequest(
          'GET',
          `${CONTROL_API}/api/v1/admin/workflows/${RECIPE_NS}/${name}`,
          undefined,
          { Authorization: `Bearer ${adminToken}` }
        )
        if (res.status !== 200) return `http-${res.status}`
        const parsed = JSON.parse(res.body) as { status?: { phase?: string } }
        return parsed.status?.phase ?? ''
      },
      {
        timeout: 300_000,
        intervals: [2_000, 5_000],
        message: `admin recipe ${RECIPE_NS}/${name} should become active`,
      }
    )
    .toBe('active')
}

async function waitForTransportRuntimeReady(
  recipeName: string,
  workloadId: string,
  timeoutMs = 180_000
): Promise<string> {
  let mcpServerName = ''
  await expect
    .poll(
      () => {
        try {
          const recipe = kubectlJson<K8sWorkflowRecipe>([
            '-n',
            RECIPE_NS,
            'get',
            'workflowrecipe',
            recipeName,
            '-o',
            'json',
          ])
          if (recipe.status?.phase !== 'active') {
            return `recipe:${recipe.status?.phase ?? 'missing-phase'}`
          }

          mcpServerName = recipe.status?.workloadInstances?.[workloadId] ?? ''
          if (!mcpServerName) return `workload-instance:${workloadId}:missing`

          const mcpServer = kubectlJson<K8sMcpServer>([
            '-n',
            MCP_SERVER_NS,
            'get',
            'mcpserver',
            mcpServerName,
            '-o',
            'json',
          ])
          if (!conditionIsTrue(mcpServer, 'Ready')) {
            const readyCondition = (mcpServer.status?.conditions ?? []).find(
              c => c.type === 'Ready'
            )
            return `mcpserver:${mcpServerName}:not-ready:${readyCondition?.reason ?? 'pending'}`
          }

          const contextRef =
            mcpServer.spec?.contextRef?.trim() ||
            recipe.spec?.contextRef?.trim() ||
            privateWorkflowContextName(recipeName)
          const context = kubectlJson<K8sContext>([
            '-n',
            MCP_SERVER_NS,
            'get',
            'context',
            contextRef,
            '-o',
            'json',
          ])
          if (!(context.spec?.mcpServers ?? []).includes(mcpServerName)) {
            return `context:${contextRef}:missing:${mcpServerName}`
          }

          const readyAddresses = readyEndpointAddressCount(mcpServerName)
          return readyAddresses > 0 ? 'ready' : `endpoints:${mcpServerName}:not-ready`
        } catch (error) {
          return error instanceof Error ? error.message.slice(0, 240) : String(error).slice(0, 240)
        }
      },
      {
        timeout: timeoutMs,
        intervals: [1_000, 2_000, 5_000],
        message: `transport runtime ${RECIPE_NS}/${recipeName} workload ${workloadId} should be ready before Desktop trigger`,
      }
    )
    .toBe('ready')
  return mcpServerName
}

async function clickDesktopTrigger(desktopPage: Page, detailCard: Locator): Promise<void> {
  const triggerButton = detailCard.getByRole('button', { name: /^trigger$/i })
  await expect(triggerButton).toBeEnabled({ timeout: 20_000 })
  await triggerButton.click()

  const successToast = desktopPage
    .getByRole('status')
    .filter({ hasText: /Workflow triggered|Approval requested/i })
    .first()
  const errorToast = desktopPage
    .getByRole('alert')
    .filter({
      hasText: /Trigger failed|409|conflict|failed|error|unable|not authorized|forbidden|denied/i,
    })
    .first()

  const outcome = await Promise.race([
    successToast
      .waitFor({ state: 'visible', timeout: 10_000 })
      .then(() => 'success' as const)
      .catch(() => null),
    errorToast
      .waitFor({ state: 'visible', timeout: 10_000 })
      .then(() => 'error' as const)
      .catch(() => null),
  ])

  if (outcome === 'error') {
    const text = await errorToast.textContent().catch(() => 'Trigger failed')
    throw new Error(`Desktop workflow trigger failed before run creation: ${text?.trim()}`)
  }

  expect(outcome, 'Desktop workflow trigger should show a success toast').toBe('success')
}

async function waitForUserWorkflowAvailable(userToken: string, name: string): Promise<void> {
  await expect
    .poll(
      async () => {
        const response = await apiRequest('GET', `${EXT_API}/api/v1/workflows`, undefined, {
          Authorization: `Bearer ${userToken}`,
        })
        if (response.status !== 200) return `http-${response.status}`
        return response.body.includes(name) ? 'available' : 'missing'
      },
      {
        timeout: 90_000,
        intervals: [500, 1_000, 2_000],
        message: `user workflow list should include ${RECIPE_NS}/${name} after Control UI grant`,
      }
    )
    .toBe('available')
}

async function apiListAdminWorkflowRuns(
  adminToken: string,
  name: string,
  limit = 20
): Promise<{ items: WorkflowRunSummary[]; count: number }> {
  const response = await apiRequest(
    'GET',
    `${CONTROL_API}/api/v1/admin/workflows/${encodeURIComponent(RECIPE_NS)}/${encodeURIComponent(name)}/runs?limit=${limit}`,
    undefined,
    { Authorization: `Bearer ${adminToken}` }
  )
  if (response.status !== 200) {
    throw new Error(`list admin workflow runs failed: HTTP ${response.status} ${response.body}`)
  }
  return JSON.parse(response.body) as { items: WorkflowRunSummary[]; count: number }
}

async function waitForAdminRunExecutionRef(
  adminToken: string,
  name: string,
  runId: string
): Promise<{ namespace: string; name: string }> {
  let lastPhase = ''
  await expect
    .poll(
      async () => {
        const runs = await apiListAdminWorkflowRuns(adminToken, name, 20)
        const run = runs.items.find(item => item.id === runId)
        lastPhase = run?.phase ?? ''
        return run?.executionRef?.name ?? null
      },
      {
        timeout: 90_000,
        intervals: [500, 1_000, 2_000],
        message: `admin run ${runId} should get a child executionRef (last phase=${lastPhase})`,
      }
    )
    .not.toBeNull()

  const runs = await apiListAdminWorkflowRuns(adminToken, name, 20)
  const run = runs.items.find(item => item.id === runId)
  if (!run?.executionRef) throw new Error(`admin run ${runId} has no executionRef`)
  expect(run.actor?.type).toBe('admin-ui')
  return run.executionRef
}

async function waitForAdminRunPhase(
  adminToken: string,
  name: string,
  runId: string,
  expected: string
): Promise<void> {
  await expect
    .poll(
      async () => {
        const runs = await apiListAdminWorkflowRuns(adminToken, name, 20)
        return runs.items.find(item => item.id === runId)?.phase ?? ''
      },
      {
        timeout: 300_000,
        intervals: [2_000, 5_000],
        message: `admin workflow run ${runId} should reach phase ${expected}`,
      }
    )
    .toBe(expected)
}

async function waitForRunExecutionRef(
  userToken: string,
  name: string,
  runId: string
): Promise<{ namespace: string; name: string }> {
  let lastPhase = ''
  await expect
    .poll(
      async () => {
        const runs = await apiListWorkflowRuns(userToken, RECIPE_NS, name, 20)
        const run = runs.items.find(item => item.id === runId)
        lastPhase = run?.phase ?? ''
        return run?.executionRef?.name ?? null
      },
      {
        timeout: 90_000,
        intervals: [500, 1_000, 2_000],
        message: `run ${runId} should get a child executionRef (last phase=${lastPhase})`,
      }
    )
    .not.toBeNull()

  const runs = await apiListWorkflowRuns(userToken, RECIPE_NS, name, 20)
  const run = runs.items.find(item => item.id === runId)
  if (!run?.executionRef) throw new Error(`run ${runId} has no executionRef`)
  return run.executionRef
}

async function waitForRunPhase(
  userToken: string,
  name: string,
  runId: string,
  expected: string
): Promise<void> {
  await expect
    .poll(
      async () => {
        const runs = await apiListWorkflowRuns(userToken, RECIPE_NS, name, 20)
        return runs.items.find(item => item.id === runId)?.phase ?? ''
      },
      {
        timeout: 300_000,
        intervals: [2_000, 5_000],
        message: `workflow run ${runId} should reach phase ${expected}`,
      }
    )
    .toBe(expected)
}

function readCoordinatorPod(childName: string): K8sPod {
  return kubectlJson(['-n', RECIPE_NS, 'get', 'pod', `${childName}-coordinator`, '-o', 'json'])
}

function readPod(podName: string): K8sPod {
  return kubectlJson(['-n', RECIPE_NS, 'get', 'pod', podName, '-o', 'json'])
}

async function waitForPodRunning(podName: string): Promise<K8sPod> {
  let pod: K8sPod = {}
  await expect
    .poll(
      () => {
        try {
          pod = readPod(podName)
          return pod.status?.phase === 'Running' && pod.spec?.nodeName
            ? `${pod.status.phase}:${pod.spec.nodeName}`
            : `${pod.status?.phase ?? 'missing'}:${pod.spec?.nodeName ?? 'no-node'}`
        } catch (error) {
          return `missing:${String(error).slice(0, 120)}`
        }
      },
      {
        timeout: 120_000,
        intervals: [1_000, 2_000, 5_000],
        message: `${RECIPE_NS}/${podName} should be Running and assigned to a node`,
      }
    )
    .toMatch(/^Running:/)
  return pod
}

async function waitForWorkflowOutputPreparePodSucceeded(
  childName: string,
  claimName: string
): Promise<K8sPod> {
  let pod: K8sPod = {}
  await expect
    .poll(
      () => {
        const pods = kubectlJson<{ items?: K8sPod[] }>([
          '-n',
          RECIPE_NS,
          'get',
          'pods',
          '-l',
          `clerum.io/recipe=${childName},clerum.io/component=${WORKFLOW_OUTPUT_PREPARE_COMPONENT}`,
          '-o',
          'json',
        ])
        const matches = pods.items ?? []
        pod = matches[0] ?? {}
        return matches
          .map(
            item =>
              `${item.metadata?.name ?? 'missing'}:${item.status?.phase ?? 'missing'}:${item.spec?.nodeName ?? 'no-node'}`
          )
          .join(',')
      },
      {
        timeout: 120_000,
        intervals: [1_000, 2_000, 5_000],
        message: `${RECIPE_NS}/${childName} workflow output prepare pod should complete before runtime pods start`,
      }
    )
    .toMatch(/:Succeeded:/)
  expect(pod.metadata?.name).toBeTruthy()
  expect(pod.spec?.nodeName).toBeTruthy()
  return pod
}

function workflowOutputClaimName(recipeName: string): string {
  // Mirrors WRC output naming so this gate keeps working if fixture names grow.
  const suffix = '-workflow-output'
  const direct = `${recipeName}${suffix}`
  if (direct.length <= 63) return direct

  const hash = createHash('sha256').update(recipeName).digest('hex').slice(0, 8)
  const maxStemLen = 63 - suffix.length - hash.length - 1
  const stem = recipeName.slice(0, Math.max(1, maxStemLen)).replace(/-+$/g, '')
  return `${stem || recipeName.slice(0, 1)}-${hash}${suffix}`
}

function truncateRfc1123(name: string, max = 63): string {
  return name.slice(0, max).replace(/[^a-z0-9]+$/, '')
}

function truncateRfc1123WithHash(name: string, max = 63): string {
  const normalized =
    name
      .replace(/[^a-z0-9-]+/g, '-')
      .replace(/^[^a-z0-9]+/, '')
      .replace(/[^a-z0-9]+$/, '') || 'x'
  if (normalized.length <= max) return normalized

  const hash = createHash('sha256')
    .update(normalized || name)
    .digest('hex')
    .slice(0, 8)
  const prefixMax = Math.max(1, max - hash.length - 1)
  const prefix = truncateRfc1123(normalized || 'x', prefixMax) || 'x'
  return `${prefix}-${hash}`
}

function workflowOutputAnchorPodName(recipeName: string): string {
  return truncateRfc1123WithHash(`${recipeName}-workflow-output-anchor`)
}

function readySchedulableNodeNames(): string[] {
  const nodes = kubectlJson<{
    items?: Array<{
      metadata?: { name?: string }
      spec?: { unschedulable?: boolean }
      status?: { conditions?: Array<{ type?: string; status?: string }> }
    }>
  }>(['get', 'nodes', '-o', 'json'])
  return (nodes.items ?? [])
    .filter(node => !node.spec?.unschedulable)
    .filter(node =>
      (node.status?.conditions ?? []).some(
        condition => condition.type === 'Ready' && condition.status === 'True'
      )
    )
    .map(node => node.metadata?.name ?? '')
    .filter(Boolean)
}

function assertMultiNodeRwoGate(): void {
  const nodes = readySchedulableNodeNames()
  expect(
    nodes.length,
    `RWO affinity gate requires at least two ready schedulable nodes; got ${nodes.join(', ') || 'none'}`
  ).toBeGreaterThanOrEqual(2)
}

function assertWorkflowOutputAffinity(pod: K8sPod, claimName: string): void {
  const terms =
    pod.spec?.affinity?.podAffinity?.requiredDuringSchedulingIgnoredDuringExecution ?? []
  expect(terms.length, `${pod.metadata?.name} should require pod affinity to output anchor`).toBe(1)
  expect(terms[0].topologyKey).toBe('kubernetes.io/hostname')
  const expressions = terms[0].labelSelector?.matchExpressions ?? []
  expect(expressions).toEqual(
    expect.arrayContaining([
      { key: WORKFLOW_OUTPUT_CLAIM_LABEL, operator: 'In', values: [claimName] },
      { key: 'clerum.io/component', operator: 'In', values: [WORKFLOW_OUTPUT_ANCHOR_COMPONENT] },
    ])
  )
}

function expectK8sDefaultFalse(value: boolean | undefined, message: string): void {
  expect(value ?? false, message).toBe(false)
}

function assertWorkflowOutputPvc(
  recipeName: string,
  claimName: string,
  expectedStorage: string
): string | undefined {
  const pvc = kubectlJson<K8sPvc>(['-n', RECIPE_NS, 'get', 'pvc', claimName, '-o', 'json'])
  expect(pvc.metadata?.name).toBe(claimName)
  expect(pvc.metadata?.labels).toMatchObject({
    'clerum.io/managed-by': 'wrc',
    'clerum.io/component': 'workflow-output',
    [WORKFLOW_OUTPUT_CLAIM_LABEL]: truncateRfc1123WithHash(claimName),
    [WORKFLOW_OUTPUT_SCOPE_LABEL]: truncateRfc1123WithHash(recipeName),
  })
  expect(pvc.spec?.accessModes).toContain('ReadWriteOnce')
  expect(pvc.spec?.resources?.requests?.storage).toBe(expectedStorage)
  const selectedNode = pvc.metadata?.annotations?.['volume.kubernetes.io/selected-node']
  if (!selectedNode) {
    const storageClassName = pvc.spec?.storageClassName
    expect(storageClassName, `${claimName} storageClassName`).toBeTruthy()
    const storageClass = kubectlJson<{ volumeBindingMode?: string }>([
      'get',
      'storageclass',
      storageClassName ?? '',
      '-o',
      'json',
    ])
    expect(
      storageClass.volumeBindingMode,
      `${claimName} may omit selected-node only for Immediate-binding storage`
    ).toBe('Immediate')
  }
  return selectedNode
}

function assertOutputAnchorPod(pod: K8sPod, recipeName: string, claimName: string): void {
  expect(pod.metadata?.labels).toMatchObject({
    'clerum.io/recipe': recipeName,
    'clerum.io/component': WORKFLOW_OUTPUT_ANCHOR_COMPONENT,
    [WORKFLOW_OUTPUT_CLAIM_LABEL]: claimName,
    [WORKFLOW_OUTPUT_SCOPE_LABEL]: recipeName,
  })
  expect(pod.spec?.containers?.[0]?.volumeMounts).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ name: 'recipe-output', mountPath: '/output-anchor' }),
    ])
  )
  expect(pod.spec?.volumes).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        name: 'recipe-output',
        persistentVolumeClaim: { claimName },
      }),
    ])
  )
}

function assertWorkflowOutputPreparePod(
  pod: K8sPod,
  options: { childName: string; recipeName: string; claimName: string; subPath: string }
): void {
  expect(pod.metadata?.labels).toMatchObject({
    'clerum.io/recipe': options.childName,
    'clerum.io/component': WORKFLOW_OUTPUT_PREPARE_COMPONENT,
    [WORKFLOW_OUTPUT_CLAIM_LABEL]: options.claimName,
    [WORKFLOW_OUTPUT_SCOPE_LABEL]: options.recipeName,
  })
  expect(pod.spec?.automountServiceAccountToken).toBe(false)
  expect(pod.spec?.enableServiceLinks).toBe(false)
  expectK8sDefaultFalse(pod.spec?.hostNetwork, `${pod.metadata?.name} hostNetwork`)
  expectK8sDefaultFalse(pod.spec?.hostPID, `${pod.metadata?.name} hostPID`)
  expectK8sDefaultFalse(pod.spec?.hostIPC, `${pod.metadata?.name} hostIPC`)
  expect(pod.spec?.securityContext?.seccompProfile?.type).toBe('RuntimeDefault')
  assertWorkflowOutputAffinity(pod, options.claimName)

  const container = pod.spec?.containers?.[0]
  expect(container?.securityContext).toMatchObject({
    runAsUser: 0,
    runAsGroup: 0,
    runAsNonRoot: false,
    readOnlyRootFilesystem: true,
    allowPrivilegeEscalation: false,
    capabilities: { drop: ['ALL'], add: ['CHOWN', 'FOWNER', 'DAC_OVERRIDE'] },
  })
  expect(container?.env).toEqual(
    expect.arrayContaining([
      { name: 'WORKFLOW_OUTPUT_ROOT', value: WORKFLOW_OUTPUT_ROOT_MOUNT_PATH },
      { name: 'WORKFLOW_OUTPUT_SUB_PATH', value: options.subPath },
    ])
  )
  expect(container?.volumeMounts).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        name: 'recipe-output',
        mountPath: WORKFLOW_OUTPUT_ROOT_MOUNT_PATH,
      }),
    ])
  )
  expect(pod.spec?.volumes).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        name: 'recipe-output',
        persistentVolumeClaim: { claimName: options.claimName },
      }),
    ])
  )
}

function assertOutputRuntimePod(
  pod: K8sPod,
  options: { component: string; recipeName: string; claimName: string; subPath: string }
): void {
  expect(pod.metadata?.labels).toMatchObject({
    'clerum.io/component': options.component,
    [WORKFLOW_OUTPUT_CLAIM_LABEL]: options.claimName,
    [WORKFLOW_OUTPUT_SCOPE_LABEL]: options.recipeName,
  })
  assertWorkflowOutputAffinity(pod, options.claimName)
  expect(pod.spec?.volumes).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        name: 'recipe-output',
        persistentVolumeClaim: { claimName: options.claimName },
      }),
    ])
  )
  expect(pod.spec?.containers?.[0]?.volumeMounts).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        name: 'recipe-output',
        mountPath: '/output',
        subPath: options.subPath,
      }),
    ])
  )
}

function assertNoWorkflowOutputAttachEvents(recipeName: string, claimName: string): void {
  const events = kubectlJson<{
    items?: Array<{
      reason?: string
      message?: string
      involvedObject?: { kind?: string; name?: string }
    }>
  }>(['-n', RECIPE_NS, 'get', 'events', '--field-selector=type=Warning', '-o', 'json'])
  const badEvents = (events.items ?? []).filter(event => {
    const text = [event.reason, event.message, event.involvedObject?.name].filter(Boolean).join(' ')
    return (
      (text.includes(recipeName) || text.includes(claimName)) &&
      /Multi-Attach|FailedAttachVolume|FailedAttach|FailedMount/i.test(text)
    )
  })
  expect(badEvents, `no Multi-Attach/FailedAttach/FailedMount events for ${claimName}`).toEqual([])
}

async function assertConcurrentOutputPodsCoLocated(
  recipeName: string,
  runs: Array<{ runId: string; childName: string }>,
  expectedStorage = '128Mi'
): Promise<void> {
  const claimName = workflowOutputClaimName(recipeName)
  const anchor = await waitForPodRunning(workflowOutputAnchorPodName(recipeName))
  assertOutputAnchorPod(anchor, recipeName, claimName)
  const anchorNode = anchor.spec?.nodeName
  expect(anchorNode).toBeTruthy()
  const selectedNode = assertWorkflowOutputPvc(recipeName, claimName, expectedStorage)
  if (selectedNode) {
    expect(selectedNode, `${claimName} selected-node annotation`).toBe(anchorNode)
  }

  for (const run of runs) {
    const expectedSubPath = `workflow-output/${recipeName}/${run.runId}`
    const preparePod = await waitForWorkflowOutputPreparePodSucceeded(run.childName, claimName)
    expect(preparePod.spec?.nodeName, `${run.childName} output-prepare node`).toBe(anchorNode)
    assertWorkflowOutputPreparePod(preparePod, {
      childName: run.childName,
      recipeName,
      claimName,
      subPath: expectedSubPath,
    })

    const expectedPods = [
      { suffix: 'coordinator', component: 'workflow-coordinator' },
      { suffix: 'artifact-reader', component: 'workflow-artifact-reader' },
      { suffix: 'mcp-host', component: 'workflow-mcp-host' },
    ]
    for (const expectedPod of expectedPods) {
      const pod = await waitForPodRunning(`${run.childName}-${expectedPod.suffix}`)
      expect(pod.spec?.nodeName, `${run.childName} ${expectedPod.suffix} node`).toBe(anchorNode)
      assertOutputRuntimePod(pod, {
        component: expectedPod.component,
        recipeName,
        claimName,
        subPath: expectedSubPath,
      })
    }
  }

  assertNoWorkflowOutputAttachEvents(recipeName, claimName)
}

function assertNoMcpHostPod(childName: string): void {
  expect(() =>
    kubectl(['-n', RECIPE_NS, 'get', 'pod', `${childName}-mcp-host`], undefined, 10_000)
  ).toThrow()
}

function assertMcpHostPod(childName: string): void {
  const pod = kubectlJson<{
    metadata?: { name?: string; labels?: Record<string, string> }
    spec?: {
      containers?: Array<{ image?: string; env?: K8sEnvVar[]; volumeMounts?: K8sVolumeMount[] }>
      volumes?: Array<{ name?: string; secret?: { secretName?: string; defaultMode?: number } }>
    }
  }>(['-n', RECIPE_NS, 'get', 'pod', `${childName}-mcp-host`, '-o', 'json'])
  expect(pod.metadata?.name).toBe(`${childName}-mcp-host`)
  expect(pod.metadata?.labels?.['clerum.io/component']).toBe('workflow-mcp-host')
  const container = pod.spec?.containers?.[0]
  const envVars = container?.env ?? []
  const envNames = envVars.map(env => env.name)
  const envByName = new Map(envVars.map(env => [env.name, env]))
  const mountsByName = new Map((container?.volumeMounts ?? []).map(mount => [mount.name, mount]))
  const volumeByName = new Map((pod.spec?.volumes ?? []).map(volume => [volume.name, volume]))

  expect(container?.image).toBe(MCP_HOST_IMAGE)
  expect(envNames).not.toContain('WRC_TOKEN_FILE')
  expect(envNames).not.toContain('WRC_TOKEN')
  expect(envNames).toContain('MCP_HOST_WORKFLOW_CONTROL_TOKEN_FILE')
  expect(envByName.get('MCP_HOST_WORKFLOW_CONTROL_TOKEN_FILE')?.value).toBe(
    '/var/run/clerum/workflow-tokens/mcp-host-workflow-control-token'
  )
  expect(envNames).not.toContain('MCP_HOST_WORKFLOW_CONTROL_TOKEN')
  expect(mountsByName.get('workflow-tokens')).toMatchObject({
    mountPath: '/var/run/clerum/workflow-tokens',
    readOnly: true,
  })
  expect(mountsByName.get('workflow-tokens')?.subPath).toBeUndefined()
  expect(volumeByName.get('workflow-tokens')?.secret).toMatchObject({
    secretName: `wf-${childName}-mcp-host-runtime-tokens`,
    defaultMode: 0o440,
  })
}

function assertCoordinatorHasMcpHostChannel(childName: string): void {
  const pod = readCoordinatorPod(childName)
  const container = pod.spec?.containers?.[0]
  const envVars = container?.env ?? []
  const envNames = envVars.map(env => env.name)
  const envByName = new Map(envVars.map(env => [env.name, env]))
  const mountsByName = new Map((container?.volumeMounts ?? []).map(mount => [mount.name, mount]))
  const volumeByName = new Map((pod.spec?.volumes ?? []).map(volume => [volume.name, volume]))
  expect(envNames).toContain('CLERUM_MCPHOST_URL')
  expect(envByName.get('WRC_TOKEN_FILE')?.value).toBe('/var/run/clerum/workflow-tokens/wrc-token')
  expect(envByName.get('MCP_HOST_TOKEN_FILE')?.value).toBe(
    '/var/run/clerum/workflow-tokens/mcp-host-token'
  )
  expect(envNames).not.toContain('WRC_TOKEN')
  expect(envNames).not.toContain('MCP_HOST_TOKEN')
  expect(mountsByName.get('workflow-tokens')).toMatchObject({
    mountPath: '/var/run/clerum/workflow-tokens',
    readOnly: true,
  })
  expect(mountsByName.get('workflow-tokens')?.subPath).toBeUndefined()
  expect(volumeByName.get('workflow-tokens')?.secret).toMatchObject({
    secretName: `wf-${childName}-coordinator-token`,
    defaultMode: 0o440,
  })
  expect(envNames).not.toContain('MCP_HOST_RUNTIME_ACCESS_TOKEN')
  expect(envNames).not.toContain('MCP_HOST_RUNTIME_REFRESH_TOKEN')
  expect(envNames).not.toContain('MCP_HOST_WORKFLOW_CONTROL_TOKEN')
  expect(envNames).not.toContain('OPENAI_API_KEY')
  expect(envNames).not.toContain('ZAI_API_KEY')
  expect(envNames).not.toContain('BAILIAN_API_KEY')
  expect(envNames).not.toContain('CLAUDE_API_KEY')
}

function cleanupRecipe(name: string): void {
  if (!/^e2e-[a-z0-9-]+$/.test(name)) {
    throw new Error(`refusing to clean non-E2E recipe name ${name}`)
  }

  try {
    const workflowNames = kubectl([
      '-n',
      RECIPE_NS,
      'get',
      'workflowrecipe',
      '-o',
      'jsonpath={range .items[*]}{.metadata.name}{"\\n"}{end}',
    ])
      .split('\n')
      .map(item => item.trim())
      .filter(item => item === name || item.startsWith(`${name}-`))
    if (workflowNames.length > 0) {
      kubectl([
        '-n',
        RECIPE_NS,
        'delete',
        'workflowrecipe',
        ...workflowNames,
        '--ignore-not-found=true',
        '--wait=false',
      ])
    }
  } catch {
    // Cleanup is best effort; the SQL and PVC cleanup below are idempotent.
  }

  try {
    const pvcNames = kubectl([
      '-n',
      RECIPE_NS,
      'get',
      'pvc',
      '-o',
      'jsonpath={range .items[*]}{.metadata.name}{"\\n"}{end}',
    ])
      .split('\n')
      .map(item => item.trim())
      .filter(item => item === `${name}-workflow-output` || item.startsWith(`${name}-`))
    if (pvcNames.length > 0) {
      kubectl(['-n', RECIPE_NS, 'delete', 'pvc', ...pvcNames, '--ignore-not-found=true'])
    }
  } catch {
    // Ignore cleanup errors so the afterAll restore still runs.
  }

  try {
    const ns = sqlLiteral(RECIPE_NS)
    const recipe = sqlLiteral(name)
    runProfilesSql(
      `
      DELETE FROM workflow_approval_requests
       WHERE recipe_namespace = ${ns} AND recipe_name = ${recipe};
      DELETE FROM workflow_approval_requests_archive
       WHERE recipe_namespace = ${ns} AND recipe_name = ${recipe};
      DELETE FROM workflow_runs
       WHERE recipe_namespace = ${ns} AND recipe_name = ${recipe};
      DELETE FROM workflow_runs_audit
       WHERE recipe_namespace = ${ns} AND recipe_name = ${recipe};
      DELETE FROM user_workflow_triggers
       WHERE recipe_namespace = ${ns} AND recipe_name = ${recipe};
      DO $$
      BEGIN
        IF to_regclass('public.workflow_recipe_allowed_users') IS NOT NULL THEN
          DELETE FROM workflow_recipe_allowed_users
           WHERE recipe_namespace = ${ns} AND recipe_name = ${recipe};
        END IF;
      END $$;
      `,
      30_000
    )
  } catch {
    // Rows are test-named; a later cleanup pass can remove leftovers if needed.
  }
}

async function apiListRunArtifacts(
  userToken: string,
  name: string,
  runId: string
): Promise<WorkflowRunArtifactDto[]> {
  const response = await apiRequest(
    'GET',
    `${EXT_API}/api/v1/workflows/${encodeURIComponent(RECIPE_NS)}/${encodeURIComponent(name)}/runs/${encodeURIComponent(runId)}/artifacts`,
    undefined,
    { Authorization: `Bearer ${userToken}` }
  )
  if (response.status !== 200) {
    throw new Error(`list run artifacts failed: HTTP ${response.status} ${response.body}`)
  }
  const parsed = JSON.parse(response.body) as { artifacts?: WorkflowRunArtifactDto[] }
  return parsed.artifacts ?? []
}

async function apiDownloadRunArtifact(
  userToken: string,
  name: string,
  runId: string,
  artifactName = ARTIFACT_NAME
): Promise<CustomArtifactPayload> {
  const response = await fetch(
    `${EXT_API}/api/v1/workflows/${encodeURIComponent(RECIPE_NS)}/${encodeURIComponent(name)}/runs/${encodeURIComponent(runId)}/artifacts/${encodeURIComponent(artifactName)}/download`,
    { headers: { Authorization: `Bearer ${userToken}` } }
  )
  if (!response.ok) {
    throw new Error(
      `download run artifact failed: HTTP ${response.status} ${await response.text()}`
    )
  }
  return (await response.json()) as CustomArtifactPayload
}

async function apiDownloadRunArtifactText(
  userToken: string,
  name: string,
  runId: string,
  artifactName: string
): Promise<string> {
  const response = await fetch(
    `${EXT_API}/api/v1/workflows/${encodeURIComponent(RECIPE_NS)}/${encodeURIComponent(name)}/runs/${encodeURIComponent(runId)}/artifacts/${encodeURIComponent(artifactName)}/download`,
    { headers: { Authorization: `Bearer ${userToken}` } }
  )
  if (!response.ok) {
    throw new Error(
      `download run artifact failed: HTTP ${response.status} ${await response.text()}`
    )
  }
  return response.text()
}

async function downloadTextFromButton(
  page: Page,
  button: Locator,
  artifactName: string,
  expectedFilename = artifactName
): Promise<string> {
  const downloadPromise = page.waitForEvent('download', { timeout: 30_000 })
  await button.click()
  const download = await downloadPromise
  expect(download.suggestedFilename()).toBe(expectedFilename)
  const tmpFile = path.join(os.tmpdir(), `clerum-${Date.now()}-${download.suggestedFilename()}`)
  await download.saveAs(tmpFile)
  try {
    return fs.readFileSync(tmpFile, 'utf8')
  } finally {
    fs.rmSync(tmpFile, { force: true })
  }
}

async function downloadJsonFromButton(
  page: Page,
  button: Locator,
  artifactName = ARTIFACT_NAME,
  expectedFilename = artifactName
): Promise<CustomArtifactPayload> {
  return JSON.parse(
    await downloadTextFromButton(page, button, artifactName, expectedFilename)
  ) as CustomArtifactPayload
}

async function downloadJsonFromDesktopWorkflowButton(
  page: Page,
  button: Locator,
  expectedRunId: string,
  expectedArtifactName = ARTIFACT_NAME
): Promise<CustomArtifactPayload> {
  return JSON.parse(
    await downloadTextFromDesktopWorkflowButton(page, button, expectedRunId, expectedArtifactName)
  ) as CustomArtifactPayload
}

async function downloadTextFromDesktopWorkflowButton(
  page: Page,
  button: Locator,
  expectedRunId: string,
  expectedArtifactName: string
): Promise<string> {
  const expectedFilename = `${expectedRunId.slice(0, 8)}-${expectedArtifactName}`
  const downloadPath = path.join(os.homedir(), 'Downloads', expectedFilename)
  fs.rmSync(downloadPath, { force: true })
  await button.click()
  await expect
    .poll(
      () => {
        if (!fs.existsSync(downloadPath)) return 0
        return fs.statSync(downloadPath).size
      },
      {
        timeout: 30_000,
        intervals: [250, 500, 1_000],
        message: `Desktop App should save ${expectedFilename} to Downloads`,
      }
    )
    .toBeGreaterThan(0)
  const downloadedText = fs.readFileSync(downloadPath, 'utf8')
  fs.rmSync(downloadPath, { force: true })
  return downloadedText
}

function assertDataArtifactSet(
  artifacts: WorkflowRunArtifactDto[],
  expected: ReadonlyArray<{ name: string; format: string }>
): void {
  const names = artifacts.map(item => item.name)
  expect(new Set(names).size).toBe(names.length)
  expect(names.sort()).toEqual(expected.map(item => item.name).sort())

  for (const artifact of artifacts) {
    const expectedArtifact = expected.find(item => item.name === artifact.name)
    expect(artifact.format).toBe(expectedArtifact?.format)
    expect(artifact).not.toHaveProperty('path')
    expect(
      EXPECTED_DATA_ARTIFACTS.some(
        item => item.name === artifact.name && item.format === artifact.format
      )
    ).toBe(true)
    expect(artifact.name).not.toMatch(
      /\.(?:cjs|mjs|js|jsx|ts|tsx|sh|bash|zsh|ps1|py|rb|php|pl|jar|war|class|wasm|html?)$/iu
    )
  }
}

function assertPublicHttpEgressProbe(artifact: CustomArtifactPayload): void {
  expect(artifact.businessDecision?.publicHttp).toEqual(
    expect.objectContaining({
      attempted: true,
      host: 'api.github.com',
      api: 'github',
      status: 200,
      repoFullName: 'octocat/Hello-World',
      private: false,
    })
  )
}

function assertDeclaredWorkloadProbe(artifact: CustomArtifactPayload): void {
  expect(artifact.businessDecision?.declaredWorkload).toEqual(
    expect.objectContaining({
      attempted: true,
      workloadId: 'business-api',
      status: 200,
      bodyStatus: 'ok',
      tools: expect.arrayContaining(['record', 'recall']),
    })
  )
}

function assertCustomArtifactPayload(
  artifact: CustomArtifactPayload,
  expectedChildName: string,
  expectedRequestId: string
): void {
  expect(artifact.workflowName).toBe(expectedChildName)
  expect(artifact.coordinatorImage).toBe(CUSTOM_IMAGE)
  expect(artifact.orderedStepIds).toEqual(['prepare', 'transform', 'emit'])
  expect(artifact.previousOutputKeys).toEqual(['prepare', 'transform'])
  expect(artifact.businessDecision?.requestId).toBe(expectedRequestId)
  expect(artifact.businessDecision?.highRiskAccounts).toEqual(['dao-alpha'])
  expect(artifact.businessDecision?.outstandingAmount).toBe(1880)
  expect(artifact.businessDecision?.manualReviewRequired).toBe(true)
  assertPublicHttpEgressProbe(artifact)
  assertDeclaredWorkloadProbe(artifact)
  expect(artifact.unsafeArtifactAttempted).toBe(true)
}

function assertBrokerArtifactPayload(
  artifact: CustomArtifactPayload,
  expectedChildName: string,
  expectedRequestId: string
): void {
  expect(artifact.workflowName).toBe(expectedChildName)
  expect(artifact.coordinatorImage).toBe(CUSTOM_IMAGE)
  expect(artifact.orderedStepIds).toEqual(['prepare', 'broker-review', 'emit'])
  expect(artifact.previousOutputKeys).toEqual(['prepare', 'broker-review'])
  expect(artifact.businessDecision?.requestId).toBe(expectedRequestId)
  assertPublicHttpEgressProbe(artifact)
  assertDeclaredWorkloadProbe(artifact)
  expect(artifact.brokerBacked?.modelUsed).toBe('zai/glm-4.7')
  expect(artifact.brokerBacked?.mcpDataUsed).toBe(true)
  expect(artifact.brokerBacked?.tools).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        serverName: 'mock-tools',
        toolName: 'add',
        args: expect.objectContaining({ a: 40, b: 2 }),
      }),
    ])
  )
  expect(artifact.unsafeArtifactAttempted).toBe(true)
}

function assertOutputAffinityArtifactPayload(
  artifact: CustomArtifactPayload,
  expectedChildName: string
): void {
  expect(artifact.workflowName).toBe(expectedChildName)
  expect(artifact.coordinatorImage).toBe(CUSTOM_IMAGE)
  expect(artifact.orderedStepIds).toEqual(['wait-for-token-rotation', 'emit'])
  expect(artifact.previousOutputKeys).toEqual(['wait-for-token-rotation'])
  expect(artifact.tokenRotationProbe).toEqual(
    expect.objectContaining({
      tokenRotationProbe: true,
      finalStatusUsesCurrentTokenFile: true,
    })
  )
}

async function refreshDesktopRunsAndFindArtifactButton(
  desktopPage: Page,
  runId: string,
  artifactName = ARTIFACT_NAME
): Promise<Locator> {
  await desktopPage.getByRole('button', { name: /^refresh$/i }).click()
  const runRow = desktopPage.locator('.workflow-run-row').filter({ hasText: runId.slice(0, 8) })
  await expect(runRow).toBeVisible({ timeout: 30_000 })
  const artifactButton = runRow.getByRole('button', { name: artifactName })
  await expect(artifactButton).toBeVisible({ timeout: 30_000 })
  return artifactButton
}

async function downloadArtifactFromControlUiRun(
  page: Page,
  recipeName: string,
  runId: string,
  artifactName = ARTIFACT_NAME
): Promise<CustomArtifactPayload> {
  await page.goto(
    `${CONTROL_UI}/workflow-recipes/${encodeURIComponent(RECIPE_NS)}/${encodeURIComponent(recipeName)}/runs/${encodeURIComponent(runId)}`
  )
  await expect(page.getByTestId('artifacts-panel')).toBeVisible({ timeout: 60_000 })
  const artifactRow = page.getByTestId('artifact-row').filter({ hasText: artifactName })
  await expect(artifactRow).toBeVisible({ timeout: 15_000 })
  return downloadJsonFromButton(
    page,
    artifactRow.getByTestId('artifact-download'),
    artifactName,
    `${runId.slice(0, 8)}-${artifactName}`
  )
}

async function downloadTextArtifactFromControlUiRun(
  page: Page,
  recipeName: string,
  runId: string,
  artifactName: string
): Promise<string> {
  await page.goto(
    `${CONTROL_UI}/workflow-recipes/${encodeURIComponent(RECIPE_NS)}/${encodeURIComponent(recipeName)}/runs/${encodeURIComponent(runId)}`
  )
  await expect(page.getByTestId('artifacts-panel')).toBeVisible({ timeout: 60_000 })
  const artifactRow = page.getByTestId('artifact-row').filter({ hasText: artifactName })
  await expect(artifactRow).toBeVisible({ timeout: 15_000 })
  return downloadTextFromButton(
    page,
    artifactRow.getByTestId('artifact-download'),
    artifactName,
    `${runId.slice(0, 8)}-${artifactName}`
  )
}

test.describe('Layer 3B custom coordinator user flow', () => {
  test.slow()
  test.describe.configure({ timeout: 1_200_000 })

  let wrcEnvSnapshot: WrcEnvSnapshot | null = null

  test.beforeAll(async () => {
    wrcEnvSnapshot = captureWrcPolicyEnv()
    await setWrcPolicyEnv(true, 'clerum/workflow-custom-sdk-e2e:', false)
    await clearSession()
  })

  test.afterAll(async () => {
    cleanupRecipe(RECIPE_NAME)
    cleanupRecipe(BROKER_RECIPE_NAME)
    cleanupRecipe(RWO_AFFINITY_RECIPE_NAME)
    if (wrcEnvSnapshot) await restoreWrcPolicyEnv(wrcEnvSnapshot)
  })

  test('installs in Control UI, grants user, triggers in Desktop App, and runs custom coordinator image', async ({
    page,
  }) => {
    await Promise.all([
      apiRequest('GET', `${CONTROL_API}/health`).then(res => expect(res.status).toBe(200)),
      apiRequest('GET', `${EXT_API}/health`).then(res => expect(res.status).toBe(200)),
    ])

    const adminToken = await installRecipeFromControlUi(page, RECIPE_NAME, E2E_EMAIL)
    await waitForRecipeWorkflowPhase(RECIPE_NAME, 'completed', 300_000)
    await waitForAdminRecipeActive(adminToken, RECIPE_NAME)

    const { userId, userToken } = await loginAs(E2E_EMAIL)
    await waitForUserWorkflowAvailable(userToken, RECIPE_NAME)

    const { app, page: desktopPage } = await launchAndLogin(E2E_EMAIL)
    try {
      await openWorkflowsPage(desktopPage)
      const row = workflowRow(desktopPage, RECIPE_NAME)
      await expect(row).toBeVisible({ timeout: 20_000 })

      const detailCard = await selectWorkflow(desktopPage, RECIPE_NAME, RECIPE_NS)
      await expect(detailCard.locator('.input-contract-form')).toBeVisible({ timeout: 10_000 })

      const customRequestId = `ui-custom-${Date.now()}`
      await desktopPage.getByLabel('requestId', { exact: true }).fill(customRequestId)
      await desktopPage.getByLabel('approvalThreshold', { exact: true }).fill('1000')
      await desktopPage
        .getByLabel('scenario', { exact: true })
        .fill('desktop-custom-coordinator-trigger')

      const runsBefore = await apiListWorkflowRuns(userToken, RECIPE_NS, RECIPE_NAME, 20)
      const previousRunIds = runsBefore.items.map(item => item.id)
      await clickDesktopTrigger(desktopPage, detailCard)

      let firstRunId = ''
      await expect
        .poll(
          async () => {
            const runs = await apiListWorkflowRuns(userToken, RECIPE_NS, RECIPE_NAME, 20)
            const fresh = runs.items.find(
              item => item.actor?.userId === userId && !previousRunIds.includes(item.id)
            )
            firstRunId = fresh?.id ?? ''
            return firstRunId || null
          },
          {
            timeout: 60_000,
            intervals: [500, 1_000, 2_000],
            message: 'Desktop App trigger should create a new user-session run',
          }
        )
        .not.toBeNull()

      const firstChild = await waitForRunExecutionRef(userToken, RECIPE_NAME, firstRunId)
      expect(firstChild.namespace).toBe(RECIPE_NS)
      await waitForRecipeWorkflowPhase(firstChild.name, 'completed', 300_000)
      await waitForRunPhase(userToken, RECIPE_NAME, firstRunId, 'Succeeded')
      assertRunRetentionPolicy(firstRunId)

      const pod = readCoordinatorPod(firstChild.name)
      expect(pod.spec?.containers?.[0]?.image).toBe(CUSTOM_IMAGE)
      expect(pod.metadata?.labels?.['clerum.io/coordinator-tier']).toBe('custom')
      assertNoMcpHostPod(firstChild.name)

      const firstArtifacts = await apiListRunArtifacts(userToken, RECIPE_NAME, firstRunId)
      assertDataArtifactSet(firstArtifacts, [{ name: ARTIFACT_NAME, format: 'json' }])
      assertCustomArtifactPayload(
        await apiDownloadRunArtifact(userToken, RECIPE_NAME, firstRunId),
        firstChild.name,
        customRequestId
      )

      const secondRequestId = `ui-custom-second-${Date.now()}`
      await desktopPage.getByLabel('requestId', { exact: true }).fill(secondRequestId)
      await desktopPage.getByLabel('approvalThreshold', { exact: true }).fill('1000')
      await desktopPage
        .getByLabel('scenario', { exact: true })
        .fill('desktop-custom-coordinator-trigger-second')

      const beforeSecond = await apiListWorkflowRuns(userToken, RECIPE_NS, RECIPE_NAME, 20)
      const runIdsBeforeSecond = beforeSecond.items.map(item => item.id)
      await clickDesktopTrigger(desktopPage, detailCard)

      let secondRunId = ''
      await expect
        .poll(
          async () => {
            const runs = await apiListWorkflowRuns(userToken, RECIPE_NS, RECIPE_NAME, 20)
            const fresh = runs.items.find(
              item => item.actor?.userId === userId && !runIdsBeforeSecond.includes(item.id)
            )
            secondRunId = fresh?.id ?? ''
            return secondRunId || null
          },
          {
            timeout: 60_000,
            intervals: [500, 1_000, 2_000],
            message: 'second Desktop App trigger should create a separate run',
          }
        )
        .not.toBeNull()

      const secondChild = await waitForRunExecutionRef(userToken, RECIPE_NAME, secondRunId)
      await waitForRecipeWorkflowPhase(secondChild.name, 'completed', 300_000)
      await waitForRunPhase(userToken, RECIPE_NAME, secondRunId, 'Succeeded')
      assertRunRetentionPolicy(secondRunId)

      assertCustomArtifactPayload(
        await apiDownloadRunArtifact(userToken, RECIPE_NAME, secondRunId),
        secondChild.name,
        secondRequestId
      )
      assertCustomArtifactPayload(
        await apiDownloadRunArtifact(userToken, RECIPE_NAME, firstRunId),
        firstChild.name,
        customRequestId
      )

      const desktopFirstButton = await refreshDesktopRunsAndFindArtifactButton(
        desktopPage,
        firstRunId
      )
      assertCustomArtifactPayload(
        await downloadJsonFromDesktopWorkflowButton(desktopPage, desktopFirstButton, firstRunId),
        firstChild.name,
        customRequestId
      )

      const desktopSecondButton = await refreshDesktopRunsAndFindArtifactButton(
        desktopPage,
        secondRunId
      )
      assertCustomArtifactPayload(
        await downloadJsonFromDesktopWorkflowButton(desktopPage, desktopSecondButton, secondRunId),
        secondChild.name,
        secondRequestId
      )

      assertCustomArtifactPayload(
        await downloadArtifactFromControlUiRun(page, RECIPE_NAME, firstRunId),
        firstChild.name,
        customRequestId
      )
    } finally {
      await app.close()
    }
  })

  test('co-locates concurrent Desktop and Control UI RWO output runs through the workflow output anchor', async ({
    page,
  }) => {
    await Promise.all([
      apiRequest('GET', `${CONTROL_API}/health`).then(res => expect(res.status).toBe(200)),
      apiRequest('GET', `${EXT_API}/health`).then(res => expect(res.status).toBe(200)),
    ])
    assertMultiNodeRwoGate()

    const adminToken = await installRecipeFromControlUi(page, RWO_AFFINITY_RECIPE_NAME, E2E_EMAIL, {
      outputAffinityProbe: true,
    })
    await waitForAdminRecipeActive(adminToken, RWO_AFFINITY_RECIPE_NAME)
    await waitForTransportRuntimeReady(RWO_AFFINITY_RECIPE_NAME, 'mock-tools')

    const { userId, userToken } = await loginAs(E2E_EMAIL)
    await waitForUserWorkflowAvailable(userToken, RWO_AFFINITY_RECIPE_NAME)
    const { app, page: desktopPage } = await launchAndLogin(E2E_EMAIL)
    try {
      await openWorkflowsPage(desktopPage)
      const row = workflowRow(desktopPage, RWO_AFFINITY_RECIPE_NAME)
      await expect(row).toBeVisible({ timeout: 20_000 })

      const detailCard = await selectWorkflow(desktopPage, RWO_AFFINITY_RECIPE_NAME, RECIPE_NS)
      await expect(detailCard.locator('.input-contract-form')).toBeVisible({ timeout: 10_000 })

      const runsBefore = await apiListWorkflowRuns(
        userToken,
        RECIPE_NS,
        RWO_AFFINITY_RECIPE_NAME,
        20
      )
      const previousRunIds = runsBefore.items.map(item => item.id)

      const firstRequestId = `rwo-first-${Date.now()}`
      await desktopPage.getByLabel('requestId', { exact: true }).fill(firstRequestId)
      await desktopPage.getByLabel('approvalThreshold', { exact: true }).fill('1000')
      await desktopPage.getByLabel('scenario', { exact: true }).fill('rwo-affinity-first')
      await clickDesktopTrigger(desktopPage, detailCard)

      let firstRunId = ''
      await expect
        .poll(
          async () => {
            const runs = await apiListWorkflowRuns(
              userToken,
              RECIPE_NS,
              RWO_AFFINITY_RECIPE_NAME,
              20
            )
            const fresh = runs.items.find(
              item => item.actor?.userId === userId && !previousRunIds.includes(item.id)
            )
            firstRunId = fresh?.id ?? ''
            return firstRunId || null
          },
          {
            timeout: 60_000,
            intervals: [500, 1_000, 2_000],
            message: 'first Desktop App trigger should create a user-session run',
          }
        )
        .not.toBeNull()

      const firstChild = await waitForRunExecutionRef(
        userToken,
        RWO_AFFINITY_RECIPE_NAME,
        firstRunId
      )
      await waitForPodRunning(`${firstChild.name}-coordinator`)

      const firstIdentity = readRunIdentity(firstRunId)
      expect(firstIdentity).toMatchObject({
        actorType: 'user',
        approvalRequestId: null,
      })

      const secondRequestId = `rwo-operator-${Date.now()}`
      const secondRunId = await triggerControlUiOperatorRun(
        page,
        RWO_AFFINITY_RECIPE_NAME,
        {
          requestId: secondRequestId,
          approvalThreshold: '1000',
          scenario: 'rwo-affinity-control-ui-operator',
        },
        adminToken
      )
      const secondChild = await waitForAdminRunExecutionRef(
        adminToken,
        RWO_AFFINITY_RECIPE_NAME,
        secondRunId
      )
      expect(secondRunId).not.toBe(firstRunId)
      expect(secondChild.name).not.toBe(firstChild.name)
      const firstRunDuringOperatorStart = (
        await apiListWorkflowRuns(userToken, RECIPE_NS, RWO_AFFINITY_RECIPE_NAME, 20)
      ).items.find(item => item.id === firstRunId)
      expect(
        firstRunDuringOperatorStart,
        'Desktop run should still be visible while operator run starts'
      ).toBeTruthy()
      expect(firstRunDuringOperatorStart?.phase ?? '').not.toMatch(/Succeeded|Failed|Cancelled/i)
      const secondIdentity = readRunIdentity(secondRunId)
      expect(secondIdentity).toMatchObject({
        actorType: 'admin',
        usageTeamId: 'control-plane-admin-ui',
        approvalRequestId: null,
      })

      await assertConcurrentOutputPodsCoLocated(RWO_AFFINITY_RECIPE_NAME, [
        { runId: firstRunId, childName: firstChild.name },
        { runId: secondRunId, childName: secondChild.name },
      ])

      await waitForRecipeWorkflowPhase(firstChild.name, 'completed', 300_000)
      await waitForRecipeWorkflowPhase(secondChild.name, 'completed', 300_000)
      await waitForRunPhase(userToken, RWO_AFFINITY_RECIPE_NAME, firstRunId, 'Succeeded')
      await waitForAdminRunPhase(adminToken, RWO_AFFINITY_RECIPE_NAME, secondRunId, 'Succeeded')
      assertRunRetentionPolicy(firstRunId)
      assertRunRetentionPolicy(secondRunId)
      assertNoWorkflowOutputAttachEvents(
        RWO_AFFINITY_RECIPE_NAME,
        workflowOutputClaimName(RWO_AFFINITY_RECIPE_NAME)
      )

      const firstArtifacts = await apiListRunArtifacts(
        userToken,
        RWO_AFFINITY_RECIPE_NAME,
        firstRunId
      )
      assertDataArtifactSet(firstArtifacts, [{ name: ARTIFACT_NAME, format: 'json' }])
      const firstArtifact = await apiDownloadRunArtifact(
        userToken,
        RWO_AFFINITY_RECIPE_NAME,
        firstRunId
      )
      assertOutputAffinityArtifactPayload(firstArtifact, firstChild.name)

      const secondArtifact = await downloadArtifactFromControlUiRun(
        page,
        RWO_AFFINITY_RECIPE_NAME,
        secondRunId
      )
      assertOutputAffinityArtifactPayload(secondArtifact, secondChild.name)

      const desktopFirstButton = await refreshDesktopRunsAndFindArtifactButton(
        desktopPage,
        firstRunId
      )
      expect(
        (await downloadJsonFromDesktopWorkflowButton(desktopPage, desktopFirstButton, firstRunId))
          .tokenRotationProbe?.finalStatusUsesCurrentTokenFile
      ).toBe(true)

      expect(secondArtifact.tokenRotationProbe?.finalStatusUsesCurrentTokenFile).toBe(true)
    } finally {
      await app.close()
    }
  })

  test('runs a broker-backed custom coordinator through WRC-managed mcp-host and downloads both artifacts', async ({
    page,
  }) => {
    await Promise.all([
      apiRequest('GET', `${CONTROL_API}/health`).then(res => expect(res.status).toBe(200)),
      apiRequest('GET', `${EXT_API}/health`).then(res => expect(res.status).toBe(200)),
    ])

    const adminToken = await installRecipeFromControlUi(page, BROKER_RECIPE_NAME, E2E_EMAIL, {
      brokerBacked: true,
    })
    await waitForAdminRecipeActive(adminToken, BROKER_RECIPE_NAME)
    await waitForTransportRuntimeReady(BROKER_RECIPE_NAME, 'mock-tools')

    const { userId, userToken } = await loginAs(E2E_EMAIL)
    await waitForUserWorkflowAvailable(userToken, BROKER_RECIPE_NAME)
    const { app, page: desktopPage } = await launchAndLogin(E2E_EMAIL)
    try {
      await openWorkflowsPage(desktopPage)
      const row = workflowRow(desktopPage, BROKER_RECIPE_NAME)
      await expect(row).toBeVisible({ timeout: 20_000 })

      const detailCard = await selectWorkflow(desktopPage, BROKER_RECIPE_NAME, RECIPE_NS)
      await expect(detailCard.locator('.input-contract-form')).toBeVisible({ timeout: 10_000 })

      const requestId = `ui-custom-broker-${Date.now()}`
      await desktopPage.getByLabel('requestId', { exact: true }).fill(requestId)
      await desktopPage.getByLabel('approvalThreshold', { exact: true }).fill('1000')
      await desktopPage.getByLabel('scenario', { exact: true }).fill('desktop-broker-backed')

      const runsBefore = await apiListWorkflowRuns(userToken, RECIPE_NS, BROKER_RECIPE_NAME, 20)
      const previousRunIds = runsBefore.items.map(item => item.id)
      await clickDesktopTrigger(desktopPage, detailCard)

      let runId = ''
      await expect
        .poll(
          async () => {
            const runs = await apiListWorkflowRuns(userToken, RECIPE_NS, BROKER_RECIPE_NAME, 20)
            const fresh = runs.items.find(
              item => item.actor?.userId === userId && !previousRunIds.includes(item.id)
            )
            runId = fresh?.id ?? ''
            return runId || null
          },
          {
            timeout: 60_000,
            intervals: [500, 1_000, 2_000],
            message: 'Desktop App trigger should create a broker-backed run',
          }
        )
        .not.toBeNull()

      const child = await waitForRunExecutionRef(userToken, BROKER_RECIPE_NAME, runId)
      expect(child.namespace).toBe(RECIPE_NS)
      await waitForRecipeWorkflowPhase(child.name, 'completed', 420_000)
      await waitForRunPhase(userToken, BROKER_RECIPE_NAME, runId, 'Succeeded')
      assertRunRetentionPolicy(runId)

      const pod = readCoordinatorPod(child.name)
      expect(pod.spec?.containers?.[0]?.image).toBe(CUSTOM_IMAGE)
      expect(pod.metadata?.labels?.['clerum.io/coordinator-tier']).toBe('custom')
      assertMcpHostPod(child.name)
      assertCoordinatorHasMcpHostChannel(child.name)

      const artifacts = await apiListRunArtifacts(userToken, BROKER_RECIPE_NAME, runId)
      assertDataArtifactSet(artifacts, [
        { name: ARTIFACT_NAME, format: 'json' },
        { name: SUMMARY_ARTIFACT_NAME, format: 'md' },
      ])

      const apiJson = await apiDownloadRunArtifact(
        userToken,
        BROKER_RECIPE_NAME,
        runId,
        ARTIFACT_NAME
      )
      assertBrokerArtifactPayload(apiJson, child.name, requestId)
      const apiSummary = await apiDownloadRunArtifactText(
        userToken,
        BROKER_RECIPE_NAME,
        runId,
        SUMMARY_ARTIFACT_NAME
      )
      expect(apiSummary).toContain('brokerBacked: true')
      expect(apiSummary).toContain('mcpDataUsed: true')
      expect(apiSummary).toContain('mock-tools__add')

      const desktopJsonButton = await refreshDesktopRunsAndFindArtifactButton(
        desktopPage,
        runId,
        ARTIFACT_NAME
      )
      assertBrokerArtifactPayload(
        await downloadJsonFromDesktopWorkflowButton(
          desktopPage,
          desktopJsonButton,
          runId,
          ARTIFACT_NAME
        ),
        child.name,
        requestId
      )

      const desktopSummaryButton = await refreshDesktopRunsAndFindArtifactButton(
        desktopPage,
        runId,
        SUMMARY_ARTIFACT_NAME
      )
      const desktopSummary = await downloadTextFromDesktopWorkflowButton(
        desktopPage,
        desktopSummaryButton,
        runId,
        SUMMARY_ARTIFACT_NAME
      )
      expect(desktopSummary).toContain('mock-tools__add')

      assertBrokerArtifactPayload(
        await downloadArtifactFromControlUiRun(page, BROKER_RECIPE_NAME, runId, ARTIFACT_NAME),
        child.name,
        requestId
      )
      const controlSummary = await downloadTextArtifactFromControlUiRun(
        page,
        BROKER_RECIPE_NAME,
        runId,
        SUMMARY_ARTIFACT_NAME
      )
      expect(controlSummary).toContain('mcpDataUsed: true')
    } finally {
      await app.close()
    }
  })
})
