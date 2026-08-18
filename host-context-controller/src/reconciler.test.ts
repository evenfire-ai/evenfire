import { beforeEach, describe, expect, it, vi } from 'vitest'
import * as k8s from '@kubernetes/client-node'
import {
  asAppsApi,
  asCoreApi,
  asCustomApi,
  asNetworkingApi,
  createMockAppsApi,
  createMockCoreApi,
  createMockCustomApi,
  createMockNetworkingApi,
} from '../test/__fixtures__/testMocks'
import { MANAGED_BY_LABEL, MCPSERVER_LABEL, WRC_MANAGED_BY_VALUE } from './constants'
import { McpServerReconciler } from './reconciler'
import { McpServerCRD } from './types'

/**
 * Tests for the managed:false guard in the reconciler (Risk 1.7).
 *
 * Uses dependency injection (same pattern as hostReconciler.test.ts)
 * to inject mock K8s API clients without module-level vi.mock().
 */

// Mock config module
vi.mock('./config', () => ({
  config: {
    devMode: false,
    port: 8081,
    namespace: 'mcp-server',
    controlPlaneNamespace: 'control-plane',
    hostNamespace: 'mcp-host',
    rpcProxyNamespace: 'rpc-proxy',
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
    name: name ?? 'test-server',
    namespace: 'mcp-server',
    spec: {
      contextRef: 'ctx1',
      image: 'test:latest',
      transport: {
        type: 'streamableHttp',
        url: 'http://test.mcp-server.svc.cluster.local:3000/mcp',
      },
      ...specOverrides,
    },
  }
}

describe('Reconciler managed:false guard (Risk 1.7)', () => {
  const appsApi = createMockAppsApi()
  const coreApi = createMockCoreApi()
  const customApi = createMockCustomApi()
  let reconciler: McpServerReconciler

  beforeEach(() => {
    vi.clearAllMocks()
    reconciler = new McpServerReconciler({} as k8s.KubeConfig, {
      appsApi: asAppsApi(appsApi),
      coreApi: asCoreApi(coreApi),
      customApi: asCustomApi(customApi),
    })
  })

  it('should skip Deployment creation when managed: false (CRITICAL)', async () => {
    const server = makeServer({ name: 'workflow-recipes', managed: false })
    await reconciler.reconcile(server)
    expect(appsApi.createNamespacedDeployment).not.toHaveBeenCalled()
  })

  it('should skip Service creation when managed: false', async () => {
    const server = makeServer({ name: 'workflow-recipes', managed: false })
    await reconciler.reconcile(server)
    expect(coreApi.createNamespacedService).not.toHaveBeenCalled()
  })

  it('should set status deployed:true, ready:true for valid WRC-owned managed:false', async () => {
    const server = makeServer({ name: 'workflow-recipes', managed: false })
    await reconciler.reconcile(server)
    const status = reconciler.getStatus('workflow-recipes')
    expect(status.deployed).toBe(true)
    expect(status.ready).toBe(true)
    expect(status.message).toContain('WRC-owned runtime registered')
  })

  it('should create Deployment when managed: true (no regression)', async () => {
    const server = makeServer({ name: 'mongo-mcp', managed: true })
    await reconciler.reconcile(server)
    expect(appsApi.createNamespacedDeployment).toHaveBeenCalled()
  })

  it('rejects managed ownership changes after the first reconcile snapshot', async () => {
    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    const serverName = 'workflow-recipes'

    await reconciler.reconcile(makeServer({ name: serverName, managed: true }))
    expect(appsApi.createNamespacedDeployment).toHaveBeenCalledTimes(1)

    await reconciler.reconcile(makeServer({ name: serverName, managed: false }))

    expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining('managed field changed'))
    expect(appsApi.createNamespacedDeployment).toHaveBeenCalledTimes(1)
    expect(appsApi.deleteNamespacedDeployment).not.toHaveBeenCalled()
    expect(coreApi.deleteNamespacedService).not.toHaveBeenCalled()
    expect(reconciler.getStatus(serverName)).toEqual(
      expect.objectContaining({
        deployed: false,
        ready: false,
        message: expect.stringContaining('managed field is immutable'),
      })
    )
    consoleSpy.mockRestore()
  })

  it('patches the network-ready annotation with merge-patch semantics', async () => {
    const server = {
      ...makeServer({ name: 'stdio-mcp', managed: true }),
      annotations: { 'clerum.io/pre-deploy': 'true' },
    }

    await reconciler.reconcile(server)

    expect(customApi.patchNamespacedCustomObject).toHaveBeenCalledWith(
      expect.objectContaining({
        group: 'clerum.io',
        version: 'v1alpha1',
        namespace: 'mcp-server',
        plural: 'mcpservers',
        name: 'stdio-mcp',
        body: {
          metadata: {
            annotations: {
              'clerum.io/network-ready': 'true',
            },
          },
        },
      }),
      expect.objectContaining({
        middleware: expect.any(Array),
      })
    )
  })

  it('Issue #408: stamps the observed generation alongside the network-ready ack', async () => {
    const server = {
      ...makeServer({ name: 'stdio-mcp', managed: true }),
      generation: 3,
      annotations: { 'clerum.io/pre-deploy': 'true' },
    }

    await reconciler.reconcile(server)

    expect(customApi.patchNamespacedCustomObject).toHaveBeenCalledWith(
      expect.objectContaining({
        plural: 'mcpservers',
        name: 'stdio-mcp',
        body: {
          metadata: {
            annotations: {
              'clerum.io/network-ready': 'true',
              'clerum.io/network-ready-observed-generation': '3',
            },
          },
        },
      }),
      expect.objectContaining({ middleware: expect.any(Array) })
    )
  })

  it('Issue #408: re-acks when the stamped generation is stale (spec changed since last ack)', async () => {
    const server = {
      ...makeServer({ name: 'stdio-mcp', managed: true }),
      generation: 3,
      annotations: {
        'clerum.io/pre-deploy': 'true',
        'clerum.io/network-ready': 'true',
        'clerum.io/network-ready-observed-generation': '2',
      },
    }

    await reconciler.reconcile(server)

    // Old guard (network-ready !== 'true') would skip the patch; the fix must re-ack
    // for the current generation, re-stamping observed-generation to '3'.
    expect(customApi.patchNamespacedCustomObject).toHaveBeenCalledWith(
      expect.objectContaining({
        plural: 'mcpservers',
        name: 'stdio-mcp',
        body: {
          metadata: {
            annotations: {
              'clerum.io/network-ready': 'true',
              'clerum.io/network-ready-observed-generation': '3',
            },
          },
        },
      }),
      expect.objectContaining({ middleware: expect.any(Array) })
    )
  })

  it('Issue #408: does NOT re-ack when the stamped generation already matches (no write storm)', async () => {
    const server = {
      ...makeServer({ name: 'stdio-mcp', managed: true }),
      generation: 3,
      annotations: {
        'clerum.io/pre-deploy': 'true',
        'clerum.io/network-ready': 'true',
        'clerum.io/network-ready-observed-generation': '3',
      },
    }

    await reconciler.reconcile(server)

    expect(customApi.patchNamespacedCustomObject).not.toHaveBeenCalledWith(
      expect.objectContaining({
        body: expect.objectContaining({
          metadata: expect.objectContaining({
            annotations: expect.objectContaining({ 'clerum.io/network-ready': 'true' }),
          }),
        }),
      }),
      expect.anything()
    )
  })

  it('Issue #408: re-acks when the ack predates the stamp (upgrade path: stamp absent)', async () => {
    // A pre-#408 HCC set network-ready:'true' without an observed-generation stamp.
    // The re-ack guard's stale-generation branch (typeof gen === 'number' && stamp !==
    // String(gen), i.e. undefined !== '3') must fire so the ack gains a generation.
    const server = {
      ...makeServer({ name: 'stdio-mcp', managed: true }),
      generation: 3,
      annotations: {
        'clerum.io/pre-deploy': 'true',
        'clerum.io/network-ready': 'true',
        // no clerum.io/network-ready-observed-generation
      },
    }

    await reconciler.reconcile(server)

    expect(customApi.patchNamespacedCustomObject).toHaveBeenCalledWith(
      expect.objectContaining({
        plural: 'mcpservers',
        name: 'stdio-mcp',
        body: {
          metadata: {
            annotations: {
              'clerum.io/network-ready': 'true',
              'clerum.io/network-ready-observed-generation': '3',
            },
          },
        },
      }),
      expect.objectContaining({ middleware: expect.any(Array) })
    )
  })

  it('should create Deployment when managed: undefined (default: true)', async () => {
    const server = makeServer({ name: 'mongo-mcp' })
    await reconciler.reconcile(server)
    expect(appsApi.createNamespacedDeployment).toHaveBeenCalled()
  })

  it('should log WRC-owned ownership when managed: false', async () => {
    const consoleSpy = vi.spyOn(console, 'log')
    const server = makeServer({ name: 'workflow-recipes', managed: false })
    await reconciler.reconcile(server)
    expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining('WRC-owned'))
    consoleSpy.mockRestore()
  })

  it('should accept managed?: boolean field on McpServerSpec', () => {
    const server = makeServer({ managed: false })
    expect(server.spec.managed).toBe(false)
    const server2 = makeServer({ managed: true })
    expect(server2.spec.managed).toBe(true)
    const server3 = makeServer({})
    expect(server3.spec.managed).toBeUndefined()
  })

  it('should still register in Discovery API (statusMap) when managed: false', async () => {
    const server = makeServer({ name: 'workflow-recipes', managed: false })
    await reconciler.reconcile(server)
    const status = reconciler.getStatus('workflow-recipes')
    expect(status.deployed).toBe(true)
    expect(status.ready).toBe(true)
  })

  it('marks managed:false not ready when envSecret is invalid without deleting WRC-owned runtime', async () => {
    const err = new Error('not found') as Error & { code?: number }
    err.code = 404
    coreApi.readNamespacedSecret.mockRejectedValueOnce(err)

    const server = makeServer({
      name: 'workflow-recipes',
      managed: false,
      envSecret: { name: 'missing', keys: [{ secretKey: 'token', envVar: 'TOKEN' }] },
    })

    await reconciler.reconcile(server)

    const status = reconciler.getStatus('workflow-recipes')
    expect(status.ready).toBe(false)
    expect(appsApi.deleteNamespacedDeployment).not.toHaveBeenCalled()
    expect(coreApi.deleteNamespacedService).not.toHaveBeenCalled()
  })

  it('does not delete WRC-owned runtime when managed:false is disabled', async () => {
    const server = makeServer({ name: 'workflow-recipes', managed: false, enabled: false })

    await reconciler.reconcile(server)

    const status = reconciler.getStatus('workflow-recipes')
    expect(status.ready).toBe(false)
    expect(appsApi.deleteNamespacedDeployment).not.toHaveBeenCalled()
    expect(coreApi.deleteNamespacedService).not.toHaveBeenCalled()
  })
})

// ─── PR-B B1: validateSecret result shape + writeStatusCondition ───────

describe('PR-B B1 — validateSecret result shape', () => {
  const appsApi = createMockAppsApi()
  const coreApi = createMockCoreApi()
  const customApi = createMockCustomApi()
  const networkingApi = createMockNetworkingApi()
  let reconciler: McpServerReconciler

  beforeEach(() => {
    vi.clearAllMocks()
    reconciler = new McpServerReconciler({} as k8s.KubeConfig, {
      appsApi: asAppsApi(appsApi),
      coreApi: asCoreApi(coreApi),
      customApi: asCustomApi(customApi),
      networkingApi: asNetworkingApi(networkingApi),
    })
  })

  it('returns ok:true with an empty revision when the server has no envSecret', async () => {
    const server = makeServer({ name: 'no-secret' })
    const result = await reconciler.validateSecret(server)
    // No credentials to hash, so no credentials-revision annotation is written
    // on the pod template (issue #223).
    expect(result).toEqual({ ok: true, revision: '' })
  })

  it('returns SecretNotFound when the Secret is missing (404)', async () => {
    const err = new Error('not found') as Error & { code?: number }
    err.code = 404
    coreApi.readNamespacedSecret.mockRejectedValueOnce(err)

    const server = makeServer({
      name: 'pg',
      envSecret: { name: 'pg-creds', keys: [{ secretKey: 'password', envVar: 'PGPASSWORD' }] },
    })

    const result = await reconciler.validateSecret(server)
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.reason).toBe('SecretNotFound')
      expect(result.message).toContain('pg-creds')
    }
  })

  it('returns SecretMissingKey when a required key is absent', async () => {
    coreApi.readNamespacedSecret.mockResolvedValueOnce({ data: { other: 'x' } })

    const server = makeServer({
      name: 'pg',
      envSecret: { name: 'pg-creds', keys: [{ secretKey: 'password', envVar: 'PGPASSWORD' }] },
    })

    const result = await reconciler.validateSecret(server)
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.reason).toBe('SecretMissingKey')
      expect(result.message).toContain('password')
    }
  })

  it('returns ReadError on unexpected API errors', async () => {
    const err = new Error('kapow') as Error & { code?: number }
    err.code = 500
    coreApi.readNamespacedSecret.mockRejectedValueOnce(err)

    const server = makeServer({
      name: 'pg',
      envSecret: { name: 'pg-creds', keys: [{ secretKey: 'password', envVar: 'PGPASSWORD' }] },
    })

    const result = await reconciler.validateSecret(server)
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.reason).toBe('ReadError')
    }
  })

  it('returns SecretAccessDenied on 401/403 API errors', async () => {
    const err = new Error('forbidden') as Error & { code?: number }
    err.code = 403
    coreApi.readNamespacedSecret.mockRejectedValueOnce(err)

    const server = makeServer({
      name: 'pg',
      envSecret: { name: 'pg-creds', keys: [{ secretKey: 'password', envVar: 'PGPASSWORD' }] },
    })

    const result = await reconciler.validateSecret(server)
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.reason).toBe('SecretAccessDenied')
    }
  })

  it('returns ok:true and the content revision when all required keys are present', async () => {
    // The base64 value does not matter for key-presence validation, but it IS
    // what the revision hashes (issue #223).
    coreApi.readNamespacedSecret.mockResolvedValueOnce({ data: { password: 'cGFzcw==' } })

    const server = makeServer({
      name: 'pg',
      envSecret: { name: 'pg-creds', keys: [{ secretKey: 'password', envVar: 'PGPASSWORD' }] },
    })

    const result = await reconciler.validateSecret(server)
    expect(result).toEqual({ ok: true, revision: expect.stringMatching(/^[0-9a-f]{64}$/) })
  })

  it('fails closed and removes managed runtime resources when secret validation fails', async () => {
    const err = new Error('not found') as Error & { code?: number }
    err.code = 404
    coreApi.readNamespacedSecret.mockRejectedValueOnce(err)
    networkingApi.listNamespacedNetworkPolicy.mockImplementation(async ({ namespace }) => ({
      items: [
        {
          metadata: {
            name: `np-${namespace}-pg`,
            namespace,
            labels: { 'clerum.io/mcpserver': 'pg' },
          },
        },
        {
          metadata: {
            name: `np-${namespace}-other`,
            namespace,
            labels: { 'clerum.io/mcpserver': 'other' },
          },
        },
      ],
    }))

    const server = makeServer({
      name: 'pg',
      envSecret: { name: 'pg-creds', keys: [{ secretKey: 'password', envVar: 'PGPASSWORD' }] },
    })

    await reconciler.reconcile(server)

    expect(appsApi.deleteNamespacedDeployment).toHaveBeenCalledWith({
      name: 'pg',
      namespace: 'mcp-server',
    })
    expect(coreApi.deleteNamespacedService).toHaveBeenCalledWith({
      name: 'pg',
      namespace: 'mcp-server',
    })
    for (const namespace of ['mcp-server', 'mcp-host', 'rpc-proxy']) {
      expect(networkingApi.deleteNamespacedNetworkPolicy).toHaveBeenCalledWith({
        name: `np-${namespace}-pg`,
        namespace,
      })
      expect(networkingApi.deleteNamespacedNetworkPolicy).not.toHaveBeenCalledWith({
        name: `np-${namespace}-other`,
        namespace,
      })
    }
    expect(reconciler.getStatus('pg')).toMatchObject({ deployed: false, ready: false })
  })

  it('propagates cleanup errors when secret validation fails', async () => {
    const err = new Error('not found') as Error & { code?: number }
    err.code = 404
    coreApi.readNamespacedSecret.mockRejectedValueOnce(err)
    appsApi.deleteNamespacedDeployment.mockRejectedValueOnce(
      Object.assign(new Error('forbidden'), { code: 403 })
    )

    const server = makeServer({
      name: 'pg',
      envSecret: { name: 'pg-creds', keys: [{ secretKey: 'password', envVar: 'PGPASSWORD' }] },
    })

    await expect(reconciler.reconcile(server)).rejects.toThrow(
      'Failed to delete runtime resources for McpServer "pg"'
    )
    expect(coreApi.deleteNamespacedService).toHaveBeenCalledWith({
      name: 'pg',
      namespace: 'mcp-server',
    })
    expect(reconciler.getStatus('pg')).toMatchObject({
      deployed: false,
      ready: false,
      message: 'Not reconciled yet',
    })
  })
})

describe('PR-B B1 — writeStatusCondition', () => {
  const appsApi = createMockAppsApi()
  const coreApi = createMockCoreApi()
  const customApi = createMockCustomApi()
  let reconciler: McpServerReconciler

  const getPatchedConditions = () => {
    const patch = customApi.patchNamespacedCustomObjectStatus.mock.calls[0][0]
    const op = patch.body[0]
    const conditions = op.path === '/status' ? op.value.conditions : op.value
    return { patch, op, conditions }
  }

  beforeEach(() => {
    vi.clearAllMocks()
    reconciler = new McpServerReconciler({} as k8s.KubeConfig, {
      appsApi: asAppsApi(appsApi),
      coreApi: asCoreApi(coreApi),
      customApi: asCustomApi(customApi),
    })
  })

  it('preserves lastTransitionTime when status is unchanged', async () => {
    const existing = {
      type: 'SecretResolved',
      status: 'True',
      reason: 'SecretFound',
      message: 'ok',
      lastTransitionTime: '2020-01-01T00:00:00.000Z',
    }
    customApi.getNamespacedCustomObjectStatus.mockResolvedValueOnce({
      status: { conditions: [existing] },
    })

    const server = makeServer({ name: 'pg' })

    await reconciler.writeStatusCondition(server, {
      type: 'SecretResolved',
      status: 'True',
      reason: 'SecretFound',
      message: 'still ok',
    })

    const { op, conditions } = getPatchedConditions()
    expect(op.path).toBe('/status/conditions')
    const written = conditions.find((c: { type: string }) => c.type === 'SecretResolved')
    expect(written.lastTransitionTime).toBe('2020-01-01T00:00:00.000Z')
    expect(written.message).toBe('still ok')
  })

  it('bumps lastTransitionTime when status flips', async () => {
    customApi.getNamespacedCustomObjectStatus.mockResolvedValueOnce({
      status: {
        conditions: [
          {
            type: 'SecretResolved',
            status: 'False',
            reason: 'SecretNotFound',
            message: 'gone',
            lastTransitionTime: '2020-01-01T00:00:00.000Z',
          },
        ],
      },
    })

    const server = makeServer({ name: 'pg' })
    const before = Date.now()

    await reconciler.writeStatusCondition(server, {
      type: 'SecretResolved',
      status: 'True',
      reason: 'SecretFound',
      message: 'resolved',
    })

    const { conditions } = getPatchedConditions()
    const written = conditions.find((c: { type: string }) => c.type === 'SecretResolved')
    const writtenMs = Date.parse(written.lastTransitionTime)
    expect(writtenMs).toBeGreaterThanOrEqual(before)
  })

  it('appends a new condition type without touching existing conditions', async () => {
    customApi.getNamespacedCustomObjectStatus.mockResolvedValueOnce({
      status: {
        conditions: [
          {
            type: 'NetworkReady',
            status: 'True',
            reason: 'NetworkPoliciesApplied',
            message: 'ok',
            lastTransitionTime: '2020-01-01T00:00:00.000Z',
          },
        ],
      },
    })

    const server = makeServer({ name: 'pg' })
    await reconciler.writeStatusCondition(server, {
      type: 'Ready',
      status: 'True',
      reason: 'ReconcileSuccess',
      message: 'done',
    })

    const { conditions } = getPatchedConditions()
    const types = conditions.map((c: { type: string }) => c.type)
    expect(types).toContain('NetworkReady')
    expect(types).toContain('Ready')
  })

  it('creates the status object when the CRD has no status yet', async () => {
    customApi.getNamespacedCustomObjectStatus.mockResolvedValueOnce({})

    const server = makeServer({ name: 'pg' })
    await reconciler.writeStatusCondition(server, {
      type: 'Ready',
      status: 'True',
      reason: 'ReconcileSuccess',
      message: 'done',
    })

    const { op } = getPatchedConditions()
    expect(op.path).toBe('/status')
    expect(op.value.conditions).toHaveLength(1)
    expect(op.value.conditions[0].type).toBe('Ready')
  })

  it('swallows 404 when the CRD was deleted mid-reconcile', async () => {
    const err = new Error('gone') as Error & { code?: number }
    err.code = 404
    customApi.getNamespacedCustomObjectStatus.mockRejectedValueOnce(err)

    const server = makeServer({ name: 'ghost' })

    await expect(
      reconciler.writeStatusCondition(server, {
        type: 'Ready',
        status: 'True',
        reason: 'ok',
        message: 'ok',
      })
    ).resolves.toBeUndefined()

    expect(customApi.patchNamespacedCustomObjectStatus).not.toHaveBeenCalled()
  })

  it('skips the patch when it cannot read current status safely', async () => {
    const err = new Error('kapow') as Error & { code?: number }
    err.code = 500
    customApi.getNamespacedCustomObjectStatus.mockRejectedValueOnce(err)

    const server = makeServer({ name: 'pg' })
    await reconciler.writeStatusCondition(server, {
      type: 'Ready',
      status: 'True',
      reason: 'ReconcileSuccess',
      message: 'done',
    })

    expect(customApi.patchNamespacedCustomObjectStatus).not.toHaveBeenCalled()
  })

  it('sets mcpserverMissingSecret=1 when writing SecretResolved=False', async () => {
    const { mcpserverMissingSecret } = await import('./metrics')
    const server = makeServer({
      name: 'pg',
      envSecret: { name: 'pg-creds', keys: [{ secretKey: 'password', envVar: 'PGPASSWORD' }] },
    })

    await reconciler.writeStatusCondition(server, {
      type: 'SecretResolved',
      status: 'False',
      reason: 'SecretNotFound',
      message: 'missing',
    })

    const metric = await mcpserverMissingSecret.get()
    const sample = metric.values.find(
      v =>
        v.labels.namespace === 'mcp-server' &&
        v.labels.name === 'pg' &&
        v.labels.secret_name === 'pg-creds'
    )
    expect(sample?.value).toBe(1)
  })

  it('sets mcpserverMissingSecret=0 when writing SecretResolved=True', async () => {
    const { mcpserverMissingSecret } = await import('./metrics')
    const server = makeServer({
      name: 'pg',
      envSecret: { name: 'pg-creds', keys: [{ secretKey: 'password', envVar: 'PGPASSWORD' }] },
    })

    await reconciler.writeStatusCondition(server, {
      type: 'SecretResolved',
      status: 'True',
      reason: 'SecretFound',
      message: 'ok',
    })

    const metric = await mcpserverMissingSecret.get()
    const sample = metric.values.find(
      v =>
        v.labels.namespace === 'mcp-server' &&
        v.labels.name === 'pg' &&
        v.labels.secret_name === 'pg-creds'
    )
    expect(sample?.value).toBe(0)
  })

  it('fences the patch with resourceVersion and retries on a 422 conflict (M2)', async () => {
    const existing = {
      type: 'DeploymentReady',
      status: 'False',
      reason: 'WaitingForReplicas',
      message: 'waiting',
      lastTransitionTime: '2020-01-01T00:00:00.000Z',
    }
    // First read at rv=v1; after the conflict, the re-read observes rv=v2 (a
    // concurrent writer bumped it).
    customApi.getNamespacedCustomObjectStatus
      .mockResolvedValueOnce({
        metadata: { resourceVersion: 'v1' },
        status: { conditions: [existing] },
      })
      .mockResolvedValueOnce({
        metadata: { resourceVersion: 'v2' },
        status: { conditions: [existing] },
      })
    // First patch loses the race (the resourceVersion `test` op fails → 422);
    // the retry succeeds.
    customApi.patchNamespacedCustomObjectStatus
      .mockRejectedValueOnce(Object.assign(new Error('the test operation failed'), { code: 422 }))
      .mockResolvedValueOnce({})

    const server = makeServer({ name: 'pg' })
    await reconciler.writeStatusCondition(server, {
      type: 'DeploymentReady',
      status: 'True',
      reason: 'ReplicasAvailable',
      message: 'ready',
    })

    // Re-read and re-patched instead of losing the write.
    expect(customApi.getNamespacedCustomObjectStatus).toHaveBeenCalledTimes(2)
    expect(customApi.patchNamespacedCustomObjectStatus).toHaveBeenCalledTimes(2)
    // Both patches are fenced; the successful retry uses the RE-READ version.
    const firstBody = customApi.patchNamespacedCustomObjectStatus.mock.calls[0][0].body
    const secondBody = customApi.patchNamespacedCustomObjectStatus.mock.calls[1][0].body
    expect(firstBody[0]).toEqual({ op: 'test', path: '/metadata/resourceVersion', value: 'v1' })
    expect(secondBody[0]).toEqual({ op: 'test', path: '/metadata/resourceVersion', value: 'v2' })
  })
})

describe('ownership-safe fail-closed cleanup', () => {
  const appsApi = createMockAppsApi()
  const coreApi = createMockCoreApi()
  const customApi = createMockCustomApi()
  let reconciler: McpServerReconciler

  beforeEach(() => {
    vi.clearAllMocks()
    reconciler = new McpServerReconciler({} as k8s.KubeConfig, {
      appsApi: asAppsApi(appsApi),
      coreApi: asCoreApi(coreApi),
      customApi: asCustomApi(customApi),
    })
  })

  it('deletes only HCC-owned resources when managed:true Secret is missing', async () => {
    const missing = new Error('missing') as Error & { code?: number }
    missing.code = 404
    coreApi.readNamespacedSecret.mockRejectedValueOnce(missing)
    appsApi.readNamespacedDeployment.mockResolvedValueOnce({
      metadata: {
        labels: {
          'clerum.io/managed-by': 'host-context-controller',
          'clerum.io/mcpserver': 'pg',
        },
      },
    })
    coreApi.readNamespacedConfigMap.mockResolvedValueOnce({
      metadata: {
        labels: {
          'clerum.io/managed-by': 'host-context-controller',
          'clerum.io/mcpserver': 'pg',
        },
      },
    })
    coreApi.readNamespacedService.mockResolvedValueOnce({
      metadata: {
        labels: {
          'clerum.io/managed-by': 'host-context-controller',
          'clerum.io/mcpserver': 'pg',
        },
      },
    })

    const server = makeServer({
      name: 'pg',
      managed: true,
      envSecret: { name: 'pg-creds', keys: [{ secretKey: 'password', envVar: 'PGPASSWORD' }] },
    })

    await reconciler.reconcile(server)

    expect(appsApi.deleteNamespacedDeployment).toHaveBeenCalledWith({
      name: 'pg',
      namespace: 'mcp-server',
    })
    expect(coreApi.deleteNamespacedService).toHaveBeenCalledWith({
      name: 'pg',
      namespace: 'mcp-server',
    })
  })

  it('preserves existing runtime when Secret validation fails with transient ReadError', async () => {
    const err = new Error('api unavailable') as Error & { code?: number }
    err.code = 500
    coreApi.readNamespacedSecret.mockRejectedValueOnce(err)

    const server = makeServer({
      name: 'pg',
      managed: true,
      envSecret: { name: 'pg-creds', keys: [{ secretKey: 'password', envVar: 'PGPASSWORD' }] },
    })

    await reconciler.reconcile(server)

    expect(appsApi.deleteNamespacedDeployment).not.toHaveBeenCalled()
    expect(coreApi.deleteNamespacedService).not.toHaveBeenCalled()
  })

  it('skips cleanup when the existing runtime is WRC-owned', async () => {
    const missing = new Error('missing') as Error & { code?: number }
    missing.code = 404
    const notFound = new Error('not found') as Error & { code?: number }
    notFound.code = 404

    coreApi.readNamespacedSecret.mockRejectedValueOnce(missing)
    appsApi.readNamespacedDeployment.mockResolvedValueOnce({
      metadata: {
        labels: {
          [MANAGED_BY_LABEL]: WRC_MANAGED_BY_VALUE,
          [MCPSERVER_LABEL]: 'pg',
        },
      },
    })
    coreApi.readNamespacedConfigMap.mockRejectedValueOnce(notFound)
    coreApi.readNamespacedService.mockRejectedValueOnce(notFound)

    const server = makeServer({
      name: 'pg',
      managed: true,
      envSecret: { name: 'pg-creds', keys: [{ secretKey: 'password', envVar: 'PGPASSWORD' }] },
    })

    await reconciler.reconcile(server)

    expect(appsApi.deleteNamespacedDeployment).not.toHaveBeenCalled()
    expect(coreApi.deleteNamespacedConfigMap).not.toHaveBeenCalled()
    expect(coreApi.deleteNamespacedService).not.toHaveBeenCalled()
  })
})

describe('updateStatusConditions', () => {
  const appsApi = createMockAppsApi()
  const coreApi = createMockCoreApi()
  const customApi = createMockCustomApi()
  let reconciler: McpServerReconciler

  beforeEach(() => {
    vi.clearAllMocks()
    reconciler = new McpServerReconciler({} as k8s.KubeConfig, {
      appsApi: asAppsApi(appsApi),
      coreApi: asCoreApi(coreApi),
      customApi: asCustomApi(customApi),
    })
  })

  it('preserves unrelated conditions while updating NetworkReady and DeploymentReady', async () => {
    const server = makeServer({ name: 'pg' })
    customApi.getNamespacedCustomObjectStatus
      .mockResolvedValueOnce({
        status: {
          conditions: [
            {
              type: 'SecretResolved',
              status: 'True',
              reason: 'SecretFound',
              message: 'ok',
              lastTransitionTime: '2020-01-01T00:00:00.000Z',
            },
          ],
        },
      })
      .mockResolvedValueOnce({
        status: {
          conditions: [
            {
              type: 'SecretResolved',
              status: 'True',
              reason: 'SecretFound',
              message: 'ok',
              lastTransitionTime: '2020-01-01T00:00:00.000Z',
            },
            {
              type: 'NetworkReady',
              status: 'True',
              reason: 'NetworkPoliciesApplied',
              message: 'NetworkPolicies and Service created',
              lastTransitionTime: '2020-01-02T00:00:00.000Z',
            },
          ],
        },
      })

    await (
      reconciler as unknown as {
        updateStatusConditions(server: McpServerCRD, deploymentReady: boolean): Promise<void>
      }
    ).updateStatusConditions(server, false)

    expect(customApi.patchNamespacedCustomObjectStatus).toHaveBeenCalledTimes(2)
    const finalPatch =
      customApi.patchNamespacedCustomObjectStatus.mock.calls[
        customApi.patchNamespacedCustomObjectStatus.mock.calls.length - 1
      ][0]
    const finalOp = finalPatch.body[0]
    const finalConditions = finalOp.path === '/status' ? finalOp.value.conditions : finalOp.value
    const types = finalConditions.map((c: { type: string }) => c.type)
    expect(types).toContain('SecretResolved')
    expect(types).toContain('NetworkReady')
    expect(types).toContain('DeploymentReady')
  })
})
