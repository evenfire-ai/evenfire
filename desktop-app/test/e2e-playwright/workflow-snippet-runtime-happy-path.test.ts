/**
 * Desktop App + Control UI -- Layer 3A TypeScript Snippet Runtime
 *
 * Proves the product path for a platform-owned snippet workflow:
 *   control-ui admin installs a WorkflowRecipe with run.type=snippet
 *     -> admin grants test@clerum.io trigger access
 *     -> Desktop App user triggers the workflow
 *     -> WRC creates a per-run child WorkflowRecipe
 *     -> the child run creates a platform workflow-snippet-runner
 *     -> the snippet writes /output/snippet-ui-result.json
 *     -> Desktop App and Control UI download that artifact by runId
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
const RECIPE_NS = 'sandbox-recipes'
const RECIPE_NAME = `e2e-ui-layer3a-snippet-${Date.now()}`
const ARTIFACT_NAME = 'snippet-ui-result.json'
const EXTRA_GRANT_EMAIL = 'placeholder-cfo@clerum.io'
const SNIPPET_SECRET_ALIAS = 'coingecko_api_key'
const SNIPPET_SECRET_KEY = 'apiKey'
const SNIPPET_SECRET_VALUE = 'CG-layer3a-e2e-key'
const WORKLOAD_SECRET_KEY = 'configToken'
const WORKLOAD_SECRET_ENV = 'CONFIG_TOKEN'
const WORKLOAD_SECRET_VALUE = 'workflow-config-token-e2e'
const RUN_MAX_DURATION_SECONDS = 600
const RUN_TTL_SECONDS_AFTER_FINISHED = 7200

type K8sWorkflowRecipe = {
  status?: { workflowExecution?: { phase?: string; message?: string } }
}
type K8sEnvVar = {
  name?: string
  value?: string
  valueFrom?: { secretKeyRef?: { name?: string; key?: string } }
}
type SnippetArtifactPayload = {
  layer?: string
  requestId?: string
  scenario?: string
  secretConfigured?: boolean
  inputEcho?: Record<string, unknown>
}
type WorkflowRunArtifactDto = { name: string; format?: string; path?: unknown }
type RunRetentionPolicy = {
  maxDurationSeconds: number | null
  ttlSecondsAfterFinished: number | null
}
type WorkflowRunsResult = Awaited<ReturnType<typeof apiListWorkflowRuns>>

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

function assertRunRetentionPolicy(runId: string): void {
  expect(readRunRetentionPolicy(runId)).toEqual({
    maxDurationSeconds: RUN_MAX_DURATION_SECONDS,
    ttlSecondsAfterFinished: RUN_TTL_SECONDS_AFTER_FINISHED,
  })
}

function buildSnippetRecipeManifest(name: string): Record<string, unknown> {
  const secretName = `${name}-coingecko-api`
  return {
    apiVersion: 'clerum.io/v1alpha1',
    kind: 'WorkflowRecipe',
    metadata: { name },
    spec: {
      inputContract: {
        type: 'object',
        properties: {
          requestId: { type: 'string', default: 'ui-snippet-default' },
          scenario: { type: 'string', default: 'layer3a-snippet-product-download' },
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
      workloads: [
        {
          id: 'config-probe',
          type: 'deployment',
          image: 'clerum/workflow-snippet-runner:test',
          imagePullPolicy: 'IfNotPresent',
          command: ['sh', '-c', 'sleep 3600'],
          env: [{ name: 'PUBLIC_MODE', value: 'ui-e2e' }],
          envSecret: {
            name: secretName,
            keys: [{ secretKey: WORKLOAD_SECRET_KEY, envVar: WORKLOAD_SECRET_ENV }],
          },
          resources: {
            requests: { cpu: '10m', memory: '32Mi' },
            limits: { cpu: '50m', memory: '64Mi' },
          },
          security: {
            runAsUser: 1000,
            runAsGroup: 1000,
          },
        },
      ],
      steps: [
        {
          id: 'emit-snippet-artifact',
          timeoutSeconds: 120,
          run: {
            type: 'snippet',
            language: 'typescript',
            code: [
              'const payload = {',
              '  layer: "3A",',
              '  requestId: sdk.inputs.requestId,',
              '  scenario: sdk.inputs.scenario,',
              `  secretConfigured: sdk.secrets.get("${SNIPPET_SECRET_ALIAS}").startsWith("CG-"),`,
              '  inputEcho: sdk.inputs',
              '}',
              `const artifact = await sdk.artifacts.writeJson("${ARTIFACT_NAME}", payload)`,
              'return { ...payload, artifact }',
            ].join('\n'),
            capabilities: {
              secrets: [
                {
                  alias: SNIPPET_SECRET_ALIAS,
                  secretRef: { name: secretName, key: SNIPPET_SECRET_KEY },
                },
              ],
              artifacts: { maxCount: 1 },
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
  userEmail: string
): Promise<string> {
  const adminToken = await controlUiLogin(page)
  await page.goto(`${CONTROL_UI}/workflow-recipes`)
  await page.getByRole('button', { name: 'Install Recipe' }).click()

  const editor = page.locator('textarea').first()
  await expect(editor).toBeVisible({ timeout: 15_000 })
  await editor.fill(JSON.stringify(buildSnippetRecipeManifest(recipeName), null, 2))
  await page.getByRole('button', { name: 'Validate' }).click()
  await expect(page.getByText(/Configuration & Secrets/i)).toBeVisible({ timeout: 15_000 })
  const secretInput = page.getByPlaceholder(`Enter value for ${SNIPPET_SECRET_ALIAS}`)
  await expect(secretInput).toBeVisible({ timeout: 15_000 })
  await secretInput.fill(SNIPPET_SECRET_VALUE)
  const workloadSecretInput = page.getByPlaceholder(`Enter value for ${WORKLOAD_SECRET_ENV}`)
  await expect(workloadSecretInput).toBeVisible({ timeout: 15_000 })
  await workloadSecretInput.fill(WORKLOAD_SECRET_VALUE)

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
  assertWorkflowRecipeSecretMaterialized(recipeName)
  assertInstalledRecipeDoesNotContainSecretValues(recipeName)
  return adminToken
}

function assertWorkflowRecipeSecretMaterialized(recipeName: string): void {
  const secretName = `${recipeName}-coingecko-api`
  const secret = kubectlJson<{ data?: Record<string, string> }>([
    '-n',
    RECIPE_NS,
    'get',
    'secret',
    secretName,
    '-o',
    'json',
  ])
  expect(Buffer.from(secret.data?.[SNIPPET_SECRET_KEY] ?? '', 'base64').toString('utf8')).toBe(
    SNIPPET_SECRET_VALUE
  )
  expect(Buffer.from(secret.data?.[WORKLOAD_SECRET_KEY] ?? '', 'base64').toString('utf8')).toBe(
    WORKLOAD_SECRET_VALUE
  )
}

function assertInstalledRecipeDoesNotContainSecretValues(recipeName: string): void {
  const recipe = kubectl(['-n', RECIPE_NS, 'get', 'workflowrecipe', recipeName, '-o', 'json'])
  expect(recipe).not.toContain(SNIPPET_SECRET_VALUE)
  expect(recipe).not.toContain(WORKLOAD_SECRET_VALUE)
}

async function grantExistingRecipeUserFromControlUi(
  page: Page,
  recipeName: string,
  userEmail: string
): Promise<void> {
  await page.goto(
    `${CONTROL_UI}/workflow-recipes/${encodeURIComponent(RECIPE_NS)}/${encodeURIComponent(recipeName)}?edit=1`
  )
  await expect(page.getByText(`Edit Recipe: ${recipeName}`)).toBeVisible({ timeout: 30_000 })
  await page.getByRole('button', { name: 'Validate' }).click()
  await expect(page.getByText(/Validation passed/i)).toBeVisible({ timeout: 15_000 })
  const userPicker = page.getByLabel('Pick a user to grant trigger access')
  await expect(userPicker).toBeVisible({ timeout: 20_000 })
  const optionValue = await userPicker
    .locator('option')
    .filter({ hasText: userEmail })
    .first()
    .getAttribute('value')
  expect(optionValue, `${userEmail} should be selectable when editing grants`).toBeTruthy()
  await userPicker.selectOption(optionValue!)
  await page.getByRole('button', { name: 'Grant user' }).click()
  await expect(page.getByTestId('workflow-access-trigger-users')).toContainText(userEmail, {
    timeout: 15_000,
  })
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

async function waitForWorkflowRunsAuthorized(
  userToken: string,
  name: string,
  limit = 20
): Promise<WorkflowRunsResult> {
  let lastBody = ''

  await expect
    .poll(
      async () => {
        const response = await apiRequest(
          'GET',
          `${EXT_API}/api/v1/workflows/${encodeURIComponent(RECIPE_NS)}/${encodeURIComponent(
            name
          )}/runs?limit=${limit}`,
          undefined,
          { Authorization: `Bearer ${userToken}` }
        )
        lastBody = response.body
        return response.status === 200 ? response.body : ''
      },
      {
        timeout: 30_000,
        intervals: [500, 1_000, 2_000],
        message: `workflow run listing should become authorized for ${RECIPE_NS}/${name}`,
      }
    )
    .not.toBe('')

  return JSON.parse(lastBody) as WorkflowRunsResult
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
  runId: string
): Promise<SnippetArtifactPayload> {
  const response = await fetch(
    `${EXT_API}/api/v1/workflows/${encodeURIComponent(RECIPE_NS)}/${encodeURIComponent(name)}/runs/${encodeURIComponent(runId)}/artifacts/${encodeURIComponent(ARTIFACT_NAME)}/download`,
    { headers: { Authorization: `Bearer ${userToken}` } }
  )
  if (!response.ok) {
    throw new Error(
      `download run artifact failed: HTTP ${response.status} ${await response.text()}`
    )
  }
  return (await response.json()) as SnippetArtifactPayload
}

async function apiTriggerSnippetRun(userToken: string, requestId: string): Promise<{ id: string }> {
  const response = await apiRequest(
    'POST',
    `${EXT_API}/api/v1/workflows/${encodeURIComponent(RECIPE_NS)}/${encodeURIComponent(RECIPE_NAME)}/trigger`,
    JSON.stringify({
      inputs: {
        requestId,
        scenario: 'post-install-grant-trigger',
      },
    }),
    {
      Authorization: `Bearer ${userToken}`,
      'Content-Type': 'application/json',
      'Idempotency-Key': `snippet-grant-${requestId}`,
    }
  )
  if (response.status !== 201 && response.status !== 200) {
    throw new Error(`trigger workflow failed: HTTP ${response.status} ${response.body}`)
  }
  return JSON.parse(response.body) as { id: string }
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

async function downloadJsonFromDesktopWorkflowButton(
  page: Page,
  button: Locator,
  expectedRunId: string
): Promise<SnippetArtifactPayload> {
  const expectedFilename = `${expectedRunId.slice(0, 8)}-${ARTIFACT_NAME}`
  const downloadPath = path.join(os.homedir(), 'Downloads', expectedFilename)
  fs.rmSync(downloadPath, { force: true })
  await button.click()
  const downloadedText = await expect
    .poll(
      () => {
        if (!fs.existsSync(downloadPath)) return ''
        const stats = fs.statSync(downloadPath)
        if (stats.size <= 0) return ''
        return fs.readFileSync(downloadPath, 'utf8')
      },
      {
        timeout: 30_000,
        intervals: [250, 500, 1_000],
        message: `Desktop App should save ${expectedFilename} to Downloads`,
      }
    )
    .not.toBe('')
    .then(() => fs.readFileSync(downloadPath, 'utf8'))
  fs.rmSync(downloadPath, { force: true })
  return JSON.parse(downloadedText) as SnippetArtifactPayload
}

async function downloadArtifactFromControlUiRun(
  page: Page,
  recipeName: string,
  runId: string
): Promise<SnippetArtifactPayload> {
  await page.goto(
    `${CONTROL_UI}/workflow-recipes/${encodeURIComponent(RECIPE_NS)}/${encodeURIComponent(recipeName)}/runs/${encodeURIComponent(runId)}`
  )
  await expect(page.getByTestId('artifacts-panel')).toBeVisible({ timeout: 60_000 })
  const artifactRow = page.getByTestId('artifact-row').filter({ hasText: ARTIFACT_NAME })
  await expect(artifactRow).toBeVisible({ timeout: 15_000 })
  return JSON.parse(
    await downloadTextFromButton(
      page,
      artifactRow.getByTestId('artifact-download'),
      ARTIFACT_NAME,
      `${runId.slice(0, 8)}-${ARTIFACT_NAME}`
    )
  ) as SnippetArtifactPayload
}

async function triggerSnippetRunFromDesktop(
  desktopPage: Page,
  detailCard: Locator,
  userToken: string,
  userId: string,
  requestId: string
): Promise<{ runId: string; childName: string }> {
  await desktopPage.getByLabel('requestId', { exact: true }).fill(requestId)
  await desktopPage.getByLabel('scenario', { exact: true }).fill('desktop-layer3a-snippet-trigger')

  const runsBefore = await apiListWorkflowRuns(userToken, RECIPE_NS, RECIPE_NAME, 20)
  const previousRunIds = runsBefore.items.map(item => item.id)
  await detailCard.getByRole('button', { name: /^trigger$/i }).click()
  await expect(
    desktopPage.getByRole('status').filter({ hasText: 'Workflow triggered.' })
  ).toBeVisible({ timeout: 10_000 })

  let runId = ''
  await expect
    .poll(
      async () => {
        const runs = await apiListWorkflowRuns(userToken, RECIPE_NS, RECIPE_NAME, 20)
        const fresh = runs.items.find(
          item => item.actor?.userId === userId && !previousRunIds.includes(item.id)
        )
        runId = fresh?.id ?? ''
        return runId || null
      },
      {
        timeout: 60_000,
        intervals: [500, 1_000, 2_000],
        message: 'Desktop App trigger should create a snippet workflow run',
      }
    )
    .not.toBeNull()

  const child = await waitForRunExecutionRef(userToken, RECIPE_NAME, runId)
  expect(child.namespace).toBe(RECIPE_NS)
  await waitForRecipeWorkflowPhase(child.name, 'completed', 300_000)
  await waitForRunPhase(userToken, RECIPE_NAME, runId, 'Succeeded')
  assertSnippetRunnerPod(child.name)
  assertNoMcpHostPod(child.name)

  return { runId, childName: child.name }
}

function assertSnippetArtifactPayload(
  artifact: SnippetArtifactPayload,
  expectedRequestId: string
): void {
  expect(artifact.layer).toBe('3A')
  expect(artifact.requestId).toBe(expectedRequestId)
  expect(artifact.scenario).toBe('desktop-layer3a-snippet-trigger')
  expect(artifact.secretConfigured).toBe(true)
  expect(artifact.inputEcho).toMatchObject({
    requestId: expectedRequestId,
    scenario: 'desktop-layer3a-snippet-trigger',
  })
}

function assertSnippetDataArtifactSet(artifacts: WorkflowRunArtifactDto[]): void {
  expect(artifacts).toHaveLength(1)
  expect(artifacts[0]).toEqual(expect.objectContaining({ name: ARTIFACT_NAME, format: 'json' }))
  expect(artifacts[0]).not.toHaveProperty('path')
  expect(artifacts[0]?.name).not.toMatch(
    /\.(?:cjs|mjs|js|jsx|ts|tsx|sh|bash|zsh|ps1|py|rb|php|pl|jar|war|class|wasm|html?)$/iu
  )
}

function assertSnippetRunnerPod(childName: string): void {
  const pod = kubectlJson<{
    metadata?: { labels?: Record<string, string> }
    spec?: { automountServiceAccountToken?: boolean; containers?: Array<{ env?: K8sEnvVar[] }> }
  }>(['-n', RECIPE_NS, 'get', 'pod', `${childName}-snippet-runner`, '-o', 'json'])
  expect(pod.spec?.automountServiceAccountToken).toBe(false)
  const envVars = pod.spec?.containers?.[0]?.env ?? []
  const envNames = envVars.map(env => env.name)
  const envByName = new Map(envVars.map(env => [env.name, env]))
  expect(envNames).toContain('CLERUM_WORKFLOW_NAME')
  expect(envByName.get('SNIPPET_RUNNER_TOKEN_FILE')?.value).toBe(
    '/var/run/clerum/workflow-tokens/snippet-runner-token'
  )
  expect(envNames).not.toContain('SNIPPET_RUNNER_TOKEN')
}

function assertNoMcpHostPod(childName: string): void {
  expect(() =>
    kubectl(['-n', RECIPE_NS, 'get', 'pod', `${childName}-mcp-host`], undefined, 10_000)
  ).toThrow()
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
    // PVCs are test-named; a later cleanup pass can remove leftovers if needed.
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

test.describe('Layer 3A snippet runtime user flow', () => {
  test.slow()
  test.describe.configure({ timeout: 900_000 })

  test.beforeAll(async () => {
    ensureWorkflowTriggerFixturesSeeded()
    await clearSession()
  })

  test.afterAll(async () => {
    cleanupRecipe(RECIPE_NAME)
  })

  test('installs in Control UI, triggers in Desktop App, and downloads run-scoped snippet artifact', async ({
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
    const { app, page: desktopPage } = await launchAndLogin(E2E_EMAIL)
    try {
      await openWorkflowsPage(desktopPage)
      const row = workflowRow(desktopPage, RECIPE_NAME)
      await expect(row).toBeVisible({ timeout: 20_000 })

      const detailCard = await selectWorkflow(desktopPage, RECIPE_NAME, RECIPE_NS)
      await expect(detailCard.locator('.input-contract-form')).toBeVisible({ timeout: 10_000 })

      const firstRequestId = `ui-snippet-first-${Date.now()}`
      const firstRun = await triggerSnippetRunFromDesktop(
        desktopPage,
        detailCard,
        userToken,
        userId,
        firstRequestId
      )

      const secondRequestId = `ui-snippet-second-${Date.now()}`
      const secondRun = await triggerSnippetRunFromDesktop(
        desktopPage,
        detailCard,
        userToken,
        userId,
        secondRequestId
      )
      expect(secondRun.runId).not.toBe(firstRun.runId)
      expect(secondRun.childName).not.toBe(firstRun.childName)
      assertRunRetentionPolicy(firstRun.runId)
      assertRunRetentionPolicy(secondRun.runId)

      const firstArtifacts = await apiListRunArtifacts(userToken, RECIPE_NAME, firstRun.runId)
      assertSnippetDataArtifactSet(firstArtifacts)
      assertSnippetArtifactPayload(
        await apiDownloadRunArtifact(userToken, RECIPE_NAME, firstRun.runId),
        firstRequestId
      )
      const secondArtifacts = await apiListRunArtifacts(userToken, RECIPE_NAME, secondRun.runId)
      assertSnippetDataArtifactSet(secondArtifacts)
      assertSnippetArtifactPayload(
        await apiDownloadRunArtifact(userToken, RECIPE_NAME, secondRun.runId),
        secondRequestId
      )

      const desktopFirstButton = await refreshDesktopRunsAndFindArtifactButton(
        desktopPage,
        firstRun.runId
      )
      assertSnippetArtifactPayload(
        await downloadJsonFromDesktopWorkflowButton(
          desktopPage,
          desktopFirstButton,
          firstRun.runId
        ),
        firstRequestId
      )

      const desktopSecondButton = await refreshDesktopRunsAndFindArtifactButton(
        desktopPage,
        secondRun.runId
      )
      assertSnippetArtifactPayload(
        await downloadJsonFromDesktopWorkflowButton(
          desktopPage,
          desktopSecondButton,
          secondRun.runId
        ),
        secondRequestId
      )

      assertSnippetArtifactPayload(
        await downloadArtifactFromControlUiRun(page, RECIPE_NAME, firstRun.runId),
        firstRequestId
      )
      assertSnippetArtifactPayload(
        await downloadArtifactFromControlUiRun(page, RECIPE_NAME, secondRun.runId),
        secondRequestId
      )

      await grantExistingRecipeUserFromControlUi(page, RECIPE_NAME, EXTRA_GRANT_EMAIL)
      const extraUser = await loginAs(EXTRA_GRANT_EMAIL)
      const extraUserRuns = await waitForWorkflowRunsAuthorized(
        extraUser.userToken,
        RECIPE_NAME,
        20
      )
      const extraUserRunIds = extraUserRuns.items.map(item => item.id)
      expect(extraUserRunIds).not.toContain(firstRun.runId)
      expect(extraUserRunIds).not.toContain(secondRun.runId)

      const extraRequestId = `ui-snippet-granted-${Date.now()}`
      const extraRun = await apiTriggerSnippetRun(extraUser.userToken, extraRequestId)
      const extraChild = await waitForRunExecutionRef(extraUser.userToken, RECIPE_NAME, extraRun.id)
      expect(extraChild.namespace).toBe(RECIPE_NS)
      await waitForRecipeWorkflowPhase(extraChild.name, 'completed', 300_000)
      await waitForRunPhase(extraUser.userToken, RECIPE_NAME, extraRun.id, 'Succeeded')

      const visibleExtraRuns = await apiListWorkflowRuns(
        extraUser.userToken,
        RECIPE_NS,
        RECIPE_NAME,
        20
      )
      const visibleExtraRunIds = visibleExtraRuns.items.map(item => item.id)
      expect(visibleExtraRunIds).toContain(extraRun.id)
      expect(visibleExtraRunIds).not.toContain(firstRun.runId)
      expect(visibleExtraRunIds).not.toContain(secondRun.runId)
    } finally {
      await app.close()
    }
  })
})
