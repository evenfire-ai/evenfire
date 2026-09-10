// R1-M1 (PR #605): the cluster-internal CIDR guard is fail-closed. Without
// operator-declared cluster-internal ranges the LAN classifier cannot tell
// cluster space (apiserver/pod ClusterIPs) from a real private LAN, so a
// cluster-internal baseURL would be accepted and a broker provisioned with a
// /32 egress route into the cluster. HCC must refuse to provision until the
// guard is configured, always pin the apiserver ClusterIP via the zero-config
// floor, and expose an explicit opt-out.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import * as k8s from '@kubernetes/client-node'
import {
  type MockAppsApi,
  type MockCoreApi,
  type MockNetworkingApi,
  asAppsApi,
  asCoreApi,
  asNetworkingApi,
  createMockAppsApi,
  createMockCoreApi,
  createMockNetworkingApi,
} from '../test/__fixtures__/testMocks'
import { config } from './config'
import {
  OpenAiEgressBrokerReconciler,
  resolveClusterInternalCidrs,
} from './openaiEgressBrokerReconciler'
import { HostCRD, HostSpec } from './types'

vi.mock('./config', () => ({
  config: {
    devMode: false,
    hostNamespace: 'mcp-host',
    llmEgressNamespace: 'llm-egress',
    openaiEgressBrokerPort: 3000,
    egressProxyImage: 'clerum/nginx-egress-proxy:test',
    k8sApiCidrs: [],
    nodeLocalDnsCidr: '',
    clusterInternalEgressCidrs: [],
    oaiEgressRequireClusterCidrs: true,
  },
}))

function makeHost(name: string, baseURL: string): HostCRD {
  const spec: Partial<HostSpec> = {
    host: name,
    contextRef: 'ctx',
    secretRef: 'host-secret',
    model: { provider: 'openai-compatible', baseURL },
  }
  return { name, namespace: 'mcp-host', generation: 1, spec: spec as HostSpec }
}

describe('OpenAiEgressBrokerReconciler — cluster-internal CIDR guard (R1-M1)', () => {
  let appsApi: MockAppsApi
  let coreApi: MockCoreApi
  let networkingApi: MockNetworkingApi
  let hosts: Map<string, HostCRD>
  let reconciler: OpenAiEgressBrokerReconciler

  beforeEach(() => {
    vi.clearAllMocks()
    appsApi = createMockAppsApi()
    coreApi = createMockCoreApi()
    networkingApi = createMockNetworkingApi()
    hosts = new Map()
    // Reset the mocked config to the fail-closed default with no CIDRs.
    config.k8sApiCidrs = []
    config.nodeLocalDnsCidr = ''
    config.clusterInternalEgressCidrs = []
    config.oaiEgressRequireClusterCidrs = true
    reconciler = new OpenAiEgressBrokerReconciler({} as k8s.KubeConfig, hosts, {
      appsApi: asAppsApi(appsApi),
      coreApi: asCoreApi(coreApi),
      networkingApi: asNetworkingApi(networkingApi),
      hostInventoryAuthoritative: () => true,
    })
  })

  afterEach(() => {
    vi.unstubAllEnvs()
  })

  function provisioned(): boolean {
    return appsApi.createNamespacedDeployment.mock.calls.length > 0
  }
  function npCreated(): boolean {
    return networkingApi.createNamespacedNetworkPolicy.mock.calls.length > 0
  }

  it('G1: cluster-internal baseURL with the guard unconfigured provisions NOTHING (fail-closed)', async () => {
    const host = makeHost('g1', 'http://10.96.0.1:6443/v1')
    hosts.set(host.name, host)
    await reconciler.reconcileForHost(host)
    // Observable: no broker Deployment and no NetworkPolicy is created.
    expect(provisioned()).toBe(false)
    expect(npCreated()).toBe(false)
  })

  it('G2: even a clean private-LAN baseURL provisions NOTHING while the guard is unconfigured', async () => {
    const host = makeHost('g2', 'http://192.168.1.50:8000/v1')
    hosts.set(host.name, host)
    await reconciler.reconcileForHost(host)
    expect(provisioned()).toBe(false)
    expect(npCreated()).toBe(false)
  })

  it('G3: with the guard configured, the zero-config floor still rejects the apiserver ClusterIP', async () => {
    config.clusterInternalEgressCidrs = ['10.244.0.0/16'] // pod CIDR only; no apiserver range
    vi.stubEnv('KUBERNETES_SERVICE_HOST', '10.96.0.1')

    // apiserver ClusterIP — covered only by the floor, not by the declared CIDR.
    const internal = makeHost('g3', 'http://10.96.0.1:6443/v1')
    hosts.set(internal.name, internal)
    await reconciler.reconcileForHost(internal)
    expect(provisioned()).toBe(false)
    expect(npCreated()).toBe(false)

    // Positive control: a genuine private-LAN endpoint provisions.
    const lan = makeHost('g3-lan', 'http://192.168.1.50:8000/v1')
    hosts.set(lan.name, lan)
    await reconciler.reconcileForHost(lan)
    expect(provisioned()).toBe(true)
  })

  it('G4: the opt-out (REQUIRE_CLUSTER_CIDRS=false) lets a clean LAN provision with no CIDRs', async () => {
    config.oaiEgressRequireClusterCidrs = false
    const host = makeHost('g4', 'http://192.168.1.50:8000/v1')
    hosts.set(host.name, host)
    await reconciler.reconcileForHost(host)
    expect(provisioned()).toBe(true)
  })

  describe('resolveClusterInternalCidrs (pure)', () => {
    it('unions every configured source and marks the guard configured', () => {
      config.k8sApiCidrs = ['10.96.0.0/12']
      config.nodeLocalDnsCidr = '169.254.20.10/32'
      config.clusterInternalEgressCidrs = ['10.244.0.0/16']
      vi.stubEnv('KUBERNETES_SERVICE_HOST', '10.96.0.1')
      const { cidrs, guardConfigured } = resolveClusterInternalCidrs()
      expect(cidrs).toEqual(['10.96.0.0/12', '169.254.20.10/32', '10.244.0.0/16', '10.96.0.1/32'])
      expect(guardConfigured).toBe(true)
    })

    it('adds only the floor when nothing is configured, and reports guard unconfigured', () => {
      vi.stubEnv('KUBERNETES_SERVICE_HOST', '10.96.0.1')
      const { cidrs, guardConfigured } = resolveClusterInternalCidrs()
      expect(cidrs).toEqual(['10.96.0.1/32'])
      expect(guardConfigured).toBe(false)
    })

    it('emits no floor entry for a non-IPv4 KUBERNETES_SERVICE_HOST', () => {
      vi.stubEnv('KUBERNETES_SERVICE_HOST', 'fd00::1')
      const { cidrs } = resolveClusterInternalCidrs()
      expect(cidrs).toEqual([])
    })
  })
})
