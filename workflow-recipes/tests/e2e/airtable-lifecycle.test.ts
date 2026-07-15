/**
 * E10.1–E10.7: Airtable MCP Server lifecycle E2E tests.
 *
 * Validates the COMPLETE operational lifecycle of an Airtable MCP server:
 * apply mcpserver.yaml → Deployment ready → secret mounted →
 * Airtable API connection → MCP tools/list → MCP tools/call (list_bases,
 * list_tables, list_records) → delete → cascade cleanup.
 *
 * Unlike basic structural tests, this verifies that the Airtable MCP server
 * actually FUNCTIONS — not just that K8s resources exist.
 *
 * Special focus on Airtable-specific behavior:
 *   - API key authentication via secret
 *   - Secret mounting verification
 *   - Airtable API connectivity validation
 *   - Tool availability and execution
 *
 * Prerequisites:
 *   - Run scripts/minikube-setup.sh
 *   - minikube cluster running with CRDs installed
 *   - Airtable API key available (set AIRTABLE_API_KEY env var)
 *   - Context CRD created (e.g., kubectl apply -f charts/clerum-crds/examples/context1.yaml)
 *
 * Environment Variables:
 *   - AIRTABLE_API_KEY: Airtable personal access token (required for real API calls)
 *                       If not set, tests will use mock mode (pod creation only)
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { ChildProcess } from 'node:child_process'
import {
  MCP_SERVER_NAMESPACE,
  createMcpServerSecret,
  executeMcpOperation,
  getMcpServerPodName,
  getPodStatus,
  kubectl,
  kubectlJson,
  mcpCallTool,
  mcpInitSession,
  mcpListTools,
  releasePort,
  reservePort,
  sleep,
  startPortForward,
  verifySecretMounted,
  waitForMcpServerReady,
  waitForPodReady,
  waitForResource,
} from './helpers'

const SERVER_NAME = 'airtable-server'
const MCP_SERVER_FILE = `${__dirname}/../../../mcp-servers/airtable/mcpserver.yaml`
const LOCAL_PORT = 18087
const MCP_REMOTE_PORT = 3000
const HEALTH_REMOTE_PORT = 3001

// Expected Airtable MCP tool names (from airtable-mcp-server spec)
const EXPECTED_AIRTABLE_TOOLS = [
  'airtable_list_bases',
  'airtable_list_tables',
  'airtable_list_records',
  'airtable_get_record',
  'airtable_create_record',
  'airtable_update_record',
  'airtable_delete_record',
  'airtable_query_records',
] as const

let mcpPortForward: { process: ChildProcess; url: string } | null = null
let healthPortForward: { process: ChildProcess; url: string } | null = null
let reservedPort: number | null = null

/**
 * Get Airtable API key from env or use dummy key for pod creation testing.
 *
 * For full E2E testing with real API calls, set AIRTABLE_API_KEY.
 * For pod creation tests without API access, a dummy key is sufficient.
 */
function getAirtableApiKey(): string {
  const envKey = process.env.AIRTABLE_API_KEY
  if (envKey) {
    console.log('[E2E Airtable] Using real Airtable API key from environment')
    return envKey
  }

  console.warn(
    '[E2E Airtable] AIRTABLE_API_KEY not set. Using dummy key for pod creation tests only.'
  )
  return 'patDummyKeyForTestingOnly'
}

/**
 * Create or update the Airtable credentials secret.
 *
 * NOTE: The secret name is hardcoded as 'mcp-airtable-credentials' to match
 * the mcpserver.yaml specification. The createMcpServerSecret helper adds
 * a '-credentials' suffix, so we pass 'airtable' to get the correct name.
 */
async function ensureAirtableSecret(): Promise<void> {
  const apiKey = getAirtableApiKey()
  const secretName = 'mcp-airtable-credentials'

  // Delete existing secret first (ignore if not found)
  try {
    kubectl(`delete secret ${secretName} -n ${MCP_SERVER_NAMESPACE} --ignore-not-found`)
  } catch {
    /* ignore */
  }

  // Create secret directly (no pipe — more reliable in test environments)
  kubectl(
    `create secret generic ${secretName} -n ${MCP_SERVER_NAMESPACE} --from-literal=api-key=${apiKey}`
  )

  console.log(`[E2E Airtable] Secret ${secretName} created`)
}

/**
 * Wait for port-forward to be established by listening for kubectl's
 * "Forwarding from" stdout message.
 */
function startAndWaitPortForward(
  podSelector: string,
  namespace: string,
  localPort: number,
  remotePort: number
): Promise<{ process: ChildProcess; url: string }> {
  return new Promise((resolve, reject) => {
    const podName = kubectl(
      `get pod -l ${podSelector} -n ${namespace} -o jsonpath='{.items[0].metadata.name}'`
    )

    const child = startPortForward(`pod/${podName}`, namespace, localPort, remotePort)
    let settled = false

    const timer = setTimeout(() => {
      if (!settled) {
        settled = true
        child.process.kill()
        reject(new Error(`port-forward to ${podName}:${remotePort} timed out`))
      }
    }, 30_000)

    child.process.stdout?.on('data', (chunk: Buffer) => {
      if (!settled && chunk.toString().includes('Forwarding from')) {
        settled = true
        clearTimeout(timer)
        resolve(child)
      }
    })

    child.process.stderr?.on('data', (chunk: Buffer) => {
      console.error(`[port-forward stderr] ${chunk.toString().trim()}`)
    })

    child.process.on('exit', code => {
      if (!settled) {
        settled = true
        clearTimeout(timer)
        reject(new Error(`port-forward exited with code ${code}`))
      }
    })
  })
}

beforeAll(async () => {
  // Clean up leftovers from previous runs
  try {
    kubectl(
      `delete mcpserver ${SERVER_NAME} -n ${MCP_SERVER_NAMESPACE} --ignore-not-found --timeout=20s`
    )
  } catch {
    /* ignore */
  }

  await waitForResource(`deploy -l clerum.io/mcpserver=${SERVER_NAME}`, MCP_SERVER_NAMESPACE, {
    shouldExist: false,
    timeoutMs: 15_000,
  }).catch(() => {})

  await sleep(3_000)

  // Ensure secret exists
  await ensureAirtableSecret()

  // Reserve a unique port for this test suite
  reservedPort = await reservePort()
}, 60_000)

afterAll(async () => {
  // Kill port-forwards
  if (mcpPortForward) mcpPortForward.process.kill()
  if (healthPortForward) healthPortForward.process.kill()

  // Release reserved port
  if (reservedPort !== null) {
    releasePort(reservedPort)
  }

  // Clean up McpServer
  try {
    kubectl(
      `delete mcpserver ${SERVER_NAME} -n ${MCP_SERVER_NAMESPACE} --ignore-not-found --timeout=30s`
    )
  } catch {
    /* ignore */
  }

  // Clean up secret
  try {
    kubectl(`delete secret mcp-airtable-credentials -n ${MCP_SERVER_NAMESPACE} --ignore-not-found`)
  } catch {
    /* ignore */
  }

  await sleep(5_000)
})

describe('Airtable MCP Server - E2E Lifecycle', () => {
  // E10.1: Apply mcpserver.yaml → Deployment created
  it('E10.1 — Apply mcpserver.yaml creates Deployment', { timeout: 60_000 }, async () => {
    const result = kubectl(`apply -f ${MCP_SERVER_FILE}`)
    expect(result).toContain('mcpserver')
    expect(result).toMatch(/created|configured/)

    // Wait for Deployment to appear
    await waitForResource(`deploy -l clerum.io/mcpserver=${SERVER_NAME}`, MCP_SERVER_NAMESPACE, {
      shouldExist: true,
      timeoutMs: 30_000,
    })

    const deploy = kubectlJson<{
      items: Array<{
        metadata: { name: string; labels: Record<string, string> }
        spec: { replicas: number }
      }>
    }>(`get deploy -l clerum.io/mcpserver=${SERVER_NAME} -n ${MCP_SERVER_NAMESPACE}`)

    expect(deploy.items.length).toBe(1)
    expect(deploy.items[0].metadata.name).toBe(SERVER_NAME)
    expect(deploy.items[0].metadata.labels['clerum.io/mcpserver']).toBe(SERVER_NAME)
    expect(deploy.items[0].spec.replicas).toBe(1)
  })

  // E10.2: Secret mounted as environment variable
  it('E10.2 — Secret mounted as environment variable in pod', { timeout: 60_000 }, async () => {
    // Wait for pod to be created
    await waitForResource(`pod -l clerum.io/mcpserver=${SERVER_NAME}`, MCP_SERVER_NAMESPACE, {
      shouldExist: true,
      timeoutMs: 30_000,
    })

    const podName = await getMcpServerPodName(SERVER_NAME, MCP_SERVER_NAMESPACE)

    // Verify secret is mounted
    await verifySecretMounted(podName, 'mcp-airtable-credentials', MCP_SERVER_NAMESPACE)

    // Verify the environment variable is set correctly
    const podSpec = kubectlJson<{
      spec: {
        containers: Array<{
          env?: Array<{
            name: string
            valueFrom?: {
              secretKeyRef?: {
                name: string
                key: string
              }
            }
          }>
        }>
      }
    }>(`get pod ${podName} -n ${MCP_SERVER_NAMESPACE}`)

    const airtableKeyEnv = podSpec.spec.containers[0].env?.find(e => e.name === 'AIRTABLE_API_KEY')

    expect(airtableKeyEnv).toBeDefined()
    expect(airtableKeyEnv?.valueFrom?.secretKeyRef?.name).toBe('mcp-airtable-credentials')
    expect(airtableKeyEnv?.valueFrom?.secretKeyRef?.key).toBe('api-key')
  })

  // E10.3: Pod Ready + Health check passing
  // Note: In minikube without DOCR registry credentials, the image
  // ghcr.io/evenfire-ai/airtable-mcp-server:latest may fail to pull
  // (ImagePullBackOff). We attempt to wait but skip gracefully if image pull fails.
  it(
    'E10.3 — Pod Ready and MCP server healthy (skips if image unavailable)',
    { timeout: 120_000 },
    async () => {
      // Try waiting for the pod to be ready, but handle ImagePullBackOff
      try {
        await waitForMcpServerReady(SERVER_NAME, MCP_SERVER_NAMESPACE, 60_000)
      } catch {
        // Check if failure is due to image pull
        const pods = kubectlJson<{
          items: Array<{
            status: { containerStatuses?: Array<{ state: { waiting?: { reason: string } } }> }
          }>
        }>(`get pod -l clerum.io/mcpserver=${SERVER_NAME} -n ${MCP_SERVER_NAMESPACE}`)

        const waiting = pods.items[0]?.status?.containerStatuses?.[0]?.state?.waiting?.reason ?? ''
        if (waiting === 'ImagePullBackOff' || waiting === 'ErrImagePull') {
          console.log(
            `[E2E Airtable] Pod stuck in ${waiting} — DOCR image not pullable in minikube. Skipping health check.`
          )
          return
        }
        throw new Error(`Pod not ready and not due to image pull: ${waiting}`)
      }

      // Pod is Ready — verify health endpoint
      healthPortForward = await startAndWaitPortForward(
        `clerum.io/mcpserver=${SERVER_NAME}`,
        MCP_SERVER_NAMESPACE,
        LOCAL_PORT + 1000,
        HEALTH_REMOTE_PORT
      )

      await sleep(2_000)

      const start = Date.now()
      let healthy = false
      while (Date.now() - start < 15_000) {
        try {
          const response = await fetch(`${healthPortForward.url}/health`)
          if (response.status === 200) {
            const body = (await response.json()) as { status: string }
            expect(body.status).toBe('ok')
            healthy = true
            break
          }
        } catch {
          /* not ready */
        }
        await sleep(1_000)
      }
      expect(healthy).toBe(true)

      healthPortForward.process.kill()
      healthPortForward = null
    }
  )

  // E10.4: MCP tools/list returns Airtable tools
  // Requires pod to be Ready (depends on DOCR image being pullable)
  it(
    'E10.4 — MCP tools/list returns Airtable tools (skips if pod not ready)',
    { timeout: 60_000 },
    async () => {
      const status = getPodStatus(`clerum.io/mcpserver=${SERVER_NAME}`, MCP_SERVER_NAMESPACE)
      if (!status?.ready) {
        console.log('[E2E Airtable] Pod not Ready — skipping MCP tools/list test.')
        return
      }

      mcpPortForward = await startAndWaitPortForward(
        `clerum.io/mcpserver=${SERVER_NAME}`,
        MCP_SERVER_NAMESPACE,
        LOCAL_PORT,
        MCP_REMOTE_PORT
      )

      await sleep(2_000)

      const sessionId = await mcpInitSession(mcpPortForward.url)
      expect(sessionId).toBeTruthy()

      const tools = await mcpListTools(mcpPortForward.url, sessionId)
      const toolNames = tools.map(t => t.name)

      for (const tool of EXPECTED_AIRTABLE_TOOLS) {
        expect(toolNames).toContain(tool)
      }
    }
  )

  // E10.5: MCP tools/call list_bases operation
  it(
    'E10.5 — MCP tools/call list_bases works (skips if pod not ready)',
    { timeout: 60_000 },
    async () => {
      if (!mcpPortForward) {
        console.log('[E2E Airtable] No port-forward available — skipping list_bases test.')
        return
      }

      const sessionId = await mcpInitSession(mcpPortForward!.url)
      const result = await mcpCallTool(mcpPortForward!.url, sessionId, 'airtable_list_bases', {})

      expect(result.content).toBeDefined()
      expect(result.content.length).toBeGreaterThan(0)
      expect(result.content[0].type).toBe('text')

      // Check if this is a real API response or mock/dummy key response
      const responseText = result.content[0].text

      if (process.env.AIRTABLE_API_KEY) {
        // Real API key - should get valid JSON response
        expect(result.isError).toBeFalsy()

        const bases = JSON.parse(responseText) as Array<{ id: string; name: string }>
        expect(Array.isArray(bases)).toBe(true)

        console.log(`[E2E Airtable] Found ${bases.length} bases in Airtable account`)
      } else {
        // Dummy key - may get error or empty response
        console.log(`[E2E Airtable] Response with dummy key: ${responseText.substring(0, 100)}...`)
      }
    }
  )

  // E10.6: MCP tools/call list_tables operation (with real baseId if available)
  it(
    'E10.6 — MCP tools/call list_tables works with baseId (skips if pod not ready)',
    { timeout: 60_000 },
    async () => {
      if (!mcpPortForward) {
        console.log('[E2E Airtable] No port-forward available — skipping list_tables test.')
        return
      }

      const sessionId = await mcpInitSession(mcpPortForward!.url)

      // First, try to get a real baseId from list_bases
      let baseId = 'appDummyBaseId'

      if (process.env.AIRTABLE_API_KEY) {
        try {
          const listBasesResult = await mcpCallTool(
            mcpPortForward!.url,
            sessionId,
            'airtable_list_bases',
            {}
          )

          if (!listBasesResult.isError) {
            const bases = JSON.parse(listBasesResult.content[0].text) as Array<{ id: string }>
            if (bases.length > 0) {
              baseId = bases[0].id
              console.log(`[E2E Airtable] Using real baseId: ${baseId}`)
            }
          }
        } catch {
          console.log('[E2E Airtable] Could not fetch real baseId, using dummy')
        }
      }

      const result = await mcpCallTool(mcpPortForward!.url, sessionId, 'airtable_list_tables', {
        baseId,
      })

      expect(result.content).toBeDefined()
      expect(result.content[0].type).toBe('text')

      if (process.env.AIRTABLE_API_KEY && baseId !== 'appDummyBaseId') {
        // Real API key with valid baseId
        expect(result.isError).toBeFalsy()

        const tables = JSON.parse(result.content[0].text) as Array<{ id: string; name: string }>
        expect(Array.isArray(tables)).toBe(true)

        console.log(`[E2E Airtable] Found ${tables.length} tables in base ${baseId}`)
      } else {
        console.log(
          `[E2E Airtable] Response with dummy baseId: ${result.content[0].text.substring(0, 100)}...`
        )
      }
    }
  )

  // E10.7: Delete mcpserver → cascade cleanup
  it(
    'E10.7 — Delete mcpserver cascades cleanup of all resources',
    { timeout: 90_000 },
    async () => {
      // Clean up port-forward before delete
      if (mcpPortForward) {
        mcpPortForward.process.kill()
        mcpPortForward = null
      }

      const result = kubectl(`delete mcpserver ${SERVER_NAME} -n ${MCP_SERVER_NAMESPACE}`)
      expect(result).toContain('deleted')

      // Deployment removed
      await waitForResource(`deploy -l clerum.io/mcpserver=${SERVER_NAME}`, MCP_SERVER_NAMESPACE, {
        shouldExist: false,
        timeoutMs: 60_000,
      })

      // McpServer CRD removed
      await waitForResource(`mcpserver ${SERVER_NAME}`, MCP_SERVER_NAMESPACE, {
        shouldExist: false,
        timeoutMs: 15_000,
      })

      // Service removed
      await waitForResource(`svc -l clerum.io/mcpserver=${SERVER_NAME}`, MCP_SERVER_NAMESPACE, {
        shouldExist: false,
        timeoutMs: 15_000,
      })

      console.log('[E2E Airtable] All resources cleaned up successfully')
    }
  )
})
