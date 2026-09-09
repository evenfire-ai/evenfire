import { beforeEach, describe, expect, it, vi } from 'vitest'
import type * as k8s from '@kubernetes/client-node'
import {
  asAppsApi,
  asCoreApi,
  asCustomApi,
  asNetworkingApi,
  asRbacApi,
  createMockAppsApi,
  createMockCoreApi,
  createMockCustomApi,
  createMockNetworkingApi,
  createMockRbacApi,
  makeStubKc,
} from '../test/__fixtures__/testMocks'
import { asApiserverService } from './__tests__/asApiserverService'
import { HostReconciler } from './hostReconciler'
import { CREATE_KINDS, createsTotal } from './metrics'
import type { HostCRD } from './types'

const host: HostCRD = {
  name: 'read-first-host',
  namespace: 'mcp-host',
  uid: 'host-uid',
  spec: { host: 'read-first-host', contextRef: 'context', secretRef: 'host-secret' },
}

function fixture() {
  const core = createMockCoreApi()
  const apps = createMockAppsApi()
  const reconciler = new HostReconciler(makeStubKc(), {
    coreApi: asCoreApi(core),
    appsApi: asAppsApi(apps),
    networkingApi: asNetworkingApi(createMockNetworkingApi()),
    rbacApi: asRbacApi(createMockRbacApi()),
    customApi: asCustomApi(createMockCustomApi()),
  })
  vi.spyOn(reconciler as any, 'computeChannelReaderRevisionForHost').mockResolvedValue('revision')
  return { core, apps, reconciler }
}

async function count(kind: string, outcome: string) {
  const sample = (await createsTotal.get()).values.find(
    v => v.labels.kind === kind && v.labels.outcome === outcome
  )
  expect(sample).toBeDefined()
  return sample!.value
}

const cases = [
  ['Host Service', 'Service', 'ensureService'],
  ['channel-reader Service', 'Service', 'reconcileChannelReaderService'],
  ['Host Deployment', 'Deployment', 'ensureDeployment'],
  ['channel-reader Deployment', 'Deployment', 'reconcileChannelReaderDeployment'],
] as const

function invoke(reconciler: HostReconciler, method: string, revalidate?: () => void) {
  return method === 'ensureDeployment'
    ? (reconciler as any)[method](host, [], 'runtime-revision', undefined, undefined, revalidate)
    : (reconciler as any)[method](host, revalidate)
}

describe('Host read-first Service and Deployment contracts', () => {
  beforeEach(() => {
    createsTotal.reset()
    for (const kind of CREATE_KINDS)
      for (const outcome of ['created', 'conflict', 'error', 'skipped'])
        createsTotal.inc({ kind, outcome }, 0)
  })

  it.each(cases)(
    '%s propagates initial GET403 without a mutation or skip',
    async (_label, kind, method) => {
      const { core, apps, reconciler } = fixture()
      const read = kind === 'Service' ? core.readNamespacedService : apps.readNamespacedDeployment
      const create =
        kind === 'Service' ? core.createNamespacedService : apps.createNamespacedDeployment
      const replace =
        kind === 'Service' ? core.replaceNamespacedService : apps.replaceNamespacedDeployment
      const denied = { code: 403 }
      read.mockRejectedValueOnce(denied)
      await expect(invoke(reconciler, method)).rejects.toBe(denied)
      expect(read).toHaveBeenCalledOnce()
      expect(create).not.toHaveBeenCalled()
      expect(replace).not.toHaveBeenCalled()
      expect(await count(kind, 'skipped')).toBe(0)
      expect(await count(kind, 'error')).toBe(0)
    }
  )

  it.each(cases)(
    '%s revalidates after an absent GET before any POST',
    async (_label, kind, method) => {
      const { core, apps, reconciler } = fixture()
      const read = kind === 'Service' ? core.readNamespacedService : apps.readNamespacedDeployment
      const create =
        kind === 'Service' ? core.createNamespacedService : apps.createNamespacedDeployment
      const replace =
        kind === 'Service' ? core.replaceNamespacedService : apps.replaceNamespacedDeployment
      let current = true
      const superseded = new Error('admission retired during existence GET')
      const revalidate = vi.fn(() => {
        if (!current) throw superseded
      })
      read.mockImplementationOnce(async () => {
        current = false
        throw { code: 404 }
      })
      await expect(invoke(reconciler, method, revalidate)).rejects.toBe(superseded)
      expect(read).toHaveBeenCalledOnce()
      expect(revalidate).toHaveBeenCalledTimes(2)
      expect(create).not.toHaveBeenCalled()
      expect(replace).not.toHaveBeenCalled()
      expect(await count(kind, 'skipped')).toBe(0)
    }
  )

  it('rechecks Host admission after asynchronous Deployment body resolution', async () => {
    const { apps, reconciler } = fixture()
    let current = true
    const superseded = new Error('admission retired during body resolution')
    const revalidate = vi.fn(() => {
      if (!current) throw superseded
    })
    apps.readNamespacedDeployment.mockRejectedValueOnce({ code: 404 })
    const resolveState = vi.fn(async () => {
      expect(apps.readNamespacedDeployment).toHaveBeenCalledOnce()
      current = false
      return {
        runtimeTokenRevision: 'fresh-revision',
        lifecycle: { stateless: false, state: 'active' },
      }
    })
    await expect(
      (reconciler as any).ensureDeployment(
        host,
        [],
        'old-revision',
        undefined,
        resolveState,
        revalidate
      )
    ).rejects.toBe(superseded)
    expect(resolveState).toHaveBeenCalledOnce()
    expect(apps.createNamespacedDeployment).not.toHaveBeenCalled()
    expect(apps.replaceNamespacedDeployment).not.toHaveBeenCalled()
    expect(await count('Deployment', 'skipped')).toBe(0)
  })

  it('uses state resolved after GET404 in the first Deployment POST', async () => {
    const { apps, reconciler } = fixture()
    apps.readNamespacedDeployment.mockRejectedValueOnce({ code: 404 })
    const resolveState = vi.fn(async () => {
      expect(apps.readNamespacedDeployment).toHaveBeenCalledOnce()
      return {
        runtimeTokenRevision: 'fresh-revision',
        lifecycle: { stateless: false, state: 'active' },
      }
    })
    await (reconciler as any).ensureDeployment(host, [], 'old-revision', undefined, resolveState)
    expect(resolveState).toHaveBeenCalledOnce()
    expect(apps.createNamespacedDeployment).toHaveBeenCalledOnce()
    const body = apps.createNamespacedDeployment.mock.calls[0][0].body as k8s.V1Deployment
    expect(body.spec?.template.metadata?.annotations?.['clerum.io/runtime-token-revision']).toBe(
      'fresh-revision'
    )
    expect(await count('Deployment', 'created')).toBe(1)
    expect(await count('Deployment', 'skipped')).toBe(0)
  })

  it('retains a Host Service POST failure without recording presence suppression', async () => {
    const { core, reconciler } = fixture()
    core.readNamespacedService.mockRejectedValueOnce({ code: 404 })
    core.createNamespacedService.mockRejectedValueOnce({ code: 503 })
    await expect((reconciler as any).ensureService(host)).resolves.toBeUndefined()
    expect(core.readNamespacedService).toHaveBeenCalledOnce()
    expect(core.createNamespacedService).toHaveBeenCalledOnce()
    expect(core.replaceNamespacedService).not.toHaveBeenCalled()
    expect(await count('Service', 'error')).toBe(1)
    expect(await count('Service', 'skipped')).toBe(0)
  })

  it('retains a Host Service convergence failure without recording a successful skip', async () => {
    const { core, reconciler } = fixture()
    core.replaceNamespacedService.mockRejectedValueOnce({ code: 503 })
    await expect((reconciler as any).ensureService(host)).resolves.toBeUndefined()
    expect(core.readNamespacedService).toHaveBeenCalledOnce()
    expect(core.createNamespacedService).not.toHaveBeenCalled()
    expect(core.replaceNamespacedService).toHaveBeenCalledOnce()
    expect(await count('Service', 'error')).toBe(0)
    expect(await count('Service', 'skipped')).toBe(0)
  })

  it('counts an equivalent present Host Service once without a POST or PUT', async () => {
    const { core, reconciler } = fixture()
    const desired = (reconciler as any).buildService(host) as k8s.V1Service
    core.readNamespacedService.mockResolvedValue(asApiserverService(desired))
    core.createNamespacedService.mockRejectedValue({ code: 409 })
    await (reconciler as any).ensureService(host)
    expect(core.readNamespacedService).toHaveBeenCalledOnce()
    expect(core.createNamespacedService).not.toHaveBeenCalled()
    expect(core.replaceNamespacedService).not.toHaveBeenCalled()
    expect(await count('Service', 'skipped')).toBe(1)
  })

  it('rejects an invalid channel-reader retry response before another PUT', async () => {
    const { apps, reconciler } = fixture()
    const stale = (reconciler as any).buildChannelReaderDeployment(
      host,
      'revision'
    ) as k8s.V1Deployment
    stale.metadata = { ...stale.metadata, resourceVersion: '1' }
    stale.spec!.template.spec!.containers[0].image = 'channel-reader:stale'
    apps.readNamespacedDeployment
      .mockResolvedValueOnce(stale)
      .mockResolvedValueOnce({ metadata: { resourceVersion: '2' } })
    apps.replaceNamespacedDeployment.mockRejectedValueOnce({ code: 409 })
    await expect((reconciler as any).reconcileChannelReaderDeployment(host)).rejects.toThrow(
      'metadata.name'
    )
    expect(apps.readNamespacedDeployment).toHaveBeenCalledTimes(2)
    expect(apps.replaceNamespacedDeployment).toHaveBeenCalledOnce()
    expect(apps.createNamespacedDeployment).not.toHaveBeenCalled()
    expect(await count('Deployment', 'skipped')).toBe(0)
  })

  it('counts a Host Service create race as conflict and never as skipped', async () => {
    const { core, reconciler } = fixture()
    core.readNamespacedService.mockRejectedValueOnce({ code: 404 })
    core.createNamespacedService.mockRejectedValueOnce({ code: 409 })
    await (reconciler as any).ensureService(host)
    expect(core.readNamespacedService).toHaveBeenCalledTimes(2)
    expect(core.createNamespacedService).toHaveBeenCalledOnce()
    expect(core.replaceNamespacedService).toHaveBeenCalledOnce()
    expect(core.replaceNamespacedService.mock.calls[0][0].body.metadata.resourceVersion).toBe('1')
    expect(await count('Service', 'conflict')).toBe(1)
    expect(await count('Service', 'skipped')).toBe(0)
  })
})
