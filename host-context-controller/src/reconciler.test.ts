import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import * as k8s from '@kubernetes/client-node'
import { PRE_DEPLOY_ANNOTATION } from '@clerum/network-policy-core'
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
import { K8sRequestTimeoutError } from './k8s/k8sRequestDeadline'
import { hccLogger } from './logger'
import { registry } from './metrics'
import {
  McpServerReconciler,
  RUNTIME_NOT_DESIRED_DISABLED_MESSAGE,
  RUNTIME_NOT_DESIRED_FAIL_CLOSED_MESSAGE,
} from './reconciler'
import { McpServerCRD } from './types'

describe.each(['Deployment', 'Service'] as const)('read-first %s contract', kind => {
  function fixture() {
    const appsApi = createMockAppsApi()
    const coreApi = createMockCoreApi()
    const reconciler = new McpServerReconciler({} as k8s.KubeConfig, {
      appsApi: asAppsApi(appsApi),
      coreApi: asCoreApi(coreApi),
      customApi: asCustomApi(createMockCustomApi()),
      assumeInventoryAuthorityWhenUnconfigured: true,
    })
    const server = makeServer()
    const read =
      kind === 'Deployment' ? appsApi.readNamespacedDeployment : coreApi.readNamespacedService
    const create =
      kind === 'Deployment' ? appsApi.createNamespacedDeployment : coreApi.createNamespacedService
    const replace =
      kind === 'Deployment' ? appsApi.replaceNamespacedDeployment : coreApi.replaceNamespacedService
    const run = (isCurrent = () => true) =>
      kind === 'Deployment'
        ? (reconciler as any).ensureDeployment(server, '', isCurrent)
        : (reconciler as any).ensureService(server, isCurrent)
    return { read, create, replace, run, server }
  }

  it('propagates GET 403 without attempting a write', async () => {
    const f = fixture()
    const forbidden = { code: 403 }
    f.read.mockRejectedValue(forbidden)
    await expect(f.run()).rejects.toBe(forbidden)
    expect(f.read).toHaveBeenCalledExactlyOnceWith({
      name: f.server.name,
      namespace: f.server.namespace,
    })
    expect(f.create).not.toHaveBeenCalled()
    expect(f.replace).not.toHaveBeenCalled()
  })

  it('reads absence before its only create request', async () => {
    const f = fixture()
    const events: string[] = []
    f.read.mockImplementation(async () => {
      events.push('GET')
      throw { code: 404 }
    })
    f.create.mockImplementation(async () => {
      events.push('POST')
      return {}
    })
    await f.run()
    expect(events).toEqual(['GET', 'POST'])
    expect(f.replace).not.toHaveBeenCalled()
  })

  it('rechecks authority after an absent read', async () => {
    const f = fixture()
    let active = true
    f.read.mockImplementation(async () => {
      active = false
      throw { code: 404 }
    })
    await f.run(() => active)
    expect(f.read).toHaveBeenCalledTimes(1)
    expect(f.create).not.toHaveBeenCalled()
    expect(f.replace).not.toHaveBeenCalled()
  })
})

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
      image: 'test:latest',
      transport: {
        type: 'streamableHttp',
        url: 'http://test.mcp-server.svc.cluster.local:3000/mcp',
      },
      ...specOverrides,
    },
  }
}

type StatusConditionFixture = {
  type: string
  status: string
  reason: string
  message: string
  lastTransitionTime: string
  observedGeneration?: number
}

/** Secret.data form. Do not write `password: 'literal'` — public-boundary rejects it. */
function storedSecret(value: string): string {
  return Buffer.from(value, 'utf8').toString('base64')
}

function hccOwnedMetadata(name: string) {
  return {
    name,
    namespace: 'mcp-server',
    labels: {
      'clerum.io/managed-by': 'host-context-controller',
      'clerum.io/mcpserver': name,
    },
  }
}

function networkReadyTrue(): StatusConditionFixture {
  return {
    type: 'NetworkReady',
    status: 'True',
    reason: 'NetworkPoliciesApplied',
    message: 'NetworkPolicies and Service created',
    lastTransitionTime: '2020-01-03T00:00:00.000Z',
  }
}

function deploymentReadyTrue(): StatusConditionFixture {
  return {
    type: 'DeploymentReady',
    status: 'True',
    reason: 'ReplicasAvailable',
    message: 'Deployment has ready replicas',
    lastTransitionTime: '2020-01-02T00:00:00.000Z',
  }
}

function secretResolvedTrue(): StatusConditionFixture {
  return {
    type: 'SecretResolved',
    status: 'True',
    reason: 'SecretFound',
    message: 'ok',
    lastTransitionTime: '2020-01-01T00:00:00.000Z',
  }
}

function installLiveStatus(
  customApi: ReturnType<typeof createMockCustomApi>,
  initial: StatusConditionFixture[] = []
): { current: () => StatusConditionFixture[] } {
  let conditions = [...initial]
  customApi.getNamespacedCustomObjectStatus.mockImplementation(async () => ({
    metadata: { resourceVersion: '1' },
    status: { conditions },
  }))
  customApi.patchNamespacedCustomObjectStatus.mockImplementation(
    async (req: { body: Array<{ op?: string; path?: string; value?: unknown }> }) => {
      const op = req.body.find(
        candidate =>
          candidate.op === 'add' &&
          (candidate.path === '/status' || candidate.path === '/status/conditions')
      )
      if (!op) throw new Error('status condition add operation was not emitted')
      conditions = (
        op.path === '/status'
          ? ((op.value as { conditions?: StatusConditionFixture[] }).conditions ?? [])
          : (op.value as StatusConditionFixture[])
      ).map(condition => ({ ...condition }))
      return {}
    }
  )
  return { current: () => conditions }
}

function persistReadySeed(server: McpServerCRD): McpServerCRD {
  server.uid = server.uid ?? 'uid-pg'
  server.generation = server.generation ?? 3
  server.status = {
    conditions: [
      {
        type: 'Ready',
        status: 'True',
        reason: 'ReconcileSuccess',
        message: 'Deployment created',
        lastTransitionTime: '2020-01-01T00:00:00.000Z',
        observedGeneration: server.generation,
      },
    ],
  }
  return server
}

function failRuntimeNotDesiredWrites(customApi: ReturnType<typeof createMockCustomApi>): void {
  const livePatch = customApi.patchNamespacedCustomObjectStatus.getMockImplementation()
  customApi.patchNamespacedCustomObjectStatus.mockImplementation(async req => {
    const body = (req as { body: Array<{ op?: string; path?: string; value?: unknown }> }).body
    const op = body.find(
      candidate =>
        candidate.op === 'add' &&
        (candidate.path === '/status' || candidate.path === '/status/conditions')
    )
    const conditions = (
      Array.isArray(op?.value)
        ? op.value
        : ((op?.value as { conditions?: Array<{ reason?: string }> }).conditions ?? [])
    ) as Array<{ reason?: string }>
    if (conditions.some(condition => condition.reason === 'RuntimeNotDesired')) {
      throw Object.assign(new Error('status write failed'), { code: 500 })
    }
    if (livePatch) return livePatch(req)
    return {}
  })
}

function patchedConditionSets(
  customApi: ReturnType<typeof createMockCustomApi>
): StatusConditionFixture[][] {
  return customApi.patchNamespacedCustomObjectStatus.mock.calls.map(call => {
    const body = (call[0] as { body: Array<{ op?: string; path?: string; value?: unknown }> }).body
    const op = body.find(
      candidate =>
        candidate.op === 'add' &&
        (candidate.path === '/status' || candidate.path === '/status/conditions')
    )
    if (!op) return []
    const value = op.value
    return (
      Array.isArray(value) ? value : ((value as { conditions?: unknown[] }).conditions ?? [])
    ) as StatusConditionFixture[]
  })
}

function firstPatchWithType(
  sets: StatusConditionFixture[][],
  type: string
): StatusConditionFixture[] | undefined {
  return sets.find(conditions => conditions.some(condition => condition.type === type))
}

describe('Reconciler managed:false guard (Risk 1.7)', () => {
  let appsApi: ReturnType<typeof createMockAppsApi>
  let coreApi: ReturnType<typeof createMockCoreApi>
  let customApi: ReturnType<typeof createMockCustomApi>
  let reconciler: McpServerReconciler

  beforeEach(() => {
    appsApi = createMockAppsApi()
    coreApi = createMockCoreApi()
    customApi = createMockCustomApi()
    reconciler = new McpServerReconciler({} as k8s.KubeConfig, {
      assumeInventoryAuthorityWhenUnconfigured: true,
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
    // First materialization is absent; subsequent reads still use the live-state fixture.
    appsApi.readNamespacedDeployment.mockRejectedValueOnce({ code: 404 })
    coreApi.readNamespacedService.mockRejectedValueOnce({ code: 404 })
    const server = makeServer({ name: 'mongo-mcp', managed: true })
    await reconciler.reconcile(server)
    expect(appsApi.createNamespacedDeployment).toHaveBeenCalled()
  })

  it('rejects managed ownership changes after the first reconcile snapshot', async () => {
    // First materialization is absent; subsequent reads still use the live-state fixture.
    appsApi.readNamespacedDeployment.mockRejectedValueOnce({ code: 404 })
    coreApi.readNamespacedService.mockRejectedValueOnce({ code: 404 })
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
    // First materialization is absent; subsequent reads still use the live-state fixture.
    appsApi.readNamespacedDeployment.mockRejectedValueOnce({ code: 404 })
    coreApi.readNamespacedService.mockRejectedValueOnce({ code: 404 })
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
    // First materialization is absent; subsequent reads still use the live-state fixture.
    appsApi.readNamespacedDeployment.mockRejectedValueOnce({ code: 404 })
    coreApi.readNamespacedService.mockRejectedValueOnce({ code: 404 })
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
    // First materialization is absent; subsequent reads still use the live-state fixture.
    appsApi.readNamespacedDeployment.mockRejectedValueOnce({ code: 404 })
    coreApi.readNamespacedService.mockRejectedValueOnce({ code: 404 })
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
    // First materialization is absent; subsequent reads still use the live-state fixture.
    appsApi.readNamespacedDeployment.mockRejectedValueOnce({ code: 404 })
    coreApi.readNamespacedService.mockRejectedValueOnce({ code: 404 })
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
    // First materialization is absent; subsequent reads still use the live-state fixture.
    appsApi.readNamespacedDeployment.mockRejectedValueOnce({ code: 404 })
    coreApi.readNamespacedService.mockRejectedValueOnce({ code: 404 })
    const server = makeServer({ name: 'mongo-mcp' })
    await reconciler.reconcile(server)
    expect(appsApi.createNamespacedDeployment).toHaveBeenCalled()
  })

  it('completes a remote proxy reconcile without rewriting the desired image', async () => {
    // This case starts without the nginx ConfigMap.
    coreApi.readNamespacedConfigMap.mockRejectedValueOnce({ code: 404 })
    // First materialization is absent; subsequent reads still use the live-state fixture.
    appsApi.readNamespacedDeployment.mockRejectedValueOnce({ code: 404 })
    coreApi.readNamespacedService.mockRejectedValueOnce({ code: 404 })
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
    const info = vi.spyOn(hccLogger, 'info').mockImplementation(() => undefined)
    const server = makeServer({ name: 'workflow-recipes', managed: false })
    await reconciler.reconcile(server)
    expect(info).toHaveBeenCalledWith(expect.stringContaining('WRC-owned'), expect.anything())
    info.mockRestore()
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
    expect(
      patchedConditionSets(customApi).some(conditions =>
        conditions.some(condition => condition.type === 'Ready' && condition.reason === 'Disabled')
      )
    ).toBe(true)
    expect(
      patchedConditionSets(customApi).some(conditions =>
        conditions.some(condition => condition.type === 'DeploymentReady')
      )
    ).toBe(false)
  })

  it('does not write DeploymentReady when a WRC-owned server is fail-closed', async () => {
    const err = new Error('not found') as Error & { code?: number }
    err.code = 404
    coreApi.readNamespacedSecret.mockRejectedValueOnce(err)
    const server = makeServer({
      name: 'workflow-recipes',
      managed: false,
      envSecret: { name: 'missing', keys: [{ secretKey: 'token', envVar: 'TOKEN' }] },
    })

    await reconciler.reconcile(server)

    expect(appsApi.deleteNamespacedDeployment).not.toHaveBeenCalled()
    expect(
      patchedConditionSets(customApi).some(conditions =>
        conditions.some(
          condition => condition.type === 'SecretResolved' && condition.reason === 'SecretNotFound'
        )
      )
    ).toBe(true)
    expect(
      patchedConditionSets(customApi).some(conditions =>
        conditions.some(condition => condition.type === 'DeploymentReady')
      )
    ).toBe(false)
  })
})

// ─── PR-B B1: validateSecret result shape + writeStatusCondition ───────

describe('PR-B B1 — validateSecret result shape', () => {
  let appsApi: ReturnType<typeof createMockAppsApi>
  let coreApi: ReturnType<typeof createMockCoreApi>
  let customApi: ReturnType<typeof createMockCustomApi>
  let networkingApi: ReturnType<typeof createMockNetworkingApi>
  let reconciler: McpServerReconciler

  beforeEach(() => {
    appsApi = createMockAppsApi()
    coreApi = createMockCoreApi()
    customApi = createMockCustomApi()
    networkingApi = createMockNetworkingApi()
    const kubeConfig = new k8s.KubeConfig()
    // Keep the forbidden API reachable: reintroducing the old optional
    // NetworkingApi client must not pass by observing an unrelated mock.
    vi.spyOn(kubeConfig, 'makeApiClient').mockReturnValue(asNetworkingApi(networkingApi))
    reconciler = new McpServerReconciler(kubeConfig, {
      assumeInventoryAuthorityWhenUnconfigured: true,
      appsApi: asAppsApi(appsApi),
      coreApi: asCoreApi(coreApi),
      customApi: asCustomApi(customApi),
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
    expect(networkingApi.listNamespacedNetworkPolicy).not.toHaveBeenCalled()
    expect(networkingApi.deleteNamespacedNetworkPolicy).not.toHaveBeenCalled()
    expect(customApi.patchNamespacedCustomObjectStatus).toHaveBeenCalledWith(
      expect.objectContaining({
        body: expect.arrayContaining([
          expect.objectContaining({
            path: '/status/conditions',
            value: expect.arrayContaining([
              expect.objectContaining({
                type: 'SecretResolved',
                status: 'False',
                reason: 'SecretNotFound',
              }),
            ]),
          }),
        ]),
      })
    )
    expect(reconciler.getStatus('pg')).toMatchObject({ deployed: false, ready: false })
  })

  it('fail-closed incomplete delete does not write RuntimeNotDesired', async () => {
    const err = new Error('not found') as Error & { code?: number }
    err.code = 404
    coreApi.readNamespacedSecret.mockRejectedValueOnce(err)
    let seenDeploymentRead = false
    let deniedDeploymentDelete = false
    appsApi.readNamespacedDeployment.mockImplementation(async () => {
      seenDeploymentRead = true
      return { metadata: hccOwnedMetadata('pg') }
    })

    const server = makeServer({
      name: 'pg',
      managed: true,
      envSecret: { name: 'pg-creds', keys: [{ secretKey: 'password', envVar: 'PGPASSWORD' }] },
    })
    await reconciler.reconcile(server, {
      isCurrent: () => {
        if (seenDeploymentRead && !deniedDeploymentDelete) {
          deniedDeploymentDelete = true
          return false
        }
        return true
      },
    })

    expect(seenDeploymentRead).toBe(true)
    expect(deniedDeploymentDelete).toBe(true)
    expect(appsApi.deleteNamespacedDeployment).not.toHaveBeenCalled()
    expect(customApi.patchNamespacedCustomObjectStatus).not.toHaveBeenCalled()
    expect(reconciler.hasIncompleteReconciliation()).toBe(true)
  })

  it('fail-closed writes RuntimeNotDesired when Service cleanup is denied after Deployment delete', async () => {
    const err = new Error('not found') as Error & { code?: number }
    err.code = 404
    coreApi.readNamespacedSecret.mockRejectedValueOnce(err)
    installLiveStatus(customApi, [secretResolvedTrue(), deploymentReadyTrue(), networkReadyTrue()])
    let seenServiceRead = false
    let deniedServiceDelete = false
    coreApi.readNamespacedService.mockImplementation(async () => {
      seenServiceRead = true
      return { metadata: hccOwnedMetadata('pg') }
    })

    const server = makeServer({
      name: 'pg',
      managed: true,
      envSecret: { name: 'pg-creds', keys: [{ secretKey: 'password', envVar: 'PGPASSWORD' }] },
    })
    await reconciler.reconcile(server, {
      isCurrent: () => {
        if (seenServiceRead && !deniedServiceDelete) {
          deniedServiceDelete = true
          return false
        }
        return true
      },
    })

    expect(appsApi.deleteNamespacedDeployment).toHaveBeenCalled()
    expect(coreApi.deleteNamespacedService).not.toHaveBeenCalled()
    expect(
      patchedConditionSets(customApi).some(conditions =>
        conditions.some(
          condition =>
            condition.type === 'DeploymentReady' &&
            condition.reason === 'RuntimeNotDesired' &&
            condition.message === RUNTIME_NOT_DESIRED_FAIL_CLOSED_MESSAGE
        )
      )
    ).toBe(true)
    expect(reconciler.hasIncompleteReconciliation()).toBe(true)
  })

  it('disabled writes RuntimeNotDesired when Service cleanup is denied after Deployment delete', async () => {
    installLiveStatus(customApi, [secretResolvedTrue(), deploymentReadyTrue(), networkReadyTrue()])
    let seenServiceRead = false
    let deniedServiceDelete = false
    coreApi.readNamespacedService.mockImplementation(async () => {
      seenServiceRead = true
      return { metadata: hccOwnedMetadata('pg') }
    })

    const server = persistReadySeed(makeServer({ name: 'pg', managed: true, enabled: false }))
    await reconciler.reconcile(server, {
      isCurrent: () => {
        if (seenServiceRead && !deniedServiceDelete) {
          deniedServiceDelete = true
          return false
        }
        return true
      },
    })

    expect(appsApi.deleteNamespacedDeployment).toHaveBeenCalled()
    expect(coreApi.deleteNamespacedService).not.toHaveBeenCalled()
    expect(
      patchedConditionSets(customApi).some(conditions =>
        conditions.some(
          condition =>
            condition.type === 'DeploymentReady' &&
            condition.reason === 'RuntimeNotDesired' &&
            condition.message === RUNTIME_NOT_DESIRED_DISABLED_MESSAGE
        )
      )
    ).toBe(true)
    expect(reconciler.hasIncompleteReconciliation()).toBe(true)
  })

  it('fail-closed writes RuntimeNotDesired when Service delete throws after Deployment is gone', async () => {
    const err = new Error('not found') as Error & { code?: number }
    err.code = 404
    coreApi.readNamespacedSecret.mockRejectedValueOnce(err)
    installLiveStatus(customApi, [secretResolvedTrue(), deploymentReadyTrue(), networkReadyTrue()])
    coreApi.deleteNamespacedService.mockRejectedValueOnce(
      Object.assign(new Error('forbidden'), { code: 403 })
    )

    const server = makeServer({
      name: 'pg',
      managed: true,
      envSecret: { name: 'pg-creds', keys: [{ secretKey: 'password', envVar: 'PGPASSWORD' }] },
    })
    await expect(reconciler.reconcile(server)).rejects.toThrow(
      'Failed to delete runtime Kubernetes resources for McpServer "pg"'
    )
    expect(appsApi.deleteNamespacedDeployment).toHaveBeenCalled()
    expect(
      patchedConditionSets(customApi).some(conditions =>
        conditions.some(
          condition =>
            condition.type === 'DeploymentReady' && condition.reason === 'RuntimeNotDesired'
        )
      )
    ).toBe(true)
  })

  it('disabled incomplete delete does not write RuntimeNotDesired', async () => {
    let seenDeploymentRead = false
    let deniedDeploymentDelete = false
    appsApi.readNamespacedDeployment.mockImplementation(async () => {
      seenDeploymentRead = true
      return { metadata: hccOwnedMetadata('pg') }
    })

    await reconciler.reconcile(makeServer({ name: 'pg', managed: true, enabled: false }), {
      isCurrent: () => {
        if (seenDeploymentRead && !deniedDeploymentDelete) {
          deniedDeploymentDelete = true
          return false
        }
        return true
      },
    })

    expect(deniedDeploymentDelete).toBe(true)
    expect(appsApi.deleteNamespacedDeployment).not.toHaveBeenCalled()
    expect(
      patchedConditionSets(customApi).some(conditions =>
        conditions.some(condition => condition.reason === 'RuntimeNotDesired')
      )
    ).toBe(false)
    expect(reconciler.hasIncompleteReconciliation()).toBe(true)
  })

  it('fail-closed SecretNotFound writes RuntimeNotDesired after delete and strips NetworkReady', async () => {
    const err = new Error('not found') as Error & { code?: number }
    err.code = 404
    coreApi.readNamespacedSecret.mockRejectedValueOnce(err)
    installLiveStatus(customApi, [secretResolvedTrue(), deploymentReadyTrue(), networkReadyTrue()])

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
    const sets = patchedConditionSets(customApi)
    const secretResolvedPatch = firstPatchWithType(sets, 'SecretResolved')
    expect(secretResolvedPatch).toBeDefined()
    expect(secretResolvedPatch?.map(condition => condition.type)).not.toContain('NetworkReady')
    expect(
      sets.some(conditions =>
        conditions.some(c => c.type === 'Ready' && c.reason === 'SecretValidationFailed')
      )
    ).toBe(true)
    const retirementIndex = sets.findIndex(conditions =>
      conditions.some(
        condition =>
          condition.type === 'DeploymentReady' &&
          condition.status === 'False' &&
          condition.reason === 'RuntimeNotDesired' &&
          condition.message === RUNTIME_NOT_DESIRED_FAIL_CLOSED_MESSAGE
      )
    )
    expect(retirementIndex).toBeGreaterThanOrEqual(0)
    expect(sets[retirementIndex]?.map(condition => condition.type)).not.toContain('NetworkReady')
    expect(appsApi.deleteNamespacedDeployment.mock.invocationCallOrder[0]).toBeLessThan(
      customApi.patchNamespacedCustomObjectStatus.mock.invocationCallOrder[retirementIndex]
    )
  })

  it('fail-closed SecretNotFound writes RuntimeNotDesired even when DeploymentReady was absent', async () => {
    const err = new Error('not found') as Error & { code?: number }
    err.code = 404
    coreApi.readNamespacedSecret.mockRejectedValueOnce(err)
    installLiveStatus(customApi, [secretResolvedTrue(), networkReadyTrue()])

    const server = makeServer({
      name: 'pg',
      managed: true,
      envSecret: { name: 'pg-creds', keys: [{ secretKey: 'password', envVar: 'PGPASSWORD' }] },
    })

    await reconciler.reconcile(server)

    expect(appsApi.deleteNamespacedDeployment).toHaveBeenCalled()
    expect(
      patchedConditionSets(customApi).some(conditions =>
        conditions.some(
          condition =>
            condition.type === 'DeploymentReady' &&
            condition.reason === 'RuntimeNotDesired' &&
            condition.message === RUNTIME_NOT_DESIRED_FAIL_CLOSED_MESSAGE
        )
      )
    ).toBe(true)
  })

  it('disabled managed server writes RuntimeNotDesired after delete and strips NetworkReady', async () => {
    installLiveStatus(customApi, [secretResolvedTrue(), deploymentReadyTrue(), networkReadyTrue()])

    const server = makeServer({ name: 'pg', managed: true, enabled: false })
    await reconciler.reconcile(server)

    expect(appsApi.deleteNamespacedDeployment).toHaveBeenCalledWith({
      name: 'pg',
      namespace: 'mcp-server',
    })
    const sets = patchedConditionSets(customApi)
    expect(
      sets.some(conditions =>
        conditions.some(condition => condition.type === 'Ready' && condition.reason === 'Disabled')
      )
    ).toBe(true)
    const retirementIndex = sets.findIndex(conditions =>
      conditions.some(
        condition =>
          condition.type === 'DeploymentReady' &&
          condition.status === 'False' &&
          condition.reason === 'RuntimeNotDesired' &&
          condition.message === RUNTIME_NOT_DESIRED_DISABLED_MESSAGE
      )
    )
    expect(retirementIndex).toBeGreaterThanOrEqual(0)
    expect(sets.flat().some(condition => condition.type === 'NetworkReady')).toBe(false)
    expect(appsApi.deleteNamespacedDeployment.mock.invocationCallOrder[0]).toBeLessThan(
      customApi.patchNamespacedCustomObjectStatus.mock.invocationCallOrder[retirementIndex]
    )
  })

  it('recovery after fail-closed stamps a fresh WaitingForReplicas time', async () => {
    vi.useFakeTimers()
    try {
      const err = new Error('not found') as Error & { code?: number }
      err.code = 404
      coreApi.readNamespacedSecret.mockRejectedValueOnce(err)
      installLiveStatus(customApi, [
        secretResolvedTrue(),
        deploymentReadyTrue(),
        networkReadyTrue(),
      ])
      const server = makeServer({
        name: 'pg',
        managed: true,
        envSecret: { name: 'pg-creds', keys: [{ secretKey: 'password', envVar: 'PGPASSWORD' }] },
      })
      await reconciler.reconcile(server)
      const retirement = patchedConditionSets(customApi)
        .flat()
        .find(condition => condition.reason === 'RuntimeNotDesired')
      expect(retirement?.lastTransitionTime).toBeDefined()
      const retiredAt = retirement!.lastTransitionTime

      await vi.advanceTimersByTimeAsync(1000)
      coreApi.readNamespacedSecret.mockResolvedValue({
        data: { password: storedSecret('fixture-key') },
      })
      appsApi.readNamespacedDeployment.mockRejectedValueOnce({ code: 404 })
      coreApi.readNamespacedService.mockRejectedValueOnce({ code: 404 })
      appsApi.readNamespacedDeployment.mockResolvedValue({
        metadata: {
          name: 'pg',
          namespace: 'mcp-server',
          generation: 2,
          labels: {
            'clerum.io/managed-by': 'host-context-controller',
            'clerum.io/mcpserver': 'pg',
          },
        },
        spec: { replicas: 1 },
        status: { observedGeneration: 1, updatedReplicas: 0, readyReplicas: 0, replicas: 1 },
      })

      await reconciler.reconcile(server)
      const waiting = patchedConditionSets(customApi)
        .flat()
        .filter(condition => condition.type === 'DeploymentReady')
        .at(-1)
      expect(waiting).toMatchObject({
        status: 'False',
        reason: 'WaitingForReplicas',
      })
      expect(Date.parse(waiting!.lastTransitionTime)).toBeGreaterThan(Date.parse(retiredAt))
      expect(
        patchedConditionSets(customApi)
          .flat()
          .some(condition => condition.type === 'NetworkReady')
      ).toBe(false)

      appsApi.readNamespacedDeployment.mockResolvedValue({
        metadata: {
          name: 'pg',
          namespace: 'mcp-server',
          generation: 2,
          labels: {
            'clerum.io/managed-by': 'host-context-controller',
            'clerum.io/mcpserver': 'pg',
          },
        },
        spec: { replicas: 1 },
        status: {
          observedGeneration: 2,
          replicas: 1,
          updatedReplicas: 1,
          readyReplicas: 1,
          unavailableReplicas: 0,
        },
      })
      const readsBeforePoll = appsApi.readNamespacedDeployment.mock.calls.length
      await vi.advanceTimersByTimeAsync(5000)
      expect(appsApi.readNamespacedDeployment.mock.calls.length).toBeGreaterThan(readsBeforePoll)
      const ready = patchedConditionSets(customApi)
        .flat()
        .filter(condition => condition.type === 'DeploymentReady')
        .at(-1)
      expect(ready?.status).toBe('True')
      expect(Date.parse(ready!.lastTransitionTime)).toBeGreaterThan(Date.parse(retiredAt))
      expect(
        patchedConditionSets(customApi)
          .flat()
          .some(condition => condition.type === 'NetworkReady')
      ).toBe(false)
    } finally {
      vi.useRealTimers()
    }
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
      'Failed to delete runtime Kubernetes resources for McpServer "pg"'
    )
    expect(appsApi.deleteNamespacedDeployment).toHaveBeenCalled()
    expect(
      patchedConditionSets(customApi).some(conditions =>
        conditions.some(condition => condition.reason === 'RuntimeNotDesired')
      )
    ).toBe(false)
    expect(coreApi.deleteNamespacedService).toHaveBeenCalledWith({
      name: 'pg',
      namespace: 'mcp-server',
    })
    // #1338: the fail-closed verdict is published in memory before
    // the retract, so a retract that throws no longer leaves the previous
    // (here: never-reconciled) verdict behind.
    expect(reconciler.getStatus('pg')).toMatchObject({
      deployed: false,
      ready: false,
      message: 'Secret "pg-creds" not found in namespace "mcp-server"',
    })
  })
})

describe('PR-B B1 — writeStatusCondition', () => {
  let appsApi: ReturnType<typeof createMockAppsApi>
  let coreApi: ReturnType<typeof createMockCoreApi>
  let customApi: ReturnType<typeof createMockCustomApi>
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
    appsApi = createMockAppsApi()
    coreApi = createMockCoreApi()
    customApi = createMockCustomApi()
    reconciler = new McpServerReconciler({} as k8s.KubeConfig, {
      assumeInventoryAuthorityWhenUnconfigured: true,
      appsApi: asAppsApi(appsApi),
      coreApi: asCoreApi(coreApi),
      customApi: asCustomApi(customApi),
    })
  })

  it('bumps DeploymentReady lastTransitionTime when reason changes at the same status', async () => {
    customApi.getNamespacedCustomObjectStatus.mockResolvedValueOnce({
      status: {
        conditions: [
          {
            type: 'DeploymentReady',
            status: 'False',
            reason: 'RuntimeNotDesired',
            message: RUNTIME_NOT_DESIRED_FAIL_CLOSED_MESSAGE,
            lastTransitionTime: '2020-01-01T00:00:00.000Z',
          },
        ],
      },
    })

    const server = makeServer({ name: 'pg' })
    await reconciler.writeStatusCondition(server, {
      type: 'DeploymentReady',
      status: 'False',
      reason: 'WaitingForReplicas',
      message: 'Waiting for pods to become ready',
    })

    const { conditions } = getPatchedConditions()
    const written = conditions.find((c: { type: string }) => c.type === 'DeploymentReady')
    expect(written.lastTransitionTime).not.toBe('2020-01-01T00:00:00.000Z')
    expect(Date.parse(written.lastTransitionTime)).toBeGreaterThan(
      Date.parse('2020-01-01T00:00:00.000Z')
    )
  })

  it('bumps DeploymentReady lastTransitionTime when only the message changes', async () => {
    customApi.getNamespacedCustomObjectStatus.mockResolvedValueOnce({
      status: {
        conditions: [
          {
            type: 'DeploymentReady',
            status: 'False',
            reason: 'WaitingForReplicas',
            message: 'Waiting for pods to become ready',
            lastTransitionTime: '2020-01-01T00:00:00.000Z',
          },
        ],
      },
    })

    const server = makeServer({ name: 'pg' })
    await reconciler.writeStatusCondition(server, {
      type: 'DeploymentReady',
      status: 'False',
      reason: 'WaitingForReplicas',
      message: 'Rollout did not converge — 0/1 ready',
    })

    const { conditions } = getPatchedConditions()
    const written = conditions.find((c: { type: string }) => c.type === 'DeploymentReady')
    expect(written.lastTransitionTime).not.toBe('2020-01-01T00:00:00.000Z')
    expect(Date.parse(written.lastTransitionTime)).toBeGreaterThan(
      Date.parse('2020-01-01T00:00:00.000Z')
    )
    expect(written.message).toBe('Rollout did not converge — 0/1 ready')
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
            type: 'ExternalEgressReady',
            status: 'True',
            reason: 'EgressPolicyApplied',
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
    expect(types).toContain('ExternalEgressReady')
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
    const externalEgressReady = {
      type: 'ExternalEgressReady',
      status: 'True',
      reason: 'EgressPolicyApplied',
      message: 'external egress ready',
      lastTransitionTime: '2020-01-01T00:00:00.000Z',
    }
    const peerCondition = {
      type: 'SecretResolved',
      status: 'True',
      reason: 'SecretFound',
      message: 'peer write',
      lastTransitionTime: '2020-01-02T00:00:00.000Z',
    }
    customApi.getNamespacedCustomObjectStatus
      .mockResolvedValueOnce({
        metadata: { resourceVersion: '100' },
        status: { conditions: [externalEgressReady] },
      })
      .mockResolvedValueOnce({
        metadata: { resourceVersion: '101' },
        status: { conditions: [externalEgressReady, peerCondition] },
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
      'ExternalEgressReady',
      'SecretResolved',
      'Ready',
    ])
  })

  it('writeStatusCondition of an identical Ready still strips NetworkReady across a 422 retry', async () => {
    const ready = {
      type: 'Ready',
      status: 'True',
      reason: 'ReconcileSuccess',
      message: 'done',
      lastTransitionTime: '2020-01-01T00:00:00.000Z',
    }
    const thirdParty = {
      type: 'ExternalEgressReady',
      status: 'True',
      reason: 'EgressPolicyApplied',
      message: 'peer',
      lastTransitionTime: '2020-01-02T00:00:00.000Z',
    }
    customApi.getNamespacedCustomObjectStatus
      .mockResolvedValueOnce({
        metadata: { resourceVersion: '100' },
        status: { conditions: [ready, networkReadyTrue()] },
      })
      .mockResolvedValueOnce({
        metadata: { resourceVersion: '101' },
        status: { conditions: [ready, networkReadyTrue(), thirdParty] },
      })
    customApi.patchNamespacedCustomObjectStatus
      .mockRejectedValueOnce(Object.assign(new Error('conflict'), { code: 422 }))
      .mockResolvedValueOnce({})

    await reconciler.writeStatusCondition(makeServer({ name: 'pg' }), {
      type: 'Ready',
      status: 'True',
      reason: 'ReconcileSuccess',
      message: 'done',
    })

    expect(customApi.getNamespacedCustomObjectStatus).toHaveBeenCalledTimes(2)
    expect(customApi.patchNamespacedCustomObjectStatus).toHaveBeenCalledTimes(2)
    const firstTypes = patchedConditionSets(customApi)[0].map(condition => condition.type)
    const secondTypes = patchedConditionSets(customApi)[1].map(condition => condition.type)
    expect(firstTypes).toContain('Ready')
    expect(firstTypes).not.toContain('NetworkReady')
    expect(secondTypes).toContain('Ready')
    expect(secondTypes).toContain('ExternalEgressReady')
    expect(secondTypes).not.toContain('NetworkReady')
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
    const warn = vi.spyOn(hccLogger, 'warn').mockImplementation(() => undefined)

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
    expect(warn).toHaveBeenCalledWith('Failed to write status condition', {
      scope: '[Reconciler]',
      name: 'pg',
      type: 'Ready',
      status: 'True',
      attempt: 3,
      maxAttempts: 3,
      err: conflict,
    })
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
    const warn = vi.spyOn(hccLogger, 'warn').mockImplementation(() => undefined)

    await reconciler.writeStatusCondition(staleServer, {
      type: 'Ready',
      status: 'True',
      reason: 'ReconcileSuccess',
      message: 'stale reconcile result',
    })

    expect(warn).toHaveBeenCalledWith('Failed to write status condition', {
      scope: '[Reconciler]',
      name: 'recreated',
      type: 'Ready',
      status: 'True',
      attempt: 1,
      maxAttempts: 3,
      err: writeFailure,
    })
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
    ).resolves.toBe('declined')

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

describe('restart-safe discovery status', () => {
  let appsApi: ReturnType<typeof createMockAppsApi>
  let coreApi: ReturnType<typeof createMockCoreApi>
  let customApi: ReturnType<typeof createMockCustomApi>
  let reconciler: McpServerReconciler

  beforeEach(() => {
    appsApi = createMockAppsApi()
    coreApi = createMockCoreApi()
    customApi = createMockCustomApi()
    reconciler = new McpServerReconciler({} as k8s.KubeConfig, {
      assumeInventoryAuthorityWhenUnconfigured: true,
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
    // First materialization is absent; subsequent reads still use the live-state fixture.
    appsApi.readNamespacedDeployment.mockRejectedValueOnce({ code: 404 })
    coreApi.readNamespacedService.mockRejectedValueOnce({ code: 404 })
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
    appsApi.readNamespacedDeployment.mockRejectedValueOnce({ code: 404 })
    coreApi.readNamespacedService.mockRejectedValueOnce({ code: 404 })
    const original: McpServerCRD = {
      ...makeServer({ name: 'identity-fenced' }),
      uid: 'original-uid',
      generation: 3,
    }
    await reconciler.reconcile(original)
    // #223 (credential rotation) makes readiness immediately False until the poll
    // upgrades it, so the original caches deployed/authoritative here — not ready.
    // This test's subject is the identity fencing asserted below, not readiness
    // timing; it only needs a real (non-default) cached status to prove it is not
    // reused across an identity change.
    expect(reconciler.getStatus(original)).toEqual(
      expect.objectContaining({ deployed: true, ready: false, authoritative: true })
    )

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
  let appsApi: ReturnType<typeof createMockAppsApi>
  let coreApi: ReturnType<typeof createMockCoreApi>
  let customApi: ReturnType<typeof createMockCustomApi>
  let reconciler: McpServerReconciler

  beforeEach(() => {
    appsApi = createMockAppsApi()
    coreApi = createMockCoreApi()
    customApi = createMockCustomApi()
    reconciler = new McpServerReconciler({} as k8s.KubeConfig, {
      assumeInventoryAuthorityWhenUnconfigured: true,
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
    installLiveStatus(customApi, [networkReadyTrue()])

    const server = makeServer({
      name: 'pg',
      managed: true,
      envSecret: { name: 'pg-creds', keys: [{ secretKey: 'password', envVar: 'PGPASSWORD' }] },
    })

    await reconciler.reconcile(server)

    expect(appsApi.deleteNamespacedDeployment).not.toHaveBeenCalled()
    expect(coreApi.deleteNamespacedService).not.toHaveBeenCalled()
    const secretResolved = firstPatchWithType(patchedConditionSets(customApi), 'SecretResolved')
    expect(secretResolved).toBeDefined()
    expect(secretResolved?.some(condition => condition.reason === 'ReadError')).toBe(true)
    expect(secretResolved?.map(condition => condition.type)).not.toContain('NetworkReady')
    expect(
      patchedConditionSets(customApi).some(conditions =>
        conditions.some(condition => condition.reason === 'RuntimeNotDesired')
      )
    ).toBe(false)
    expect(reconciler.hasIncompleteReconciliation()).toBe(true)
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
    expect(
      patchedConditionSets(customApi).some(conditions =>
        conditions.some(
          condition => condition.type === 'SecretResolved' && condition.reason === 'SecretNotFound'
        )
      )
    ).toBe(true)
    expect(
      patchedConditionSets(customApi).some(conditions =>
        conditions.some(
          condition => condition.type === 'Ready' && condition.reason === 'SecretValidationFailed'
        )
      )
    ).toBe(true)
    expect(
      patchedConditionSets(customApi).some(conditions =>
        conditions.some(condition => condition.reason === 'RuntimeNotDesired')
      )
    ).toBe(false)
    expect(reconciler.hasIncompleteReconciliation()).toBe(false)
  })

  it('keeps the obligation when a foreign Deployment sits next to a denied HCC Service', async () => {
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
    let seenServiceRead = false
    let deniedServiceDelete = false
    coreApi.readNamespacedService.mockImplementation(async () => {
      seenServiceRead = true
      return { metadata: hccOwnedMetadata('pg') }
    })

    const server = makeServer({
      name: 'pg',
      managed: true,
      envSecret: { name: 'pg-creds', keys: [{ secretKey: 'password', envVar: 'PGPASSWORD' }] },
    })
    await reconciler.reconcile(server, {
      isCurrent: () => {
        if (seenServiceRead && !deniedServiceDelete) {
          deniedServiceDelete = true
          return false
        }
        return true
      },
    })

    expect(appsApi.deleteNamespacedDeployment).not.toHaveBeenCalled()
    expect(coreApi.deleteNamespacedService).not.toHaveBeenCalled()
    expect(
      patchedConditionSets(customApi).some(conditions =>
        conditions.some(condition => condition.reason === 'RuntimeNotDesired')
      )
    ).toBe(false)
    expect(reconciler.hasIncompleteReconciliation()).toBe(true)
  })

  it('disabled managed server still writes Disabled when the runtime is WRC-owned', async () => {
    appsApi.readNamespacedDeployment.mockResolvedValueOnce({
      metadata: {
        labels: {
          [MANAGED_BY_LABEL]: WRC_MANAGED_BY_VALUE,
          [MCPSERVER_LABEL]: 'pg',
        },
      },
    })

    await reconciler.reconcile(makeServer({ name: 'pg', managed: true, enabled: false }))

    expect(appsApi.deleteNamespacedDeployment).not.toHaveBeenCalled()
    expect(
      patchedConditionSets(customApi).some(conditions =>
        conditions.some(condition => condition.type === 'Ready' && condition.reason === 'Disabled')
      )
    ).toBe(true)
    expect(
      patchedConditionSets(customApi).some(conditions =>
        conditions.some(condition => condition.reason === 'RuntimeNotDesired')
      )
    ).toBe(false)
    expect(reconciler.hasIncompleteReconciliation()).toBe(false)
  })

  it('fail-closed status write failure after Deployment delete keeps obligation and publishes not-ready', async () => {
    const err = new Error('not found') as Error & { code?: number }
    err.code = 404
    coreApi.readNamespacedSecret.mockRejectedValueOnce(err)
    installLiveStatus(customApi, [secretResolvedTrue(), deploymentReadyTrue(), networkReadyTrue()])
    failRuntimeNotDesiredWrites(customApi)

    const server = persistReadySeed(
      makeServer({
        name: 'pg',
        managed: true,
        envSecret: { name: 'pg-creds', keys: [{ secretKey: 'password', envVar: 'PGPASSWORD' }] },
      })
    )
    await reconciler.reconcile(server)

    expect(appsApi.deleteNamespacedDeployment).toHaveBeenCalled()
    expect(
      patchedConditionSets(customApi).some(conditions =>
        conditions.some(condition => condition.reason === 'RuntimeNotDesired')
      )
    ).toBe(true)
    expect(
      patchedConditionSets(customApi).some(conditions =>
        conditions.some(
          condition => condition.type === 'Ready' && condition.reason === 'SecretValidationFailed'
        )
      )
    ).toBe(true)
    expect(
      patchedConditionSets(customApi).some(conditions =>
        conditions.some(
          condition => condition.type === 'SecretResolved' && condition.status === 'False'
        )
      )
    ).toBe(true)
    expect(reconciler.getStatus(server)).toMatchObject({
      deployed: false,
      ready: false,
      authoritative: true,
    })
    expect(reconciler.hasIncompleteReconciliation()).toBe(true)
  })

  it('disabled status write failure after Deployment delete still publishes Disabled', async () => {
    installLiveStatus(customApi, [secretResolvedTrue(), deploymentReadyTrue(), networkReadyTrue()])
    failRuntimeNotDesiredWrites(customApi)

    const server = persistReadySeed(makeServer({ name: 'pg', managed: true, enabled: false }))
    await reconciler.reconcile(server)

    expect(appsApi.deleteNamespacedDeployment).toHaveBeenCalled()
    expect(
      patchedConditionSets(customApi).some(conditions =>
        conditions.some(condition => condition.type === 'Ready' && condition.reason === 'Disabled')
      )
    ).toBe(true)
    expect(
      patchedConditionSets(customApi).some(conditions =>
        conditions.some(
          condition => condition.type === 'SecretResolved' && condition.status === 'False'
        )
      )
    ).toBe(false)
    expect(reconciler.getStatus(server)).toMatchObject({
      deployed: false,
      ready: false,
      authoritative: true,
    })
    expect(reconciler.hasIncompleteReconciliation()).toBe(true)
  })
})

describe('full reconciliation inventory authority', () => {
  let appsApi: ReturnType<typeof createMockAppsApi>
  let coreApi: ReturnType<typeof createMockCoreApi>
  let customApi: ReturnType<typeof createMockCustomApi>
  let reconciler: McpServerReconciler

  beforeEach(() => {
    appsApi = createMockAppsApi()
    coreApi = createMockCoreApi()
    customApi = createMockCustomApi()
    customApi.getNamespacedCustomObject.mockRejectedValue(
      Object.assign(new Error('not found'), { code: 404 })
    )
    reconciler = new McpServerReconciler({} as k8s.KubeConfig, {
      assumeInventoryAuthorityWhenUnconfigured: true,
      appsApi: asAppsApi(appsApi),
      coreApi: asCoreApi(coreApi),
      customApi: asCustomApi(customApi),
    })
  })

  it('rejects when Deployment inventory LIST fails so startup retry remains possible', async () => {
    const inventoryError = new Error('deployment inventory unavailable')
    const error = vi.spyOn(hccLogger, 'error').mockImplementation(() => undefined)
    appsApi.listNamespacedDeployment.mockRejectedValueOnce(inventoryError)

    await expect(reconciler.fullReconcile([])).rejects.toBe(inventoryError)

    expect(error).toHaveBeenCalledWith('Failed to list managed deployments', {
      scope: '[Reconciler]',
      err: inventoryError,
    })
    error.mockRestore()
  })

  it('defaults to fail-closed orphan cleanup until an authority source is wired', async () => {
    const warn = vi.spyOn(hccLogger, 'warn').mockImplementation(() => undefined)
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
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining('inventory authority'),
      expect.anything()
    )
    warn.mockRestore()
  })

  it('finishes desired reconciliation but skips orphan cleanup if inventory authority is lost mid-pass', async () => {
    let authority = { known: true, generation: 7 }
    reconciler.setInventoryAuthority(() => authority)
    const desired = makeServer({ name: 'desired-server' })
    const warn = vi.spyOn(hccLogger, 'warn').mockImplementation(() => undefined)
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
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining('inventory authority'),
      expect.anything()
    )
    warn.mockRestore()
  })

  it('skips orphan cleanup if the authoritative inventory generation changes mid-pass', async () => {
    let authority = { known: true, generation: 11 }
    reconciler.setInventoryAuthority(() => authority)
    const warn = vi.spyOn(hccLogger, 'warn').mockImplementation(() => undefined)
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
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining('inventory authority'),
      expect.anything()
    )
    warn.mockRestore()
  })

  it('limits a scoped pass to its names without treating out-of-scope servers as orphans', async () => {
    reconciler.setInventoryAuthority(() => ({ known: true, generation: 31 }))
    const failed = makeServer({ name: 'failed-server' })
    const healthy = makeServer({ name: 'healthy-server' })
    const reconcile = vi.spyOn(reconciler, 'reconcile').mockResolvedValue(undefined)
    appsApi.listNamespacedDeployment.mockResolvedValueOnce({
      items: [
        { metadata: { name: 'healthy-server', namespace: 'mcp-server' } },
        { metadata: { name: 'scoped-orphan', namespace: 'mcp-server' } },
        { metadata: { name: 'unscoped-orphan', namespace: 'mcp-server' } },
      ],
    })

    await reconciler.fullReconcile([failed, healthy], {
      scope: new Set(['failed-server', 'scoped-orphan']),
    })

    expect(reconcile.mock.calls.map(([server]) => server.name)).toEqual(['failed-server'])
    expect(appsApi.deleteNamespacedDeployment).toHaveBeenCalledOnce()
    expect(appsApi.deleteNamespacedDeployment).toHaveBeenCalledWith({
      name: 'scoped-orphan',
      namespace: 'mcp-server',
    })
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
        image: 'clerum/updated-server:old',
        transport: { type: 'streamableHttp', port: 3000 },
      },
    }
    const current: McpServerCRD = {
      ...makeServer({ name: 'updated-server' }),
      generation: 2,
      spec: {
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
    // First materialization is absent; subsequent reads still use the live-state fixture.
    appsApi.readNamespacedDeployment.mockRejectedValueOnce({ code: 404 })
    coreApi.readNamespacedService.mockRejectedValueOnce({ code: 404 })
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
  let appsApi: ReturnType<typeof createMockAppsApi>
  let coreApi: ReturnType<typeof createMockCoreApi>
  let customApi: ReturnType<typeof createMockCustomApi>
  let reconciler: McpServerReconciler

  beforeEach(() => {
    appsApi = createMockAppsApi()
    coreApi = createMockCoreApi()
    customApi = createMockCustomApi()
    reconciler = new McpServerReconciler({} as k8s.KubeConfig, {
      assumeInventoryAuthorityWhenUnconfigured: true,
      appsApi: asAppsApi(appsApi),
      coreApi: asCoreApi(coreApi),
      customApi: asCustomApi(customApi),
    })
  })

  it('updateStatusConditions removes NetworkReady and preserves SecretResolved and DeploymentReady in one patch', async () => {
    const server = makeServer({ name: 'pg' })
    installLiveStatus(customApi, [secretResolvedTrue(), deploymentReadyTrue(), networkReadyTrue()])

    await (
      reconciler as unknown as {
        updateStatusConditions(server: McpServerCRD, deploymentReady: boolean): Promise<void>
      }
    ).updateStatusConditions(server, true)

    expect(customApi.getNamespacedCustomObjectStatus).toHaveBeenCalledTimes(1)
    expect(customApi.patchNamespacedCustomObjectStatus).toHaveBeenCalledTimes(1)
    const finalConditions = patchedConditionSets(customApi)[0]
    expect(finalConditions.map(condition => condition.type)).toEqual([
      'SecretResolved',
      'DeploymentReady',
    ])
    expect(
      finalConditions.find(condition => condition.type === 'SecretResolved')?.lastTransitionTime
    ).toBe(secretResolvedTrue().lastTransitionTime)
    expect(
      finalConditions.find(condition => condition.type === 'DeploymentReady')?.lastTransitionTime
    ).toBe(deploymentReadyTrue().lastTransitionTime)
  })

  it('preserves unrelated conditions while updating DeploymentReady and removing NetworkReady', async () => {
    const server = makeServer({ name: 'pg' })
    installLiveStatus(customApi, [secretResolvedTrue(), networkReadyTrue()])

    await (
      reconciler as unknown as {
        updateStatusConditions(server: McpServerCRD, deploymentReady: boolean): Promise<void>
      }
    ).updateStatusConditions(server, false)

    expect(customApi.patchNamespacedCustomObjectStatus).toHaveBeenCalledTimes(1)
    const types = patchedConditionSets(customApi)[0].map(condition => condition.type)
    expect(types).toContain('SecretResolved')
    expect(types).not.toContain('NetworkReady')
    expect(types).toContain('DeploymentReady')
  })

  it('does not log Updated status conditions when the write was skipped', async () => {
    const server = makeServer({ name: 'pg' })
    installLiveStatus(customApi, [deploymentReadyTrue()])

    const updateStatusConditions = (
      reconciler as unknown as {
        updateStatusConditions(server: McpServerCRD, deploymentReady: boolean): Promise<void>
      }
    ).updateStatusConditions.bind(reconciler)

    await updateStatusConditions(server, true)
    expect(customApi.patchNamespacedCustomObjectStatus).not.toHaveBeenCalled()
    expect(customApi.getNamespacedCustomObjectStatus).toHaveBeenCalledTimes(1)

    customApi.getNamespacedCustomObjectStatus.mockClear()
    const info = vi.spyOn(hccLogger, 'info').mockImplementation(() => undefined)
    try {
      await updateStatusConditions(server, true)
      expect(customApi.getNamespacedCustomObjectStatus).toHaveBeenCalledTimes(1)
      expect(customApi.patchNamespacedCustomObjectStatus).not.toHaveBeenCalled()
      expect(info.mock.calls.map(call => call[0])).not.toContain('Updated status conditions')
    } finally {
      info.mockRestore()
    }
  })

  it('skips a second identical updateStatusConditions call after NetworkReady was stripped', async () => {
    const server = makeServer({ name: 'pg' })
    installLiveStatus(customApi, [secretResolvedTrue(), deploymentReadyTrue(), networkReadyTrue()])
    const updateStatusConditions = (
      reconciler as unknown as {
        updateStatusConditions(server: McpServerCRD, deploymentReady: boolean): Promise<void>
      }
    ).updateStatusConditions.bind(reconciler)

    await updateStatusConditions(server, true)
    expect(customApi.patchNamespacedCustomObjectStatus).toHaveBeenCalledTimes(1)

    customApi.patchNamespacedCustomObjectStatus.mockClear()
    customApi.getNamespacedCustomObjectStatus.mockClear()
    const info = vi.spyOn(hccLogger, 'info').mockImplementation(() => undefined)
    try {
      await updateStatusConditions(server, true)
      expect(customApi.getNamespacedCustomObjectStatus).toHaveBeenCalledTimes(1)
      expect(customApi.patchNamespacedCustomObjectStatus).not.toHaveBeenCalled()
      expect(info.mock.calls.map(call => call[0])).not.toContain('Updated status conditions')
    } finally {
      info.mockRestore()
    }
  })

  it('does not patch when DeploymentReady already matches and NetworkReady is absent', async () => {
    const server = makeServer({ name: 'pg' })
    installLiveStatus(customApi, [secretResolvedTrue(), deploymentReadyTrue()])

    await (
      reconciler as unknown as {
        updateStatusConditions(server: McpServerCRD, deploymentReady: boolean): Promise<void>
      }
    ).updateStatusConditions(server, true)

    expect(customApi.getNamespacedCustomObjectStatus).toHaveBeenCalledTimes(1)
    expect(customApi.patchNamespacedCustomObjectStatus).not.toHaveBeenCalled()
  })
})

describe('unconfigured inventory authority fails closed (G1)', () => {
  let appsApi: ReturnType<typeof createMockAppsApi>
  let coreApi: ReturnType<typeof createMockCoreApi>
  let customApi: ReturnType<typeof createMockCustomApi>
  let errorSpy: ReturnType<typeof vi.spyOn>

  // Deliberately NO assumeInventoryAuthorityWhenUnconfigured and NO
  // setInventoryAuthority/setResolveCurrentServer wiring: the fence must deny.
  function makeUnwiredReconciler(): McpServerReconciler {
    return new McpServerReconciler({} as k8s.KubeConfig, {
      appsApi: asAppsApi(appsApi),
      coreApi: asCoreApi(coreApi),
      customApi: asCustomApi(customApi),
    })
  }

  beforeEach(() => {
    appsApi = createMockAppsApi()
    coreApi = createMockCoreApi()
    customApi = createMockCustomApi()
    errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
  })

  afterEach(() => {
    errorSpy.mockRestore()
  })

  it('T-G1a: reconcile() denies (no Deployment) and warns once when authority is unwired', async () => {
    const reconciler = makeUnwiredReconciler()
    await reconciler.reconcile(makeServer({ name: 'g1-mcp', managed: true }))
    expect(appsApi.createNamespacedDeployment).not.toHaveBeenCalled()
    expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining('fail closed'))
  })

  it('T-G1b: fullReconcile() denies when authority is unwired', async () => {
    const reconciler = makeUnwiredReconciler()
    await reconciler.fullReconcile([makeServer({ name: 'g1-mcp', managed: true })])
    expect(appsApi.createNamespacedDeployment).not.toHaveBeenCalled()
  })

  it('T-G1c: the explicit opt-in restores assume-current', async () => {
    // First materialization is absent; subsequent reads still use the live-state fixture.
    appsApi.readNamespacedDeployment.mockRejectedValueOnce({ code: 404 })
    coreApi.readNamespacedService.mockRejectedValueOnce({ code: 404 })
    const reconciler = new McpServerReconciler({} as k8s.KubeConfig, {
      appsApi: asAppsApi(appsApi),
      coreApi: asCoreApi(coreApi),
      customApi: asCustomApi(customApi),
      assumeInventoryAuthorityWhenUnconfigured: true,
    })
    await reconciler.reconcile(makeServer({ name: 'g1-mcp', managed: true }))
    expect(appsApi.createNamespacedDeployment).toHaveBeenCalled()
  })
})

// ─── #1338: a failed Kubernetes call does not withdraw a published verdict ──

type H3LogEntry = { level: string; message: string; fields: any }

/**
 * Capture the lines HostContextLogger prints. Its `sanitize` step redacts
 * field names such as `key` or `secret`, so assertions read the serialized
 * output, not the arguments passed to `hccLogger.*`.
 */
function captureH3Logs(): { entries: H3LogEntry[]; restore: () => void } {
  const entries: H3LogEntry[] = []
  const spies = (['log', 'warn', 'error'] as const).map(method =>
    vi.spyOn(console, method).mockImplementation((line?: unknown) => {
      if (typeof line !== 'string' || !line.startsWith('{')) return
      const fields = JSON.parse(line)
      entries.push({ level: fields.level, message: fields.msg, fields })
    })
  )
  return { entries, restore: () => spies.forEach(spy => spy.mockRestore()) }
}

function h3Events(entries: H3LogEntry[], event: string): any[] {
  return entries.filter(entry => entry.fields?.event === event).map(entry => entry.fields)
}

async function reconcileCallFailures(site: string, outcome: string): Promise<number> {
  const metric = registry.getSingleMetric('clerum_hcc_mcpserver_reconcile_call_failures_total')
  if (!metric)
    throw new Error('clerum_hcc_mcpserver_reconcile_call_failures_total is not registered')
  const snapshot = await metric.get()
  return (
    snapshot.values.find(entry => entry.labels.site === site && entry.labels.outcome === outcome)
      ?.value ?? 0
  )
}

const H3_READY_ROLLOUT = {
  observedGeneration: 1,
  replicas: 1,
  updatedReplicas: 1,
  readyReplicas: 1,
  availableReplicas: 1,
  unavailableReplicas: 0,
}

const H3_WAITING_ROLLOUT = {
  ...H3_READY_ROLLOUT,
  readyReplicas: 0,
  availableReplicas: 0,
  unavailableReplicas: 1,
}

function h3Absent(): Error & { code: number } {
  return Object.assign(new Error('fixture object absent'), { code: 404 })
}

function h3Timeout(operation = 'readNamespacedSecret'): K8sRequestTimeoutError {
  return new K8sRequestTimeoutError(operation, 30_000)
}

const H3_TRANSIENT_FAILURES: Array<[string, () => unknown]> = [
  ['the request deadline', () => h3Timeout()],
  ['a connection reset', () => Object.assign(new Error('socket hang up'), { code: 'ECONNRESET' })],
  ['an apiserver 500', () => Object.assign(new Error('internal error'), { code: 500 })],
  ['an apiserver 429', () => Object.assign(new Error('too many requests'), { code: 429 })],
]

/**
 * A stateful cluster: Deployments and Services persist what HCC writes, so a
 * second reconcile of an unchanged server reads objects that already match
 * desired and attempts no write. Status conditions persist too.
 */
function h3Cluster(options: { rolloutReady?: boolean } = {}) {
  const appsApi = createMockAppsApi()
  const coreApi = createMockCoreApi()
  const customApi = createMockCustomApi()
  const deployments = new Map<string, any>()
  const services = new Map<string, any>()
  let rolloutReady = options.rolloutReady ?? true
  const store = (objects: Map<string, any>, body: any) => {
    const object = structuredClone(body)
    object.metadata = { ...object.metadata, resourceVersion: '1', generation: 1 }
    objects.set(object.metadata.name, object)
    return structuredClone(object)
  }
  const readDeployment = async ({ name }: { name: string }) => {
    const deployment = deployments.get(name)
    if (!deployment) throw h3Absent()
    return {
      ...structuredClone(deployment),
      status: rolloutReady ? H3_READY_ROLLOUT : H3_WAITING_ROLLOUT,
    }
  }
  const readSecret = async ({ name }: { name: string }) => ({
    metadata: { name, resourceVersion: '1' },
    data: { password: storedSecret('fixture-input-value') },
  })
  appsApi.readNamespacedDeployment.mockImplementation(readDeployment)
  appsApi.createNamespacedDeployment.mockImplementation(async ({ body }: any) =>
    store(deployments, body)
  )
  appsApi.replaceNamespacedDeployment.mockImplementation(async ({ body }: any) =>
    store(deployments, body)
  )
  appsApi.deleteNamespacedDeployment.mockImplementation(async ({ name }: any) => {
    deployments.delete(name)
    return {}
  })
  coreApi.readNamespacedService.mockImplementation(async ({ name }: any) => {
    const service = services.get(name)
    if (!service) throw h3Absent()
    return structuredClone(service)
  })
  coreApi.createNamespacedService.mockImplementation(async ({ body }: any) => store(services, body))
  coreApi.replaceNamespacedService.mockImplementation(async ({ body }: any) =>
    store(services, body)
  )
  coreApi.deleteNamespacedService.mockImplementation(async ({ name }: any) => {
    services.delete(name)
    return {}
  })
  const configMaps = new Map<string, any>()
  coreApi.readNamespacedConfigMap.mockImplementation(async ({ name }: any) => {
    const configMap = configMaps.get(name)
    if (!configMap) throw h3Absent()
    return structuredClone(configMap)
  })
  coreApi.createNamespacedConfigMap.mockImplementation(async ({ body }: any) =>
    store(configMaps, body)
  )
  coreApi.replaceNamespacedConfigMap.mockImplementation(async ({ body }: any) =>
    store(configMaps, body)
  )
  coreApi.readNamespacedSecret.mockImplementation(readSecret)
  const status = installLiveStatus(customApi)
  const reconciler = new McpServerReconciler({} as k8s.KubeConfig, {
    assumeInventoryAuthorityWhenUnconfigured: true,
    appsApi: asAppsApi(appsApi),
    coreApi: asCoreApi(coreApi),
    customApi: asCustomApi(customApi),
  })
  const listener = vi.fn()
  reconciler.setIncompleteReconciliationListener(listener)
  return {
    appsApi,
    coreApi,
    customApi,
    reconciler,
    status,
    listener,
    deployments,
    services,
    configMaps,
    readDeployment,
    readSecret,
    setRolloutReady: (ready: boolean) => {
      rolloutReady = ready
    },
    patches: () => customApi.patchNamespacedCustomObjectStatus.mock.calls.length,
    secretReads: () => coreApi.readNamespacedSecret.mock.calls.length,
    condition: (type: string) => status.current().find(condition => condition.type === type),
  }
}

function h3Server(overrides: Partial<McpServerCRD> = {}): McpServerCRD {
  return {
    ...makeServer({
      name: 'h3-server',
      envSecret: { name: 'h3-input', keys: [{ secretKey: 'password', envVar: 'INPUT_VALUE' }] },
    }),
    uid: 'uid-h3',
    generation: 1,
    ...overrides,
  }
}

async function h3ReadyCluster(server = h3Server()) {
  const f = h3Cluster()
  await f.reconciler.reconcile(server)
  expect(f.reconciler.getStatus(server)).toMatchObject({
    deployed: true,
    ready: true,
    authoritative: true,
  })
  expect(f.reconciler.hasIncompleteReconciliation()).toBe(false)
  return f
}

describe('#1338: a Secret read error keeps an authoritative verdict', () => {
  let logs: ReturnType<typeof captureH3Logs>
  beforeEach(() => {
    logs = captureH3Logs()
  })
  afterEach(() => {
    logs.restore()
    vi.useRealTimers()
  })

  it.each(H3_TRANSIENT_FAILURES)(
    'U1 keeps a ready verdict when the Secret read fails with %s',
    async (_label, failure) => {
      const server = h3Server()
      const f = await h3ReadyCluster(server)
      const patchesBefore = f.patches()
      const keptBefore = await reconcileCallFailures('secret_read', 'verdict_kept')
      f.coreApi.readNamespacedSecret.mockRejectedValueOnce(failure())

      await expect(f.reconciler.reconcile(server)).resolves.toBeUndefined()

      expect(f.secretReads()).toBe(2)
      expect(f.reconciler.getStatus(server)).toMatchObject({
        deployed: true,
        ready: true,
        authoritative: true,
      })
      expect(f.patches()).toBe(patchesBefore)
      expect(f.appsApi.deleteNamespacedDeployment).not.toHaveBeenCalled()
      expect(f.appsApi.replaceNamespacedDeployment).not.toHaveBeenCalled()
      expect(f.reconciler.hasIncompleteReconciliation()).toBe(true)
      expect(h3Events(logs.entries, 'mcpserver-call-failed')).toEqual([
        expect.objectContaining({
          serverName: 'h3-server',
          site: 'secret_read',
          outcome: 'verdict_kept',
        }),
      ])
      expect(await reconcileCallFailures('secret_read', 'verdict_kept')).toBe(keptBefore + 1)
    }
  )

  it('U2 keeps a generation-matched persisted Ready after a restart when the Secret read times out', async () => {
    const f = h3Cluster()
    const server = persistReadySeed(h3Server())
    f.coreApi.readNamespacedSecret.mockRejectedValueOnce(h3Timeout())

    await expect(f.reconciler.reconcile(server)).resolves.toBeUndefined()

    expect(f.secretReads()).toBe(1)
    expect(f.reconciler.getStatus(server)).toMatchObject({
      deployed: true,
      ready: true,
      authoritative: true,
    })
    expect(f.patches()).toBe(0)
    expect(f.appsApi.createNamespacedDeployment).not.toHaveBeenCalled()
    expect(f.reconciler.hasIncompleteReconciliation()).toBe(true)
  })

  it('U3 publishes not-ready for a first deploy whose Secret read times out', async () => {
    const f = h3Cluster()
    const server = h3Server()
    const publishedBefore = await reconcileCallFailures('secret_read', 'not_ready_published')
    f.coreApi.readNamespacedSecret.mockRejectedValueOnce(h3Timeout())

    await f.reconciler.reconcile(server)

    expect(f.secretReads()).toBe(1)
    expect(f.reconciler.getStatus(server)).toMatchObject({ ready: false, authoritative: true })
    expect(f.condition('SecretResolved')).toMatchObject({ status: 'False', reason: 'ReadError' })
    expect(await reconcileCallFailures('secret_read', 'not_ready_published')).toBe(
      publishedBefore + 1
    )
  })

  it('U4 publishes not-ready when the in-memory ready verdict belongs to an older generation', async () => {
    const server = h3Server()
    const f = await h3ReadyCluster(server)
    const next = { ...server, generation: 2 }
    const patchesBefore = f.patches()
    f.coreApi.readNamespacedSecret.mockRejectedValueOnce(h3Timeout())

    await f.reconciler.reconcile(next)

    expect(f.secretReads()).toBe(2)
    expect(f.reconciler.getStatus(next)).toMatchObject({ ready: false, authoritative: true })
    expect(f.patches()).toBeGreaterThan(patchesBefore)
    expect(f.condition('SecretResolved')).toMatchObject({ status: 'False', reason: 'ReadError' })
  })

  it('U4 publishes not-ready when the persisted Ready observed an older generation', async () => {
    const f = h3Cluster()
    const server = persistReadySeed(h3Server({ generation: 1 }))
    const next: McpServerCRD = { ...server, generation: 2 }
    f.coreApi.readNamespacedSecret.mockRejectedValueOnce(h3Timeout())

    await f.reconciler.reconcile(next)

    expect(f.secretReads()).toBe(1)
    expect(f.reconciler.getStatus(next)).toMatchObject({ ready: false, authoritative: true })
    expect(f.condition('SecretResolved')).toMatchObject({ status: 'False', reason: 'ReadError' })
  })

  it('U5 withdraws a ready verdict when Secret-change evidence is pending', async () => {
    const server = h3Server()
    const f = await h3ReadyCluster(server)
    f.coreApi.readNamespacedSecret.mockRejectedValueOnce(h3Timeout())
    f.reconciler.recordSecretChangeEvidence('h3-server')

    await f.reconciler.reconcile(server)

    expect(f.secretReads()).toBe(2)
    expect(f.reconciler.getStatus(server)).toMatchObject({ ready: false, authoritative: true })
    expect(f.condition('Ready')).toMatchObject({
      status: 'False',
      reason: 'SecretValidationFailed',
    })
  })

  it.each([
    ['a missing Secret', 'SecretNotFound'],
    ['a denied Secret read', 'SecretAccessDenied'],
    ['a missing key', 'SecretMissingKey'],
  ] as const)('U6 still fails closed for %s', async (_label, reason) => {
    const server = h3Server()
    const f = await h3ReadyCluster(server)
    if (reason === 'SecretNotFound')
      f.coreApi.readNamespacedSecret.mockRejectedValueOnce(h3Absent())
    else if (reason === 'SecretAccessDenied')
      f.coreApi.readNamespacedSecret.mockRejectedValueOnce(
        Object.assign(new Error('forbidden'), { code: 403 })
      )
    else
      f.coreApi.readNamespacedSecret.mockResolvedValueOnce({
        metadata: { name: 'h3-input', resourceVersion: '2' },
        data: {},
      })

    await f.reconciler.reconcile(server)

    expect(f.secretReads()).toBe(2)
    expect(f.appsApi.deleteNamespacedDeployment).toHaveBeenCalledWith({
      name: 'h3-server',
      namespace: 'mcp-server',
    })
    expect(f.reconciler.getStatus(server)).toMatchObject({ ready: false })
    expect(f.condition('SecretResolved')).toMatchObject({ status: 'False', reason })
  })

  it('U7 keeps a SecretNotFound verdict when the next Secret read fails', async () => {
    const f = h3Cluster()
    const server = h3Server()
    f.coreApi.readNamespacedSecret.mockRejectedValueOnce(h3Absent())
    await f.reconciler.reconcile(server)
    expect(f.condition('SecretResolved')).toMatchObject({ reason: 'SecretNotFound' })
    const patchesBefore = f.patches()
    f.coreApi.readNamespacedSecret.mockRejectedValueOnce(h3Timeout())

    await f.reconciler.reconcile(server)

    expect(f.secretReads()).toBe(2)
    expect(f.patches()).toBe(patchesBefore)
    expect(f.condition('SecretResolved')).toMatchObject({
      status: 'False',
      reason: 'SecretNotFound',
    })
    expect(f.reconciler.getStatus(server)).toMatchObject({ ready: false, authoritative: true })
  })

  it('U8 keeps a WRC-owned ready verdict when the Secret read fails', async () => {
    const server = h3Server({ spec: { ...h3Server().spec, managed: false } })
    const f = h3Cluster()
    await f.reconciler.reconcile(server)
    expect(f.reconciler.getStatus(server)).toMatchObject({ ready: true, authoritative: true })
    const patchesBefore = f.patches()
    f.coreApi.readNamespacedSecret.mockRejectedValueOnce(h3Timeout())

    await f.reconciler.reconcile(server)

    expect(f.secretReads()).toBe(2)
    expect(f.reconciler.getStatus(server)).toMatchObject({ ready: true, authoritative: true })
    expect(f.patches()).toBe(patchesBefore)
    expect(f.reconciler.hasIncompleteReconciliation()).toBe(true)
  })

  it('U12 keeps a SecretNotFound verdict even when Secret-change evidence is pending', async () => {
    const f = h3Cluster()
    const server = h3Server()
    f.coreApi.readNamespacedSecret.mockRejectedValueOnce(h3Absent())
    await f.reconciler.reconcile(server)
    const patchesBefore = f.patches()
    f.coreApi.readNamespacedSecret.mockRejectedValueOnce(h3Timeout())
    f.reconciler.recordSecretChangeEvidence('h3-server')

    await f.reconciler.reconcile(server)

    expect(f.secretReads()).toBe(2)
    expect(f.patches()).toBe(patchesBefore)
    expect(f.condition('SecretResolved')).toMatchObject({ reason: 'SecretNotFound' })
  })

  it('U13 leaves a live readiness poll running, which publishes Ready, and the retry discharges the obligation', async () => {
    vi.useFakeTimers()
    const f = h3Cluster({ rolloutReady: false })
    const server = h3Server()
    await f.reconciler.reconcile(server)
    expect((f.reconciler as any).readinessPolls.size).toBe(1)
    f.coreApi.readNamespacedSecret.mockRejectedValueOnce(h3Timeout())

    await f.reconciler.reconcile(server)

    expect(f.secretReads()).toBe(2)
    expect((f.reconciler as any).readinessPolls.size).toBe(1)
    expect(f.reconciler.hasIncompleteReconciliation()).toBe(true)
    f.setRolloutReady(true)
    await vi.advanceTimersByTimeAsync(5000)
    expect(f.reconciler.getStatus(server)).toMatchObject({ ready: true })
    expect(f.condition('Ready')).toMatchObject({ status: 'True', reason: 'ReconcileSuccess' })

    await f.reconciler.reconcile(server)

    expect(f.secretReads()).toBe(3)
    expect(f.reconciler.hasIncompleteReconciliation()).toBe(false)
  })

  // Durable Secret-change evidence inverts the residual this test used to pin: evidence is
  // reconciler state, so a reconcile superseded at entry no longer loses it,
  // and the next ReadError publishes not-ready instead of keeping ready.
  it('U14 Secret-change evidence survives a reconcile superseded at entry, so the next ReadError publishes', async () => {
    const server = h3Server()
    const f = await h3ReadyCluster(server)
    f.reconciler.recordSecretChangeEvidence('h3-server')
    await f.reconciler.reconcile(server, { isCurrent: () => false })
    expect(f.secretReads()).toBe(1)
    f.coreApi.readNamespacedSecret.mockRejectedValueOnce(h3Timeout())

    await f.reconciler.reconcile(server)

    expect(f.secretReads()).toBe(2)
    expect(f.reconciler.getStatus(server)).toMatchObject({ ready: false, authoritative: true })
    expect(f.condition('Ready')).toMatchObject({
      status: 'False',
      reason: 'SecretValidationFailed',
    })
  })

  it('U15 rejects reconcile when processing the Secret data fails, instead of reporting ReadError', async () => {
    const f = h3Cluster()
    const server = h3Server()
    f.coreApi.readNamespacedSecret.mockResolvedValueOnce({
      metadata: { name: 'h3-input', resourceVersion: '1' },
      data: { password: BigInt(1) as unknown as string },
    })

    await expect(f.reconciler.reconcile(server)).rejects.toThrow(TypeError)

    expect(f.secretReads()).toBe(1)
    expect(f.condition('SecretResolved')).toBeUndefined()
    expect(f.reconciler.hasIncompleteReconciliation()).toBe(true)
  })

  const NON_TRANSIENT_READ_FAILURES: Array<[string, () => unknown]> = [
    ['an apiserver 400', () => Object.assign(new Error('bad request'), { code: 400 })],
    ['an apiserver 409', () => Object.assign(new Error('conflict'), { code: 409 })],
    ['an apiserver 422', () => Object.assign(new Error('invalid'), { code: 422 })],
    ['an untyped error', () => new Error('opaque failure')],
    [
      'a Node ERR_INVALID_ARG_TYPE defect',
      () => Object.assign(new TypeError('invalid argument'), { code: 'ERR_INVALID_ARG_TYPE' }),
    ],
  ]

  it.each(NON_TRANSIENT_READ_FAILURES)(
    'U16 publishes not-ready over a ready verdict when the Secret read fails with %s (#1338)',
    async (_label, failure) => {
      const server = h3Server()
      const f = await h3ReadyCluster(server)
      const publishedBefore = await reconcileCallFailures('secret_read', 'not_ready_published')
      const keptBefore = await reconcileCallFailures('secret_read', 'verdict_kept')
      f.coreApi.readNamespacedSecret.mockRejectedValueOnce(failure())

      await f.reconciler.reconcile(server)

      expect(f.secretReads()).toBe(2)
      expect(f.reconciler.getStatus(server)).toMatchObject({ ready: false, authoritative: true })
      expect(f.condition('SecretResolved')).toMatchObject({ status: 'False', reason: 'ReadError' })
      expect(f.condition('Ready')).toMatchObject({
        status: 'False',
        reason: 'SecretValidationFailed',
      })
      expect(await reconcileCallFailures('secret_read', 'not_ready_published')).toBe(
        publishedBefore + 1
      )
      expect(await reconcileCallFailures('secret_read', 'verdict_kept')).toBe(keptBefore)
      // A ReadError never fails closed.
      expect(f.appsApi.deleteNamespacedDeployment).not.toHaveBeenCalled()
    }
  )

  it('U17 keeps a SecretNotFound verdict when the next Secret read fails with a non-transient 422', async () => {
    const f = h3Cluster()
    const server = h3Server()
    f.coreApi.readNamespacedSecret.mockRejectedValueOnce(h3Absent())
    await f.reconciler.reconcile(server)
    expect(f.condition('SecretResolved')).toMatchObject({ reason: 'SecretNotFound' })
    const patchesBefore = f.patches()
    f.coreApi.readNamespacedSecret.mockRejectedValueOnce(
      Object.assign(new Error('invalid'), { code: 422 })
    )

    await f.reconciler.reconcile(server)

    expect(f.secretReads()).toBe(2)
    expect(f.patches()).toBe(patchesBefore)
    expect(f.condition('SecretResolved')).toMatchObject({ reason: 'SecretNotFound' })
    expect(f.reconciler.getStatus(server)).toMatchObject({ ready: false, authoritative: true })
  })

  it('U8b publishes not-ready for a WRC-owned ready verdict when the Secret read fails with a non-transient 422', async () => {
    const server = h3Server({ spec: { ...h3Server().spec, managed: false } })
    const f = h3Cluster()
    await f.reconciler.reconcile(server)
    expect(f.reconciler.getStatus(server)).toMatchObject({ ready: true, authoritative: true })
    f.coreApi.readNamespacedSecret.mockRejectedValueOnce(
      Object.assign(new Error('invalid'), { code: 422 })
    )

    await f.reconciler.reconcile(server)

    expect(f.secretReads()).toBe(2)
    expect(f.reconciler.getStatus(server)).toMatchObject({ ready: false, authoritative: true })
    expect(f.condition('Ready')).toMatchObject({
      status: 'False',
      reason: 'SecretValidationFailed',
    })
  })

  const TRANSIENT_TRANSPORT_CODES = [
    'ECONNRESET',
    'EPIPE',
    'ECONNREFUSED',
    'ETIMEDOUT',
    'EHOSTUNREACH',
    'ENETUNREACH',
    'ERR_STREAM_PREMATURE_CLOSE',
  ]

  it.each([
    ...TRANSIENT_TRANSPORT_CODES.map(
      code => [code, () => Object.assign(new Error(`transport ${code}`), { code })] as const
    ),
    ['the request deadline', () => h3Timeout()] as const,
  ])(
    'U18 keeps a ready verdict when the Secret read fails with %s (#1338)',
    async (_label, failure) => {
      const server = h3Server()
      const f = await h3ReadyCluster(server)
      const patchesBefore = f.patches()
      const keptBefore = await reconcileCallFailures('secret_read', 'verdict_kept')
      f.coreApi.readNamespacedSecret.mockRejectedValueOnce(failure())

      await f.reconciler.reconcile(server)

      expect(f.secretReads()).toBe(2)
      expect(f.reconciler.getStatus(server)).toMatchObject({ ready: true, authoritative: true })
      expect(f.patches()).toBe(patchesBefore)
      expect(await reconcileCallFailures('secret_read', 'verdict_kept')).toBe(keptBefore + 1)
    }
  )

  it('U20 evidence recorded while the Secret read is in flight survives the completion that used the older content', async () => {
    const server = h3Server()
    const f = await h3ReadyCluster(server)
    const readGate = deferred()
    f.coreApi.readNamespacedSecret.mockImplementationOnce(async (request: any) => {
      await readGate.promise
      return f.readSecret(request)
    })

    const inFlight = f.reconciler.reconcile(server)
    await vi.waitFor(() => expect(f.secretReads()).toBe(2))
    f.reconciler.recordSecretChangeEvidence('h3-server')
    readGate.resolve()
    await inFlight

    // The reconcile completed (its obligation is cleared) with the old content.
    expect(f.reconciler.hasIncompleteReconciliation()).toBe(false)
    expect(f.reconciler.hasSecretChangeEvidence()).toBe(true)
    f.coreApi.readNamespacedSecret.mockRejectedValueOnce(h3Timeout())

    await f.reconciler.reconcile(server)

    expect(f.secretReads()).toBe(3)
    expect(f.reconciler.getStatus(server)).toMatchObject({ ready: false, authoritative: true })
  })

  it('U21 evidence is discharged by the first completed reconcile, so a later transient read error keeps ready', async () => {
    const server = h3Server()
    const f = await h3ReadyCluster(server)
    f.reconciler.recordSecretChangeEvidence('h3-server')
    await f.reconciler.reconcile(server)
    expect(f.secretReads()).toBe(2)
    expect(f.reconciler.hasSecretChangeEvidence()).toBe(false)
    const keptBefore = await reconcileCallFailures('secret_read', 'verdict_kept')
    f.coreApi.readNamespacedSecret.mockRejectedValueOnce(h3Timeout())

    await f.reconciler.reconcile(server)

    expect(f.secretReads()).toBe(3)
    expect(f.reconciler.getStatus(server)).toMatchObject({ ready: true, authoritative: true })
    expect(await reconcileCallFailures('secret_read', 'verdict_kept')).toBe(keptBefore + 1)
  })

  it('U22 two servers sharing one Secret: only the server whose reconcile completed is discharged', async () => {
    const serverA = h3Server()
    const serverB = h3Server({ name: 'h3-peer', uid: 'uid-h3-peer' })
    const f = await h3ReadyCluster(serverA)
    await f.reconciler.reconcile(serverB)
    expect(f.reconciler.getStatus(serverB)).toMatchObject({ ready: true, authoritative: true })
    f.reconciler.recordSecretChangeEvidence('h3-server')
    f.reconciler.recordSecretChangeEvidence('h3-peer')
    await f.reconciler.reconcile(serverA)
    expect(f.secretReads()).toBe(3)
    f.coreApi.readNamespacedSecret
      .mockRejectedValueOnce(h3Timeout())
      .mockRejectedValueOnce(h3Timeout())

    await f.reconciler.reconcile(serverA)
    await f.reconciler.reconcile(serverB)

    expect(f.secretReads()).toBe(5)
    expect(f.reconciler.getStatus(serverA)).toMatchObject({ ready: true, authoritative: true })
    expect(f.reconciler.getStatus(serverB)).toMatchObject({ ready: false, authoritative: true })
  })

  it('U23 a completed delete clears the evidence', async () => {
    const server = h3Server()
    const f = await h3ReadyCluster(server)
    let present = true
    f.reconciler.setInventoryAuthority(() => ({ known: true, generation: 1 }))
    f.reconciler.setResolveCurrentServer(name =>
      present && name === 'h3-server' ? server : undefined
    )
    f.customApi.getNamespacedCustomObject.mockRejectedValue(h3Absent())
    f.reconciler.recordSecretChangeEvidence('h3-server')
    expect(f.reconciler.hasSecretChangeEvidence()).toBe(true)

    present = false
    await f.reconciler.reconcileDelete('h3-server', 'mcp-server')
    // Resolve the name again so pruning cannot be what removed the entry.
    present = true

    expect(f.appsApi.deleteNamespacedDeployment).toHaveBeenCalledWith({
      name: 'h3-server',
      namespace: 'mcp-server',
    })
    expect(f.reconciler.hasIncompleteReconciliation()).toBe(false)
    expect(f.reconciler.hasSecretChangeEvidence()).toBe(false)
  })

  it('U24 a completed reconcile that never reads the Secret (disabled) discharges the evidence', async () => {
    const server = h3Server()
    const f = await h3ReadyCluster(server)
    const disabled: McpServerCRD = {
      ...server,
      generation: 2,
      spec: { ...server.spec, enabled: false },
    }
    f.reconciler.recordSecretChangeEvidence('h3-server')

    await f.reconciler.reconcile(disabled)

    expect(f.appsApi.deleteNamespacedDeployment).toHaveBeenCalledWith({
      name: 'h3-server',
      namespace: 'mcp-server',
    })
    expect(f.secretReads()).toBe(1)
    expect(f.reconciler.hasIncompleteReconciliation()).toBe(false)
    expect(f.reconciler.hasSecretChangeEvidence()).toBe(false)
  })

  it('U40 evidence of a server that left the inventory without a delete is pruned, so it does not outlive the server', async () => {
    const server = h3Server()
    const f = await h3ReadyCluster(server)
    let present = true
    f.reconciler.setResolveCurrentServer(name =>
      present && name === 'h3-server' ? server : undefined
    )
    f.reconciler.recordSecretChangeEvidence('h3-server')
    // Witness: while the server is in the inventory the evidence counts.
    expect(f.reconciler.hasSecretChangeEvidence()).toBe(true)

    present = false
    expect(f.reconciler.hasSecretChangeEvidence()).toBe(false)

    // The same name returns. A transient read failure keeps its ready verdict,
    // because no evidence from before it left remains.
    present = true
    expect(f.reconciler.hasSecretChangeEvidence()).toBe(false)
    const keptBefore = await reconcileCallFailures('secret_read', 'verdict_kept')
    f.coreApi.readNamespacedSecret.mockRejectedValueOnce(h3Timeout())

    await f.reconciler.reconcile(server)

    expect(f.secretReads()).toBe(2)
    expect(f.reconciler.getStatus(server)).toMatchObject({ ready: true, authoritative: true })
    expect(await reconcileCallFailures('secret_read', 'verdict_kept')).toBe(keptBefore + 1)
  })
})

describe('validateSecret structured logs', () => {
  let logs: ReturnType<typeof captureH3Logs>
  beforeEach(() => {
    logs = captureH3Logs()
  })
  afterEach(() => {
    logs.restore()
  })

  const fieldsOf = (message: string) =>
    logs.entries.filter(entry => entry.message === message).map(entry => entry.fields)

  it('logs a validated Secret with its resource and server names', async () => {
    const f = h3Cluster()

    await expect(f.reconciler.validateSecret(h3Server())).resolves.toMatchObject({ ok: true })

    expect(fieldsOf('Secret validated for McpServer')).toEqual([
      expect.objectContaining({
        scope: '[Reconciler]',
        resourceName: 'h3-input',
        name: 'h3-server',
      }),
    ])
  })

  it('logs a missing key with the entry, the env var and the server name', async () => {
    const f = h3Cluster()
    f.coreApi.readNamespacedSecret.mockResolvedValueOnce({
      metadata: { name: 'h3-input' },
      data: {},
    })

    await expect(f.reconciler.validateSecret(h3Server())).resolves.toMatchObject({
      ok: false,
      reason: 'SecretMissingKey',
    })

    expect(fieldsOf('Secret is missing required key (needed for env var) in McpServer')).toEqual([
      expect.objectContaining({
        scope: '[Reconciler]',
        resourceName: 'h3-input',
        entryName: 'password',
        envVar: 'INPUT_VALUE',
        name: 'h3-server',
      }),
    ])
  })

  it('logs a failed read with the server name', async () => {
    const f = h3Cluster()
    f.coreApi.readNamespacedSecret.mockRejectedValueOnce(h3Timeout())

    await expect(f.reconciler.validateSecret(h3Server())).resolves.toMatchObject({
      ok: false,
      reason: 'ReadError',
    })

    expect(fieldsOf('Failed to read secret')).toEqual([
      expect.objectContaining({
        scope: '[Reconciler]',
        resourceName: 'h3-input',
        name: 'h3-server',
      }),
    ])
  })
})

describe('#1338: only listed transport codes are transient', () => {
  let logs: ReturnType<typeof captureH3Logs>
  beforeEach(() => {
    logs = captureH3Logs()
  })
  afterEach(() => {
    logs.restore()
  })

  const DEFECT_CODES = [
    'ERR_INVALID_ARG_TYPE',
    'ERR_TLS_CERT_ALTNAME_INVALID',
    'EPROTO',
    'ENOTFOUND',
  ]
  const coded = (code: string) => Object.assign(new Error(`failure ${code}`), { code })

  it.each(DEFECT_CODES)('U19 the Secret read failing with %s publishes not-ready', async code => {
    const server = h3Server()
    const f = await h3ReadyCluster(server)
    const publishedBefore = await reconcileCallFailures('secret_read', 'not_ready_published')
    f.coreApi.readNamespacedSecret.mockRejectedValueOnce(coded(code))

    await f.reconciler.reconcile(server)

    expect(f.secretReads()).toBe(2)
    expect(f.reconciler.getStatus(server)).toMatchObject({ ready: false, authoritative: true })
    expect(await reconcileCallFailures('secret_read', 'not_ready_published')).toBe(
      publishedBefore + 1
    )
  })

  it.each(DEFECT_CODES)('U19 the rollout read failing with %s publishes not-ready', async code => {
    const server = h3Server()
    const f = await h3ReadyCluster(server)
    const publishedBefore = await reconcileCallFailures('rollout_read', 'not_ready_published')
    const readsBefore = f.appsApi.readNamespacedDeployment.mock.calls.length
    f.appsApi.readNamespacedDeployment
      .mockImplementationOnce(f.readDeployment)
      .mockRejectedValueOnce(coded(code))

    await f.reconciler.reconcile(server)

    expect(f.appsApi.readNamespacedDeployment.mock.calls.length - readsBefore).toBe(2)
    expect(f.reconciler.getStatus(server)).toMatchObject({ ready: false, authoritative: true })
    expect(await reconcileCallFailures('rollout_read', 'not_ready_published')).toBe(
      publishedBefore + 1
    )
  })
})

describe('#1338: a fail-closed verdict withdraws readiness before the retract', () => {
  let logs: ReturnType<typeof captureH3Logs>
  beforeEach(() => {
    logs = captureH3Logs()
  })
  afterEach(() => {
    logs.restore()
    vi.useRealTimers()
  })

  it('U10 publishes not-ready although the Deployment delete times out, and a later ReadError keeps it', async () => {
    const server = h3Server()
    const f = await h3ReadyCluster(server)
    f.coreApi.readNamespacedSecret.mockRejectedValueOnce(h3Absent())
    f.appsApi.deleteNamespacedDeployment.mockRejectedValueOnce(
      h3Timeout('deleteNamespacedDeployment')
    )

    await expect(f.reconciler.reconcile(server)).rejects.toThrow(
      'Failed to delete runtime Kubernetes resources for McpServer "h3-server"'
    )

    expect(f.appsApi.deleteNamespacedDeployment).toHaveBeenCalledTimes(1)
    expect(f.reconciler.getStatus(server)).toMatchObject({ ready: false, authoritative: true })
    const patchesBefore = f.patches()
    f.coreApi.readNamespacedSecret.mockRejectedValueOnce(h3Timeout())
    await f.reconciler.reconcile(server)
    expect(f.secretReads()).toBe(3)
    expect(f.patches()).toBe(patchesBefore)
    expect(f.reconciler.getStatus(server)).toMatchObject({ ready: false, authoritative: true })
  })

  it('U10 publishes not-ready when the runtime is gone but the retract write is declined', async () => {
    const server = h3Server()
    const f = await h3ReadyCluster(server)
    let current = true
    f.coreApi.readNamespacedSecret.mockRejectedValueOnce(h3Absent())
    f.appsApi.deleteNamespacedDeployment.mockImplementationOnce(async ({ name }: any) => {
      f.deployments.delete(name)
      current = false
      return {}
    })

    await f.reconciler.reconcile(server, { isCurrent: () => current })

    expect(f.appsApi.deleteNamespacedDeployment).toHaveBeenCalledTimes(1)
    expect(f.condition('DeploymentReady')?.reason).not.toBe('RuntimeNotDesired')
    expect(f.reconciler.getStatus(server)).toMatchObject({ ready: false, authoritative: true })
    const patchesBefore = f.patches()
    f.coreApi.readNamespacedSecret.mockRejectedValueOnce(h3Timeout())
    await f.reconciler.reconcile(server)
    expect(f.secretReads()).toBe(3)
    expect(f.patches()).toBe(patchesBefore)
    expect(f.reconciler.getStatus(server)).toMatchObject({ ready: false })
  })

  it('U10 publishes not-ready when the retract is denied', async () => {
    const server = h3Server()
    const f = await h3ReadyCluster(server)
    let current = true
    const deploymentReadsBefore = f.appsApi.readNamespacedDeployment.mock.calls.length
    f.coreApi.readNamespacedSecret.mockRejectedValueOnce(h3Absent())
    f.appsApi.readNamespacedDeployment.mockImplementationOnce(async (request: any) => {
      current = false
      return f.readDeployment(request)
    })

    await f.reconciler.reconcile(server, { isCurrent: () => current })

    expect(f.appsApi.readNamespacedDeployment.mock.calls.length).toBe(deploymentReadsBefore + 1)
    expect(f.appsApi.deleteNamespacedDeployment).not.toHaveBeenCalled()
    expect(f.reconciler.getStatus(server)).toMatchObject({ ready: false, authoritative: true })
  })

  it('U11 an in-flight readiness tick cannot republish ready after the fail-closed decision', async () => {
    vi.useFakeTimers()
    const f = h3Cluster({ rolloutReady: false })
    const server = h3Server()
    await f.reconciler.reconcile(server)
    expect((f.reconciler as any).readinessPolls.size).toBe(1)
    f.setRolloutReady(true)
    const tickRead = deferred()
    let tickReadReturned = false
    f.appsApi.readNamespacedDeployment.mockImplementationOnce(async (request: any) => {
      await tickRead.promise
      const deployment = await f.readDeployment(request)
      tickReadReturned = true
      return deployment
    })
    await vi.advanceTimersByTimeAsync(5000)
    f.coreApi.readNamespacedSecret.mockRejectedValueOnce(h3Absent())
    f.appsApi.deleteNamespacedDeployment.mockRejectedValueOnce(
      h3Timeout('deleteNamespacedDeployment')
    )

    await expect(f.reconciler.reconcile(server)).rejects.toThrow('Failed to delete runtime')
    tickRead.resolve()
    await vi.advanceTimersByTimeAsync(0)

    expect(tickReadReturned).toBe(true)
    expect(f.reconciler.getStatus(server)).toMatchObject({ ready: false })
    expect(f.condition('Ready')?.status).not.toBe('True')
  })
})

describe('#1338: out-of-pass obligations reach the incomplete-reconciliation listener', () => {
  let logs: ReturnType<typeof captureH3Logs>
  beforeEach(() => {
    logs = captureH3Logs()
  })
  afterEach(() => {
    logs.restore()
    vi.useRealTimers()
  })

  it('U9a a ReadError reconcile fires the listener exactly once', async () => {
    const server = h3Server()
    const f = await h3ReadyCluster(server)
    expect(f.listener).not.toHaveBeenCalled()
    f.coreApi.readNamespacedSecret.mockRejectedValueOnce(h3Timeout())

    await f.reconciler.reconcile(server)

    expect(f.secretReads()).toBe(2)
    expect(f.listener).toHaveBeenCalledExactlyOnceWith('h3-server')
  })

  it('U9b an incomplete delete fires the listener once', async () => {
    const f = h3Cluster()
    const deploymentReadsBefore = f.appsApi.readNamespacedDeployment.mock.calls.length
    f.deployments.set('h3-server', {
      metadata: {
        name: 'h3-server',
        namespace: 'mcp-server',
        labels: hccOwnedMetadata('h3-server').labels,
      },
    })

    await f.reconciler.reconcileDelete('h3-server', 'mcp-server')

    expect(f.appsApi.readNamespacedDeployment.mock.calls.length).toBe(deploymentReadsBefore + 1)
    expect(f.appsApi.deleteNamespacedDeployment).not.toHaveBeenCalled()
    expect(f.reconciler.incompleteReconciliationNames()).toEqual(['h3-server'])
    expect(f.listener).toHaveBeenCalledExactlyOnceWith('h3-server')
  })

  it('U9c a readiness tick with exactly one declined write fires the listener once', async () => {
    vi.useFakeTimers()
    const f = h3Cluster({ rolloutReady: false })
    const server = h3Server()
    await f.reconciler.reconcile(server)
    expect(f.listener).not.toHaveBeenCalled()
    f.setRolloutReady(true)
    f.customApi.patchNamespacedCustomObjectStatus.mockImplementationOnce(async () => {
      throw Object.assign(new Error('status unavailable'), { code: 500 })
    })
    const patchesBefore = f.patches()

    await vi.advanceTimersByTimeAsync(5000)

    expect(f.patches()).toBe(patchesBefore + 2)
    expect(f.condition('Ready')).toMatchObject({ status: 'True' })
    expect(f.reconciler.incompleteReconciliationNames()).toEqual(['h3-server'])
    expect(f.listener).toHaveBeenCalledExactlyOnceWith('h3-server')
  })

  it('U9c a retained retired readiness poll fires the listener once', async () => {
    vi.useFakeTimers()
    const f = h3Cluster({ rolloutReady: false })
    const server = h3Server()
    let current = true
    await f.reconciler.reconcile(server, { isCurrent: () => current })
    expect((f.reconciler as any).readinessPolls.size).toBe(1)
    expect(f.listener).not.toHaveBeenCalled()
    current = false
    const deploymentReadsBefore = f.appsApi.readNamespacedDeployment.mock.calls.length

    await vi.advanceTimersByTimeAsync(5000)

    expect((f.reconciler as any).readinessPolls.size).toBe(0)
    expect(f.appsApi.readNamespacedDeployment.mock.calls.length).toBe(deploymentReadsBefore)
    expect(f.reconciler.incompleteReconciliationNames()).toEqual(['h3-server'])
    expect(f.listener).toHaveBeenCalledExactlyOnceWith('h3-server')
  })

  it('U9d a rejected reconcile fires the listener once', async () => {
    const server = h3Server()
    const f = await h3ReadyCluster(server)
    f.coreApi.readNamespacedSecret.mockRejectedValueOnce(h3Absent())
    f.appsApi.deleteNamespacedDeployment.mockRejectedValueOnce(
      Object.assign(new Error('apiserver unavailable'), { code: 500 })
    )

    await expect(f.reconciler.reconcile(server)).rejects.toThrow('Failed to delete runtime')

    expect(f.appsApi.deleteNamespacedDeployment).toHaveBeenCalledTimes(1)
    expect(f.listener).toHaveBeenCalledExactlyOnceWith('h3-server')
  })

  it('U9e a reconcile superseded before it ends does not fire; the superseding ReadError does', async () => {
    const server = h3Server()
    const f = await h3ReadyCluster(server)
    let current = true
    f.coreApi.readNamespacedSecret.mockImplementationOnce(async (request: any) => {
      current = false
      return f.readSecret(request)
    })

    await f.reconciler.reconcile(server, { isCurrent: () => current })

    expect(f.secretReads()).toBe(2)
    expect(f.reconciler.hasIncompleteReconciliation()).toBe(true)
    expect(f.listener).not.toHaveBeenCalled()
    f.coreApi.readNamespacedSecret.mockRejectedValueOnce(h3Timeout())
    await f.reconciler.reconcile(server)
    expect(f.secretReads()).toBe(3)
    expect(f.listener).toHaveBeenCalledExactlyOnceWith('h3-server')
  })

  it('U9f two declined writes inside one reconcile fire the listener once', async () => {
    const f = h3Cluster()
    const server = h3Server()
    f.coreApi.readNamespacedSecret.mockRejectedValueOnce(h3Timeout())
    f.customApi.patchNamespacedCustomObjectStatus.mockRejectedValue(
      Object.assign(new Error('status unavailable'), { code: 500 })
    )

    await f.reconciler.reconcile(server)

    expect(f.secretReads()).toBe(1)
    expect(f.patches()).toBe(2)
    expect(f.listener).toHaveBeenCalledExactlyOnceWith('h3-server')
  })

  it('U9g a fullReconcile-issued ReadError leaves its obligation to the pass end', async () => {
    const f = h3Cluster()
    const server = h3Server()
    f.coreApi.readNamespacedSecret.mockRejectedValueOnce(h3Timeout())

    await f.reconciler.fullReconcile([server])

    expect(f.secretReads()).toBe(1)
    expect(f.reconciler.incompleteReconciliationNames()).toEqual(['h3-server'])
    expect(f.listener).not.toHaveBeenCalled()
  })

  it('U9g a fullReconcile-issued orphan delete leaves its obligation to the pass end', async () => {
    const f = h3Cluster()
    f.appsApi.listNamespacedDeployment.mockResolvedValueOnce({
      items: [{ metadata: { name: 'h3-orphan', namespace: 'mcp-server' } }],
    })
    f.deployments.set('h3-orphan', {
      metadata: {
        name: 'h3-orphan',
        namespace: 'mcp-server',
        labels: hccOwnedMetadata('h3-orphan').labels,
      },
    })
    ;(f.reconciler as any).orphanDeleteAllowed = vi.fn(async () => true)
    ;(f.reconciler as any).deleteRuntimeResources = vi.fn(async () => false)

    await f.reconciler.fullReconcile([])

    expect((f.reconciler as any).deleteRuntimeResources).toHaveBeenCalledTimes(1)
    expect(f.reconciler.incompleteReconciliationNames()).toEqual(['h3-orphan'])
    expect(f.listener).not.toHaveBeenCalled()
  })

  const deploymentReads = (f: ReturnType<typeof h3Cluster>) =>
    f.appsApi.readNamespacedDeployment.mock.calls.length
  const pollOf = (f: ReturnType<typeof h3Cluster>) =>
    (f.reconciler as any).readinessPolls.get('h3-server')

  it('U39 a terminal RolloutIncomplete from a readiness tick is a published verdict, not an obligation', async () => {
    vi.useFakeTimers()
    const f = h3Cluster({ rolloutReady: false })
    const server = h3Server()
    await f.reconciler.reconcile(server)
    expect(pollOf(f).timer).toBeDefined()
    const patchesBefore = f.patches()

    await vi.advanceTimersByTimeAsync(24 * 5000)

    expect(logs.entries.filter(entry => entry.message.includes('giving up'))).toHaveLength(1)
    expect(f.patches()).toBeGreaterThan(patchesBefore)
    expect(f.condition('DeploymentReady')).toMatchObject({
      status: 'False',
      reason: 'RolloutIncomplete',
    })
    expect(pollOf(f)).toMatchObject({ exhausted: true, timer: undefined, ticking: false })
    expect(f.reconciler.incompleteReconciliationNames()).not.toContain('h3-server')
    expect(f.reconciler.hasIncompleteReconciliation()).toBe(false)
    expect(f.listener).not.toHaveBeenCalled()
  })

  it('U38a readiness tick does not publish ready while a Secret change is pending', async () => {
    vi.useFakeTimers()
    const f = h3Cluster({ rolloutReady: false })
    const server = h3Server()
    await f.reconciler.reconcile(server)
    expect(pollOf(f).timer).toBeDefined()
    f.reconciler.recordSecretChangeEvidence('h3-server')
    f.setRolloutReady(true)
    const readsBefore = deploymentReads(f)
    const patchesBefore = f.patches()

    await vi.advanceTimersByTimeAsync(5000)

    expect(deploymentReads(f)).toBe(readsBefore + 1)
    expect(f.patches()).toBe(patchesBefore)
    expect(f.condition('Ready')).not.toMatchObject({ status: 'True' })
    expect(f.reconciler.getStatus(server)).toMatchObject({ ready: false })
    expect(pollOf(f)).toBeUndefined()
    expect(f.reconciler.incompleteReconciliationNames()).toEqual(['h3-server'])
    expect(f.listener).toHaveBeenCalledExactlyOnceWith('h3-server')

    await f.reconciler.reconcile(server)

    expect(f.reconciler.getStatus(server)).toMatchObject({ ready: true })
    expect(f.condition('Ready')).toMatchObject({ status: 'True' })
    expect(f.reconciler.hasIncompleteReconciliation()).toBe(false)
  })

  it('U9h a successful reconcile does not fire the listener', async () => {
    const f = h3Cluster()
    const server = h3Server()

    await f.reconciler.reconcile(server)

    expect(f.secretReads()).toBe(1)
    expect(f.reconciler.getStatus(server)).toMatchObject({ ready: true })
    expect(f.listener).not.toHaveBeenCalled()
  })

  it('U9 a call followed by a queued successor leaves the report to the successor', async () => {
    const server = h3Server()
    const f = await h3ReadyCluster(server)
    const firstRead = deferred()
    f.coreApi.readNamespacedSecret.mockImplementationOnce(async () => {
      await firstRead.promise
      throw h3Timeout()
    })

    const first = f.reconciler.reconcile(server)
    await vi.waitFor(() => expect(f.secretReads()).toBe(2))
    const second = f.reconciler.reconcile(server)
    firstRead.resolve()
    await Promise.all([first, second])

    expect(f.secretReads()).toBe(3)
    expect(f.reconciler.getStatus(server)).toMatchObject({ ready: true })
    expect(f.reconciler.hasIncompleteReconciliation()).toBe(false)
    expect(f.listener).not.toHaveBeenCalled()
  })
})

describe('#1338: transient failures of the other managed reconcile calls', () => {
  let logs: ReturnType<typeof captureH3Logs>
  beforeEach(() => {
    logs = captureH3Logs()
  })
  afterEach(() => {
    logs.restore()
  })

  function handshakeServer(overrides: Partial<McpServerCRD> = {}): McpServerCRD {
    return h3Server({ annotations: { [PRE_DEPLOY_ANNOTATION]: 'true' }, ...overrides })
  }

  function failSite(
    f: ReturnType<typeof h3Cluster>,
    site: 'resource_sync' | 'pre_deploy_handshake' | 'rollout_read'
  ): () => number {
    if (site === 'resource_sync') {
      const before = f.coreApi.readNamespacedService.mock.calls.length
      f.coreApi.readNamespacedService.mockRejectedValueOnce(h3Timeout('readNamespacedService'))
      return () => f.coreApi.readNamespacedService.mock.calls.length - before
    }
    if (site === 'pre_deploy_handshake') {
      const before = f.customApi.patchNamespacedCustomObject.mock.calls.length
      f.customApi.patchNamespacedCustomObject.mockRejectedValueOnce(
        h3Timeout('patchNamespacedCustomObject')
      )
      return () => f.customApi.patchNamespacedCustomObject.mock.calls.length - before
    }
    const before = f.appsApi.readNamespacedDeployment.mock.calls.length
    f.appsApi.readNamespacedDeployment
      .mockImplementationOnce(f.readDeployment)
      .mockRejectedValueOnce(h3Timeout('readNamespacedDeployment'))
    return () => f.appsApi.readNamespacedDeployment.mock.calls.length - before
  }

  const SITES = [
    ['resource_sync', 1, 'Resource sync failed'],
    ['pre_deploy_handshake', 1, 'Pre-deploy handshake failed'],
    ['rollout_read', 2, 'Deployment created, waiting for pods to become ready'],
  ] as const

  it.each(SITES)(
    'keeps an authoritative ready verdict when the %s call times out',
    async (site, failingCalls) => {
      const server = handshakeServer()
      const f = await h3ReadyCluster(server)
      const patchesBefore = f.patches()
      const keptBefore = await reconcileCallFailures(site, 'verdict_kept')
      const calls = failSite(f, site)

      await expect(f.reconciler.reconcile(server)).resolves.toBeUndefined()

      expect(calls()).toBe(failingCalls)
      expect(f.appsApi.replaceNamespacedDeployment).not.toHaveBeenCalled()
      expect(f.coreApi.replaceNamespacedService).not.toHaveBeenCalled()
      expect(f.reconciler.getStatus(server)).toMatchObject({
        deployed: true,
        ready: true,
        authoritative: true,
      })
      expect(f.patches()).toBe(patchesBefore)
      expect(f.reconciler.hasIncompleteReconciliation()).toBe(true)
      expect(f.listener).toHaveBeenCalledExactlyOnceWith('h3-server')
      expect(h3Events(logs.entries, 'mcpserver-call-failed')).toEqual([
        expect.objectContaining({ serverName: 'h3-server', site, outcome: 'verdict_kept' }),
      ])
      expect(await reconcileCallFailures(site, 'verdict_kept')).toBe(keptBefore + 1)
    }
  )

  it.each(SITES)(
    'still publishes not-ready for a new generation when the %s call times out',
    async (site, failingCalls, message) => {
      const server = handshakeServer()
      const f = await h3ReadyCluster(server)
      const next: McpServerCRD = { ...server, generation: 2 }
      const publishedBefore = await reconcileCallFailures(site, 'not_ready_published')
      const calls = failSite(f, site)

      await f.reconciler.reconcile(next)

      expect(calls()).toBe(failingCalls)
      expect(f.appsApi.replaceNamespacedDeployment).not.toHaveBeenCalled()
      expect(f.coreApi.replaceNamespacedService).not.toHaveBeenCalled()
      expect(f.reconciler.getStatus(next)).toMatchObject({ ready: false, authoritative: true })
      expect(f.reconciler.getStatus(next).message).toContain(message)
      expect(await reconcileCallFailures(site, 'not_ready_published')).toBe(publishedBefore + 1)
    }
  )

  const rotatedSecret = {
    metadata: { name: 'h3-input', resourceVersion: '2' },
    data: { password: storedSecret('rotated-fixture-input-value') },
  }

  it('a restored ready verdict with a failing read has no maximum age: it is still kept at +1 h', async () => {
    vi.useFakeTimers()
    const f = h3Cluster()
    const server = persistReadySeed(h3Server())
    const keptBefore = await reconcileCallFailures('secret_read', 'verdict_kept')
    f.coreApi.readNamespacedSecret.mockRejectedValue(h3Timeout())

    await f.reconciler.reconcile(server)
    await vi.advanceTimersByTimeAsync(3_600_000)
    await f.reconciler.reconcile(server)

    expect(f.secretReads()).toBe(2)
    expect(f.reconciler.getStatus(server)).toMatchObject({ ready: true, authoritative: true })
    expect(await reconcileCallFailures('secret_read', 'verdict_kept')).toBe(keptBefore + 2)
    expect(f.patches()).toBe(0)
  })

  it('a confirmed ready verdict with a failing read is kept at +1 h', async () => {
    vi.useFakeTimers()
    const server = h3Server()
    const f = await h3ReadyCluster(server)
    const keptBefore = await reconcileCallFailures('secret_read', 'verdict_kept')
    f.coreApi.readNamespacedSecret.mockRejectedValue(h3Timeout())

    await vi.advanceTimersByTimeAsync(3_600_000)
    await f.reconciler.reconcile(server)

    expect(f.secretReads()).toBe(2)
    expect(f.reconciler.getStatus(server)).toMatchObject({ ready: true })
    expect(await reconcileCallFailures('secret_read', 'verdict_kept')).toBe(keptBefore + 1)
  })

  it('a Secret revision other than the applied one publishes not-ready when a later call times out', async () => {
    const server = h3Server()
    const f = await h3ReadyCluster(server)
    f.coreApi.readNamespacedSecret.mockResolvedValueOnce(rotatedSecret)
    const serviceReadsBefore = f.coreApi.readNamespacedService.mock.calls.length
    f.coreApi.readNamespacedService.mockRejectedValueOnce(h3Timeout('readNamespacedService'))
    const publishedBefore = await reconcileCallFailures('resource_sync', 'not_ready_published')

    await f.reconciler.reconcile(server)

    expect(f.coreApi.readNamespacedService.mock.calls.length).toBe(serviceReadsBefore + 1)
    expect(f.appsApi.replaceNamespacedDeployment).not.toHaveBeenCalled()
    expect(f.reconciler.getStatus(server)).toMatchObject({ ready: false })
    expect(await reconcileCallFailures('resource_sync', 'not_ready_published')).toBe(
      publishedBefore + 1
    )
  })

  it('an ensureDeployment that applied nothing records no revision', async () => {
    const server = h3Server()
    const f = await h3ReadyCluster(server)
    const ensureDeployment = vi
      .spyOn(f.reconciler as any, 'ensureDeployment')
      .mockResolvedValueOnce('not_allowed')
    f.coreApi.readNamespacedSecret.mockResolvedValueOnce(rotatedSecret)
    await f.reconciler.reconcile(server)
    expect(ensureDeployment).toHaveBeenCalledTimes(1)
    const keptBefore = await reconcileCallFailures('resource_sync', 'verdict_kept')
    f.coreApi.readNamespacedService.mockRejectedValueOnce(h3Timeout('readNamespacedService'))

    // The original revision is the one still applied, so nothing differs.
    await f.reconciler.reconcile(server)

    expect(await reconcileCallFailures('resource_sync', 'verdict_kept')).toBe(keptBefore + 1)
    expect(f.reconciler.getStatus(server)).toMatchObject({ ready: true })
  })

  it.each(SITES)(
    'publishes not-ready when the %s call times out with a Secret change pending',
    async (site, failingCalls, message) => {
      const server = handshakeServer()
      const f = await h3ReadyCluster(server)
      f.reconciler.recordSecretChangeEvidence('h3-server')
      const publishedBefore = await reconcileCallFailures(site, 'not_ready_published')
      const calls = failSite(f, site)

      await f.reconciler.reconcile(server)

      expect(calls()).toBe(failingCalls)
      expect(f.reconciler.getStatus(server)).toMatchObject({ ready: false, authoritative: true })
      expect(f.reconciler.getStatus(server).message).toContain(message)
      expect(await reconcileCallFailures(site, 'not_ready_published')).toBe(publishedBefore + 1)
    }
  )

  it('publishes not-ready when this reconcile had to write the runtime before the call failed', async () => {
    const server = h3Server()
    const f = await h3ReadyCluster(server)
    f.coreApi.readNamespacedSecret.mockResolvedValueOnce({
      metadata: { name: 'h3-input', resourceVersion: '2' },
      data: { password: storedSecret('rotated-fixture-input-value') },
    })
    f.appsApi.replaceNamespacedDeployment.mockRejectedValueOnce(
      h3Timeout('replaceNamespacedDeployment')
    )

    await f.reconciler.reconcile(server)

    expect(f.appsApi.replaceNamespacedDeployment).toHaveBeenCalledTimes(1)
    expect(f.reconciler.getStatus(server)).toMatchObject({ ready: false, authoritative: true })
    expect(f.reconciler.getStatus(server).message).toContain('Resource sync failed')
  })

  // The test above rotates the Secret too, so the revision mismatch alone
  // would publish. These two isolate the write-attempt signal and the
  // revision learned from an up-to-date Deployment.
  it('publishes not-ready when a Deployment deleted out of band is re-created and the create times out', async () => {
    const server = h3Server()
    const f = await h3ReadyCluster(server)
    f.deployments.delete('h3-server')
    f.appsApi.createNamespacedDeployment.mockRejectedValueOnce(
      h3Timeout('createNamespacedDeployment')
    )
    const createsBefore = f.appsApi.createNamespacedDeployment.mock.calls.length

    await f.reconciler.reconcile(server)

    expect(f.appsApi.createNamespacedDeployment.mock.calls.length).toBe(createsBefore + 1)
    expect(f.reconciler.getStatus(server)).toMatchObject({ ready: false })
  })

  function failRolloutRead(f: ReturnType<typeof h3Cluster>): () => number {
    const before = f.appsApi.readNamespacedDeployment.mock.calls.length
    f.appsApi.readNamespacedDeployment
      .mockImplementationOnce(f.readDeployment)
      .mockRejectedValueOnce(h3Timeout('readNamespacedDeployment'))
    return () => f.appsApi.readNamespacedDeployment.mock.calls.length - before
  }

  it('publishes not-ready when a Service deleted out of band is re-created and the rollout read times out', async () => {
    const server = h3Server()
    const f = await h3ReadyCluster(server)
    f.services.delete('h3-server')
    const createsBefore = f.coreApi.createNamespacedService.mock.calls.length
    const publishedBefore = await reconcileCallFailures('rollout_read', 'not_ready_published')
    const rolloutReads = failRolloutRead(f)

    await f.reconciler.reconcile(server)

    expect(f.coreApi.createNamespacedService.mock.calls.length).toBe(createsBefore + 1)
    expect(f.appsApi.replaceNamespacedDeployment).not.toHaveBeenCalled()
    expect(rolloutReads()).toBe(2)
    expect(f.reconciler.getStatus(server)).toMatchObject({ ready: false, authoritative: true })
    expect(await reconcileCallFailures('rollout_read', 'not_ready_published')).toBe(
      publishedBefore + 1
    )
  })

  function remoteH3Server(): McpServerCRD {
    const server = h3Server()
    return { ...server, spec: { ...server.spec, remote: { baseUrl: 'https://api.example.com' } } }
  }

  it('keeps ready for an unchanged remote server whose ConfigMap needs no write keeps ready when the rollout read times out', async () => {
    const server = remoteH3Server()
    const f = await h3ReadyCluster(server)
    expect(f.configMaps.has('h3-server-nginx-conf')).toBe(true)
    const createsBefore = f.coreApi.createNamespacedConfigMap.mock.calls.length
    const cmReadsBefore = f.coreApi.readNamespacedConfigMap.mock.calls.length
    const keptBefore = await reconcileCallFailures('rollout_read', 'verdict_kept')
    const rolloutReads = failRolloutRead(f)

    await f.reconciler.reconcile(server)

    expect(f.coreApi.readNamespacedConfigMap.mock.calls.length).toBeGreaterThan(cmReadsBefore)
    expect(f.coreApi.createNamespacedConfigMap.mock.calls.length).toBe(createsBefore)
    expect(f.coreApi.replaceNamespacedConfigMap).not.toHaveBeenCalled()
    expect(rolloutReads()).toBe(2)
    expect(f.reconciler.getStatus(server)).toMatchObject({ ready: true, authoritative: true })
    expect(await reconcileCallFailures('rollout_read', 'verdict_kept')).toBe(keptBefore + 1)
  })

  it('publishes not-ready when a remote server ConfigMap deleted out of band is re-created and the rollout read times out', async () => {
    const server = remoteH3Server()
    const f = await h3ReadyCluster(server)
    f.configMaps.delete('h3-server-nginx-conf')
    const createsBefore = f.coreApi.createNamespacedConfigMap.mock.calls.length
    const publishedBefore = await reconcileCallFailures('rollout_read', 'not_ready_published')
    const rolloutReads = failRolloutRead(f)

    await f.reconciler.reconcile(server)

    expect(f.coreApi.createNamespacedConfigMap.mock.calls.length).toBe(createsBefore + 1)
    expect(f.appsApi.replaceNamespacedDeployment).not.toHaveBeenCalled()
    expect(rolloutReads()).toBe(2)
    expect(f.reconciler.getStatus(server)).toMatchObject({ ready: false, authoritative: true })
    expect(await reconcileCallFailures('rollout_read', 'not_ready_published')).toBe(
      publishedBefore + 1
    )
  })

  it('publishes not-ready when a drifted Service is replaced and the rollout read times out', async () => {
    const server = h3Server()
    const f = await h3ReadyCluster(server)
    const live = f.services.get('h3-server')
    live.spec.ports[0].port = live.spec.ports[0].port + 1
    const publishedBefore = await reconcileCallFailures('rollout_read', 'not_ready_published')
    const rolloutReads = failRolloutRead(f)

    await f.reconciler.reconcile(server)

    expect(f.coreApi.replaceNamespacedService).toHaveBeenCalledTimes(1)
    expect(f.appsApi.replaceNamespacedDeployment).not.toHaveBeenCalled()
    expect(rolloutReads()).toBe(2)
    expect(f.reconciler.getStatus(server)).toMatchObject({ ready: false, authoritative: true })
    expect(await reconcileCallFailures('rollout_read', 'not_ready_published')).toBe(
      publishedBefore + 1
    )
  })

  it('publishes not-ready when a drifted remote ConfigMap is replaced and the rollout read times out', async () => {
    const server = remoteH3Server()
    const f = await h3ReadyCluster(server)
    const live = f.configMaps.get('h3-server-nginx-conf')
    for (const key of Object.keys(live.data)) live.data[key] = live.data[key] + '\n# drift'
    const publishedBefore = await reconcileCallFailures('rollout_read', 'not_ready_published')
    const rolloutReads = failRolloutRead(f)

    await f.reconciler.reconcile(server)

    expect(f.coreApi.replaceNamespacedConfigMap).toHaveBeenCalledTimes(1)
    expect(f.appsApi.replaceNamespacedDeployment).not.toHaveBeenCalled()
    expect(rolloutReads()).toBe(2)
    expect(f.reconciler.getStatus(server)).toMatchObject({ ready: false, authoritative: true })
    expect(await reconcileCallFailures('rollout_read', 'not_ready_published')).toBe(
      publishedBefore + 1
    )
  })

  it('after a restart, a revision learned from an up-to-date Deployment detects a later missed rotation', async () => {
    const first = await h3ReadyCluster(h3Server())
    const restarted = new McpServerReconciler({} as k8s.KubeConfig, {
      assumeInventoryAuthorityWhenUnconfigured: true,
      appsApi: asAppsApi(first.appsApi),
      coreApi: asCoreApi(first.coreApi),
      customApi: asCustomApi(first.customApi),
    })
    restarted.setIncompleteReconciliationListener(vi.fn())
    const server = persistReadySeed(h3Server())
    await restarted.reconcile(server)
    expect(restarted.getStatus(server)).toMatchObject({ ready: true })
    expect(first.appsApi.replaceNamespacedDeployment).not.toHaveBeenCalled()
    first.coreApi.readNamespacedSecret.mockResolvedValueOnce({
      metadata: { name: 'h3-input', resourceVersion: '2' },
      data: { password: storedSecret('rotated-fixture-input-value') },
    })
    first.coreApi.readNamespacedService.mockRejectedValueOnce(h3Timeout('readNamespacedService'))
    const serviceReadsBefore = first.coreApi.readNamespacedService.mock.calls.length

    await restarted.reconcile(server)

    expect(first.coreApi.readNamespacedService.mock.calls.length).toBe(serviceReadsBefore + 1)
    expect(restarted.getStatus(server)).toMatchObject({ ready: false })
  })

  it.each([
    ['a 404', () => h3Absent()],
    ['a 409', () => Object.assign(new Error('conflict'), { code: 409 })],
    ['a 422', () => Object.assign(new Error('invalid'), { code: 422 })],
    ['an untyped error', () => new Error('opaque failure')],
  ])('publishes not-ready when the handshake fails with %s', async (_label, failure) => {
    const server = handshakeServer()
    const f = await h3ReadyCluster(server)
    f.customApi.patchNamespacedCustomObject.mockRejectedValueOnce(failure())

    await f.reconciler.reconcile(server)

    expect(f.customApi.patchNamespacedCustomObject).toHaveBeenCalledTimes(2)
    expect(f.reconciler.getStatus(server)).toMatchObject({ ready: false })
    expect(f.reconciler.getStatus(server).message).toContain('Pre-deploy handshake failed')
  })
})
