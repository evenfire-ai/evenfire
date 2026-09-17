import { beforeEach, describe, expect, it, vi } from 'vitest'
import * as k8s from '@kubernetes/client-node'
import { readFileSync } from 'node:fs'
import path from 'node:path'
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
import { HostCRD, HostLlmPolicyFallback } from './types'

// Uses the REAL @clerum/egress-policy (no mock): this pins HCC's actual broker
// naming against the cross-service contract vectors. A slotId- or hash-scheme
// change in the shared package turns this red — same as the mcp-host and package
// tests reading the SAME vectors.
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

type BrokerNameVector = {
  label: string
  hostName: string
  slot: { kind: 'primary' } | { kind: 'fallback'; index: number }
  slotId: string
  brokerName: string
}

const { vectors } = JSON.parse(
  readFileSync(
    path.join(__dirname, '../../tests/contracts/oai-egress-broker-name-vectors.json'),
    'utf8'
  )
) as { vectors: BrokerNameVector[] }

const LAN_URL = 'http://192.168.1.50:8000/v1'

function hostForVector(vector: BrokerNameVector): HostCRD {
  const spec: HostCRD['spec'] = {
    host: vector.hostName,
    contextRef: 'ctx',
    secretRef: 'host-secret',
  }
  if (vector.slot.kind === 'primary') {
    spec.model = { provider: 'openai-compatible', baseURL: LAN_URL }
  } else {
    // Pin the RAW fallback index: pad with non-local entries so the
    // openai-compatible slot lands at exactly `slot.index`.
    const fallbacks: HostLlmPolicyFallback[] = []
    for (let i = 0; i < vector.slot.index; i++) fallbacks.push({ provider: 'openai', model: 'm' })
    fallbacks.push({ provider: 'openai-compatible', model: 'm', baseURL: LAN_URL })
    spec.llmPolicy = { fallbacks }
  }
  return { name: vector.hostName, namespace: 'mcp-host', generation: 1, spec }
}

describe('OpenAiEgressBrokerReconciler — broker names match the cross-service vectors', () => {
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

  it.each(vectors)('provisions the broker named per the contract: $label', async vector => {
    const host = hostForVector(vector)
    hosts.set(host.name, host)
    await reconciler.reconcileForHost(host)

    const created = appsApi.createNamespacedDeployment.mock.calls.map(
      c => (c[0] as { body: k8s.V1Deployment }).body.metadata?.name
    )
    expect(created).toEqual([vector.brokerName])
  })
})
