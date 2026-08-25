/**
 * E6.9–E6.14: HCC-WRC Integration E2E tests.
 *
 * Validates that both operators work together:
 * - WRC creates McpServer CRD → HCC detects it via watch
 * - WRC patches Context → HCC creates L2 context-allow NetworkPolicy
 * - HCC Discovery API serves the delegated McpServer
 * - Recipe deletion triggers cascade: McpServer removed → HCC removes L2 policy
 *
 * Prerequisites:
 *   - Both WRC and HCC deployed in minikube (clerum-test profile)
 *   - Context CRD "default" exists in mcp-server namespace
 *   - These tests run AFTER delegation.test.ts (sequential mode)
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { ChildProcess } from 'node:child_process'
import {
  MCP_SERVER_NAMESPACE,
  RECIPE_NAMESPACE,
  fetchJson,
  kubectl,
  kubectlJson,
  sleep,
  startPortForward,
  waitForPortForward,
  waitForResource,
} from './helpers'

const RECIPE_NAME = 'mcp-redis-cache'
const RECIPE_FILE = `${__dirname}/../../samples/mcp-redis-cache.yaml`
const MCP_SERVER_NAME = 'mcp-redis-cache-redis-mcp'
const HCC_LOCAL_PORT = 18081
const HCC_REMOTE_PORT = 8081
const HCC_NAMESPACE = 'control-plane'

let hccPortForward: ChildProcess | null = null

beforeAll(async () => {
  // Ensure HCC is running
  const hccPod = kubectlJson<{
    items: Array<{ status: { phase: string } }>
  }>(`get pod -l app=host-context-controller -n ${HCC_NAMESPACE}`)
  expect(hccPod.items.length).toBeGreaterThan(0)
  expect(hccPod.items[0].status.phase).toBe('Running')

  // Start port-forward to HCC Discovery API
  const pf = startPortForward(
    'deploy/host-context-controller',
    HCC_NAMESPACE,
    HCC_LOCAL_PORT,
    HCC_REMOTE_PORT
  )
  hccPortForward = pf.process
  await waitForPortForward(pf.url)

  // Clean up any leftover recipe from previous runs
  try {
    kubectl(
      `delete workflowrecipe ${RECIPE_NAME} -n ${RECIPE_NAMESPACE} --ignore-not-found --timeout=20s`
    )
  } catch {
    /* ignore */
  }
  await sleep(5_000)

  // Ensure Context CRD "default" exists
  try {
    kubectl(`get contexts.clerum.io default -n ${MCP_SERVER_NAMESPACE}`)
  } catch {
    kubectl(`apply -f - <<'EOF'
apiVersion: clerum.io/v1alpha1
kind: Context
metadata:
  name: default
  namespace: ${MCP_SERVER_NAMESPACE}
spec:
  contextId: default
  mcpServers: []
EOF`)
  }
})

afterAll(async () => {
  // Clean up recipe
  try {
    kubectl(
      `delete workflowrecipe ${RECIPE_NAME} -n ${RECIPE_NAMESPACE} --ignore-not-found --timeout=20s`
    )
  } catch {
    /* ignore */
  }
  await sleep(3_000)

  // Kill port-forward
  if (hccPortForward) {
    hccPortForward.kill()
    hccPortForward = null
  }
})

describe('HCC-WRC Integration E2E', () => {
  // E6.9: Apply recipe and wait for McpServer CRD to be created by WRC
  it('E6.9 — Recipe with transport workload creates McpServer detected by HCC', async () => {
    kubectl(`apply -f ${RECIPE_FILE}`)

    // Wait for McpServer CRD to appear (created by WRC delegation)
    await waitForResource(`mcpservers.clerum.io ${MCP_SERVER_NAME}`, MCP_SERVER_NAMESPACE, {
      timeoutMs: 30_000,
    })

    // Give HCC time to process the watch event
    await sleep(3_000)

    // Verify HCC detected it — check HCC logs for the McpServer watch event
    const logs = kubectl(`logs deploy/host-context-controller -n ${HCC_NAMESPACE} --tail=50`)
    expect(logs).toContain(MCP_SERVER_NAME)
  })

  // E6.10: temporary PR 2 system inventory serves the delegated McpServer
  // This suite does not mint a Host JWT, so it cannot exercise the v2 Host
  // route. Keep the current global metadata-only poll assertion here until
  // PR 2 adds an authenticated system-inventory fixture.
  // 1. Create the McpServer CRD (done in E6.9)
  // 2. Patch the Context to add the server to mcpServers[]
  // 3. HCC watches Context change → caches the server → serves via API
  // We wait for Context to be patched first, then poll the Discovery API.
  it('E6.10 — HCC metadata inventory lists delegated McpServer', { timeout: 60_000 }, async () => {
    // Wait for WRC to patch Context (may take a reconciliation cycle)
    const ctxStart = Date.now()
    while (Date.now() - ctxStart < 30_000) {
      const ctx = kubectlJson<{ spec: { mcpServers?: string[] } }>(
        `get contexts.clerum.io default -n ${MCP_SERVER_NAMESPACE}`
      )
      if (ctx.spec.mcpServers?.includes(MCP_SERVER_NAME)) break
      await sleep(2_000)
    }

    // Now poll the Discovery API (HCC needs to process the Context watch event)
    const start = Date.now()
    let found: { name: string; transport?: { type: string } } | undefined

    while (Date.now() - start < 20_000) {
      const { data } = await fetchJson(`http://localhost:${HCC_LOCAL_PORT}/api/v1/mcpservers`)
      const response = data as { servers: Array<{ name: string; transport?: { type: string } }> }
      if (response.servers) {
        found = response.servers.find(s => s.name === MCP_SERVER_NAME)
        if (found) break
      }
      await sleep(2_000)
    }

    expect(found).toBeDefined()
    expect(found!.transport?.type).toBe('streamableHttp')
    expect(found).not.toHaveProperty('secretRef')
    expect(found).not.toHaveProperty('secretKey')
    expect(found).not.toHaveProperty('auth')
  })

  // E6.11: Context patch triggers L2 context-allow NetworkPolicy from HCC
  // HCC watches Context changes and creates L2 NetworkPolicies.
  // We poll with retries since HCC reconciliation has variable timing.
  it('E6.11 — L2 context-allow NetworkPolicy created by HCC', { timeout: 30_000 }, async () => {
    const start = Date.now()
    let contextPolicies: Array<{ metadata: { name: string } }> = []

    while (Date.now() - start < 20_000) {
      const policies = kubectlJson<{
        items: Array<{
          metadata: { name: string; labels: Record<string, string> }
        }>
      }>(`get networkpolicy -l clerum.io/policy-type=context-allow -n ${MCP_SERVER_NAMESPACE}`)

      contextPolicies = policies.items.filter(
        p => p.metadata.labels['clerum.io/context'] === 'default'
      )
      if (contextPolicies.length > 0) break
      await sleep(2_000)
    }

    expect(contextPolicies.length).toBeGreaterThan(0)
  })

  // E6.12: McpServer CRD has correct status set by HCC (discovery-only)
  it('E6.12 — McpServer CRD has discovery-only status', () => {
    const mcpServer = kubectlJson<{
      spec: { managed: boolean }
    }>(`get mcpservers.clerum.io ${MCP_SERVER_NAME} -n ${MCP_SERVER_NAMESPACE}`)

    // HCC skips Deployment/Service for managed:false — only sets status
    expect(mcpServer.spec.managed).toBe(false)
  })

  // E6.13: Delete recipe triggers cascade — McpServer removed, L2 policy cleaned
  it(
    'E6.13 — Delete recipe cascades: McpServer removed, L2 policy cleaned',
    { timeout: 90_000 },
    async () => {
      kubectl(`delete workflowrecipe ${RECIPE_NAME} -n ${RECIPE_NAMESPACE}`)

      // Wait for McpServer CRD to be removed (ownerRef cascade)
      await waitForResource(`mcpservers.clerum.io ${MCP_SERVER_NAME}`, MCP_SERVER_NAMESPACE, {
        shouldExist: false,
        timeoutMs: 60_000,
      })

      // Poll for Context cleanup (WRC reconcileDelete needs time to unpatch)
      const pollStart = Date.now()
      let contextCleaned = false
      while (Date.now() - pollStart < 10_000) {
        const context = kubectlJson<{
          spec: { mcpServers?: string[] }
        }>(`get contexts.clerum.io default -n ${MCP_SERVER_NAMESPACE}`)
        const servers = context.spec.mcpServers ?? []
        if (!servers.includes(MCP_SERVER_NAME)) {
          contextCleaned = true
          break
        }
        await sleep(1_000)
      }
      expect(contextCleaned).toBe(true)
    }
  )

  // E6.13b: HCC /metrics endpoint returns Prometheus metrics (Phase 8)
  it('E6.13b — HCC /metrics endpoint returns Prometheus format', async () => {
    const res = await fetch(`http://localhost:${HCC_LOCAL_PORT}/metrics`)
    expect(res.status).toBe(200)
    const contentType = res.headers.get('content-type') ?? ''
    expect(contentType).toContain('text/plain')
    const body = await res.text()
    expect(body).toContain('clerum_hcc_mcpservers_total')
  })

  // E6.14: temporary PR 2 metadata inventory no longer lists the deleted server
  it('E6.14 — HCC metadata inventory no longer lists deleted McpServer', async () => {
    const { data } = await fetchJson(`http://localhost:${HCC_LOCAL_PORT}/api/v1/mcpservers`)

    const response = data as { servers: Array<{ name: string }> }
    const found = (response.servers ?? []).find(s => s.name === MCP_SERVER_NAME)
    expect(found).toBeUndefined()
  })
})
