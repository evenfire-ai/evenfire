import { afterEach, describe, expect, it, vi } from 'vitest'
import type { SharedFileSystemCRD } from '../types'

// k8sClient.ts builds this reconciler with no factoryConfig, so production runs
// defaultFactoryConfig(). Every other suite injects a factoryConfig and cannot see
// what that function does to a value on its way from config to the Deployment.

const originalEnv = process.env

const sfs: SharedFileSystemCRD = {
  name: 'team-mission',
  namespace: 'mcp-host',
  spec: {
    size: '5Gi',
    directories: ['docs'],
    security: { runAsUser: 1000, runAsGroup: 1000, fsGroup: 1000 },
  },
}

const notFound = () => Object.assign(new Error('not found'), { code: 404 })

async function wfcPodSpecFor(pullSecret: string | undefined) {
  vi.resetModules()
  process.env = { ...originalEnv, CONTEXT_MAPPER_WFC_IMAGE: 'registry.test/wfc:head' }
  delete process.env.CONTEXT_MAPPER_WFC_IMAGE_PULL_SECRET
  if (pullSecret !== undefined) process.env.CONTEXT_MAPPER_WFC_IMAGE_PULL_SECRET = pullSecret

  const { SharedFileSystemReconciler } = await import('../sharedFileSystemReconciler')
  const createNamespacedDeployment = vi.fn().mockResolvedValue({})
  const missing = () => vi.fn().mockRejectedValue(notFound())
  const created = () => vi.fn().mockResolvedValue({})
  const reconciler = new SharedFileSystemReconciler(null, {
    /* eslint-disable @typescript-eslint/no-explicit-any */
    appsApi: { readNamespacedDeployment: missing(), createNamespacedDeployment } as any,
    coreApi: {
      readNamespacedPersistentVolumeClaim: missing(),
      createNamespacedPersistentVolumeClaim: created(),
      readNamespacedService: missing(),
      createNamespacedService: created(),
      listNamespacedPod: vi.fn().mockResolvedValue({ items: [] }),
    } as any,
    batchApi: { listNamespacedJob: vi.fn().mockResolvedValue({ items: [] }) } as any,
    networkingApi: {
      readNamespacedNetworkPolicy: missing(),
      createNamespacedNetworkPolicy: created(),
    } as any,
    customApi: { patchNamespacedCustomObjectStatus: created() } as any,
    /* eslint-enable @typescript-eslint/no-explicit-any */
  })

  await reconciler.reconcile(sfs)

  expect(createNamespacedDeployment).toHaveBeenCalledOnce()
  return createNamespacedDeployment.mock.calls[0][0].body.spec.template.spec
}

afterEach(() => {
  process.env = originalEnv
  vi.resetModules()
})

describe('SharedFileSystemReconciler default factory config', () => {
  it('sends no imagePullSecrets when the variable is unset', async () => {
    const podSpec = await wfcPodSpecFor(undefined)
    expect(podSpec.imagePullSecrets).toBeUndefined()
    // Witness: this Deployment was built from the real config.
    expect(podSpec.containers[0].image).toBe('registry.test/wfc:head')
  })

  it('sends the configured pull Secret', async () => {
    const podSpec = await wfcPodSpecFor('wfc-regcred')
    expect(podSpec.imagePullSecrets).toEqual([{ name: 'wfc-regcred' }])
  })
})
