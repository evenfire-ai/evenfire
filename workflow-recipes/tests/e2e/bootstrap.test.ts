/**
 * E5.1–E5.8: Bootstrap E2E tests.
 *
 * Validates that the WRC is correctly deployed in minikube:
 * CRD registration, pod running, health endpoint, MCP initialization,
 * RBAC, self-registration, service account, and liveness probe.
 *
 * Prerequisites: Run scripts/minikube-setup.sh before these tests.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { ChildProcess } from 'node:child_process'
import http from 'node:http'
import {
  MCP_SERVER_NAMESPACE,
  WRC_NAMESPACE,
  crdExists,
  fetchJson,
  getPodLogs,
  getPodStatus,
  kubectl,
  kubectlJson,
  startPortForward,
  waitForPortForward,
} from './helpers'

const LOCAL_PORT = 18082
const WRC_REMOTE_PORT = 8082
let portForwardProcess: ChildProcess | null = null

beforeAll(async () => {
  const pf = startPortForward('deploy/workflow-recipes', WRC_NAMESPACE, LOCAL_PORT, WRC_REMOTE_PORT)
  portForwardProcess = pf.process
  await waitForPortForward(pf.url)
})

afterAll(() => {
  if (portForwardProcess) {
    portForwardProcess.kill()
    portForwardProcess = null
  }
})

describe('Bootstrap E2E', () => {
  // E5.1: CRD registration
  it('E5.1 — WorkflowRecipe CRD is registered', () => {
    expect(crdExists('workflowrecipes.clerum.io')).toBe(true)
  })

  // E5.2: WRC pod running
  it('E5.2 — WRC pod is Running and Ready', () => {
    const status = getPodStatus('app=workflow-recipes', WRC_NAMESPACE)
    expect(status).not.toBeNull()
    expect(status!.phase).toBe('Running')
    expect(status!.ready).toBe(true)
  })

  // E5.3: Health endpoint
  it('E5.3 — Health endpoint returns ok', async () => {
    const { data } = await fetchJson(`http://localhost:${LOCAL_PORT}/health`)
    expect(data).toEqual({ status: 'ok' })
  })

  // E5.4: MCP server initializable
  // StreamableHTTP responds with SSE (text/event-stream). Node's fetch (undici)
  // doesn't handle SSE connection closure gracefully, so we use http.request
  // for full control over the response stream.
  it('E5.4 — MCP endpoint accepts initialize request', async () => {
    const body = JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: {
        protocolVersion: '2025-03-26',
        capabilities: {},
        clientInfo: { name: 'e2e-test', version: '0.1.0' },
      },
    })

    const { status, data } = await new Promise<{ status: number; data: string }>(
      (resolve, reject) => {
        const req = http.request(
          {
            hostname: '127.0.0.1',
            port: LOCAL_PORT,
            path: '/mcp/v1',
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              Accept: 'application/json, text/event-stream',
              Connection: 'close',
            },
          },
          res => {
            const chunks: Buffer[] = []
            res.on('data', (chunk: Buffer) => {
              chunks.push(chunk)
            })
            res.on('end', () =>
              resolve({ status: res.statusCode ?? 0, data: Buffer.concat(chunks).toString() })
            )
            // StreamableHTTP may reset the connection after sending SSE data — resolve with what we have
            res.on('error', () =>
              resolve({ status: res.statusCode ?? 0, data: Buffer.concat(chunks).toString() })
            )
          }
        )
        req.on('error', e => reject(e))
        req.write(body)
        req.end()
      }
    )

    expect(status).toBe(200)

    // SSE response format: "event: message\ndata: {json}\n\n"
    // Extract the JSON-RPC response from the SSE data field
    const dataLines = data.split('\n').filter(l => l.startsWith('data: '))
    expect(dataLines.length).toBeGreaterThan(0)

    const parsed = dataLines
      .map(l => {
        try {
          return JSON.parse(l.slice(6))
        } catch {
          return null
        }
      })
      .find(p => p?.result !== undefined)

    expect(parsed).toBeDefined()
    expect(parsed.result.serverInfo.name).toBe('workflow-recipes')
  })

  // E5.5: RBAC working — no 403 errors in WRC logs
  it('E5.5 — RBAC is working (no 403 in logs)', () => {
    const logs = getPodLogs('workflow-recipes', WRC_NAMESPACE, 500)
    expect(logs).not.toMatch(/403|Forbidden/i)
  })

  // E5.6: Self-registration
  // WRC self-registration McpServer is a Phase 9 feature (not yet implemented).
  // The WRC operator does not currently create an McpServer CRD for itself.
  it.skip('E5.6 — McpServer self-registration exists with managed: false', () => {
    const server = kubectlJson<{
      spec: { managed: boolean; transport: { type: string } }
    }>('get mcpserver workflow-recipes -n mcp-server')

    expect(server.spec.managed).toBe(false)
    expect(server.spec.transport.type).toBe('streamableHttp')
  })

  // E5.7: Service account
  it('E5.7 — ServiceAccount exists in control-plane', () => {
    const sa = kubectlJson<{
      metadata: { name: string }
    }>(`get sa workflow-recipes -n ${WRC_NAMESPACE}`)
    expect(sa.metadata.name).toBe('workflow-recipes')
  })

  // E5.8: Liveness probe — verify the pod has a probe configured
  it('E5.8 — Liveness probe is configured on WRC pod', () => {
    const pod = kubectlJson<{
      items: Array<{
        spec: {
          containers: Array<{
            livenessProbe?: { httpGet?: { path: string; port: number | string } }
          }>
        }
      }>
    }>(`get pod -l app=workflow-recipes -n ${WRC_NAMESPACE}`)

    expect(pod.items.length).toBeGreaterThan(0)
    const container = pod.items[0].spec.containers[0]
    expect(container.livenessProbe).toBeDefined()
    expect(container.livenessProbe!.httpGet?.path).toBe('/health')
  })

  // E5.9: sandbox-recipes namespace exists (workload isolation boundary)
  it('E5.9 — sandbox-recipes namespace exists', () => {
    const ns = kubectlJson<{ metadata: { name: string }; status: { phase: string } }>(
      'get ns sandbox-recipes'
    )
    expect(ns.metadata.name).toBe('sandbox-recipes')
    expect(ns.status.phase).toBe('Active')
  })

  // E5.10: L0 deny-all NetworkPolicy exists in mcp-server namespace
  // Phase 8: policy renamed to deny-all-{namespace}, policyTypes extended to Ingress+Egress
  it('E5.10 — L0 deny-all NetworkPolicy exists in mcp-server (Ingress + Egress)', () => {
    const np = kubectlJson<{
      metadata: { name: string; labels: Record<string, string> }
      spec: { podSelector: Record<string, unknown>; policyTypes: string[] }
    }>(`get networkpolicy deny-all-mcp-server -n ${MCP_SERVER_NAMESPACE}`)

    expect(np.metadata.name).toBe('deny-all-mcp-server')
    expect(np.metadata.labels['clerum.io/policy-type']).toBe('default-deny')
    // L0 deny-all uses empty podSelector (matches all pods)
    expect(np.spec.podSelector).toEqual({})
    // Phase 8: deny both ingress AND egress — defense-in-depth baseline
    expect(np.spec.policyTypes).toContain('Ingress')
    expect(np.spec.policyTypes).toContain('Egress')
  })

  // E5.11: L1 infrastructure policies exist (Phase 8 — DNS, HCC API, K8s API egress)
  it('E5.11 — L1 infrastructure policies exist in mcp-server', () => {
    const policies = kubectlJson<{
      items: Array<{ metadata: { name: string; labels: Record<string, string> } }>
    }>(`get networkpolicy -l clerum.io/policy-type=infrastructure -n ${MCP_SERVER_NAMESPACE}`)

    const names = policies.items.map(p => p.metadata.name)

    // DNS egress (port 53 UDP+TCP to kube-system)
    expect(names).toContain('allow-dns-egress-mcp-server')
    // HCC API egress (port 8081 to control-plane)
    expect(names).toContain('allow-hcc-api-egress-mcp-server')
    // K8s API egress (port 443)
    expect(names).toContain('allow-k8s-api-egress-mcp-server')
  })

  // E5.12: /metrics endpoint returns Prometheus metrics (Phase 8)
  it('E5.12 — WRC /metrics endpoint returns Prometheus format', async () => {
    const res = await fetch(`http://localhost:${LOCAL_PORT}/metrics`)
    expect(res.status).toBe(200)
    const contentType = res.headers.get('content-type') ?? ''
    expect(contentType).toContain('text/plain')
    const body = await res.text()
    // Verify at least one WRC metric is present
    expect(body).toContain('clerum_wrc_recipes_total')
  })
})
