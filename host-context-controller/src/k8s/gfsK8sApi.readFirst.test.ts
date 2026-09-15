import { beforeEach, describe, expect, it, vi } from 'vitest'
import type * as k8s from '@kubernetes/client-node'
import { createsTotal, existenceReadsTotal } from '../metrics'
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
    updates: true,
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
    updates: true,
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
    await expect(apply(h.api)).resolves.toBeUndefined()
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
