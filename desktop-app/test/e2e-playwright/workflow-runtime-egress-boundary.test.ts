/**
 * Desktop App + Control UI -- Workflow runtime egress boundary
 *
 * E2E contract:
 * - Operator journey: install a WorkflowRecipe through Control UI, validate it,
 *   grant a real user, and deploy it without API shortcuts.
 * - User journey: sign in to Desktop App, select the granted workflow, trigger
 *   an on-demand run, observe the run, and download the run-scoped artifact.
 * - Business/security signal: the successful recipe proves WRC mcp-host public
 *   egress to the LLM provider plus recipe MCP transport egress to a public
 *   allowlisted host. The denied recipe proves a recipe MCP transport workload
 *   cannot reach public internet when egressBindings are omitted.
 */
import { type Locator, type Page, expect, test } from '@playwright/test'
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
  E2E_EMAIL,
  EXT_API,
  K8S_CONTEXT,
  RECIPE_NS,
  apiListWorkflowRuns,
  apiRequest,
  clearSession,
  ensureWorkflowTriggerFixturesSeeded,
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
const MCP_SERVER_NS = process.env.MCP_SERVER_NS || 'mcp-server'
const WORKLOAD_ID = 'egress-probe'
const PUBLIC_URL = 'https://example.com/'
const PUBLIC_HOST = 'example.com'
const ARTIFACT_NAME = 'egress-boundary-report.md'
const DENIED_PREFLIGHT_ARTIFACT_NAME = 'egress-denied-preflight.json'
const DENIED_UNEXPECTED_SUCCESS_ARTIFACT_NAME = 'unexpected-egress-success.json'
const POSITIVE_RECIPE_NAME = `e2e-ui-egress-boundary-${Date.now()}`
const DENIED_RECIPE_NAME = `e2e-ui-egress-denied-${Date.now()}`

type K8sList<T> = { items: T[] }
type K8sCondition = { type?: string; status?: string; reason?: string; message?: string }
type K8sMcpServer = {
  metadata?: { name?: string; labels?: Record<string, string> }
  status?: {
    resolvedEgressIPs?: Array<{ dns?: string; ips?: string[]; resolvedAt?: string }>
    conditions?: K8sCondition[]
  }
}
type K8sNetworkPolicy = {
  metadata?: { name?: string; namespace?: string; labels?: Record<string, string> }
  spec?: {
    egress?: Array<{
      to?: Array<{ ipBlock?: { cidr?: string; except?: string[] } }>
      ports?: Array<{ port?: number; protocol?: string }>
    }>
  }
}
type K8sWorkflowRecipe = {
  status?: {
    workflowExecution?: {
      phase?: string
      message?: string
    }
    steps?: Array<{ id?: string; phase?: string; output?: unknown; error?: string }>
  }
}
type WorkflowRunArtifactDto = { name: string; format?: string; path?: unknown }

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
    timeout,
  })
}

function kubectlJson<T>(args: string[], timeout = 30_000): T {
  return JSON.parse(kubectl(args, undefined, timeout)) as T
}

function runProfilesSql(sql: string, timeout = 20_000): string {
  return kubectl(
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

function buildEgressRecipeManifest(
  name: string,
  includeEgressBinding: boolean
): Record<string, unknown> {
  return {
    apiVersion: 'clerum.io/v1alpha1',
    kind: 'WorkflowRecipe',
    metadata: { name },
    spec: {
      description: includeEgressBinding
        ? 'E2E product path for workflow mcp-host and recipe MCP transport public egress.'
        : 'E2E negative path proving recipe MCP transport has no public egress without egressBindings.',
      // This E2E targets the HCC-delegated MCP transport path because external
      // egressBindings are reconciled from McpServer CRDs.
      contextRef: `wf-${name}`,
      security: { allowContextRef: true },
      agent: { provider: 'zai', model: 'glm-4.7' },
      inputContract: {
        type: 'object',
        properties: {
          publicUrl: { type: 'string', default: PUBLIC_URL },
          marker: { type: 'string', default: `${name}-marker` },
        },
      },
      triggers: {
        onDemand: {
          requiresApproval: false,
          allowedActors: ['user'],
        },
      },
      runRetention: {
        maxRunDurationSeconds: 600,
        ttlSecondsAfterFinished: 7200,
      },
      output: {
        destination: 'pvc',
        name,
        format: 'multi',
        storageSize: '128Mi',
      },
      mcpServers: [{ id: WORKLOAD_ID }],
      workloads: [
        {
          id: WORKLOAD_ID,
          type: 'deployment',
          image: 'clerum/mock-mcp-server:test',
          imagePullPolicy: 'IfNotPresent',
          port: 3000,
          transport: { type: 'streamableHttp', path: '/mcp' },
          env: [
            { name: 'FETCH_TIMEOUT_MS', value: '10000' },
            { name: 'EGRESS_PROBE_ALLOWED_HOSTS', value: PUBLIC_HOST },
          ],
          healthCheck: { type: 'tcp', port: 3001 },
          ...(includeEgressBinding && {
            egressBindings: [{ dns: PUBLIC_HOST, port: 443, protocol: 'TCP' }],
          }),
        },
      ],
      steps: includeEgressBinding
        ? [
            {
              id: 'agentic-provider-check',
              timeoutSeconds: 120,
              instruction: [
                'Return exactly one line.',
                'The line must be:',
                'MCP_HOST_PROVIDER_OK {{inputs.marker}}',
              ].join('\n'),
            },
            {
              id: 'snippet-mcp-public-egress-report',
              dependsOn: ['agentic-provider-check'],
              timeoutSeconds: 180,
              run: {
                type: 'snippet',
                language: 'typescript',
                code: [
                  'const fetchResult = await sdk.mcp.callTool("egress-probe", "fetch_http", {',
                  '  url: sdk.inputs.publicUrl',
                  '})',
                  'const fetchText = JSON.stringify(fetchResult)',
                  'if (!fetchText.includes("example.com") || !fetchText.includes("Example Domain")) {',
                  '  throw new Error(`unexpected fetch_http result: ${fetchText}`)',
                  '}',
                  'const providerOutput = String(sdk.previousOutputs["agentic-provider-check"] ?? "")',
                  'if (!providerOutput.includes(`MCP_HOST_PROVIDER_OK ${sdk.inputs.marker}`)) {',
                  '  throw new Error(`provider check did not return expected marker: ${providerOutput}`)',
                  '}',
                  'const report = [',
                  '  "# Runtime Egress Boundary",',
                  '  "",',
                  '  "MCP_HOST_PROVIDER_OK",',
                  '  "MCP_SERVER_HTTP_OK",',
                  '  `Marker: ${sdk.inputs.marker}`,',
                  '  "Host: example.com"',
                  '].join("\\n")',
                  `await sdk.artifacts.writeMarkdown("${ARTIFACT_NAME}", report)`,
                  'return { providerOk: true, mcpServerHttpOk: true, host: "example.com" }',
                ].join('\n'),
                capabilities: {
                  mcp: {
                    servers: [WORKLOAD_ID],
                    allowedTools: { include: [`${WORKLOAD_ID}__fetch_http`] },
                  },
                  artifacts: { maxCount: 1 },
                },
              },
            },
          ]
        : [
            {
              id: 'snippet-mcp-egress-denied',
              timeoutSeconds: 120,
              run: {
                type: 'snippet',
                language: 'typescript',
                code: [
                  `await sdk.artifacts.writeJson("${DENIED_PREFLIGHT_ARTIFACT_NAME}", {`,
                  '  beforeFetch: true,',
                  '  publicUrl: sdk.inputs.publicUrl',
                  '})',
                  'const result = await sdk.mcp.callTool("egress-probe", "fetch_http", {',
                  '  url: sdk.inputs.publicUrl',
                  '})',
                  'const resultText = JSON.stringify(result)',
                  'if (result?.isError || resultText.includes("aborted") || resultText.includes("fetch failed")) {',
                  '  throw new Error(`egress blocked as expected: ${resultText}`)',
                  '}',
                  `await sdk.artifacts.writeJson("${DENIED_UNEXPECTED_SUCCESS_ARTIFACT_NAME}", { result })`,
                  'return { unexpectedEgressSuccess: true, result }',
                ].join('\n'),
                capabilities: {
                  mcp: {
                    servers: [WORKLOAD_ID],
                    allowedTools: { include: [`${WORKLOAD_ID}__fetch_http`] },
                  },
                  artifacts: { maxCount: 2 },
                },
              },
            },
          ],
    },
  }
}

async function controlUiLogin(page: Page): Promise<string> {
  const password = requireAdminPassword()
  await page.goto(CONTROL_UI)
  const existingToken = await page.evaluate(() => localStorage.getItem('controlUiAdminToken') ?? '')
  if (existingToken) {
    return existingToken
  }

  const workflowHeading = page.getByText('Workflow Recipes', { exact: false })
  if (await workflowHeading.isVisible({ timeout: 2_000 }).catch(() => false)) {
    const workflowToken = await page.evaluate(
      () => localStorage.getItem('controlUiAdminToken') ?? ''
    )
    expect(workflowToken, 'Control UI should already have an admin token').toBeTruthy()
    return workflowToken
  }

  const usernameInput = page.getByLabel('Username')
  const passwordInput = page.getByLabel('Password')
  await expect(usernameInput).toBeVisible({ timeout: 25_000 })
  await expect(passwordInput).toBeVisible({ timeout: 25_000 })
  await usernameInput.fill(ADMIN_USERNAME)
  await passwordInput.fill(password)
  const signInButton = page.getByRole('button', { name: /^Sign in$/ })
  await expect(signInButton).toBeEnabled({ timeout: 10_000 })
  await signInButton.click()
  await expect(workflowHeading).toBeVisible({
    timeout: 25_000,
  })
  const token = await page.evaluate(() => localStorage.getItem('controlUiAdminToken') ?? '')
  expect(token, 'Control UI should persist admin token after login').toBeTruthy()
  return token
}

function visibleInstallFailureText(body: string): string | null {
  const patterns = [
    /Validation failed[\s\S]{0,800}/i,
    /Cannot deploy[\s\S]{0,800}/i,
    /\d{3} Internal Server Error[\s\S]{0,800}/i,
    /Unsupported value[\s\S]{0,800}/i,
    /policy violation[\s\S]{0,800}/i,
  ]
  for (const pattern of patterns) {
    const match = body.match(pattern)
    if (match?.[0]) return match[0].replace(/\s+/g, ' ').slice(0, 700)
  }
  return null
}

async function installRecipeFromControlUi(
  page: Page,
  recipeName: string,
  manifest: Record<string, unknown>,
  userEmail: string
): Promise<string> {
  const adminToken = await controlUiLogin(page)
  await page.goto(`${CONTROL_UI}/workflow-recipes`)
  await page.getByRole('button', { name: 'Install Recipe' }).click()

  const editor = page.locator('textarea').first()
  await expect(editor).toBeVisible({ timeout: 15_000 })
  await editor.fill(JSON.stringify(manifest, null, 2))
  await page.getByRole('button', { name: 'Validate' }).click()
  await expect(page.getByText(/Validation passed/i)).toBeVisible({ timeout: 20_000 })
  await expect(page.getByText(/Validation failed/i)).toHaveCount(0)

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
  await expect
    .poll(
      async () => {
        if (
          await page
            .getByRole('link', { name: `Open ${recipeName}` })
            .isVisible()
            .catch(() => false)
        ) {
          return 'deployed'
        }
        const body = await page
          .locator('body')
          .innerText()
          .catch(() => '')
        const failure = visibleInstallFailureText(body)
        return failure ? `error:${failure}` : 'pending'
      },
      {
        timeout: 60_000,
        intervals: [1_000, 2_000, 5_000],
        message: `Control UI should deploy ${RECIPE_NS}/${recipeName} or show a deploy error`,
      }
    )
    .toBe('deployed')
  await expect(page.getByRole('link', { name: `Open ${recipeName}` })).toBeVisible()
  return adminToken
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
        const parsed = JSON.parse(res.body) as { status?: { phase?: string; message?: string } }
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

async function waitForRunExecutionRef(
  userToken: string,
  recipeName: string,
  runId: string
): Promise<{ namespace: string; name: string }> {
  let lastPhase = ''
  await expect
    .poll(
      async () => {
        const runs = await apiListWorkflowRuns(userToken, RECIPE_NS, recipeName, 20)
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

  const runs = await apiListWorkflowRuns(userToken, RECIPE_NS, recipeName, 20)
  const run = runs.items.find(item => item.id === runId)
  if (!run?.executionRef) throw new Error(`run ${runId} has no executionRef`)
  return run.executionRef
}

async function waitForRunPhase(
  userToken: string,
  recipeName: string,
  runId: string,
  expected: string,
  timeoutMs = 300_000
): Promise<void> {
  await expect
    .poll(
      async () => {
        const runs = await apiListWorkflowRuns(userToken, RECIPE_NS, recipeName, 20)
        const run = runs.items.find(item => item.id === runId)
        return run?.phase ?? ''
      },
      {
        timeout: timeoutMs,
        intervals: [2_000, 5_000],
        message: `workflow run ${runId} should reach phase ${expected}`,
      }
    )
    .toBe(expected)
}

async function triggerRunFromDesktop(
  desktopPage: Page,
  detailCard: Locator,
  userToken: string,
  userId: string,
  recipeName: string,
  inputs: Record<string, string>,
  expectedRunPhase: 'Succeeded' | 'Failed'
): Promise<{ runId: string; childName: string }> {
  for (const [name, value] of Object.entries(inputs)) {
    await desktopPage.getByLabel(name, { exact: true }).fill(value)
  }

  const runsBefore = await apiListWorkflowRuns(userToken, RECIPE_NS, recipeName, 20)
  const previousRunIds = runsBefore.items.map(item => item.id)
  await detailCard.getByRole('button', { name: /^trigger$/i }).click()
  await expect(
    desktopPage.getByRole('status').filter({ hasText: 'Workflow triggered.' })
  ).toBeVisible({ timeout: 10_000 })

  let runId = ''
  await expect
    .poll(
      async () => {
        const runs = await apiListWorkflowRuns(userToken, RECIPE_NS, recipeName, 20)
        const fresh = runs.items.find(
          item => item.actor?.userId === userId && !previousRunIds.includes(item.id)
        )
        runId = fresh?.id ?? ''
        return runId || null
      },
      {
        timeout: 60_000,
        intervals: [500, 1_000, 2_000],
        message: `Desktop App trigger should create a workflow run for ${recipeName}`,
      }
    )
    .not.toBeNull()

  const child = await waitForRunExecutionRef(userToken, recipeName, runId)
  expect(child.namespace).toBe(RECIPE_NS)
  await waitForRecipeWorkflowPhase(
    child.name,
    expectedRunPhase === 'Succeeded' ? 'completed' : 'failed',
    300_000
  )
  await waitForRunPhase(userToken, recipeName, runId, expectedRunPhase)
  return { runId, childName: child.name }
}

async function apiListRunArtifacts(
  userToken: string,
  recipeName: string,
  runId: string
): Promise<WorkflowRunArtifactDto[]> {
  const response = await apiRequest(
    'GET',
    `${EXT_API}/api/v1/workflows/${encodeURIComponent(RECIPE_NS)}/${encodeURIComponent(recipeName)}/runs/${encodeURIComponent(runId)}/artifacts`,
    undefined,
    { Authorization: `Bearer ${userToken}` }
  )
  if (response.status !== 200) {
    throw new Error(`list run artifacts failed: HTTP ${response.status} ${response.body}`)
  }
  const parsed = JSON.parse(response.body) as { artifacts?: WorkflowRunArtifactDto[] }
  return parsed.artifacts ?? []
}

async function waitForRunArtifacts(
  userToken: string,
  recipeName: string,
  runId: string,
  expectedNames: string[]
): Promise<WorkflowRunArtifactDto[]> {
  let artifacts: WorkflowRunArtifactDto[] = []
  await expect
    .poll(
      async () => {
        artifacts = await apiListRunArtifacts(userToken, recipeName, runId)
        const names = new Set(artifacts.map(artifact => artifact.name))
        return expectedNames.every(name => names.has(name))
      },
      {
        timeout: 120_000,
        intervals: [1_000, 2_000, 5_000],
        message: `run ${runId} should expose artifacts ${expectedNames.join(', ')}`,
      }
    )
    .toBe(true)
  return artifacts
}

async function refreshDesktopRunsAndFindArtifactButton(
  desktopPage: Page,
  runId: string
): Promise<Locator> {
  await desktopPage.getByRole('button', { name: /^refresh$/i }).click()
  const runRow = desktopPage.locator('.workflow-run-row').filter({ hasText: runId.slice(0, 8) })
  await expect(runRow).toBeVisible({ timeout: 30_000 })
  const artifactButton = runRow.getByRole('button', { name: ARTIFACT_NAME })
  await expect(artifactButton).toBeVisible({ timeout: 30_000 })
  return artifactButton
}

async function downloadTextFromControlUiButton(
  page: Page,
  button: Locator,
  artifactName: string,
  expectedFilename: string
): Promise<string> {
  const downloadPromise = page.waitForEvent('download', { timeout: 30_000 })
  await button.click()
  const download = await downloadPromise
  expect(download.suggestedFilename()).toBe(expectedFilename)
  const tmpFile = path.join(os.tmpdir(), `clerum-${Date.now()}-${download.suggestedFilename()}`)
  await download.saveAs(tmpFile)
  try {
    const text = fs.readFileSync(tmpFile, 'utf8')
    expect(text, `${artifactName} should not be empty`).not.toHaveLength(0)
    return text
  } finally {
    fs.rmSync(tmpFile, { force: true })
  }
}

async function downloadTextFromDesktopArtifactButton(
  desktopPage: Page,
  button: Locator,
  runId: string
): Promise<string> {
  const expectedFilename = `${runId.slice(0, 8)}-${ARTIFACT_NAME}`
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
  try {
    return fs.readFileSync(downloadPath, 'utf8')
  } finally {
    fs.rmSync(downloadPath, { force: true })
  }
}

async function downloadArtifactFromControlUiRun(
  page: Page,
  recipeName: string,
  runId: string
): Promise<string> {
  await page.goto(
    `${CONTROL_UI}/workflow-recipes/${encodeURIComponent(RECIPE_NS)}/${encodeURIComponent(recipeName)}/runs/${encodeURIComponent(runId)}`
  )
  await expect(page.getByTestId('artifacts-panel')).toBeVisible({ timeout: 60_000 })
  const artifactRow = page.getByTestId('artifact-row').filter({ hasText: ARTIFACT_NAME })
  await expect(artifactRow).toBeVisible({ timeout: 15_000 })
  return downloadTextFromControlUiButton(
    page,
    artifactRow.getByTestId('artifact-download'),
    ARTIFACT_NAME,
    `${runId.slice(0, 8)}-${ARTIFACT_NAME}`
  )
}

function getMcpServerForRecipe(recipeName: string): K8sMcpServer {
  const servers = kubectlJson<K8sList<K8sMcpServer>>([
    '-n',
    MCP_SERVER_NS,
    'get',
    'mcpserver',
    '-l',
    `clerum.io/recipe=${recipeName},clerum.io/workload=${WORKLOAD_ID}`,
    '-o',
    'json',
  ])
  expect(servers.items, `expected one McpServer for ${recipeName}/${WORKLOAD_ID}`).toHaveLength(1)
  return servers.items[0]
}

async function assertExternalEgressPolicy(recipeName: string): Promise<void> {
  await expect
    .poll(
      () => {
        try {
          const server = getMcpServerForRecipe(recipeName)
          const serverName = server.metadata?.name
          const policies = kubectlJson<K8sList<K8sNetworkPolicy>>([
            '-n',
            MCP_SERVER_NS,
            'get',
            'networkpolicy',
            '-l',
            `clerum.io/policy-type=external-egress,clerum.io/mcpserver=${serverName}`,
            '-o',
            'json',
          ])
          const condition = server.status?.conditions?.find(
            item => item.type === 'ExternalEgressReady'
          )
          const resolvedCount = server.status?.resolvedEgressIPs?.[0]?.ips?.length ?? 0
          return `${policies.items.length}:${condition?.status ?? ''}:${server.status?.resolvedEgressIPs?.[0]?.dns ?? ''}:${resolvedCount}`
        } catch {
          return 'missing'
        }
      },
      {
        timeout: 90_000,
        intervals: [2_000, 5_000],
        message: `HCC should create ready external egress policy for ${recipeName}/${WORKLOAD_ID}`,
      }
    )
    .toMatch(/^1:True:example\.com:[1-9][0-9]*$/)

  const server = getMcpServerForRecipe(recipeName)
  const serverName = server.metadata?.name
  expect(serverName).toBeTruthy()

  const policies = kubectlJson<K8sList<K8sNetworkPolicy>>([
    '-n',
    MCP_SERVER_NS,
    'get',
    'networkpolicy',
    '-l',
    `clerum.io/policy-type=external-egress,clerum.io/mcpserver=${serverName}`,
    '-o',
    'json',
  ])
  expect(policies.items, `external egress policy should exist for ${serverName}`).toHaveLength(1)
  const policy = policies.items[0]
  expect(policy.metadata?.labels?.['clerum.io/managed-by']).toBe('host-context-controller')
  expect(policy.spec?.egress?.length).toBeGreaterThan(0)
  for (const rule of policy.spec?.egress ?? []) {
    expect(rule.ports?.[0]).toMatchObject({ port: 443, protocol: 'TCP' })
    const cidr = rule.to?.[0]?.ipBlock?.cidr ?? ''
    expect(cidr).toMatch(/\/32$/)
    expect(cidr).not.toBe('0.0.0.0/0')
  }

  const condition = server.status?.conditions?.find(item => item.type === 'ExternalEgressReady')
  expect(condition).toMatchObject({ status: 'True' })
  expect(server.status?.resolvedEgressIPs?.[0]?.dns).toBe(PUBLIC_HOST)
  expect(server.status?.resolvedEgressIPs?.[0]?.ips?.length).toBeGreaterThan(0)
}

async function assertNoExternalEgressPolicy(recipeName: string): Promise<void> {
  const server = getMcpServerForRecipe(recipeName)
  const serverName = server.metadata?.name
  expect(serverName).toBeTruthy()
  await expect
    .poll(
      () => {
        const policies = kubectlJson<K8sList<K8sNetworkPolicy>>([
          '-n',
          MCP_SERVER_NS,
          'get',
          'networkpolicy',
          '-l',
          `clerum.io/policy-type=external-egress,clerum.io/mcpserver=${serverName}`,
          '-o',
          'json',
        ])
        return policies.items.length
      },
      {
        timeout: 60_000,
        intervals: [2_000, 5_000],
        message: `no external egress policy should exist for ${serverName}`,
      }
    )
    .toBe(0)
}

function assertNoLegacyBroadMcpServerPolicy(recipeNames: string[]): void {
  const policies = kubectlJson<K8sList<K8sNetworkPolicy>>([
    'get',
    'networkpolicy',
    '-A',
    '-o',
    'json',
  ])
  const legacy = policies.items.filter(policy => {
    const name = policy.metadata?.name ?? ''
    const recipe = policy.metadata?.labels?.['clerum.io/recipe'] ?? ''
    return (
      name.endsWith('-mcp-servers-egress-internet') &&
      recipeNames.some(recipeName => recipe === recipeName || name.startsWith(recipeName))
    )
  })
  expect(
    legacy,
    'WRC must not recreate legacy broad recipe MCP-server internet egress'
  ).toHaveLength(0)
}

function assertWorkflowMcpHostPod(childName: string): void {
  const pod = kubectlJson<{
    metadata?: { labels?: Record<string, string> }
    spec?: { automountServiceAccountToken?: boolean }
  }>(['-n', RECIPE_NS, 'get', 'pod', `${childName}-mcp-host`, '-o', 'json'])
  expect(pod.metadata?.labels?.['clerum.io/component']).toBe('workflow-mcp-host')
  expect(pod.spec?.automountServiceAccountToken).toBe(false)
}

function collectText(value: unknown): string {
  if (typeof value === 'string') return value
  if (Array.isArray(value)) return value.map(item => collectText(item)).join('\n')
  if (value && typeof value === 'object') {
    const maybeText = (value as { text?: unknown }).text
    if (typeof maybeText === 'string') return maybeText
    return JSON.stringify(value)
  }
  return String(value ?? '')
}

function assertRuntimeSignals(childName: string, marker: string): void {
  const child = kubectlJson<K8sWorkflowRecipe>([
    '-n',
    RECIPE_NS,
    'get',
    'workflowrecipe',
    childName,
    '-o',
    'json',
  ])
  expect(child.status?.workflowExecution?.phase).toBe('completed')

  const steps = child.status?.steps ?? []
  const providerStep = steps.find(step => step.id === 'agentic-provider-check')
  expect(providerStep, 'agentic provider step should be reported in child status').toBeTruthy()
  expect(providerStep?.phase).toBe('completed')
  expect(providerStep?.error).toBeUndefined()
  expect(collectText(providerStep?.output)).toContain(`MCP_HOST_PROVIDER_OK ${marker}`)

  const mcpStep = steps.find(step => step.id === 'snippet-mcp-public-egress-report')
  expect(mcpStep, 'snippet MCP public-egress step should be reported in child status').toBeTruthy()
  expect(mcpStep?.phase).toBe('completed')
  expect(mcpStep?.error).toBeUndefined()
  const mcpOutputText = collectText(mcpStep?.output)
  expect(mcpOutputText).toContain('providerOk')
  expect(mcpOutputText).toContain('mcpServerHttpOk')
  expect(mcpOutputText).toContain(PUBLIC_HOST)
}

function assertReport(text: string, marker: string): void {
  expect(text).toContain('MCP_HOST_PROVIDER_OK')
  expect(text).toContain('MCP_SERVER_HTTP_OK')
  expect(text).toContain(`Marker: ${marker}`)
  expect(text).toContain('Host: example.com')
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
    // Cleanup is best effort so the test can still report the original failure.
  }

  try {
    const mcpServers = kubectl([
      '-n',
      MCP_SERVER_NS,
      'get',
      'mcpserver',
      '-l',
      `clerum.io/recipe=${name}`,
      '-o',
      'jsonpath={range .items[*]}{.metadata.name}{"\\n"}{end}',
    ])
      .split('\n')
      .map(item => item.trim())
      .filter(Boolean)
    if (mcpServers.length > 0) {
      kubectl([
        '-n',
        MCP_SERVER_NS,
        'delete',
        'mcpserver',
        ...mcpServers,
        '--ignore-not-found=true',
        '--wait=false',
      ])
    }
  } catch {
    // Label-based cleanup protects non-E2E state; later WRC/HCC passes can finish leftovers.
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
      `,
      30_000
    )
  } catch {
    // Rows are test-named; a later cleanup pass can remove leftovers if needed.
  }
}

test.describe('Workflow runtime egress boundary user flows', () => {
  test.slow()
  test.describe.configure({ timeout: 1_200_000 })

  test.beforeAll(async () => {
    ensureWorkflowTriggerFixturesSeeded()
    await clearSession()
  })

  test.afterAll(async () => {
    cleanupRecipe(POSITIVE_RECIPE_NAME)
    cleanupRecipe(DENIED_RECIPE_NAME)
  })

  test('installs in Control UI, triggers in Desktop App, enforces MCP transport egress, and downloads artifacts', async ({
    page,
  }) => {
    await Promise.all([
      apiRequest('GET', `${CONTROL_API}/health`).then(res => expect(res.status).toBe(200)),
      apiRequest('GET', `${EXT_API}/health`).then(res => expect(res.status).toBe(200)),
    ])

    const positiveManifest = buildEgressRecipeManifest(POSITIVE_RECIPE_NAME, true)
    const deniedManifest = buildEgressRecipeManifest(DENIED_RECIPE_NAME, false)

    const adminToken = await installRecipeFromControlUi(
      page,
      POSITIVE_RECIPE_NAME,
      positiveManifest,
      E2E_EMAIL
    )
    await waitForAdminRecipeActive(adminToken, POSITIVE_RECIPE_NAME)
    await assertExternalEgressPolicy(POSITIVE_RECIPE_NAME)
    assertNoLegacyBroadMcpServerPolicy([POSITIVE_RECIPE_NAME])

    await installRecipeFromControlUi(page, DENIED_RECIPE_NAME, deniedManifest, E2E_EMAIL)
    await waitForAdminRecipeActive(adminToken, DENIED_RECIPE_NAME)
    await assertNoExternalEgressPolicy(DENIED_RECIPE_NAME)
    assertNoLegacyBroadMcpServerPolicy([POSITIVE_RECIPE_NAME, DENIED_RECIPE_NAME])

    const { userId, userToken } = await loginAs(E2E_EMAIL)
    const { app, page: desktopPage } = await launchAndLogin(E2E_EMAIL)
    try {
      await openWorkflowsPage(desktopPage)
      await expect(workflowRow(desktopPage, POSITIVE_RECIPE_NAME)).toBeVisible({ timeout: 20_000 })
      await expect(workflowRow(desktopPage, DENIED_RECIPE_NAME)).toBeVisible({ timeout: 20_000 })

      const positiveDetail = await selectWorkflow(desktopPage, POSITIVE_RECIPE_NAME, RECIPE_NS)
      await expect(positiveDetail.locator('.input-contract-form')).toBeVisible({ timeout: 10_000 })
      const marker = `egress-ok-${Date.now()}`
      const positiveRun = await triggerRunFromDesktop(
        desktopPage,
        positiveDetail,
        userToken,
        userId,
        POSITIVE_RECIPE_NAME,
        { publicUrl: PUBLIC_URL, marker },
        'Succeeded'
      )
      assertWorkflowMcpHostPod(positiveRun.childName)
      assertRuntimeSignals(positiveRun.childName, marker)

      const artifacts = await waitForRunArtifacts(
        userToken,
        POSITIVE_RECIPE_NAME,
        positiveRun.runId,
        [ARTIFACT_NAME]
      )
      expect(artifacts).toEqual(
        expect.arrayContaining([expect.objectContaining({ name: ARTIFACT_NAME, format: 'md' })])
      )
      for (const artifact of artifacts) {
        expect(artifact).not.toHaveProperty('path')
      }

      const desktopArtifactButton = await refreshDesktopRunsAndFindArtifactButton(
        desktopPage,
        positiveRun.runId
      )
      assertReport(
        await downloadTextFromDesktopArtifactButton(
          desktopPage,
          desktopArtifactButton,
          positiveRun.runId
        ),
        marker
      )
      assertReport(
        await downloadArtifactFromControlUiRun(page, POSITIVE_RECIPE_NAME, positiveRun.runId),
        marker
      )

      await openWorkflowsPage(desktopPage)
      const deniedDetail = await selectWorkflow(desktopPage, DENIED_RECIPE_NAME, RECIPE_NS)
      await expect(deniedDetail.locator('.input-contract-form')).toBeVisible({ timeout: 10_000 })
      const deniedRun = await triggerRunFromDesktop(
        desktopPage,
        deniedDetail,
        userToken,
        userId,
        DENIED_RECIPE_NAME,
        { publicUrl: PUBLIC_URL, marker: `egress-denied-${Date.now()}` },
        'Failed'
      )
      const deniedChild = await waitForRecipeWorkflowPhase(deniedRun.childName, 'failed', 120_000)
      expect(deniedChild.status?.workflowExecution?.phase).toBe('failed')
      expect(collectText(deniedChild.status?.workflowExecution?.message)).toContain(
        'egress blocked as expected'
      )
      const deniedStep = deniedChild.status?.steps?.find(
        step => step.id === 'snippet-mcp-egress-denied'
      )
      expect(deniedStep?.phase).toBe('failed')
      expect(collectText(deniedStep?.error)).toContain('egress blocked as expected')
      await assertNoExternalEgressPolicy(DENIED_RECIPE_NAME)
      assertNoLegacyBroadMcpServerPolicy([POSITIVE_RECIPE_NAME, DENIED_RECIPE_NAME])
    } finally {
      await app.close()
    }
  })
})
