import { beforeEach, describe, expect, it, vi } from 'vitest'
import type * as k8s from '@kubernetes/client-node'
import { asApiserverDeployment } from '../__tests__/asApiserverDeployment'
import liveReaderFixture from '../__tests__/fixtures/629/gfsc-reader.deployment.json'
import livePdbFixture from '../__tests__/fixtures/629/gfsc-writer-pdb.json'
import { createsTotal, existenceReadsTotal, writeSkipsTotal } from '../metrics'
import { deploymentMatchesDesired, podDisruptionBudgetMatchesDesired } from '../utils'
import { type GfsFactoryConfig, buildDeployment } from './gfsFactory'
import { K8sGfsApi } from './gfsK8sApi'

const namespace = 'mcp-host'
const metadata = {
  name: 'gfs-resource',
  namespace,
  labels: { 'app.kubernetes.io/managed-by': 'host-context-controller' },
}
const cases = [
  {
    kind: 'PersistentVolumeClaim',
    updates: false,
    body: {
      kind: 'PersistentVolumeClaim',
      metadata,
      spec: { accessModes: ['ReadWriteOnce'], resources: { requests: { storage: '1Gi' } } },
    },
    apply: (api: K8sGfsApi, body: k8s.V1PersistentVolumeClaim) => api.applyPvc(body, namespace),
  },
  {
    kind: 'Service',
    updates: false,
    body: {
      kind: 'Service',
      metadata,
      spec: { selector: { app: 'gfs' }, ports: [{ port: 8080 }] },
    },
    apply: (api: K8sGfsApi, body: k8s.V1Service) => api.applyService(body, namespace),
  },
  {
    kind: 'Deployment',
    updates: false,
    body: {
      kind: 'Deployment',
      metadata,
      spec: {
        selector: { matchLabels: { app: 'gfs' } },
        template: {
          metadata: { labels: { app: 'gfs' } },
          spec: { containers: [{ name: 'gfs', image: 'example/gfs:1' }] },
        },
      },
    },
    apply: (api: K8sGfsApi, body: k8s.V1Deployment) => api.applyDeployment(body, namespace),
  },
  {
    kind: 'PodDisruptionBudget',
    updates: false,
    body: {
      kind: 'PodDisruptionBudget',
      metadata,
      spec: { minAvailable: 1, selector: { matchLabels: { app: 'gfs' } } },
    },
    apply: (api: K8sGfsApi, body: k8s.V1PodDisruptionBudget) =>
      api.applyPodDisruptionBudget(body, namespace),
  },
] as const

// The SDK mock boundary records real adapter calls, not a fake GfsK8sApi implementation.
function harness(kind: string) {
  const events: string[] = []
  const read = vi.fn(async (): Promise<unknown> => {
    events.push('GET')
    throw new Error('Arrange the SDK read outcome for this scenario')
  })
  const create = vi.fn(async (): Promise<unknown> => {
    events.push('POST')
    return {}
  })
  const replace = vi.fn(async ({ body }: { body: { metadata?: { resourceVersion?: string } } }) => {
    events.push(`PUT:${body.metadata?.resourceVersion}`)
    return body
  })
  const sdk = {
    [`readNamespaced${kind}`]: read,
    [`createNamespaced${kind}`]: create,
    [`replaceNamespaced${kind}`]: replace,
  }
  const api = new K8sGfsApi(
    sdk as unknown as k8s.CoreV1Api,
    sdk as unknown as k8s.AppsV1Api,
    sdk as unknown as k8s.NetworkingV1Api,
    sdk as unknown as k8s.PolicyV1Api,
    {} as k8s.CustomObjectsApi
  )
  return { api, read, create, replace, events }
}

async function count(metric: typeof createsTotal, kind: string, outcome: string) {
  return (
    (await metric.get()).values.find(
      row => row.labels.kind === kind && row.labels.outcome === outcome
    )?.value ?? 0
  )
}

beforeEach(() => {
  createsTotal.reset()
  existenceReadsTotal.reset()
  writeSkipsTotal.reset()
})

describe.each(cases)('K8sGfsApi $kind read-first', resource => {
  // This union is passed only to its matching case adapter above.
  const apply = (api: K8sGfsApi) => resource.apply(api, resource.body as never)
  const live = (version = '1') => ({
    ...resource.body,
    metadata: { ...metadata, resourceVersion: version },
  })

  it('preserves or converges an existing object without POST or a duplicate GET', async () => {
    const h = harness(resource.kind)
    h.read.mockImplementation(async () => {
      h.events.push('GET')
      return live()
    })
    await apply(h.api)
    expect(h.events).toEqual(resource.updates ? ['GET', 'PUT:1'] : ['GET'])
    expect(h.read).toHaveBeenCalledExactlyOnceWith({ name: metadata.name, namespace })
    expect(h.create).not.toHaveBeenCalled()
    expect(h.replace).toHaveBeenCalledTimes(resource.updates ? 1 : 0)
    if (resource.updates)
      expect(h.replace).toHaveBeenCalledWith({ name: metadata.name, namespace, body: live() })
    expect(await count(createsTotal, resource.kind, 'skipped')).toBe(1)
    expect(await count(existenceReadsTotal, resource.kind, 'found')).toBe(1)
  })

  it('creates an absent object after its single existence GET', async () => {
    const h = harness(resource.kind)
    h.read.mockImplementationOnce(async () => {
      h.events.push('GET')
      throw { code: 404 }
    })
    await apply(h.api)
    expect(h.events).toEqual(['GET', 'POST'])
    expect(h.create).toHaveBeenCalledExactlyOnceWith({ namespace, body: resource.body })
    expect(h.replace).not.toHaveBeenCalled()
    expect(await count(createsTotal, resource.kind, 'created')).toBe(1)
    expect(await count(createsTotal, resource.kind, 'skipped')).toBe(0)
    expect(await count(existenceReadsTotal, resource.kind, 'absent')).toBe(1)
  })

  it.each([{ code: 403 }, { response: { statusCode: 500 } }, new Error('transport failure')])(
    'propagates initial GET failure without a write: %j',
    async error => {
      const h = harness(resource.kind)
      h.read.mockRejectedValueOnce(error)
      await expect(apply(h.api)).rejects.toBe(error)
      expect(h.read).toHaveBeenCalledTimes(1)
      expect(h.create).not.toHaveBeenCalled()
      expect(h.replace).not.toHaveBeenCalled()
      expect(await count(existenceReadsTotal, resource.kind, 'error')).toBe(1)
      expect(await count(createsTotal, resource.kind, 'skipped')).toBe(0)
    }
  )

  it('rereads after absence races with POST409, without counting a suppressed create', async () => {
    const h = harness(resource.kind)
    h.read
      .mockImplementationOnce(async () => {
        h.events.push('GET')
        throw { code: 404 }
      })
      .mockImplementationOnce(async () => {
        h.events.push('GET')
        return live('2')
      })
    h.create.mockImplementationOnce(async () => {
      h.events.push('POST')
      throw { code: 409 }
    })
    await apply(h.api)
    expect(h.events).toEqual(
      resource.updates ? ['GET', 'POST', 'GET', 'PUT:2'] : ['GET', 'POST', 'GET']
    )
    expect(h.create).toHaveBeenCalledTimes(1)
    expect(h.read).toHaveBeenCalledTimes(2)
    expect(await count(createsTotal, resource.kind, 'conflict')).toBe(1)
    expect(await count(createsTotal, resource.kind, 'skipped')).toBe(0)
  })

  it('propagates the fresh GET403 after POST409', async () => {
    const h = harness(resource.kind)
    const denied = { code: 403 }
    h.read.mockRejectedValueOnce({ code: 404 }).mockRejectedValueOnce(denied)
    h.create.mockRejectedValueOnce({ code: 409 })
    await expect(apply(h.api)).rejects.toBe(denied)
    expect(h.read).toHaveBeenCalledTimes(2)
    expect(h.create).toHaveBeenCalledTimes(1)
    expect(h.replace).not.toHaveBeenCalled()
    expect(await count(createsTotal, resource.kind, 'skipped')).toBe(0)
  })

  it('preserves benign disappearance after a create conflict', async () => {
    const h = harness(resource.kind)
    h.read.mockRejectedValueOnce({ code: 404 }).mockRejectedValueOnce({ code: 404 })
    h.create.mockRejectedValueOnce({ code: 409 })
    await expect(apply(h.api)).resolves.toBe('missing')
    expect(h.read).toHaveBeenCalledTimes(2)
    expect(h.create).toHaveBeenCalledTimes(1)
    expect(h.replace).not.toHaveBeenCalled()
    expect(await count(createsTotal, resource.kind, 'skipped')).toBe(0)
  })

  it('preserves a non-conflict POST failure without convergence', async () => {
    const h = harness(resource.kind)
    h.read.mockRejectedValueOnce({ code: 404 })
    const denied = { code: 403 }
    h.create.mockRejectedValueOnce(denied)
    await expect(apply(h.api)).rejects.toBe(denied)
    expect(h.read).toHaveBeenCalledTimes(1)
    expect(h.create).toHaveBeenCalledTimes(1)
    expect(h.replace).not.toHaveBeenCalled()
    expect(await count(createsTotal, resource.kind, 'error')).toBe(1)
  })
})

describe.each(cases.filter(resource => resource.updates))(
  'K8sGfsApi $kind PUT conflicts',
  resource => {
    const apply = (api: K8sGfsApi) => resource.apply(api, resource.body as never)
    it('uses the cached first read once, then fresh resourceVersion for the retry', async () => {
      const h = harness(resource.kind)
      let version = 0
      h.read.mockImplementation(async () => {
        h.events.push('GET')
        return { ...resource.body, metadata: { ...metadata, resourceVersion: String(++version) } }
      })
      h.replace.mockImplementationOnce(async ({ body }) => {
        h.events.push(`PUT:${body.metadata?.resourceVersion}`)
        throw { code: 409 }
      })
      await apply(h.api)
      expect(h.events).toEqual(['GET', 'PUT:1', 'GET', 'PUT:2'])
      expect(h.create).not.toHaveBeenCalled()
      expect(await count(existenceReadsTotal, resource.kind, 'found')).toBe(2)
      expect(await count(createsTotal, resource.kind, 'skipped')).toBe(1)
    })

    it('retains the three-attempt PUT budget and propagates exhaustion', async () => {
      const h = harness(resource.kind)
      h.read.mockResolvedValue({
        ...resource.body,
        metadata: { ...metadata, resourceVersion: '1' },
      })
      const conflict = { code: 409 }
      h.replace.mockRejectedValue(conflict)
      await expect(apply(h.api)).rejects.toBe(conflict)
      expect(h.read).toHaveBeenCalledTimes(3)
      expect(h.replace).toHaveBeenCalledTimes(3)
      expect(h.create).not.toHaveBeenCalled()
      expect(await count(createsTotal, resource.kind, 'skipped')).toBe(0)
    })
  }
)

describe('K8sGfsApi PodDisruptionBudget no-op gate (T4)', () => {
  const namespace = 'gfs'
  const desired = livePdbFixture as k8s.V1PodDisruptionBudget

  async function skipCount() {
    return (
      (await writeSkipsTotal.get()).values.find(row => row.labels.kind === 'PodDisruptionBudget')
        ?.value ?? 0
    )
  }

  it('T4: skips replace when the live PDB matches', async () => {
    const equal = harness('PodDisruptionBudget')
    equal.read.mockImplementation(async () => {
      equal.events.push('GET')
      return {
        ...desired,
        status: {
          currentHealthy: 1,
          desiredHealthy: 1,
          disruptionsAllowed: 0,
          expectedPods: 1,
        },
        metadata: {
          ...desired.metadata,
          resourceVersion: '1',
          uid: 'pdb-uid',
          creationTimestamp: new Date('2026-01-01T00:00:00Z'),
          managedFields: [{ manager: 'kube-apiserver', operation: 'Update' }],
        },
      }
    })
    await equal.api.applyPodDisruptionBudget(desired, namespace)
    expect(equal.read).toHaveBeenCalledTimes(1)
    expect(equal.replace).toHaveBeenCalledTimes(0)
    expect(await skipCount()).toBe(1)
  })

  it('T4: retries a drifted PDB PUT after 409 using a fresh resourceVersion', async () => {
    const h = harness('PodDisruptionBudget')
    let version = 0
    h.read.mockImplementation(async () => {
      h.events.push('GET')
      return {
        ...desired,
        metadata: { ...desired.metadata, resourceVersion: String(++version) },
        spec: { ...desired.spec, minAvailable: 2 },
      }
    })
    h.replace.mockImplementationOnce(async ({ body }) => {
      h.events.push(`PUT:${body.metadata?.resourceVersion}`)
      throw { code: 409 }
    })
    await h.api.applyPodDisruptionBudget(desired, namespace)
    expect(h.events).toEqual(['GET', 'PUT:1', 'GET', 'PUT:2'])
    expect(h.replace).toHaveBeenCalledTimes(2)
    expect(h.create).not.toHaveBeenCalled()
  })

  it('T4: writes when minAvailable differs', async () => {
    const drifted = harness('PodDisruptionBudget')
    const live = {
      ...desired,
      metadata: { ...desired.metadata, resourceVersion: '7' },
      spec: { ...desired.spec, minAvailable: 2 },
    }
    drifted.read.mockImplementation(async () => {
      drifted.events.push('GET')
      return live
    })
    await drifted.api.applyPodDisruptionBudget(desired, namespace)
    expect(drifted.read).toHaveBeenCalledTimes(1)
    expect(drifted.replace).toHaveBeenCalledTimes(1)
    const replaced = drifted.replace.mock.calls[0][0].body as k8s.V1PodDisruptionBudget
    expect(replaced.spec?.minAvailable).toBe(1)
    expect(await skipCount()).toBe(0)
  })

  it('T4: a live unhealthyPodEvictionPolicy is drift', () => {
    const live = {
      ...desired,
      spec: { ...desired.spec, unhealthyPodEvictionPolicy: 'AlwaysAllow' as const },
    }
    expect(podDisruptionBudgetMatchesDesired(desired, live)).toBe(false)
  })
})

const REVISION_ANNOTATION = 'deployment.kubernetes.io/revision'
const RESTARTED_AT = 'kubectl.kubernetes.io/restartedAt'

const readerProducerConfig: GfsFactoryConfig = {
  gfsNamespace: 'gfs',
  controlPlaneNamespace: 'control-plane',
  postgresPodLabels: { app: 'control-postgres' },
  postgresPort: 5432,
  gfscImage: 'clerum-gfs-controller:test',
  gfscImagePullPolicy: 'IfNotPresent',
  gfscPort: 8087,
  gfscInitImage: 'busybox:1.36',
  gfscResources: {
    requests: { memory: '128Mi', cpu: '100m' },
    limits: { memory: '256Mi', cpu: '500m' },
  },
  jwtPublicKeyConfigMapName: 'gfs-config',
  jwtPublicKeyConfigMapKey: 'jwt-public-key',
  pgSecretName: 'gfs-controller-db',
  pgSecretKey: 'connection-string',
  readerPgSecretName: 'gfs-controller-reader-db',
  readerPgSecretKey: 'connection-string',
  driveName: 'main',
  tokenAudience: 'gfs-controller',
}

function producedReader(): k8s.V1Deployment {
  return buildDeployment(
    { name: 'gfs', namespace: 'gfs', spec: {} },
    readerProducerConfig,
    'reader'
  )
}

/**
 * Synthetic twin of the captured fixture (revision stripped). These cases
 * prove annotation merge and fail-open replica drift. They do not put
 * `buildDeployment` on the desired side — see the producer+defaulting cases.
 */
function desiredReaderFromFixture(): k8s.V1Deployment {
  const desired = structuredClone(liveReaderFixture) as k8s.V1Deployment
  if (desired.metadata?.annotations) {
    delete desired.metadata.annotations[REVISION_ANNOTATION]
  }
  return desired
}

function liveReader(overrides: Partial<k8s.V1DeploymentSpec> = {}): k8s.V1Deployment {
  const live = structuredClone(liveReaderFixture) as k8s.V1Deployment
  const selector = overrides.selector ?? live.spec?.selector
  const template = overrides.template ?? live.spec?.template
  if (!selector || !template) {
    throw new Error('gfsc-reader fixture is missing spec.selector or spec.template')
  }
  const spec: k8s.V1DeploymentSpec = {
    ...live.spec,
    ...overrides,
    selector,
    template,
  }
  return {
    ...live,
    metadata: {
      ...live.metadata,
      resourceVersion: '1',
      uid: 'reader-uid',
      creationTimestamp: new Date('2026-01-01T00:00:00Z'),
      managedFields: [{ manager: 'kube-controller-manager', operation: 'Update' }],
    },
    spec,
    status: { observedGeneration: 1, availableReplicas: spec.replicas ?? 2 },
  }
}

describe('K8sGfsApi Deployment no-op gate (T3, T8)', () => {
  const namespace = 'gfs'

  async function deploymentSkipCount() {
    return (
      (await writeSkipsTotal.get()).values.find(row => row.labels.kind === 'Deployment')?.value ?? 0
    )
  }

  it('T3: the captured fixture is synthetic and does not match buildDeployment', () => {
    expect(deploymentMatchesDesired(producedReader(), liveReaderFixture as k8s.V1Deployment)).toBe(
      false
    )
  })

  it('T3: skips replace when live is buildDeployment after apiserver defaulting', async () => {
    const desired = producedReader()
    const live = asApiserverDeployment(desired)
    const templateMeta = live.spec?.template?.metadata
    if (!templateMeta) throw new Error('expected pod template metadata')
    templateMeta.annotations = {
      ...templateMeta.annotations,
      [RESTARTED_AT]: '2026-09-16T20:33:45Z',
    }
    const equal = harness('Deployment')
    equal.read.mockImplementation(async () => {
      equal.events.push('GET')
      return live
    })
    await equal.api.applyDeployment(desired, namespace)
    expect(equal.read).toHaveBeenCalledTimes(1)
    expect(equal.replace).toHaveBeenCalledTimes(0)
    expect(await deploymentSkipCount()).toBe(1)
  })

  it('T3: writes when live has a default-filled field the normalizer does not strip', async () => {
    const desired = producedReader()
    const live = asApiserverDeployment(desired)
    if (!live.spec) throw new Error('expected live spec')
    live.spec.minReadySeconds = 7
    const drifted = harness('Deployment')
    drifted.read.mockImplementation(async () => {
      drifted.events.push('GET')
      return live
    })
    await drifted.api.applyDeployment(desired, namespace)
    expect(drifted.read).toHaveBeenCalledTimes(1)
    expect(drifted.replace).toHaveBeenCalledTimes(1)
    expect(await deploymentSkipCount()).toBe(0)
  })

  it('T3: skips replace when the live reader matches after revision merge', async () => {
    const desired = desiredReaderFromFixture()
    const equal = harness('Deployment')
    equal.read.mockImplementation(async () => {
      equal.events.push('GET')
      return liveReader()
    })
    await equal.api.applyDeployment(desired, namespace)
    expect(equal.read).toHaveBeenCalledTimes(1)
    expect(equal.replace).toHaveBeenCalledTimes(0)
    expect(await deploymentSkipCount()).toBe(1)
  })

  it('T3: writes when live replicas are 0 and restores the desired replica count', async () => {
    const desired = desiredReaderFromFixture()
    const scaled = harness('Deployment')
    scaled.read.mockImplementation(async () => {
      scaled.events.push('GET')
      return liveReader({ replicas: 0 })
    })
    await scaled.api.applyDeployment(desired, namespace)
    expect(scaled.read).toHaveBeenCalledTimes(1)
    expect(scaled.replace).toHaveBeenCalledTimes(1)
    const replaced = scaled.replace.mock.calls[0][0].body as k8s.V1Deployment
    expect(replaced.spec?.replicas).toBe(desired.spec?.replicas)
    expect(await deploymentSkipCount()).toBe(0)
  })

  it('T8: skips replace when live template has restartedAt and increments writeSkipsTotal', async () => {
    const desired = desiredReaderFromFixture()
    const restarted = harness('Deployment')
    const live = liveReader()
    const templateMeta = live.spec?.template?.metadata
    if (!templateMeta) throw new Error('expected pod template metadata')
    templateMeta.annotations = {
      ...templateMeta.annotations,
      [RESTARTED_AT]: '2026-09-16T20:33:45Z',
    }
    restarted.read.mockImplementation(async () => {
      restarted.events.push('GET')
      return live
    })
    await restarted.api.applyDeployment(desired, namespace)
    expect(restarted.read).toHaveBeenCalledTimes(1)
    expect(restarted.replace).toHaveBeenCalledTimes(0)
    expect(await deploymentSkipCount()).toBe(1)
  })

  it('T3: retries a drifted reader PUT after 409 using a fresh resourceVersion', async () => {
    const desired = desiredReaderFromFixture()
    const h = harness('Deployment')
    let version = 0
    h.read.mockImplementation(async () => {
      h.events.push('GET')
      const live = liveReader({ replicas: 0 })
      live.metadata = { ...live.metadata, resourceVersion: String(++version) }
      return live
    })
    h.replace.mockImplementationOnce(async ({ body }) => {
      h.events.push(`PUT:${body.metadata?.resourceVersion}`)
      throw { code: 409 }
    })
    await h.api.applyDeployment(desired, namespace)
    expect(h.events).toEqual(['GET', 'PUT:1', 'GET', 'PUT:2'])
    expect(h.replace).toHaveBeenCalledTimes(2)
    expect(h.create).not.toHaveBeenCalled()
  })
})
