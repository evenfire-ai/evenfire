import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import * as k8s from '@kubernetes/client-node'
import {
  type MockAppsApi,
  type MockCoreApi,
  type MockCustomApi,
  asAppsApi,
  asCoreApi,
  asCustomApi,
  createMockAppsApi,
  createMockCoreApi,
  createMockCustomApi,
} from '../../test/__fixtures__/testMocks'
import { mcpserverMissingSecret } from '../metrics'
import { McpServerReconciler } from '../reconciler'
import type { McpServerCRD } from '../types'

/**
 * Egress-proxy value preflight (spec §4/§8.5, issue #1240): PF-1..PF-20 and
 * PF-11b. Every negative assertion carries a witness that the path ran: the
 * Secret read, the condition write, the `False` condition or the block's
 * `Ready=False` patch.
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

const SECRET_NAME = 'remote-creds'
const API_KEY_SECRET_KEY = 'api-key'

function cloneServer(
  server: McpServerCRD,
  specOverrides: Partial<McpServerCRD['spec']> = {}
): McpServerCRD {
  return {
    ...server,
    spec: {
      ...server.spec,
      ...specOverrides,
      transport: { ...server.spec.transport, ...specOverrides.transport },
      remote: 'remote' in specOverrides ? specOverrides.remote : server.spec.remote,
      envSecret: 'envSecret' in specOverrides ? specOverrides.envSecret : server.spec.envSecret,
    },
  }
}

const API_KEY_SERVER: McpServerCRD = {
  name: 'mcp-query-remote',
  namespace: 'mcp-server',
  uid: 'uid-query-remote',
  spec: {
    image: 'clerum/nginx-egress-proxy:0.1.0',
    transport: { type: 'streamableHttp', port: 3000 },
    managed: true,
    enabled: true,
    remote: { baseUrl: 'https://api.example.com/mcp?apikey=' + '$' + '{API_KEY}' },
    envSecret: {
      name: SECRET_NAME,
      keys: [{ secretKey: API_KEY_SECRET_KEY, envVar: 'API_KEY' }],
    },
  },
}

const LOCAL_SERVER: McpServerCRD = {
  name: 'local-mongo',
  namespace: 'mcp-server',
  uid: 'uid-local-mongo',
  spec: {
    image: 'clerum/mongodb-mcp:0.9.5',
    transport: { type: 'streamableHttp', port: 3000 },
    managed: true,
    enabled: true,
  },
}

function encodedSecret(entries: Record<string, string>): { data: Record<string, string> } {
  const data: Record<string, string> = {}
  for (const [key, value] of Object.entries(entries)) {
    data[key] = Buffer.from(value, 'utf8').toString('base64')
  }
  return { data }
}

function conditionsFromStatusPatch(patch: unknown): any[] {
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

function allPatchedConditions(customApi: MockCustomApi): any[] {
  return customApi.patchNamespacedCustomObjectStatus.mock.calls.flatMap(call =>
    conditionsFromStatusPatch(call[0]?.body)
  )
}

function convergedDeployment(name: string): k8s.V1Deployment {
  return {
    metadata: { name, namespace: 'mcp-server', generation: 1 },
    spec: {
      replicas: 1,
      selector: { matchLabels: { app: name } },
      template: {
        metadata: { labels: { app: name } },
        spec: { containers: [{ name: 'egress-proxy', image: 'clerum/nginx-egress-proxy:0.1.0' }] },
      },
    },
    status: {
      observedGeneration: 1,
      replicas: 1,
      updatedReplicas: 1,
      readyReplicas: 1,
      unavailableReplicas: 0,
    },
  }
}

/** Leave every no-op mock alone; only a 404 makes the resource be created. */
function forceCreates(appsApi: MockAppsApi, coreApi: MockCoreApi): void {
  coreApi.readNamespacedConfigMap.mockRejectedValueOnce({ code: 404 })
  coreApi.readNamespacedService.mockRejectedValueOnce({ code: 404 })
  appsApi.readNamespacedDeployment.mockRejectedValueOnce({ code: 404 })
}

async function flushMicrotasks(turns = 60): Promise<void> {
  for (let turn = 0; turn < turns; turn += 1) await Promise.resolve()
}

function expectNoValueFragment(message: string, value: string): void {
  if (value.length > 0) expect(message).not.toContain(value)
  for (let index = 0; index + 4 <= value.length; index += 1) {
    expect(message, `a 4-character fragment of the value leaked at ${index}`).not.toContain(
      value.slice(index, index + 4)
    )
  }
}

describe('egress-proxy value preflight (PF for #1240)', () => {
  let appsApi: MockAppsApi
  let coreApi: MockCoreApi
  let customApi: MockCustomApi
  let reconciler: McpServerReconciler

  beforeEach(() => {
    vi.useFakeTimers()
    vi.clearAllMocks()
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

  afterEach(() => {
    vi.clearAllTimers()
    vi.useRealTimers()
    vi.restoreAllMocks()
  })

  it('PF-1: a query value within the class writes the resources and reports True', async () => {
    coreApi.readNamespacedSecret.mockResolvedValue(
      encodedSecret({ [API_KEY_SECRET_KEY]: 'abc/def%2Bgh==' })
    )
    forceCreates(appsApi, coreApi)

    await reconciler.reconcile(API_KEY_SERVER)

    expect(coreApi.createNamespacedConfigMap).toHaveBeenCalledOnce()
    expect(appsApi.createNamespacedDeployment).toHaveBeenCalledOnce()
    expect(allPatchedConditions(customApi)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: 'EgressProxyValuesValid',
          status: 'True',
          reason: 'ValuesWithinClass',
        }),
      ])
    )
  })

  it('PF-2: an out-of-class query value blocks both writes and names the placeholder', async () => {
    const value = 'abc/def+gh=='
    coreApi.readNamespacedSecret.mockResolvedValue(encodedSecret({ [API_KEY_SECRET_KEY]: value }))

    await reconciler.reconcile(API_KEY_SERVER)

    // Witness: the reconcile reached the preflight (it read the Secret).
    expect(coreApi.readNamespacedSecret).toHaveBeenCalledOnce()
    expect(coreApi.createNamespacedConfigMap).not.toHaveBeenCalled()
    expect(coreApi.replaceNamespacedConfigMap).not.toHaveBeenCalled()
    expect(appsApi.createNamespacedDeployment).not.toHaveBeenCalled()
    expect(appsApi.replaceNamespacedDeployment).not.toHaveBeenCalled()

    const valid = allPatchedConditions(customApi).find(
      condition => condition.type === 'EgressProxyValuesValid'
    )
    expect(valid).toBeDefined()
    expect(valid.status).toBe('False')
    expect(valid.reason).toBe('ValueOutsideClass')
    expect(valid.message).toContain('query placeholder ${API_KEY}')
    expect(valid.message).toContain(`Secret "${SECRET_NAME}"`)
    expect(valid.message).toContain(`"${API_KEY_SECRET_KEY}"`)
    expect(valid.message).toContain('query')
    expectNoValueFragment(valid.message, value)
    expect(valid.message).not.toContain(value)
  })

  it('PF-3: an out-of-class authHeader value blocks and names header, placeholder and key', async () => {
    const value = 'tok\n'
    const server = cloneServer(API_KEY_SERVER, {
      remote: {
        baseUrl: 'https://api.example.com/mcp',
        authHeaders: [{ header: 'X-Api-Key', valueTemplate: 'Bearer ' + '$' + '{TOKEN}' }],
      },
      envSecret: {
        name: SECRET_NAME,
        keys: [{ secretKey: 'token', envVar: 'TOKEN' }],
      },
    })
    coreApi.readNamespacedSecret.mockResolvedValue(encodedSecret({ token: value }))

    await reconciler.reconcile(server)

    // Witness: the Secret read proves the preflight path ran.
    expect(coreApi.readNamespacedSecret).toHaveBeenCalledOnce()
    expect(appsApi.createNamespacedDeployment).not.toHaveBeenCalled()
    const valid = allPatchedConditions(customApi).find(
      condition => condition.type === 'EgressProxyValuesValid'
    )
    expect(valid.status).toBe('False')
    expect(valid.message).toContain('authHeader X-Api-Key')
    expect(valid.message).toContain('placeholder ${TOKEN}')
    expect(valid.message).toContain('key "token"')
    expect(valid.message).toContain('quoted')
    expectNoValueFragment(valid.message, value)
  })

  it('PF-4: an out-of-class literal in spec.env blocks with the "literal value" source', async () => {
    const server = cloneServer(API_KEY_SERVER, {
      remote: { baseUrl: 'https://api.example.com/mcp?apikey=' + '$' + '{API_KEY}' },
      envSecret: undefined,
      env: [{ name: 'API_KEY', value: 'a+b' }],
    })

    await reconciler.reconcile(server)

    // Witness: the same CRD renders its template, so the block is about the
    // value and not about the placeholder position.
    expect((reconciler as any).buildNginxConfigMap(server).data['default.conf.template']).toContain(
      'proxy_pass https://api.example.com/mcp?apikey=${API_KEY};'
    )
    expect(appsApi.createNamespacedDeployment).not.toHaveBeenCalled()
    expect(coreApi.createNamespacedConfigMap).not.toHaveBeenCalled()
    const valid = allPatchedConditions(customApi).find(
      condition => condition.type === 'EgressProxyValuesValid'
    )
    expect(valid.status).toBe('False')
    expect(valid.message).toContain('query placeholder ${API_KEY}')
    expect(valid.message).toContain('literal value from spec.env or spec.envMapping')
    expectNoValueFragment(valid.message, 'a+b')
  })

  it('PF-5: an env var that collides with a fixed NGINX variable is blocked', async () => {
    const server = cloneServer(API_KEY_SERVER, {
      env: [{ name: 'scheme', value: 'https' }],
    })
    coreApi.readNamespacedSecret.mockResolvedValue(
      encodedSecret({ [API_KEY_SECRET_KEY]: 'alpha%2Fbeta' })
    )

    await reconciler.reconcile(server)

    // Witness: the same server without the colliding declaration renders.
    expect(
      (reconciler as any).buildNginxConfigMap(cloneServer(API_KEY_SERVER)).data[
        'default.conf.template'
      ]
    ).toContain('proxy_set_header X-Forwarded-Proto $scheme;')
    expect(appsApi.createNamespacedDeployment).not.toHaveBeenCalled()
    const valid = allPatchedConditions(customApi).find(
      condition => condition.type === 'EgressProxyValuesValid'
    )
    expect(valid.status).toBe('False')
    expect(valid.message).toContain('env var ${scheme} collides with an NGINX variable')
    expect(valid.message).toContain('collides')
  })

  it('PF-6: two violations are both listed and sorted by context and placeholder', async () => {
    const server = cloneServer(API_KEY_SERVER, {
      remote: {
        baseUrl: 'https://api.example.com/mcp?apikey=' + '$' + '{ZED_KEY}',
        authHeaders: [{ header: 'X-Api-Key', valueTemplate: 'Bearer ' + '$' + '{TOKEN}' }],
      },
      envSecret: {
        name: SECRET_NAME,
        keys: [
          { secretKey: 'z', envVar: 'ZED_KEY' },
          { secretKey: 'token', envVar: 'TOKEN' },
        ],
      },
    })
    coreApi.readNamespacedSecret.mockResolvedValue(encodedSecret({ z: 'a+b', token: 'tok\n' }))

    await reconciler.reconcile(server)

    // Witness: the Secret read proves the preflight path ran.
    expect(coreApi.readNamespacedSecret).toHaveBeenCalledOnce()
    const valid = allPatchedConditions(customApi).find(
      condition => condition.type === 'EgressProxyValuesValid'
    )
    expect(valid.message).toContain('2 value(s)')
    expect(valid.message).toContain('query placeholder ${ZED_KEY}')
    expect(valid.message).toContain('authHeader X-Api-Key placeholder ${TOKEN}')
    expect(valid.message.indexOf('query placeholder')).toBeLessThan(
      valid.message.indexOf('authHeader X-Api-Key')
    )
  })

  it('PF-6b: the message stops at ten entries and counts the rest', async () => {
    const names = Array.from({ length: 12 }, (_unused, index) => `BAD_KEY_${index}`)
    const server = cloneServer(API_KEY_SERVER, {
      remote: {
        baseUrl:
          'https://api.example.com/mcp?' +
          names.map((name, index) => `k${index}=` + '$' + `{${name}}`).join('&'),
      },
      envSecret: undefined,
      env: names.map(name => ({ name, value: 'a+b' })),
    })

    await reconciler.reconcile(server)

    // Witness: the block wrote the False condition and nothing was deployed.
    expect(appsApi.createNamespacedDeployment).not.toHaveBeenCalled()
    const valid = allPatchedConditions(customApi).find(
      condition => condition.type === 'EgressProxyValuesValid'
    )
    expect(valid.status).toBe('False')
    expect(valid.message).toContain('12 value(s)')
    expect(valid.message).toContain('and 2 more')
    expect(valid.message.match(/query placeholder/g)).toHaveLength(10)
  })

  it('PF-7: an identical repeated block keeps the message and restamps the refusal', async () => {
    coreApi.readNamespacedSecret.mockResolvedValue(
      encodedSecret({ [API_KEY_SECRET_KEY]: 'abc/def+gh==' })
    )
    const persisted: any[] = []
    customApi.getNamespacedCustomObjectStatus.mockImplementation(async () => ({
      metadata: { resourceVersion: '7' },
      status: { conditions: persisted },
    }))
    customApi.patchNamespacedCustomObjectStatus.mockImplementation(async ({ body }: any) => {
      persisted.length = 0
      persisted.push(...conditionsFromStatusPatch(body))
      return {}
    })

    vi.setSystemTime(new Date('2026-11-03T09:00:00.000Z'))
    await reconciler.reconcile(API_KEY_SERVER)
    const firstRefusal = persisted.find(condition => condition.type === 'EgressProxyValuesValid')
    const firstMessage = firstRefusal.message
    const patchesAfterFirst = customApi.patchNamespacedCustomObjectStatus.mock.calls.length
    expect(patchesAfterFirst).toBeGreaterThan(0)

    // A second rotation lands outside the class too, violating the same
    // placeholder, source and key: reason+message are byte-identical and only
    // the instant of the refusal differs.
    vi.setSystemTime(new Date('2026-11-03T09:05:00.000Z'))
    await reconciler.reconcile(API_KEY_SERVER)

    const secondRefusal = persisted.find(condition => condition.type === 'EgressProxyValuesValid')
    // Life witness: the second reconcile re-read the Secret, reached the block
    // and republished the refusal.
    expect(coreApi.readNamespacedSecret).toHaveBeenCalledTimes(2)
    expect(reconciler.getStatus(API_KEY_SERVER).message).toContain(firstMessage)
    // The message stays a pure function of CRD + Secret data...
    expect(secondRefusal.message).toBe(firstMessage)
    // ...and the refusal is restamped in THIS reconcile. Without that, a second
    // consecutive out-of-class rotation would carry the first block's
    // timestamp, Control UI's freshness rule would discard it and the operator
    // would sit through the full 180s budget instead of seeing the refusal.
    expect(customApi.patchNamespacedCustomObjectStatus.mock.calls.length).toBe(
      patchesAfterFirst + 1
    )
    expect(secondRefusal.lastTransitionTime).toBe('2026-11-03T09:05:00.000Z')
    // Scope witness: only the refusal restamps. Ready=False is byte-identical
    // and keeps the stamp it already had.
    expect(persisted.find(condition => condition.type === 'Ready').lastTransitionTime).toBe(
      '2026-11-03T09:00:00.000Z'
    )
  })

  it('PF-8: a fixed Secret clears the block and the Deployment is written', async () => {
    coreApi.readNamespacedSecret.mockResolvedValue(
      encodedSecret({ [API_KEY_SECRET_KEY]: 'abc/def+gh==' })
    )
    await reconciler.reconcile(API_KEY_SERVER)
    expect(appsApi.createNamespacedDeployment).not.toHaveBeenCalled()

    coreApi.readNamespacedSecret.mockResolvedValue(
      encodedSecret({ [API_KEY_SECRET_KEY]: 'abc/def%2Bgh==' })
    )
    forceCreates(appsApi, coreApi)
    await reconciler.reconcile(API_KEY_SERVER)

    expect(coreApi.createNamespacedConfigMap).toHaveBeenCalledOnce()
    expect(appsApi.createNamespacedDeployment).toHaveBeenCalledOnce()
    const conditions = allPatchedConditions(customApi)
    expect(conditions).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: 'EgressProxyValuesValid',
          status: 'True',
          reason: 'ValuesWithinClass',
        }),
      ])
    )
  })

  it('PF-9: a block with envSecret writes SecretResolved=True and resets the gauge', async () => {
    coreApi.readNamespacedSecret.mockResolvedValue(
      encodedSecret({ [API_KEY_SECRET_KEY]: 'abc/def+gh==' })
    )

    await reconciler.reconcile(API_KEY_SERVER)

    const conditions = allPatchedConditions(customApi)
    expect(conditions).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: 'SecretResolved',
          status: 'True',
          reason: 'SecretFound',
        }),
      ])
    )
    const snapshot = await mcpserverMissingSecret.get()
    const gauge = snapshot.values.find(
      value =>
        value.labels.name === API_KEY_SERVER.name &&
        value.labels.namespace === API_KEY_SERVER.namespace
    )
    expect(gauge?.value).toBe(0)
  })

  it('PF-10: a block reports not ready and the status names the condition', async () => {
    coreApi.readNamespacedSecret.mockResolvedValue(
      encodedSecret({ [API_KEY_SECRET_KEY]: 'abc/def+gh==' })
    )

    await reconciler.reconcile(API_KEY_SERVER)

    const status = reconciler.getStatus(API_KEY_SERVER)
    expect(status.ready).toBe(false)
    expect(status.deployed).toBe(false)
    expect(status.message).toContain('EgressProxyValuesValid')
    // Witness: the CRD also carries Ready=False/EgressProxyValuesInvalid.
    expect(allPatchedConditions(customApi)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: 'Ready',
          status: 'False',
          reason: 'EgressProxyValuesInvalid',
        }),
      ])
    )
  })

  it('PF-11: a pending readiness timer cannot publish Ready=True after the block', async () => {
    coreApi.readNamespacedSecret.mockResolvedValue(
      encodedSecret({ [API_KEY_SECRET_KEY]: 'abc/def%2Bgh==' })
    )
    forceCreates(appsApi, coreApi)
    await reconciler.reconcile(API_KEY_SERVER)
    // Witness: the first reconcile armed the window.
    expect((reconciler as any).readinessPolls.size).toBe(1)

    coreApi.readNamespacedSecret.mockResolvedValue(
      encodedSecret({ [API_KEY_SECRET_KEY]: 'abc/def+gh==' })
    )
    await reconciler.reconcile(API_KEY_SERVER)

    expect((reconciler as any).readinessPolls.size).toBe(0)
    const patchesAtBlock = customApi.patchNamespacedCustomObjectStatus.mock.calls.length
    await vi.advanceTimersByTimeAsync(60000)
    await flushMicrotasks()
    expect(customApi.patchNamespacedCustomObjectStatus.mock.calls.length).toBe(patchesAtBlock)
    const readyTrue = allPatchedConditions(customApi).filter(
      condition => condition.type === 'Ready' && condition.status === 'True'
    )
    expect(readyTrue).toEqual([])
    expect(reconciler.getStatus(API_KEY_SERVER).ready).toBe(false)
  })

  it('PF-11b: a tick already in flight cannot publish Ready=True after the block', async () => {
    coreApi.readNamespacedSecret.mockResolvedValue(
      encodedSecret({ [API_KEY_SECRET_KEY]: 'abc/def%2Bgh==' })
    )
    forceCreates(appsApi, coreApi)
    await reconciler.reconcile(API_KEY_SERVER)

    // The rollout converges: the next tick reports ready.
    appsApi.readNamespacedDeployment.mockResolvedValue(convergedDeployment(API_KEY_SERVER.name))

    // Hold the tick's DeploymentReady=True patch. The block's own writes
    // (SecretResolved, EgressProxyValuesValid, Ready=False) are not held.
    let releaseHeld: () => void = () => {}
    const heldWrite = new Promise<void>(resolve => {
      releaseHeld = resolve
    })
    let heldReached = false
    customApi.patchNamespacedCustomObjectStatus.mockImplementation(async ({ body }: any) => {
      const conditions = conditionsFromStatusPatch(body)
      const isTickWrite = conditions.some(
        condition => condition.type === 'DeploymentReady' && condition.status === 'True'
      )
      if (isTickWrite && !heldReached) {
        heldReached = true
        await heldWrite
      }
      return {}
    })

    // Fire the tick without awaiting it: it stops on the held promise.
    vi.advanceTimersByTime(5000)
    await flushMicrotasks()
    expect(heldReached, 'the tick did not reach its status write').toBe(true)
    // Witness the tick set the in-memory status ready at :822 before the block.
    expect(reconciler.getStatus(API_KEY_SERVER).ready).toBe(true)

    coreApi.readNamespacedSecret.mockResolvedValue(
      encodedSecret({ [API_KEY_SECRET_KEY]: 'abc/def+gh==' })
    )
    await reconciler.reconcile(API_KEY_SERVER)
    const patchesAtBlock = customApi.patchNamespacedCustomObjectStatus.mock.calls.length

    releaseHeld()
    await flushMicrotasks()

    const writesAfterBlock = customApi.patchNamespacedCustomObjectStatus.mock.calls
      .slice(patchesAtBlock)
      .flatMap(call => conditionsFromStatusPatch(call[0]?.body))
    expect(
      writesAfterBlock.filter(
        condition => condition.type === 'Ready' && condition.status === 'True'
      )
    ).toEqual([])
    expect(reconciler.getStatus(API_KEY_SERVER).ready).toBe(false)
    // Witness: the block's own Ready=False was written.
    expect(
      customApi.patchNamespacedCustomObjectStatus.mock.calls
        .flatMap(call => conditionsFromStatusPatch(call[0]?.body))
        .filter(
          condition =>
            condition.type === 'Ready' &&
            condition.status === 'False' &&
            condition.reason === 'EgressProxyValuesInvalid'
        ).length
    ).toBeGreaterThan(0)
  })

  it('PF-12: a non-remote server never gets the condition, and its Deployment is written', async () => {
    forceCreates(appsApi, coreApi)

    await reconciler.reconcile(LOCAL_SERVER)

    expect(appsApi.createNamespacedDeployment).toHaveBeenCalledOnce()
    expect(
      allPatchedConditions(customApi).filter(
        condition => condition.type === 'EgressProxyValuesValid'
      )
    ).toEqual([])
  })

  it('PF-13: a static CRD error keeps the Resource sync failed path and writes no EgressProxyValuesValid condition', async () => {
    const server = cloneServer(API_KEY_SERVER, {
      remote: {
        baseUrl: 'https://api.example.com/mcp?apikey=' + '$' + '{UNDECLARED_KEY}',
      },
    })
    coreApi.readNamespacedSecret.mockResolvedValue(
      encodedSecret({ [API_KEY_SECRET_KEY]: 'alpha%2Fbeta' })
    )

    await reconciler.reconcile(server)

    // Witness: the reconcile reached the resource sync (it read the Secret).
    expect(coreApi.readNamespacedSecret).toHaveBeenCalledOnce()
    expect(reconciler.getStatus(server).message).toContain('Resource sync failed')
    expect(reconciler.getStatus(server).message).toContain(
      'query placeholder ${UNDECLARED_KEY} is not declared'
    )
    expect(
      allPatchedConditions(customApi).filter(
        condition => condition.type === 'EgressProxyValuesValid'
      )
    ).toEqual([])
    // Witness: the failure still reaches the CRD as Ready=False, the write a
    // stale verdict would be retired on (PF-19 covers the retirement itself).
    expect(allPatchedConditions(customApi)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: 'Ready',
          status: 'False',
          reason: 'ResourceSyncFailed',
        }),
      ])
    )
  })

  it('PF-14: a referenced literal holding $(NAME) is blocked by design', async () => {
    const server = cloneServer(API_KEY_SERVER, {
      remote: { baseUrl: 'https://api.example.com/mcp?apikey=' + '$' + '{Q}' },
      envSecret: undefined,
      env: [
        { name: 'OTHER', value: 'abc' },
        { name: 'Q', value: '$(OTHER)' },
      ],
    })

    await reconciler.reconcile(server)

    // Witness: the False condition is written and names ${Q}.
    const valid = allPatchedConditions(customApi).find(
      condition => condition.type === 'EgressProxyValuesValid'
    )
    expect(valid.status).toBe('False')
    expect(valid.message).toContain('query placeholder ${Q}')
    expect(valid.message).toContain('literal value from spec.env or spec.envMapping')
    expect(valid.message).toContain('dependent env reference')
    expect(appsApi.createNamespacedDeployment).not.toHaveBeenCalled()
  })

  it('PF-15: removing spec.remote retires the condition through the Ready write', async () => {
    let persisted: any[] = [
      {
        type: 'Ready',
        status: 'True',
        reason: 'ReconcileSuccess',
        message: 'Deployment created',
        lastTransitionTime: '2026-01-01T00:00:00.000Z',
      },
      {
        type: 'EgressProxyValuesValid',
        status: 'True',
        reason: 'ValuesWithinClass',
        message: 'Every value the egress-proxy template substitutes is within its class',
        lastTransitionTime: '2026-01-01T00:00:00.000Z',
      },
    ]
    customApi.getNamespacedCustomObjectStatus.mockImplementation(async () => ({
      metadata: { resourceVersion: '11' },
      status: { conditions: persisted },
    }))
    customApi.patchNamespacedCustomObjectStatus.mockImplementation(async ({ body }: any) => {
      persisted = conditionsFromStatusPatch(body)
      return {}
    })
    appsApi.readNamespacedDeployment.mockResolvedValue(convergedDeployment(LOCAL_SERVER.name))

    await reconciler.reconcile(LOCAL_SERVER)

    // Witness: the Ready patch is sent although Ready itself is unchanged, and
    // it carries no EgressProxyValuesValid.
    const readyPatch = allPatchedConditions(customApi).filter(
      condition => condition.type === 'Ready'
    )
    expect(readyPatch.length).toBeGreaterThan(0)
    expect(readyPatch[readyPatch.length - 1]).toEqual(
      expect.objectContaining({ type: 'Ready', status: 'True', reason: 'ReconcileSuccess' })
    )
    expect(persisted.map(condition => condition.type)).not.toContain('EgressProxyValuesValid')

    const patchesAfterFirst = customApi.patchNamespacedCustomObjectStatus.mock.calls.length
    await reconciler.reconcile(LOCAL_SERVER)
    expect(customApi.patchNamespacedCustomObjectStatus.mock.calls.length).toBe(patchesAfterFirst)
  })

  it('PF-16: disabling the server retires the condition through the Disabled write', async () => {
    let persisted: any[] = [
      {
        type: 'Ready',
        status: 'True',
        reason: 'ReconcileSuccess',
        message: 'Deployment created',
        lastTransitionTime: '2026-01-01T00:00:00.000Z',
      },
      {
        type: 'EgressProxyValuesValid',
        status: 'True',
        reason: 'ValuesWithinClass',
        message: 'Every value the egress-proxy template substitutes is within its class',
        lastTransitionTime: '2026-01-01T00:00:00.000Z',
      },
    ]
    customApi.getNamespacedCustomObjectStatus.mockImplementation(async () => ({
      metadata: { resourceVersion: '12' },
      status: { conditions: persisted },
    }))
    customApi.patchNamespacedCustomObjectStatus.mockImplementation(async ({ body }: any) => {
      persisted = conditionsFromStatusPatch(body)
      return {}
    })
    const disabled = cloneServer(API_KEY_SERVER, { enabled: false })

    await reconciler.reconcile(disabled)

    // Witness: the Ready=False/Disabled patch holds no EgressProxyValuesValid.
    const disabledPatch = allPatchedConditions(customApi).filter(
      condition => condition.type === 'Ready' && condition.reason === 'Disabled'
    )
    expect(disabledPatch).toHaveLength(1)
    expect(disabledPatch[0].status).toBe('False')
    expect(persisted.map(condition => condition.type)).not.toContain('EgressProxyValuesValid')
  })

  it('PF-17: a block that stops being current before setStatus publishes no status', async () => {
    coreApi.readNamespacedSecret.mockResolvedValue(
      encodedSecret({ [API_KEY_SECRET_KEY]: 'abc/def+gh==' })
    )
    // The reconcile stays current through every condition write and stops
    // being current right after the last one (Ready=False): the exact window
    // between the block's writes and its setStatus(). Production's composed
    // predicate turns false there when a newer generation or a delete
    // replaced this desired revision; this test injects that state through
    // the caller hook.
    let current = true
    let flippedAtLastWrite = false
    customApi.patchNamespacedCustomObjectStatus.mockImplementation(async ({ body }: any) => {
      const conditions = conditionsFromStatusPatch(body)
      if (
        !flippedAtLastWrite &&
        conditions.some(
          condition =>
            condition.type === 'Ready' &&
            condition.status === 'False' &&
            condition.reason === 'EgressProxyValuesInvalid'
        )
      ) {
        flippedAtLastWrite = true
        current = false
      }
      return {}
    })

    await reconciler.reconcile(API_KEY_SERVER, { isCurrent: () => current })

    // Life witness: the reconcile reached the block (Secret read, all three
    // condition writes) before it stopped being current.
    expect(coreApi.readNamespacedSecret).toHaveBeenCalledOnce()
    expect(flippedAtLastWrite, 'the block never wrote Ready=False').toBe(true)
    expect(allPatchedConditions(customApi)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ type: 'SecretResolved', status: 'True', reason: 'SecretFound' }),
        expect.objectContaining({
          type: 'EgressProxyValuesValid',
          status: 'False',
          reason: 'ValueOutsideClass',
        }),
        expect.objectContaining({
          type: 'Ready',
          status: 'False',
          reason: 'EgressProxyValuesInvalid',
        }),
      ])
    )
    expect(appsApi.createNamespacedDeployment).not.toHaveBeenCalled()

    // The guard: a block that is no longer current must not publish its
    // refusal through setStatus(). Without it the in-memory status describes
    // a reconcile a newer generation already replaced, and the next reader
    // believes this CRD is blocked on the retired revision.
    expect((reconciler as any).statusMap.has(API_KEY_SERVER.name)).toBe(false)
    expect(reconciler.getStatus(API_KEY_SERVER)).toEqual({
      deployed: false,
      ready: false,
      message: 'Not reconciled yet',
      authoritative: false,
    })
  })

  it('PF-18: a query placeholder naming a forbidden env var is rejected even when declared only via envSecret', () => {
    const forbiddenNames = [
      'LD_PRELOAD',
      'LD_LIBRARY_PATH',
      'PATH',
      'NODE_OPTIONS',
      'PYTHONPATH',
      'JAVA_TOOL_OPTIONS',
      'KUBECONFIG',
      'KUBERNETES_SERVICE_HOST',
      'KUBERNETES_SERVICE_PORT',
    ]
    expect(forbiddenNames).toHaveLength(9)
    for (const name of forbiddenNames) {
      const server = cloneServer(API_KEY_SERVER, {
        remote: { baseUrl: 'https://api.example.com/mcp?q=' + '$' + `{${name}}` },
        envSecret: {
          name: SECRET_NAME,
          keys: [{ secretKey: 'k', envVar: name }],
        },
      })
      expect(
        () => (reconciler as any).buildNginxConfigMap(server),
        `${name} declared via envSecret must still be rejected`
      ).toThrow(`query placeholder \${${name}} names a forbidden env var; use another name`)
    }
    // Life witness: the same shape with an allowed name declared only via
    // envSecret renders, so the rejections above come from the name class and
    // not from the envSecret declaration channel.
    expect(
      (reconciler as any).buildNginxConfigMap(API_KEY_SERVER).data['default.conf.template']
    ).toContain('proxy_pass https://api.example.com/mcp?apikey=${API_KEY};')
  })

  it('PF-19: a render failure retires a stale True through the Ready write', async () => {
    let persisted: any[] = [
      {
        type: 'Ready',
        status: 'True',
        reason: 'ReconcileSuccess',
        message: 'Deployment created',
        lastTransitionTime: '2026-01-01T00:00:00.000Z',
      },
      {
        type: 'EgressProxyValuesValid',
        status: 'True',
        reason: 'ValuesWithinClass',
        message: 'Every value the egress-proxy template substitutes is within its class',
        lastTransitionTime: '2026-01-01T00:00:00.000Z',
      },
    ]
    customApi.getNamespacedCustomObjectStatus.mockImplementation(async () => ({
      metadata: { resourceVersion: '13' },
      status: { conditions: persisted },
    }))
    customApi.patchNamespacedCustomObjectStatus.mockImplementation(async ({ body }: any) => {
      persisted = conditionsFromStatusPatch(body)
      return {}
    })
    coreApi.readNamespacedSecret.mockResolvedValue(
      encodedSecret({ [API_KEY_SECRET_KEY]: 'alpha%2Fbeta' })
    )
    // Editing baseUrl to an undeclared placeholder makes the render throw
    // before any verdict exists for this spec.
    const server = cloneServer(API_KEY_SERVER, {
      remote: {
        baseUrl: 'https://api.example.com/mcp?apikey=' + '$' + '{UNDECLARED_KEY}',
      },
    })

    await reconciler.reconcile(server)

    // Life witness: the reconcile reached the resource sync and the render
    // failed there (it read the Secret and recorded the sync failure).
    expect(coreApi.readNamespacedSecret).toHaveBeenCalledOnce()
    expect(reconciler.getStatus(server).message).toContain('Resource sync failed')
    expect(reconciler.getStatus(server).message).toContain(
      'query placeholder ${UNDECLARED_KEY} is not declared'
    )
    expect(coreApi.createNamespacedConfigMap).not.toHaveBeenCalled()
    expect(appsApi.createNamespacedDeployment).not.toHaveBeenCalled()
    // The retirement rides the Ready write: the resulting conditions hold the
    // new Ready=False and no EgressProxyValuesValid at all, instead of the
    // stale True the earlier spec persisted.
    expect(persisted).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: 'Ready',
          status: 'False',
          reason: 'ResourceSyncFailed',
        }),
      ])
    )
    expect(persisted.map(condition => condition.type)).not.toContain('EgressProxyValuesValid')
  })

  it('PF-20: a WRC-owned server retires a stale False through its Ready write', async () => {
    let persisted: any[] = [
      {
        type: 'Ready',
        status: 'False',
        reason: 'EgressProxyValuesInvalid',
        message: 'stale refusal from before WRC ownership',
        lastTransitionTime: '2026-01-01T00:00:00.000Z',
      },
      {
        type: 'EgressProxyValuesValid',
        status: 'False',
        reason: 'ValueOutsideClass',
        message: 'stale refusal from before WRC ownership',
        lastTransitionTime: '2026-01-01T00:00:00.000Z',
      },
    ]
    customApi.getNamespacedCustomObjectStatus.mockImplementation(async () => ({
      metadata: { resourceVersion: '14' },
      status: { conditions: persisted },
    }))
    customApi.patchNamespacedCustomObjectStatus.mockImplementation(async ({ body }: any) => {
      persisted = conditionsFromStatusPatch(body)
      return {}
    })
    coreApi.readNamespacedSecret.mockResolvedValue(
      encodedSecret({ [API_KEY_SECRET_KEY]: 'alpha%2Fbeta' })
    )
    const server = cloneServer(API_KEY_SERVER, { managed: false })

    await reconciler.reconcile(server)

    // Life witness: the WRC-owned path ran (Secret validated, discovery
    // status registered, no HCC runtime written).
    expect(coreApi.readNamespacedSecret).toHaveBeenCalledOnce()
    expect(reconciler.getStatus(server).message).toContain('WRC-owned runtime registered')
    expect(appsApi.createNamespacedDeployment).not.toHaveBeenCalled()
    // Ready=True no longer sits next to the stale False: the WRC Ready write
    // retired it.
    expect(persisted).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: 'Ready',
          status: 'True',
          reason: 'WrcOwnedRuntimeRegistered',
        }),
      ])
    )
    expect(persisted.map(condition => condition.type)).not.toContain('EgressProxyValuesValid')
  })
})
