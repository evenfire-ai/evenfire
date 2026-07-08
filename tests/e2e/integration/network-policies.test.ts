/**
 * NetworkPolicy E2E Tests — validates Calico-enforced network segmentation.
 *
 * Tests both POSITIVE cases (allowed traffic) and NEGATIVE cases (blocked by design).
 * Requires minikube with Calico CNI and all services deployed.
 *
 * Negative tests use `wget --timeout=3` from kubectl exec. A timeout indicates
 * the NetworkPolicy is blocking traffic as expected. A successful response or
 * connection refused (port not listening) would indicate a policy gap.
 */
import { describe, expect, it } from 'vitest'
import { execFileSync } from 'child_process'

// Short timeout for negative tests — we expect these to time out
const NP_TIMEOUT = 3

interface ConnectResult {
  reachable: boolean
  statusCode?: number
  error?: string
}

let cachedMcpHostRuntimeName: string | null = null
let cachedChannelReaderPodName: string | null | undefined

function getMcpHostRuntimeName(): string {
  if (cachedMcpHostRuntimeName) return cachedMcpHostRuntimeName

  for (const candidate of ['chatllm', 'mcp-host']) {
    try {
      execFileSync('kubectl', ['get', 'svc', candidate, '-n', 'mcp-host'], {
        encoding: 'utf-8',
        timeout: 10_000,
      })
      cachedMcpHostRuntimeName = candidate
      return candidate
    } catch {
      // Try the next known runtime name.
    }
  }

  throw new Error('No mcp-host runtime service found in namespace mcp-host')
}

function getMcpHostRuntimeUrl(path = '/v1/runtime/health'): string {
  const runtimeName = getMcpHostRuntimeName()
  return `http://${runtimeName}.mcp-host.svc.cluster.local:8080${path}`
}

function getChannelReaderPodName(): string | null {
  if (cachedChannelReaderPodName !== undefined) return cachedChannelReaderPodName

  for (const selector of ['app=channel-reader', 'app.kubernetes.io/name=channel-reader']) {
    try {
      const podName = execFileSync(
        'kubectl',
        [
          'get',
          'pods',
          '-n',
          'channels',
          '-l',
          selector,
          '--field-selector=status.phase=Running',
          '-o',
          'jsonpath={.items[0].metadata.name}',
        ],
        { encoding: 'utf-8', timeout: 10_000 }
      ).trim()
      if (podName) {
        cachedChannelReaderPodName = podName
        return podName
      }
    } catch {
      // Try the next known label.
    }
  }

  cachedChannelReaderPodName = null
  return null
}

/**
 * Attempts an HTTP connection from a pod in one namespace to a target service.
 * Uses `kubectl exec` + `wget` to test in-cluster connectivity.
 *
 * Returns { reachable: true, statusCode } if the HTTP layer responds (even 404).
 * Returns { reachable: false, error } if the connection times out or is blocked.
 */
function testConnectivity(
  fromNamespace: string,
  fromTarget: string,
  targetUrl: string
): ConnectResult {
  // Support both deployment names (prefixed with deployment/) and bare pod names
  const execTarget = fromTarget.includes('/') ? fromTarget : `deployment/${fromTarget}`
  try {
    // TM-3: use execFileSync to avoid shell interpolation
    execFileSync(
      'kubectl',
      [
        'exec',
        '-n',
        fromNamespace,
        execTarget,
        '--',
        'wget',
        '-qO-',
        `--timeout=${NP_TIMEOUT}`,
        targetUrl,
      ],
      { encoding: 'utf-8', timeout: (NP_TIMEOUT + 5) * 1000 }
    )
    // wget succeeded — HTTP response received
    return { reachable: true, statusCode: 200 }
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err)
    // wget returns exit code 8 for server error (4xx/5xx) — still reachable
    if (msg.includes('server returned error')) {
      const match = msg.match(/HTTP\/\d\.?\d?\s+(\d+)/)
      return { reachable: true, statusCode: match ? parseInt(match[1]) : 0 }
    }
    // wget returns "download timed out" when NP blocks traffic
    if (
      msg.includes('timed out') ||
      msg.includes('ETIMEDOUT') ||
      msg.includes('Network is unreachable')
    ) {
      return { reachable: false, error: 'timeout (blocked by NetworkPolicy)' }
    }
    // Connection refused = port not open, but network IS reachable
    if (msg.includes('Connection refused') || msg.includes('ECONNREFUSED')) {
      return { reachable: true, error: 'connection refused (port not listening)' }
    }
    // DNS failure = network IS reachable to DNS but service doesn't exist
    if (msg.includes('bad address') || msg.includes('NXDOMAIN')) {
      return { reachable: false, error: 'DNS resolution failed' }
    }
    return { reachable: false, error: msg.slice(0, 200) }
  }
}

describe('NetworkPolicy Enforcement (Calico)', () => {
  // ─── Prerequisite Check ──────────────────────────────────────────────
  it('Calico CNI is active', () => {
    const pods = execFileSync(
      'kubectl',
      ['get', 'pods', '-n', 'kube-system', '-l', 'k8s-app=calico-node', '--no-headers'],
      { encoding: 'utf-8' }
    )
    expect(pods).toContain('Running')
  })

  it('deny-all policies exist in secured namespaces', () => {
    const namespaces = ['mcp-host', 'mcp-server', 'rpc-proxy', 'sandbox-recipes']
    for (const ns of namespaces) {
      let nps: string
      try {
        nps = execFileSync(
          'kubectl',
          [
            'get',
            'networkpolicy',
            '-n',
            ns,
            '-l',
            'clerum.io/policy-type=default-deny',
            '--no-headers',
          ],
          { encoding: 'utf-8' }
        )
      } catch {
        nps = 'NONE'
      }
      // Check for deny-all by name if label selector didn't work
      if (nps.includes('NONE')) {
        const allNps = execFileSync('kubectl', ['get', 'networkpolicy', '-n', ns, '--no-headers'], {
          encoding: 'utf-8',
        })
        expect(allNps).toContain('deny-all')
      }
    }
  })

  // ─── POSITIVE TESTS (Allowed Traffic) ────────────────────────────────
  describe('Allowed traffic (positive)', () => {
    it('control-api → registry-api:8085 (cross-namespace, registry access)', () => {
      const result = testConnectivity(
        'control-plane',
        'control-api',
        'http://registry-api.registry.svc.cluster.local:8085/health'
      )
      expect(result.reachable).toBe(true)
    })

    it('control-ui → control-api:8090 (UI backend path)', () => {
      const result = testConnectivity(
        'control-plane',
        'control-ui',
        'http://control-api.control-plane.svc.cluster.local:8090/health'
      )
      expect(result.reachable).toBe(true)
    })

    it('external-rest-api → profile-control-funnel:8080 (internal control path)', () => {
      const result = testConnectivity(
        'profiles',
        'external-rest-api',
        'http://profile-control-funnel.profiles.svc.cluster.local:8080/health'
      )
      expect(result.reachable).toBe(true)
    })

    it('rpc-proxy → mcp-host:8080 (message relay)', () => {
      const result = testConnectivity('rpc-proxy', 'rpc-proxy', getMcpHostRuntimeUrl())
      expect(result.reachable).toBe(true)
    })

    it('mcp-host can reach the HCC gateway readiness endpoint', () => {
      const result = testConnectivity(
        'mcp-host',
        getMcpHostRuntimeName(),
        'http://host-context-controller-api-gateway.control-plane.svc.cluster.local:8081/ready'
      )
      // HCC API Gateway is explicitly allowed by allow-hcc-api-egress-mcp-host + mcp-host egress NP
      expect(result.reachable).toBe(true)
      expect(result.statusCode).toBe(200)
    })
  })

  // ─── NEGATIVE TESTS (Blocked by Design) ──────────────────────────────
  describe('Blocked traffic (negative — deny-all enforced)', () => {
    it('mcp-host → rpc-proxy:8094 (reverse direction blocked)', () => {
      const result = testConnectivity(
        'mcp-host',
        getMcpHostRuntimeName(),
        'http://rpc-proxy.rpc-proxy.svc.cluster.local:8094/health'
      )
      expect(result.reachable).toBe(false)
      expect(result.error).toContain('timeout')
    })

    it('mcp-host → control-api:8090 (no direct access to control-plane)', () => {
      const result = testConnectivity(
        'mcp-host',
        getMcpHostRuntimeName(),
        'http://control-api.control-plane.svc.cluster.local:8090/health'
      )
      expect(result.reachable).toBe(false)
      expect(result.error).toContain('timeout')
    })

    it('channel-reader → workflow approval gateway:8092 (must go through mcp-host)', () => {
      const podName = getChannelReaderPodName()
      if (!podName) {
        console.warn('SKIPPED: no running channel-reader pod in channels')
        return
      }

      const result = testConnectivity(
        'channels',
        podName,
        'http://nginx-workflow-approval-gateway.control-plane.svc.cluster.local:8092/health'
      )
      expect(result.reachable).toBe(false)
      expect(result.error).toContain('timeout')
    })

    it('mcp-host → registry-api:8085 (no direct registry access)', () => {
      const result = testConnectivity(
        'mcp-host',
        getMcpHostRuntimeName(),
        'http://registry-api.registry.svc.cluster.local:8085/health'
      )
      expect(result.reachable).toBe(false)
      expect(result.error).toContain('timeout')
    })

    it('control-api → rpc-proxy:8094 (no direct control-plane hop)', () => {
      const result = testConnectivity(
        'control-plane',
        'control-api',
        'http://rpc-proxy.rpc-proxy.svc.cluster.local:8094/health'
      )
      expect(result.reachable).toBe(false)
      expect(result.error).toContain('timeout')
    })

    it('external-rest-api → rpc-proxy:8094 (desktop app reaches rpc-proxy directly, not via backend)', () => {
      const result = testConnectivity(
        'profiles',
        'external-rest-api',
        'http://rpc-proxy.rpc-proxy.svc.cluster.local:8094/health'
      )
      expect(result.reachable).toBe(false)
      expect(result.error).toContain('timeout')
    })

    it('control-api → mcp-host:8080 directly (must go through rpc-proxy)', () => {
      const result = testConnectivity('control-plane', 'control-api', getMcpHostRuntimeUrl())
      expect(result.reachable).toBe(false)
      expect(result.error).toContain('timeout')
    })

    it('external-rest-api → mcp-host:8080 directly (must go through rpc-proxy)', () => {
      const result = testConnectivity('profiles', 'external-rest-api', getMcpHostRuntimeUrl())
      expect(result.reachable).toBe(false)
      expect(result.error).toContain('timeout')
    })

    it('mcp-proxy → external-rest-api:3000 (no reverse path)', () => {
      const result = testConnectivity(
        'mcp-server',
        'mcp-proxy',
        'http://external-rest-api.profiles.svc.cluster.local:3000/health'
      )
      expect(result.reachable).toBe(false)
      expect(result.error).toContain('timeout')
    })
  })

  // ─── NAMESPACE ISOLATION ─────────────────────────────────────────────
  describe('Namespace isolation (cross-namespace blocked unless explicitly allowed)', () => {
    /**
     * Helper: checks if a usable pod exists in the namespace before attempting NP validation.
     * Returns the pod name if found, or null if no pods are available.
     */
    function findExecPod(namespace: string, labelSelector: string): string | null {
      try {
        const output = execFileSync(
          'kubectl',
          [
            'get',
            'pods',
            '-n',
            namespace,
            '-l',
            labelSelector,
            '--field-selector=status.phase=Running',
            '-o',
            'jsonpath={.items[0].metadata.name}',
          ],
          { encoding: 'utf-8', timeout: 10_000 }
        ).trim()
        return output || null
      } catch {
        return null
      }
    }

    it('sandbox-recipes → control-api:8090 (isolated sandbox)', () => {
      const podName = findExecPod('sandbox-recipes', 'app=db')
      if (!podName) {
        console.warn('SKIPPED: no running db pod in sandbox-recipes')
        return
      }
      // sandbox-recipes has deny-all; only DNS + HCC API egress allowed
      const result = testConnectivity(
        'sandbox-recipes',
        podName,
        'http://control-api.control-plane.svc.cluster.local:8090/health'
      )
      expect(result.reachable).toBe(false)
      expect(result.error).toContain('timeout')
    })

    it('sandbox-recipes → rpc-proxy:8094 (isolated sandbox)', () => {
      const podName = findExecPod('sandbox-recipes', 'app=db')
      if (!podName) {
        console.warn('SKIPPED: no running db pod in sandbox-recipes')
        return
      }
      const result = testConnectivity(
        'sandbox-recipes',
        podName,
        'http://rpc-proxy.rpc-proxy.svc.cluster.local:8094/health'
      )
      expect(result.reachable).toBe(false)
      expect(result.error).toContain('timeout')
    })
  })
})
