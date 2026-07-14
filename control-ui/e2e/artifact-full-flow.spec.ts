/**
 * E2E test: Full artifact lifecycle through Control UI.
 *
 * Validates the complete flow:
 *   1. Deploy a 1-step workflow that generates a PDF
 *   2. Wait for workflow completion
 *   3. Download artifact from the run-scoped recipe status view
 *   4. Delete per-file via ✕ button — verify removal + CRD update
 *   5. Navigate to /outputs — verify page loads and shows recipe data
 *   6. Re-deploy → generate → Clear All via bulk delete
 *
 * Uses the local glm-4.7 model mapping available in the minikube E2E profile.
 *
 * Prerequisites:
 *   - target Kubernetes context in KUBECONTEXT/CONTEXT
 *   - port-forward: control-ui via CONTROL_UI_URL, control-api via CONTROL_API_URL
 *   - Admin credentials: admin / changeme123!
 */
import { expect, test } from '@playwright/test'
import { execFileSync } from 'node:child_process'

const RECIPE_NAME = 'e2e-artifact-flow'
function requiredUrlEnv(...names: string[]): string {
  for (const name of names) {
    const value = process.env[name]?.trim()
    if (value) return value.replace(/\/+$/, '')
  }
  throw new Error(`${names.join(' or ')} is required for profile-scoped artifact E2E`)
}

function requiredTextEnv(...names: string[]): string {
  for (const name of names) {
    const value = process.env[name]?.trim()
    if (value) return value
  }
  throw new Error(`${names.join(' or ')} is required for profile-scoped artifact E2E`)
}

const BASE_API = requiredUrlEnv('CONTROL_API_URL', 'CONTROL_API_BASE_URL', 'E2E_CONTROL_API_URL')
const BASE_UI = requiredUrlEnv('CONTROL_UI_URL', 'CONTROL_UI_BASE_URL')
const RECIPE_NAMESPACE = 'sandbox-recipes'
const DEDICATED_OUTPUT_PVC = `${RECIPE_NAME}-workflow-output`
const DEDICATED_OUTPUT_SUBPATH = `workflow-output/${RECIPE_NAME}`
const KUBE_CONTEXT = requiredTextEnv('KUBECONTEXT', 'CONTEXT')
const ALLOWED_KUBE_CONTEXTS = (process.env.E2E_ALLOWED_CONTEXTS ?? KUBE_CONTEXT)
  .split(',')
  .map(context => context.trim())
  .filter(Boolean)

const RECIPE_SPEC = {
  apiVersion: 'clerum.io/v1alpha1',
  kind: 'WorkflowRecipe',
  metadata: { name: RECIPE_NAME },
  spec: {
    contextRef: 'context1',
    security: { allowContextRef: true },
    agent: { provider: 'zai', model: 'glm-4.7' },
    inputContract: {
      properties: {
        topic: { type: 'string', default: 'E2E artifact test' },
      },
    },
    steps: [
      {
        id: 'generate-report',
        instruction:
          'You MUST call the clerum__generate_pdf tool with filename "e2e-test-report.pdf", title "E2E Test Report", and body "This is a test report for artifact lifecycle validation.". Do NOT skip the tool call — it is mandatory.',
        timeoutSeconds: 120,
        maxRetries: 2,
        backoffSeconds: 10,
        allowedTools: { include: ['clerum__generate_pdf'] },
      },
    ],
    output: { destination: 'pvc', name: RECIPE_NAME, format: 'pdf', storageSize: '64Mi' },
    triggers: {
      onDemand: {
        requiresApproval: false,
        allowedActors: ['user', 'autonomous'],
      },
    },
    workloads: [],
  },
}

// ── Helpers ──────────────────────────────────────────────────────────────

type KubePvc = {
  metadata?: { labels?: Record<string, string> }
  spec?: { resources?: { requests?: { storage?: string } } }
}

type KubePod = {
  metadata?: { name?: string }
  spec?: {
    containers?: Array<{
      name?: string
      volumeMounts?: Array<{ name: string; mountPath: string; subPath?: string }>
    }>
    volumes?: Array<{
      name: string
      persistentVolumeClaim?: { claimName?: string }
    }>
  }
}

type WorkflowRunDto = {
  id: string
  phase: string
  executionRef?: { namespace: string; name: string } | null
}
type WorkflowRunListDto = {
  items?: WorkflowRunDto[]
}
type AdminLoginResponse = {
  token?: string
}
type KubePodList = {
  items?: KubePod[]
}

let kubeContextChecked = false

function kubeContextMatches(pattern: string, context: string): boolean {
  if (pattern === context) return true
  if (!pattern.includes('*')) return false
  const escaped = pattern
    .split('*')
    .map(part => part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
    .join('.*')
  return new RegExp(`^${escaped}$`).test(context)
}

function requireSafeKubeContext() {
  if (kubeContextChecked) return
  if (!ALLOWED_KUBE_CONTEXTS.some(pattern => kubeContextMatches(pattern, KUBE_CONTEXT))) {
    throw new Error(
      `Refusing to run Control UI artifact E2E against context "${KUBE_CONTEXT}". ` +
        `Allowed contexts: ${ALLOWED_KUBE_CONTEXTS.join(', ')}.`
    )
  }
  kubeContextChecked = true
}

function kubectl(args: string[]): string {
  requireSafeKubeContext()
  return execFileSync('kubectl', ['--context', KUBE_CONTEXT, ...args], {
    encoding: 'utf8',
    timeout: 30_000,
  }).trim()
}

function kubectlJson<T>(args: string[]): T {
  return JSON.parse(kubectl([...args, '-o', 'json'])) as T
}

function workflowPodNames(): string[] {
  try {
    const pods = kubectlJson<KubePodList>(['get', 'pods', '-n', RECIPE_NAMESPACE])
    return (pods.items ?? [])
      .map(pod => pod.metadata?.name ?? '')
      .filter(name => name.startsWith(`${RECIPE_NAME}-`))
  } catch {
    return []
  }
}

async function waitForWorkflowPodsGone(timeout = 60_000) {
  await expect
    .poll(() => workflowPodNames().length, {
      timeout,
      intervals: [1_000, 2_000, 5_000],
      message: `${RECIPE_NAME} runtime pods should be cleaned up`,
    })
    .toBe(0)
}

async function waitForKubectlJson<T>(
  args: string[],
  label: string,
  timeoutMs = 120_000
): Promise<T> {
  const start = Date.now()
  let lastError = ''
  while (Date.now() - start < timeoutMs) {
    try {
      return kubectlJson<T>(args)
    } catch (err) {
      lastError = err instanceof Error ? err.message : String(err)
    }
    await new Promise(resolve => setTimeout(resolve, 2_000))
  }
  throw new Error(`Timed out waiting for ${label}: ${lastError}`)
}

function expectPodUsesDedicatedOutputPvc(pod: KubePod, podName: string, expectedSubPath: string) {
  const containers = pod.spec?.containers ?? []
  const outputMount = containers
    .flatMap(container =>
      (container.volumeMounts ?? []).map(mount => ({
        ...mount,
        containerName: container.name ?? '<unknown>',
      }))
    )
    .find(mount => mount.mountPath === '/output')

  expect(outputMount, `${podName} should mount /output`).toBeTruthy()
  expect(outputMount?.subPath).toBe(expectedSubPath)

  const outputVolume = (pod.spec?.volumes ?? []).find(volume => volume.name === outputMount?.name)
  expect(outputVolume?.persistentVolumeClaim?.claimName).toBe(DEDICATED_OUTPUT_PVC)
}

async function expectDedicatedOutputPvc() {
  const pvc = await waitForKubectlJson<KubePvc>(
    ['get', 'pvc', DEDICATED_OUTPUT_PVC, '-n', RECIPE_NAMESPACE],
    `dedicated output PVC ${DEDICATED_OUTPUT_PVC}`
  )

  expect(pvc.metadata?.labels?.['clerum.io/recipe']).toBe(RECIPE_NAME)
  expect(pvc.metadata?.labels?.['clerum.io/component']).toBe('workflow-output')
  expect(pvc.spec?.resources?.requests?.storage).toBe('64Mi')
}

async function expectDedicatedOutputRuntime(childName: string, runId: string) {
  const expectedSubPath = `${DEDICATED_OUTPUT_SUBPATH}/${runId}`
  const mcpHostPod = await waitForKubectlJson<KubePod>(
    ['get', 'pod', `${childName}-mcp-host`, '-n', RECIPE_NAMESPACE],
    'child mcp-host pod'
  )
  const artifactReaderPod = await waitForKubectlJson<KubePod>(
    ['get', 'pod', `${childName}-artifact-reader`, '-n', RECIPE_NAMESPACE],
    'child artifact-reader pod'
  )

  expectPodUsesDedicatedOutputPvc(mcpHostPod, `${childName}-mcp-host`, expectedSubPath)
  expectPodUsesDedicatedOutputPvc(
    artifactReaderPod,
    `${childName}-artifact-reader`,
    expectedSubPath
  )
}

async function apiDelete(token: string, path: string): Promise<number> {
  const resp = await fetch(`${BASE_API}${path}`, {
    method: 'DELETE',
    headers: { Authorization: `Bearer ${token}` },
  })
  return resp.status
}

async function apiGetJson<T>(token: string, path: string): Promise<T> {
  const resp = await fetch(`${BASE_API}${path}`, {
    headers: { Authorization: `Bearer ${token}` },
  })
  if (!resp.ok) {
    const body = await resp.text().catch(() => '')
    throw new Error(`GET ${path} failed (HTTP ${resp.status}): ${body}`)
  }
  return (await resp.json()) as T
}

async function waitForArtifactStatus(
  token: string,
  runId: string,
  artifactName: string,
  expectedStatus: number
) {
  await expect
    .poll(
      async () => {
        const resp = await fetch(`${BASE_API}${runArtifactDownloadPath(runId, artifactName)}`, {
          headers: { Authorization: `Bearer ${token}` },
        })
        return resp.status
      },
      {
        timeout: 30_000,
        intervals: [500, 1_000, 2_000],
        message: `${artifactName} should return HTTP ${expectedStatus}`,
      }
    )
    .toBe(expectedStatus)
}

async function login(page: import('@playwright/test').Page): Promise<string> {
  await page.goto(BASE_UI)
  await expect(page.getByRole('button', { name: 'Sign in' })).toBeVisible({ timeout: 10_000 })
  const inputs = page.locator('input')
  await inputs.nth(0).fill('admin')
  await inputs.nth(1).fill('changeme123!')
  const loginResponsePromise = page.waitForResponse(
    resp => resp.url().includes('/api/v1/admin/auth/login') && resp.request().method() === 'POST',
    { timeout: 15_000 }
  )
  await page.getByRole('button', { name: 'Sign in' }).click()
  const loginResponse = await loginResponsePromise
  expect(loginResponse.status()).toBeLessThan(300)
  const loginBody = (await loginResponse.json()) as AdminLoginResponse
  expect(loginBody.token, 'admin login should return a token').toBeTruthy()
  await expect(page.getByRole('button', { name: 'Workflow Recipes' })).toBeVisible({
    timeout: 15_000,
  })
  return loginBody.token!
}

async function gotoWorkflowRecipes(page: import('@playwright/test').Page) {
  await page.goto(`${BASE_UI}/workflow-recipes`)
  await expect(page.getByRole('button', { name: 'Install Recipe' })).toBeVisible({
    timeout: 15_000,
  })
}

async function cleanupRecipe(token: string) {
  // Best-effort cleanup — ignore errors
  try {
    await apiDelete(token, `/api/v1/admin/recipes/${RECIPE_NAME}`)
  } catch {
    /* ok */
  }
  await waitForWorkflowPodsGone()
  try {
    kubectl([
      'delete',
      'pvc',
      DEDICATED_OUTPUT_PVC,
      '-n',
      RECIPE_NAMESPACE,
      '--ignore-not-found',
      '--timeout=30s',
    ])
  } catch {
    /* ok */
  }
}

async function deployRecipeViaUI(page: import('@playwright/test').Page) {
  await gotoWorkflowRecipes(page)
  const installButton = page.getByRole('button', { name: 'Install Recipe' })
  await expect(installButton).toBeVisible({ timeout: 15_000 })
  await installButton.click()
  await page.waitForSelector('textarea', { timeout: 5_000 })
  await page
    .locator('textarea')
    .first()
    .fill(JSON.stringify(RECIPE_SPEC, null, 2))

  // Review first
  await page.getByRole('button', { name: 'Review manifest' }).click()
  await expect(page.locator('text=Manifest review passed')).toBeVisible({ timeout: 10_000 })
  await page.getByRole('button', { name: 'Apply defaults' }).click()
  await page.getByRole('button', { name: 'Continue to access' }).click()

  // Deploy
  const deployBtn = page.getByRole('button', { name: 'Deploy plugin' })
  await expect(deployBtn).toBeVisible({ timeout: 10_000 })
  await expect(deployBtn).toBeEnabled({ timeout: 10_000 })
  await deployBtn.click()
  await expect(page.getByRole('link', { name: `Open ${RECIPE_NAME}` })).toBeVisible({
    timeout: 45_000,
  })
}

async function listRunIds(token: string): Promise<string[]> {
  const data = await apiGetJson<WorkflowRunListDto>(
    token,
    `/api/v1/admin/workflows/${RECIPE_NAMESPACE}/${RECIPE_NAME}/runs?limit=20`
  )
  return (data.items ?? []).map(item => item.id)
}

async function triggerWorkflowRunViaUI(
  page: import('@playwright/test').Page,
  token: string
): Promise<string> {
  const previousRunIds = await listRunIds(token)

  await page.getByRole('link', { name: `Open ${RECIPE_NAME}` }).click()
  await expect(page.getByRole('heading', { name: RECIPE_NAME })).toBeVisible({ timeout: 30_000 })

  const runButton = page.getByRole('button', { name: 'Run…' })
  await expect(runButton).toBeEnabled({ timeout: 60_000 })
  await runButton.click()

  const runDialog = page.getByRole('dialog', { name: new RegExp(`Run\\s+${RECIPE_NAME}`) })
  await expect(runDialog).toBeVisible({ timeout: 10_000 })
  await runDialog.getByRole('button', { name: 'Run' }).click()
  await expect(page.getByText(/Runs \([1-9]\d*\)/)).toBeVisible({ timeout: 30_000 })

  let runId = ''
  await expect
    .poll(
      async () => {
        const runIds = await listRunIds(token)
        runId = runIds.find(id => !previousRunIds.includes(id)) ?? ''
        return runId || null
      },
      {
        timeout: 60_000,
        intervals: [500, 1_000, 2_000],
        message: 'Control UI Run action should create a new workflow run',
      }
    )
    .not.toBeNull()
  return runId
}

async function openRunStatusView(page: import('@playwright/test').Page, runId: string) {
  await page.goto(
    `${BASE_UI}/workflow-recipes/${encodeURIComponent(RECIPE_NAMESPACE)}/${encodeURIComponent(RECIPE_NAME)}/runs/${encodeURIComponent(runId)}`
  )
  await expect(page.getByRole('heading', { name: `Run ${runId.slice(0, 8)}` })).toBeVisible({
    timeout: 20_000,
  })
}

async function waitForRunExecutionRef(
  token: string,
  runId: string
): Promise<{ namespace: string; name: string }> {
  await expect
    .poll(
      async () => {
        const data = await apiGetJson<WorkflowRunListDto>(
          token,
          `/api/v1/admin/workflows/${RECIPE_NAMESPACE}/${RECIPE_NAME}/runs?limit=10`
        )
        const run = data.items?.find(item => item.id === runId)
        return run?.executionRef?.name ?? null
      },
      {
        timeout: 90_000,
        intervals: [500, 1_000, 2_000],
        message: `workflow run ${runId} should get a child executionRef`,
      }
    )
    .not.toBeNull()

  const data = await apiGetJson<WorkflowRunListDto>(
    token,
    `/api/v1/admin/workflows/${RECIPE_NAMESPACE}/${RECIPE_NAME}/runs?limit=10`
  )
  const run = data.items?.find(item => item.id === runId)
  expect(run?.executionRef, `workflow run ${runId} should have executionRef`).toBeTruthy()
  return run!.executionRef!
}

async function waitForWorkflowCompletion(token: string, runId: string): Promise<void> {
  // Poll the canonical run list so artifact checks are tied to the run that
  // actually produced them, not to a recipe-scoped legacy status snapshot.
  const maxWait = 360_000 // 6 min — GKE image pull + LLM latency
  const start = Date.now()

  while (Date.now() - start < maxWait) {
    try {
      const data = await apiGetJson<WorkflowRunListDto>(
        token,
        `/api/v1/admin/workflows/${RECIPE_NAMESPACE}/${RECIPE_NAME}/runs?limit=5`
      )
      const run = data.items?.find(item => item.id === runId)
      if (run?.phase === 'Succeeded') {
        return
      }
      if (run && ['Failed', 'Canceled', 'Cancelled', 'TimedOut'].includes(run.phase)) {
        throw new Error(`Workflow failed with phase ${run.phase}`)
      }
    } catch (e) {
      if (e instanceof Error && e.message.startsWith('Workflow failed')) throw e
    }
    await new Promise(resolve => setTimeout(resolve, 5_000))
  }
  throw new Error(`Workflow run ${runId} did not complete within timeout`)
}

function runArtifactDownloadPath(runId: string, artifactName: string): string {
  return `/api/v1/admin/workflows/${RECIPE_NAMESPACE}/${RECIPE_NAME}/runs/${encodeURIComponent(runId)}/artifacts/${encodeURIComponent(artifactName)}/download`
}

// ── Tests ───────────────────────────────────────────────────────────────

test.describe('Artifact Full Flow E2E', () => {
  test.describe.configure({ mode: 'serial' })
  let artifactRunId = ''

  test('1. cleanup + deploy workflow + wait for PDF generation', async ({ page }) => {
    const token = await login(page)
    await cleanupRecipe(token)

    await deployRecipeViaUI(page)
    await expectDedicatedOutputPvc()
    artifactRunId = await triggerWorkflowRunViaUI(page, token)
    const child = await waitForRunExecutionRef(token, artifactRunId)
    await expectDedicatedOutputRuntime(child.name, artifactRunId)
    await waitForWorkflowCompletion(token, artifactRunId)
    await openRunStatusView(page, artifactRunId)

    // Verify artifact exists via API
    const resp = await fetch(
      `${BASE_API}${runArtifactDownloadPath(artifactRunId, 'e2e-test-report.pdf')}`,
      { headers: { Authorization: `Bearer ${token}` } }
    )
    expect(resp.status).toBe(200)
    expect(resp.headers.get('content-type')).toContain('pdf')
    console.log('  [PASS] Workflow completed, PDF artifact generated')
  })

  test('2. download artifact from run status view', async ({ page }) => {
    await login(page)
    await openRunStatusView(page, artifactRunId)

    // Wait for artifacts panel
    await expect(page.locator('text=Output Artifacts')).toBeVisible({ timeout: 30_000 })

    // Click Download
    const downloadPromise = page.waitForEvent('download', { timeout: 30_000 })
    await page.getByRole('button', { name: 'Download' }).first().click()
    const download = await downloadPromise

    expect(download.suggestedFilename()).toContain('e2e-test-report')
    console.log(`  [PASS] Download works: ${download.suggestedFilename()}`)
  })

  test('3. delete single artifact via X button', async ({ page }) => {
    const token = await login(page)
    await openRunStatusView(page, artifactRunId)

    await expect(page.locator('text=Output Artifacts')).toBeVisible({ timeout: 30_000 })

    // Intercept delete request to verify it fires
    const deleteRequestPromise = page.waitForResponse(
      resp => resp.url().includes('/artifacts/') && resp.request().method() === 'DELETE',
      { timeout: 15_000 }
    )

    // Click delete ✕ — use title attribute to distinguish from other close buttons.
    const deleteBtn = page.locator('button[title^="Delete "]').first()
    await expect(deleteBtn).toBeVisible()
    await deleteBtn.click()

    // Wait for the DELETE response from the browser
    const deleteResponse = await deleteRequestPromise
    expect(deleteResponse.status()).toBeLessThan(300)

    await waitForArtifactStatus(token, artifactRunId, 'e2e-test-report.pdf', 404)

    console.log('  [PASS] Per-file delete works, API confirms 404')
  })

  test('4. /outputs page loads and shows recipe', async ({ page }) => {
    await login(page)

    // Navigate to /outputs
    await page.goto(`${BASE_UI}/outputs`)

    // The page should show the recipe name (even if artifacts are deleted,
    // the regex fallback on step output may still detect filenames)
    await expect(page.locator('text=Recipe Artifacts')).toBeVisible({ timeout: 10_000 })

    console.log('  [PASS] /outputs page loads correctly')
  })

  test('5. re-deploy + bulk delete via Clear All', async ({ page }) => {
    const token = await login(page)

    // Delete old recipe via API
    await cleanupRecipe(token)

    // Navigate fresh to clear any overlay
    await gotoWorkflowRecipes(page)

    await deployRecipeViaUI(page)
    artifactRunId = await triggerWorkflowRunViaUI(page, token)
    const child = await waitForRunExecutionRef(token, artifactRunId)
    await expectDedicatedOutputRuntime(child.name, artifactRunId)

    // Wait for workflow to complete via API polling.
    await waitForWorkflowCompletion(token, artifactRunId)

    // Verify artifact exists first
    const checkResp = await fetch(
      `${BASE_API}${runArtifactDownloadPath(artifactRunId, 'e2e-test-report.pdf')}`,
      { headers: { Authorization: `Bearer ${token}` } }
    )
    expect(checkResp.status).toBe(200)

    // Open the run-scoped status view fresh.
    await openRunStatusView(page, artifactRunId)

    await expect(page.locator('text=Output Artifacts')).toBeVisible({ timeout: 30_000 })

    const clearBtn = page.getByRole('button', { name: 'Clear All' })
    await expect(clearBtn).toBeVisible()
    await clearBtn.click()

    // Confirm dialog
    const confirmBtn = page.getByRole('button', { name: 'Confirm' })
    await expect(confirmBtn).toBeVisible({ timeout: 5_000 })
    await confirmBtn.click()

    await waitForArtifactStatus(token, artifactRunId, 'e2e-test-report.pdf', 404)

    console.log('  [PASS] Bulk delete via Clear All works')
  })

  test.afterAll(async () => {
    try {
      const resp = await fetch(`${BASE_API}/api/v1/admin/auth/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username: 'admin', password: 'changeme123!' }),
      })
      const data = (await resp.json()) as { token: string }
      await apiDelete(data.token, `/api/v1/admin/recipes/${RECIPE_NAME}`)
      await waitForWorkflowPodsGone()
      kubectl([
        'delete',
        'pvc',
        DEDICATED_OUTPUT_PVC,
        '-n',
        RECIPE_NAMESPACE,
        '--ignore-not-found',
        '--timeout=30s',
      ])
    } catch {
      /* best-effort */
    }
  })
})
