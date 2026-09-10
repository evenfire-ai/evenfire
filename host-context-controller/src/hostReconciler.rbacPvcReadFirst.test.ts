import { beforeEach, describe, expect, it, vi } from 'vitest'
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
import { HostReconciler } from './hostReconciler'
import { CREATE_KINDS, createsTotal } from './metrics'
import type { HostCRD } from './types'

const host: HostCRD = {
  name: 'rbac-host',
  namespace: 'mcp-host',
  uid: 'host-uid',
  generation: 1,
  spec: { host: 'rbac-host', contextRef: 'context', secretRef: 'host-secret' },
}

function fixture() {
  const core = createMockCoreApi()
  const rbac = createMockRbacApi()
  const apps = createMockAppsApi()
  const reconciler = new HostReconciler(makeStubKc(), {
    coreApi: asCoreApi(core),
    appsApi: asAppsApi(apps),
    rbacApi: asRbacApi(rbac),
    customApi: asCustomApi(createMockCustomApi()),
    networkingApi: asNetworkingApi(createMockNetworkingApi()),
  })
  // A failing RBAC reconcile must not reach credential issuance. This canary
  // also keeps the negative-control mutation entirely local.
  const provision = vi
    .spyOn(reconciler as any, 'provisionRuntimeTokenRevision')
    .mockImplementation(() => {
      throw new Error('Downstream provisioning must not execute after an RBAC failure')
    })
  return { core, rbac, apps, reconciler, provision }
}

const rbacCases = ['ServiceAccount', 'Role', 'RoleBinding'] as const
type RbacKind = (typeof rbacCases)[number]
function operations(f: ReturnType<typeof fixture>, kind: RbacKind) {
  if (kind === 'ServiceAccount')
    return {
      read: f.core.readNamespacedServiceAccount,
      create: f.core.createNamespacedServiceAccount,
      method: 'ensureHostServiceAccount',
    }
  if (kind === 'Role')
    return {
      read: f.rbac.readNamespacedRole,
      create: f.rbac.createNamespacedRole,
      method: 'ensureHostRole',
    }
  return {
    read: f.rbac.readNamespacedRoleBinding,
    create: f.rbac.createNamespacedRoleBinding,
    method: 'ensureHostRoleBinding',
  }
}

async function count(kind: string, outcome: string) {
  const sample = (await createsTotal.get()).values.find(
    v => v.labels.kind === kind && v.labels.outcome === outcome
  )
  expect(sample).toBeDefined()
  return sample!.value
}

describe('Host read-first RBAC and PVC contracts', () => {
  beforeEach(() => {
    createsTotal.reset()
    for (const kind of CREATE_KINDS)
      for (const outcome of ['created', 'conflict', 'error', 'skipped'])
        createsTotal.inc({ kind, outcome }, 0)
  })

  it.each(rbacCases)('%s propagates initial GET403 without attempting a write', async kind => {
    const f = fixture()
    const { read, create, method } = operations(f, kind)
    const denied = { code: 403 }
    read.mockRejectedValueOnce(denied)
    await expect((f.reconciler as any)[method](host)).rejects.toBe(denied)
    expect(read).toHaveBeenCalledOnce()
    expect(create).not.toHaveBeenCalled()
    expect(f.rbac.replaceNamespacedRole).not.toHaveBeenCalled()
    expect(await count(kind, 'skipped')).toBe(0)
  })

  it.each(rbacCases)(
    '%s propagates an unexpected POST failure after observed absence',
    async kind => {
      const f = fixture()
      const { read, create, method } = operations(f, kind)
      const failure = { code: 503 }
      read.mockRejectedValueOnce({ code: 404 })
      create.mockRejectedValueOnce(failure)
      await expect((f.reconciler as any)[method](host)).rejects.toBe(failure)
      expect(read).toHaveBeenCalledOnce()
      expect(create).toHaveBeenCalledOnce()
      expect(f.rbac.replaceNamespacedRole).not.toHaveBeenCalled()
      expect(await count(kind, 'error')).toBe(1)
      expect(await count(kind, 'skipped')).toBe(0)
    }
  )

  it.each(rbacCases)('%s rereads after POST409 and propagates raced GET403', async kind => {
    const f = fixture()
    const { read, create, method } = operations(f, kind)
    const denied = { code: 403 }
    read.mockRejectedValueOnce({ code: 404 }).mockRejectedValueOnce(denied)
    create.mockRejectedValueOnce({ code: 409 })
    await expect((f.reconciler as any)[method](host)).rejects.toBe(denied)
    expect(read).toHaveBeenCalledTimes(2)
    expect(create).toHaveBeenCalledOnce()
    expect(f.rbac.replaceNamespacedRole).not.toHaveBeenCalled()
    expect(await count(kind, 'conflict')).toBe(1)
    expect(await count(kind, 'skipped')).toBe(0)
  })

  it.each(rbacCases)(
    '%s retains the benign POST409 then GET404 disappearance without a skip',
    async kind => {
      const f = fixture()
      const { read, create, method } = operations(f, kind)
      read.mockRejectedValueOnce({ code: 404 }).mockRejectedValueOnce({ code: 404 })
      create.mockRejectedValueOnce({ code: 409 })
      await expect((f.reconciler as any)[method](host)).resolves.toBeUndefined()
      expect(read).toHaveBeenCalledTimes(2)
      expect(create).toHaveBeenCalledOnce()
      expect(f.rbac.replaceNamespacedRole).not.toHaveBeenCalled()
      expect(await count(kind, 'conflict')).toBe(1)
      expect(await count(kind, 'skipped')).toBe(0)
    }
  )

  it.each(rbacCases)(
    '%s aborts the Host reconcile before downstream resources on failure',
    async kind => {
      const f = fixture()
      const { read, create } = operations(f, kind)
      const denied = { code: 403 }
      read.mockRejectedValueOnce(denied)
      const reportError = vi.spyOn(f.reconciler as any, 'enqueueControllerError')
      await expect(f.reconciler.reconcile(host)).rejects.toBe(denied)
      expect(read).toHaveBeenCalledOnce()
      expect(create).not.toHaveBeenCalled()
      expect(f.core.readNamespacedPersistentVolumeClaim).not.toHaveBeenCalled()
      expect(f.core.createNamespacedPersistentVolumeClaim).not.toHaveBeenCalled()
      expect(f.core.replaceNamespacedPersistentVolumeClaim).not.toHaveBeenCalled()
      expect(f.core.readNamespacedService).not.toHaveBeenCalled()
      expect(f.apps.createNamespacedDeployment).not.toHaveBeenCalled()
      expect(f.apps.replaceNamespacedDeployment).not.toHaveBeenCalled()
      expect(f.provision).not.toHaveBeenCalled()
      expect(reportError).toHaveBeenCalledWith(
        expect.objectContaining({ name: host.name }),
        'reconcile_exception',
        denied
      )
    }
  )

  it.each(['ServiceAccount', 'RoleBinding'] as const)(
    '%s preserves present state with one read and no PUT',
    async kind => {
      const f = fixture()
      const { read, create, method } = operations(f, kind)
      create.mockRejectedValue({ code: 409 })
      await (f.reconciler as any)[method](host)
      expect(read).toHaveBeenCalledOnce()
      expect(create).not.toHaveBeenCalled()
      expect(f.rbac.replaceNamespacedRole).not.toHaveBeenCalled()
      expect(await count(kind, 'skipped')).toBe(1)
    }
  )

  it.each(['ServiceAccount', 'Role', 'RoleBinding', 'PersistentVolumeClaim'] as const)(
    '%s rechecks admission after GET404',
    async kind => {
      const f = fixture()
      const op =
        kind === 'PersistentVolumeClaim'
          ? {
              read: f.core.readNamespacedPersistentVolumeClaim,
              create: f.core.createNamespacedPersistentVolumeClaim,
              method: 'ensurePvc',
            }
          : operations(f, kind)
      let current = true
      const retired = new Error('admission retired during existence read')
      const revalidate = vi.fn(() => {
        if (!current) throw retired
      })
      op.read.mockImplementationOnce(async () => {
        current = false
        throw { code: 404 }
      })
      await expect((f.reconciler as any)[op.method](host, revalidate)).rejects.toBe(retired)
      expect(op.read).toHaveBeenCalledOnce()
      expect(revalidate).toHaveBeenCalledTimes(2)
      expect(op.create).not.toHaveBeenCalled()
      expect(f.rbac.replaceNamespacedRole).not.toHaveBeenCalled()
      expect(f.core.replaceNamespacedPersistentVolumeClaim).not.toHaveBeenCalled()
      expect(await count(kind, 'skipped')).toBe(0)
    }
  )

  it('keeps Role PUT404 disappearance benign without counting a successful skip', async () => {
    const f = fixture()
    f.rbac.replaceNamespacedRole.mockRejectedValueOnce({ code: 404 })
    await expect((f.reconciler as any).ensureHostRole(host)).resolves.toBeUndefined()
    expect(f.rbac.readNamespacedRole).toHaveBeenCalledOnce()
    expect(f.rbac.replaceNamespacedRole).toHaveBeenCalledOnce()
    expect(f.rbac.createNamespacedRole).not.toHaveBeenCalled()
    expect(await count('Role', 'skipped')).toBe(0)
  })

  it.each([403, 500])('propagates Role PUT%d without retrying', async code => {
    const f = fixture()
    const failure = { code }
    f.rbac.replaceNamespacedRole.mockRejectedValueOnce(failure)
    await expect((f.reconciler as any).ensureHostRole(host)).rejects.toBe(failure)
    expect(f.rbac.readNamespacedRole).toHaveBeenCalledOnce()
    expect(f.rbac.replaceNamespacedRole).toHaveBeenCalledOnce()
    expect(f.rbac.createNamespacedRole).not.toHaveBeenCalled()
    expect(await count('Role', 'skipped')).toBe(0)
  })

  it('rereads a conflicted Role and replaces using the fresh resourceVersion', async () => {
    const f = fixture()
    f.rbac.readNamespacedRole
      .mockResolvedValueOnce({ metadata: { name: 'host-rbac-host', resourceVersion: '17' } })
      .mockResolvedValueOnce({ metadata: { name: 'host-rbac-host', resourceVersion: '18' } })
    f.rbac.replaceNamespacedRole.mockRejectedValueOnce({ code: 409 })
    await expect((f.reconciler as any).ensureHostRole(host)).resolves.toBeUndefined()
    expect(f.rbac.readNamespacedRole).toHaveBeenCalledTimes(2)
    expect(f.rbac.replaceNamespacedRole).toHaveBeenCalledTimes(2)
    expect(
      f.rbac.replaceNamespacedRole.mock.calls.map(
        ([request]) => request.body.metadata.resourceVersion
      )
    ).toEqual(['17', '18'])
    expect(f.rbac.createNamespacedRole).not.toHaveBeenCalled()
    expect(await count('Role', 'skipped')).toBe(1)
  })

  it('accepts a Role already converged by the competing writer after a conflict', async () => {
    const f = fixture()
    f.rbac.replaceNamespacedRole.mockImplementationOnce(async ({ body }) => {
      f.rbac.readNamespacedRole.mockResolvedValue({
        ...structuredClone(body),
        metadata: { ...body.metadata, resourceVersion: '18' },
      })
      throw { code: 409 }
    })
    await expect((f.reconciler as any).ensureHostRole(host)).resolves.toBeUndefined()
    expect(f.rbac.readNamespacedRole).toHaveBeenCalledTimes(2)
    expect(f.rbac.replaceNamespacedRole).toHaveBeenCalledOnce()
    expect(f.rbac.createNamespacedRole).not.toHaveBeenCalled()
    expect(await count('Role', 'skipped')).toBe(1)
  })

  it('propagates the final Role conflict after three attempts', async () => {
    const f = fixture()
    const failure = { code: 409 }
    f.rbac.replaceNamespacedRole.mockRejectedValue(failure)
    await expect((f.reconciler as any).ensureHostRole(host)).rejects.toBe(failure)
    expect(f.rbac.readNamespacedRole).toHaveBeenCalledTimes(3)
    expect(f.rbac.replaceNamespacedRole).toHaveBeenCalledTimes(3)
    expect(f.rbac.createNamespacedRole).not.toHaveBeenCalled()
    expect(await count('Role', 'skipped')).toBe(0)
  })

  it('rechecks admission before retrying a conflicted Role write', async () => {
    const f = fixture()
    let current = true
    const retired = new Error('Host spec changed while the Role write was in flight')
    retired.name = 'HostMutationSpecRevisionChangedError'
    const revalidate = () => {
      if (!current) throw retired
    }
    f.rbac.replaceNamespacedRole.mockImplementationOnce(async () => {
      current = false
      throw { code: 409 }
    })
    await expect((f.reconciler as any).ensureHostRole(host, revalidate)).rejects.toBe(retired)
    expect(f.rbac.replaceNamespacedRole).toHaveBeenCalledOnce()
    expect(f.rbac.createNamespacedRole).not.toHaveBeenCalled()
    expect(await count('Role', 'skipped')).toBe(0)
  })

  it('preserves a bound Host PVC without attempting an immutable update', async () => {
    const f = fixture()
    f.core.readNamespacedPersistentVolumeClaim.mockResolvedValueOnce({
      metadata: {
        name: 'rbac-host-workspace',
        namespace: host.namespace,
        uid: 'pvc-uid',
        resourceVersion: '17',
      },
      spec: { volumeName: 'bound-volume' },
    })
    await (f.reconciler as any).ensurePvc(host)
    expect(f.core.readNamespacedPersistentVolumeClaim).toHaveBeenCalledOnce()
    expect(f.core.createNamespacedPersistentVolumeClaim).not.toHaveBeenCalled()
    expect(f.core.replaceNamespacedPersistentVolumeClaim).not.toHaveBeenCalled()
    expect(await count('PersistentVolumeClaim', 'skipped')).toBe(1)
  })

  it('updates an unbound Host PVC once with its observed resourceVersion', async () => {
    const f = fixture()
    await (f.reconciler as any).ensurePvc(host)
    expect(f.core.readNamespacedPersistentVolumeClaim).toHaveBeenCalledOnce()
    expect(f.core.createNamespacedPersistentVolumeClaim).not.toHaveBeenCalled()
    expect(f.core.replaceNamespacedPersistentVolumeClaim).toHaveBeenCalledOnce()
    expect(
      f.core.replaceNamespacedPersistentVolumeClaim.mock.calls[0][0].body.metadata.resourceVersion
    ).toBe('1')
    expect(await count('PersistentVolumeClaim', 'skipped')).toBe(1)
  })

  it('propagates a Host PVC initial GET failure outside retained write catches', async () => {
    const f = fixture()
    const failure = { code: 403 }
    f.core.readNamespacedPersistentVolumeClaim.mockRejectedValueOnce(failure)
    await expect((f.reconciler as any).ensurePvc(host)).rejects.toBe(failure)
    expect(f.core.readNamespacedPersistentVolumeClaim).toHaveBeenCalledOnce()
    expect(f.core.createNamespacedPersistentVolumeClaim).not.toHaveBeenCalled()
    expect(f.core.replaceNamespacedPersistentVolumeClaim).not.toHaveBeenCalled()
    expect(await count('PersistentVolumeClaim', 'skipped')).toBe(0)
  })

  it('retains the Host PVC POST failure without recording a skip', async () => {
    const f = fixture()
    f.core.readNamespacedPersistentVolumeClaim.mockRejectedValueOnce({ code: 404 })
    f.core.createNamespacedPersistentVolumeClaim.mockRejectedValueOnce({ code: 503 })
    await expect((f.reconciler as any).ensurePvc(host)).resolves.toBeUndefined()
    expect(f.core.readNamespacedPersistentVolumeClaim).toHaveBeenCalledOnce()
    expect(f.core.createNamespacedPersistentVolumeClaim).toHaveBeenCalledOnce()
    expect(f.core.replaceNamespacedPersistentVolumeClaim).not.toHaveBeenCalled()
    expect(await count('PersistentVolumeClaim', 'error')).toBe(1)
    expect(await count('PersistentVolumeClaim', 'skipped')).toBe(0)
  })

  it.each([409, 503])('retains Host PVC PUT%d without retrying or recording a skip', async code => {
    const f = fixture()
    f.core.replaceNamespacedPersistentVolumeClaim.mockRejectedValueOnce({ code })
    await expect((f.reconciler as any).ensurePvc(host)).resolves.toBeUndefined()
    expect(f.core.readNamespacedPersistentVolumeClaim).toHaveBeenCalledOnce()
    expect(f.core.replaceNamespacedPersistentVolumeClaim).toHaveBeenCalledOnce()
    expect(f.core.createNamespacedPersistentVolumeClaim).not.toHaveBeenCalled()
    expect(await count('PersistentVolumeClaim', 'skipped')).toBe(0)
  })
})
