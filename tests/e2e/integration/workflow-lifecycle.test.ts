/**
 * Integration: WorkflowRecipe full lifecycle with coordinator + mcp_host Pods
 *
 * Validates the two-Pod model (coordinator + mcp_host) for agentic workflow execution:
 *   1. WorkflowRecipe with spec.steps[] created via control-api admin endpoint
 *   2. WRC reconciler creates coordinator Pod + mcp_host Pod in sandbox-recipes
 *   3. Coordinator drives step execution via mcp_host
 *   4. Recipe reaches completed or failed phase (not hanging)
 *   5. Status is reflected in WorkflowRecipe CRD status
 *
 * Requires:
 *   - minikube cluster (clerum-test) running
 *   - control-api port-forwarded on :8090  (make minikube-pf-control-ui)
 *   - WRC running with CLERUM_COORDINATOR_IMAGE=clerum/workflow-coordinator:test
 *   - CLERUM_MCP_HOST_IMAGE=clerum/mcp-host:test
 *   - clerum-model-secret-mapping ConfigMap in mcp-host ns with a `zai` key (R1: keyed by provider)
 *   - chatllm-api-keys Secret in mcp-host ns with zai-api-key populated (single source of truth post-refactor)
 *
 * Model: zai / glm-4.7 (default for all steps)
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { execFileSync } from 'node:child_process'
import { CONTROL_API_URL, deleteJson, fetchJson, postJson } from './helpers.integration.js'
import {
  adminLogin,
  adminSessionHeader,
  requireControlApiUp,
  skipEachIfClusterDown,
} from './mcpRotation.helpers.js'

// ─── Config ─────────────────────────────────────────────────────────────────

/** Max wait time for workflow to reach terminal phase (completed/failed) */
const WORKFLOW_TIMEOUT_MS = 5 * 60 * 1000 // 5 minutes
/** How often to poll workflow status */
const POLL_INTERVAL_MS = 10_000
/** Test recipe name — prefix with wf- to identify as workflow (not workload) */
const SMOKE_RECIPE = 'wf-integration-smoke'
/** Namespace where coordinator + mcp_host Pods are created */
const SANDBOX_NS = 'sandbox-recipes'

// ─── State ──────────────────────────────────────────────────────────────────

let controlApiUp = false
let adminToken = ''
let workflowRunId = ''

skipEachIfClusterDown(() => controlApiUp)

// ─── Helpers ─────────────────────────────────────────────────────────────────

/**
 * Execute kubectl and return stdout. Returns null on error.
 * Safe for read-only checks in tests (not destructive).
 *
 * WARNING: `args` is split on whitespace before being passed to execFileSync,
 * so no single token may contain a space (e.g. a jsonpath with embedded
 * spaces like `{range .items[*]}{.metadata.name}{" "}{end}`, or quoted
 * values). All current call sites use K8s names/label selectors/jsonpaths
 * without spaces. If you need a whitespace-containing token, call
 * execFileSync directly with an explicit argv array instead.
 */
function kubectl(args: string): string | null {
  const parts = args.split(/\s+/).filter(Boolean)
  return kubectlArgs(parts)
}

function kubectlArgs(args: string[]): string | null {
  try {
    const ctx = process.env.KUBECTL_CONTEXT ?? 'clerum-test'
    return execFileSync('kubectl', [...args, '--context', ctx], {
      encoding: 'utf-8',
      timeout: 10_000,
      stdio: ['pipe', 'pipe', 'pipe'],
    }).trim()
  } catch {
    return null
  }
}

/** Poll the triggered run using its persisted identity. */
async function waitForTriggeredRunPhase(
  token: string,
  terminalPhases: string[],
  timeoutMs: number
): Promise<string> {
  const deadline = Date.now() + timeoutMs
  let lastPhase = 'unknown'

  while (Date.now() < deadline) {
    const { status, data } = await fetchJson<{ phase?: string }>(
      `${CONTROL_API_URL}/api/v1/admin/workflows/${SANDBOX_NS}/${SMOKE_RECIPE}/runs/${encodeURIComponent(token)}`,
      { headers: adminSessionHeader(adminToken) }
    )
    if (status === 200 && data?.phase) {
      lastPhase = data.phase
      if (terminalPhases.includes(lastPhase)) return lastPhase
    }
    await new Promise(r => setTimeout(r, POLL_INTERVAL_MS))
  }

  return lastPhase
}

/** Wait for a Pod matching labelSelector to appear in a namespace. */
async function waitForPod(
  namespace: string,
  labelSelector: string,
  timeoutMs = 60_000
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const out = kubectl(`get pods -n ${namespace} -l ${labelSelector} --no-headers`)
    if (out && out.trim().length > 0) return true
    await new Promise(r => setTimeout(r, 3_000))
  }
  return false
}

async function waitForKubectlArgs(args: string[], timeoutMs = 15_000): Promise<string> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const out = kubectlArgs(args)
    if (out !== null && out.trim().length > 0) return out
    await new Promise(r => setTimeout(r, 500))
  }
  throw new Error(`Timed out waiting for kubectl output: ${args.join(' ')}`)
}

// ─── Setup / Teardown ────────────────────────────────────────────────────────

beforeAll(async () => {
  controlApiUp = await requireControlApiUp('workflow-lifecycle')
  if (!controlApiUp) return

  try {
    adminToken = await adminLogin()
  } catch (err) {
    throw new Error(`[workflow-lifecycle] Admin login failed: ${(err as Error).message}`)
  }

  // Pre-cleanup: remove leftover recipe from a previous crashed run
  if (adminToken) {
    await deleteJson(
      `${CONTROL_API_URL}/api/v1/admin/recipes/${SMOKE_RECIPE}`,
      adminSessionHeader(adminToken)
    )
    kubectl(
      `delete pods -n ${SANDBOX_NS} -l clerum.io/recipe=${SMOKE_RECIPE} --ignore-not-found=true`
    )
  }
})

afterAll(async () => {
  if (!adminToken) return
  await deleteJson(
    `${CONTROL_API_URL}/api/v1/admin/recipes/${SMOKE_RECIPE}`,
    adminSessionHeader(adminToken)
  )
  kubectl(
    `delete pods -n ${SANDBOX_NS} -l clerum.io/recipe=${SMOKE_RECIPE} --ignore-not-found=true`
  )
})

// ─── Tests ───────────────────────────────────────────────────────────────────

describe('WorkflowRecipe lifecycle — coordinator + mcp_host two-Pod model', () => {
  it('control-api is reachable', async () => {
    const { status } = await fetchJson(`${CONTROL_API_URL}/health`)
    expect(status).toBe(200)
  })

  it('admin login succeeds', async () => {
    expect(adminToken).toBeTruthy()
    expect(adminToken.length).toBeGreaterThan(10)
  })

  it('WRC is running in control-plane', () => {
    const out = kubectl('get deployment workflow-recipes -n control-plane --no-headers')
    expect(out).toBeTruthy()
    expect(out).toContain('1/1')
  })

  it('creates WorkflowRecipe with two steps — default model zai/glm-4.7', async () => {
    const recipeBody = {
      metadata: { name: SMOKE_RECIPE },
      spec: {
        // Pure workflow mode — no workloads[] (coordinator + mcp_host only)
        steps: [
          {
            id: 'step-hello',
            instruction: 'Respond with exactly: HELLO_WORKFLOW_OK',
          },
          {
            id: 'step-confirm',
            instruction: 'Respond with exactly: CONFIRM_OK',
            dependsOn: ['step-hello'],
          },
        ],
        triggers: { onDemand: {} },
        // Provider + model applied to ALL steps (no per-step override)
        agent: {
          provider: 'zai',
          model: 'glm-4.7',
        },
      },
    }

    const { status, data } = await postJson<{ metadata?: { name: string } }>(
      `${CONTROL_API_URL}/api/v1/admin/recipes`,
      recipeBody,
      adminSessionHeader(adminToken)
    )

    expect(status).toBe(201)
    expect(data.metadata?.name).toBe(SMOKE_RECIPE)
  }, 15_000)

  it('triggers the recipe and returns a persisted workflow run identity', async () => {
    const { status, data } = await postJson<{ id?: string; phase?: string }>(
      `${CONTROL_API_URL}/api/v1/admin/workflows/${SANDBOX_NS}/${SMOKE_RECIPE}/trigger`,
      {},
      {
        ...adminSessionHeader(adminToken),
        'Idempotency-Key': `e2e-${SMOKE_RECIPE}-${Date.now()}`,
      }
    )

    expect(status).toBe(201)
    expect(typeof data.id).toBe('string')
    expect(data.id).toMatch(/^[0-9a-f-]{36}$/i)
    expect(data.phase).toBeTruthy()
    workflowRunId = data.id as string
  }, 15_000)

  it('WRC creates coordinator Pod in sandbox-recipes within 60s', async () => {
    const found = await waitForPod(
      SANDBOX_NS,
      `clerum.io/recipe=${SMOKE_RECIPE},clerum.io/component=workflow-coordinator`,
      60_000
    )

    expect(found).toBe(true)
  }, 70_000)

  it('WRC creates mcp_host Pod in sandbox-recipes within 60s', async () => {
    const found = await waitForPod(
      SANDBOX_NS,
      `clerum.io/recipe=${SMOKE_RECIPE},clerum.io/component=workflow-mcp-host`,
      60_000
    )

    expect(found).toBe(true)
  }, 70_000)

  it('mcp_host Pod env has CLERUM_WORKFLOW_ENABLED=true', async () => {
    const out = await waitForKubectlArgs([
      'get',
      'pods',
      '-n',
      SANDBOX_NS,
      '-l',
      `clerum.io/recipe=${SMOKE_RECIPE},clerum.io/component=workflow-mcp-host`,
      '-o',
      'jsonpath={.items[0].spec.containers[0].env[?(@.name=="CLERUM_WORKFLOW_ENABLED")].value}',
    ])
    expect(out.trim()).toBe('true')
  }, 15_000)

  it(
    'the triggered workflow run completes successfully within 5 minutes',
    async () => {
      expect(workflowRunId).toMatch(/^[0-9a-f-]{36}$/i)
      const finalPhase = await waitForTriggeredRunPhase(
        workflowRunId,
        ['completed', 'failed', 'timed_out'],
        WORKFLOW_TIMEOUT_MS
      )

      expect(finalPhase).toBe('completed')
      console.log(`[workflow-lifecycle] Final phase: ${finalPhase}`)
    },
    WORKFLOW_TIMEOUT_MS + 30_000
  )

  it('coordinator Pod reached terminal state (Succeeded or Failed)', async () => {
    const out = kubectl(
      `get pods -n ${SANDBOX_NS} -l clerum.io/recipe=${SMOKE_RECIPE},clerum.io/component=workflow-coordinator --no-headers`
    )
    expect(out).toBeTruthy()
    expect(out).toContain('Completed')
  }, 15_000)

  it('WorkflowRecipe CRD has workflowExecution.phase after workflow runs', async () => {
    const { status, data } = await fetchJson<Record<string, unknown>>(
      `${CONTROL_API_URL}/api/v1/admin/recipes/${SMOKE_RECIPE}/status`,
      { headers: adminSessionHeader(adminToken) }
    )

    expect(status).toBe(200)
    expect(data).toBeTruthy()
    const typedData = data as {
      workflowExecution?: { phase?: string }
      steps?: Array<{ id?: string; phase?: string; output?: string }>
    }
    const phase = typedData.workflowExecution?.phase
    expect(phase).toBe('completed')
    const steps = typedData.steps ?? []
    expect(steps).toHaveLength(2)
    expect(steps.find(step => step.id === 'step-hello')).toMatchObject({ phase: 'completed' })
    expect(steps.find(step => step.id === 'step-confirm')).toMatchObject({ phase: 'completed' })
    expect(steps.find(step => step.id === 'step-hello')?.output).toContain('HELLO_WORKFLOW_OK')
    expect(steps.find(step => step.id === 'step-confirm')?.output).toContain('CONFIRM_OK')
  }, 15_000)
})
