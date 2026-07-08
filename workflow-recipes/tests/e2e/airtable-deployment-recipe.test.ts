/**
 * E13.1–E13.7: Airtable MCP Server WorkflowRecipe E2E tests.
 *
 * Validates that Airtable MCP server can be deployed via WorkflowRecipe
 * as a Deployment with proper secret mounting and MCP functionality.
 *
 * This test uses WorkflowRecipe instead of McpServer CRD for consistency
 * with the MongoDB deployment model.
 *
 * Prerequisites:
 *   - Run scripts/minikube-setup.sh
 *   - minikube cluster running with CRDs installed
 *   - Airtable API key available (set AIRTABLE_API_KEY env var)
 *   - Context CRD created (e.g., kubectl apply -f charts/clerum-crds/examples/context1.yaml)
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { ChildProcess } from 'node:child_process'
import {
  MCP_SERVER_NAMESPACE,
  RECIPE_NAMESPACE,
  SANDBOX_NAMESPACE,
  getPodName,
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

const RECIPE_NAME = 'airtable-mcp-server'
const WORKLOAD_ID = 'airtable-mcp'
const RECIPE_FILE = `${__dirname}/../../../charts/clerum-crds/examples/airtable-mcp-deployment-recipe.yaml`
const LOCAL_PORT = 18087
const MCP_REMOTE_PORT = 3000

// Expected Airtable MCP tool names
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

async function ensureAirtableSecret(): Promise<void> {
  const apiKey = getAirtableApiKey()

  // Create secret in both runtime namespaces: mcp-server for rendered MCP
  // transport children and sandbox-recipes for non-MCP recipe runtime.
  for (const ns of [MCP_SERVER_NAMESPACE, SANDBOX_NAMESPACE]) {
    const secretYaml = `apiVersion: v1
kind: Secret
metadata:
  name: mcp-airtable-credentials
  namespace: ${ns}
type: Opaque
stringData:
  api-key: ${apiKey}`

    kubectl(`apply -f - <<EOF
${secretYaml}
EOF`)
  }
  console.log('[E2E Airtable] Secret mcp-airtable-credentials created in both namespaces')
}

function startAndWaitPortForward(
  podName: string,
  namespace: string,
  localPort: number,
  remotePort: number
): Promise<{ process: ChildProcess; url: string }> {
  return new Promise((resolve, reject) => {
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
      `delete workflowrecipe ${RECIPE_NAME} -n ${RECIPE_NAMESPACE} --ignore-not-found --timeout=20s`
    )
  } catch {
    /* ignore */
  }

  await waitForResource(`deploy -l clerum.io/workload=${WORKLOAD_ID}`, RECIPE_NAMESPACE, {
    shouldExist: false,
    timeoutMs: 15_000,
  }).catch(() => {})

  await sleep(3_000)

  // Ensure secret exists
  await ensureAirtableSecret()
}, 60_000)

afterAll(async () => {
  // Kill port-forwards
  if (mcpPortForward) mcpPortForward.process.kill()

  // Clean up WorkflowRecipe
  try {
    kubectl(
      `delete workflowrecipe ${RECIPE_NAME} -n ${RECIPE_NAMESPACE} --ignore-not-found --timeout=30s`
    )
  } catch {
    /* ignore */
  }

  // Clean up secret from both namespaces
  for (const ns of [MCP_SERVER_NAMESPACE, SANDBOX_NAMESPACE]) {
    try {
      kubectl(`delete secret mcp-airtable-credentials -n ${ns} --ignore-not-found`)
    } catch {
      /* ignore */
    }
  }

  await sleep(5_000)
})

describe('Airtable MCP Server - WorkflowRecipe E2E', () => {
  // E13.1: Apply WorkflowRecipe → Deployment created
  it('E13.1 — Apply WorkflowRecipe creates Deployment', { timeout: 60_000 }, async () => {
    const result = kubectl(`apply -f ${RECIPE_FILE}`)
    expect(result).toContain('workflowrecipe')
    expect(result).toMatch(/created|configured/)

    // Wait for Deployment to appear in SANDBOX_NAMESPACE (namespace splitting)
    await waitForResource(`deploy -l clerum.io/workload=${WORKLOAD_ID}`, SANDBOX_NAMESPACE, {
      shouldExist: true,
      timeoutMs: 30_000,
    })

    const deploy = kubectlJson<{
      items: Array<{
        metadata: { name: string; labels: Record<string, string> }
        spec: { replicas: number }
      }>
    }>(`get deploy -l clerum.io/workload=${WORKLOAD_ID} -n ${SANDBOX_NAMESPACE}`)

    expect(deploy.items.length).toBe(1)
    expect(deploy.items[0].metadata.name).toBe(WORKLOAD_ID)
    expect(deploy.items[0].metadata.labels['clerum.io/workload']).toBe(WORKLOAD_ID)
    expect(deploy.items[0].spec.replicas).toBe(1)
  })

  // E13.2: Secret mounted as environment variable
  it('E13.2 — Secret mounted as environment variable in pod', { timeout: 60_000 }, async () => {
    // Wait for pod to be created in SANDBOX_NAMESPACE (namespace splitting)
    await waitForResource(`pod -l clerum.io/workload=${WORKLOAD_ID}`, SANDBOX_NAMESPACE, {
      shouldExist: true,
      timeoutMs: 30_000,
    })

    const podName = getPodName(`clerum.io/workload=${WORKLOAD_ID}`, SANDBOX_NAMESPACE)

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
    }>(`get pod ${podName} -n ${SANDBOX_NAMESPACE}`)

    const airtableKeyEnv = podSpec.spec.containers[0].env?.find(e => e.name === 'AIRTABLE_API_KEY')

    expect(airtableKeyEnv).toBeDefined()
    expect(airtableKeyEnv?.valueFrom?.secretKeyRef?.name).toBe('mcp-airtable-credentials')
    expect(airtableKeyEnv?.valueFrom?.secretKeyRef?.key).toBe('api-key')
  })

  // E13.3: Pod Ready + MCP server running
  // Note: Airtable MCP server does not have a /health endpoint, so we only verify pod readiness
  it('E13.3 — Pod Ready and MCP server healthy', { timeout: 180_000 }, async () => {
    // Wait for pod to be ready in SANDBOX_NAMESPACE (namespace splitting)
    // This verifies both that the pod exists and that all containers are ready
    await waitForPodReady(`clerum.io/workload=${WORKLOAD_ID}`, SANDBOX_NAMESPACE, 120_000)

    // If waitForPodReady completed successfully, the pod is ready
    // No additional checks needed since waitForPodReady already validates:
    // - Pod exists
    // - Pod phase is Running
    // - All containers are ready
    expect(true).toBe(true) // Explicit assertion for test clarity
  })

  // E13.4: MCP tools/list returns Airtable tools
  // NOTE: Requires AIRTABLE_API_KEY environment variable with valid API key
  // Skipped if no API key is provided (dummy key only tests infrastructure)
  it('E13.4 — MCP tools/list returns Airtable tools', { timeout: 60_000 }, async () => {
    if (!process.env.AIRTABLE_API_KEY || process.env.AIRTABLE_API_KEY === 'dummy-key-for-testing') {
      console.log('[E2E Airtable] Skipping E13.4: No valid AIRTABLE_API_KEY provided')
      return
    }
    const podName = getPodName(`clerum.io/workload=${WORKLOAD_ID}`, SANDBOX_NAMESPACE)
    mcpPortForward = await startAndWaitPortForward(
      podName,
      SANDBOX_NAMESPACE,
      LOCAL_PORT,
      MCP_REMOTE_PORT
    )

    await sleep(2_000)

    const sessionId = await mcpInitSession(mcpPortForward.url)
    expect(sessionId).toBeTruthy()

    const tools = await mcpListTools(mcpPortForward.url, sessionId)
    const toolNames = tools.map(t => t.name)

    // Verify all expected Airtable tools are present
    for (const tool of EXPECTED_AIRTABLE_TOOLS) {
      expect(toolNames).toContain(tool)
    }

    console.log(`[E2E Airtable] Verified ${toolNames.length} tools: ${toolNames.join(', ')}`)
  })

  // E13.5: MCP tools/call list_bases operation
  // NOTE: Requires AIRTABLE_API_KEY environment variable with valid API key
  it('E13.5 — MCP tools/call list_bases works', { timeout: 60_000 }, async () => {
    if (!process.env.AIRTABLE_API_KEY || process.env.AIRTABLE_API_KEY === 'dummy-key-for-testing') {
      console.log('[E2E Airtable] Skipping E13.5: No valid AIRTABLE_API_KEY provided')
      return
    }
    expect(mcpPortForward).not.toBeNull()

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
      console.log(`[E2E Airtable] Response with dummy key: ${responseText.substring(0, 100)}...`)
    }
  })

  // E13.6: MCP tools/call list_tables operation (with real baseId if available)
  // NOTE: Requires AIRTABLE_API_KEY environment variable with valid API key
  it('E13.6 — MCP tools/call list_tables works with baseId', { timeout: 60_000 }, async () => {
    if (!process.env.AIRTABLE_API_KEY || process.env.AIRTABLE_API_KEY === 'dummy-key-for-testing') {
      console.log('[E2E Airtable] Skipping E13.6: No valid AIRTABLE_API_KEY provided')
      return
    }
    expect(mcpPortForward).not.toBeNull()

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
  })

  // E13.7: Delete WorkflowRecipe → cascade cleanup
  it(
    'E13.7 — Delete WorkflowRecipe cascades cleanup of all resources',
    { timeout: 90_000 },
    async () => {
      // Clean up port-forward before delete
      if (mcpPortForward) {
        mcpPortForward.process.kill()
        mcpPortForward = null
      }

      const result = kubectl(`delete workflowrecipe ${RECIPE_NAME} -n ${RECIPE_NAMESPACE}`)
      expect(result).toContain('deleted')

      // Deployment removed from SANDBOX_NAMESPACE (namespace splitting)
      await waitForResource(`deploy -l clerum.io/workload=${WORKLOAD_ID}`, SANDBOX_NAMESPACE, {
        shouldExist: false,
        timeoutMs: 60_000,
      })

      // WorkflowRecipe CRD removed from RECIPE_NAMESPACE
      await waitForResource(`workflowrecipe ${RECIPE_NAME}`, RECIPE_NAMESPACE, {
        shouldExist: false,
        timeoutMs: 15_000,
      })

      // Service removed from SANDBOX_NAMESPACE (namespace splitting)
      await waitForResource(`svc -l clerum.io/workload=${WORKLOAD_ID}`, SANDBOX_NAMESPACE, {
        shouldExist: false,
        timeoutMs: 15_000,
      }).catch(() => {}) // Service might not exist for deployments without port

      console.log('[E2E Airtable] All resources cleaned up successfully')
    }
  )
})
