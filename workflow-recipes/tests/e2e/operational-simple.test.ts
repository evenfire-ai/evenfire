/**
 * E9.1–E9.7: Simple MCP operational lifecycle E2E tests.
 *
 * Validates the FULL operational lifecycle of a simple MCP workload:
 * apply recipe → pod Ready → health endpoint → MCP tools/list →
 * MCP tools/call (echo) → delete → cascade cleanup.
 *
 * Unlike structural tests (simple-recipe, lifecycle), these tests verify
 * that workloads actually FUNCTION — not just that K8s resources exist.
 *
 * Prerequisites:
 *   - Run scripts/minikube-setup.sh (builds clerum/mock-mcp-server:test image)
 *   - minikube cluster running with CRDs installed
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { ChildProcess } from 'node:child_process'
import {
  MCP_SERVER_NAMESPACE,
  RECIPE_NAMESPACE,
  fetchJson,
  kubectl,
  kubectlJson,
  mcpCallTool,
  mcpInitSession,
  mcpListTools,
  sleep,
  startPortForward,
  waitForPodReady,
  waitForResource,
} from './helpers'

const RECIPE_NAME = 'mock-mcp-echo'
const RECIPE_FILE = `${__dirname}/../../samples/mock-mcp-echo.yaml`
const LOCAL_PORT = 18084
const MCP_REMOTE_PORT = 3000
const HEALTH_REMOTE_PORT = 3001

let mcpPortForward: { process: ChildProcess; url: string } | null = null
let healthPortForward: { process: ChildProcess; url: string } | null = null

beforeAll(async () => {
  // Clean up leftovers from previous runs
  try {
    kubectl(
      `delete workflowrecipe ${RECIPE_NAME} -n ${RECIPE_NAMESPACE} --ignore-not-found --timeout=20s`
    )
  } catch {
    /* ignore */
  }
  await waitForResource(`deploy -l clerum.io/recipe=${RECIPE_NAME}`, MCP_SERVER_NAMESPACE, {
    shouldExist: false,
    timeoutMs: 15_000,
  }).catch(() => {})
}, 30_000)

afterAll(async () => {
  // Kill port-forwards
  if (mcpPortForward) mcpPortForward.process.kill()
  if (healthPortForward) healthPortForward.process.kill()

  // Clean up recipe
  try {
    kubectl(
      `delete workflowrecipe ${RECIPE_NAME} -n ${RECIPE_NAMESPACE} --ignore-not-found --timeout=30s`
    )
  } catch {
    /* ignore */
  }
  await sleep(5_000)
})

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
    // Find the pod name first
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

describe('Simple MCP Operational Lifecycle E2E', () => {
  // E9.1: Apply mock-mcp-echo recipe
  it('E9.1 — Apply mock-mcp-echo recipe', () => {
    const result = kubectl(`apply -f ${RECIPE_FILE}`)
    expect(result).toContain('workflowrecipe')
    expect(result).toMatch(/created|configured/)
  })

  // E9.2: Deployment and McpServer CRD created
  it('E9.2 — Deployment and McpServer CRD created', { timeout: 60_000 }, async () => {
    // MCP workload (has transport) → mcp-server namespace
    // Pre-deploy handshake (Option C) adds up to 30s before Deployment creation
    await waitForResource(`deploy -l clerum.io/recipe=${RECIPE_NAME}`, MCP_SERVER_NAMESPACE, {
      timeoutMs: 60_000,
    })

    const deploys = kubectlJson<{
      items: Array<{ metadata: { name: string; labels: Record<string, string> } }>
    }>(`get deploy -l clerum.io/recipe=${RECIPE_NAME} -n ${MCP_SERVER_NAMESPACE}`)

    expect(deploys.items.length).toBe(1)
    expect(deploys.items[0].metadata.name).toBe('echo-server')
    expect(deploys.items[0].metadata.labels['clerum.io/workload']).toBe('echo-server')

    // McpServer CRD should be created for transport workloads
    await waitForResource(`mcpserver -l clerum.io/recipe=${RECIPE_NAME}`, MCP_SERVER_NAMESPACE, {
      timeoutMs: 15_000,
    })
  })

  // E9.3: Pod reaches Ready state
  it('E9.3 — Pod reaches Ready state', { timeout: 180_000 }, async () => {
    await waitForPodReady('clerum.io/workload=echo-server', MCP_SERVER_NAMESPACE, 120_000)
  })

  // E9.4: Health endpoint responds
  it('E9.4 — Health endpoint responds with tool list', { timeout: 60_000 }, async () => {
    // Port-forward to health port (3001)
    healthPortForward = await startAndWaitPortForward(
      'clerum.io/workload=echo-server',
      MCP_SERVER_NAMESPACE,
      LOCAL_PORT + 1000, // 19084 for health
      HEALTH_REMOTE_PORT
    )

    // Wait for health endpoint (allow extra time for port-forward stabilization)
    await sleep(3_000)
    const start = Date.now()
    let healthy = false
    while (Date.now() - start < 30_000) {
      try {
        const { status, data } = await fetchJson(`${healthPortForward.url}/health`)
        if (status === 200) {
          const body = data as { status: string; tools: string[] }
          expect(body.status).toBe('ok')
          expect(body.tools).toContain('echo')
          expect(body.tools).toContain('add')
          healthy = true
          break
        }
      } catch {
        /* not ready */
      }
      await sleep(1_000)
    }
    expect(healthy).toBe(true)

    // Clean up health port-forward (no longer needed)
    healthPortForward.process.kill()
    healthPortForward = null
  })

  // E9.5: MCP tools/list returns echo and add
  it('E9.5 — MCP tools/list returns echo and add tools', { timeout: 60_000 }, async () => {
    mcpPortForward = await startAndWaitPortForward(
      'clerum.io/workload=echo-server',
      MCP_SERVER_NAMESPACE,
      LOCAL_PORT,
      MCP_REMOTE_PORT
    )

    // Give port-forward a moment to stabilize
    await sleep(2_000)

    const sessionId = await mcpInitSession(mcpPortForward.url)
    expect(sessionId).toBeTruthy()

    const tools = await mcpListTools(mcpPortForward.url, sessionId)
    const toolNames = tools.map(t => t.name)
    expect(toolNames).toContain('echo')
    expect(toolNames).toContain('add')
  })

  // E9.6: MCP tools/call echo works
  it('E9.6 — MCP tools/call echo returns correct response', { timeout: 30_000 }, async () => {
    // Reuse existing port-forward and create fresh session
    expect(mcpPortForward).not.toBeNull()

    const sessionId = await mcpInitSession(mcpPortForward!.url)
    const result = await mcpCallTool(mcpPortForward!.url, sessionId, 'echo', {
      text: 'hello from e2e',
    })

    expect(result.content).toHaveLength(1)
    expect(result.content[0].type).toBe('text')
    expect(result.content[0].text).toBe('Echo: hello from e2e')
    expect(result.isError).toBeFalsy()

    // Also test the add tool
    const addResult = await mcpCallTool(mcpPortForward!.url, sessionId, 'add', { a: 17, b: 25 })
    expect(addResult.content[0].text).toBe('42')

    // Clean up port-forward
    mcpPortForward!.process.kill()
    mcpPortForward = null
  })

  // E9.7: Delete recipe → cascade cleanup
  it('E9.7 — Delete recipe cascades cleanup of all resources', { timeout: 90_000 }, async () => {
    const result = kubectl(`delete workflowrecipe ${RECIPE_NAME} -n ${RECIPE_NAMESPACE}`)
    expect(result).toContain('deleted')

    // Deployment removed
    await waitForResource(`deploy -l clerum.io/recipe=${RECIPE_NAME}`, MCP_SERVER_NAMESPACE, {
      shouldExist: false,
      timeoutMs: 60_000,
    })

    // McpServer CRD removed
    await waitForResource(`mcpserver -l clerum.io/recipe=${RECIPE_NAME}`, MCP_SERVER_NAMESPACE, {
      shouldExist: false,
      timeoutMs: 15_000,
    })

    // Service removed
    await waitForResource(`svc -l clerum.io/recipe=${RECIPE_NAME}`, MCP_SERVER_NAMESPACE, {
      shouldExist: false,
      timeoutMs: 15_000,
    })
  })
})
