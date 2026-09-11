import { beforeEach, describe, expect, it, vi } from 'vitest'
import * as k8s from '@kubernetes/client-node'
import { OAI_EGRESS_BROKERS_CONDITION_TYPE } from '@clerum/egress-policy'
import {
  type MockAppsApi,
  type MockCoreApi,
  type MockCustomApi,
  type MockNetworkingApi,
  asAppsApi,
  asCoreApi,
  asCustomApi,
  asNetworkingApi,
  createMockAppsApi,
  createMockCoreApi,
  createMockCustomApi,
  createMockNetworkingApi,
} from '../test/__fixtures__/testMocks'
import { HOST_LABEL, MANAGED_BY_LABEL, OAI_EGRESS_BROKER_LABEL } from './constants'
import {
  OpenAiEgressBrokerReconciler,
  brokerNameFor,
  hostDeclaresOpenAiCompatible,
} from './openaiEgressBrokerReconciler'
import { HostCRD, HostCondition, HostSpec } from './types'

vi.mock('./config', () => ({
  config: {
    devMode: false,
    hostNamespace: 'mcp-host',
    llmEgressNamespace: 'llm-egress',
    openaiEgressBrokerPort: 3000,
    egressProxyImage: 'clerum/nginx-egress-proxy:test',
    mcpServerImagePullPolicy: 'IfNotPresent',
    k8sApiCidrs: [],
    nodeLocalDnsCidr: '',
    // kube default Service range — a broker must never be pointed at it.
    clusterInternalEgressCidrs: ['10.96.0.0/12'],
    // node subnet — present so the node-guard category is configured; none of
    // the test LAN URLs (192.168.1.x, 10.0.0.x) fall inside it.
    clusterNodeEgressCidrs: ['192.168.49.0/24'],
    oaiEgressRequireClusterCidrs: true,
  },
}))

const LOCAL_URL = 'http://192.168.1.50:8000/v1'

function makeHost(
  overrides: Omit<Partial<HostCRD>, 'spec'> & { name: string; spec?: Partial<HostSpec> }
): HostCRD {
  const { name, spec, ...rest } = overrides
  return {
    name,
    namespace: 'mcp-host',
    generation: 1,
    spec: {
      host: name,
      contextRef: 'ctx',
      secretRef: 'host-secret',
      ...spec,
    },
    ...rest,
  }
}

/** base64 helper matching how a K8s Secret stores data values. */
function b64(v: string): string {
  return Buffer.from(v, 'utf8').toString('base64')
}

function conflict(): Error {
  return Object.assign(new Error('conflict'), { code: 409 })
}

function notFound(): Error {
  return Object.assign(new Error('not found'), { code: 404 })
}

function deploymentCreates(appsApi: MockAppsApi): k8s.V1Deployment[] {
  return appsApi.createNamespacedDeployment.mock.calls.map(
    c => (c[0] as { body: k8s.V1Deployment }).body
  )
}
function npCreates(
  networkingApi: MockNetworkingApi
): Array<{ namespace: string; body: k8s.V1NetworkPolicy }> {
  return networkingApi.createNamespacedNetworkPolicy.mock.calls.map(
    c => c[0] as { namespace: string; body: k8s.V1NetworkPolicy }
  )
}

describe('OpenAiEgressBrokerReconciler', () => {
  let appsApi: MockAppsApi
  let coreApi: MockCoreApi
  let networkingApi: MockNetworkingApi
  let customApi: MockCustomApi
  let hosts: Map<string, HostCRD>
  let reconciler: OpenAiEgressBrokerReconciler
  // Host-inventory authority the reconciler's fullReconcile fence reads. Default
  // authoritative; T11 flips it to exercise the empty-cache guard.
  let authoritative: boolean

  function build(): OpenAiEgressBrokerReconciler {
    return new OpenAiEgressBrokerReconciler({} as k8s.KubeConfig, hosts, {
      appsApi: asAppsApi(appsApi),
      coreApi: asCoreApi(coreApi),
      networkingApi: asNetworkingApi(networkingApi),
      customApi: asCustomApi(customApi),
      hostInventoryAuthoritative: () => authoritative,
    })
  }

  beforeEach(() => {
    vi.clearAllMocks()
    appsApi = createMockAppsApi()
    coreApi = createMockCoreApi()
    networkingApi = createMockNetworkingApi()
    customApi = createMockCustomApi()
    // Fresh Host reads return no conditions by default (so a first write happens).
    customApi.getNamespacedCustomObject.mockImplementation(({ name }: { name?: string } = {}) =>
      Promise.resolve({
        metadata: { name: name ?? 'h', namespace: 'mcp-host', uid: 'u', resourceVersion: '42' },
        spec: { host: name ?? 'h', contextRef: 'ctx', secretRef: 'host-secret' },
        status: {},
      })
    )
    hosts = new Map()
    authoritative = true
    reconciler = build()
  })

  /** The conditions[] value written by the last status patch, if any. */
  function lastWrittenConditions(): HostCondition[] | undefined {
    const calls = customApi.patchNamespacedCustomObjectStatus.mock.calls
    if (calls.length === 0) return undefined
    const body = (calls[calls.length - 1][0] as { body: Array<{ path: string; value: unknown }> })
      .body
    const op = body.find(o => o.path === '/status/conditions' || o.path === '/status')
    if (!op) return undefined
    return op.path === '/status'
      ? (op.value as { conditions?: HostCondition[] }).conditions
      : (op.value as HostCondition[])
  }
  function brokersCondition(): HostCondition | undefined {
    return lastWrittenConditions()?.find(c => c.type === OAI_EGRESS_BROKERS_CONDITION_TYPE)
  }

  it('T1: primary local endpoint provisions the full broker with deterministic names + HOST_LABEL', async () => {
    const host = makeHost({
      name: 'h1',
      spec: { model: { provider: 'openai-compatible', baseURL: LOCAL_URL } },
    })
    hosts.set(host.name, host)
    await reconciler.reconcileForHost(host)

    const expectedName = brokerNameFor('h1', 'primary')
    expect(expectedName).toMatch(/^oai-egress-[0-9a-f]{16}$/)

    const dep = deploymentCreates(appsApi)
    expect(dep).toHaveLength(1)
    expect(dep[0].metadata?.name).toBe(expectedName)
    expect(dep[0].metadata?.labels?.[HOST_LABEL]).toBe('h1')

    expect(coreApi.createNamespacedService).toHaveBeenCalledTimes(1)
    expect(coreApi.createNamespacedConfigMap).toHaveBeenCalledTimes(1)
    expect(coreApi.createNamespacedSecret).toHaveBeenCalledTimes(1)

    const nps = npCreates(networkingApi)
    expect(nps).toHaveLength(3)
    const byName = new Map(nps.map(n => [n.body.metadata?.name, n]))
    expect(byName.get(`${expectedName}-ingress`)?.namespace).toBe('llm-egress')
    expect(byName.get(`${expectedName}-egress`)?.namespace).toBe('llm-egress')
    expect(byName.get(`${expectedName}-src`)?.namespace).toBe('mcp-host')
  })

  it('T2: a local fallback slot gets its own broker with a distinct slot id', async () => {
    const host = makeHost({
      name: 'h2',
      spec: {
        llmPolicy: {
          fallbacks: [{ provider: 'openai-compatible', baseURL: 'http://10.0.0.5:11434/v1' }],
        },
      },
    })
    hosts.set(host.name, host)
    await reconciler.reconcileForHost(host)

    const dep = deploymentCreates(appsApi)
    expect(dep).toHaveLength(1)
    expect(dep[0].metadata?.name).toBe(brokerNameFor('h2', 'fallback-0'))
    // primary was not openai-compatible → no primary broker
    expect(dep[0].metadata?.name).not.toBe(brokerNameFor('h2', 'primary'))
  })

  it('T3: host with no openai-compatible slot provisions nothing and sweeps an orphan broker', async () => {
    const host = makeHost({ name: 'h3', spec: { model: { provider: 'openai' } } })
    hosts.set(host.name, host)
    // A leftover broker Deployment for this host from a prior config.
    const orphan = 'oai-egress-deadbeefdeadbeef'
    appsApi.listNamespacedDeployment.mockResolvedValue({
      items: [{ metadata: { name: orphan, labels: { [OAI_EGRESS_BROKER_LABEL]: orphan } } }],
    })

    await reconciler.reconcileForHost(host)

    expect(appsApi.createNamespacedDeployment).not.toHaveBeenCalled()
    expect(coreApi.createNamespacedService).not.toHaveBeenCalled()
    // Orphan swept (ownership-verified delete).
    expect(appsApi.deleteNamespacedDeployment).toHaveBeenCalledWith(
      expect.objectContaining({ name: orphan, namespace: 'llm-egress' })
    )
    expect(coreApi.deleteNamespacedSecret).toHaveBeenCalledWith(
      expect.objectContaining({ name: `${orphan}-key` })
    )
  })

  it('T3b: reconcileDelete tears down a broker discovered only via its mirror Secret (Deployment create had failed)', async () => {
    // Leak scenario: Secret + ConfigMap were created, the Deployment create
    // failed, then the Host was deleted. A Deployment-only teardown would miss
    // the broker and orphan its credential-bearing Secret. gcHostBrokers must
    // discover it by the mirror Secret too.
    const orphan = 'oai-egress-cafecafecafecafe'
    coreApi.listNamespacedSecret.mockResolvedValue({
      items: [
        { metadata: { name: `${orphan}-key`, labels: { [OAI_EGRESS_BROKER_LABEL]: orphan } } },
      ],
    })
    // No Deployment exists (its create failed) → the Deployment-only discovery
    // finds nothing.
    appsApi.readNamespacedDeployment.mockRejectedValue(notFound())

    await reconciler.reconcileDelete('h3b')

    // The orphaned mirror Secret is deleted (ownership-verified).
    expect(coreApi.deleteNamespacedSecret).toHaveBeenCalledWith(
      expect.objectContaining({ name: `${orphan}-key`, namespace: 'llm-egress' })
    )
    // The missing Deployment is not force-deleted (read 404 → skip).
    expect(appsApi.deleteNamespacedDeployment).not.toHaveBeenCalled()
  })

  it('T4: primary + fallback pointing at the SAME ip:port still get TWO brokers (no dedup)', async () => {
    const host = makeHost({
      name: 'h4',
      spec: {
        model: { provider: 'openai-compatible', baseURL: LOCAL_URL },
        llmPolicy: { fallbacks: [{ provider: 'openai-compatible', baseURL: LOCAL_URL }] },
      },
    })
    hosts.set(host.name, host)
    await reconciler.reconcileForHost(host)

    const names = deploymentCreates(appsApi).map(d => d.metadata?.name)
    expect(names).toHaveLength(2)
    expect(new Set(names).size).toBe(2)
    expect(names).toContain(brokerNameFor('h4', 'primary'))
    expect(names).toContain(brokerNameFor('h4', 'fallback-0'))
  })

  it('T5: key present → mirror Secret carries the value + credentials-revision; empty key → broker still created', async () => {
    // key present
    coreApi.readNamespacedSecret.mockResolvedValue({
      metadata: { resourceVersion: '1' },
      data: { 'openai-compatible-api-key': b64('sk-secret') },
    })
    const host = makeHost({
      name: 'h5',
      spec: { model: { provider: 'openai-compatible', baseURL: LOCAL_URL } },
    })
    hosts.set(host.name, host)
    await reconciler.reconcileForHost(host)

    const secretBody = (coreApi.createNamespacedSecret.mock.calls[0][0] as { body: k8s.V1Secret })
      .body
    expect(secretBody.data?.['openai-compatible-api-key']).toBe(b64('sk-secret'))
    // Deployment injects the key via secretKeyRef and stamps a credentials-revision.
    const dep = deploymentCreates(appsApi)[0]
    const env = dep.spec?.template?.spec?.containers?.[0].env?.[0]
    expect(env?.name).toBe('OPENAI_COMPATIBLE_API_KEY')
    expect(env?.valueFrom?.secretKeyRef?.name).toBe(`${brokerNameFor('h5', 'primary')}-key`)
    const rev = dep.spec?.template?.metadata?.annotations?.['clerum.io/credentials-revision']
    expect(rev).toBeTruthy()
    // The nginx config carries the conditional auth `map` (value-blind placeholder).
    const cm = (coreApi.createNamespacedConfigMap.mock.calls[0][0] as { body: k8s.V1ConfigMap })
      .body
    const conf = cm.data?.['default.conf.template'] ?? ''
    expect(conf).toContain('map "${OPENAI_COMPATIBLE_API_KEY}" $oai_auth_header')
    expect(conf).toContain('default "Bearer ${OPENAI_COMPATIBLE_API_KEY}"')
    // The secret value never appears in the ConfigMap (value-blind).
    expect(conf).not.toContain('sk-secret')

    // empty key → broker still created, mirror value empty
    vi.clearAllMocks()
    coreApi.readNamespacedSecret.mockResolvedValue({ metadata: { resourceVersion: '1' }, data: {} })
    const host2 = makeHost({
      name: 'h5b',
      spec: { model: { provider: 'openai-compatible', baseURL: LOCAL_URL } },
    })
    hosts.set(host2.name, host2)
    await reconciler.reconcileForHost(host2)
    expect(appsApi.createNamespacedDeployment).toHaveBeenCalledTimes(1)
    const emptySecret = (coreApi.createNamespacedSecret.mock.calls[0][0] as { body: k8s.V1Secret })
      .body
    expect(emptySecret.data?.['openai-compatible-api-key']).toBe('')
  })

  it('T6: rotating the credential moves the credentials-revision annotation', async () => {
    coreApi.readNamespacedSecret.mockResolvedValue({
      metadata: { resourceVersion: '1' },
      data: { 'openai-compatible-api-key': b64('v1') },
    })
    const host = makeHost({
      name: 'h6',
      spec: { model: { provider: 'openai-compatible', baseURL: LOCAL_URL } },
    })
    hosts.set(host.name, host)
    await reconciler.reconcileForHost(host)
    const rev1 =
      deploymentCreates(appsApi)[0].spec?.template?.metadata?.annotations?.[
        'clerum.io/credentials-revision'
      ]

    vi.clearAllMocks()
    coreApi.readNamespacedSecret.mockResolvedValue({
      metadata: { resourceVersion: '2' },
      data: { 'openai-compatible-api-key': b64('v2-rotated') },
    })
    await reconciler.reconcileForHost(host)
    const rev2 =
      deploymentCreates(appsApi)[0].spec?.template?.metadata?.annotations?.[
        'clerum.io/credentials-revision'
      ]

    expect(rev1).toBeTruthy()
    expect(rev2).toBeTruthy()
    expect(rev1).not.toBe(rev2)
  })

  it('T7: fail-closed — a baseURL that does not pass classifyLanBaseURL provisions nothing', async () => {
    // public IP (not RFC1918) and a DNS hostname both must be rejected.
    for (const bad of ['http://8.8.8.8/v1', 'http://example.com/v1', 'http://169.254.1.1/v1']) {
      vi.clearAllMocks()
      const host = makeHost({
        name: `bad-${bad}`,
        spec: { model: { provider: 'openai-compatible', baseURL: bad } },
      })
      hosts.clear()
      hosts.set(host.name, host)
      await reconciler.reconcileForHost(host)
      expect(appsApi.createNamespacedDeployment).not.toHaveBeenCalled()
      expect(networkingApi.createNamespacedNetworkPolicy).not.toHaveBeenCalled()
    }
  })

  it('T7b: fail-closed — a path carrying an nginx metachar ($) provisions nothing', async () => {
    // Passes classifyLanBaseURL (host IP is RFC1918) but the path would inject an
    // nginx runtime variable into proxy_pass; must be rejected fail-closed.
    const host = makeHost({
      name: 'h7b',
      spec: {
        model: {
          provider: 'openai-compatible',
          baseURL: 'http://192.168.1.50:8000/v1$request_uri',
        },
      },
    })
    hosts.set(host.name, host)
    await reconciler.reconcileForHost(host)
    expect(appsApi.createNamespacedDeployment).not.toHaveBeenCalled()
    expect(networkingApi.createNamespacedNetworkPolicy).not.toHaveBeenCalled()
  })

  it('T7c: fail-closed — a cluster-internal RFC1918 target (apiserver ClusterIP) provisions nothing', async () => {
    const host = makeHost({
      name: 'h7c',
      spec: { model: { provider: 'openai-compatible', baseURL: 'http://10.96.0.1:6443/v1' } },
    })
    hosts.set(host.name, host)
    await reconciler.reconcileForHost(host)
    expect(appsApi.createNamespacedDeployment).not.toHaveBeenCalled()
    expect(networkingApi.createNamespacedNetworkPolicy).not.toHaveBeenCalled()
  })

  it('T8: broker→LAN NetworkPolicy pins an exact /32 on the dial port with NO DNS egress', async () => {
    const host = makeHost({
      name: 'h8',
      spec: { model: { provider: 'openai-compatible', baseURL: LOCAL_URL } },
    })
    hosts.set(host.name, host)
    await reconciler.reconcileForHost(host)

    const egressNp = npCreates(networkingApi).find(
      n => n.body.metadata?.name === `${brokerNameFor('h8', 'primary')}-egress`
    )!.body
    expect(egressNp.spec?.policyTypes).toEqual(['Egress'])
    expect(egressNp.spec?.egress).toHaveLength(1)
    const rule = egressNp.spec!.egress![0]
    expect(rule.to).toEqual([{ ipBlock: { cidr: '192.168.1.50/32' } }])
    expect(rule.ports).toEqual([{ port: 8000, protocol: 'TCP' }])
    // No DNS: nothing selects kube-system, no UDP/53.
    const json = JSON.stringify(egressNp)
    expect(json).not.toContain('kube-system')
    expect(json).not.toContain('"port":53')
  })

  it('T9: broker Deployment is hardened (runAsNonRoot, drop ALL, seccomp, no SA token)', async () => {
    const host = makeHost({
      name: 'h9',
      spec: { model: { provider: 'openai-compatible', baseURL: LOCAL_URL } },
    })
    hosts.set(host.name, host)
    await reconciler.reconcileForHost(host)

    const pod = deploymentCreates(appsApi)[0].spec!.template!.spec!
    expect(pod.automountServiceAccountToken).toBe(false)
    expect(pod.enableServiceLinks).toBe(false)
    const c = pod.containers[0]
    expect(c.securityContext?.runAsNonRoot).toBe(true)
    expect(c.securityContext?.runAsUser).toBe(101)
    expect(c.securityContext?.allowPrivilegeEscalation).toBe(false)
    expect(c.securityContext?.capabilities?.drop).toEqual(['ALL'])
    expect(c.securityContext?.seccompProfile?.type).toBe('RuntimeDefault')
  })

  it('hostDeclaresOpenAiCompatible gates the fan-out (primary, fallback, none, undefined)', () => {
    expect(hostDeclaresOpenAiCompatible(undefined)).toBe(false)
    expect(
      hostDeclaresOpenAiCompatible(makeHost({ name: 'a', spec: { model: { provider: 'openai' } } }))
    ).toBe(false)
    expect(
      hostDeclaresOpenAiCompatible(
        makeHost({ name: 'b', spec: { model: { provider: 'openai-compatible' } } })
      )
    ).toBe(true)
    expect(
      hostDeclaresOpenAiCompatible(
        makeHost({
          name: 'c',
          spec: { llmPolicy: { fallbacks: [{ provider: 'openai-compatible' }] } },
        })
      )
    ).toBe(true)
  })

  it('T10: no-op gate — re-reconcile against an already-current mirror Secret does not rewrite it', async () => {
    // Simulate the Secret already existing with the SAME value: create → 409,
    // read → matching data ⇒ replace skipped by isUpToDate.
    coreApi.readNamespacedSecret.mockImplementation(({ name }: { name?: string } = {}) => {
      if (name === 'host-secret') {
        return Promise.resolve({
          metadata: { resourceVersion: '1' },
          data: { 'openai-compatible-api-key': b64('same') },
        })
      }
      // The mirror Secret read returns the same value already stored.
      return Promise.resolve({
        metadata: {
          resourceVersion: '9',
          labels: { [MANAGED_BY_LABEL]: 'host-context-controller' },
        },
        data: { 'openai-compatible-api-key': b64('same') },
      })
    })
    coreApi.createNamespacedSecret.mockRejectedValue(conflict())

    const host = makeHost({
      name: 'h10',
      spec: { model: { provider: 'openai-compatible', baseURL: LOCAL_URL } },
    })
    hosts.set(host.name, host)
    await reconciler.reconcileForHost(host)

    expect(coreApi.replaceNamespacedSecret).not.toHaveBeenCalled()
  })

  // Two live brokers exist in the cluster, but the Host cache is empty (a
  // cold-start LIST failed or a watch is recovering). Wiring the sweep listings
  // so the fullReconcile orphan pass, if it ran, would delete both.
  function seedTwoLiveBrokers(): string[] {
    const brokers = ['oai-egress-1111111111111111', 'oai-egress-2222222222222222']
    appsApi.listNamespacedDeployment.mockResolvedValue({
      items: brokers.map(b => ({
        metadata: { name: b, labels: { [OAI_EGRESS_BROKER_LABEL]: b } },
      })),
    })
    coreApi.listNamespacedSecret.mockResolvedValue({
      items: brokers.map(b => ({
        metadata: { name: `${b}-key`, labels: { [OAI_EGRESS_BROKER_LABEL]: b } },
      })),
    })
    networkingApi.listNamespacedNetworkPolicy.mockResolvedValue({
      items: brokers.map(b => ({
        metadata: { name: `${b}-src`, labels: { [OAI_EGRESS_BROKER_LABEL]: b } },
      })),
    })
    return brokers
  }

  it('T11: fullReconcile with a non-authoritative Host inventory deletes NOTHING (no cache-wipe sweep)', async () => {
    seedTwoLiveBrokers()
    hosts.clear() // empty cache — the sweep would compute an empty desired set
    authoritative = false

    await reconciler.fullReconcile([])

    // Observable: the live brokers survive — not one delete is issued.
    expect(appsApi.deleteNamespacedDeployment).toHaveBeenCalledTimes(0)
    expect(coreApi.deleteNamespacedService).toHaveBeenCalledTimes(0)
    expect(coreApi.deleteNamespacedConfigMap).toHaveBeenCalledTimes(0)
    expect(coreApi.deleteNamespacedSecret).toHaveBeenCalledTimes(0)
    expect(networkingApi.deleteNamespacedNetworkPolicy).toHaveBeenCalledTimes(0)
  })

  it('T11b: positive control — an AUTHORITATIVE fullReconcile still sweeps brokers no Host desires', async () => {
    const brokers = seedTwoLiveBrokers()
    // ConfigMap read must report HCC ownership for the ownership-verified delete.
    coreApi.readNamespacedConfigMap.mockResolvedValue({
      metadata: { resourceVersion: '1', labels: { [MANAGED_BY_LABEL]: 'host-context-controller' } },
      data: {},
    })
    hosts.clear()
    authoritative = true

    await reconciler.fullReconcile([])

    // Both orphans are torn down (one delete per broker for each kind).
    expect(appsApi.deleteNamespacedDeployment).toHaveBeenCalledTimes(brokers.length)
    expect(coreApi.deleteNamespacedSecret).toHaveBeenCalledTimes(brokers.length)
    expect(coreApi.deleteNamespacedConfigMap).toHaveBeenCalledTimes(brokers.length)
    // src (host ns) + ingress + egress (egress ns) = 3 NetworkPolicies per broker.
    expect(networkingApi.deleteNamespacedNetworkPolicy).toHaveBeenCalledTimes(brokers.length * 3)
  })

  it('T12: a dropped slot writes a False OpenAiEgressBrokersReady condition to Host status', async () => {
    const host = makeHost({
      name: 'h12',
      // 10.96.0.1 is inside the mocked clusterInternalEgressCidrs (10.96.0.0/12).
      spec: { model: { provider: 'openai-compatible', baseURL: 'http://10.96.0.1:6443/v1' } },
    })
    hosts.set(host.name, host)
    await reconciler.reconcileForHost(host)

    // Observable: exactly one status patch reporting the drop.
    expect(customApi.patchNamespacedCustomObjectStatus).toHaveBeenCalledTimes(1)
    const cond = brokersCondition()
    expect(cond).toMatchObject({
      type: OAI_EGRESS_BROKERS_CONDITION_TYPE,
      status: 'False',
      reason: 'ClusterInternal',
    })
    expect(cond?.message).toContain('primary')
  })

  it('T13: a fully provisioned slot writes a True AllSlotsProvisioned condition', async () => {
    const host = makeHost({
      name: 'h13',
      spec: { model: { provider: 'openai-compatible', baseURL: LOCAL_URL } },
    })
    hosts.set(host.name, host)
    await reconciler.reconcileForHost(host)

    expect(customApi.patchNamespacedCustomObjectStatus).toHaveBeenCalledTimes(1)
    expect(brokersCondition()).toMatchObject({
      type: OAI_EGRESS_BROKERS_CONDITION_TYPE,
      status: 'True',
      reason: 'AllSlotsProvisioned',
    })
  })

  it('T15: a fallback credentialSlot not owned by openai-compatible is dropped WITHOUT reading the foreign key (R4-H2)', async () => {
    // Host Secret carries both a foreign key (claude-api-key) and the canonical
    // openai-compatible key. A fallback that names claude-api-key would have HCC
    // mirror that foreign key to the admin-chosen LAN IP.
    coreApi.readNamespacedSecret.mockResolvedValue({
      metadata: { resourceVersion: '1' },
      data: { 'claude-api-key': b64('sk-claude'), 'openai-compatible-api-key': b64('sk-oai') },
    })
    const host = makeHost({
      name: 'h15',
      spec: {
        llmPolicy: {
          fallbacks: [
            {
              provider: 'openai-compatible',
              model: 'm',
              baseURL: LOCAL_URL,
              credentialSlot: 'claude-api-key',
            },
          ],
        },
      },
    })
    hosts.set(host.name, host)
    await reconciler.reconcileForHost(host)

    // No broker materialized: the foreign key is never read or mirrored.
    expect(appsApi.createNamespacedDeployment).not.toHaveBeenCalled()
    expect(coreApi.createNamespacedSecret).not.toHaveBeenCalled()
    // HCC never reads the Host Secret for this dropped slot.
    expect(coreApi.readNamespacedSecret).not.toHaveBeenCalled()
    expect(brokersCondition()).toMatchObject({
      type: OAI_EGRESS_BROKERS_CONDITION_TYPE,
      status: 'False',
      reason: 'CredentialSlotNotOwned',
    })
    expect(brokersCondition()?.message).toContain('fallback-0: credential_slot_not_owned')
  })

  it('T15b: a fallback credentialSlot owned by openai-compatible (suffixed) mirrors that key', async () => {
    coreApi.readNamespacedSecret.mockResolvedValue({
      metadata: { resourceVersion: '1' },
      data: {
        'openai-compatible-api-key-fb1': b64('sk-fb1'),
        'openai-compatible-api-key': b64('sk-primary'),
      },
    })
    const host = makeHost({
      name: 'h15b',
      spec: {
        llmPolicy: {
          fallbacks: [
            {
              provider: 'openai-compatible',
              model: 'm',
              baseURL: LOCAL_URL,
              credentialSlot: 'openai-compatible-api-key-fb1',
            },
          ],
        },
      },
    })
    hosts.set(host.name, host)
    await reconciler.reconcileForHost(host)

    expect(appsApi.createNamespacedDeployment).toHaveBeenCalledTimes(1)
    const secretBody = (coreApi.createNamespacedSecret.mock.calls[0][0] as { body: k8s.V1Secret })
      .body
    // The mirror carries the fb1 key's value under the canonical mirror key.
    expect(secretBody.data?.['openai-compatible-api-key']).toBe(b64('sk-fb1'))
  })

  it('T17: an empty baseURL on a declared openai-compatible slot drops missing_base_url, not a silent success (R4-M3)', async () => {
    const host = makeHost({
      name: 'h17',
      spec: { model: { provider: 'openai-compatible', baseURL: '' } },
    })
    hosts.set(host.name, host)
    await reconciler.reconcileForHost(host)

    expect(appsApi.createNamespacedDeployment).not.toHaveBeenCalled()
    const cond = brokersCondition()
    expect(cond).toMatchObject({
      type: OAI_EGRESS_BROKERS_CONDITION_TYPE,
      status: 'False',
      reason: 'MissingBaseUrl',
    })
    expect(cond?.message).toContain('primary: missing_base_url')
  })

  it('T14: anti-oscillation — a second reconcile against the same status does not re-patch', async () => {
    // Fresh GET reflects the last written condition, so the dirty check on the
    // second reconcile sees an equivalent condition and skips the write.
    let currentConditions: HostCondition[] = []
    customApi.getNamespacedCustomObject.mockImplementation(({ name }: { name?: string } = {}) =>
      Promise.resolve({
        metadata: { name: name ?? 'h14', namespace: 'mcp-host', uid: 'u', resourceVersion: '1' },
        spec: { host: name ?? 'h14', contextRef: 'ctx', secretRef: 'host-secret' },
        status: { conditions: currentConditions },
      })
    )
    customApi.patchNamespacedCustomObjectStatus.mockImplementation(
      ({ body }: { body?: Array<{ path: string; value: unknown }> } = {}) => {
        const op = (body ?? []).find(o => o.path === '/status/conditions' || o.path === '/status')
        if (op) {
          currentConditions =
            op.path === '/status'
              ? ((op.value as { conditions?: HostCondition[] }).conditions ?? [])
              : (op.value as HostCondition[])
        }
        return Promise.resolve({})
      }
    )

    const host = makeHost({
      name: 'h14',
      spec: { model: { provider: 'openai-compatible', baseURL: LOCAL_URL } },
    })
    hosts.set(host.name, host)

    await reconciler.reconcileForHost(host)
    await reconciler.reconcileForHost(host)

    // Only the first reconcile writes; the second is a no-op (equivalent condition).
    expect(customApi.patchNamespacedCustomObjectStatus).toHaveBeenCalledTimes(1)
  })
})
