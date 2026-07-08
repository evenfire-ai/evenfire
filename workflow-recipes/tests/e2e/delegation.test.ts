/**
 * E6.1–E6.8: MCP Delegation E2E tests (Phase 6).
 *
 * Validates the MCP intent decomposition pipeline in minikube:
 * - Transport workloads create McpServer CRDs (managed: false)
 * - Transport Services are created for DNS resolution
 * - A per-recipe Context CRD allowlists delegated servers
 * - The shared Context referenced by the recipe is not patched
 * - Non-transport workloads do NOT create McpServer CRDs
 * - Delete recipe cleans up McpServer CRDs and its per-recipe Context
 *
 * Prerequisites:
 *   - Run scripts/minikube-setup.sh before these tests
 *   - The recipe's Context CRD must exist in mcp-server namespace
 *   - These tests run AFTER simple-recipe.test.ts (sequential mode)
 *
 * Note: The redis-mcp image won't pull in minikube — tests verify
 * structural resource creation, not pod readiness.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  MCP_SERVER_NAMESPACE,
  RECIPE_NAMESPACE,
  SANDBOX_NAMESPACE,
  kubectl,
  kubectlJson,
  sleep,
  waitForResource,
} from './helpers'

const RECIPE_NAME = 'mcp-redis-cache'
const RECIPE_FILE = `${__dirname}/../../samples/mcp-redis-cache.yaml`
const CONTEXT_REF = 'context1'
const RECIPE_CONTEXT_NAME = `wf-${RECIPE_NAME}`

// Expected McpServer name: {recipeName}-{workloadId}
const MCP_SERVER_NAME = 'mcp-redis-cache-redis-mcp'

function cleanupRecipeArtifacts(): void {
  const commands = [
    `delete workflowrecipe ${RECIPE_NAME} -n ${RECIPE_NAMESPACE} --ignore-not-found --timeout=20s`,
    `delete mcpservers.clerum.io ${MCP_SERVER_NAME} -n ${MCP_SERVER_NAMESPACE} --ignore-not-found --timeout=20s`,
    `delete contexts.clerum.io ${RECIPE_CONTEXT_NAME} -n ${MCP_SERVER_NAMESPACE} --ignore-not-found --timeout=20s`,
    `delete svc ${MCP_SERVER_NAME} -n ${MCP_SERVER_NAMESPACE} --ignore-not-found --timeout=20s`,
    `delete deploy redis-mcp -n ${MCP_SERVER_NAMESPACE} --ignore-not-found --timeout=20s`,
    `delete deploy redis -n ${SANDBOX_NAMESPACE} --ignore-not-found --timeout=20s`,
    `delete svc redis -n ${SANDBOX_NAMESPACE} --ignore-not-found --timeout=20s`,
  ]

  for (const command of commands) {
    try {
      kubectl(command)
    } catch (e) {
      console.warn('cleanup warning:', e)
    }
  }
}

// ─── Setup & Teardown ──────────────────────────────────────────────────

beforeAll(async () => {
  cleanupRecipeArtifacts()

  // Wait for cascade cleanup in both namespaces
  for (const ns of [MCP_SERVER_NAMESPACE, SANDBOX_NAMESPACE]) {
    try {
      await waitForResource(`deploy -l clerum.io/recipe=${RECIPE_NAME}`, ns, {
        shouldExist: false,
        timeoutMs: 15_000,
      })
    } catch {
      // May not have existed
    }
  }

  // Ensure the Context referenced by the recipe exists.
  try {
    kubectl(`get contexts.clerum.io ${CONTEXT_REF} -n ${MCP_SERVER_NAMESPACE}`)
  } catch {
    // Create it if missing
    kubectl(`apply -f - <<'EOF'
apiVersion: clerum.io/v1alpha1
kind: Context
metadata:
  name: ${CONTEXT_REF}
  namespace: ${MCP_SERVER_NAMESPACE}
spec:
  contextId: ${CONTEXT_REF}
  mcpServers: []
EOF`)
  }
})

afterAll(async () => {
  cleanupRecipeArtifacts()
  await sleep(1_000)
  cleanupRecipeArtifacts()
})

// ─── MCP Delegation E2E Tests ──────────────────────────────────────────

describe('MCP Delegation E2E (Phase 6)', () => {
  // E6.1: Apply the mcp-redis-cache recipe
  it('E6.1 — Apply mcp-redis-cache recipe with transport workload', () => {
    const result = kubectl(`apply -f ${RECIPE_FILE}`)
    expect(result).toContain('workflowrecipe')
    expect(result).toMatch(/created|configured/)
  })

  // E6.2: Both Deployments created — redis (non-MCP → sandbox-recipes) + redis-mcp (MCP → mcp-server)
  it(
    'E6.2 — Two Deployments created (redis in sandbox-recipes, redis-mcp in mcp-server)',
    { timeout: 90_000 },
    async () => {
      // Wait for the MCP deploy (redis-mcp) in mcp-server namespace
      await waitForResource(`deploy redis-mcp`, MCP_SERVER_NAMESPACE, { timeoutMs: 60_000 })
      // Wait for the non-MCP deploy (redis) in sandbox-recipes namespace
      await waitForResource(`deploy redis`, SANDBOX_NAMESPACE, { timeoutMs: 60_000 })

      // MCP workload stays in mcp-server
      const mcpDeploys = kubectlJson<{
        items: Array<{
          metadata: { name: string; labels: Record<string, string> }
        }>
      }>(`get deploy -l clerum.io/recipe=${RECIPE_NAME} -n ${MCP_SERVER_NAMESPACE}`)

      // Non-MCP workload goes to sandbox-recipes (namespace splitting)
      const sandboxDeploys = kubectlJson<{
        items: Array<{
          metadata: { name: string; labels: Record<string, string> }
        }>
      }>(`get deploy -l clerum.io/recipe=${RECIPE_NAME} -n ${SANDBOX_NAMESPACE}`)

      const allDeploys = [...mcpDeploys.items, ...sandboxDeploys.items]
      expect(allDeploys.length).toBe(2)

      const workloadIds = allDeploys.map(d => d.metadata.labels['clerum.io/workload']).sort()
      expect(workloadIds).toEqual(['redis', 'redis-mcp'])

      // Verify namespace routing: redis-mcp (MCP) → mcp-server, redis (non-MCP) → sandbox-recipes
      expect(mcpDeploys.items.map(d => d.metadata.name)).toContain('redis-mcp')
      expect(sandboxDeploys.items.map(d => d.metadata.name)).toContain('redis')
    }
  )

  // E6.3: Transport Service created with correct name for DNS resolution
  it('E6.3 — Transport Service created for redis-mcp', async () => {
    await waitForResource(`svc ${MCP_SERVER_NAME}`, MCP_SERVER_NAMESPACE, { timeoutMs: 15_000 })

    const svc = kubectlJson<{
      metadata: {
        name: string
        labels: Record<string, string>
        ownerReferences?: Array<{ kind: string; name: string }>
      }
      spec: {
        type: string
        selector: Record<string, string>
        ports: Array<{ port: number }>
      }
    }>(`get svc ${MCP_SERVER_NAME} -n ${MCP_SERVER_NAMESPACE}`)

    expect(svc.metadata.name).toBe(MCP_SERVER_NAME)
    expect(svc.spec.type).toBe('ClusterIP')
    expect(svc.spec.selector.app).toBe('redis-mcp')
    expect(svc.spec.ports[0].port).toBe(3000)
    expect(svc.metadata.ownerReferences).toBeUndefined()
  })

  // E6.4: McpServer CRD created with managed: false and correct transport URL
  it('E6.4 — McpServer CRD created (managed: false, transport URL correct)', async () => {
    await waitForResource(`mcpservers.clerum.io ${MCP_SERVER_NAME}`, MCP_SERVER_NAMESPACE, {
      timeoutMs: 15_000,
    })

    const mcpServer = kubectlJson<{
      metadata: {
        name: string
        labels: Record<string, string>
        annotations?: Record<string, string>
        ownerReferences?: Array<{ kind: string; name: string; uid: string }>
      }
      spec: {
        managed: boolean
        contextRef: string
        transport: { type: string; url: string; port: number }
      }
    }>(`get mcpservers.clerum.io ${MCP_SERVER_NAME} -n ${MCP_SERVER_NAMESPACE}`)

    // Managed: false — HCC discovery-only, no Deployment creation
    expect(mcpServer.spec.managed).toBe(false)
    expect(mcpServer.spec.contextRef).toBe(CONTEXT_REF)

    // Transport URL matches Service DNS
    const expectedUrl = `http://${MCP_SERVER_NAME}.${MCP_SERVER_NAMESPACE}.svc.cluster.local:3000/mcp`
    expect(mcpServer.spec.transport.url).toBe(expectedUrl)
    expect(mcpServer.spec.transport.type).toBe('streamableHttp')
    expect(mcpServer.spec.transport.port).toBe(3000)

    // Labels
    expect(mcpServer.metadata.labels['clerum.io/managed-by']).toBe('workflow-recipes')
    expect(mcpServer.metadata.labels['clerum.io/recipe']).toBe(RECIPE_NAME)
    expect(mcpServer.metadata.labels['clerum.io/workload']).toBe('redis-mcp')

    // Cross-namespace rendered MCP resources are cleaned by WRC finalizers, not ownerRefs.
    expect(mcpServer.metadata.ownerReferences).toBeUndefined()

    // Binding annotations (mcp-redis-cache has bindings)
    expect(mcpServer.metadata.annotations?.['clerum.io/recipe-bindings']).toBeDefined()
    const bindings = JSON.parse(mcpServer.metadata.annotations!['clerum.io/recipe-bindings'])
    expect(bindings).toHaveLength(1)
    expect(bindings[0].from).toBe('redis-mcp')
    expect(bindings[0].to).toBe('redis')
  })

  // E6.5: Per-recipe Context CRD created — mcpServers[] includes the delegated server
  it('E6.5 — Per-recipe Context allowlist includes delegated server name', async () => {
    // Give reconciler time to patch the Context
    await sleep(3_000)

    const recipeContext = kubectlJson<{
      spec: { contextId: string; mcpServers?: string[] }
    }>(`get contexts.clerum.io ${RECIPE_CONTEXT_NAME} -n ${MCP_SERVER_NAMESPACE}`)

    expect(recipeContext.spec.contextId).toBe(RECIPE_CONTEXT_NAME)
    expect(recipeContext.spec.mcpServers).toBeDefined()
    expect(recipeContext.spec.mcpServers).toContain(MCP_SERVER_NAME)

    const sharedContext = kubectlJson<{
      spec: { mcpServers?: string[] }
    }>(`get contexts.clerum.io ${CONTEXT_REF} -n ${MCP_SERVER_NAMESPACE}`)

    expect(sharedContext.spec.mcpServers ?? []).not.toContain(MCP_SERVER_NAME)
  })

  // E6.6: Non-transport workload (redis) does NOT have its own McpServer CRD
  it('E6.6 — Non-transport workload has no McpServer CRD', () => {
    const nonTransportName = `${RECIPE_NAME}-redis`
    expect(() => {
      kubectl(`get mcpservers.clerum.io ${nonTransportName} -n ${MCP_SERVER_NAMESPACE}`)
    }).toThrow()
  })

  // E6.7: Delete recipe removes McpServer CRD
  it('E6.7 — Delete recipe removes McpServer CRD', { timeout: 90_000 }, async () => {
    // Delete the recipe
    const result = kubectl(`delete workflowrecipe ${RECIPE_NAME} -n ${RECIPE_NAMESPACE}`)
    expect(result).toContain('deleted')

    // Wait for McpServer CRD to be cleaned up
    await waitForResource(`mcpservers.clerum.io ${MCP_SERVER_NAME}`, MCP_SERVER_NAMESPACE, {
      shouldExist: false,
      timeoutMs: 60_000,
    })

    // Verify McpServer is gone
    expect(() => {
      kubectl(`get mcpservers.clerum.io ${MCP_SERVER_NAME} -n ${MCP_SERVER_NAMESPACE}`)
    }).toThrow()
  })

  // E6.8: Delete recipe removes the per-recipe Context allowlist.
  it('E6.8 — Per-recipe Context is removed after recipe deletion', async () => {
    // Give the reconciler time to delete the per-recipe Context
    await sleep(3_000)

    expect(() => {
      kubectl(`get contexts.clerum.io ${RECIPE_CONTEXT_NAME} -n ${MCP_SERVER_NAMESPACE}`)
    }).toThrow()
  })
})
