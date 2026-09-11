import { beforeEach, describe, expect, it, vi } from 'vitest'
import * as k8s from '@kubernetes/client-node'
import { brokerNameFor } from '@clerum/egress-policy'
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
import { OpenAiEgressBrokerReconciler } from './openaiEgressBrokerReconciler'
import { HostCRD, HostSpec } from './types'

// Substitute ONLY the slot-id vocabulary of the shared package with sentinel
// values, keeping brokerNameFor (the drift-critical hash) real. If HCC ever
// reintroduces the literals `'primary'` / `` `fallback-${i}` `` instead of the
// shared constants, the broker names it derives are hashed from those literals
// and diverge from brokerNameFor(host, PRIMARY_SLOT_ID/fallbackSlotId(i)) — the
// name mcp-host reconstructs — so the assertions below fail. This is the drift
// R3-M1 warned about, caught at the (host, slot) → broker-name seam.
vi.mock('@clerum/egress-policy', async () => {
  const actual =
    await vi.importActual<typeof import('@clerum/egress-policy')>('@clerum/egress-policy')
  return {
    ...actual,
    PRIMARY_SLOT_ID: 'p0',
    fallbackSlotId: (index: number) => `fb${index}`,
  }
})

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
    // kube default Service range — a broker must never be pointed at it. Present
    // so the CIDR guard is CONFIGURED; otherwise validateSlot fails closed and no
    // broker is created (the assertions would then never run).
    clusterInternalEgressCidrs: ['10.96.0.0/12'],
    oaiEgressRequireClusterCidrs: true,
  },
}))

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

function deploymentCreates(appsApi: MockAppsApi): k8s.V1Deployment[] {
  return appsApi.createNamespacedDeployment.mock.calls.map(
    c => (c[0] as { body: k8s.V1Deployment }).body
  )
}

describe('OpenAiEgressBrokerReconciler — slot ids come from @clerum/egress-policy', () => {
  let appsApi: MockAppsApi
  let coreApi: MockCoreApi
  let networkingApi: MockNetworkingApi
  let customApi: MockCustomApi
  let hosts: Map<string, HostCRD>
  let reconciler: OpenAiEgressBrokerReconciler

  beforeEach(() => {
    vi.clearAllMocks()
    appsApi = createMockAppsApi()
    coreApi = createMockCoreApi()
    networkingApi = createMockNetworkingApi()
    customApi = createMockCustomApi()
    customApi.getNamespacedCustomObject.mockImplementation(({ name }: { name?: string } = {}) =>
      Promise.resolve({
        metadata: { name: name ?? 'h', namespace: 'mcp-host', uid: 'u', resourceVersion: '42' },
        spec: { host: name ?? 'h', contextRef: 'ctx', secretRef: 'host-secret' },
        status: {},
      })
    )
    hosts = new Map()
    reconciler = new OpenAiEgressBrokerReconciler({} as k8s.KubeConfig, hosts, {
      appsApi: asAppsApi(appsApi),
      coreApi: asCoreApi(coreApi),
      networkingApi: asNetworkingApi(networkingApi),
      customApi: asCustomApi(customApi),
      hostInventoryAuthoritative: () => true,
    })
  })

  it('derives both the primary and the raw-index fallback broker names via the shared constants', async () => {
    const host = makeHost({
      name: 'h',
      spec: {
        model: { provider: 'openai-compatible', baseURL: 'http://192.168.1.50:8000/v1' },
        llmPolicy: {
          fallbacks: [
            // index 0: not openai-compatible → no broker; keeps the local slot at raw index 1.
            { provider: 'openai', model: 'm' },
            { provider: 'openai-compatible', model: 'm', baseURL: 'http://192.168.1.51:8000/v1' },
          ],
        },
      },
    })
    hosts.set(host.name, host)
    await reconciler.reconcileForHost(host)

    const names = deploymentCreates(appsApi).map(d => d.metadata?.name)
    expect(names).toHaveLength(2)

    // Broker names are hashed from the SENTINEL slot ids the shared package now
    // exports, not from the old inline literals.
    expect(names).toContain(brokerNameFor('h', 'p0'))
    expect(names).toContain(brokerNameFor('h', 'fb1'))

    // The literals a hand-rolled reimplementation would have produced must NOT
    // appear — that is exactly the drift this test guards.
    expect(names).not.toContain(brokerNameFor('h', 'primary'))
    expect(names).not.toContain(brokerNameFor('h', 'fallback-1'))
  })
})
