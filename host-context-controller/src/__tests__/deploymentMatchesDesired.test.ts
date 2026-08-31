import { describe, expect, it, vi } from 'vitest'
import * as k8s from '@kubernetes/client-node'
import {
  asAppsApi,
  asCoreApi,
  asNetworkingApi,
  asRbacApi,
  createMockAppsApi,
  createMockCoreApi,
  createMockNetworkingApi,
  createMockRbacApi,
} from '../../test/__fixtures__/testMocks'
import { HostReconciler } from '../hostReconciler'
import type { HostCRD } from '../types'
import { deploymentMatchesDesired, preserveDeploymentAnnotations } from '../utils'
import { asApiserverDeployment } from './asApiserverDeployment'
import { cloneAndMutateLeaf, collectLeafPaths, formatLeafPath } from './mutateJsonLeaves'

vi.mock('../config', () => ({
  config: {
    hostNamespace: 'mcp-host',
    hostWorkspaceStorageClassName: 'standard',
    hostWorkspaceStorageSize: '1Gi',
    hostWorkspacePath: '/workspace',
    hostImage: 'clerum/mcp-host:test',
    desktopImage: 'clerum/mcp-host-desktop:test',
    hostImagePullPolicy: 'IfNotPresent',
    hostImagePullSecretName: '',
    hostPort: 8080,
    hostConfigMapName: 'mcp-host-config',
    hostServiceAccountName: 'mcp-host',
    gfsNamespace: 'gfs',
    gfscPort: 8087,
    desktopPort: 3000,
    rpcProxyNamespace: 'rpc-proxy',
    channelsNamespace: 'channels',
    channelReaderImage: 'clerum/channel-reader:test',
    channelReaderImagePullPolicy: 'IfNotPresent',
    channelReaderHandoffPort: 8091,
    hostK8sRequestTimeoutMs: 30_000,
    hostFullReconcileConcurrency: 2,
    mcpHostGatewayUrl: 'http://mcp-host-gateway',
    hostResources: {
      requests: { memory: '128Mi', cpu: '50m' },
      limits: { memory: '256Mi', cpu: '200m' },
    },
    desktopResources: {
      requests: { memory: '256Mi', cpu: '100m' },
      limits: { memory: '512Mi', cpu: '500m' },
    },
  },
}))

function sparseDeployment(): k8s.V1Deployment {
  return {
    apiVersion: 'apps/v1',
    kind: 'Deployment',
    metadata: { name: 'sparse', namespace: 'ns' },
    spec: {
      selector: { matchLabels: { app: 'sparse' } },
      template: {
        metadata: { labels: { app: 'sparse' } },
        spec: {
          containers: [{ name: 'c', image: 'img:1', ports: [{ containerPort: 80 }] }],
        },
      },
    },
  }
}

function makeHost(name = 'alpha-host'): HostCRD {
  return {
    name,
    namespace: 'mcp-host',
    uid: 'uid-alpha-host',
    spec: {
      host: name,
      contextRef: 'ctx1',
      secretRef: 'llm-secret',
    },
  }
}

function createReconciler(): HostReconciler {
  return new HostReconciler({} as k8s.KubeConfig, {
    appsApi: asAppsApi(createMockAppsApi()),
    coreApi: asCoreApi(createMockCoreApi()),
    networkingApi: asNetworkingApi(createMockNetworkingApi()),
    rbacApi: asRbacApi(createMockRbacApi()),
    countCommunicationChannels: () => 1,
    isCommunicationChannelCacheSynced: () => true,
  })
}

/** Mirror replaceWithConflictRetry: merge after stamping the live resourceVersion. */
function mergedForCompare(desired: k8s.V1Deployment, existing: k8s.V1Deployment): k8s.V1Deployment {
  return preserveDeploymentAnnotations(
    {
      ...desired,
      metadata: { ...desired.metadata, resourceVersion: existing.metadata?.resourceVersion },
    },
    existing
  )
}

function expectSweepDetectsEveryLeaf(desired: k8s.V1Deployment, existing: k8s.V1Deployment): void {
  const undetectable: string[] = []
  for (const path of collectLeafPaths(desired)) {
    const mutated = cloneAndMutateLeaf(desired, path) as k8s.V1Deployment
    if (deploymentMatchesDesired(mergedForCompare(mutated, existing), existing)) {
      undetectable.push(formatLeafPath(path))
    }
  }
  expect(undetectable, `undetectable leaf path(s): ${undetectable.join(', ')}`).toEqual([])
}

describe('asApiserverDeployment', () => {
  it('FIXTURE-1: default-fills a sparse Deployment so it differs structurally', () => {
    const desired = sparseDeployment()
    expect(asApiserverDeployment(desired)).not.toEqual(desired)
  })

  it('FIXTURE-1: Host builder output differs from the default-filled live object', () => {
    const desired = createReconciler().buildDeployment(makeHost())
    expect(asApiserverDeployment(desired)).not.toEqual(desired)
  })

  it('FIXTURE-1: channel-reader builder output differs from the default-filled live object', () => {
    const desired = (createReconciler() as any).buildChannelReaderDeployment(
      makeHost(),
      'rev-abc'
    ) as k8s.V1Deployment
    expect(asApiserverDeployment(desired)).not.toEqual(desired)
  })
})

describe('deploymentMatchesDesired', () => {
  it('returns false when either spec is missing (fail-open-to-write)', () => {
    const desired = sparseDeployment()
    expect(deploymentMatchesDesired(undefined, desired)).toBe(false)
    expect(deploymentMatchesDesired(desired, undefined)).toBe(false)
    expect(deploymentMatchesDesired({ metadata: { name: 'x' } }, desired)).toBe(false)
    expect(deploymentMatchesDesired(desired, { metadata: { name: 'x' } })).toBe(false)
  })

  it('Host builder vs fixture is a no-op after merge', () => {
    const desired = createReconciler().buildDeployment(makeHost())
    const existing = asApiserverDeployment(desired)
    expect(deploymentMatchesDesired(mergedForCompare(desired, existing), existing)).toBe(true)
  })

  it('channel-reader builder vs fixture is a no-op after merge', () => {
    const desired = (createReconciler() as any).buildChannelReaderDeployment(
      makeHost(),
      'rev-abc'
    ) as k8s.V1Deployment
    const existing = asApiserverDeployment(desired)
    expect(deploymentMatchesDesired(mergedForCompare(desired, existing), existing)).toBe(true)
  })

  it('Host mutation sweep: every desired leaf is detectable', () => {
    const desired = createReconciler().buildDeployment(makeHost())
    expectSweepDetectsEveryLeaf(desired, asApiserverDeployment(desired))
  })

  it('channel-reader mutation sweep: every desired leaf is detectable', () => {
    const desired = (createReconciler() as any).buildChannelReaderDeployment(
      makeHost(),
      'rev-abc'
    ) as k8s.V1Deployment
    expectSweepDetectsEveryLeaf(desired, asApiserverDeployment(desired))
  })
})
