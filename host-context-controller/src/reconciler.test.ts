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

function deferred<T = void>(): {
  promise: Promise<T>
  resolve: (value: T | PromiseLike<T>) => void
} {
  let resolve!: (value: T | PromiseLike<T>) => void
  const promise = new Promise<T>(res => {
    resolve = res
  })
  return { promise, resolve }
}

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
    egressProxyImage: 'clerum/nginx-egress-proxy:test',
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

  it('should create Deployment when managed: undefined (default: true)', async () => {
    const server = makeServer({ name: 'mongo-mcp' })
    await reconciler.reconcile(server)
    expect(appsApi.createNamespacedDeployment).toHaveBeenCalled()
  })

  it('completes a remote proxy reconcile without rewriting the desired image', async () => {
    const server = makeServer({
      name: 'remote-api',
      image: 'vendor/original-image:1',
      remote: { baseUrl: 'https://api.example.com' },
    })
    const originalSpec = structuredClone(server.spec)
    let desiredRevisionIsCurrent = true
    customApi.patchNamespacedCustomObject.mockImplementation(
      ({ body }: { body?: { spec?: unknown } }) => {
        if (body?.spec !== undefined) {
          desiredRevisionIsCurrent = false
        }
        return Promise.resolve({})
      }
    )

    await reconciler.reconcile(server, {
      isCurrent: () => desiredRevisionIsCurrent,
    })

    expect(server.spec).toEqual(originalSpec)
    expect(customApi.patchNamespacedCustomObject).not.toHaveBeenCalledWith(
      expect.objectContaining({ body: expect.objectContaining({ spec: expect.anything() }) }),
      expect.anything()
    )
    expect(coreApi.createNamespacedConfigMap).toHaveBeenCalledOnce()
    expect(coreApi.createNamespacedService).toHaveBeenCalledOnce()
    expect(appsApi.createNamespacedDeployment).toHaveBeenCalledOnce()
    expect(appsApi.createNamespacedDeployment).toHaveBeenCalledWith(
      expect.objectContaining({
        body: expect.objectContaining({
          spec: expect.objectContaining({
            template: expect.objectContaining({
              spec: expect.objectContaining({
                containers: [
                  expect.objectContaining({
                    name: 'egress-proxy',
                    image: 'clerum/nginx-egress-proxy:test',
                  }),
                ],
              }),
            }),
          }),
        }),
      })
    )
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

  it('returns ok:true when the server has no envSecret', async () => {
    const server = makeServer({ name: 'no-secret' })
    const result = await reconciler.validateSecret(server)
    expect(result).toEqual({ ok: true })
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

  it('returns ok:true when all required keys are present', async () => {
    // Base64 value doesn't matter — the validator only checks key presence.
    coreApi.readNamespacedSecret.mockResolvedValueOnce({ data: { password: 'cGFzcw==' } })

    const server = makeServer({
      name: 'pg',
      envSecret: { name: 'pg-creds', keys: [{ secretKey: 'password', envVar: 'PGPASSWORD' }] },
    })

    const result = await reconciler.validateSecret(server)
    expect(result).toEqual({ ok: true })
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
    const op = patch.body.find(
      (candidate: { op?: string; path?: string }) =>
        candidate.op === 'add' &&
        (candidate.path === '/status' || candidate.path === '/status/conditions')
    )
    if (!op) throw new Error('status condition add operation was not emitted')
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

  it('records the reconciled McpServer generation on status conditions', async () => {
    const server = {
      ...makeServer({ name: 'pg' }),
      generation: 17,
    }

    await reconciler.writeStatusCondition(server, {
      type: 'Ready',
      status: 'True',
      reason: 'ReconcileSuccess',
      message: 'done',
    })

    const { conditions } = getPatchedConditions()
    expect(conditions.find((condition: { type: string }) => condition.type === 'Ready')).toEqual(
      expect.objectContaining({
        status: 'True',
        observedGeneration: 17,
      })
    )
  })

  it('re-reads and preserves a concurrent condition after a resourceVersion conflict', async () => {
    const networkReady = {
      type: 'NetworkReady',
      status: 'True',
      reason: 'NetworkPoliciesApplied',
      message: 'network ready',
      lastTransitionTime: '2020-01-01T00:00:00.000Z',
    }
    const externalEgressReady = {
      type: 'ExternalEgressReady',
      status: 'True',
      reason: 'EgressPolicyApplied',
      message: 'external egress ready',
      lastTransitionTime: '2020-01-02T00:00:00.000Z',
    }
    customApi.getNamespacedCustomObjectStatus
      .mockResolvedValueOnce({
        metadata: { resourceVersion: '100' },
        status: { conditions: [networkReady] },
      })
      .mockResolvedValueOnce({
        metadata: { resourceVersion: '101' },
        status: { conditions: [networkReady, externalEgressReady] },
      })
    customApi.patchNamespacedCustomObjectStatus
      .mockRejectedValueOnce(Object.assign(new Error('resourceVersion conflict'), { code: 409 }))
      .mockResolvedValueOnce({})

    const server: McpServerCRD = {
      ...makeServer({ name: 'pg' }),
      uid: 'uid-pg',
      generation: 17,
    }
    await reconciler.writeStatusCondition(server, {
      type: 'Ready',
      status: 'True',
      reason: 'ReconcileSuccess',
      message: 'done',
    })

    expect(customApi.getNamespacedCustomObjectStatus).toHaveBeenCalledTimes(2)
    expect(customApi.patchNamespacedCustomObjectStatus).toHaveBeenCalledTimes(2)
    expect(customApi.patchNamespacedCustomObjectStatus.mock.calls[0][0].body).toContainEqual({
      op: 'test',
      path: '/metadata/resourceVersion',
      value: '100',
    })
    const secondPatch = customApi.patchNamespacedCustomObjectStatus.mock.calls[1][0].body
    expect(secondPatch).toContainEqual({
      op: 'test',
      path: '/metadata/resourceVersion',
      value: '101',
    })
    const conditionPatch = secondPatch.find(
      (candidate: { op?: string; path?: string }) =>
        candidate.op === 'add' && candidate.path === '/status/conditions'
    )
    expect(conditionPatch?.value.map((written: { type: string }) => written.type)).toEqual([
      'NetworkReady',
      'ExternalEgressReady',
      'Ready',
    ])
  })

  it('bounds resourceVersion conflict retries', async () => {
    const currentStatus = {
      metadata: { resourceVersion: '100' },
      status: { conditions: [] },
    }
    customApi.getNamespacedCustomObjectStatus
      .mockResolvedValueOnce(currentStatus)
      .mockResolvedValueOnce(currentStatus)
      .mockResolvedValueOnce(currentStatus)
    const conflict = Object.assign(new Error('resourceVersion conflict'), { code: 422 })
    customApi.patchNamespacedCustomObjectStatus
      .mockRejectedValueOnce(conflict)
      .mockRejectedValueOnce(conflict)
      .mockRejectedValueOnce(conflict)
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)

    await reconciler.writeStatusCondition(
      {
        ...makeServer({ name: 'pg' }),
        uid: 'uid-pg',
        generation: 17,
      },
      {
        type: 'Ready',
        status: 'True',
        reason: 'ReconcileSuccess',
        message: 'done',
      }
    )

    expect(customApi.getNamespacedCustomObjectStatus).toHaveBeenCalledTimes(3)
    expect(customApi.patchNamespacedCustomObjectStatus).toHaveBeenCalledTimes(3)
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining('Failed to write status condition Ready=True'),
      conflict
    )
    warn.mockRestore()
  })

  it('guards the status patch with the captured UID, generation, and resourceVersion', async () => {
    const staleServer: McpServerCRD = {
      ...makeServer({ name: 'recreated' }),
      uid: 'uid-before-recreation',
      generation: 1,
    }
    customApi.getNamespacedCustomObjectStatus.mockResolvedValueOnce({
      metadata: { resourceVersion: '100' },
      status: { conditions: [] },
    })
    const writeFailure = Object.assign(new Error('status API unavailable'), {
      code: 500,
    })
    customApi.patchNamespacedCustomObjectStatus.mockImplementationOnce(async request => {
      expect(request.body.slice(0, 3)).toEqual([
        {
          op: 'test',
          path: '/metadata/uid',
          value: 'uid-before-recreation',
        },
        {
          op: 'test',
          path: '/metadata/generation',
          value: 1,
        },
        {
          op: 'test',
          path: '/metadata/resourceVersion',
          value: '100',
        },
      ])
      throw writeFailure
    })
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)

    await reconciler.writeStatusCondition(staleServer, {
      type: 'Ready',
      status: 'True',
      reason: 'ReconcileSuccess',
      message: 'stale reconcile result',
    })

    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining('Failed to write status condition Ready=True'),
      writeFailure
    )
    warn.mockRestore()
  })

  it('refreshes observedGeneration even when the condition payload is otherwise unchanged', async () => {
    customApi.getNamespacedCustomObjectStatus.mockResolvedValueOnce({
      status: {
        conditions: [
          {
            type: 'Ready',
            status: 'True',
            reason: 'ReconcileSuccess',
            message: 'done',
            observedGeneration: 16,
            lastTransitionTime: '2020-01-01T00:00:00.000Z',
          },
        ],
      },
    })
    const server = {
      ...makeServer({ name: 'pg' }),
      generation: 17,
    }

    await reconciler.writeStatusCondition(server, {
      type: 'Ready',
      status: 'True',
      reason: 'ReconcileSuccess',
      message: 'done',
    })

    const { conditions } = getPatchedConditions()
    expect(conditions.find((condition: { type: string }) => condition.type === 'Ready')).toEqual(
      expect.objectContaining({
        observedGeneration: 17,
        lastTransitionTime: '2020-01-01T00:00:00.000Z',
      })
    )
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
})

describe('restart-safe discovery status', () => {
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

  it('uses a persisted Ready condition only when it observes the current generation', () => {
    const server: McpServerCRD = {
      ...makeServer({ name: 'restart-safe' }),
      generation: 7,
      status: {
        conditions: [
          {
            type: 'Ready',
            status: 'True',
            reason: 'ReconcileSuccess',
            message: 'Deployment created',
            observedGeneration: 7,
          },
        ],
      },
    }

    expect(reconciler.getStatus(server)).toEqual({
      deployed: true,
      ready: true,
      message: 'Deployment created',
      authoritative: true,
    })
  })

  it.each([
    ['stale', 6],
    ['unversioned', undefined],
  ])('fails closed for a %s persisted Ready condition', (_label, observedGeneration) => {
    const server: McpServerCRD = {
      ...makeServer({ name: 'restart-unsafe' }),
      generation: 7,
      status: {
        conditions: [
          {
            type: 'Ready',
            status: 'True',
            reason: 'ReconcileSuccess',
            message: 'Deployment created',
            observedGeneration,
          },
        ],
      },
    }

    expect(reconciler.getStatus(server)).toEqual({
      deployed: false,
      ready: false,
      message: 'Not reconciled yet',
      authoritative: false,
    })
  })

  it('fails closed when persisted Ready conditions conflict for the current generation', () => {
    const server: McpServerCRD = {
      ...makeServer({ name: 'restart-conflict' }),
      generation: 7,
      status: {
        conditions: [
          {
            type: 'Ready',
            status: 'True',
            reason: 'ReconcileSuccess',
            observedGeneration: 7,
          },
          {
            type: 'Ready',
            status: 'False',
            reason: 'SecretValidationFailed',
            observedGeneration: 7,
          },
        ],
      },
    }

    expect(reconciler.getStatus(server)).toEqual({
      deployed: false,
      ready: false,
      message: 'Not reconciled yet',
      authoritative: false,
    })
  })

  it('prefers fresh in-memory status over persisted status from the same generation', async () => {
    const server: McpServerCRD = {
      ...makeServer({ name: 'live-status' }),
      generation: 3,
      status: {
        conditions: [
          {
            type: 'Ready',
            status: 'True',
            reason: 'ReconcileSuccess',
            observedGeneration: 3,
          },
        ],
      },
    }
    appsApi.readNamespacedDeployment.mockResolvedValueOnce({
      status: { readyReplicas: 0 },
    })

    await reconciler.reconcile(server)

    expect(reconciler.getStatus(server)).toEqual(
      expect.objectContaining({
        deployed: true,
        ready: false,
        authoritative: true,
      })
    )
  })

  it.each([
    ['generation changes', 'stable-uid', 4],
    ['the same name is recreated', 'replacement-uid', 3],
  ])('does not reuse in-memory status when %s', async (_case, uid, generation) => {
    const original: McpServerCRD = {
      ...makeServer({ name: 'identity-fenced' }),
      uid: 'original-uid',
      generation: 3,
    }
    await reconciler.reconcile(original)
    expect(reconciler.getStatus(original).ready).toBe(true)

    const current: McpServerCRD = {
      ...original,
      uid,
      generation,
      status: undefined,
    }

    expect(reconciler.getStatus(current)).toEqual({
      deployed: false,
      ready: false,
      message: 'Not reconciled yet',
      authoritative: false,
    })
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

describe('full reconciliation inventory authority', () => {
  const appsApi = createMockAppsApi()
  const coreApi = createMockCoreApi()
  const customApi = createMockCustomApi()
  let reconciler: McpServerReconciler

  beforeEach(() => {
    vi.clearAllMocks()
    customApi.getNamespacedCustomObject.mockRejectedValue(
      Object.assign(new Error('not found'), { code: 404 })
    )
    reconciler = new McpServerReconciler({} as k8s.KubeConfig, {
      appsApi: asAppsApi(appsApi),
      coreApi: asCoreApi(coreApi),
      customApi: asCustomApi(customApi),
    })
  })

  it('rejects when Deployment inventory LIST fails so startup retry remains possible', async () => {
    const inventoryError = new Error('deployment inventory unavailable')
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    appsApi.listNamespacedDeployment.mockRejectedValueOnce(inventoryError)

    await expect(reconciler.fullReconcile([])).rejects.toBe(inventoryError)

    expect(error).toHaveBeenCalledWith(
      '[Reconciler] Failed to list managed deployments:',
      inventoryError
    )
    error.mockRestore()
  })

  it('defaults to fail-closed orphan cleanup until an authority source is wired', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    appsApi.listNamespacedDeployment.mockResolvedValueOnce({
      items: [
        {
          metadata: {
            name: 'orphan-server',
            namespace: 'mcp-server',
          },
        },
      ],
    })

    await reconciler.fullReconcile([])

    expect(appsApi.deleteNamespacedDeployment).not.toHaveBeenCalled()
    expect(coreApi.deleteNamespacedService).not.toHaveBeenCalled()
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('inventory authority'))
    warn.mockRestore()
  })

  it('finishes desired reconciliation but skips orphan cleanup if inventory authority is lost mid-pass', async () => {
    let authority = { known: true, generation: 7 }
    reconciler.setInventoryAuthority(() => authority)
    const desired = makeServer({ name: 'desired-server' })
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    const reconcile = vi.spyOn(reconciler, 'reconcile').mockImplementation(async () => {
      authority = { known: false, generation: 8 }
    })
    appsApi.listNamespacedDeployment.mockResolvedValueOnce({
      items: [
        {
          metadata: {
            name: 'orphan-server',
            namespace: 'mcp-server',
          },
        },
      ],
    })

    await reconciler.fullReconcile([desired])

    expect(reconcile).toHaveBeenCalledOnce()
    expect(reconcile).toHaveBeenCalledWith(desired, {
      isCurrent: expect.any(Function),
    })
    expect(appsApi.deleteNamespacedDeployment).not.toHaveBeenCalled()
    expect(coreApi.deleteNamespacedService).not.toHaveBeenCalled()
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('inventory authority'))
    warn.mockRestore()
  })

  it('skips orphan cleanup if the authoritative inventory generation changes mid-pass', async () => {
    let authority = { known: true, generation: 11 }
    reconciler.setInventoryAuthority(() => authority)
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    vi.spyOn(reconciler, 'reconcile').mockImplementation(async () => {
      authority = { known: true, generation: 12 }
    })
    appsApi.listNamespacedDeployment.mockResolvedValueOnce({
      items: [
        {
          metadata: {
            name: 'orphan-server',
            namespace: 'mcp-server',
          },
        },
      ],
    })

    await reconciler.fullReconcile([makeServer({ name: 'desired-server' })])

    expect(appsApi.deleteNamespacedDeployment).not.toHaveBeenCalled()
    expect(coreApi.deleteNamespacedService).not.toHaveBeenCalled()
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('inventory authority'))
    warn.mockRestore()
  })

  it('deletes an orphan when inventory authority remains known and stable', async () => {
    reconciler.setInventoryAuthority(() => ({ known: true, generation: 21 }))
    appsApi.listNamespacedDeployment.mockResolvedValueOnce({
      items: [
        {
          metadata: {
            name: 'orphan-server',
            namespace: 'mcp-server',
          },
        },
      ],
    })

    await reconciler.fullReconcile([])

    expect(appsApi.deleteNamespacedDeployment).toHaveBeenCalledWith({
      name: 'orphan-server',
      namespace: 'mcp-server',
    })
    expect(coreApi.deleteNamespacedService).toHaveBeenCalledWith({
      name: 'orphan-server',
      namespace: 'mcp-server',
    })
  })

  it('skips a startup runtime revision superseded before its keyed effect is admitted', async () => {
    const snapshot: McpServerCRD = {
      ...makeServer({ name: 'updated-server' }),
      generation: 1,
      spec: {
        contextRef: 'default',
        image: 'clerum/updated-server:old',
        transport: { type: 'streamableHttp', port: 3000 },
      },
    }
    const current: McpServerCRD = {
      ...makeServer({ name: 'updated-server' }),
      generation: 2,
      spec: {
        contextRef: 'default',
        image: 'clerum/updated-server:new',
        transport: { type: 'streamableHttp', port: 3000 },
        egressBindings: [{ dns: 'new.example', port: 443 }],
      },
    }
    reconciler.setInventoryAuthority(() => ({ known: true, generation: 40 }))
    reconciler.setResolveCurrentServer(() => current)
    const reconcile = vi.spyOn(reconciler, 'reconcile')

    await reconciler.fullReconcile([snapshot])

    expect(reconcile).not.toHaveBeenCalled()
  })

  it('does not mutate runtime or status after startup authority retires during Secret validation', async () => {
    let authority = { known: true, generation: 51 }
    const server = {
      ...makeServer({
        name: 'secret-authority-race',
        envSecret: {
          name: 'runtime-secret',
          keys: [{ secretKey: 'token', envVar: 'TOKEN' }],
        },
      }),
      uid: 'secret-authority-race-uid',
      generation: 4,
    }
    reconciler.setInventoryAuthority(() => authority)
    reconciler.setResolveCurrentServer(name => (name === server.name ? server : undefined))
    const secretReadStarted = deferred()
    const releaseSecretRead = deferred<{ data: Record<string, string> }>()
    coreApi.readNamespacedSecret.mockImplementationOnce(async () => {
      secretReadStarted.resolve(undefined)
      return releaseSecretRead.promise
    })

    const convergence = reconciler.fullReconcile([server])
    await secretReadStarted.promise

    authority = { known: true, generation: 53 }
    releaseSecretRead.resolve({ data: { token: 'encoded-token' } })
    await convergence

    expect(coreApi.createNamespacedService).not.toHaveBeenCalled()
    expect(appsApi.createNamespacedDeployment).not.toHaveBeenCalled()
    expect(customApi.patchNamespacedCustomObject).not.toHaveBeenCalled()
    expect(customApi.patchNamespacedCustomObjectStatus).not.toHaveBeenCalled()
  })

  it('retires a same-watch runtime revision superseded during Secret validation', async () => {
    let current: McpServerCRD
    const original: McpServerCRD = {
      ...makeServer({
        name: 'same-watch-runtime',
        image: 'clerum/same-watch-runtime:v1',
        envSecret: {
          name: 'runtime-secret',
          keys: [{ secretKey: 'token', envVar: 'TOKEN' }],
        },
      }),
      uid: 'same-watch-runtime-uid',
      generation: 1,
    }
    const replacement: McpServerCRD = {
      ...original,
      generation: 2,
      spec: {
        ...original.spec,
        image: 'clerum/same-watch-runtime:v2',
      },
    }
    current = original
    reconciler.setInventoryAuthority(() => ({ known: true, generation: 61 }))
    reconciler.setResolveCurrentServer(name => (name === original.name ? current : undefined))

    const originalSecretReadStarted = deferred()
    const releaseOriginalSecretRead = deferred<{ data: Record<string, string> }>()
    coreApi.readNamespacedSecret
      .mockImplementationOnce(async () => {
        originalSecretReadStarted.resolve(undefined)
        return releaseOriginalSecretRead.promise
      })
      .mockResolvedValueOnce({ data: { token: 'encoded-token' } })

    const originalReconcile = reconciler.reconcile(original)
    await originalSecretReadStarted.promise
    current = replacement
    const replacementReconcile = reconciler.reconcile(replacement)
    releaseOriginalSecretRead.resolve({ data: { token: 'encoded-token' } })

    await Promise.all([originalReconcile, replacementReconcile])

    expect(coreApi.createNamespacedService).toHaveBeenCalledTimes(1)
    expect(appsApi.createNamespacedDeployment).toHaveBeenCalledTimes(1)
    expect(appsApi.createNamespacedDeployment).toHaveBeenCalledWith({
      namespace: replacement.namespace,
      body: expect.objectContaining({
        spec: expect.objectContaining({
          template: expect.objectContaining({
            spec: expect.objectContaining({
              containers: expect.arrayContaining([
                expect.objectContaining({
                  image: 'clerum/same-watch-runtime:v2',
                }),
              ]),
            }),
          }),
        }),
      }),
    })
  })

  it('admits independent desired effects while another server effect is blocked', async () => {
    const blocked = makeServer({ name: 'blocked-server' })
    const independent = makeServer({ name: 'independent-server' })
    let markBlockedStarted!: () => void
    let releaseBlocked!: () => void
    const blockedStarted = new Promise<void>(resolve => {
      markBlockedStarted = resolve
    })
    const blockedRelease = new Promise<void>(resolve => {
      releaseBlocked = resolve
    })
    const reconcile = vi.spyOn(reconciler, 'reconcile').mockResolvedValue(undefined)
    const fullReconcile = reconciler.fullReconcile([blocked, independent], {
      runEffect: async (serverName, work) => {
        if (serverName === blocked.name) {
          markBlockedStarted()
          await blockedRelease
        }
        await work()
      },
    })

    await blockedStarted
    await Promise.resolve()

    expect(reconcile).toHaveBeenCalledWith(independent, {
      isCurrent: expect.any(Function),
    })
    expect(reconcile.mock.calls.some(([server]) => server === blocked)).toBe(false)

    releaseBlocked()
    await fullReconcile

    expect(reconcile).toHaveBeenCalledWith(blocked, {
      isCurrent: expect.any(Function),
    })
  })

  it('bounds desired-effect admission without serializing independent siblings', async () => {
    const desired = Array.from({ length: 25 }, (_, index) =>
      makeServer({ name: `bounded-server-${index}` })
    )
    let active = 0
    let maxActive = 0
    let startedBeforeRelease = 0
    let releaseAll!: () => void
    const release = new Promise<void>(resolve => {
      releaseAll = resolve
    })
    const reconcile = vi.spyOn(reconciler, 'reconcile').mockResolvedValue(undefined)
    const options = {
      maxConcurrency: 3,
      runEffect: async (_serverName: string, work: () => Promise<void>) => {
        active += 1
        startedBeforeRelease += 1
        maxActive = Math.max(maxActive, active)
        await release
        try {
          await work()
        } finally {
          active -= 1
        }
      },
    }

    const fullReconcile = reconciler.fullReconcile(desired, options)
    await vi.waitFor(() => expect(active).toBeGreaterThanOrEqual(3))
    await Promise.resolve()
    const observedMaxActive = maxActive
    const observedStartedBeforeRelease = startedBeforeRelease

    releaseAll()
    await fullReconcile

    expect(observedMaxActive).toBe(3)
    expect(observedStartedBeforeRelease).toBe(3)
    expect(reconcile).toHaveBeenCalledTimes(desired.length)
  })

  it('waits for every admitted desired effect before reporting a sibling failure', async () => {
    const failed = makeServer({ name: 'failed-server' })
    const slow = makeServer({ name: 'slow-server' })
    let markSlowStarted!: () => void
    let releaseSlow!: () => void
    const slowStarted = new Promise<void>(resolve => {
      markSlowStarted = resolve
    })
    const slowRelease = new Promise<void>(resolve => {
      releaseSlow = resolve
    })
    const reconcile = vi.spyOn(reconciler, 'reconcile').mockResolvedValue(undefined)

    const fullReconcile = reconciler.fullReconcile([failed, slow], {
      runEffect: async (serverName, work) => {
        if (serverName === failed.name) {
          throw new Error('failed server gate')
        }
        markSlowStarted()
        await slowRelease
        await work()
      },
    })
    let settled = false
    const observed = fullReconcile.then(
      () => undefined,
      error => error
    )
    void observed.then(() => {
      settled = true
    })

    await slowStarted
    await Promise.resolve()
    await Promise.resolve()

    expect(settled).toBe(false)

    releaseSlow()
    const error = await observed

    expect(error).toBeInstanceOf(AggregateError)
    expect(error).toMatchObject({
      message: 'Failed to reconcile desired McpServers',
    })
    expect(reconcile).toHaveBeenCalledWith(slow, {
      isCurrent: expect.any(Function),
    })
  })

  it('aggregates every desired-effect failure after all bounded workers settle', async () => {
    const failures = [
      new Error('first desired failure'),
      new Error('second desired failure'),
      new Error('third desired failure'),
    ]
    const desired = failures.map((_, index) => makeServer({ name: `failed-${index}` }))
    const reconcile = vi.spyOn(reconciler, 'reconcile').mockResolvedValue(undefined)

    const error = await reconciler
      .fullReconcile(desired, {
        maxConcurrency: 2,
        runEffect: async serverName => {
          throw failures[Number(serverName.replace('failed-', ''))]
        },
      })
      .then(
        () => undefined,
        reason => reason
      )

    expect(error).toBeInstanceOf(AggregateError)
    expect((error as AggregateError).errors).toEqual(failures)
    expect(reconcile).not.toHaveBeenCalled()
  })

  it('does not delete an orphan candidate that was added to the same-generation cache mid-pass', async () => {
    const currentServers = new Map<string, McpServerCRD>()
    ;(reconciler as any).setResolveCurrentServer((name: string) => currentServers.get(name))
    reconciler.setInventoryAuthority(() => ({ known: true, generation: 31 }))
    appsApi.listNamespacedDeployment.mockImplementationOnce(async () => {
      currentServers.set('orphan-server', makeServer({ name: 'orphan-server' }))
      return {
        items: [
          {
            metadata: {
              name: 'orphan-server',
              namespace: 'mcp-server',
            },
          },
        ],
      }
    })

    await reconciler.fullReconcile([])

    expect(customApi.getNamespacedCustomObject).not.toHaveBeenCalled()
    expect(appsApi.deleteNamespacedDeployment).not.toHaveBeenCalled()
    expect(coreApi.deleteNamespacedService).not.toHaveBeenCalled()
  })

  it('does not delete an orphan candidate when a fresh API GET sees a same-name CRD before ADDED arrives', async () => {
    ;(reconciler as any).setResolveCurrentServer(() => undefined)
    reconciler.setInventoryAuthority(() => ({ known: true, generation: 32 }))
    customApi.getNamespacedCustomObject.mockResolvedValueOnce({
      metadata: { name: 'orphan-server', namespace: 'mcp-server', uid: 'recreated-uid' },
    })
    appsApi.listNamespacedDeployment.mockResolvedValueOnce({
      items: [
        {
          metadata: {
            name: 'orphan-server',
            namespace: 'mcp-server',
          },
        },
      ],
    })

    await reconciler.fullReconcile([])

    expect(customApi.getNamespacedCustomObject).toHaveBeenCalledWith(
      expect.objectContaining({
        namespace: 'mcp-server',
        plural: 'mcpservers',
        name: 'orphan-server',
      })
    )
    expect(appsApi.deleteNamespacedDeployment).not.toHaveBeenCalled()
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
