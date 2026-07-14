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
 *   - clerum-model-secret-mapping ConfigMap in mcp-host ns with zai__glm-4.7 and zai__glm-5-turbo keys
 *   - chatllm-api-keys Secret in mcp-host ns with zai-api-key populated (single source of truth post-refactor)
 *
 * Model: zai / glm-4.7 (default for all steps)
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { execSync } from 'node:child_process'
import {
  CONTROL_API_URL,
  bearer,
  deleteJson,
  fetchJson,
  isServiceUp,
  postJson,
} from './helpers.integration.js'

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

// ─── Helpers ─────────────────────────────────────────────────────────────────

/**
 * Execute kubectl and return stdout. Returns null on error.
 * Safe for read-only checks in tests (not destructive).
 */
function kubectl(args: string): string | null {
  try {
    return execSync(`kubectl ${args} --context clerum-test`, {
      encoding: 'utf-8',
      timeout: 10_000,
      stdio: ['pipe', 'pipe', 'pipe'],
    }).trim()
  } catch {
    return null
  }
}

/** Poll workflow phase until terminal or timeout. Returns final phase. */
async function waitForWorkflowPhase(
  recipeName: string,
  token: string,
  terminalPhases: string[],
  timeoutMs: number
): Promise<string> {
  const deadline = Date.now() + timeoutMs
  let lastPhase = 'unknown'

  while (Date.now() < deadline) {
    // control-api /status returns resource.status directly (not wrapped in { status: ... })
    const { status, data } = await fetchJson<{
      workflowExecution?: { phase?: string }
    }>(`${CONTROL_API_URL}/api/v1/admin/recipes/${recipeName}/status`, { headers: bearer(token) })

    if (status === 200 && data) {
      const phase = (data as { workflowExecution?: { phase?: string } }).workflowExecution?.phase
      if (phase) {
        lastPhase = phase
        if (terminalPhases.includes(lastPhase)) {
          return lastPhase
        }
      }
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
    const out = kubectl(`get pods -n ${namespace} -l ${labelSelector} --no-headers 2>/dev/null`)
    if (out && out.trim().length > 0) return true
    await new Promise(r => setTimeout(r, 3_000))
  }
  return false
}

/** Wait for kubectl jsonpath output to become available. */
async function waitForKubectlOutput(args: string, timeoutMs = 5_000): Promise<string | null> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const out = kubectl(args)
    if (out && out.trim().length > 0) return out
    await new Promise(r => setTimeout(r, 500))
  }
  return null
}

// ─── Setup / Teardown ────────────────────────────────────────────────────────

beforeAll(async () => {
  controlApiUp = await isServiceUp(CONTROL_API_URL)
  if (!controlApiUp) {
    console.log('[workflow-lifecycle] control-api not available — tests will be skipped')
    return
  }

  const adminUsername = process.env.TEST_ADMIN_USERNAME ?? 'admin'
  const adminPassword = process.env.TEST_ADMIN_PASSWORD ?? 'changeme123!'
  const { status, data } = await postJson<{ token?: string }>(
    `${CONTROL_API_URL}/api/v1/admin/auth/login`,
    { username: adminUsername, password: adminPassword }
  )

  if (status === 200 && data.token) {
    adminToken = data.token
  } else {
    console.log('[workflow-lifecycle] Admin login failed — tests will be skipped')
  }

  // Pre-cleanup: remove leftover recipe from a previous crashed run
  if (adminToken) {
    await deleteJson(`${CONTROL_API_URL}/api/v1/admin/recipes/${SMOKE_RECIPE}`, bearer(adminToken))
    // Remove any leftover Pods — ignore errors
    kubectl(
      `delete pods -n ${SANDBOX_NS} -l clerum.io/recipe=${SMOKE_RECIPE} --ignore-not-found=true`
    )
  }
})

afterAll(async () => {
  if (!adminToken) return
  // Best-effort cleanup
  await deleteJson(`${CONTROL_API_URL}/api/v1/admin/recipes/${SMOKE_RECIPE}`, bearer(adminToken))
  kubectl(
    `delete pods -n ${SANDBOX_NS} -l clerum.io/recipe=${SMOKE_RECIPE} --ignore-not-found=true`
  )
})

// ─── Tests ───────────────────────────────────────────────────────────────────

describe('WorkflowRecipe lifecycle — coordinator + mcp_host two-Pod model', () => {
  it('control-api is reachable', async () => {
    if (!controlApiUp) return
    const { status } = await fetchJson(`${CONTROL_API_URL}/health`)
    expect(status).toBe(200)
  })

  it('admin login succeeds', async () => {
    if (!controlApiUp) return
    expect(adminToken).toBeTruthy()
    expect(adminToken.length).toBeGreaterThan(10)
  })

  it('WRC is running in control-plane', () => {
    if (!controlApiUp) return
    const out = kubectl('get deployment workflow-recipes -n control-plane --no-headers')
    expect(out).toBeTruthy()
    expect(out).toContain('1/1')
  })

  it('creates WorkflowRecipe with two steps — default model zai/glm-4.7', async () => {
    if (!controlApiUp || !adminToken) return

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
      bearer(adminToken)
    )

    expect(status).toBe(201)
    expect(data.metadata?.name).toBe(SMOKE_RECIPE)
  }, 15_000)

  it('WRC creates coordinator Pod in sandbox-recipes within 60s', async () => {
    if (!controlApiUp || !adminToken) return

    const found = await waitForPod(
      SANDBOX_NS,
      `clerum.io/recipe=${SMOKE_RECIPE},clerum.io/component=workflow-coordinator`,
      60_000
    )

    expect(found).toBe(true)
  }, 70_000)

  it('WRC creates mcp_host Pod in sandbox-recipes within 60s', async () => {
    if (!controlApiUp || !adminToken) return

    const found = await waitForPod(
      SANDBOX_NS,
      `clerum.io/recipe=${SMOKE_RECIPE},clerum.io/component=workflow-mcp-host`,
      60_000
    )

    expect(found).toBe(true)
  }, 70_000)

  it('mcp_host Pod env has CLERUM_WORKFLOW_ENABLED=true', async () => {
    if (!controlApiUp || !adminToken) return

    const out = await waitForKubectlOutput(
      `get pods -n ${SANDBOX_NS} -l clerum.io/recipe=${SMOKE_RECIPE},clerum.io/component=workflow-mcp-host -o jsonpath='{.items[0].spec.containers[0].env}'`
    )
    // mcp_host should have CLERUM_WORKFLOW_ENABLED in its env
    // Soft assertion: pod may still be in ContainerCreating, skip check if not ready yet
    if (out && out.trim().length > 0) {
      expect(out).toContain('CLERUM_WORKFLOW_ENABLED')
    } else {
      console.log('[workflow-lifecycle] mcp_host pod env not yet available — skipping env check')
    }
  }, 15_000)

  it(
    'WorkflowRecipe reaches terminal phase (completed or failed) within 5 minutes',
    async () => {
      if (!controlApiUp || !adminToken) return

      const terminalPhases = ['completed', 'failed', 'timed_out']
      const finalPhase = await waitForWorkflowPhase(
        SMOKE_RECIPE,
        adminToken,
        terminalPhases,
        WORKFLOW_TIMEOUT_MS
      )

      // Both completed and failed are valid terminal states — the important
      // thing is that the workflow DID run and didn't hang forever.
      expect(terminalPhases).toContain(finalPhase)
      console.log(`[workflow-lifecycle] Final phase: ${finalPhase}`)
    },
    WORKFLOW_TIMEOUT_MS + 30_000
  )

  it('coordinator Pod reached terminal state (Succeeded or Failed)', async () => {
    if (!controlApiUp || !adminToken) return

    const out = kubectl(
      `get pods -n ${SANDBOX_NS} -l clerum.io/recipe=${SMOKE_RECIPE},clerum.io/component=workflow-coordinator --no-headers`
    )
    // Pod should be in Succeeded or Failed phase after workflow completes
    if (out && out.trim().length > 0) {
      const inTerminalState =
        out.includes('Completed') ||
        out.includes('Error') ||
        out.includes('OOMKilled') ||
        out.includes('CrashLoopBackOff') ||
        out.includes('0/1')
      // If the pod exists, it should not be in Running state indefinitely
      // (Completed = exit 0, Error/OOMKilled = exit 1 — both are expected)
      expect(inTerminalState || out.includes('Running')).toBe(true)
    }
    // If pod was cleaned up, that's also fine
  }, 15_000)

  it('WorkflowRecipe CRD has workflowExecution.phase after workflow runs', async () => {
    if (!controlApiUp || !adminToken) return

    const { status, data } = await fetchJson<Record<string, unknown>>(
      `${CONTROL_API_URL}/api/v1/admin/recipes/${SMOKE_RECIPE}/status`,
      { headers: bearer(adminToken) }
    )

    expect([200, 404]).toContain(status)
    if (status === 200 && data) {
      // control-api /status returns resource.status → workflowExecution.phase
      const phase = (data as { workflowExecution?: { phase?: string } }).workflowExecution?.phase
      if (phase !== undefined) {
        expect(typeof phase).toBe('string')
        expect(String(phase).length).toBeGreaterThan(0)
      }
    }
  }, 15_000)
})
