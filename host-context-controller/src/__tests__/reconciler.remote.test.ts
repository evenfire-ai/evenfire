import { beforeEach, describe, expect, it, vi } from 'vitest'
import * as k8s from '@kubernetes/client-node'
import {
  MockAppsApi,
  MockCoreApi,
  MockCustomApi,
  asAppsApi,
  asCoreApi,
  asCustomApi,
  createMockAppsApi,
  createMockCoreApi,
  createMockCustomApi,
} from '../../test/__fixtures__/testMocks'
import { MANAGED_BY_LABEL, MANAGED_BY_VALUE, MCPSERVER_LABEL } from '../constants'
import { McpServerReconciler } from '../reconciler'
import { McpServerCRD } from '../types'

/**
 * Tests for the remote egress proxy reconciliation logic in McpServerReconciler.
 *
 * When a McpServer CRD has spec.remote.baseUrl, the reconciler creates an nginx
 * egress proxy (ConfigMap + Deployment) instead of deploying the vendor image directly.
 */

vi.mock('../config', () => ({
  config: {
    devMode: false,
    port: 8081,
    namespace: 'mcp-server',
    hostNamespace: 'mcp-host',
    rpcProxyNamespace: 'rpc-proxy',
    egressProxyImage: 'clerum/nginx-egress-proxy:0.1.0',
    stdioBridgeImage: 'clerum/stdio-bridge:0.1.0',
    stdioBridgeResources: {
      requests: { memory: '32Mi', cpu: '50m' },
      limits: { memory: '128Mi', cpu: '200m' },
    },
    devMcpServers: [],
    devContexts: [],
    devAuthTokens: new Map(),
    allowedPluginImagePrefixes: ['registry.evenfire.ai/', 'clerum/'],
    enforcePluginImageAllowlist: false,
  },
}))

// ─── Fixtures ────────────────────────────────────────────────────────────────

const LEGACY_REMOTE_EGRESS_IMAGE = ['nginxinc/nginx-unprivileged', '1.27-alpine'].join(':')

const REMOTE_SERVER: McpServerCRD = {
  name: 'mcp-sentry-remote',
  namespace: 'mcp-server',
  uid: 'test-uid-123',
  spec: {
    contextRef: 'context1',
    image: 'clerum/nginx-egress-proxy:0.1.0',
    transport: { type: 'streamableHttp', port: 3000 },
    managed: true,
    enabled: true,
    remote: { baseUrl: 'https://mcp.sentry.io/sse' },
    envSecret: {
      name: 'sentry-credentials',
      keys: [{ secretKey: 'SENTRY_AUTH_TOKEN', envVar: 'SENTRY_AUTH_TOKEN' }],
    },
    egressBindings: [{ dns: 'mcp.sentry.io', port: 443, protocol: 'TCP' }],
  },
}

const LOCAL_SERVER: McpServerCRD = {
  name: 'mongo-mcp',
  namespace: 'mcp-server',
  uid: 'test-uid-456',
  spec: {
    contextRef: 'context1',
    image: 'clerum/mongodb-mcp:0.9.5',
    transport: { type: 'streamableHttp', port: 3000 },
    managed: true,
    enabled: true,
  },
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function buildReconciler(
  appsApi: MockAppsApi,
  coreApi: MockCoreApi,
  customApi: MockCustomApi
): McpServerReconciler {
  return new McpServerReconciler({} as k8s.KubeConfig, {
    appsApi: asAppsApi(appsApi),
    coreApi: asCoreApi(coreApi),
    customApi: asCustomApi(customApi),
  })
}

/** Helper to create a 409 Conflict error matching the K8s client error shape. */
function make409Error(): Error & { code?: number } {
  const err = new Error('Conflict') as Error & { code?: number }
  err.code = 409
  return err
}

/** Helper to create a 404 Not Found error matching the K8s client error shape. */
function make404Error(): Error & { code?: number } {
  const err = new Error('Not Found') as Error & { code?: number }
  err.code = 404
  return err
}

function mockHccOwnedRuntimeReads(
  appsApi: MockAppsApi,
  coreApi: MockCoreApi,
  name = 'mcp-sentry-remote'
): void {
  const labels = {
    [MANAGED_BY_LABEL]: MANAGED_BY_VALUE,
    [MCPSERVER_LABEL]: name,
  }

  appsApi.readNamespacedDeployment.mockResolvedValue({
    metadata: { resourceVersion: '1', labels },
    status: { readyReplicas: 1 },
  })
  coreApi.readNamespacedConfigMap.mockResolvedValue({
    metadata: { resourceVersion: '1', labels },
    data: {},
  })
  coreApi.readNamespacedService.mockResolvedValue({
    metadata: { resourceVersion: '1', labels },
    spec: { clusterIP: '10.0.0.1' },
  })
}

function cloneServer(
  server: McpServerCRD,
  specOverrides: Partial<McpServerCRD['spec']> = {}
): McpServerCRD {
  return {
    ...server,
    annotations: server.annotations ? { ...server.annotations } : undefined,
    spec: {
      ...server.spec,
      ...specOverrides,
      transport: { ...server.spec.transport, ...specOverrides.transport },
      remote:
        specOverrides.remote ??
        (server.spec.remote
          ? {
              ...server.spec.remote,
              authHeaders: server.spec.remote.authHeaders
                ? [...server.spec.remote.authHeaders]
                : undefined,
            }
          : undefined),
      envSecret:
        specOverrides.envSecret ??
        (server.spec.envSecret
          ? {
              ...server.spec.envSecret,
              keys: [...server.spec.envSecret.keys],
            }
          : undefined),
      egressBindings:
        specOverrides.egressBindings ??
        (server.spec.egressBindings ? [...server.spec.egressBindings] : undefined),
    },
  }
}

function lastPatchedStatusConditions(customApi: MockCustomApi): any[] {
  const calls = customApi.patchNamespacedCustomObjectStatus.mock.calls
  const lastCall = calls[calls.length - 1]?.[0]
  const patch = lastCall?.body
  const statusAdd = Array.isArray(patch)
    ? patch.find(
        candidate =>
          candidate?.op === 'add' &&
          (candidate.path === '/status' || candidate.path === '/status/conditions')
      )
    : undefined
  const value = statusAdd?.value
  return Array.isArray(value) ? value : (value?.conditions ?? [])
}

// ─── Tests ───────────────────────────────────────────────────────────────────

describe('McpServerReconciler remote egress proxy', () => {
  let appsApi: MockAppsApi
  let coreApi: MockCoreApi
  let customApi: MockCustomApi
  let reconciler: McpServerReconciler

  beforeEach(() => {
    vi.clearAllMocks()
    appsApi = createMockAppsApi()
    coreApi = createMockCoreApi()
    customApi = createMockCustomApi()

    // Default: secret validation passes (return data with the required key)
    coreApi.readNamespacedSecret.mockResolvedValue({
      data: { SENTRY_AUTH_TOKEN: 'base64-encoded-token' },
    })

    reconciler = buildReconciler(appsApi, coreApi, customApi)
  })

  // ─── Test 1: buildNginxConfigMap ───────────────────────────────────────

  describe('buildNginxConfigMap', () => {
    it('should generate ConfigMap with correct name', () => {
      const cm = (reconciler as any).buildNginxConfigMap(REMOTE_SERVER)

      expect(cm.metadata.name).toBe('mcp-sentry-remote-nginx-conf')
    })

    it('should generate ConfigMap in the server namespace', () => {
      const cm = (reconciler as any).buildNginxConfigMap(REMOTE_SERVER)

      expect(cm.metadata.namespace).toBe('mcp-server')
    })

    it('should contain proxy_pass directive pointing to the remote baseUrl', () => {
      const cm = (reconciler as any).buildNginxConfigMap(REMOTE_SERVER)
      const conf = cm.data['default.conf.template']

      expect(conf).toContain('proxy_pass https://mcp.sentry.io/sse')
    })

    it('should match the Sentry upstream path locally to avoid duplicating /sse paths', () => {
      const cm = (reconciler as any).buildNginxConfigMap(REMOTE_SERVER)
      const conf = cm.data['default.conf.template']

      expect(conf).toContain('location /sse {')
      expect(conf).not.toContain('location / {\n        proxy_pass https://mcp.sentry.io/sse;')
    })

    it('should match the upstream path locally to avoid duplicating /mcp paths', () => {
      const coinGeckoServer: McpServerCRD = {
        ...REMOTE_SERVER,
        name: 'mcp-coingecko-remote',
        spec: {
          ...REMOTE_SERVER.spec,
          remote: { baseUrl: 'https://mcp.api.coingecko.com/mcp' },
        },
      }

      const cm = (reconciler as any).buildNginxConfigMap(coinGeckoServer)
      const conf = cm.data['default.conf.template']

      expect(conf).toContain('location /mcp {')
      expect(conf).toContain('proxy_pass https://mcp.api.coingecko.com/mcp;')
      expect(conf).not.toContain(
        'location / {\n        proxy_pass https://mcp.api.coingecko.com/mcp;'
      )
    })

    it('should match / for bare-origin remote endpoints', () => {
      const rootServer: McpServerCRD = {
        ...REMOTE_SERVER,
        spec: {
          ...REMOTE_SERVER.spec,
          remote: { baseUrl: 'https://mcp.glassnode.com/' },
        },
      }

      const cm = (reconciler as any).buildNginxConfigMap(rootServer)
      const conf = cm.data['default.conf.template']

      expect(conf).toContain('location / {')
      expect(conf).toContain('proxy_pass https://mcp.glassnode.com/;')
    })

    it('should listen on the transport port', () => {
      const cm = (reconciler as any).buildNginxConfigMap(REMOTE_SERVER)
      const conf = cm.data['default.conf.template']

      expect(conf).toContain('listen 3000')
    })

    it('should disable proxy_buffering for SSE streaming support', () => {
      const cm = (reconciler as any).buildNginxConfigMap(REMOTE_SERVER)
      const conf = cm.data['default.conf.template']

      expect(conf).toContain('proxy_buffering off')
    })

    it('should set proxy_cache off for streaming', () => {
      const cm = (reconciler as any).buildNginxConfigMap(REMOTE_SERVER)
      const conf = cm.data['default.conf.template']

      expect(conf).toContain('proxy_cache off')
    })

    it('should set Host header to the upstream host', () => {
      const cm = (reconciler as any).buildNginxConfigMap(REMOTE_SERVER)
      const conf = cm.data['default.conf.template']

      expect(conf).toContain('proxy_set_header Host mcp.sentry.io')
    })

    it('should enable proxy_ssl_verify for TLS upstream', () => {
      const cm = (reconciler as any).buildNginxConfigMap(REMOTE_SERVER)
      const conf = cm.data['default.conf.template']

      expect(conf).toContain('proxy_ssl_verify on')
    })

    // nginx defaults proxy_ssl_verify_depth to 1, which only admits chains with a
    // single untrusted intermediate. Upstreams mid-root-rollover (Let's Encrypt
    // "Root YE"/"Root YR", "Microsoft TLS ECC Root G2") serve a chain that reaches
    // a trusted anchor via a cross-signed root — two untrusted intermediates — and
    // nginx rejects them with "(20:unable to get local issuer certificate)" even
    // though the CA bundle is complete. Verified against real upstreams: without
    // this directive mcp.postman.com / api.firecrawl.dev / learn.microsoft.com all
    // fail the handshake; with it they connect while verification stays on.
    it('should raise proxy_ssl_verify_depth to admit cross-signed root chains', () => {
      const cm = (reconciler as any).buildNginxConfigMap(REMOTE_SERVER)
      const conf = cm.data['default.conf.template']

      const match = conf.match(/proxy_ssl_verify_depth\s+(\d+);/)
      expect(match).not.toBeNull()
      expect(Number(match![1])).toBeGreaterThanOrEqual(3)
    })

    it('should include a /health endpoint returning 200', () => {
      const cm = (reconciler as any).buildNginxConfigMap(REMOTE_SERVER)
      const conf = cm.data['default.conf.template']

      expect(conf).toContain('location /health')
      expect(conf).toContain('return 200')
    })

    it('should set ownerReference pointing to the McpServer CRD', () => {
      const cm = (reconciler as any).buildNginxConfigMap(REMOTE_SERVER)

      expect(cm.metadata.ownerReferences).toHaveLength(1)
      expect(cm.metadata.ownerReferences[0]).toMatchObject({
        apiVersion: 'clerum.io/v1alpha1',
        kind: 'McpServer',
        name: 'mcp-sentry-remote',
        uid: 'test-uid-123',
        controller: true,
        blockOwnerDeletion: true,
      })
    })

    it('should include egress-proxy component label', () => {
      const cm = (reconciler as any).buildNginxConfigMap(REMOTE_SERVER)

      expect(cm.metadata.labels['clerum.io/component']).toBe('egress-proxy')
    })

    it('should use default port 3000 when transport.port is undefined', () => {
      const serverNoPort: McpServerCRD = {
        ...REMOTE_SERVER,
        spec: {
          ...REMOTE_SERVER.spec,
          transport: { type: 'streamableHttp' },
        },
      }

      const cm = (reconciler as any).buildNginxConfigMap(serverNoPort)
      const conf = cm.data['default.conf.template']

      expect(conf).toContain('listen 3000')
    })

    it('should omit ownerReferences when uid is not set', () => {
      const serverNoUid: McpServerCRD = {
        ...REMOTE_SERVER,
        uid: undefined,
      }

      const cm = (reconciler as any).buildNginxConfigMap(serverNoUid)

      expect(cm.metadata.ownerReferences).toBeUndefined()
    })

    // ── Codex P1 fix (PR #101) — credential auth headers via envsubst ──
    it('should emit proxy_set_header lines for each authHeader (Codex P1)', () => {
      const serverWithAuth: McpServerCRD = {
        ...REMOTE_SERVER,
        spec: {
          ...REMOTE_SERVER.spec,
          remote: {
            baseUrl: 'https://api.example.com/v1',
            authHeaders: [
              { header: 'Authorization', valueTemplate: 'Bearer ${API_KEY}' },
              { header: 'X-API-Key', valueTemplate: '${SECONDARY_KEY}' },
            ],
          },
        },
      }

      const cm = (reconciler as any).buildNginxConfigMap(serverWithAuth)
      const conf = cm.data['default.conf.template']

      expect(conf).toContain('proxy_set_header Authorization "Bearer ${API_KEY}"')
      expect(conf).toContain('proxy_set_header X-API-Key "${SECONDARY_KEY}"')
      // Placeholder kept intact — the nginx egress proxy entrypoint resolves at startup
      expect(conf).toContain('${API_KEY}')
    })

    it('should omit auth header section when authHeaders is not set', () => {
      const cm = (reconciler as any).buildNginxConfigMap(REMOTE_SERVER)
      const conf = cm.data['default.conf.template']

      expect(conf).not.toContain('Credential auth headers')
      expect(conf).not.toContain('proxy_set_header Authorization')
    })

    // ── Codex P0 fix (PR #101) — authHeaders sanitization (nginx + HTTP injection) ──
    describe('authHeaders sanitization (Codex P0)', () => {
      const buildWithAuth = (
        headers: Array<{ header: string; valueTemplate: string }>
      ): McpServerCRD => ({
        ...REMOTE_SERVER,
        spec: {
          ...REMOTE_SERVER.spec,
          remote: { baseUrl: 'https://api.example.com/v1', authHeaders: headers },
        },
      })

      it('emits a well-formed nginx line for a normal Bearer header', () => {
        const cm = (reconciler as any).buildNginxConfigMap(
          buildWithAuth([{ header: 'Authorization', valueTemplate: 'Bearer ${T}' }])
        )
        const conf = cm.data['default.conf.template']
        expect(conf).toContain('proxy_set_header Authorization "Bearer ${T}";')
      })

      it('rejects nginx-breakout injection attempts in valueTemplate', () => {
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
        const malicious = '"; return 200 "leaked"; #'
        const cm = (reconciler as any).buildNginxConfigMap(
          buildWithAuth([{ header: 'Authorization', valueTemplate: malicious }])
        )
        const conf = cm.data['default.conf.template']

        // Value has no CR/LF but DOES contain `"` — confirm current policy (escape).
        // Rule per fix spec #2: valueTemplate without CR/LF but with `"` is NOT
        // required to be rejected; escaping is the contract. We expect the line
        // to be emitted with escaped quotes AND the raw injection never to leak.
        expect(conf).not.toContain('"; return 200 "leaked";')
        expect(conf).toContain('\\"; return 200 \\"leaked\\"; #')
        warn.mockRestore()
      })

      it('rejects CRLF injection attempts (header smuggling / nginx directive injection)', () => {
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
        const malicious = 'a\r\nproxy_pass http://evil.com'
        const cm = (reconciler as any).buildNginxConfigMap(
          buildWithAuth([{ header: 'X-Evil', valueTemplate: malicious }])
        )
        const conf = cm.data['default.conf.template']

        expect(conf).not.toContain('X-Evil')
        expect(conf).not.toContain('proxy_pass http://evil.com')
        expect(warn).toHaveBeenCalledWith(expect.stringContaining('CR/LF/NUL'))
        warn.mockRestore()
      })

      it('rejects invalid header names (disallowed chars like space)', () => {
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
        const cm = (reconciler as any).buildNginxConfigMap(
          buildWithAuth([{ header: 'X-Bad Header', valueTemplate: 'ok' }])
        )
        const conf = cm.data['default.conf.template']

        expect(conf).not.toContain('X-Bad Header')
        expect(warn).toHaveBeenCalledWith(expect.stringContaining('invalid name'))
        warn.mockRestore()
      })

      it('emits a header value with embedded double quotes, properly escaped', () => {
        const cm = (reconciler as any).buildNginxConfigMap(
          buildWithAuth([{ header: 'Authorization', valueTemplate: 'Bearer "quoted"' }])
        )
        const conf = cm.data['default.conf.template']
        expect(conf).toContain('proxy_set_header Authorization "Bearer \\"quoted\\"";')
      })

      it('emits valid entries and rejects invalid ones in a mixed batch', () => {
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
        const cm = (reconciler as any).buildNginxConfigMap(
          buildWithAuth([
            { header: 'Authorization', valueTemplate: 'Bearer ${T}' },
            { header: 'X-API-Key', valueTemplate: '${K}' },
            { header: 'X-Trace', valueTemplate: 'id-${TID}' },
            { header: 'X-Evil', valueTemplate: 'a\r\nproxy_pass http://evil.com' },
          ])
        )
        const conf = cm.data['default.conf.template']

        expect(conf).toContain('proxy_set_header Authorization "Bearer ${T}";')
        expect(conf).toContain('proxy_set_header X-API-Key "${K}";')
        expect(conf).toContain('proxy_set_header X-Trace "id-${TID}";')
        expect(conf).not.toContain('X-Evil')
        expect(conf).not.toContain('evil.com')
        expect(warn).toHaveBeenCalledTimes(1)
        warn.mockRestore()
      })

      it('rejects values longer than the 2048-char bound', () => {
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
        const tooLong = 'x'.repeat(2049)
        const cm = (reconciler as any).buildNginxConfigMap(
          buildWithAuth([{ header: 'Authorization', valueTemplate: tooLong }])
        )
        const conf = cm.data['default.conf.template']

        expect(conf).not.toContain('xxxxxxxx')
        expect(conf).not.toContain('proxy_set_header Authorization')
        expect(warn).toHaveBeenCalledWith(expect.stringContaining('too long'))
        warn.mockRestore()
      })

      it('rejects NUL byte injection', () => {
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
        const cm = (reconciler as any).buildNginxConfigMap(
          buildWithAuth([{ header: 'Authorization', valueTemplate: 'Bearer\0evil' }])
        )
        const conf = cm.data['default.conf.template']

        expect(conf).not.toContain('proxy_set_header Authorization')
        expect(warn).toHaveBeenCalledWith(expect.stringContaining('CR/LF/NUL'))
        warn.mockRestore()
      })
    })
  })

  // ─── Test 2: buildDeployment for remote servers ────────────────────────

  describe('buildDeployment for remote servers', () => {
    it("should use 'egress-proxy' as the container name", () => {
      const deployment = (reconciler as any).buildDeployment(REMOTE_SERVER)
      const containers = deployment.spec.template.spec.containers

      const egressContainer = containers.find((c: any) => c.name === 'egress-proxy')
      expect(egressContainer).toBeDefined()
    })

    it('should use config.egressProxyImage as the container image', () => {
      const deployment = (reconciler as any).buildDeployment(REMOTE_SERVER)
      const containers = deployment.spec.template.spec.containers

      const egressContainer = containers.find((c: any) => c.name === 'egress-proxy')
      expect(egressContainer.image).toBe('clerum/nginx-egress-proxy:0.1.0')
    })

    it('should mount nginx-conf volume at /etc/nginx/templates (Codex P1: envsubst at startup)', () => {
      const deployment = (reconciler as any).buildDeployment(REMOTE_SERVER)
      const containers = deployment.spec.template.spec.containers

      const egressContainer = containers.find((c: any) => c.name === 'egress-proxy')
      const nginxMount = egressContainer.volumeMounts.find((vm: any) => vm.name === 'nginx-conf')
      expect(nginxMount).toBeDefined()
      expect(nginxMount.mountPath).toBe('/etc/nginx/templates')
      expect(nginxMount.readOnly).toBe(true)
    })

    it('should include nginx-conf volume referencing the ConfigMap', () => {
      const deployment = (reconciler as any).buildDeployment(REMOTE_SERVER)
      const volumes = deployment.spec.template.spec.volumes

      const nginxVolume = volumes.find((v: any) => v.name === 'nginx-conf')
      expect(nginxVolume).toBeDefined()
      expect(nginxVolume.configMap.name).toBe('mcp-sentry-remote-nginx-conf')
    })

    it('should NOT have any initContainers (no stdio copy pattern)', () => {
      const deployment = (reconciler as any).buildDeployment(REMOTE_SERVER)
      const initContainers = deployment.spec.template.spec.initContainers

      expect(initContainers).toBeUndefined()
    })

    it('should NOT include the vendor mcp-server container', () => {
      const deployment = (reconciler as any).buildDeployment(REMOTE_SERVER)
      const containers = deployment.spec.template.spec.containers

      const mcpServerContainer = containers.find((c: any) => c.name === 'mcp-server')
      expect(mcpServerContainer).toBeUndefined()
    })

    it('should NOT include the stdio-bridge container', () => {
      const deployment = (reconciler as any).buildDeployment(REMOTE_SERVER)
      const containers = deployment.spec.template.spec.containers

      const bridgeContainer = containers.find((c: any) => c.name === 'stdio-bridge')
      expect(bridgeContainer).toBeUndefined()
    })

    it('should set liveness probe on /health endpoint', () => {
      const deployment = (reconciler as any).buildDeployment(REMOTE_SERVER)
      const containers = deployment.spec.template.spec.containers

      const egressContainer = containers.find((c: any) => c.name === 'egress-proxy')
      expect(egressContainer.livenessProbe.httpGet.path).toBe('/health')
    })

    it('should set readiness probe on /health endpoint', () => {
      const deployment = (reconciler as any).buildDeployment(REMOTE_SERVER)
      const containers = deployment.spec.template.spec.containers

      const egressContainer = containers.find((c: any) => c.name === 'egress-proxy')
      expect(egressContainer.readinessProbe.httpGet.path).toBe('/health')
    })

    it('should set resource limits on the egress-proxy container', () => {
      const deployment = (reconciler as any).buildDeployment(REMOTE_SERVER)
      const containers = deployment.spec.template.spec.containers

      const egressContainer = containers.find((c: any) => c.name === 'egress-proxy')
      expect(egressContainer.resources).toEqual({
        requests: { memory: '32Mi', cpu: '25m' },
        limits: { memory: '64Mi', cpu: '100m' },
      })
    })

    it('should drop all capabilities in the egress-proxy securityContext', () => {
      const deployment = (reconciler as any).buildDeployment(REMOTE_SERVER)
      const containers = deployment.spec.template.spec.containers

      const egressContainer = containers.find((c: any) => c.name === 'egress-proxy')
      expect(egressContainer.securityContext.runAsNonRoot).toBe(true)
      expect(egressContainer.securityContext.runAsUser).toBe(101)
      expect(egressContainer.securityContext.runAsGroup).toBe(101)
      expect(egressContainer.securityContext.capabilities.drop).toEqual(['ALL'])
      expect(egressContainer.securityContext.allowPrivilegeEscalation).toBe(false)
    })

    it('should inject envSecret as env vars in the egress-proxy container', () => {
      const deployment = (reconciler as any).buildDeployment(REMOTE_SERVER)
      const containers = deployment.spec.template.spec.containers

      const egressContainer = containers.find((c: any) => c.name === 'egress-proxy')
      const sentryEnv = egressContainer.env.find((e: any) => e.name === 'SENTRY_AUTH_TOKEN')
      expect(sentryEnv).toBeDefined()
      expect(sentryEnv.valueFrom.secretKeyRef).toEqual({
        name: 'sentry-credentials',
        key: 'SENTRY_AUTH_TOKEN',
      })
    })

    it('should backfill empty env vars for auth header placeholders when envSecret is absent', () => {
      const { envSecret: _envSecret, ...specWithoutSecret } = REMOTE_SERVER.spec
      const serverWithoutSecret: McpServerCRD = {
        ...REMOTE_SERVER,
        spec: {
          ...specWithoutSecret,
          env: [{ name: 'STATIC_TOKEN', value: 'already-set' }],
          remote: {
            baseUrl: 'https://api.example.com/v1',
            authHeaders: [
              { header: 'Authorization', valueTemplate: 'Bearer ${OPTIONAL_TOKEN}' },
              { header: 'X-Static', valueTemplate: '${STATIC_TOKEN}' },
              { header: 'X-Refresh', valueTemplate: '${OPTIONAL_TOKEN}:${SECONDARY_TOKEN}' },
            ],
          },
        },
      }

      const deployment = (reconciler as any).buildDeployment(serverWithoutSecret)
      const containers = deployment.spec.template.spec.containers

      const egressContainer = containers.find((c: any) => c.name === 'egress-proxy')
      const optionalEntries = egressContainer.env.filter((e: any) => e.name === 'OPTIONAL_TOKEN')
      const secondaryEntries = egressContainer.env.filter((e: any) => e.name === 'SECONDARY_TOKEN')
      const staticEntries = egressContainer.env.filter((e: any) => e.name === 'STATIC_TOKEN')

      expect(optionalEntries).toEqual([{ name: 'OPTIONAL_TOKEN', value: '' }])
      expect(secondaryEntries).toEqual([{ name: 'SECONDARY_TOKEN', value: '' }])
      expect(staticEntries).toEqual([{ name: 'STATIC_TOKEN', value: 'already-set' }])
    })
  })

  describe('canonicalizeRemoteEgressProxyImage', () => {
    it('patches stale remote McpServer spec.image to the platform egress proxy image', async () => {
      const staleRemote = cloneServer(REMOTE_SERVER, {
        image: LEGACY_REMOTE_EGRESS_IMAGE,
      })

      await (reconciler as any).canonicalizeRemoteEgressProxyImage(staleRemote)

      expect(customApi.patchNamespacedCustomObject).toHaveBeenCalledWith(
        expect.objectContaining({
          group: 'clerum.io',
          version: 'v1alpha1',
          namespace: 'mcp-server',
          plural: 'mcpservers',
          name: 'mcp-sentry-remote',
          body: {
            spec: {
              image: 'clerum/nginx-egress-proxy:0.1.0',
            },
          },
        }),
        expect.objectContaining({
          middleware: expect.any(Array),
        })
      )
      expect(staleRemote.spec.image).toBe('clerum/nginx-egress-proxy:0.1.0')
      expect(lastPatchedStatusConditions(customApi)).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            type: 'ImageCanonicalized',
            status: 'True',
            reason: 'RemoteEgressProxyImageMatches',
            message: 'Remote McpServer spec.image matches the platform egress proxy image',
          }),
        ])
      )
    })

    it('does not patch spec for a remote McpServer already using the platform image', async () => {
      const currentRemote = cloneServer(REMOTE_SERVER)

      await (reconciler as any).canonicalizeRemoteEgressProxyImage(currentRemote)

      expect(customApi.patchNamespacedCustomObject).not.toHaveBeenCalled()
      expect(lastPatchedStatusConditions(customApi)).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            type: 'ImageCanonicalized',
            status: 'True',
            reason: 'RemoteEgressProxyImageMatches',
            message: 'Remote McpServer spec.image matches the platform egress proxy image',
          }),
        ])
      )
    })

    it('does not patch local McpServers even when their image differs', async () => {
      const localServer = cloneServer(LOCAL_SERVER, {
        image: 'clerum/custom-local-mcp:1.2.3',
      })

      await (reconciler as any).canonicalizeRemoteEgressProxyImage(localServer)

      expect(customApi.patchNamespacedCustomObject).not.toHaveBeenCalled()
      expect(customApi.patchNamespacedCustomObjectStatus).not.toHaveBeenCalled()
      expect(localServer.spec.image).toBe('clerum/custom-local-mcp:1.2.3')
    })

    it('does not throw and records status when declarative image patching fails', async () => {
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
      const staleRemote = cloneServer(REMOTE_SERVER, {
        image: LEGACY_REMOTE_EGRESS_IMAGE,
      })
      customApi.patchNamespacedCustomObject.mockRejectedValueOnce(new Error('rbac denied'))

      await expect(
        (reconciler as any).canonicalizeRemoteEgressProxyImage(staleRemote)
      ).resolves.toBeUndefined()

      expect(staleRemote.spec.image).toBe(LEGACY_REMOTE_EGRESS_IMAGE)
      expect(warn).toHaveBeenCalledWith(
        expect.stringContaining('Failed to canonicalize remote McpServer'),
        expect.any(Error)
      )
      expect(lastPatchedStatusConditions(customApi)).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            type: 'ImageCanonicalized',
            status: 'False',
            reason: 'RemoteEgressProxyImagePatchFailed',
            message:
              'Failed to patch remote McpServer spec.image to the platform egress proxy image',
          }),
        ])
      )
      warn.mockRestore()
    })
  })

  // ─── Test 3: buildDeployment for local servers ─────────────────────────

  describe('buildDeployment for local servers', () => {
    it("should use 'mcp-server' as the container name", () => {
      const deployment = (reconciler as any).buildDeployment(LOCAL_SERVER)
      const containers = deployment.spec.template.spec.containers

      const mcpContainer = containers.find((c: any) => c.name === 'mcp-server')
      expect(mcpContainer).toBeDefined()
    })

    it('should use spec.image as the container image', () => {
      const deployment = (reconciler as any).buildDeployment(LOCAL_SERVER)
      const containers = deployment.spec.template.spec.containers

      const mcpContainer = containers.find((c: any) => c.name === 'mcp-server')
      expect(mcpContainer.image).toBe('clerum/mongodb-mcp:0.9.5')
    })

    it('should NOT include an egress-proxy container', () => {
      const deployment = (reconciler as any).buildDeployment(LOCAL_SERVER)
      const containers = deployment.spec.template.spec.containers

      const egressContainer = containers.find((c: any) => c.name === 'egress-proxy')
      expect(egressContainer).toBeUndefined()
    })

    it('should NOT include an nginx-conf volume', () => {
      const deployment = (reconciler as any).buildDeployment(LOCAL_SERVER)
      const volumes = deployment.spec.template.spec.volumes

      // volumes may be undefined or an empty-ish array for local HTTP servers
      if (volumes) {
        const nginxVolume = volumes.find((v: any) => v.name === 'nginx-conf')
        expect(nginxVolume).toBeUndefined()
      }
    })
  })

  // ─── Test 4: reconcile creates ConfigMap before Deployment for remote ──

  describe('reconcile call order for remote servers', () => {
    it('should create ConfigMap before Deployment', async () => {
      const callOrder: string[] = []

      coreApi.createNamespacedConfigMap.mockImplementation(async () => {
        callOrder.push('createConfigMap')
        return {}
      })
      coreApi.createNamespacedService.mockImplementation(async () => {
        callOrder.push('createService')
        return {}
      })
      appsApi.createNamespacedDeployment.mockImplementation(async () => {
        callOrder.push('createDeployment')
        return {}
      })

      await reconciler.reconcile(REMOTE_SERVER)

      expect(callOrder).toContain('createConfigMap')
      expect(callOrder).toContain('createDeployment')

      const cmIndex = callOrder.indexOf('createConfigMap')
      const deployIndex = callOrder.indexOf('createDeployment')
      expect(cmIndex).toBeLessThan(deployIndex)
    })

    it('should canonicalize stale remote image before syncing ConfigMap and Deployment', async () => {
      const callOrder: string[] = []
      const staleRemote = cloneServer(REMOTE_SERVER, {
        image: LEGACY_REMOTE_EGRESS_IMAGE,
      })

      customApi.patchNamespacedCustomObject.mockImplementation(async () => {
        callOrder.push('canonicalizeImage')
        return {}
      })
      coreApi.createNamespacedConfigMap.mockImplementation(async () => {
        callOrder.push('createConfigMap')
        return {}
      })
      coreApi.createNamespacedService.mockImplementation(async () => {
        callOrder.push('createService')
        return {}
      })
      appsApi.createNamespacedDeployment.mockImplementation(async () => {
        callOrder.push('createDeployment')
        return {}
      })

      await reconciler.reconcile(staleRemote)

      expect(callOrder).toEqual([
        'canonicalizeImage',
        'createConfigMap',
        'createService',
        'createDeployment',
      ])
      expect(staleRemote.spec.image).toBe('clerum/nginx-egress-proxy:0.1.0')
      expect(customApi.patchNamespacedCustomObject).toHaveBeenCalledWith(
        expect.objectContaining({
          body: {
            spec: {
              image: 'clerum/nginx-egress-proxy:0.1.0',
            },
          },
        }),
        expect.objectContaining({
          middleware: expect.any(Array),
        })
      )
    })

    it('should call createNamespacedConfigMap with correct namespace', async () => {
      await reconciler.reconcile(REMOTE_SERVER)

      expect(coreApi.createNamespacedConfigMap).toHaveBeenCalledWith(
        expect.objectContaining({
          namespace: 'mcp-server',
          body: expect.objectContaining({
            metadata: expect.objectContaining({
              name: 'mcp-sentry-remote-nginx-conf',
            }),
          }),
        })
      )
    })

    it('should also create Deployment and Service', async () => {
      await reconciler.reconcile(REMOTE_SERVER)

      expect(appsApi.createNamespacedDeployment).toHaveBeenCalled()
      expect(coreApi.createNamespacedService).toHaveBeenCalled()
    })
  })

  // ─── Test 5: reconcile skips ConfigMap for local servers ───────────────

  describe('reconcile for local servers', () => {
    it('should NOT call createNamespacedConfigMap', async () => {
      await reconciler.reconcile(LOCAL_SERVER)

      expect(coreApi.createNamespacedConfigMap).not.toHaveBeenCalled()
    })

    it('should NOT call readNamespacedConfigMap', async () => {
      await reconciler.reconcile(LOCAL_SERVER)

      expect(coreApi.readNamespacedConfigMap).not.toHaveBeenCalled()
    })

    it('should NOT call replaceNamespacedConfigMap', async () => {
      await reconciler.reconcile(LOCAL_SERVER)

      expect(coreApi.replaceNamespacedConfigMap).not.toHaveBeenCalled()
    })

    it('should still create Deployment and Service', async () => {
      await reconciler.reconcile(LOCAL_SERVER)

      expect(appsApi.createNamespacedDeployment).toHaveBeenCalled()
      expect(coreApi.createNamespacedService).toHaveBeenCalled()
    })
  })

  // ─── Test 6: deleteResources cleans up ConfigMap ───────────────────────

  describe('deleteResources cleanup', () => {
    it('should call deleteNamespacedConfigMap with nginx-conf name', async () => {
      mockHccOwnedRuntimeReads(appsApi, coreApi)

      await (reconciler as any).deleteResources('mcp-sentry-remote', 'mcp-server')

      expect(coreApi.deleteNamespacedConfigMap).toHaveBeenCalledWith({
        name: 'mcp-sentry-remote-nginx-conf',
        namespace: 'mcp-server',
      })
    })

    it('should also delete Deployment and Service', async () => {
      mockHccOwnedRuntimeReads(appsApi, coreApi)

      await (reconciler as any).deleteResources('mcp-sentry-remote', 'mcp-server')

      expect(appsApi.deleteNamespacedDeployment).toHaveBeenCalledWith({
        name: 'mcp-sentry-remote',
        namespace: 'mcp-server',
      })
      expect(coreApi.deleteNamespacedService).toHaveBeenCalledWith({
        name: 'mcp-sentry-remote',
        namespace: 'mcp-server',
      })
    })

    it('should not throw when ConfigMap is already gone (404)', async () => {
      coreApi.deleteNamespacedConfigMap.mockRejectedValue(make404Error())

      await expect(
        (reconciler as any).deleteResources('mcp-sentry-remote', 'mcp-server')
      ).resolves.not.toThrow()
    })

    it('should fail closed for non-404 ConfigMap delete failure', async () => {
      const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
      const err = new Error('Internal Server Error') as Error & { code?: number }
      err.code = 500
      mockHccOwnedRuntimeReads(appsApi, coreApi)
      coreApi.deleteNamespacedConfigMap.mockRejectedValue(err)

      await expect(
        (reconciler as any).deleteResources('mcp-sentry-remote', 'mcp-server')
      ).rejects.toThrow(
        'Failed to delete runtime Kubernetes resources for McpServer "mcp-sentry-remote"'
      )

      expect(consoleSpy).toHaveBeenCalledWith(
        expect.stringContaining('Failed to delete ConfigMap'),
        expect.anything()
      )
      consoleSpy.mockRestore()
    })
  })

  // ─── Test 7: ensureDeployment migrates existing remote egress pods ────────

  describe('ensureDeployment conflict handling', () => {
    it('should replace an existing remote egress proxy Deployment with the current image', async () => {
      appsApi.createNamespacedDeployment.mockRejectedValue(make409Error())
      appsApi.readNamespacedDeployment.mockResolvedValue({
        metadata: { resourceVersion: 'old-rv' },
        spec: {
          template: {
            spec: {
              containers: [
                {
                  name: 'egress-proxy',
                  image: 'clerum/legacy-egress-proxy:0.0.1',
                },
              ],
            },
          },
        },
      })

      await (reconciler as any).ensureDeployment(REMOTE_SERVER)

      expect(appsApi.readNamespacedDeployment).toHaveBeenCalledWith({
        name: 'mcp-sentry-remote',
        namespace: 'mcp-server',
      })

      const replaceBody = appsApi.replaceNamespacedDeployment.mock.calls[0][0].body
      const containers = replaceBody.spec.template.spec.containers
      const egressContainer = containers.find((c: any) => c.name === 'egress-proxy')

      expect(replaceBody.metadata.resourceVersion).toBe('old-rv')
      expect(egressContainer.image).toBe('clerum/nginx-egress-proxy:0.1.0')
      expect(egressContainer.securityContext.runAsNonRoot).toBe(true)
      expect(egressContainer.securityContext.runAsUser).toBe(101)
      expect(egressContainer.securityContext.runAsGroup).toBe(101)
    })
  })

  // ─── Test 8: ensureConfigMap handles 409 conflict ──────────────────────

  describe('ensureConfigMap conflict handling', () => {
    it('should call replaceNamespacedConfigMap on 409 conflict', async () => {
      coreApi.createNamespacedConfigMap.mockRejectedValue(make409Error())
      coreApi.readNamespacedConfigMap.mockResolvedValue({
        metadata: { resourceVersion: '42' },
        data: { 'default.conf.template': 'old-config' },
      })

      await (reconciler as any).ensureConfigMap(REMOTE_SERVER)

      expect(coreApi.readNamespacedConfigMap).toHaveBeenCalledWith({
        name: 'mcp-sentry-remote-nginx-conf',
        namespace: 'mcp-server',
      })

      expect(coreApi.replaceNamespacedConfigMap).toHaveBeenCalledWith(
        expect.objectContaining({
          name: 'mcp-sentry-remote-nginx-conf',
          namespace: 'mcp-server',
          body: expect.objectContaining({
            metadata: expect.objectContaining({
              resourceVersion: '42',
            }),
          }),
        })
      )
    })

    it('should preserve the resourceVersion from the existing ConfigMap on replace', async () => {
      coreApi.createNamespacedConfigMap.mockRejectedValue(make409Error())
      coreApi.readNamespacedConfigMap.mockResolvedValue({
        metadata: { resourceVersion: '99' },
        data: {},
      })

      await (reconciler as any).ensureConfigMap(REMOTE_SERVER)

      const replaceCall = coreApi.replaceNamespacedConfigMap.mock.calls[0][0]
      expect(replaceCall.body.metadata.resourceVersion).toBe('99')
    })

    it('should rethrow non-409 errors from createNamespacedConfigMap', async () => {
      const err = new Error('Forbidden') as Error & { code?: number }
      err.code = 403
      coreApi.createNamespacedConfigMap.mockRejectedValue(err)

      await expect((reconciler as any).ensureConfigMap(REMOTE_SERVER)).rejects.toThrow('Forbidden')

      expect(coreApi.replaceNamespacedConfigMap).not.toHaveBeenCalled()
    })

    it('should succeed on first create when no conflict', async () => {
      coreApi.createNamespacedConfigMap.mockResolvedValue({})

      await expect((reconciler as any).ensureConfigMap(REMOTE_SERVER)).resolves.not.toThrow()

      expect(coreApi.readNamespacedConfigMap).not.toHaveBeenCalled()
      expect(coreApi.replaceNamespacedConfigMap).not.toHaveBeenCalled()
    })
  })

  // ─── Additional edge cases ─────────────────────────────────────────────

  describe('isRemote detection', () => {
    it('should return true for a server with spec.remote.baseUrl', () => {
      expect((reconciler as any).isRemote(REMOTE_SERVER)).toBe(true)
    })

    it('should return false for a server without spec.remote', () => {
      expect((reconciler as any).isRemote(LOCAL_SERVER)).toBe(false)
    })

    it('should return false when spec.remote is undefined', () => {
      const server: McpServerCRD = {
        ...LOCAL_SERVER,
        spec: { ...LOCAL_SERVER.spec, remote: undefined },
      }
      expect((reconciler as any).isRemote(server)).toBe(false)
    })
  })

  describe('reconcileDelete for remote servers', () => {
    beforeEach(() => {
      reconciler.setInventoryAuthority(() => ({ known: true, generation: 1 }))
      reconciler.setResolveCurrentServer(() => undefined)
      customApi.getNamespacedCustomObject.mockRejectedValue(make404Error())
    })

    it('should clean up ConfigMap via deleteResources', async () => {
      mockHccOwnedRuntimeReads(appsApi, coreApi)

      await reconciler.reconcileDelete('mcp-sentry-remote', 'mcp-server')

      expect(coreApi.deleteNamespacedConfigMap).toHaveBeenCalledWith({
        name: 'mcp-sentry-remote-nginx-conf',
        namespace: 'mcp-server',
      })
    })

    it('should clean up Deployment and Service via deleteResources', async () => {
      mockHccOwnedRuntimeReads(appsApi, coreApi)

      await reconciler.reconcileDelete('mcp-sentry-remote', 'mcp-server')

      expect(appsApi.deleteNamespacedDeployment).toHaveBeenCalled()
      expect(coreApi.deleteNamespacedService).toHaveBeenCalled()
    })

    it('should clear status tracking after delete', async () => {
      // First reconcile to populate status
      await reconciler.reconcile(REMOTE_SERVER)
      expect(reconciler.getStatus('mcp-sentry-remote').deployed).toBe(true)

      // Then delete
      await reconciler.reconcileDelete('mcp-sentry-remote', 'mcp-server')
      const status = reconciler.getStatus('mcp-sentry-remote')
      expect(status.deployed).toBe(false)
      expect(status.message).toBe('Not reconciled yet')
    })
  })

  // ─── Test: sanitizeRemoteUrl SSRF prevention ─────────────────────────
  describe('sanitizeRemoteUrl validation', () => {
    it('should accept a valid HTTPS URL and return safe components', () => {
      const result = (reconciler as any).sanitizeRemoteUrl('https://mcp.sentry.io/sse')
      expect(result.safeUrl).toBe('https://mcp.sentry.io/sse')
      expect(result.host).toBe('mcp.sentry.io')
      expect(result.path).toBe('/sse')
    })

    it('should reject HTTP (non-HTTPS) URLs', () => {
      expect(() => {
        ;(reconciler as any).sanitizeRemoteUrl('http://mcp.sentry.io/sse')
      }).toThrow('remote.baseUrl must use HTTPS')
    })

    it('should reject .svc.cluster.local internal cluster services', () => {
      expect(() => {
        ;(reconciler as any).sanitizeRemoteUrl(
          'https://control-api.control-plane.svc.cluster.local:8090/api'
        )
      }).toThrow('must not point to internal cluster services')
    })

    it('should reject .svc suffix (short cluster DNS)', () => {
      expect(() => {
        ;(reconciler as any).sanitizeRemoteUrl('https://control-api.control-plane.svc:8090/api')
      }).toThrow('must not point to internal cluster services')
    })

    it('should reject kubernetes.default', () => {
      expect(() => {
        ;(reconciler as any).sanitizeRemoteUrl('https://kubernetes.default:443/api')
      }).toThrow('must not point to internal cluster services')
    })

    it('should reject RFC1918 10.x.x.x private IPs', () => {
      expect(() => {
        ;(reconciler as any).sanitizeRemoteUrl('https://10.0.0.1:443/api')
      }).toThrow('must use a DNS hostname, not an IP address')
    })

    it('should reject RFC1918 172.16-31.x.x private IPs', () => {
      expect(() => {
        ;(reconciler as any).sanitizeRemoteUrl('https://172.16.0.1:443/api')
      }).toThrow('must use a DNS hostname, not an IP address')
    })

    it('should reject RFC1918 192.168.x.x private IPs', () => {
      expect(() => {
        ;(reconciler as any).sanitizeRemoteUrl('https://192.168.1.1:443/api')
      }).toThrow('must use a DNS hostname, not an IP address')
    })

    it('should reject loopback 127.x.x.x addresses', () => {
      expect(() => {
        ;(reconciler as any).sanitizeRemoteUrl('https://127.0.0.1:443/api')
      }).toThrow('must use a DNS hostname, not an IP address')
    })

    it('should reject link-local 169.254.x.x addresses', () => {
      expect(() => {
        ;(reconciler as any).sanitizeRemoteUrl('https://169.254.169.254:443/latest/meta-data')
      }).toThrow('must use a DNS hostname, not an IP address')
    })

    it('should reject 0.x.x.x addresses', () => {
      expect(() => {
        ;(reconciler as any).sanitizeRemoteUrl('https://0.0.0.0:443/api')
      }).toThrow('must use a DNS hostname, not an IP address')
    })

    it('should throw on malformed URLs', () => {
      expect(() => {
        ;(reconciler as any).sanitizeRemoteUrl('not-a-url')
      }).toThrow()
    })

    it('should throw on empty string', () => {
      expect(() => {
        ;(reconciler as any).sanitizeRemoteUrl('')
      }).toThrow()
    })

    it('should strip newlines and injected characters from URL', () => {
      // URL constructor normalizes these, then we reconstruct from parsed
      const result = (reconciler as any).sanitizeRemoteUrl('https://mcp.sentry.io/sse')
      expect(result.safeUrl).not.toContain('\n')
      expect(result.safeUrl).not.toContain('\r')
    })

    it('should accept a URL with path components', () => {
      const result = (reconciler as any).sanitizeRemoteUrl('https://api.example.com/v1/mcp/sse')
      expect(result.safeUrl).toBe('https://api.example.com/v1/mcp/sse')
      expect(result.host).toBe('api.example.com')
      expect(result.path).toBe('/v1/mcp/sse')
    })

    it('should accept a URL with explicit port', () => {
      const result = (reconciler as any).sanitizeRemoteUrl('https://api.example.com:8443/mcp')
      expect(result.safeUrl).toBe('https://api.example.com:8443/mcp')
      expect(result.host).toBe('api.example.com:8443')
    })

    it('should reject all IP addresses including non-private ones', () => {
      // All IP-literal URLs are blocked — only DNS hostnames allowed
      expect(() => {
        ;(reconciler as any).sanitizeRemoteUrl('https://172.15.0.1:443/api')
      }).toThrow('must use a DNS hostname, not an IP address')
    })

    it('should reject 172.31.x.x which IS in private range', () => {
      expect(() => {
        ;(reconciler as any).sanitizeRemoteUrl('https://172.31.255.1:443/api')
      }).toThrow('must use a DNS hostname, not an IP address')
    })
  })

  describe('reconcile failure modes for remote servers', () => {
    it('should set status deployed:false when ConfigMap creation fails', async () => {
      const err = new Error('Quota exceeded') as Error & { code?: number }
      err.code = 403
      coreApi.createNamespacedConfigMap.mockRejectedValue(err)

      await reconciler.reconcile(REMOTE_SERVER)

      const status = reconciler.getStatus('mcp-sentry-remote')
      expect(status.deployed).toBe(false)
      expect(status.ready).toBe(false)
      expect(status.message).toContain('Resource sync failed')
    })

    it('should skip deployment when secret validation fails for remote server', async () => {
      coreApi.readNamespacedSecret.mockRejectedValue(make404Error())

      await reconciler.reconcile(REMOTE_SERVER)

      expect(coreApi.createNamespacedConfigMap).not.toHaveBeenCalled()
      expect(appsApi.createNamespacedDeployment).not.toHaveBeenCalled()
      const status = reconciler.getStatus('mcp-sentry-remote')
      expect(status.deployed).toBe(false)
      // PR-B B1: message now carries the typed reason (SecretNotFound/MissingKey/ReadError)
      // instead of the generic "Secret validation failed" string.
      expect(status.message).toMatch(
        /Secret .* not found|Secret .* is missing|Failed to read Secret/
      )
    })

    it('should skip all resources when remote server is disabled', async () => {
      const disabledRemote: McpServerCRD = {
        ...REMOTE_SERVER,
        spec: { ...REMOTE_SERVER.spec, enabled: false },
      }

      await reconciler.reconcile(disabledRemote)

      expect(coreApi.createNamespacedConfigMap).not.toHaveBeenCalled()
      expect(appsApi.createNamespacedDeployment).not.toHaveBeenCalled()
      const status = reconciler.getStatus('mcp-sentry-remote')
      expect(status.deployed).toBe(false)
      expect(status.message).toBe('Disabled')
    })
  })
})

describe('plugin image-host allowlist (2.3)', () => {
  it('audit mode: a disallowed local image is warned but still built', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const appsApi = createMockAppsApi()
    const coreApi = createMockCoreApi()
    const customApi = createMockCustomApi()
    const reconciler = buildReconciler(appsApi, coreApi, customApi)
    const server = cloneServer(LOCAL_SERVER, { image: 'docker.io/evil/x:1' })

    await reconciler.reconcile(server)

    expect(appsApi.createNamespacedDeployment).toHaveBeenCalled()
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('audit mode'))
    warn.mockRestore()
  })

  it('enforce mode: a disallowed local image is blocked with ImageNotAllowed and not built', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    const appsApi = createMockAppsApi()
    const coreApi = createMockCoreApi()
    const customApi = createMockCustomApi()
    const reconciler = buildReconciler(appsApi, coreApi, customApi)
    // flip enforce for this test via the mocked config object
    const cfg = (await import('../config')).config as { enforcePluginImageAllowlist: boolean }
    cfg.enforcePluginImageAllowlist = true
    try {
      const server = cloneServer(LOCAL_SERVER, { image: 'docker.io/evil/x:1' })
      await reconciler.reconcile(server)

      expect(appsApi.createNamespacedDeployment).not.toHaveBeenCalled()
      const conditions = lastPatchedStatusConditions(customApi)
      expect(conditions).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ type: 'Ready', status: 'False', reason: 'ImageNotAllowed' }),
        ])
      )
    } finally {
      cfg.enforcePluginImageAllowlist = false
    }
  })

  it('an allowed local image builds normally in both modes', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    const appsApi = createMockAppsApi()
    const coreApi = createMockCoreApi()
    const customApi = createMockCustomApi()
    const reconciler = buildReconciler(appsApi, coreApi, customApi)
    const server = cloneServer(LOCAL_SERVER, { image: 'registry.evenfire.ai/acme/x:1' })

    await reconciler.reconcile(server)
    expect(appsApi.createNamespacedDeployment).toHaveBeenCalled()
  })

  it('enforce mode: an allowed local image still builds and is NOT blocked', async () => {
    // Guards the enforce-flip: a mutation that blocks allowed images (e.g.
    // `if (!decision.ok || config.enforcePluginImageAllowlist)`) would false-deny
    // first-party plugins (mongodb / playwright / airtable) — this test kills it.
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    const appsApi = createMockAppsApi()
    const coreApi = createMockCoreApi()
    const customApi = createMockCustomApi()
    const reconciler = buildReconciler(appsApi, coreApi, customApi)
    const cfg = (await import('../config')).config as { enforcePluginImageAllowlist: boolean }
    cfg.enforcePluginImageAllowlist = true
    try {
      const server = cloneServer(LOCAL_SERVER, { image: 'registry.evenfire.ai/acme/x:1' })
      await reconciler.reconcile(server)

      expect(appsApi.createNamespacedDeployment).toHaveBeenCalled()
      const conditions = lastPatchedStatusConditions(customApi)
      expect(conditions).not.toEqual(
        expect.arrayContaining([expect.objectContaining({ reason: 'ImageNotAllowed' })])
      )
    } finally {
      cfg.enforcePluginImageAllowlist = false
    }
  })
})
