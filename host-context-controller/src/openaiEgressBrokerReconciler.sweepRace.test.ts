import { beforeEach, describe, expect, it, vi } from 'vitest'
import * as k8s from '@kubernetes/client-node'
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
import { HOST_LABEL, MANAGED_BY_LABEL } from './constants'
import { OpenAiEgressBrokerReconciler, brokerNameFor } from './openaiEgressBrokerReconciler'
import { HostCRD, HostSpec } from './types'

// Same config the main reconciler suite mocks: a LAN URL (192.168.1.x) that is
// admitted by the deny-set so a broker is actually derived.
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
    clusterInternalEgressCidrs: ['10.96.0.0/12'],
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

describe('OpenAiEgressBrokerReconciler — orphan sweep TOCTOU (R5-M1)', () => {
  let appsApi: MockAppsApi
  let coreApi: MockCoreApi
  let networkingApi: MockNetworkingApi
  let customApi: MockCustomApi
  let hosts: Map<string, HostCRD>
  let reconciler: OpenAiEgressBrokerReconciler
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

  /** Bodies of every broker Deployment the reconciler has created so far. */
  function createdDeployments(): k8s.V1Deployment[] {
    return appsApi.createNamespacedDeployment.mock.calls.map(
      c => (c[0] as { body: k8s.V1Deployment }).body
    )
  }

  it("S1: a Host created while the sweep's LISTs are in flight keeps its broker", async () => {
    // 1. Provision a real orphan broker (fixture derived from the reconciler, not
    //    hand-authored), then drop the Host from the cache to model a missed delete
    //    event — this is the true positive the sweep MUST still delete.
    const orphanHost = makeHost({
      name: 'h-old',
      spec: { model: { provider: 'openai-compatible', baseURL: LOCAL_URL } },
    })
    hosts.set('h-old', orphanHost)
    await reconciler.reconcileForHost(orphanHost)
    const orphanName = brokerNameFor('h-old', 'primary')
    hosts.delete('h-old')

    const newHost = makeHost({
      name: 'h-new',
      spec: { model: { provider: 'openai-compatible', baseURL: LOCAL_URL } },
    })
    const newName = brokerNameFor('h-new', 'primary')

    // 2. The sweep snapshots `desired` from the cache, THEN issues its LISTs. Model
    //    the race precisely at the cluster-wide Deployment LIST: while it is in
    //    flight, h-new is created and reconciled (its broker body captured from the
    //    reconciler — a real fixture, T1), and the LIST then returns every broker
    //    Deployment that exists, h-new's included. Host-scoped LISTs (gcHostBrokers)
    //    return only that host's deployments.
    appsApi.listNamespacedDeployment.mockImplementation(
      async ({ labelSelector }: { labelSelector?: string } = {}) => {
        if (labelSelector?.includes(HOST_LABEL)) {
          const host = labelSelector.match(new RegExp(`${HOST_LABEL}=([^,]+)`))?.[1]
          return {
            items: createdDeployments().filter(d => d.metadata?.labels?.[HOST_LABEL] === host),
          }
        }
        if (!hosts.has('h-new')) {
          hosts.set('h-new', newHost)
          await reconciler.reconcileForHost(newHost)
        }
        return { items: createdDeployments() }
      }
    )

    // The ownership-verified ConfigMap delete of the true orphan needs its read to
    // report HCC ownership (default ConfigMap read carries no managed-by label).
    coreApi.readNamespacedConfigMap.mockResolvedValue({
      metadata: {
        resourceVersion: '1',
        labels: { [MANAGED_BY_LABEL]: 'host-context-controller' },
      },
      data: {},
    })

    // 3. Sweep with an EMPTY cache snapshot (h-old already deleted, h-new not in yet).
    await reconciler.fullReconcile([...hosts.values()])

    // Observable at the apiserver boundary: NONE of h-new's objects are deleted.
    expect(appsApi.deleteNamespacedDeployment).not.toHaveBeenCalledWith(
      expect.objectContaining({ name: newName })
    )
    expect(coreApi.deleteNamespacedService).not.toHaveBeenCalledWith(
      expect.objectContaining({ name: newName })
    )
    expect(coreApi.deleteNamespacedConfigMap).not.toHaveBeenCalledWith(
      expect.objectContaining({ name: `${newName}-nginx-conf` })
    )
    expect(coreApi.deleteNamespacedSecret).not.toHaveBeenCalledWith(
      expect.objectContaining({ name: `${newName}-key` })
    )
    for (const suffix of ['ingress', 'egress', 'src']) {
      expect(networkingApi.deleteNamespacedNetworkPolicy).not.toHaveBeenCalledWith(
        expect.objectContaining({ name: `${newName}-${suffix}` })
      )
    }

    // Positive control: the sweep still works — the real orphan IS torn down.
    expect(appsApi.deleteNamespacedDeployment).toHaveBeenCalledWith(
      expect.objectContaining({ name: orphanName })
    )
  })
})
