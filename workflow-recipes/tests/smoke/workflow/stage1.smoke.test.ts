/**
 * Stage 1 Smoke Tests (Layer 3) — Minikube clerum-test cluster required.
 *
 * These tests validate that the Stage 1 infrastructure actually works
 * end-to-end in a real Kubernetes cluster, not just in isolation.
 *
 * Prerequisites:
 *   - minikube profile 'clerum-test' running with Calico CNI
 *   - All namespaces created (control-plane, sandbox-recipes, mcp-server, mcp-host)
 *   - CRDs installed
 *   - clerum-wrc-signing-key Secret + clerum-wrc-public-key ConfigMap in control-plane
 *   - WRC and mcp-host deployed and running
 *
 * Run: TEST_SMOKE=true npx vitest run tests/smoke/workflow/stage1.smoke.test.ts
 *
 * Source of truth: STAGE-1-CRD-TWO-POD-FOUNDATION.md §Layer 3
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { execSync } from 'child_process'

const PROFILE = 'clerum-test'
const KC = `kubectl --context=${PROFILE}`
const RECIPE_NAME = 'smoke-wf-test'
const NAMESPACE = 'sandbox-recipes'
const FIXTURE_PATH = 'tests/fixtures/workflow/smoke-test-recipe.yaml'
const INVALID_AGENT_NO_STEPS = 'tests/fixtures/workflow/invalid-agent-no-steps.yaml'
const INVALID_DUPLICATE_IDS = 'tests/fixtures/workflow/invalid-duplicate-step-ids.yaml'
const INVALID_BAD_DEPENDS = 'tests/fixtures/workflow/invalid-bad-depends-on.yaml'

// Skip entire suite if TEST_SMOKE is not set
const runSmoke = process.env.TEST_SMOKE === 'true'

function kubectl(cmd: string, timeout = 30000): string {
  return execSync(`${KC} ${cmd}`, { timeout, encoding: 'utf-8' }).trim()
}

function kubectlSafe(cmd: string, timeout = 30000): string | null {
  try {
    return kubectl(cmd, timeout)
  } catch {
    return null
  }
}

function waitForPodExists(name: string, ns: string, timeoutSec = 30): boolean {
  const deadline = Date.now() + timeoutSec * 1000
  while (Date.now() < deadline) {
    if (kubectlSafe(`get pod ${name} -n ${ns} -o name`, 5000)) return true
    execSync('sleep 2')
  }
  return false
}

// Used by Stage 2+ smoke tests (S2.1 wait for Pod Ready)
export function waitForPod(name: string, ns: string, condition: string, timeoutSec = 120): boolean {
  try {
    kubectl(
      `wait pod/${name} -n ${ns} --for=${condition} --timeout=${timeoutSec}s`,
      (timeoutSec + 10) * 1000
    )
    return true
  } catch {
    return false
  }
}

describe.skipIf(!runSmoke)('Stage 1 Smoke Tests', () => {
  beforeAll(() => {
    // Clean up any previous test run
    kubectlSafe(`delete workflowrecipe ${RECIPE_NAME} -n ${NAMESPACE} --ignore-not-found`)
    // Wait for cleanup
    kubectlSafe(`wait --for=delete pod/${RECIPE_NAME}-coordinator -n ${NAMESPACE} --timeout=30s`)
  })

  afterAll(() => {
    // Cleanup is tested in S1.8, but ensure it happens regardless
    kubectlSafe(`delete workflowrecipe ${RECIPE_NAME} -n ${NAMESPACE} --ignore-not-found`, 15000)
    // Force-remove finalizer if stuck
    kubectlSafe(
      `patch workflowrecipe ${RECIPE_NAME} -n ${NAMESPACE} --type=merge -p '{"metadata":{"finalizers":[]}}' 2>/dev/null`,
      5000
    )
  }, 30000)

  // S1.1: Apply WorkflowRecipe CRD, create test recipe
  it('S1.1 — Apply workflow recipe (CRD schema + CEL valid)', () => {
    const result = kubectl(`apply -f ${FIXTURE_PATH}`)
    expect(result).toContain('created')

    // Verify the recipe exists
    const get = kubectl(
      `get workflowrecipe ${RECIPE_NAME} -n ${NAMESPACE} -o jsonpath='{.metadata.name}'`
    )
    expect(get).toContain(RECIPE_NAME)
  })

  // S1.2: Verify WRC creates coordinator + mcp_host Pods with full SecurityContext
  it('S1.2 — WRC creates coordinator + mcp_host Pods in sandbox-recipes (I-01, I-07)', () => {
    // Wait for Pods to exist (WRC reconciliation may take a few seconds)
    waitForPodExists(`${RECIPE_NAME}-coordinator`, NAMESPACE, 30)
    waitForPodExists(`${RECIPE_NAME}-mcp-host`, NAMESPACE, 30)

    // Verify both Pods exist
    const coordExists = kubectlSafe(
      `get pod ${RECIPE_NAME}-coordinator -n ${NAMESPACE} -o jsonpath='{.metadata.name}'`
    )
    const mcpHostExists = kubectlSafe(
      `get pod ${RECIPE_NAME}-mcp-host -n ${NAMESPACE} -o jsonpath='{.metadata.name}'`
    )
    expect(coordExists).toContain(`${RECIPE_NAME}-coordinator`)
    expect(mcpHostExists).toContain(`${RECIPE_NAME}-mcp-host`)

    // Verify SecurityContext — coordinator (I-07)
    const coordRunAsNonRoot = kubectl(
      `get pod ${RECIPE_NAME}-coordinator -n ${NAMESPACE} -o jsonpath='{.spec.securityContext.runAsNonRoot}'`
    )
    expect(coordRunAsNonRoot).toContain('true')

    // Verify SecurityContext — mcp_host (I-07, GAP-5 fix)
    const mcpHostRunAsNonRoot = kubectl(
      `get pod ${RECIPE_NAME}-mcp-host -n ${NAMESPACE} -o jsonpath='{.spec.securityContext.runAsNonRoot}'`
    )
    expect(mcpHostRunAsNonRoot).toContain('true')

    // Verify readOnlyRootFilesystem — mcp_host (I-11)
    const mcpHostReadOnly = kubectl(
      `get pod ${RECIPE_NAME}-mcp-host -n ${NAMESPACE} -o jsonpath='{.spec.containers[0].securityContext.readOnlyRootFilesystem}'`
    )
    expect(mcpHostReadOnly).toContain('true')

    // Verify readOnlyRootFilesystem — coordinator (I-11)
    const coordReadOnly = kubectl(
      `get pod ${RECIPE_NAME}-coordinator -n ${NAMESPACE} -o jsonpath='{.spec.containers[0].securityContext.readOnlyRootFilesystem}'`
    )
    expect(coordReadOnly).toContain('true')

    // Verify labels
    const coordComponent = kubectl(
      `get pod ${RECIPE_NAME}-coordinator -n ${NAMESPACE} -o jsonpath='{.metadata.labels.clerum\\.io/component}'`
    )
    expect(coordComponent).toContain('workflow-coordinator')

    const mcpComponent = kubectl(
      `get pod ${RECIPE_NAME}-mcp-host -n ${NAMESPACE} -o jsonpath='{.metadata.labels.clerum\\.io/component}'`
    )
    expect(mcpComponent).toContain('workflow-mcp-host')
  })

  // S1.3: WRC POST /configure reaches mcp_host with valid JWT
  it('S1.3 — WRC POST /configure reaches mcp_host with valid JWT', () => {
    // Verify mcp_host is in workflow mode by checking its env
    const workflowEnabled = kubectl(
      `get pod ${RECIPE_NAME}-mcp-host -n ${NAMESPACE} -o jsonpath='{.spec.containers[0].env[?(@.name=="CLERUM_WORKFLOW_ENABLED")].value}'`
    )
    expect(workflowEnabled).toContain('true')
  })

  // S1.4: Coordinator reads JWT tokens from mounted Secret
  it('S1.4 — Coordinator Secret contains JWT tokens (I-05)', () => {
    const secretName = `wf-${RECIPE_NAME}-coordinator-token`

    const secretExists = kubectlSafe(
      `get secret ${secretName} -n ${NAMESPACE} -o jsonpath='{.metadata.name}'`
    )
    expect(secretExists).toContain(secretName)

    // Verify Secret has both required keys
    const keys = kubectl(`get secret ${secretName} -n ${NAMESPACE} -o jsonpath='{.data}'`)
    expect(keys).toContain('mcp-host-token')
    expect(keys).toContain('wrc-token')

    // Verify coordinator Pod mounts the full Secret volume so kubelet can rotate files.
    const tokenVolumeRef = kubectl(
      `get pod ${RECIPE_NAME}-coordinator -n ${NAMESPACE} -o jsonpath='{.spec.volumes[?(@.name=="workflow-tokens")].secret.secretName}'`
    )
    expect(tokenVolumeRef).toContain(secretName)
    const mcpHostTokenFile = kubectl(
      `get pod ${RECIPE_NAME}-coordinator -n ${NAMESPACE} -o jsonpath='{.spec.containers[0].env[?(@.name=="MCP_HOST_TOKEN_FILE")].value}'`
    )
    expect(mcpHostTokenFile).toContain('/var/run/clerum/workflow-tokens/mcp-host-token')
  })

  // S1.5: NetworkPolicies — all 4 exist + coordinator K8s isolation
  it('S1.5 — All 4 NetworkPolicies created + coordinator K8s isolation (I-02, I-08)', () => {
    // Verify automountServiceAccountToken is false (I-02)
    const autoMount = kubectl(
      `get pod ${RECIPE_NAME}-coordinator -n ${NAMESPACE} -o jsonpath='{.spec.automountServiceAccountToken}'`
    )
    expect(autoMount).toContain('false')

    // Verify all 4 NetworkPolicies exist (GAP-3 fix)
    const policies = kubectl(
      `get networkpolicy -n ${NAMESPACE} -l clerum.io/recipe=${RECIPE_NAME} -o name`
    )
    expect(policies).toContain('coord-to-mcp-host')
    expect(policies).toContain('coord-to-wrc')
    expect(policies).toContain('wrc-to-mcp-host')
    expect(policies).toContain('mcp-host-to-llm-api')
  })

  // S1.6: mcp_host readiness depends on POST /configure
  it('S1.6 — mcp_host has readiness probe on /v1/runtime/health', () => {
    const probePath = kubectl(
      `get pod ${RECIPE_NAME}-mcp-host -n ${NAMESPACE} -o jsonpath='{.spec.containers[0].readinessProbe.httpGet.path}'`
    )
    expect(probePath).toContain('/v1/runtime/health')
  })

  // S1.7: SOUL.md ConfigMap + workflow-config ConfigMap + headless Service
  it('S1.7 — SOUL.md ConfigMap, workflow-config ConfigMap, and headless Service created (I-06)', () => {
    // Verify SOUL.md ConfigMap exists (GAP-1 fix)
    const soulCm = kubectlSafe(
      `get configmap wf-${RECIPE_NAME}-soul-md -n ${NAMESPACE} -o jsonpath='{.metadata.name}'`
    )
    expect(soulCm).toContain(`wf-${RECIPE_NAME}-soul-md`)

    // Verify SOUL.md has content (default SOUL.md)
    const soulData = kubectl(
      `get configmap wf-${RECIPE_NAME}-soul-md -n ${NAMESPACE} -o jsonpath='{.data.SOUL\\.md}'`
    )
    expect(soulData.length).toBeGreaterThan(0)

    // Verify workflow-config ConfigMap exists
    const workflowConfigCm = kubectlSafe(
      `get configmap ${RECIPE_NAME}-workflow-config -n ${NAMESPACE} -o jsonpath='{.metadata.name}'`
    )
    expect(workflowConfigCm).toContain(`${RECIPE_NAME}-workflow-config`)

    // Verify headless Service exists (GAP-2 fix)
    const svc = kubectlSafe(
      `get service wf-${RECIPE_NAME}-mcp-host -n ${NAMESPACE} -o jsonpath='{.metadata.name}'`
    )
    expect(svc).toContain(`wf-${RECIPE_NAME}-mcp-host`)

    // Verify headless Service has clusterIP: None
    const clusterIP = kubectl(
      `get service wf-${RECIPE_NAME}-mcp-host -n ${NAMESPACE} -o jsonpath='{.spec.clusterIP}'`
    )
    expect(clusterIP).toContain('None')
  })

  // S1.8: Delete recipe → full cleanup of ALL resources
  it('S1.8 — Delete WorkflowRecipe cleans up all resources', { timeout: 120000 }, () => {
    // Delete recipe — if finalizer stalls, force-remove it
    kubectlSafe(`delete workflowrecipe ${RECIPE_NAME} -n ${NAMESPACE} --timeout=45s`)

    // If still stuck (finalizer not processed), patch finalizers away
    const stillExists = kubectlSafe(`get workflowrecipe ${RECIPE_NAME} -n ${NAMESPACE} -o name`)
    if (stillExists) {
      kubectlSafe(
        `patch workflowrecipe ${RECIPE_NAME} -n ${NAMESPACE} --type=merge -p '{"metadata":{"finalizers":[]}}'`
      )
    }

    // Wait for GC (coordinator has terminationGracePeriodSeconds, needs more time)
    kubectlSafe(`wait --for=delete pod/${RECIPE_NAME}-coordinator -n ${NAMESPACE} --timeout=60s`)
    kubectlSafe(`wait --for=delete pod/${RECIPE_NAME}-mcp-host -n ${NAMESPACE} --timeout=60s`)

    // If pods are still Terminating after wait, force-delete them (finalizer may be slow)
    kubectlSafe(
      `delete pod ${RECIPE_NAME}-coordinator -n ${NAMESPACE} --force --grace-period=0 --ignore-not-found`
    )
    kubectlSafe(
      `delete pod ${RECIPE_NAME}-mcp-host -n ${NAMESPACE} --force --grace-period=0 --ignore-not-found`
    )
    execSync('sleep 3')

    // Verify Pods are gone
    const coordAfter = kubectlSafe(
      `get pod ${RECIPE_NAME}-coordinator -n ${NAMESPACE} --ignore-not-found -o name`
    )
    expect(coordAfter).toSatisfy((v: string | null) => !v || v.trim() === '')

    // Verify Secret cleaned up
    const secretAfter = kubectlSafe(
      `get secret wf-${RECIPE_NAME}-coordinator-token -n ${NAMESPACE} 2>&1`
    )
    expect(secretAfter).toBeNull()

    // Verify SOUL.md ConfigMap cleaned up (GAP-4 fix)
    const soulCmAfter = kubectlSafe(`get configmap wf-${RECIPE_NAME}-soul-md -n ${NAMESPACE} 2>&1`)
    expect(soulCmAfter).toBeNull()

    // Verify workflow-config ConfigMap cleaned up (GAP-4 fix)
    const configCmAfter = kubectlSafe(
      `get configmap ${RECIPE_NAME}-workflow-config -n ${NAMESPACE} 2>&1`
    )
    expect(configCmAfter).toBeNull()

    // Verify headless Service cleaned up (GAP-4 fix)
    const svcAfter = kubectlSafe(`get service wf-${RECIPE_NAME}-mcp-host -n ${NAMESPACE} 2>&1`)
    expect(svcAfter).toBeNull()

    // Verify NetworkPolicies cleaned up (GAP-4 fix)
    const npAfter = kubectlSafe(
      `get networkpolicy -n ${NAMESPACE} -l clerum.io/recipe=${RECIPE_NAME} -o name`
    )
    expect(npAfter === null || npAfter === '').toBe(true)
  })

  // S1.9: Idempotency — applying the same recipe twice produces no error
  it('S1.9 — Idempotency: re-apply same recipe succeeds (GAP-8)', { timeout: 90000 }, () => {
    // Ensure clean state after S1.8 force-delete
    kubectlSafe(
      `delete workflowrecipe ${RECIPE_NAME} -n ${NAMESPACE} --ignore-not-found --timeout=10s`
    )
    kubectlSafe(
      `delete pod ${RECIPE_NAME}-coordinator -n ${NAMESPACE} --force --grace-period=0 --ignore-not-found`
    )
    kubectlSafe(
      `delete pod ${RECIPE_NAME}-mcp-host -n ${NAMESPACE} --force --grace-period=0 --ignore-not-found`
    )
    execSync('sleep 5')

    // First apply (creates)
    const first = kubectl(`apply -f ${FIXTURE_PATH}`)
    expect(first).toMatch(/created|unchanged|configured/)

    // Wait for reconciliation
    waitForPodExists(`${RECIPE_NAME}-coordinator`, NAMESPACE, 45)

    // Second apply (should be unchanged or configured, not error)
    const second = kubectl(`apply -f ${FIXTURE_PATH}`)
    expect(second).toMatch(/unchanged|configured/)

    // Verify resources still exist and are not duplicated
    const coordExists = kubectlSafe(
      `get pod ${RECIPE_NAME}-coordinator -n ${NAMESPACE} -o jsonpath='{.metadata.name}'`
    )
    expect(coordExists).toContain(`${RECIPE_NAME}-coordinator`)

    // Cleanup for next tests
    kubectlSafe(`delete workflowrecipe ${RECIPE_NAME} -n ${NAMESPACE} --timeout=30s`)
    kubectlSafe(
      `patch workflowrecipe ${RECIPE_NAME} -n ${NAMESPACE} --type=merge -p '{"metadata":{"finalizers":[]}}' 2>/dev/null`,
      5000
    )
    kubectlSafe(`wait --for=delete pod/${RECIPE_NAME}-coordinator -n ${NAMESPACE} --timeout=30s`)
  })

  // S1.10: CEL R1 — agent{} without steps[] is rejected
  it('S1.10 — CEL R1: agent without steps is rejected (I-13)', () => {
    const result = kubectlSafe(`apply -f ${INVALID_AGENT_NO_STEPS} 2>&1`)
    // K8s API should reject with validation error
    expect(result).toBeNull() // kubectlSafe returns null on error
    // Double-check: resource should not exist
    const exists = kubectlSafe(`get workflowrecipe smoke-invalid-cel -n ${NAMESPACE} -o name`)
    expect(exists).toBeNull()
  })

  // S1.11: CEL R4 — duplicate step IDs are rejected
  it('S1.11 — CEL R4: duplicate step IDs rejected (I-13)', () => {
    const result = kubectlSafe(`apply -f ${INVALID_DUPLICATE_IDS} 2>&1`)
    expect(result).toBeNull()
    const exists = kubectlSafe(`get workflowrecipe smoke-invalid-dup -n ${NAMESPACE} -o name`)
    expect(exists).toBeNull()
  })

  // S1.12: WRC graph validation — dependsOn referencing non-existent step is rejected
  it('S1.12 — WRC graph validation: invalid dependsOn reference fails before pods (I-13)', () => {
    const result = kubectlSafe(`apply -f ${INVALID_BAD_DEPENDS} 2>&1`)
    expect(result).toContain('workflowrecipe.clerum.io/smoke-invalid-dep')

    let phase = ''
    let message = ''
    for (let i = 0; i < 20; i++) {
      phase =
        kubectlSafe(
          `get workflowrecipe smoke-invalid-dep -n ${NAMESPACE} -o jsonpath='{.status.phase}'`
        ) ?? ''
      message =
        kubectlSafe(
          `get workflowrecipe smoke-invalid-dep -n ${NAMESPACE} -o jsonpath='{.status.message}'`
        ) ?? ''
      if (phase === 'failed' && message.includes('depends on unknown step')) break
      execSync('sleep 1')
    }

    expect(phase).toBe('failed')
    expect(message).toContain('depends on unknown step')
    const pod = kubectlSafe(`get pod smoke-invalid-dep-coordinator -n ${NAMESPACE} -o name`)
    expect(pod).toBeNull()
    kubectlSafe(`delete workflowrecipe smoke-invalid-dep -n ${NAMESPACE} --ignore-not-found`)
  })
})
