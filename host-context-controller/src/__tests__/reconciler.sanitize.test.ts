import { beforeEach, describe, expect, it, vi } from 'vitest'
import * as k8s from '@kubernetes/client-node'
import {
  asAppsApi,
  asCoreApi,
  asCustomApi,
  createMockAppsApi,
  createMockCoreApi,
  createMockCustomApi,
} from '../../test/__fixtures__/testMocks'
import { McpServerReconciler } from '../reconciler'
import { McpServerCRD } from '../types'

/**
 * CRD Field Injection Prevention Tests
 *
 * Principle: A developer-supplied CRD MUST NOT be able to influence
 * platform-controlled deployment behavior. The platform (HCC) is the
 * sole authority on how pods are deployed.
 *
 * These tests verify that sanitizeCrdSpec() strips or overrides every
 * dangerous CRD field before it reaches the PodSpec.
 */

vi.mock('../config', () => ({
  config: {
    devMode: false,
    port: 8081,
    namespace: 'mcp-server',
    hostNamespace: 'mcp-host',
    mcpServerImagePullPolicy: 'IfNotPresent',
    egressProxyImage: 'clerum/nginx-egress-proxy:0.1.0',
    stdioBridgeImage: 'clerum/stdio-bridge:test',
    stdioBridgeResources: {
      requests: { cpu: '50m', memory: '64Mi' },
      limits: { cpu: '200m', memory: '128Mi' },
    },
    devMcpServers: [],
    devContexts: [],
    devAuthTokens: new Map(),
  },
}))

function makeServer(
  overrides: Partial<McpServerCRD['spec']> & { name?: string } = {}
): McpServerCRD {
  const { name, ...specOverrides } = overrides
  return {
    name: name ?? 'test-mcp',
    namespace: 'mcp-server',
    uid: 'uid-test-1234',
    spec: {
      contextRef: 'ctx1',
      image: 'my-mcp-server:v1',
      transport: { type: 'streamableHttp', port: 3000, url: 'http://test.mcp-server.svc:3000/mcp' },
      ...specOverrides,
    },
  }
}

/** Extract the PodSpec from the Deployment body passed to createNamespacedDeployment */
function capturedDeployment(appsApi: ReturnType<typeof createMockAppsApi>): k8s.V1Deployment {
  const call = appsApi.createNamespacedDeployment.mock.calls[0]
  return (call[0] as { body: k8s.V1Deployment }).body
}

function capturedContainer(
  appsApi: ReturnType<typeof createMockAppsApi>,
  name = 'mcp-server'
): k8s.V1Container {
  const dep = capturedDeployment(appsApi)
  const containers = dep.spec!.template.spec!.containers
  return containers.find(c => c.name === name)!
}

function capturedInitContainer(
  appsApi: ReturnType<typeof createMockAppsApi>,
  name: string
): k8s.V1Container {
  const dep = capturedDeployment(appsApi)
  const containers = dep.spec!.template.spec!.initContainers ?? []
  return containers.find(c => c.name === name)!
}

describe('CRD Field Injection Prevention (sanitizeCrdSpec)', () => {
  const appsApi = createMockAppsApi()
  const coreApi = createMockCoreApi()
  const customApi = createMockCustomApi()
  let reconciler: McpServerReconciler

  beforeEach(() => {
    vi.clearAllMocks()
    reconciler = new McpServerReconciler({} as k8s.KubeConfig, {
      assumeInventoryAuthorityWhenUnconfigured: true,
      appsApi: asAppsApi(appsApi),
      coreApi: asCoreApi(coreApi),
      customApi: asCustomApi(customApi),
    })
  })

  // ════════════════════════════════════════════════════════════════════
  // CRITICAL: imagePullPolicy — platform decides, CRD cannot override
  // ════════════════════════════════════════════════════════════════════

  describe('imagePullPolicy override prevention', () => {
    it('should use platform config when CRD sets imagePullPolicy: Always', async () => {
      const server = makeServer({ imagePullPolicy: 'Always' })
      await reconciler.reconcile(server)
      const container = capturedContainer(appsApi)
      expect(container.imagePullPolicy).toBe('IfNotPresent')
    })

    it('should use platform config when CRD sets imagePullPolicy: Never', async () => {
      const server = makeServer({ imagePullPolicy: 'Never' })
      await reconciler.reconcile(server)
      const container = capturedContainer(appsApi)
      expect(container.imagePullPolicy).toBe('IfNotPresent')
    })

    it('should use platform config when CRD omits imagePullPolicy', async () => {
      const server = makeServer()
      await reconciler.reconcile(server)
      const container = capturedContainer(appsApi)
      expect(container.imagePullPolicy).toBe('IfNotPresent')
    })

    it('does not mutate a watched desired spec while building the sanitized Deployment', async () => {
      const server = makeServer({
        imagePullPolicy: 'Always',
        security: { runAsUser: 0, addCapabilities: ['CHOWN', 'SYS_ADMIN'] },
      })
      const originalSpec = structuredClone(server.spec)

      await reconciler.reconcile(server)

      expect(capturedContainer(appsApi).imagePullPolicy).toBe('IfNotPresent')
      expect(server.spec).toEqual(originalSpec)
    })
  })

  // ════════════════════════════════════════════════════════════════════
  // CRITICAL: runAsUser — CRD cannot request root (UID 0)
  // ════════════════════════════════════════════════════════════════════

  describe('root execution prevention', () => {
    it('should reject runAsUser: 0 and force UID 1000', async () => {
      const server = makeServer({
        security: { runAsUser: 0, runAsGroup: 0, fsGroup: 0 },
      })
      await reconciler.reconcile(server)
      const dep = capturedDeployment(appsApi)
      const podSec = dep.spec!.template.spec!.securityContext!
      expect(podSec.runAsUser).toBe(1000)
      expect(podSec.runAsGroup).toBe(1000)
      expect(podSec.fsGroup).toBe(1000)
    })

    it('should allow non-root UIDs (e.g., postgres UID 70)', async () => {
      const server = makeServer({
        security: { runAsUser: 70, runAsGroup: 70, fsGroup: 70 },
      })
      await reconciler.reconcile(server)
      const dep = capturedDeployment(appsApi)
      const podSec = dep.spec!.template.spec!.securityContext!
      expect(podSec.runAsUser).toBe(70)
      expect(podSec.runAsGroup).toBe(70)
      expect(podSec.fsGroup).toBe(70)
    })

    it('should reject negative UIDs', async () => {
      const server = makeServer({
        security: { runAsUser: -1 },
      })
      await reconciler.reconcile(server)
      const dep = capturedDeployment(appsApi)
      const podSec = dep.spec!.template.spec!.securityContext!
      expect(podSec.runAsUser).toBe(1000)
      expect(podSec.runAsGroup).toBe(1000)
      expect(podSec.fsGroup).toBeUndefined()
    })

    it('should reject root group IDs', async () => {
      const server = makeServer({
        security: { runAsGroup: 0, fsGroup: 0 },
      })
      await reconciler.reconcile(server)
      const dep = capturedDeployment(appsApi)
      const podSec = dep.spec!.template.spec!.securityContext!
      expect(podSec.runAsGroup).toBe(1000)
      expect(podSec.fsGroup).toBe(1000)
    })
  })

  // ════════════════════════════════════════════════════════════════════
  // CRITICAL: addCapabilities — keep only default-allowed Linux capabilities
  // ════════════════════════════════════════════════════════════════════

  describe('capabilities stripping', () => {
    it('should always keep no-new-privileges and drop all capabilities', async () => {
      const server = makeServer()
      await reconciler.reconcile(server)
      const container = capturedContainer(appsApi)
      expect(container.securityContext?.allowPrivilegeEscalation).toBe(false)
      expect(container.securityContext?.capabilities?.drop).toEqual(['ALL'])
      expect(container.securityContext?.capabilities?.add).toBeUndefined()
    })

    it('should strip SYS_ADMIN capability', async () => {
      const server = makeServer({
        security: { runAsUser: 1000, addCapabilities: ['CHOWN', 'SYS_ADMIN', 'FOWNER'] },
      })
      await reconciler.reconcile(server)
      const container = capturedContainer(appsApi)
      const caps = container.securityContext?.capabilities?.add
      expect(caps).toContain('CHOWN')
      expect(caps).toContain('FOWNER')
      expect(caps).not.toContain('SYS_ADMIN')
    })

    it('should strip NET_ADMIN capability', async () => {
      const server = makeServer({
        security: { runAsUser: 1000, addCapabilities: ['NET_ADMIN'] },
      })
      await reconciler.reconcile(server)
      const container = capturedContainer(appsApi)
      // All caps stripped → no securityContext.capabilities.add
      const caps = container.securityContext?.capabilities?.add ?? []
      expect(caps).not.toContain('NET_ADMIN')
    })

    it('should strip SYS_PTRACE capability', async () => {
      const server = makeServer({
        security: { runAsUser: 1000, addCapabilities: ['SYS_PTRACE', 'CHOWN'] },
      })
      await reconciler.reconcile(server)
      const container = capturedContainer(appsApi)
      const caps = container.securityContext?.capabilities?.add ?? []
      expect(caps).not.toContain('SYS_PTRACE')
      expect(caps).toContain('CHOWN')
    })

    it('should strip ALL forbidden caps in one CRD', async () => {
      const allForbidden = [
        'SYS_ADMIN',
        'SYS_PTRACE',
        'NET_ADMIN',
        'NET_RAW',
        'SYS_MODULE',
        'SYS_RAWIO',
        'MKNOD',
        'SETUID',
        'SETGID',
        'SYS_CHROOT',
        'KILL',
        'AUDIT_WRITE',
      ]
      const server = makeServer({
        security: { runAsUser: 1000, addCapabilities: [...allForbidden, 'CHOWN'] },
      })
      await reconciler.reconcile(server)
      const container = capturedContainer(appsApi)
      const caps = container.securityContext?.capabilities?.add ?? []
      expect(caps).toEqual(['CHOWN'])
    })

    it('should allow safe capabilities (CHOWN, FOWNER, DAC_OVERRIDE)', async () => {
      const server = makeServer({
        security: { runAsUser: 70, addCapabilities: ['CHOWN', 'FOWNER', 'DAC_OVERRIDE'] },
      })
      await reconciler.reconcile(server)
      const container = capturedContainer(appsApi)
      expect(container.securityContext?.allowPrivilegeEscalation).toBe(false)
      expect(container.securityContext?.capabilities?.drop).toEqual(['ALL'])
      const caps = container.securityContext?.capabilities?.add
      expect(caps).toEqual(['CHOWN', 'FOWNER', 'DAC_OVERRIDE'])
    })

    it('should harden stdio copy initContainer and bridge container', async () => {
      const server = makeServer({
        transport: { type: 'stdio', port: 3000 },
        command: ['/mcp-bin/mcp-server'],
      })
      await reconciler.reconcile(server)
      const copyContainer = capturedInitContainer(appsApi, 'copy-mcp-app')
      const bridgeContainer = capturedContainer(appsApi, 'stdio-bridge')
      for (const container of [copyContainer, bridgeContainer]) {
        expect(container.securityContext?.allowPrivilegeEscalation).toBe(false)
        expect(container.securityContext?.capabilities?.drop).toEqual(['ALL'])
        expect(container.securityContext?.capabilities?.add).toBeUndefined()
      }
    })

    it('should be case-insensitive when checking forbidden caps', async () => {
      const server = makeServer({
        security: { runAsUser: 1000, addCapabilities: ['sys_admin', 'Sys_Ptrace'] },
      })
      await reconciler.reconcile(server)
      const container = capturedContainer(appsApi)
      const caps = container.securityContext?.capabilities?.add ?? []
      expect(caps).toHaveLength(0)
    })

    it('should strip capabilities outside the default-allowed set', async () => {
      const server = makeServer({
        security: { runAsUser: 1000, addCapabilities: ['SYS_NICE', 'NET_BIND_SERVICE'] },
      })
      await reconciler.reconcile(server)
      const container = capturedContainer(appsApi)
      const caps = container.securityContext?.capabilities?.add ?? []
      expect(caps).toEqual(['NET_BIND_SERVICE'])
    })
  })

  // ════════════════════════════════════════════════════════════════════
  // HIGH: env var injection — block PATH, LD_PRELOAD, NODE_OPTIONS
  // ════════════════════════════════════════════════════════════════════

  describe('dangerous env var stripping', () => {
    it('should strip LD_PRELOAD from env', async () => {
      const server = makeServer({
        env: [
          { name: 'LD_PRELOAD', value: '/tmp/evil.so' },
          { name: 'MY_CONFIG', value: 'safe' },
        ],
      })
      await reconciler.reconcile(server)
      const container = capturedContainer(appsApi)
      const envNames = container.env?.map(e => e.name) ?? []
      expect(envNames).not.toContain('LD_PRELOAD')
      expect(envNames).toContain('MY_CONFIG')
    })

    it('should strip PATH override', async () => {
      const server = makeServer({
        env: [{ name: 'PATH', value: '/tmp/evil:$PATH' }],
      })
      await reconciler.reconcile(server)
      const container = capturedContainer(appsApi)
      const envNames = container.env?.map(e => e.name) ?? []
      expect(envNames).not.toContain('PATH')
    })

    it('should strip NODE_OPTIONS', async () => {
      const server = makeServer({
        env: [{ name: 'NODE_OPTIONS', value: '--require /tmp/evil.js' }],
      })
      await reconciler.reconcile(server)
      const container = capturedContainer(appsApi)
      const envNames = container.env?.map(e => e.name) ?? []
      expect(envNames).not.toContain('NODE_OPTIONS')
    })

    it('should strip KUBECONFIG and K8s service env vars', async () => {
      const server = makeServer({
        env: [
          { name: 'KUBECONFIG', value: '/tmp/kubeconfig' },
          { name: 'KUBERNETES_SERVICE_HOST', value: '10.0.0.1' },
          { name: 'KUBERNETES_SERVICE_PORT', value: '443' },
        ],
      })
      await reconciler.reconcile(server)
      const container = capturedContainer(appsApi)
      const envNames = container.env?.map(e => e.name) ?? []
      expect(envNames).not.toContain('KUBECONFIG')
      expect(envNames).not.toContain('KUBERNETES_SERVICE_HOST')
      expect(envNames).not.toContain('KUBERNETES_SERVICE_PORT')
    })

    it('should allow safe env vars', async () => {
      const server = makeServer({
        env: [
          { name: 'DATABASE_URL', value: 'postgres://...' },
          { name: 'API_KEY', value: 'key123' },
          { name: 'LOG_LEVEL', value: 'debug' },
        ],
      })
      await reconciler.reconcile(server)
      const container = capturedContainer(appsApi)
      const envNames = container.env?.map(e => e.name) ?? []
      expect(envNames).toContain('DATABASE_URL')
      expect(envNames).toContain('API_KEY')
      expect(envNames).toContain('LOG_LEVEL')
    })

    it('should handle mixed safe and dangerous env vars', async () => {
      const server = makeServer({
        env: [
          { name: 'LD_PRELOAD', value: 'evil' },
          { name: 'SAFE_VAR', value: 'ok' },
          { name: 'PATH', value: 'evil' },
          { name: 'ANOTHER_SAFE', value: 'ok' },
          { name: 'NODE_OPTIONS', value: 'evil' },
        ],
      })
      await reconciler.reconcile(server)
      const container = capturedContainer(appsApi)
      const envNames = container.env?.map(e => e.name) ?? []
      expect(envNames).toEqual(expect.arrayContaining(['SAFE_VAR', 'ANOTHER_SAFE']))
      expect(envNames).not.toContain('LD_PRELOAD')
      expect(envNames).not.toContain('PATH')
      expect(envNames).not.toContain('NODE_OPTIONS')
    })
  })

  // ════════════════════════════════════════════════════════════════════
  // Combined attack vector: multiple dangerous fields in one CRD
  // ════════════════════════════════════════════════════════════════════

  describe('combined attack vectors', () => {
    it('should sanitize ALL dangerous fields in a single malicious CRD', async () => {
      const server = makeServer({
        imagePullPolicy: 'Always',
        security: {
          runAsUser: 0,
          runAsGroup: 0,
          addCapabilities: ['SYS_ADMIN', 'NET_ADMIN', 'CHOWN'],
        },
        env: [
          { name: 'LD_PRELOAD', value: '/evil.so' },
          { name: 'PATH', value: '/evil' },
          { name: 'SAFE_VAR', value: 'ok' },
        ],
      })

      await reconciler.reconcile(server)

      const dep = capturedDeployment(appsApi)
      const podSec = dep.spec!.template.spec!.securityContext!
      const container = capturedContainer(appsApi)

      // imagePullPolicy: platform wins
      expect(container.imagePullPolicy).toBe('IfNotPresent')

      // runAsUser: forced to 1000
      expect(podSec.runAsUser).toBe(1000)
      expect(podSec.runAsGroup).toBe(1000)

      // capabilities: only CHOWN survives
      const caps = container.securityContext?.capabilities?.add ?? []
      expect(caps).toEqual(['CHOWN'])
      expect(caps).not.toContain('SYS_ADMIN')

      // env: only SAFE_VAR survives
      const envNames = container.env?.map(e => e.name) ?? []
      expect(envNames).toContain('SAFE_VAR')
      expect(envNames).not.toContain('LD_PRELOAD')
      expect(envNames).not.toContain('PATH')
    })
  })

  // ════════════════════════════════════════════════════════════════════
  // Platform invariants: fields that MUST always be platform-controlled
  // ════════════════════════════════════════════════════════════════════

  describe('platform invariants', () => {
    it('should always set labels with managed-by=host-context-controller', async () => {
      const server = makeServer()
      await reconciler.reconcile(server)
      const dep = capturedDeployment(appsApi)
      expect(dep.metadata!.labels!['clerum.io/managed-by']).toBe('host-context-controller')
    })

    it('should always set replicas to 1 regardless of CRD', async () => {
      const server = makeServer()
      await reconciler.reconcile(server)
      const dep = capturedDeployment(appsApi)
      expect(dep.spec!.replicas).toBe(1)
    })

    it('should never set hostNetwork', async () => {
      const server = makeServer()
      await reconciler.reconcile(server)
      const dep = capturedDeployment(appsApi)
      expect(dep.spec!.template.spec!.hostNetwork).toBeUndefined()
    })

    it('should never set serviceAccountName from CRD', async () => {
      const server = makeServer()
      await reconciler.reconcile(server)
      const dep = capturedDeployment(appsApi)
      expect(dep.spec!.template.spec!.serviceAccountName).toBeUndefined()
    })

    it('should always deploy in the same namespace as the CRD', async () => {
      const server = makeServer()
      await reconciler.reconcile(server)
      const dep = capturedDeployment(appsApi)
      expect(dep.metadata!.namespace).toBe('mcp-server')
    })
  })
})
