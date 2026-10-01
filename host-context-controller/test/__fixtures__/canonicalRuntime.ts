import type * as k8s from '@kubernetes/client-node'
import { createHash } from 'node:crypto'
import { config } from '../../src/config'
import type { HostReconciler, ResolvedSfsMount } from '../../src/hostReconciler'
import type { EffectiveHostLifecycle } from '../../src/statelessLifecycle.types'
import type { HostCRD } from '../../src/types'
import { type MockCoreApi, type MockCustomApi, createMockCustomApi } from './testMocks'

const FIXTURE_TIME = '2026-01-01T00:00:00.000Z'

function fixtureUid(kind: string, namespace: string, name: string): string {
  const value = createHash('sha256')
    .update(`${kind}:${namespace}/${name}`)
    .digest('hex')
    .slice(0, 32)
  return `${value.slice(0, 8)}-${value.slice(8, 12)}-4${value.slice(13, 16)}-8${value.slice(17, 20)}-${value.slice(20)}`
}

export function canonicalFixturePvcUid(host: Pick<HostCRD, 'name' | 'namespace'>): string {
  return fixtureUid('pvc', host.namespace, `${host.name}-workspace`)
}

/** Explicit positive boundary for tests of unrelated reconciler behavior.
 * Models controller-owned canonical readiness already established in an earlier
 * operation; it does not mint an operator request, maintenance or writer proof.
 * An explicitly unknown Host UID remains unknown so negative guards stay live. */
export function canonicalRuntimeHost(host: HostCRD): HostCRD {
  const uid =
    host.uid ??
    (Object.hasOwn(host, 'uid') ? undefined : fixtureUid('host', host.namespace, host.name))
  if (!uid) return host
  const pvcUid = canonicalFixturePvcUid(host)
  const image =
    host.spec.desktop?.browser || host.spec.desktop?.x11 ? config.desktopImage : config.hostImage
  // A mutable configured image remains blocked for operator preparation. This
  // prior diagnostic only models a previous controller observation at the
  // unrelated-feature boundary; it carries no revision or preparation proof.
  const previousDiagnostic =
    host.status?.conversationStore?.operatorProposal ??
    (image && !/@sha256:[0-9a-f]{64}$/.test(image)
      ? {
          schemaVersion: 1 as const,
          state: 'blocked' as const,
          hostUid: uid,
          pvcUid,
          storageContract: 'canonical' as const,
          image,
          reason: 'ImmutableImageRequired',
        }
      : undefined)
  return {
    ...host,
    uid,
    generation: host.generation ?? 1,
    resourceVersion: host.resourceVersion ?? '42',
    status: {
      ...host.status,
      conversationStore: {
        ...host.status?.conversationStore,
        ...(previousDiagnostic ? { operatorProposal: previousDiagnostic } : {}),
        compatibility: {
          schemaVersion: 1,
          storageContract: 'canonical',
          hostUid: uid,
          pvcUid,
          contractVersion: 1,
          establishedAt: FIXTURE_TIME,
        },
        layout: {
          version: 1,
          hostUid: uid,
          pvcUid,
          state: 'ready',
          committedAt: FIXTURE_TIME,
          storeId: fixtureUid('store', host.namespace, host.name),
        },
      },
    },
  }
}

/** Native API metadata only. This API fixture does not admit any Host. */
export function installCanonicalPvcApi(core: MockCoreApi): void {
  const resource = ({
    name,
    namespace,
  }: {
    name: string
    namespace: string
  }): k8s.V1PersistentVolumeClaim => ({
    apiVersion: 'v1',
    kind: 'PersistentVolumeClaim',
    metadata: {
      name,
      namespace,
      uid: fixtureUid('pvc', namespace, name),
      resourceVersion: '1',
      creationTimestamp: new Date(FIXTURE_TIME),
      labels: {
        'clerum.io/managed-by': 'host-context-controller',
        'clerum.io/host': name.replace(/-workspace$/, ''),
      },
    },
    spec: { accessModes: ['ReadWriteOnce'], resources: { requests: { storage: '10Gi' } } },
  })
  core.readNamespacedPersistentVolumeClaim.mockImplementation(async args => resource(args))
  core.createNamespacedPersistentVolumeClaim.mockImplementation(async ({ namespace, body }) => ({
    ...body,
    metadata: { ...body.metadata, ...resource({ namespace, name: body.metadata.name }).metadata },
  }))
}

export function appliedCanonicalDeployment(
  reconciler: HostReconciler,
  host: HostCRD,
  mounts: ResolvedSfsMount[] = [],
  runtimeRevision?: string,
  lifecycle?: EffectiveHostLifecycle,
  grokExecutionEnabled?: boolean
): k8s.V1Deployment {
  const desired = reconciler.buildDeployment(
    host,
    mounts,
    runtimeRevision,
    lifecycle,
    grokExecutionEnabled,
    {
      pvcUid: canonicalFixturePvcUid(host),
      canonical: true,
      storageContract: 'canonical',
      sourceEnvironment: [],
    }
  )
  return {
    ...desired,
    metadata: {
      ...desired.metadata,
      uid: fixtureUid('deployment', host.namespace, host.name),
      resourceVersion: '1',
      annotations: { ...desired.metadata?.annotations, 'clerum.io/host-uid': host.uid! },
      labels: {
        ...desired.metadata?.labels,
        'clerum.io/managed-by': 'host-context-controller',
        'clerum.io/host': host.name,
      },
    },
  }
}

/** Native-shaped GET response for an explicitly selected positive Host fixture.
 * The fixture's controller-owned status is the boundary; this helper adds no
 * authorization, preparation receipt, or writer evidence. */
export function canonicalFixtureHostApiObject(host: HostCRD) {
  return {
    apiVersion: 'hcc.clerum.io/v1alpha1',
    kind: 'Host',
    metadata: {
      name: host.name,
      namespace: host.namespace,
      uid: host.uid,
      resourceVersion: host.resourceVersion ?? '42',
      generation: host.generation ?? 1,
      annotations: host.annotations,
    },
    spec: host.spec,
    status: host.status,
  }
}

/** Existing, empty runtime ConfigMap at this positive unit boundary.
 * Enrich only that API resource's default shape; later scenario overrides and
 * unrelated catalog/provider ConfigMaps retain their own responses. */
export function installCanonicalRuntimeConfigApi(
  core: Pick<MockCoreApi, 'readNamespacedConfigMap'>
): void {
  const original = core.readNamespacedConfigMap.getMockImplementation()!
  core.readNamespacedConfigMap.mockImplementation(async args => {
    const observed = await original(args)
    if (args.name !== config.hostConfigMapName) return observed
    return {
      ...observed,
      metadata: {
        name: args.name,
        namespace: args.namespace,
        uid: fixtureUid('configmap', args.namespace, args.name),
        resourceVersion: '1',
        ...observed.metadata,
      },
    }
  })
}

/** Native GET model owned by one test fixture. The resolver states server-side
 * Host truth explicitly; scenario-specific overrides remain authoritative.
 * It does not authenticate a caller or grant preparation/writer authority. */
export function createCanonicalFixtureHostApi(
  resolveHost: (name: string) => HostCRD
): MockCustomApi {
  const api = createMockCustomApi()
  api.getNamespacedCustomObject.mockImplementation(async ({ name }) =>
    structuredClone(canonicalFixtureHostApiObject(resolveHost(name)))
  )
  return api
}
