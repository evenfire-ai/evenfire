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
import {
  deploymentMatchesDesired,
  normalizeDeploymentForComparison,
  preserveDeploymentAnnotations,
} from '../utils'
import { asApiserverDeployment } from './asApiserverDeployment'
import {
  cloneAndMutateLeaf,
  collectLeafPaths,
  collectLiveOnlySpecLeaves,
  formatLeafPath,
} from './mutateJsonLeaves'

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

function expectSweepDetectsLiveOnlySpecLeaves(
  desired: k8s.V1Deployment,
  existing: k8s.V1Deployment
): void {
  const liveOnly = collectLiveOnlySpecLeaves(desired, existing)
  expect(liveOnly.length, 'fixture added no spec-only leaves').toBeGreaterThan(0)
  const undetectable: string[] = []
  for (const path of liveOnly) {
    const mutatedExisting = cloneAndMutateLeaf(existing, path) as k8s.V1Deployment
    if (deploymentMatchesDesired(mergedForCompare(desired, mutatedExisting), mutatedExisting)) {
      undetectable.push(formatLeafPath(path))
    }
  }
  expect(undetectable, `undetectable live-only spec path(s): ${undetectable.join(', ')}`).toEqual(
    []
  )
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

  it('FIXTURE-1: asApiserverDeployment does not mutate the caller desired object', () => {
    const desired = sparseDeployment()
    const before = structuredClone(desired)
    asApiserverDeployment(desired)
    expect(desired).toEqual(before)
  })

  it('FIXTURE-1: omitted Deployment spec fields come from the recorded blob', () => {
    const desired = sparseDeployment()
    const existing = asApiserverDeployment(desired)
    expect(existing.spec?.progressDeadlineSeconds).toBe(600)
    expect(existing.spec?.revisionHistoryLimit).toBe(10)
    expect(existing.spec?.template?.spec?.dnsPolicy).toBe('ClusterFirst')
    expect(existing.spec?.template?.spec?.restartPolicy).toBe('Always')
  })

  it('FIXTURE-1: fills omitted imagePullPolicy the way apps/v1 defaults it', () => {
    const containerOf = (desired: k8s.V1Deployment) =>
      asApiserverDeployment(desired).spec?.template?.spec?.containers?.[0]

    expect(containerOf(sparseDeployment())?.imagePullPolicy).toBe('IfNotPresent')

    const latest = sparseDeployment()
    latest.spec!.template.spec!.containers![0].image = 'img:latest'
    expect(containerOf(latest)?.imagePullPolicy).toBe('Always')

    const untagged = sparseDeployment()
    untagged.spec!.template.spec!.containers![0].image = 'img'
    expect(containerOf(untagged)?.imagePullPolicy).toBe('Always')

    const digested = sparseDeployment()
    digested.spec!.template.spec!.containers![0].image = 'img@sha256:aaaaaaaa'
    expect(containerOf(digested)?.imagePullPolicy).toBe('IfNotPresent')

    const authored = sparseDeployment()
    authored.spec!.template.spec!.containers![0].imagePullPolicy = 'Never'
    expect(containerOf(authored)?.imagePullPolicy).toBe('Never')
  })
})

type CanonicalPodSpec = {
  serviceAccountName?: string
  containers?: Array<{
    resources?: unknown
    livenessProbe?: { timeoutSeconds?: number; failureThreshold?: number }
  }>
}

function canonicalPodSpec(normalized: unknown): CanonicalPodSpec | undefined {
  return (normalized as { spec?: { template?: { spec?: CanonicalPodSpec } } }).spec?.template?.spec
}

function deploymentWithProbe(
  probe: Partial<k8s.V1Probe>,
  serviceAccountName?: string
): k8s.V1Deployment {
  return {
    apiVersion: 'apps/v1',
    kind: 'Deployment',
    metadata: { name: 'probe-guard', namespace: 'ns' },
    spec: {
      replicas: 1,
      selector: { matchLabels: { app: 'probe-guard' } },
      template: {
        metadata: { labels: { app: 'probe-guard' } },
        spec: {
          ...(serviceAccountName !== undefined ? { serviceAccountName } : {}),
          containers: [
            {
              name: 'c',
              image: 'img:1',
              imagePullPolicy: 'IfNotPresent',
              livenessProbe: {
                httpGet: { path: '/live', port: 80 },
                periodSeconds: 5,
                ...probe,
              },
            },
          ],
        },
      },
    },
  }
}

describe('safe-strip lemma equality guards', () => {
  it('strips timeoutSeconds === 1 and keeps a non-default 2', () => {
    const stripped = canonicalPodSpec(
      normalizeDeploymentForComparison(deploymentWithProbe({ timeoutSeconds: 1 }))
    )
    const kept = canonicalPodSpec(
      normalizeDeploymentForComparison(deploymentWithProbe({ timeoutSeconds: 2 }))
    )
    expect(stripped?.containers?.[0]?.livenessProbe?.timeoutSeconds).toBeUndefined()
    expect(kept?.containers?.[0]?.livenessProbe?.timeoutSeconds).toBe(2)
  })

  it('strips failureThreshold === 3 and keeps a non-default 6', () => {
    const stripped = canonicalPodSpec(
      normalizeDeploymentForComparison(deploymentWithProbe({ failureThreshold: 3 }))
    )
    const kept = canonicalPodSpec(
      normalizeDeploymentForComparison(deploymentWithProbe({ failureThreshold: 6 }))
    )
    expect(stripped?.containers?.[0]?.livenessProbe?.failureThreshold).toBeUndefined()
    expect(kept?.containers?.[0]?.livenessProbe?.failureThreshold).toBe(6)
  })

  it("strips serviceAccountName === 'default' and keeps a non-default name", () => {
    const stripped = canonicalPodSpec(
      normalizeDeploymentForComparison(deploymentWithProbe({}, 'default'))
    )
    const kept = canonicalPodSpec(
      normalizeDeploymentForComparison(deploymentWithProbe({}, 'clerum-x'))
    )
    expect(stripped?.serviceAccountName).toBeUndefined()
    expect(kept?.serviceAccountName).toBe('clerum-x')
  })

  it('omitted probe timeout/failure and SA match the apiserver defaults after merge', () => {
    const desired = deploymentWithProbe({ periodSeconds: 5 })
    const existing = asApiserverDeployment(desired)
    expect(deploymentMatchesDesired(mergedForCompare(desired, existing), existing)).toBe(true)
  })

  it('strips empty resources {} and keeps a non-empty request', () => {
    const empty = deploymentWithProbe({ periodSeconds: 5 })
    empty.spec!.template.spec!.containers![0].resources = {}
    const kept = deploymentWithProbe({ periodSeconds: 5 })
    kept.spec!.template.spec!.containers![0].resources = { requests: { cpu: '50m' } }
    expect(
      canonicalPodSpec(normalizeDeploymentForComparison(empty))?.containers?.[0]?.resources
    ).toBeUndefined()
    expect(
      canonicalPodSpec(normalizeDeploymentForComparison(kept))?.containers?.[0]?.resources
    ).toEqual({ requests: { cpu: '50m' } })
  })

  it('omitted container resources match a live empty resources object', () => {
    const desired = deploymentWithProbe({ periodSeconds: 5 })
    const existing = asApiserverDeployment(desired)
    expect(existing.spec?.template?.spec?.containers?.[0]?.resources).toEqual({})
    expect(desired.spec?.template?.spec?.containers?.[0]?.resources).toBeUndefined()
    expect(deploymentMatchesDesired(mergedForCompare(desired, existing), existing)).toBe(true)
  })

  it('does not treat 1000m and 1 as the same cpu quantity', () => {
    const milli = deploymentWithProbe({ periodSeconds: 5 })
    milli.spec!.template.spec!.containers![0].resources = { limits: { cpu: '1000m' } }
    const canonical = deploymentWithProbe({ periodSeconds: 5 })
    canonical.spec!.template.spec!.containers![0].resources = { limits: { cpu: '1' } }
    expect(deploymentMatchesDesired(milli, canonical)).toBe(false)
  })
})

describe('deploymentMatchesDesired', () => {
  it('omitted imagePullPolicy is not a no-op against the apiserver default-fill', () => {
    const desired = sparseDeployment()
    const existing = asApiserverDeployment(desired)
    expect(existing.spec?.template?.spec?.containers?.[0]?.imagePullPolicy).toBe('IfNotPresent')
    expect(deploymentMatchesDesired(mergedForCompare(desired, existing), existing)).toBe(false)
  })

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

  it('Host mutation sweep: every live-only spec leaf is detectable', () => {
    const desired = createReconciler().buildDeployment(makeHost())
    expectSweepDetectsLiveOnlySpecLeaves(desired, asApiserverDeployment(desired))
  })

  it('channel-reader mutation sweep: every desired leaf is detectable', () => {
    const desired = (createReconciler() as any).buildChannelReaderDeployment(
      makeHost(),
      'rev-abc'
    ) as k8s.V1Deployment
    expectSweepDetectsEveryLeaf(desired, asApiserverDeployment(desired))
  })

  it('channel-reader mutation sweep: every live-only spec leaf is detectable', () => {
    const desired = (createReconciler() as any).buildChannelReaderDeployment(
      makeHost(),
      'rev-abc'
    ) as k8s.V1Deployment
    expectSweepDetectsLiveOnlySpecLeaves(desired, asApiserverDeployment(desired))
  })
})
