import { type Page, expect } from '@playwright/test'
import { UUID_RE, kubectlOut } from '../../../tests/e2e/gfsUiFixtures'
import { loginControlUi } from './gfs-control-ui-session'
import {
  EXPECTED_HELD_STATE,
  GFS_PLUGIN_NAMESPACE,
  GFS_PLUGIN_RECIPE,
} from './gfs-normal-workflow-constants'
import {
  normalGfsPluginRunDiagnostic,
  normalGfsPluginRunState,
} from './gfs-normal-workflow-state.test'

export { GFS_PLUGIN_NAMESPACE, GFS_PLUGIN_RECIPE }
const CONTROL_API_DIAGNOSTIC_URL =
  process.env.CONTROL_API_BASE_URL ||
  process.env.E2E_CONTROL_API_URL ||
  process.env.CONTROL_API_URL ||
  'http://localhost:8090'
const CHILD_TIMEOUT_MS = 45_000
const MCP_HOST_TIMEOUT_MS = 60_000
const COORDINATOR_TIMEOUT_MS = 90_000
const APPROVAL_TIMEOUT_MS = 30_000
const BROWSER_REQUEST_TIMEOUT_MS = 10_000
type WorkflowRun = {
  id?: string
  phase?: string
  executionRef?: { namespace?: string; name?: string } | null
}

export type NormalGfsPluginRunProgress = {
  runId: string
  childName?: string
}

export type WorkflowRecipeResource = {
  metadata?: {
    name?: string
    namespace?: string
    uid?: string
    deletionTimestamp?: string
    labels?: Record<string, string>
    ownerReferences?: Array<{
      apiVersion?: string
      blockOwnerDeletion?: boolean
      controller?: boolean
      kind?: string
      name?: string
      uid?: string
    }>
  }
  spec?: {
    agent?: unknown
    gfs?: { mounts?: Array<{ drive?: string; scopes?: string[]; target?: string }> }
    pluginWorkloadSdk?: unknown
    steps?: Array<{ id?: string; requiresApproval?: unknown }>
  }
}

type PodList = {
  items?: Array<{
    metadata?: { name?: string; deletionTimestamp?: string }
    status?: { conditions?: Array<{ type?: string; status?: string }> }
  }>
}

function kubectlJson<T>(args: string[], timeout = 20_000): T {
  return JSON.parse(kubectlOut([...args, '-o', 'json'], timeout)) as T
}

function workflowPodState(
  recipeName: string,
  component: 'workflow-coordinator' | 'workflow-mcp-host'
): { names: string[]; ready: boolean } {
  const pods = kubectlJson<PodList>([
    '-n',
    GFS_PLUGIN_NAMESPACE,
    'get',
    'pod',
    '-l',
    `clerum.io/recipe=${recipeName},clerum.io/component=${component}`,
  ])
  const items = pods.items ?? []
  return {
    names: items.map(item => item.metadata?.name ?? '').filter(Boolean),
    ready:
      items.length === 1 &&
      !items[0]?.metadata?.deletionTimestamp &&
      items[0]?.status?.conditions?.some(
        condition => condition.type === 'Ready' && condition.status === 'True'
      ) === true,
  }
}

function mcpHostPodState(recipeName: string): { names: string[]; ready: boolean } {
  return workflowPodState(recipeName, 'workflow-mcp-host')
}

function expectNormalParent(recipeName: string): void {
  const parent = kubectlJson<WorkflowRecipeResource>([
    '-n',
    GFS_PLUGIN_NAMESPACE,
    'get',
    'workflowrecipe',
    recipeName,
  ])
  expect(parent.metadata?.namespace).toBe(GFS_PLUGIN_NAMESPACE)
  expect(parent.metadata?.name).toBe(recipeName)
  expect(parent.metadata?.uid).toBeTruthy()
  expect(parent.spec?.pluginWorkloadSdk).toBeUndefined()
  expect(parent.spec?.agent).toBeTruthy()
  expect(parent.spec?.steps).toHaveLength(4)
  expect(parent.spec?.steps?.[0]?.id).toBe('approval-held-gfs-read')
  expect(parent.spec?.steps?.[0]?.requiresApproval).toBeTruthy()
  expect(parent.spec?.gfs?.mounts).toEqual([
    {
      drive: 'main',
      target: 'e2e/gfs-grant-e2e-plugin',
      scopes: ['gfs.read', 'gfs.write'],
    },
  ])
  expect(mcpHostPodState(recipeName).names).toEqual([])
}
async function adminRequest<T>(page: Page, path: string): Promise<{ body: T; status: number }> {
  const result = await page.evaluate(
    async request => {
      const controller = new AbortController()
      const timer = window.setTimeout(() => controller.abort(), request.timeoutMs)
      try {
        const response = await fetch(request.path, {
          method: 'GET',
          credentials: 'same-origin',
          signal: controller.signal,
        })
        const text = await response.text()
        let responseBody: unknown
        try {
          responseBody = JSON.parse(text)
        } catch {
          responseBody = { raw: text }
        }
        return {
          body: responseBody,
          requestOrigin: window.location.origin,
          responseOrigin: new URL(response.url).origin,
          status: response.status,
          text,
        }
      } finally {
        window.clearTimeout(timer)
      }
    },
    { path, timeoutMs: BROWSER_REQUEST_TIMEOUT_MS }
  )
  expect(result.responseOrigin).toBe(result.requestOrigin)
  if (result.status < 200 || result.status >= 300) {
    throw new Error(
      `GET ${path} returned ${result.status}: ${result.text} ` +
        `(configured control API: ${CONTROL_API_DIAGNOSTIC_URL})`
    )
  }
  return { body: result.body as T, status: result.status }
}
async function triggerRun(page: Page, recipeName: string): Promise<string> {
  await loginControlUi(page)
  const pluginsNavigation = page.getByRole('link', { name: 'Plugins', exact: true })
  await expect(pluginsNavigation).toBeVisible({ timeout: 20_000 })
  await pluginsNavigation.click()
  await expect(page).toHaveURL(/\/plugins(?:$|\?)/, { timeout: 20_000 })

  const search = page.getByRole('searchbox', { name: 'Search plugins', exact: true })
  await expect(search).toBeVisible({ timeout: 20_000 })
  await search.fill(recipeName)
  const recipeLink = page.getByRole('link', { name: `Open ${recipeName}` })
  await expect(recipeLink).toBeVisible({ timeout: 20_000 })
  await recipeLink.click()
  await expect(page).toHaveURL(
    new RegExp(`/plugins/${GFS_PLUGIN_NAMESPACE}/${recipeName}/workloads(?:\\?|$)`),
    { timeout: 20_000 }
  )
  await expect(page.getByRole('heading', { name: recipeName })).toBeVisible({
    timeout: 20_000,
  })
  await expect(page.getByText(/Loading recipe/)).toBeHidden({ timeout: 120_000 })

  const runsTab = page.getByRole('tab', { name: /Runs/ })
  await expect(runsTab).toBeVisible({ timeout: 20_000 })
  const runButton = page.getByRole('button', { name: 'Run…', exact: true })
  await expect(runButton).toBeVisible({ timeout: 20_000 })
  await expect(runButton).toBeEnabled({ timeout: 120_000 })
  await runButton.click()

  const dialog = page.getByRole('dialog', {
    name: new RegExp(`Run\\s+${recipeName}\\s+as operator`),
  })
  await expect(dialog).toBeVisible({ timeout: 20_000 })
  const triggerResponse = page.waitForResponse(
    response =>
      response.request().method() === 'POST' &&
      response
        .url()
        .includes(
          `/control-api/api/v1/admin/workflows/${GFS_PLUGIN_NAMESPACE}/${recipeName}/trigger`
        )
  )
  const submitRun = dialog.getByRole('button', { name: 'Run as operator' })
  await expect(submitRun).toBeEnabled({ timeout: 20_000 })
  await submitRun.click()
  const response = await triggerResponse
  expect(response.status()).toBe(201)
  const body = (await response.json()) as WorkflowRun
  expect(body.id).toMatch(UUID_RE)
  await expect(dialog).toBeHidden({ timeout: 30_000 })
  await runsTab.click()
  await expect(page).toHaveURL(
    new RegExp(`/plugins/${GFS_PLUGIN_NAMESPACE}/${recipeName}/runs(?:\\?|$)`),
    { timeout: 20_000 }
  )
  await expect(page.getByRole('link', { name: `Open run ${body.id!.slice(0, 8)}` })).toBeVisible({
    timeout: 60_000,
  })
  return body.id!
}

async function waitForChild(page: Page, runId: string, recipeName: string): Promise<string> {
  let childName = ''
  await expect
    .poll(
      async () => {
        const response = await adminRequest<WorkflowRun>(
          page,
          `/control-api/api/v1/admin/workflows/${GFS_PLUGIN_NAMESPACE}/${recipeName}/runs/${runId}`
        )
        expect(['Pending', 'Running']).toContain(response.body.phase)
        expect(response.body.executionRef?.namespace ?? GFS_PLUGIN_NAMESPACE).toBe(
          GFS_PLUGIN_NAMESPACE
        )
        childName = response.body.executionRef?.name ?? ''
        return childName || null
      },
      {
        timeout: CHILD_TIMEOUT_MS,
        intervals: [500, 1_000, 2_000],
        message: `workflow run ${runId} should receive its child executionRef`,
      }
    )
    .not.toBeNull()
  return childName
}

function expectChildContract(childName: string, runId: string, recipeName: string): void {
  const parent = kubectlJson<WorkflowRecipeResource>([
    '-n',
    GFS_PLUGIN_NAMESPACE,
    'get',
    'workflowrecipe',
    recipeName,
  ])
  const child = kubectlJson<WorkflowRecipeResource>([
    '-n',
    GFS_PLUGIN_NAMESPACE,
    'get',
    'workflowrecipe',
    childName,
  ])
  expect(parent.metadata?.uid).toBeTruthy()
  expect(child.metadata?.name).toBe(childName)
  expect(child.metadata?.namespace).toBe(GFS_PLUGIN_NAMESPACE)
  expect(child.metadata?.labels?.['clerum.io/parent-recipe']).toBe(recipeName)
  expect(child.metadata?.labels?.['clerum.io/workflow-run-id']).toBe(runId)
  expect(child.metadata?.ownerReferences).toHaveLength(1)
  expect(child.metadata?.ownerReferences).toEqual([
    expect.objectContaining({
      apiVersion: 'clerum.io/v1alpha1',
      blockOwnerDeletion: true,
      controller: true,
      kind: 'WorkflowRecipe',
      name: recipeName,
      uid: parent.metadata!.uid,
    }),
  ])
  expect(child.spec?.gfs?.mounts).toEqual([
    {
      drive: 'main',
      target: 'e2e/gfs-grant-e2e-plugin',
      scopes: ['gfs.read', 'gfs.write'],
    },
  ])
}

async function waitForMcpHostAndApproval(
  childName: string,
  runId: string,
  recipeName: string
): Promise<string> {
  const expectedPod = `${childName}-mcp-host`
  await expect
    .poll(() => mcpHostPodState(childName), {
      timeout: MCP_HOST_TIMEOUT_MS,
      intervals: [1_000, 2_000, 5_000],
      message: `workflow run ${runId} should create one Ready child-labeled mcp-host`,
    })
    .toEqual({ names: [expectedPod], ready: true })
  expect(mcpHostPodState(recipeName).names).toEqual([])

  await expect
    .poll(() => workflowPodState(childName, 'workflow-coordinator'), {
      timeout: COORDINATOR_TIMEOUT_MS,
      intervals: [1_000, 2_000, 5_000],
      message: `workflow run ${runId} should create one Ready child-labeled coordinator`,
    })
    .toEqual({ names: [`${childName}-coordinator`], ready: true })

  try {
    await expect
      .poll(() => normalGfsPluginRunState(runId, childName, recipeName), {
        timeout: APPROVAL_TIMEOUT_MS,
        intervals: [500, 1_000, 2_000],
        message: `workflow run ${runId} should stop before LLM or tool execution`,
      })
      .toBe(EXPECTED_HELD_STATE)
  } catch (error) {
    let coordinatorLogs = '<coordinator pod already unavailable>'
    try {
      coordinatorLogs = kubectlOut(
        ['-n', GFS_PLUGIN_NAMESPACE, 'logs', `${childName}-coordinator`, '--tail=200'],
        20_000
      )
    } catch {
      // The reconciler removes a terminal coordinator quickly; the durable DB
      // diagnostic below remains authoritative when pod logs are already gone.
    }
    throw new Error(
      `${error instanceof Error ? error.message : String(error)}\n` +
        `Persisted run diagnostic:\n${normalGfsPluginRunDiagnostic(runId, childName, recipeName)}\n` +
        `Coordinator logs for ${childName}:\n${coordinatorLogs}`
    )
  }
  return expectedPod
}

export async function startNormalGfsPluginRun(
  page: Page,
  onProgress?: (progress: NormalGfsPluginRunProgress) => void,
  recipeName = GFS_PLUGIN_RECIPE
): Promise<{ childName: string; pod: string; runId: string }> {
  expectNormalParent(recipeName)
  const runId = await triggerRun(page, recipeName)
  onProgress?.({ runId })
  const childName = await waitForChild(page, runId, recipeName)
  onProgress?.({ runId, childName })
  expectChildContract(childName, runId, recipeName)
  const pod = await waitForMcpHostAndApproval(childName, runId, recipeName)
  return { childName, pod, runId }
}
