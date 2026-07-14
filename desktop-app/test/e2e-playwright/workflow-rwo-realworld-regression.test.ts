/**
 * Desktop App + Control UI -- WorkflowRecipe RWO affinity regression probe
 *
 * Proves the reduced chains-discovery-mini geometry that produced Multi-Attach risk:
 *   Control UI installs and grants a long-name workflow recipe derived from chains-discovery-mini
 *     -> Desktop App triggers a real user run
 *     -> the child run creates snippet-runner, coordinator, and artifact-reader pods
 *     -> all pods mounting the same WRC-managed RWO output PVC co-locate with the anchor
 *     -> Desktop App downloads a run-scoped JSON artifact written to the PVC
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
  RECIPE_NS,
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
const RECIPE_SUFFIX = Date.now().toString(36)
const MINI_RECIPE_NAME = `e2e-chains-discovery-mini-realworld-rwo-probe-${RECIPE_SUFFIX}`
const MINI_CSV_JSON_ARTIFACT_NAME = 'mini-leads.csv.json'
const MINI_MARKDOWN_ARTIFACT_NAME = 'mini-report.md'
const WORKFLOW_OUTPUT_CLAIM_LABEL = 'clerum.io/workflow-output-claim'
const WORKFLOW_OUTPUT_SCOPE_LABEL = 'clerum.io/workflow-output-scope'
const WORKFLOW_OUTPUT_ANCHOR_COMPONENT = 'workflow-output-anchor'
const WORKFLOW_OUTPUT_PREPARE_COMPONENT = 'workflow-output-prepare'
const WORKFLOW_OUTPUT_ROOT_MOUNT_PATH = '/workflow-output-root'
const KUBECTL_MAX_BUFFER = 16 * 1024 * 1024

type K8sEnvVar = { name?: string; value?: string }
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
  status?: { workflowExecution?: { phase?: string; message?: string } }
}
type WorkflowRunSummary = {
  id: string
  phase: string
  actor: { type?: string; userId?: string } | null
  executionRef: { namespace: string; name: string } | null
}
type WorkflowRunArtifactDto = { name: string; format?: string; path?: unknown }
type MiniLeadsPayload = {
  csv?: string
  run_id?: string
  chain_slug?: string
  rows?: number
}

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

function urlPort(url: string): string {
  try {
    return new URL(url).port
  } catch {
    return ''
  }
}

function assertBranchScopedGateUsesRandomPorts(): void {
  if (!/^clerum-(codex|detached)-/.test(K8S_CONTEXT)) return
  const urls = [
    ['CONTROL_UI_BASE_URL', CONTROL_UI, '3000'],
    ['CONTROL_API_BASE_URL', CONTROL_API, '8090'],
    ['EXTERNAL_REST_API_BASE_URL', EXT_API, '8091'],
  ] as const
  for (const [name, url, defaultPort] of urls) {
    expect(
      urlPort(url),
      `${name} must use a random localhost port for branch-scoped context ${K8S_CONTEXT}`
    ).not.toBe(defaultPort)
  }
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

function buildMiniRwoRecipeManifest(name: string): Record<string, unknown> {
  return {
    apiVersion: 'clerum.io/v1alpha1',
    kind: 'WorkflowRecipe',
    metadata: {
      name,
      labels: { 'clerum.io/use-case': 'chains-prospecting-demo' },
    },
    spec: {
      description:
        'Reduced chains-discovery-mini RWO regression fixture with local deterministic MCP.',
      inputContract: {
        type: 'object',
        required: [],
        properties: {
          lookbackDays: {
            type: 'integer',
            default: 14,
            description: 'How recent a chain must be to count as new',
          },
          holdMs: { type: 'integer', default: 25000 },
        },
      },
      mcpServers: [{ id: 'mini-tools' }],
      workloads: [
        {
          id: 'mini-tools',
          type: 'deployment',
          image: 'clerum/mock-mcp-server:test',
          imagePullPolicy: 'IfNotPresent',
          port: 3000,
          transport: {
            type: 'streamableHttp',
            path: '/mcp',
          },
          healthCheck: {
            type: 'tcp',
            port: 3001,
          },
          resources: {
            requests: { cpu: '50m', memory: '64Mi' },
            limits: { cpu: '200m', memory: '128Mi' },
          },
        },
      ],
      output: {
        destination: 'pvc',
        format: 'multi',
        storageSize: '100Mi',
      },
      triggers: {
        onDemand: {
          requiresApproval: false,
          allowedActors: ['user', 'scheduled'],
        },
      },
      steps: [
        {
          id: 'init-schema',
          run: {
            type: 'snippet',
            language: 'typescript',
            capabilities: {
              mcp: {
                servers: ['mini-tools'],
                allowedTools: { include: ['mini-tools__add'] },
              },
            },
            code: `
const runId = \`mini-\${Math.floor(Date.now() / 1000)}\`
const lookback = sdk.inputs.lookbackDays ?? 14
const threshold = new Date(Date.now() - lookback * 86400000).toISOString().slice(0, 10)
const probe = await sdk.mcp.callTool('mini-tools', 'add', { a: 10, b: 4 })
if ((probe as any).isError) throw new Error('init-schema MCP probe failed')
return { run_id: runId, lookback_days: lookback, threshold_date: threshold, init_probe: probe }
`,
          },
          timeoutSeconds: 60,
          maxRetries: 2,
          backoffSeconds: 10,
        },
        {
          id: 'source-news',
          dependsOn: ['init-schema'],
          run: {
            type: 'snippet',
            language: 'typescript',
            capabilities: {
              mcp: {
                servers: ['mini-tools'],
                allowedTools: { include: ['mini-tools__add'] },
              },
            },
            code: `
const init = sdk.previousOutputs['init-schema']
const probe = await sdk.mcp.callTool('mini-tools', 'add', { a: 40, b: 2 })
if ((probe as any).isError) throw new Error('source-news MCP probe failed')
return {
  run_id: init.run_id,
  research_probe: probe,
  candidates: [{
    raw_name: 'E2E Chain',
    canonical_slug: 'e2e-chain',
    url: 'https://example.test/e2e-chain',
    evidence_date: init.threshold_date
  }]
}
`,
          },
          timeoutSeconds: 60,
          maxRetries: 2,
          backoffSeconds: 10,
        },
        {
          id: 'pick-top-chain',
          dependsOn: ['source-news'],
          run: {
            type: 'snippet',
            language: 'typescript',
            capabilities: {
              mcp: {
                servers: ['mini-tools'],
                allowedTools: { include: ['mini-tools__add'] },
              },
            },
            code: `
const news = sdk.previousOutputs['source-news']
const top = news.candidates[0]
const probe = await sdk.mcp.callTool('mini-tools', 'add', { a: 20, b: 22 })
if ((probe as any).isError) throw new Error('pick-top-chain MCP probe failed')
return {
  run_id: news.run_id,
  picked: { chain_slug: top.canonical_slug, name: top.raw_name, url: top.url },
  total_candidates: news.candidates.length,
  persist_probe: probe,
}
`,
          },
          timeoutSeconds: 60,
          maxRetries: 2,
          backoffSeconds: 10,
        },
        {
          id: 'find-personnel',
          dependsOn: ['pick-top-chain'],
          run: {
            type: 'snippet',
            language: 'typescript',
            capabilities: {
              mcp: {
                servers: ['mini-tools'],
                allowedTools: { include: ['mini-tools__add'] },
              },
            },
            code: `
const pick = sdk.previousOutputs['pick-top-chain']
const probe = await sdk.mcp.callTool('mini-tools', 'add', { a: 21, b: 21 })
if ((probe as any).isError) throw new Error('find-personnel MCP probe failed')
return {
  run_id: pick.run_id,
  chain_slug: pick.picked.chain_slug,
  name: pick.picked.name,
  url: pick.picked.url,
  domain: 'example.test',
  contact_probe: probe,
  persons_count: 2,
  persons: [
    {
      full_name: 'Ada E2E',
      role: 'Protocol Lead',
      linkedin: 'https://linkedin.example/ada-e2e',
      twitter: '@ada_e2e',
      github: 'ada-e2e',
      attribution_url: 'https://example.test/e2e-chain/team'
    },
    {
      full_name: 'Grace E2E',
      role: 'BD Lead',
      linkedin: null,
      twitter: '@grace_e2e',
      github: 'grace-e2e',
      attribution_url: 'https://example.test/e2e-chain/about'
    }
  ]
}
`,
          },
          timeoutSeconds: 60,
          maxRetries: 2,
          backoffSeconds: 10,
        },
        {
          id: 'persist-and-emit',
          dependsOn: ['find-personnel'],
          run: {
            type: 'snippet',
            language: 'typescript',
            capabilities: {
              mcp: {
                servers: ['mini-tools'],
                allowedTools: { include: ['mini-tools__add'] },
              },
              artifacts: { maxCount: 5 },
            },
            code: `
const ppl = sdk.previousOutputs['find-personnel']
const holdMs = sdk.inputs.holdMs ?? 25000
await sdk.sleep(holdMs)
const probe = await sdk.mcp.callTool('mini-tools', 'add', { a: 30, b: 12 })
if ((probe as any).isError) throw new Error('persist-and-emit MCP probe failed')
const header = 'chain_slug,name,role,linkedin,twitter,github,attribution_url'
const csvRows = ppl.persons.map((p: any) =>
  [ppl.chain_slug, p.full_name, p.role, p.linkedin ?? '', p.twitter ?? '', p.github ?? '', p.attribution_url]
    .map((v: any) => \`"\${String(v).replace(/"/g, '""')}"\`).join(',')
)
const csv = [header, ...csvRows].join('\\n')
await sdk.artifacts.writeJson('${MINI_CSV_JSON_ARTIFACT_NAME}', {
  run_id: ppl.run_id,
  chain_slug: ppl.chain_slug,
  rows: csvRows.length,
  csv,
  persist_probe: probe
})
const md = [
  '# Chains Discovery Mini',
  '',
  \`Run: \${ppl.run_id}\`,
  '',
  \`## Chain: \${ppl.name} (\${ppl.chain_slug})\`,
  \`- URL: \${ppl.url}\`,
  \`- Domain: \${ppl.domain}\`,
  '',
  \`## Personnel (\${ppl.persons.length})\`,
  '',
  ...ppl.persons.map((p: any) => \`- **\${p.full_name}**: \${p.role}\`)
].join('\\n')
await sdk.artifacts.writeMarkdown('${MINI_MARKDOWN_ARTIFACT_NAME}', md)
return {
  run_id: ppl.run_id,
  chain_slug: ppl.chain_slug,
  persons_persisted: ppl.persons.length,
  csv_rows: csvRows.length,
}
`,
          },
          timeoutSeconds: 120,
          maxRetries: 2,
          backoffSeconds: 10,
        },
      ],
    },
  }
}

async function controlUiLogin(page: Page): Promise<string> {
  await page.goto(CONTROL_UI)
  const usernameInput = page.getByLabel('Username')
  const passwordInput = page.getByLabel('Password')
  await expect(usernameInput).toBeVisible({ timeout: 20_000 })
  await expect(passwordInput).toBeVisible({ timeout: 20_000 })
  await usernameInput.fill(ADMIN_USERNAME)
  await passwordInput.fill(requireAdminPassword())
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
  manifest: Record<string, unknown>
): Promise<string> {
  const adminToken = await controlUiLogin(page)
  await page.goto(`${CONTROL_UI}/workflow-recipes`)
  await page.getByRole('button', { name: 'Install Recipe' }).click()

  const editor = page.locator('textarea').first()
  await expect(editor).toBeVisible({ timeout: 15_000 })
  await editor.fill(JSON.stringify(manifest, null, 2))
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
        timeout: 360_000,
        intervals: [2_000, 5_000],
        message: `workflow run ${runId} should reach phase ${expected}`,
      }
    )
    .toBe(expected)
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
        timeout: 150_000,
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
        timeout: 150_000,
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
    [WORKFLOW_OUTPUT_SCOPE_LABEL]: truncateRfc1123WithHash(recipeName),
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
    [WORKFLOW_OUTPUT_SCOPE_LABEL]: truncateRfc1123WithHash(options.recipeName),
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
}

function assertOutputRuntimePod(
  pod: K8sPod,
  options: { component: string; recipeName: string; claimName: string; subPath: string }
): void {
  expect(pod.metadata?.labels).toMatchObject({
    'clerum.io/component': options.component,
    [WORKFLOW_OUTPUT_CLAIM_LABEL]: options.claimName,
    [WORKFLOW_OUTPUT_SCOPE_LABEL]: truncateRfc1123WithHash(options.recipeName),
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
      involvedObject?: { name?: string }
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

async function assertRealworldOutputPodsCoLocated(
  recipeName: string,
  runs: Array<{ runId: string; childName: string }>,
  expectedStorage: string,
  expectedRuntimeComponents = [
    { suffix: 'coordinator', component: 'workflow-coordinator' },
    { suffix: 'artifact-reader', component: 'workflow-artifact-reader' },
    { suffix: 'mcp-host', component: 'workflow-mcp-host' },
    { suffix: 'snippet-runner', component: 'workflow-snippet-runner' },
  ]
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

    const pods = expectedRuntimeComponents.map(item => ({
      name: `${run.childName}-${item.suffix}`,
      component: item.component,
    }))
    for (const expectedPod of pods) {
      const pod = await waitForPodRunning(expectedPod.name)
      expect(pod.spec?.nodeName, `${expectedPod.name} node`).toBe(anchorNode)
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

async function apiDownloadJsonArtifact<T = unknown>(
  userToken: string,
  name: string,
  runId: string,
  artifactName: string
): Promise<T> {
  const response = await fetch(
    `${EXT_API}/api/v1/workflows/${encodeURIComponent(RECIPE_NS)}/${encodeURIComponent(name)}/runs/${encodeURIComponent(runId)}/artifacts/${encodeURIComponent(artifactName)}/download`,
    { headers: { Authorization: `Bearer ${userToken}` } }
  )
  if (!response.ok) {
    throw new Error(
      `download run artifact failed: HTTP ${response.status} ${await response.text()}`
    )
  }
  return (await response.json()) as T
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

async function refreshDesktopRunsAndFindArtifactButton(
  desktopPage: Page,
  runId: string,
  artifactName: string
): Promise<Locator> {
  await desktopPage.getByRole('button', { name: /^refresh$/i }).click()
  const runRow = desktopPage.locator('.workflow-run-row').filter({ hasText: runId.slice(0, 8) })
  await expect(runRow).toBeVisible({ timeout: 30_000 })
  const artifactButton = runRow.getByRole('button', { name: artifactName })
  await expect(artifactButton).toBeVisible({ timeout: 30_000 })
  return artifactButton
}

function assertMiniArtifactSet(artifacts: WorkflowRunArtifactDto[]): void {
  const expected = [
    { name: MINI_CSV_JSON_ARTIFACT_NAME, format: 'json' },
    { name: MINI_MARKDOWN_ARTIFACT_NAME, format: 'md' },
  ]
  expect(artifacts.map(item => item.name).sort()).toEqual(expected.map(item => item.name).sort())
  for (const artifact of artifacts) {
    const expectedArtifact = expected.find(item => item.name === artifact.name)
    expect(artifact.format).toBe(expectedArtifact?.format)
    expect(artifact).not.toHaveProperty('path')
  }
}

function assertMiniLeadsPayload(artifact: MiniLeadsPayload): void {
  expect(artifact).toMatchObject({
    chain_slug: 'e2e-chain',
    rows: 2,
  })
  expect(artifact.run_id).toMatch(/^mini-/)
  expect(artifact.csv).toContain('chain_slug,name,role,linkedin,twitter,github,attribution_url')
  expect(artifact.csv).toContain('"e2e-chain","Ada E2E","Protocol Lead"')
  expect(artifact.csv).toContain('"e2e-chain","Grace E2E","BD Lead"')
}

async function triggerDesktopRun(
  desktopPage: Page,
  detailCard: Locator,
  userToken: string,
  userId: string,
  recipeName: string,
  previousRunIds: string[],
  inputs: Record<string, string>
): Promise<{ runId: string; childName: string }> {
  for (const [label, value] of Object.entries(inputs)) {
    await desktopPage.getByLabel(label, { exact: true }).fill(value)
  }
  const triggerButton = detailCard.getByRole('button', { name: /^trigger$/i })
  await expect(triggerButton).toBeEnabled({ timeout: 20_000 })
  await triggerButton.click()
  await expect(
    desktopPage
      .getByRole('status')
      .filter({ hasText: /failed|error|unable|not authorized|forbidden|denied/i })
      .first()
  ).toBeHidden({ timeout: 5_000 })

  let run: WorkflowRunSummary | undefined
  await expect
    .poll(
      async () => {
        const runs = await apiListWorkflowRuns(userToken, RECIPE_NS, recipeName, 20)
        run = runs.items.find(
          item => item.actor?.userId === userId && !previousRunIds.includes(item.id)
        ) as WorkflowRunSummary | undefined
        return run?.id ?? null
      },
      {
        timeout: 60_000,
        intervals: [500, 1_000, 2_000],
        message: 'Desktop App trigger should create a new chains RWO workflow run',
      }
    )
    .not.toBeNull()

  const runId = run!.id
  const child = await waitForRunExecutionRef(userToken, recipeName, runId)
  expect(child.namespace).toBe(RECIPE_NS)
  return { runId, childName: child.name }
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
    // Cleanup is best effort; SQL and PVC cleanup below are idempotent.
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
      .filter(item => item === workflowOutputClaimName(name) || item.startsWith(`${name}-`))
    if (pvcNames.length > 0) {
      kubectl(['-n', RECIPE_NS, 'delete', 'pvc', ...pvcNames, '--ignore-not-found=true'])
    }
  } catch {
    // Ignore cleanup errors so afterAll does not hide the test result.
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

test.describe('Workflow output RWO real-world regression', () => {
  test.slow()
  test.describe.configure({ timeout: 1_200_000 })

  test.beforeAll(async () => {
    assertBranchScopedGateUsesRandomPorts()
    await clearSession()
  })

  test.afterAll(async () => {
    cleanupRecipe(MINI_RECIPE_NAME)
  })

  test('runs the reduced chains-discovery-mini fixture with snippet MCP calls and PVC artifacts', async ({
    page,
  }) => {
    await Promise.all([
      apiRequest('GET', `${CONTROL_API}/health`).then(res => expect(res.status).toBe(200)),
      apiRequest('GET', `${EXT_API}/health`).then(res => expect(res.status).toBe(200)),
    ])
    assertMultiNodeRwoGate()

    const adminToken = await installRecipeFromControlUi(
      page,
      MINI_RECIPE_NAME,
      E2E_EMAIL,
      buildMiniRwoRecipeManifest(MINI_RECIPE_NAME)
    )
    await waitForAdminRecipeActive(adminToken, MINI_RECIPE_NAME)

    const { userId, userToken } = await loginAs(E2E_EMAIL)
    await waitForUserWorkflowAvailable(userToken, MINI_RECIPE_NAME)
    const { app, page: desktopPage } = await launchAndLogin(E2E_EMAIL)
    try {
      await openWorkflowsPage(desktopPage)
      const row = workflowRow(desktopPage, MINI_RECIPE_NAME)
      await expect(row).toBeVisible({ timeout: 20_000 })

      const detailCard = await selectWorkflow(desktopPage, MINI_RECIPE_NAME, RECIPE_NS)
      await expect(detailCard.locator('.input-contract-form')).toBeVisible({ timeout: 10_000 })

      const runsBefore = await apiListWorkflowRuns(userToken, RECIPE_NS, MINI_RECIPE_NAME, 20)
      const run = await triggerDesktopRun(
        desktopPage,
        detailCard,
        userToken,
        userId,
        MINI_RECIPE_NAME,
        runsBefore.items.map(item => item.id),
        { lookbackDays: '14', holdMs: '35000' }
      )

      await assertRealworldOutputPodsCoLocated(MINI_RECIPE_NAME, [run], '100Mi', [
        { suffix: 'coordinator', component: 'workflow-coordinator' },
        { suffix: 'artifact-reader', component: 'workflow-artifact-reader' },
        { suffix: 'snippet-runner', component: 'workflow-snippet-runner' },
      ])
      await waitForRecipeWorkflowPhase(run.childName, 'completed', 420_000)
      await waitForRunPhase(userToken, MINI_RECIPE_NAME, run.runId, 'Succeeded')
      assertNoWorkflowOutputAttachEvents(
        MINI_RECIPE_NAME,
        workflowOutputClaimName(MINI_RECIPE_NAME)
      )

      const artifacts = await apiListRunArtifacts(userToken, MINI_RECIPE_NAME, run.runId)
      assertMiniArtifactSet(artifacts)
      assertMiniLeadsPayload(
        await apiDownloadJsonArtifact<MiniLeadsPayload>(
          userToken,
          MINI_RECIPE_NAME,
          run.runId,
          MINI_CSV_JSON_ARTIFACT_NAME
        )
      )

      const artifactButton = await refreshDesktopRunsAndFindArtifactButton(
        desktopPage,
        run.runId,
        MINI_CSV_JSON_ARTIFACT_NAME
      )
      assertMiniLeadsPayload(
        JSON.parse(
          await downloadTextFromDesktopWorkflowButton(
            desktopPage,
            artifactButton,
            run.runId,
            MINI_CSV_JSON_ARTIFACT_NAME
          )
        ) as MiniLeadsPayload
      )
    } finally {
      await app.close()
    }
  })
})
