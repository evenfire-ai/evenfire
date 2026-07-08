/**
 * E2E test helpers for WRC minikube tests.
 *
 * Provides kubectl wrapper, port-forward management, health checks,
 * and K8s resource polling utilities.
 */
import { ChildProcess, execSync, spawn } from 'node:child_process'

export const WRC_NAMESPACE = 'control-plane'
export const SANDBOX_NAMESPACE = 'sandbox-recipes'
export const WORKFLOW_RECIPE_NAMESPACE = SANDBOX_NAMESPACE
export const MCP_SERVER_NAMESPACE = 'mcp-server'
export const KUBE_CONTEXT = process.env.KUBECONTEXT ?? process.env.CONTEXT ?? 'clerum-test'
// Backward-compatible alias for recipe CRD tests. New code should prefer the
// explicit WORKFLOW_RECIPE_NAMESPACE name. MCP transport resources must use
// MCP_SERVER_NAMESPACE.
export const RECIPE_NAMESPACE = WORKFLOW_RECIPE_NAMESPACE

const ALLOWED_KUBE_CONTEXTS = (process.env.E2E_ALLOWED_CONTEXTS ?? 'minikube,clerum-test')
  .split(',')
  .map(context => context.trim())
  .filter(Boolean)

let kubeContextChecked = false

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`
}

function requireSafeKubeContext(): void {
  if (kubeContextChecked) return
  if (!ALLOWED_KUBE_CONTEXTS.includes(KUBE_CONTEXT)) {
    throw new Error(
      `Refusing to run workflow-recipes E2E against context "${KUBE_CONTEXT}". ` +
        `Allowed contexts: ${ALLOWED_KUBE_CONTEXTS.join(', ')}. ` +
        'Set E2E_ALLOWED_CONTEXTS only for an intentional gate.'
    )
  }
  kubeContextChecked = true
}

/** Run a kubectl command and return stdout. Throws on non-zero exit. */
export function kubectl(args: string): string {
  requireSafeKubeContext()
  return execSync(`kubectl --context=${shellQuote(KUBE_CONTEXT)} ${args}`, {
    encoding: 'utf-8',
    timeout: 30_000,
  }).trim()
}

/** Run kubectl and return parsed JSON output. */
export function kubectlJson<T = unknown>(args: string): T {
  const raw = kubectl(`${args} -o json`)
  return JSON.parse(raw) as T
}

/** Check if a CRD exists. */
export function crdExists(crdName: string): boolean {
  try {
    kubectl(`get crd ${crdName}`)
    return true
  } catch {
    return false
  }
}

/** Get pod status for a label selector in a namespace. */
export function getPodStatus(
  labelSelector: string,
  namespace: string
): { name: string; phase: string; ready: boolean } | null {
  try {
    const result = kubectlJson<{
      items: Array<{
        metadata: { name: string }
        status: {
          phase: string
          containerStatuses?: Array<{ ready: boolean }>
        }
      }>
    }>(`get pod -l ${labelSelector} -n ${namespace}`)

    if (result.items.length === 0) return null

    const pod = result.items[0]
    const ready = pod.status.containerStatuses?.every(c => c.ready) ?? false
    return { name: pod.metadata.name, phase: pod.status.phase, ready }
  } catch {
    return null
  }
}

/** Wait for a pod matching the selector to be Ready, with timeout. */
export async function waitForPodReady(
  labelSelector: string,
  namespace: string,
  timeoutMs = 60_000
): Promise<void> {
  const start = Date.now()
  while (Date.now() - start < timeoutMs) {
    const status = getPodStatus(labelSelector, namespace)
    if (status?.ready) return
    await sleep(2_000)
  }
  throw new Error(`Pod ${labelSelector} in ${namespace} not ready within ${timeoutMs}ms`)
}

/**
 * Wait for a resource to exist (or not exist).
 *
 * For label-selector queries (e.g. "deploy -l foo=bar"), kubectl returns
 * 0 exit code with an empty items array instead of an error. This helper
 * handles both patterns: named resources (throws on NotFound) and label
 * queries (returns empty list).
 */
export async function waitForResource(
  resource: string,
  namespace: string,
  opts: { shouldExist?: boolean; timeoutMs?: number } = {}
): Promise<void> {
  const { shouldExist = true, timeoutMs = 30_000 } = opts
  const isLabelQuery = resource.includes('-l ')
  const start = Date.now()
  while (Date.now() - start < timeoutMs) {
    try {
      if (isLabelQuery) {
        const result = kubectlJson<{ items: unknown[] }>(`get ${resource} -n ${namespace}`)
        const exists = result.items.length > 0
        if (exists === shouldExist) return
      } else {
        kubectl(`get ${resource} -n ${namespace}`)
        if (shouldExist) return
      }
    } catch {
      if (!shouldExist) return
    }
    await sleep(2_000)
  }
  throw new Error(
    `Resource ${resource} in ${namespace} did not ${shouldExist ? 'appear' : 'disappear'} within ${timeoutMs}ms`
  )
}

/**
 * Start a port-forward and return the child process + local URL.
 * Caller must kill the process when done.
 */
export function startPortForward(
  resource: string,
  namespace: string,
  localPort: number,
  remotePort: number
): { process: ChildProcess; url: string } {
  requireSafeKubeContext()
  const child = spawn(
    'kubectl',
    [
      '--context',
      KUBE_CONTEXT,
      'port-forward',
      resource,
      `${localPort}:${remotePort}`,
      '-n',
      namespace,
    ],
    { stdio: 'pipe' }
  )

  return {
    process: child,
    url: `http://localhost:${localPort}`,
  }
}

/** Wait for a port-forward to become available by polling the health endpoint. */
export async function waitForPortForward(url: string, timeoutMs = 15_000): Promise<void> {
  const start = Date.now()
  while (Date.now() - start < timeoutMs) {
    try {
      const res = await fetch(`${url}/health`)
      if (res.status === 200) return
    } catch {
      // port-forward not ready yet
    }
    await sleep(1_000)
  }
  throw new Error(`Port-forward at ${url} not ready within ${timeoutMs}ms`)
}

/** Simple fetch that returns status + parsed JSON body. */
export async function fetchJson(
  url: string,
  opts?: RequestInit
): Promise<{ status: number; data: unknown }> {
  const res = await fetch(url, opts)
  const text = await res.text()
  let data: unknown
  try {
    data = JSON.parse(text)
  } catch {
    data = text
  }
  return { status: res.status, data }
}

/** Health check — returns true if GET /health returns 200. */
export async function healthCheck(url: string): Promise<boolean> {
  try {
    const { status } = await fetchJson(`${url}/health`)
    return status === 200
  } catch {
    return false
  }
}

/** Get pod logs (last N lines). */
export function getPodLogs(deployment: string, namespace: string, tail = 50): string {
  try {
    return kubectl(`logs deploy/${deployment} -n ${namespace} --tail=${tail}`)
  } catch {
    return ''
  }
}

export function sleep(ms: number): Promise<void> {
  return new Promise(r => setTimeout(r, ms))
}

// ---------------------------------------------------------------------------
// MCP Protocol Helpers — direct StreamableHTTP (no Clerum proxy headers)
// ---------------------------------------------------------------------------

/**
 * Parse an SSE or plain JSON response.
 * StreamableHTTP may respond with `text/event-stream` (SSE) containing
 * `event: message\ndata: {...}\n` lines, or plain JSON.
 */
export function parseSseOrJson(text: string): unknown {
  try {
    return JSON.parse(text)
  } catch {
    const lines = text.split('\n')
    for (let i = lines.length - 1; i >= 0; i--) {
      if (lines[i].startsWith('data: ')) {
        return JSON.parse(lines[i].slice(6))
      }
    }
    return text
  }
}

function requireJsonRpcResult<T>(data: unknown, method: string, rawBody: string): T {
  if (!data || typeof data !== 'object') {
    throw new Error(`MCP ${method} returned non-object response: ${rawBody}`)
  }

  const envelope = data as { error?: unknown; result?: unknown }
  if (envelope.error != null) {
    throw new Error(`MCP ${method} returned JSON-RPC error: ${JSON.stringify(envelope.error)}`)
  }
  if (!('result' in envelope)) {
    throw new Error(`MCP ${method} response missing result: ${rawBody}`)
  }

  return envelope.result as T
}

/** Initialize an MCP session and return the session ID. */
export async function mcpInitSession(baseUrl: string): Promise<string> {
  const res = await fetch(`${baseUrl}/mcp`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Accept: 'application/json, text/event-stream',
    },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: {
        protocolVersion: '2025-03-26',
        capabilities: {},
        clientInfo: { name: 'e2e-operational-test', version: '1.0.0' },
      },
    }),
  })

  if (res.status !== 200) {
    const body = await res.text().catch(() => '')
    throw new Error(`MCP initialize failed: HTTP ${res.status} ${body}`)
  }

  const body = await res.text()
  const parsed = body.trim() ? parseSseOrJson(body) : null
  if (parsed && typeof parsed === 'object' && 'error' in parsed && parsed.error != null) {
    throw new Error(`MCP initialize returned JSON-RPC error: ${JSON.stringify(parsed.error)}`)
  }

  const sessionId = res.headers.get('mcp-session-id')
  if (!sessionId) {
    throw new Error(
      `MCP initialize did not return session ID. Status: ${res.status}, body: ${body}`
    )
  }

  return sessionId
}

/** List available MCP tools using an existing session. */
export async function mcpListTools(
  baseUrl: string,
  sessionId: string
): Promise<Array<{ name: string; description: string }>> {
  const res = await fetch(`${baseUrl}/mcp`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Accept: 'application/json, text/event-stream',
      'mcp-session-id': sessionId,
    },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 2,
      method: 'tools/list',
      params: {},
    }),
  })

  const text = await res.text()
  if (res.status !== 200) {
    throw new Error(`MCP tools/list failed: HTTP ${res.status} ${text}`)
  }
  const data = parseSseOrJson(text) as {
    result?: { tools: Array<{ name: string; description: string }> }
    error?: unknown
  }
  const result = requireJsonRpcResult<{ tools?: unknown }>(data, 'tools/list', text)
  if (!Array.isArray(result.tools)) {
    throw new Error(`MCP tools/list result missing tools array: ${text}`)
  }
  return result.tools as Array<{ name: string; description: string }>
}

/** Call an MCP tool using an existing session. */
export async function mcpCallTool(
  baseUrl: string,
  sessionId: string,
  toolName: string,
  args: Record<string, unknown>
): Promise<{ content: Array<{ type: string; text: string }>; isError?: boolean }> {
  const res = await fetch(`${baseUrl}/mcp`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Accept: 'application/json, text/event-stream',
      'mcp-session-id': sessionId,
    },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 3,
      method: 'tools/call',
      params: { name: toolName, arguments: args },
    }),
  })

  const text = await res.text()
  if (res.status !== 200) {
    throw new Error(`MCP tools/call ${toolName} failed: HTTP ${res.status} ${text}`)
  }
  const data = parseSseOrJson(text) as {
    result?: { content: Array<{ type: string; text: string }>; isError?: boolean }
    error?: unknown
  }
  const result = requireJsonRpcResult<{
    content?: unknown
    isError?: boolean
  }>(data, `tools/call ${toolName}`, text)
  if (!Array.isArray(result.content)) {
    throw new Error(`MCP tools/call ${toolName} result missing content array: ${text}`)
  }
  return result as { content: Array<{ type: string; text: string }>; isError?: boolean }
}

// ---------------------------------------------------------------------------
// MCP Server Specific Helpers for E2E Testing
// ---------------------------------------------------------------------------

/**
 * Get the pod name for an MCP server using its label selector.
 */
export async function getMcpServerPodName(
  serverName: string,
  namespace: string = MCP_SERVER_NAMESPACE
): Promise<string> {
  const result = kubectlJson<{ items: Array<{ metadata: { name: string } }> }>(
    `get pod -l clerum.io/mcpserver=${serverName} -n ${namespace}`
  )
  if (result.items.length === 0) {
    throw new Error(`No pod found for MCP server ${serverName} in ${namespace}`)
  }
  return result.items[0].metadata.name
}

/**
 * Wait for an MCP server pod to be ready (Running phase + Ready condition).
 */
export async function waitForMcpServerReady(
  serverName: string,
  namespace: string = MCP_SERVER_NAMESPACE,
  timeoutMs: number = 60_000
): Promise<void> {
  const start = Date.now()
  while (Date.now() - start < timeoutMs) {
    try {
      const podName = await getMcpServerPodName(serverName, namespace)
      const result = kubectlJson<{
        status: {
          phase: string
          conditions?: Array<{ type: string; status: string }>
        }
      }>(`get pod ${podName} -n ${namespace}`)

      if (result.status.phase === 'Running') {
        const ready = result.status.conditions?.find(c => c.type === 'Ready')
        if (ready?.status === 'True') {
          console.log(`[MCP Helper] MCP server ${serverName} is ready`)
          return
        }
      }
    } catch {
      // Pod not ready yet, continue waiting
    }
    await sleep(1_000)
  }
  throw new Error(`Timeout waiting for MCP server ${serverName} to be ready`)
}

/**
 * Verify that an MCP server exposes the expected tools.
 * Uses port-forward to access the MCP server directly.
 */
export async function verifyMcpServerTools(
  serverName: string,
  expectedTools: string[],
  namespace: string = MCP_SERVER_NAMESPACE
): Promise<void> {
  const podName = await getMcpServerPodName(serverName, namespace)
  const localPort = await reservePort()
  const { process } = startPortForward(podName, namespace, localPort, 3000)
  const baseUrl = `http://localhost:${localPort}`

  try {
    await waitForPortForward(baseUrl, 15_000)
    const sessionId = await mcpInitSession(baseUrl)
    const tools = await mcpListTools(baseUrl, sessionId)
    const toolNames = tools.map(t => t.name)

    for (const expected of expectedTools) {
      if (!toolNames.includes(expected)) {
        throw new Error(`Expected tool ${expected} not found. Got: ${toolNames.join(', ')}`)
      }
    }

    console.log(`[MCP Helper] Verified tools: ${toolNames.join(', ')}`)
  } finally {
    process.kill()
    releasePort(localPort)
  }
}

/**
 * Execute an MCP tool call on a specific server.
 * Uses port-forward to access the MCP server directly.
 */
export async function executeMcpOperation(
  serverName: string,
  toolName: string,
  args: Record<string, unknown>,
  namespace: string = MCP_SERVER_NAMESPACE
): Promise<{ content: Array<{ type: string; text: string }>; isError?: boolean }> {
  const podName = await getMcpServerPodName(serverName, namespace)
  const localPort = await reservePort()
  const { process } = startPortForward(podName, namespace, localPort, 3000)
  const baseUrl = `http://localhost:${localPort}`

  try {
    await waitForPortForward(baseUrl, 15_000)
    const sessionId = await mcpInitSession(baseUrl)
    return await mcpCallTool(baseUrl, sessionId, toolName, args)
  } finally {
    process.kill()
    releasePort(localPort)
  }
}

/**
 * Create a Kubernetes secret for MCP server credentials.
 */
export async function createMcpServerSecret(
  serverName: string,
  credentials: Record<string, string>,
  namespace: string = MCP_SERVER_NAMESPACE
): Promise<void> {
  const secretName = `mcp-${serverName}-credentials`

  // Build kubectl secret command with from-literal args
  const literalArgs = Object.entries(credentials)
    .map(([key, value]) => `--from-literal=${key}=${value}`)
    .join(' ')

  kubectl(
    `create secret generic ${secretName} -n ${namespace} ${literalArgs} --dry-run=client -o yaml | kubectl apply -f -`
  )

  console.log(`[MCP Helper] Created secret: ${secretName}`)
}

/**
 * Verify that a secret is mounted as an environment variable in a pod.
 */
export async function verifySecretMounted(
  podName: string,
  secretName: string,
  namespace: string = MCP_SERVER_NAMESPACE
): Promise<void> {
  const result = kubectlJson<{
    spec: {
      containers: Array<{
        env?: Array<{
          name: string
          valueFrom?: { secretKeyRef?: { name: string } }
        }>
      }>
    }
  }>(`get pod ${podName} -n ${namespace}`)

  const container = result.spec.containers[0]
  const secretEnv = container.env?.find(e => e.valueFrom?.secretKeyRef?.name === secretName)

  if (!secretEnv) {
    throw new Error(`Secret ${secretName} not mounted in pod ${podName}`)
  }

  console.log(`[MCP Helper] Secret ${secretName} mounted as ${secretEnv.name}`)
}

/**
 * Write test data to MongoDB via MCP server.
 */
export async function writeMongoTestData(
  serverName: string,
  collection: string,
  document: Record<string, unknown>,
  namespace: string = MCP_SERVER_NAMESPACE
): Promise<void> {
  const result = await executeMcpOperation(
    serverName,
    'mongodb_insert_one',
    {
      database: 'test',
      collection,
      document,
    },
    namespace
  )

  const responseText = result.content[0]?.text ?? '{}'
  const response = JSON.parse(responseText) as { insertedId?: string }

  console.log(`[MCP Helper] Wrote test data to ${collection}:`, response.insertedId ?? 'unknown')
}

/**
 * Read test data from MongoDB via MCP server.
 */
export async function readMongoTestData(
  serverName: string,
  collection: string,
  filter: Record<string, unknown>,
  namespace: string = MCP_SERVER_NAMESPACE
): Promise<unknown[]> {
  const result = await executeMcpOperation(
    serverName,
    'mongodb_find',
    {
      database: 'test',
      collection,
      filter,
      limit: 100,
    },
    namespace
  )

  const responseText = result.content[0]?.text ?? '[]'
  return JSON.parse(responseText) as unknown[]
}

/**
 * Verify that a PVC is retained after pod deletion (UID remains the same).
 */
export async function verifyPvcRetention(
  serverName: string,
  pvcName: string,
  namespace: string = MCP_SERVER_NAMESPACE
): Promise<void> {
  // Get PVC UID before deletion
  const pvcBefore = kubectlJson<{ metadata: { uid: string } }>(`get pvc ${pvcName} -n ${namespace}`)
  const uidBefore = pvcBefore.metadata.uid

  // Delete StatefulSet pod (it will be recreated)
  const podName = await getMcpServerPodName(serverName, namespace)
  kubectl(`delete pod ${podName} -n ${namespace}`)

  // Wait for pod to be recreated
  await sleep(5_000)

  // Check PVC still exists with same UID
  const pvcAfter = kubectlJson<{ metadata: { uid: string } }>(`get pvc ${pvcName} -n ${namespace}`)
  const uidAfter = pvcAfter.metadata.uid

  if (uidBefore !== uidAfter) {
    throw new Error(`PVC ${pvcName} was recreated (UID changed)`)
  }

  console.log(`[MCP Helper] PVC ${pvcName} retained (UID: ${uidAfter})`)
}

// ---------------------------------------------------------------------------
// Port Management for Port-Forwards
// ---------------------------------------------------------------------------

const usedPorts = new Set<number>()

/**
 * Reserve a unique local port for port-forwarding.
 */
export async function reservePort(): Promise<number> {
  const minPort = 18000
  const maxPort = 19000

  for (let port = minPort; port <= maxPort; port++) {
    if (!usedPorts.has(port)) {
      usedPorts.add(port)
      return port
    }
  }
  throw new Error('No available ports in range 18000-19000')
}

/**
 * Release a previously reserved port.
 */
export function releasePort(port: number): void {
  usedPorts.delete(port)
}

/**
 * Get a pod name by label selector.
 */
export function getPodName(labelSelector: string, namespace: string): string {
  return kubectl(
    `get pod -l ${labelSelector} -n ${namespace} -o jsonpath='{.items[0].metadata.name}'`
  )
}

/**
 * Wait for StatefulSet to have all replicas ready.
 */
export async function waitForStatefulSetReady(
  name: string,
  namespace: string,
  timeoutMs = 120_000
): Promise<void> {
  const start = Date.now()
  while (Date.now() - start < timeoutMs) {
    try {
      const sts = kubectlJson<{
        status: { readyReplicas: number; replicas: number }
      }>(`get statefulset ${name} -n ${namespace}`)

      if (sts.status.readyReplicas === sts.status.replicas && sts.status.replicas > 0) {
        return
      }
    } catch {
      /* not ready yet */
    }
    await sleep(2_000)
  }
  throw new Error(`StatefulSet ${name} in ${namespace} not ready within ${timeoutMs}ms`)
}
