/**
 * Desktop App — Competitive Intel Happy Path
 *
 * Full happy-path E2E that stitches admin-side recipe creation, Desktop App
 * user-side trigger with custom inputs and real-time progress visibility.
 * Validates the full chain:
 *
 *   control-api (admin JWT)
 *     → POST /admin/recipes                 (canonical sandbox-recipes ns)
 *     → wait status=Active + pods Ready
 *     → PUT /admin/workflows/:ns/:name/grants   (grant test@clerum.io)
 *   external-rest-api (session JWT)
 *     → GET /api/v1/workflows               (list filtered to granted)
 *     → GET /api/v1/workflows/:ns/:name     (read inputContract)
 *     → POST /api/v1/workflows/:ns/:name/trigger (custom inputs body)
 *     → GET /api/v1/workflows/:ns/:name/runs     (phase transitions)
 *   Desktop App (electron/playwright)
 *     → launch + dev-login (test@clerum.io)
 *     → navigate to Workflows
 *     → select recipe + verify InputContractForm renders
 *     → fill custom values (industry, competitors, focus_areas)
 *     → click Trigger + observe success toast + new run row
 *     → watch run phase Pending → Running → (terminal)
 *   legacy control-api artifact check (admin JWT; not Desktop acceptance)
 *     → GET /admin/workflows/:ns/:name/runs/:runId/artifacts/:file/download
 *     → verify PDF content (%PDF magic bytes + size > 0)
 *
 * Scope & known Desktop App gaps
 * ------------------------------
 *  - This is legacy coverage for an older agentic WorkflowRecipe path. It does
 *    NOT prove Desktop App artifact download. New workflow artifact acceptance
 *    must use the run-scoped Desktop App button path and Playwright's download
 *    event, as covered by workflow-snippet-runtime-happy-path.test.ts and
 *    workflow-custom-coordinator-sdk-happy-path.test.ts.
 *  - The trigger flow must support custom inputs before submission.
 *
 * Runtime characteristics
 * -----------------------
 *  - Deploy of web-search MCP workload + coordinator + mcp-host pods: 30-90s.
 *  - 4 agentic steps via zai/glm-4.7 with real web search: 3-6 min typical.
 *  - Total budget: 12 minutes. Marked `test.slow()` and with a per-test
 *    timeout of 900 seconds. Not for every-push CI; run on-demand.
 *
 * Prerequisites
 * -------------
 *  - clerum-test cluster with port-forwards on :8090, :8091, :8094.
 *  - ZAI_API_KEY present in mcp-host-secrets (verified in the setup phase).
 *  - ADMIN_PASSWORD env var (default 'changeme123!') valid for admin auth.
 *  - test@clerum.io seeded via scripts/minikube/seed-test-data.sh.
 */
import { expect, test } from '@playwright/test'
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
  launchAndLogin,
  loginAs,
  openWorkflowsPage,
  selectWorkflow,
  workflowRow,
} from './workflowUi'

const CONTROL_API = process.env.CONTROL_API_BASE_URL || 'http://127.0.0.1:8090'
const RPC_PROXY = process.env.RPC_PROXY_BASE_URL || 'http://127.0.0.1:8094'
const MCP_HOST = process.env.MCP_HOST_BASE_URL || 'http://127.0.0.1:8080'
const WORKFLOW_APPROVAL_READER =
  process.env.WORKFLOW_APPROVAL_READER_BASE_URL || 'http://127.0.0.1:8098'
const ADMIN_USERNAME = process.env.E2E_ADMIN_USERNAME || 'admin'
// Symmetric with scripts/e2e/e2e-workflow-triggers.sh:103 which fails fast
// when E2E_ADMIN_PASSWORD is unset. A silent default here would let CI go
// green on an unconfigured machine while the shell suite fails — strictly
// worse than a loud config error. Resolved lazily (inside the test body,
// not at module load) so the full Playwright suite can still discover
// this spec when the env var is not set.
function requireAdminPassword(): string {
  const value = process.env.E2E_ADMIN_PASSWORD || process.env.ADMIN_PASSWORD
  if (!value) {
    throw new Error(
      'E2E_ADMIN_PASSWORD is required to acquire an admin JWT for recipe ' +
        'creation + grants. Set it in .env.e2e or the command-line env.'
    )
  }
  return value
}
const RECIPE_NS = 'sandbox-recipes'
const RECIPE_NAME = `e2e-compintel-${Date.now()}`
const MCP_SERVER_NS = 'mcp-server'
const CLEANUP_TIMEOUT_MS = 180_000
const WEB_SEARCH_PUBLIC_WEB_EGRESS_BINDINGS = [{ egressClass: 'public-web' }]

// Terminal phases from workflow_runs.phase enum. `Succeeded` is the happy-path
// terminal. `Failed` and `Canceled` are also terminal but should never occur
// in a healthy run — if we see one we surface it as the cause of the test
// failure instead of waiting out the full timeout.
const TERMINAL_PHASES = new Set(['Succeeded', 'Failed', 'Canceled'])

async function adminLogin(): Promise<string> {
  const password = requireAdminPassword()
  const { status, body } = await apiRequest(
    'POST',
    `${CONTROL_API}/api/v1/admin/auth/login`,
    JSON.stringify({ username: ADMIN_USERNAME, password })
  )
  if (status !== 200) {
    throw new Error(`admin login failed (HTTP ${status}): ${body}`)
  }
  const parsed = JSON.parse(body) as { token?: string }
  if (!parsed.token) throw new Error('admin login missing token')
  return parsed.token
}

function buildRecipeSpec(name: string): Record<string, unknown> {
  // Mirrors control-ui/components/RecipeEditor.tsx "Competitive Intel Report
  // (PDF)" template — 4 agentic steps + web-search MCP workload. The
  // `ghcr.io/aas-ee/open-web-search:latest` image is already cached in
  // clerum-test's docker (verified via `minikube docker-env && docker images`),
  // so WRC's mcpDelegation NETWORK_READY_TIMEOUT_MS (30 s) is sufficient for
  // the child recipe to reach `active` on re-trigger.
  //
  // Namespace intentionally omitted — control-api forces sandbox-recipes
  // regardless (recipes.ts:497 strips caller-supplied metadata.namespace).
  return {
    apiVersion: 'clerum.io/v1alpha1',
    kind: 'WorkflowRecipe',
    metadata: { name },
    spec: {
      agent: { provider: 'zai', model: 'glm-4.7' },
      inputContract: {
        properties: {
          industry: {
            type: 'string',
            default: 'enterprise AI orchestration platforms',
            description: 'Market sector being analyzed',
          },
          competitors: {
            type: 'string',
            default: 'LangChain, CrewAI, AutoGen',
            description: 'Comma-separated list of competitors to research',
          },
          focus_areas: {
            type: 'string',
            default: 'pricing, features, market share, developer experience',
            description: 'Dimensions the report should focus on',
          },
        },
      },
      triggers: {
        onDemand: {
          requiresApproval: false,
          allowedActors: ['user', 'autonomous'],
        },
      },
      mcpServers: [{ id: 'web-search' }],
      steps: [
        {
          id: 'research-competitors',
          instruction:
            'Briefly research {{inputs.competitors}} in {{inputs.industry}} — focus on {{inputs.focus_areas}}. Use 1 DuckDuckGo search call, stay well under the step budget. Output <400 words, bullet points.',
          mcpServers: ['web-search'],
          allowedTools: {
            include: ['web-search__search'],
          },
          timeoutSeconds: 180,
        },
        {
          id: 'analyze-market',
          instruction:
            'Using the research below, produce a compact comparison matrix plus 3 strategic recommendations. Keep under 400 words.\n\n{{research-competitors:output}}',
          dependsOn: ['research-competitors'],
          timeoutSeconds: 120,
        },
        {
          id: 'deslop',
          instruction:
            'Review the analysis and strip filler / vague claims. Preserve facts and the comparison matrix. Output the cleaned markdown only.\n\n{{analyze-market:output}}',
          dependsOn: ['analyze-market'],
          timeoutSeconds: 90,
        },
        {
          id: 'generate-report',
          instruction:
            'You MUST call clerum__generate_pdf once with this exact payload:\nfilename: "competitive-intelligence-report.pdf"\ntitle: "Competitive Intelligence Report: {{inputs.industry}}"\nbody:\n{{deslop:output}}',
          allowedTools: { include: ['clerum__generate_pdf'] },
          dependsOn: ['deslop'],
          timeoutSeconds: 120,
        },
      ],
      output: {
        destination: 'pvc',
        name: 'competitive-intel-report',
        format: 'pdf',
        storageSize: '64Mi',
      },
      workloads: [
        {
          id: 'web-search',
          type: 'deployment',
          image: 'ghcr.io/aas-ee/open-web-search:latest',
          port: 3000,
          transport: { type: 'streamableHttp' },
          env: [
            { name: 'DEFAULT_SEARCH_ENGINE', value: 'duckduckgo' },
            { name: 'ALLOWED_SEARCH_ENGINES', value: 'duckduckgo' },
            { name: 'ENABLE_CORS', value: 'true' },
          ],
          egressBindings: WEB_SEARCH_PUBLIC_WEB_EGRESS_BINDINGS,
        },
      ],
    },
  }
}

async function apiCreateRecipe(adminToken: string, name: string): Promise<void> {
  const { status, body } = await apiRequest(
    'POST',
    `${CONTROL_API}/api/v1/admin/recipes`,
    JSON.stringify(buildRecipeSpec(name)),
    { Authorization: `Bearer ${adminToken}` }
  )
  if (status !== 201) {
    throw new Error(`POST /admin/recipes failed (HTTP ${status}): ${body}`)
  }
}

async function apiGrantRecipe(adminToken: string, name: string, userId: string): Promise<void> {
  const { status, body } = await apiRequest(
    'PUT',
    `${CONTROL_API}/api/v1/admin/workflows/${RECIPE_NS}/${name}/grants`,
    JSON.stringify({ userIds: [userId] }),
    { Authorization: `Bearer ${adminToken}` }
  )
  if (status !== 200) {
    throw new Error(`PUT /grants failed (HTTP ${status}): ${body}`)
  }
}

// Timeouts are DERIVED from the recipe spec (not hardcoded, not env vars)
// so the test stays in lock-step with the CRD's own declared budget:
//
//   RUN_EXEC_TIMEOUT_MS = sum(step.timeoutSeconds) * 1.25
//     Rationale: step.timeoutSeconds is the WRC-enforced step ceiling
//     declared in `buildRecipeSpec`. The 25 % slack covers WRC reconcile
//     overhead (child-recipe creation, pod readiness polling between
//     steps) that happens *outside* the step timer.
//
//   DEPLOY_TIMEOUT_MS — no single infra constant governs end-to-end
//     reconcile (it's the composition of K8s scheduler + image pull +
//     HCC NetworkPolicy reconcile + WRC mcpDelegation NETWORK_READY_TIMEOUT_MS
//     of 30 s per workload). First pull of ghcr.io/aas-ee/open-web-search
//     is already cached in clerum-test's docker (verified via
//     `minikube docker-env && docker images`), so a 5-minute window is
//     generous enough for every subsequent reconcile.
//
//   RUN_CREATE_TIMEOUT_MS — control-api inserts the workflow_runs row
//     synchronously in the POST /trigger handler. 60 s is ~12× the
//     observed DB INSERT latency and tolerates nginx funnel hiccups.
function sumStepTimeoutsMs(spec: Record<string, unknown>): number {
  const steps =
    ((spec.spec as Record<string, unknown>)?.steps as
      | Array<{ timeoutSeconds?: number }>
      | undefined) ?? []
  const totalSeconds = steps.reduce((acc, step) => acc + (step.timeoutSeconds ?? 0), 0)
  return Math.round(totalSeconds * 1_000 * 1.25) // 25% slack for WRC orchestration overhead
}

const DEPLOY_TIMEOUT_MS = 300_000
const RUN_CREATE_TIMEOUT_MS = 60_000

async function assertJsonHealth(label: string, url: string): Promise<void> {
  const response = await fetch(url)
  expect(response.status, `${label} health should return HTTP 200`).toBe(200)
  const body = (await response.json()) as { status?: string; ok?: boolean }
  expect(
    body.status === 'ok' || body.ok === true,
    `${label} health response should be an explicit ok payload`
  ).toBe(true)
}

async function assertClusterHealthPreconditions(): Promise<void> {
  await Promise.all([
    assertJsonHealth('control-api', `${CONTROL_API}/health`),
    assertJsonHealth('external-rest-api', `${EXT_API}/health`),
    assertJsonHealth('rpc-proxy', `${RPC_PROXY}/health`),
    assertJsonHealth('workflow-approval-request-reader', `${WORKFLOW_APPROVAL_READER}/health`),
    assertJsonHealth('mcp-host runtime', `${MCP_HOST}/v1/runtime/health`),
  ])
}

async function assertExternalWorkflowRead(
  userToken: string,
  name: string
): Promise<Record<string, unknown>> {
  const readResponse = await apiRequest(
    'GET',
    `${EXT_API}/api/v1/workflows/${encodeURIComponent(RECIPE_NS)}/${encodeURIComponent(name)}`,
    undefined,
    { Authorization: `Bearer ${userToken}` }
  )
  expect(readResponse.status, `GET external workflow detail for ${name}`).toBe(200)
  const readBody = JSON.parse(readResponse.body) as {
    metadata?: { namespace?: string; name?: string }
    spec?: { inputContract?: { properties?: Record<string, unknown> } }
  }

  expect(readBody.metadata?.namespace).toBe(RECIPE_NS)
  expect(readBody.metadata?.name).toBe(name)
  expect(Object.keys(readBody.spec?.inputContract?.properties ?? {}).sort()).toEqual([
    'competitors',
    'focus_areas',
    'industry',
  ])

  return readBody as Record<string, unknown>
}

async function waitForRecipeReady(adminToken: string, name: string): Promise<void> {
  // CRD status.phase is lowercase per workflow-recipes/src/types.ts:RecipePhase
  // enum. Happy path: candidate -> deploying -> active. `failed` is terminal
  // and should abort the test instead of timing out.
  const TERMINAL_FAIL = new Set(['failed', 'rollback-failed', 'deprecated'])
  const deadline = Date.now() + DEPLOY_TIMEOUT_MS
  let lastStatus = ''
  while (Date.now() < deadline) {
    const { status, body } = await apiRequest(
      'GET',
      `${CONTROL_API}/api/v1/admin/workflows/${RECIPE_NS}/${name}`,
      undefined,
      { Authorization: `Bearer ${adminToken}` }
    )
    if (status === 200) {
      const parsed = JSON.parse(body) as { status?: { phase?: string } }
      lastStatus = parsed.status?.phase ?? '(unset)'
      if (lastStatus === 'active') return
      if (TERMINAL_FAIL.has(lastStatus)) {
        throw new Error(`recipe ${name} reached terminal failure phase=${lastStatus}`)
      }
    }
    await new Promise(resolve => setTimeout(resolve, 5_000))
  }
  throw new Error(
    `recipe ${name} did not reach active within ${DEPLOY_TIMEOUT_MS / 1000}s (last phase=${lastStatus})`
  )
}

async function downloadRunArtifactViaAdmin(
  adminToken: string,
  ns: string,
  name: string,
  runId: string,
  artifactName: string
): Promise<Buffer> {
  // node fetch binds arraybuffer for us — apiRequest is string-only, so go
  // raw here for the binary download path. Keep this run-scoped so the test
  // proves the artifact belongs to the run triggered through Desktop App.
  const res = await fetch(
    `${CONTROL_API}/api/v1/admin/workflows/${encodeURIComponent(ns)}/${encodeURIComponent(name)}/runs/${encodeURIComponent(runId)}/artifacts/${encodeURIComponent(artifactName)}/download`,
    { headers: { Authorization: `Bearer ${adminToken}` } }
  )
  if (res.status !== 200) {
    const text = await res.text().catch(() => '')
    throw new Error(`artifact download failed (HTTP ${res.status}): ${text}`)
  }
  const arrayBuffer = await res.arrayBuffer()
  return Buffer.from(arrayBuffer)
}

function kubectl(args: string[], timeout = 30_000): string {
  return execFileSync('kubectl', ['--context', K8S_CONTEXT, ...args], {
    encoding: 'utf-8',
    timeout,
  })
}

function listRecipeK8sResidues(name: string): string[] {
  const checks = [
    {
      namespace: RECIPE_NS,
      kinds: 'workflowrecipe,pod,svc,configmap,secret,networkpolicy',
    },
    {
      namespace: MCP_SERVER_NS,
      kinds: 'deployment,pod,svc,networkpolicy,mcpserver',
    },
  ]

  return checks.flatMap(check => {
    try {
      return kubectl(['-n', check.namespace, 'get', check.kinds, '-o', 'name'], 20_000)
        .split('\n')
        .map(line => line.trim())
        .filter(line => line.includes(name))
        .map(line => `${check.namespace}/${line}`)
    } catch {
      return []
    }
  })
}

async function waitForRecipeK8sCleanup(name: string): Promise<void> {
  await expect
    .poll(() => listRecipeK8sResidues(name), {
      timeout: CLEANUP_TIMEOUT_MS,
      intervals: [1_000, 2_000, 5_000],
      message: `K8s resources for ${name} should be removed from ${RECIPE_NS} and ${MCP_SERVER_NS}`,
    })
    .toEqual([])
}

async function cleanupRecipe(name: string): Promise<void> {
  // K8s + DB cleanup so repeated on-demand test runs do not accumulate
  // orphan resources or rows in workflow_runs / user_workflow_triggers.
  // The recipe name includes Date.now(), but
  // cleanup still has to prove WRC finalizers removed cross-namespace transport
  // resources from mcp-server.
  try {
    const recipeResources = kubectl(
      ['-n', RECIPE_NS, 'get', 'workflowrecipe', '-o', 'name'],
      30_000
    )
      .split('\n')
      .map(line => line.trim())
      .filter(line => line.includes(name))

    if (recipeResources.length > 0) {
      kubectl(
        ['-n', RECIPE_NS, 'delete', ...recipeResources, '--ignore-not-found=true', '--wait=false'],
        30_000
      )
    }
  } catch {
    /* ignore — the assertion below reports any remaining resources */
  }

  await waitForRecipeK8sCleanup(name)

  try {
    const sql = [
      `DELETE FROM workflow_runs WHERE recipe_name = '${name}';`,
      `DELETE FROM user_workflow_triggers WHERE recipe_name = '${name}';`,
    ].join('\n')
    execFileSync(
      'kubectl',
      [
        '--context',
        K8S_CONTEXT,
        '-n',
        'control-plane',
        'exec',
        'deploy/control-postgres',
        '--',
        'psql',
        '-U',
        'postgres',
        '-d',
        'profiles',
        '-c',
        sql,
      ],
      { encoding: 'utf-8', timeout: 20_000 }
    )
  } catch {
    /* ignore — rows are test-named with Date.now() so next run picks a unique name anyway */
  }
}

test.describe('Desktop App — competitive-intel happy path', () => {
  test.slow()
  test.describe.configure({ timeout: 1_200_000 })

  test.beforeAll(async () => {
    await assertClusterHealthPreconditions()
    await clearSession()
  })

  test.afterAll(async () => {
    await cleanupRecipe(RECIPE_NAME)
  })

  test('creates, grants, triggers from Desktop App with custom inputs, observes progress, and validates run-scoped PDF artifact', async () => {
    // ── Setup A: admin creates recipe via control-api ─────────────────────
    const adminToken = await adminLogin()
    await apiCreateRecipe(adminToken, RECIPE_NAME)

    // ── Setup B: wait for reconciliation (coordinator + mcp-host + web-search Ready)
    await waitForRecipeReady(adminToken, RECIPE_NAME)

    // ── Setup C: grant recipe to test@clerum.io ────────────────────────────
    const { userId, userToken } = await loginAs(E2E_EMAIL)
    await apiGrantRecipe(adminToken, RECIPE_NAME, userId)

    // Cross-check grant landed via external list (same path Desktop App uses).
    const listResponse = await apiRequest('GET', `${EXT_API}/api/v1/workflows`, undefined, {
      Authorization: `Bearer ${userToken}`,
    })
    expect(listResponse.status).toBe(200)
    const listBody = JSON.parse(listResponse.body) as {
      items: Array<{ metadata?: { name?: string; namespace?: string } }>
    }
    const present = listBody.items.some(
      item => item.metadata?.name === RECIPE_NAME && item.metadata?.namespace === RECIPE_NS
    )
    expect(present, `recipe ${RECIPE_NAME} should appear in external list after grant`).toBe(true)
    await assertExternalWorkflowRead(userToken, RECIPE_NAME)

    // ── Exercise D: Desktop App launch + trigger with custom inputs ───────
    const { app, page } = await launchAndLogin()
    try {
      await openWorkflowsPage(page)

      // Row appears (list is auth-filtered to granted recipes).
      const row = workflowRow(page, RECIPE_NAME)
      await expect(row).toBeVisible({ timeout: 15_000 })

      const detailCard = await selectWorkflow(page, RECIPE_NAME, RECIPE_NS)

      // InputContractForm must render before custom inputs can be submitted.
      const form = detailCard.locator('.input-contract-form')
      await expect(form).toBeVisible({ timeout: 10_000 })

      const customIndustry = 'autonomous code review tooling'
      const customCompetitors = 'GitHub Copilot, Cursor, CodeRabbit'
      const customFocus = 'model quality, UX, pricing'

      // InputContractForm wires each input id to the Field <label htmlFor>,
      // so Playwright can resolve the input by its accessible name.
      const industryField = page.getByLabel('industry', { exact: true })
      await industryField.fill(customIndustry)
      const competitorsField = page.getByLabel('competitors', { exact: true })
      await competitorsField.fill(customCompetitors)
      const focusField = page.getByLabel('focus_areas', { exact: true })
      await focusField.fill(customFocus)

      // Before clicking Trigger, confirm the form reflects custom values. This
      // guards against React state races where onChange fires but the input
      // retains a stale display value.
      await expect(industryField).toHaveValue(customIndustry)
      await expect(competitorsField).toHaveValue(customCompetitors)
      await expect(focusField).toHaveValue(customFocus)

      const runsBeforeTrigger = await apiListWorkflowRuns(userToken, RECIPE_NS, RECIPE_NAME, 20)
      const previousRunIds = new Set(runsBeforeTrigger.items.map(item => item.id))

      const triggerBtn = detailCard.getByRole('button', { name: /^trigger$/i })
      await triggerBtn.click()

      // Success toast is exposed through role=status for accessible feedback.
      const toast = page.getByRole('status').filter({ hasText: 'Workflow triggered.' })
      await expect(toast).toBeVisible({ timeout: 10_000 })

      // A new run row should appear. Poll the external API directly with the
      // userToken — bypasses any renderer IPC cache latency seen on slow
      // clusters where the electron worker hadn't refetched runs yet.
      let newRun: {
        id: string
        phase: string
        actor: { type?: string; userId?: string } | null
      } | null = null
      await expect
        .poll(
          async () => {
            const runs = await apiListWorkflowRuns(userToken, RECIPE_NS, RECIPE_NAME, 20)
            const fresh = runs.items.find(
              item => item.actor?.userId === userId && !previousRunIds.has(item.id)
            )
            if (fresh) {
              newRun = fresh
              return fresh.id
            }
            return null
          },
          {
            timeout: RUN_CREATE_TIMEOUT_MS,
            intervals: [500, 1_000, 2_000],
            message: `trigger did not produce a new run within ${RUN_CREATE_TIMEOUT_MS / 1000}s`,
          }
        )
        .not.toBeNull()
      expect(newRun!.actor?.type).toBe('user-session')
      expect(newRun!.actor?.userId).toBe(userId)

      // ── Exercise E: observe progress until terminal ────────────────────
      // Poll the same API surface the Desktop App renderer consumes (same
      // contract, same auth, but without the renderer's caching behaviour).
      const runExecTimeoutMs = sumStepTimeoutsMs(buildRecipeSpec(RECIPE_NAME))
      const runDeadline = Date.now() + runExecTimeoutMs
      let lastPhase = newRun!.phase
      let seenRunning = false
      while (Date.now() < runDeadline) {
        await new Promise(resolve => setTimeout(resolve, 5_000))
        const runs = await apiListWorkflowRuns(userToken, RECIPE_NS, RECIPE_NAME, 20)
        const current = runs.items.find(r => r.id === newRun!.id)
        if (!current) continue
        lastPhase = current.phase
        if (current.phase === 'Running') seenRunning = true
        if (TERMINAL_PHASES.has(current.phase)) break
      }
      expect(
        TERMINAL_PHASES.has(lastPhase),
        `run ${newRun!.id} did not reach a terminal phase within ${runExecTimeoutMs / 1000}s (last=${lastPhase})`
      ).toBe(true)
      expect(seenRunning, 'never observed Running phase transition').toBe(true)
      expect(lastPhase, `run ${newRun!.id} reached terminal phase ${lastPhase}`).toBe('Succeeded')

      const pdf = await downloadRunArtifactViaAdmin(
        adminToken,
        RECIPE_NS,
        RECIPE_NAME,
        newRun!.id,
        'competitive-intelligence-report.pdf'
      )
      expect(pdf.byteLength).toBeGreaterThan(200)
      const head = pdf.subarray(0, 5).toString('ascii')
      expect(head, `expected %PDF- magic, got ${head}`).toBe('%PDF-')

      const outDir = path.join(os.tmpdir(), 'clerum-e2e-artifacts')
      fs.mkdirSync(outDir, { recursive: true })
      const outPath = path.join(outDir, `${RECIPE_NAME}.pdf`)
      fs.writeFileSync(outPath, pdf)
      console.log(`[competitive-intel] downloaded PDF saved to ${outPath}`)
    } finally {
      await app.close()
    }
  })
})
