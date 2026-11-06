import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import * as k8s from '@kubernetes/client-node'
import * as http from 'node:http'
import { fakeDeploymentApiserver } from '../__tests__/fakeDeploymentApiserver'
import { makeK8sApiClientWithDeadline } from '../k8s/k8sRequestDeadline'
import { hccLogger } from '../logger'
import { registry } from '../metrics'
import {
  DeploymentObservation,
  ManagedDeploymentInformer,
  managedDeploymentListFromAppsApi,
} from './deploymentInformer'

const NAMESPACE = 'mcp-server'
const SELECTOR = 'clerum.io/managed-by=host-context-controller'

async function runningGauge(): Promise<number | undefined> {
  const metric = registry.getSingleMetric('clerum_hcc_deployment_informer_running')
  if (!metric) throw new Error('clerum_hcc_deployment_informer_running is not registered')
  const snapshot = await metric.get()
  return snapshot.values.find(value => value.labels.namespace === NAMESPACE)?.value
}

describe('ManagedDeploymentInformer', () => {
  let observations: DeploymentObservation[]
  let informer: ManagedDeploymentInformer | undefined

  const start = (api: ReturnType<typeof fakeDeploymentApiserver>) => {
    informer = new ManagedDeploymentInformer(
      {} as k8s.KubeConfig,
      NAMESPACE,
      observation => observations.push(observation),
      api.list,
      { watch: { watch: api.watch } }
    )
    return informer.start()
  }

  beforeEach(() => {
    vi.useFakeTimers()
    observations = []
  })

  afterEach(() => {
    informer?.stop()
    informer = undefined
    vi.restoreAllMocks()
    vi.useRealTimers()
  })

  it('DI1 the first connect lists once, delivers each item, then watches from the list version', async () => {
    const api = fakeDeploymentApiserver(NAMESPACE, {
      stuck: { generation: 3, ready: false },
      healthy: { generation: 1, ready: true },
    })
    const info = vi.spyOn(hccLogger, 'info')

    await expect(start(api)).resolves.toBe(true)

    expect(api.list).toHaveBeenCalledTimes(1)
    expect(observations).toEqual([
      { name: 'stuck', deleted: false, ready: false, generation: 3 },
      { name: 'healthy', deleted: false, ready: true, generation: 1 },
    ])
    expect(api.watchCalls).toHaveLength(1)
    expect(api.watchCalls[0].path).toBe(`/apis/apps/v1/namespaces/${NAMESPACE}/deployments`)
    expect(api.watchCalls[0].queryParams).toEqual({
      resourceVersion: api.revision(),
      allowWatchBookmarks: true,
      labelSelector: SELECTOR,
    })
    expect(await runningGauge()).toBe(1)
    expect(info).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ event: 'deployment-informer-watch-established', resumed: false })
    )
  })

  it('DI2 a disconnect resumes from the last event, and a later bookmark moves the resume point', async () => {
    const api = fakeDeploymentApiserver(NAMESPACE, { stuck: { generation: 3, ready: false } })
    await start(api)
    api.set('stuck', { generation: 3, ready: true })
    const lastEvent = api.revision()

    api.disconnect()
    expect(await runningGauge()).toBe(0)
    await vi.advanceTimersByTimeAsync(1000)

    expect(api.list).toHaveBeenCalledTimes(1)
    expect(api.watchCalls).toHaveLength(2)
    expect(api.watchCalls[1].queryParams.resourceVersion).toBe(lastEvent)

    api.bookmark('900')
    api.disconnect()
    await vi.advanceTimersByTimeAsync(1000)

    expect(api.list).toHaveBeenCalledTimes(1)
    expect(api.watchCalls).toHaveLength(3)
    expect(api.watchCalls[2].queryParams.resourceVersion).toBe('900')
    expect(observations.at(-1)).toEqual({
      name: 'stuck',
      deleted: false,
      ready: true,
      generation: 3,
    })
  })

  it.each([
    ['HTTP 410 at resume', 'resume'],
    ['an in-stream 410', 'stream'],
  ] as const)(
    'DI3 %s makes the next connect list and deliver what changed during the gap',
    async (_label, kind) => {
      const api = fakeDeploymentApiserver(NAMESPACE, { stuck: { generation: 3, ready: false } })
      await start(api)
      observations.length = 0
      if (kind === 'resume') {
        api.expireNextResume()
        api.disconnect()
        // The resume answers 410, then the next backoff lists.
        await vi.advanceTimersByTimeAsync(1000)
        expect(api.list).toHaveBeenCalledTimes(1)
      } else {
        api.expireInStream()
      }
      api.failWatches(null)
      api.set('stuck', { generation: 4, ready: true })
      await vi.advanceTimersByTimeAsync(2000)

      expect(api.list).toHaveBeenCalledTimes(2)
      expect(observations).toEqual([{ name: 'stuck', deleted: false, ready: true, generation: 4 }])
      expect(api.watchCalls.at(-1)?.queryParams.resourceVersion).toBe(api.revision())
    }
  )

  it('DI4 a failed list delivers nothing and opens no watch; backoff is 1 s then 2 s', async () => {
    const api = fakeDeploymentApiserver(NAMESPACE, { stuck: { generation: 3, ready: false } })
    const error = vi.spyOn(hccLogger, 'error')
    api.failNextList(() => new Error('list unavailable'))
    api.failNextList(() => new Error('list unavailable'))

    await expect(start(api)).resolves.toBe(false)

    expect(api.list).toHaveBeenCalledTimes(1)
    expect(api.watchCalls).toHaveLength(0)
    expect(observations).toEqual([])
    expect(await runningGauge()).toBe(0)
    expect(error).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ event: 'deployment-informer-list-failed' })
    )

    await vi.advanceTimersByTimeAsync(999)
    expect(api.list).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(1)
    expect(api.list).toHaveBeenCalledTimes(2)
    expect(api.watchCalls).toHaveLength(0)

    await vi.advanceTimersByTimeAsync(1999)
    expect(api.list).toHaveBeenCalledTimes(2)
    await vi.advanceTimersByTimeAsync(1)
    expect(api.list).toHaveBeenCalledTimes(3)
    expect(api.watchCalls).toHaveLength(1)
    expect(observations).toHaveLength(1)
    expect(await runningGauge()).toBe(1)
  })

  it('DI4b a list with no resourceVersion is a failed list', async () => {
    const api = fakeDeploymentApiserver(NAMESPACE, { stuck: { generation: 3, ready: false } })
    api.list.mockResolvedValueOnce({ items: [{ metadata: { name: 'stuck' } }], metadata: {} })

    await expect(start(api)).resolves.toBe(false)

    expect(api.list).toHaveBeenCalledTimes(1)
    expect(api.watchCalls).toHaveLength(0)
    expect(observations).toEqual([])
  })

  it('DI5 a watch that answers 403 keeps climbing the backoff with the gauge at 0', async () => {
    const api = fakeDeploymentApiserver(NAMESPACE, { stuck: { generation: 3, ready: false } })
    const warn = vi.spyOn(hccLogger, 'warn')
    api.failWatches(() => Object.assign(new Error('forbidden'), { statusCode: 403 }))
    const startedAt = Date.now()
    const callTimes: number[] = []
    const watch = api.watch
    const timedWatch: typeof watch = (...args) => {
      callTimes.push(Date.now() - startedAt)
      return watch(...args)
    }
    informer = new ManagedDeploymentInformer(
      {} as k8s.KubeConfig,
      NAMESPACE,
      observation => observations.push(observation),
      api.list,
      { watch: { watch: timedWatch } }
    )

    await expect(informer.start()).resolves.toBe(false)
    await vi.advanceTimersByTimeAsync(7000)

    expect(callTimes).toEqual([0, 1000, 3000, 7000])
    expect(await runningGauge()).toBe(0)
    expect(api.list).toHaveBeenCalledTimes(1)
    expect(warn).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ event: 'deployment-informer-watch-ended', statusCode: 403 })
    )
  })

  it('DI6 stop during a pending list delivers nothing and opens no watch', async () => {
    const api = fakeDeploymentApiserver(NAMESPACE, { stuck: { generation: 3, ready: false } })
    let releaseList!: () => void
    const held = new Promise<void>(resolve => {
      releaseList = resolve
    })
    const realList = api.list.getMockImplementation()!
    api.list.mockImplementationOnce(async () => {
      await held
      return realList()
    })

    const started = start(api)
    expect(api.list).toHaveBeenCalledTimes(1)
    informer!.stop()
    releaseList()

    await expect(started).resolves.toBe(false)
    expect(observations).toEqual([])
    expect(api.watchCalls).toHaveLength(0)
  })

  it('DI6b stop during backoff clears the reconnect', async () => {
    const api = fakeDeploymentApiserver(NAMESPACE, { stuck: { generation: 3, ready: false } })
    await start(api)
    const firstWatch = api.watchCalls[0]
    api.disconnect()
    expect(vi.getTimerCount()).toBe(1)

    informer!.stop()

    expect(vi.getTimerCount()).toBe(0)
    await vi.advanceTimersByTimeAsync(60_000)
    expect(api.watchCalls).toEqual([firstWatch])
    expect(api.list).toHaveBeenCalledTimes(1)
    expect(await runningGauge()).toBe(0)
  })

  it('DI6c stop aborts the established watch and later callbacks deliver nothing', async () => {
    const api = fakeDeploymentApiserver(NAMESPACE, { stuck: { generation: 3, ready: false } })
    await start(api)
    observations.length = 0
    const live = api.watchCalls[0]

    informer!.stop()

    expect(live.abort).toHaveBeenCalledTimes(1)
    live.cb('MODIFIED', {
      metadata: { name: 'stuck', resourceVersion: '999', generation: 3 },
      status: {},
    })
    expect(observations).toEqual([])
  })

  it('DI7 an event with no name or resourceVersion is ignored and logged', async () => {
    const api = fakeDeploymentApiserver(NAMESPACE, {})
    await start(api)
    const error = vi.spyOn(hccLogger, 'error')

    api.emitRaw('MODIFIED', { metadata: { resourceVersion: '200' } })
    api.emitRaw('MODIFIED', { metadata: { name: 'stuck' } })

    expect(observations).toEqual([])
    expect(error).toHaveBeenCalledTimes(2)
    expect(error).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ event: 'deployment-informer-event-invalid', type: 'MODIFIED' })
    )
  })

  it('DI7b a DELETED event is delivered as deleted', async () => {
    const api = fakeDeploymentApiserver(NAMESPACE, { stuck: { generation: 3, ready: false } })
    await start(api)
    observations.length = 0

    api.remove('stuck')

    expect(observations).toEqual([{ name: 'stuck', deleted: true, ready: false, generation: 3 }])
  })

  it('DI8 a consumer that throws is logged and the next event is still delivered', async () => {
    const api = fakeDeploymentApiserver(NAMESPACE, {})
    const delivered: string[] = []
    const error = vi.spyOn(hccLogger, 'error')
    informer = new ManagedDeploymentInformer(
      {} as k8s.KubeConfig,
      NAMESPACE,
      observation => {
        delivered.push(observation.name)
        if (observation.name === 'bad') throw new Error('consumer failure')
      },
      api.list,
      { watch: { watch: api.watch } }
    )
    await informer.start()

    api.set('bad', { generation: 1, ready: false })
    api.set('good', { generation: 1, ready: true })

    expect(delivered).toEqual(['bad', 'good'])
    expect(error).toHaveBeenCalledWith(
      '[DeploymentInformer] observation consumer threw',
      expect.objectContaining({ name: 'bad' })
    )
    expect(api.watchCalls).toHaveLength(1)
  })
})

describe('managedDeploymentListFromAppsApi', () => {
  it('DI9 lists through a real AppsV1Api with the managed-by selector', async () => {
    const requests: string[] = []
    const server = http.createServer((req, res) => {
      requests.push(req.url ?? '')
      res.setHeader('content-type', 'application/json')
      res.end(
        JSON.stringify({
          apiVersion: 'apps/v1',
          kind: 'DeploymentList',
          metadata: { resourceVersion: '77' },
          items: [{ metadata: { name: 'stuck', generation: 2 }, status: {} }],
        })
      )
    })
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject)
      server.listen(0, '127.0.0.1', resolve)
    })
    try {
      const address = server.address()
      if (!address || typeof address === 'string') throw new Error('no TCP address')
      const base = `http://127.0.0.1:${address.port}`
      const kc = new k8s.KubeConfig()
      kc.loadFromOptions({
        clusters: [{ name: 'local', server: base, skipTLSVerify: true }],
        users: [{ name: 'tester' }],
        contexts: [{ name: 'local', cluster: 'local', user: 'tester' }],
        currentContext: 'local',
      })
      const api = makeK8sApiClientWithDeadline(kc, k8s.AppsV1Api, 5000)

      const list = await managedDeploymentListFromAppsApi(api, NAMESPACE)()

      expect(requests).toHaveLength(1)
      const url = new URL(requests[0], base)
      expect(url.pathname).toBe(`/apis/apps/v1/namespaces/${NAMESPACE}/deployments`)
      expect(url.searchParams.get('labelSelector')).toBe(SELECTOR)
      expect(list.metadata?.resourceVersion).toBe('77')
      expect(list.items.map(item => item.metadata?.name)).toEqual(['stuck'])
    } finally {
      server.closeAllConnections()
      await new Promise<void>(resolve => server.close(() => resolve()))
    }
  })
})
