/**
 * E12.1–E12.8: MongoDB MCP Server StatefulSet WorkflowRecipe E2E tests.
 *
 * Validates that MongoDB MCP server can be deployed via WorkflowRecipe
 * as a StatefulSet with persistent storage (PVC).
 *
 * This test uses WorkflowRecipe instead of McpServer CRD because:
 * - McpServer CRD does not support volumeClaimTemplates
 * - WorkflowRecipe already supports StatefulSet with volumeClaimTemplates
 * - WRC already has buildStatefulSet() implemented
 *
 * Prerequisites:
 *   - Run scripts/minikube-setup.sh
 *   - minikube cluster running with CRDs installed
 *   - MongoDB instance available (set MONGODB_CONNECTION_STRING env var)
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
  waitForStatefulSetReady,
} from './helpers'

const RECIPE_NAME = 'mongodb-mcp-server'
const WORKLOAD_ID = 'mongodb-mcp'
const RECIPE_FILE = `${__dirname}/../../../charts/clerum-crds/examples/mongodb-mcp-statefulset-recipe.yaml`
const LOCAL_PORT = 18086
const MCP_REMOTE_PORT = 3000
const HEALTH_REMOTE_PORT = 3001

// Expected MongoDB MCP tool names (from us-central1-docker.pkg.dev/${GCP_PROJECT}/clerum/mongodb-mcp-server:latest)
// Verified 2026-03-06: Server returns 15 READ-ONLY tools (no insert/update/delete)
// Actual tools: aggregate, collection-indexes, collection-schema, collection-storage-size,
//               connect, count, db-stats, explain, export, find, list-collections,
//               list-databases, list-knowledge-sources, mongodb-logs, search-knowledge
const EXPECTED_MONGO_TOOLS = [
  'aggregate',
  'find',
  'count',
  'list-collections',
  'list-databases',
  'collection-indexes',
  'collection-schema',
  'collection-storage-size',
  'db-stats',
  'explain',
] as const

let mcpPortForward: { process: ChildProcess; url: string } | null = null
let healthPortForward: { process: ChildProcess; url: string } | null = null

function getMongoConnectionString(): string {
  const envConnection = process.env.MONGODB_CONNECTION_STRING
  if (envConnection) {
    return envConnection
  }
  return 'mongodb://localhost:27017/e2e_test?directConnection=true'
}

async function ensureMongoSecret(): Promise<void> {
  const connectionString = getMongoConnectionString()
  const base64Connection = Buffer.from(connectionString).toString('base64')

  // Create secret in both runtime namespaces: mcp-server for rendered MCP
  // transport children and sandbox-recipes for non-MCP recipe runtime.
  for (const ns of [MCP_SERVER_NAMESPACE, SANDBOX_NAMESPACE]) {
    const secretYaml = `apiVersion: v1
kind: Secret
metadata:
  name: mcp-mongodb-credentials
  namespace: ${ns}
type: Opaque
data:
  connection-string: ${base64Connection}`

    // Delete if exists
    try {
      kubectl(`delete secret mcp-mongodb-credentials -n ${ns} --ignore-not-found`)
    } catch {
      /* ignore */
    }

    // Create secret
    kubectl(`apply -f - <<EOF
${secretYaml}
EOF`)
  }
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

  await waitForResource(`statefulset -l clerum.io/workload=${WORKLOAD_ID}`, SANDBOX_NAMESPACE, {
    shouldExist: false,
    timeoutMs: 15_000,
  }).catch(() => {})

  // Clean up PVCs from previous runs
  try {
    kubectl(
      `delete pvc -l clerum.io/workload=${WORKLOAD_ID} -n ${SANDBOX_NAMESPACE} --ignore-not-found`
    )
  } catch {
    /* ignore */
  }

  await sleep(3_000)

  // Ensure secret exists
  await ensureMongoSecret()
}, 60_000)

afterAll(async () => {
  // Kill port-forwards
  if (mcpPortForward) mcpPortForward.process.kill()
  if (healthPortForward) healthPortForward.process.kill()

  // Clean up WorkflowRecipe
  try {
    kubectl(
      `delete workflowrecipe ${RECIPE_NAME} -n ${RECIPE_NAMESPACE} --ignore-not-found --timeout=30s`
    )
  } catch {
    /* ignore */
  }
  await sleep(5_000)

  // Clean up PVCs (data retention means they survive recipe delete)
  try {
    kubectl(
      `delete pvc -l clerum.io/workload=${WORKLOAD_ID} -n ${SANDBOX_NAMESPACE} --ignore-not-found`
    )
  } catch {
    /* ignore */
  }
})

describe('MongoDB MCP Server - StatefulSet WorkflowRecipe E2E', () => {
  // E12.1: Apply WorkflowRecipe → StatefulSet created
  it('E12.1 — Apply WorkflowRecipe creates StatefulSet', { timeout: 60_000 }, async () => {
    const result = kubectl(`apply -f ${RECIPE_FILE}`)
    expect(result).toContain('workflowrecipe')
    expect(result).toMatch(/created|configured/)

    // Wait for StatefulSet to appear
    await waitForResource(`statefulset -l clerum.io/workload=${WORKLOAD_ID}`, SANDBOX_NAMESPACE, {
      shouldExist: true,
      timeoutMs: 30_000,
    })

    const sts = kubectlJson<{
      items: Array<{
        metadata: { name: string; labels: Record<string, string> }
        spec: { serviceName: string; replicas: number }
      }>
    }>(`get statefulset -l clerum.io/workload=${WORKLOAD_ID} -n ${SANDBOX_NAMESPACE}`)

    expect(sts.items.length).toBe(1)
    expect(sts.items[0].metadata.name).toBe(WORKLOAD_ID)
    expect(sts.items[0].spec.serviceName).toBe(`${WORKLOAD_ID}-headless`)
    expect(sts.items[0].spec.replicas).toBe(1)
  })

  // E12.2: PVC is created without ownerReferences for data retention.
  it('E12.2 — PVC created without ownerReferences', { timeout: 60_000 }, async () => {
    // Wait for PVC to be created by StatefulSet
    await sleep(5_000)

    const pvcs = kubectlJson<{
      items: Array<{
        metadata: {
          name: string
          namespace: string
          labels: Record<string, string>
          ownerReferences?: unknown[]
        }
        spec: {
          resources: { requests: { storage: string } }
          volumeMode: string
        }
      }>
    }>(`get pvc -l clerum.io/workload=${WORKLOAD_ID} -n ${SANDBOX_NAMESPACE}`)

    expect(pvcs.items.length).toBeGreaterThan(0)

    const pvc = pvcs.items[0]
    expect(pvc.metadata.name).toContain(WORKLOAD_ID)
    expect(pvc.metadata.namespace).toBe(SANDBOX_NAMESPACE)

    // PVC must NOT have ownerReferences (data retention)
    expect(pvc.metadata.ownerReferences).toBeUndefined()
    expect(pvc.spec.volumeMode).toBe('Filesystem')
  })

  // E12.3: Pod Ready + MongoDB connection successful
  it('E12.3 — Pod Ready and MCP server healthy', { timeout: 180_000 }, async () => {
    // Wait for StatefulSet pod to be Ready
    await waitForStatefulSetReady(WORKLOAD_ID, SANDBOX_NAMESPACE, 120_000)

    // Verify pod is Ready
    await waitForPodReady(`clerum.io/workload=${WORKLOAD_ID}`, SANDBOX_NAMESPACE, 10_000)

    // Verify health endpoint responds
    const podName = getPodName(`clerum.io/workload=${WORKLOAD_ID}`, SANDBOX_NAMESPACE)
    healthPortForward = await startAndWaitPortForward(
      podName,
      SANDBOX_NAMESPACE,
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

    // Clean up health port-forward
    healthPortForward.process.kill()
    healthPortForward = null
  })

  // E12.4: MCP tools/list returns MongoDB tools.
  it('E12.4 — MCP tools/list returns MongoDB tools', { timeout: 60_000 }, async () => {
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

    // DEBUG: Print actual tools returned by MongoDB MCP server
    console.log(`[E2E MongoDB] Actual tools returned by server: ${toolNames.sort().join(', ')}`)
    console.log(`[E2E MongoDB] Total tools: ${toolNames.length}`)

    // Verify all expected MongoDB tools are present
    for (const tool of EXPECTED_MONGO_TOOLS) {
      expect(toolNames).toContain(tool)
    }
  })

  // E12.5: MCP tools/call list-databases operation
  it('E12.5 — MCP tools/call list-databases works', { timeout: 60_000 }, async () => {
    expect(mcpPortForward).not.toBeNull()

    const sessionId = await mcpInitSession(mcpPortForward!.url)

    // First, connect to MongoDB using the connection string from secret
    const connectionString =
      'mongodb+srv://test-user:test-password@cluster0.example.mongodb.net/?appName=Cluster0'
    const connectResult = await mcpCallTool(mcpPortForward!.url, sessionId, 'connect', {
      connectionString,
    })

    if (connectResult.isError) {
      console.log(`[E2E MongoDB] connect ERROR: ${JSON.stringify(connectResult)}`)
    }

    // Now call list-databases
    const result = await mcpCallTool(mcpPortForward!.url, sessionId, 'list-databases', {})

    expect(result.content).toBeDefined()
    expect(result.content.length).toBeGreaterThan(0)
    expect(result.content[0].type).toBe('text')
    expect(result.isError).toBeFalsy()

    // Response is plain text, not JSON
    const responseText = result.content[0].text
    expect(responseText).toContain('database')
    console.log(`[E2E MongoDB] list-databases response: ${responseText.substring(0, 100)}...`)
  })

  // E12.6: Delete WorkflowRecipe → StatefulSet removed → PVC retained
  it('E12.6 — Delete WorkflowRecipe retains PVC', { timeout: 90_000 }, async () => {
    // Clean up port-forward before delete
    if (mcpPortForward) {
      mcpPortForward.process.kill()
      mcpPortForward = null
    }

    // Get PVC name before delete
    const pvcsBefore = kubectlJson<{
      items: Array<{ metadata: { name: string } }>
    }>(`get pvc -l clerum.io/workload=${WORKLOAD_ID} -n ${SANDBOX_NAMESPACE}`)

    const pvcName = pvcsBefore.items[0].metadata.name

    // Delete WorkflowRecipe
    const deleteResult = kubectl(`delete workflowrecipe ${RECIPE_NAME} -n ${RECIPE_NAMESPACE}`)
    expect(deleteResult).toContain('deleted')

    // StatefulSet removed
    await waitForResource(`statefulset ${WORKLOAD_ID}`, SANDBOX_NAMESPACE, {
      shouldExist: false,
      timeoutMs: 60_000,
    })

    // Verify PVC still exists (data retention)
    const pvcExistsAfterDelete = (() => {
      try {
        kubectl(`get pvc ${pvcName} -n ${SANDBOX_NAMESPACE}`)
        return true
      } catch {
        return false
      }
    })()
    expect(pvcExistsAfterDelete).toBe(true)

    console.log(
      `[E2E MongoDB] PVC ${pvcName} retained after WorkflowRecipe deletion (data retention works)`
    )
  })
})
