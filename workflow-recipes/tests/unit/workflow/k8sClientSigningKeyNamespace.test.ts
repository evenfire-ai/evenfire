import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import * as k8s from '@kubernetes/client-node'
import { WorkflowRecipeWatcher } from '../../../src/k8sClient'

// ─── Mock K8s client ────────────────────────────────────────────────
//
// The signing-key initialization path reads the WRC signing-key Secret via
// CoreV1Api.readNamespacedSecret. We return a Secret WITHOUT the private.pem
// key so tryInitializeWorkflow short-circuits after the read (no real JWT
// init), letting us assert purely on the namespace argument of the read.

const mockCoreApi = {
  readNamespacedSecret: vi.fn().mockResolvedValue({ data: {} }),
}

const mockAppsApi = {}
const mockBatchApi = {}
const mockCustomApi = {}
const mockNetworkingApi = {}

vi.mock('@kubernetes/client-node', () => ({
  KubeConfig: vi.fn().mockImplementation(() => ({
    makeApiClient: vi.fn().mockImplementation((ApiClass: unknown) => {
      const name = (ApiClass as { name: string }).name
      if (name === 'AppsV1Api') return mockAppsApi
      if (name === 'BatchV1Api') return mockBatchApi
      if (name === 'CustomObjectsApi') return mockCustomApi
      if (name === 'NetworkingV1Api') return mockNetworkingApi
      return mockCoreApi
    }),
  })),
  Watch: vi.fn().mockImplementation(() => ({})),
  AppsV1Api: { name: 'AppsV1Api' },
  BatchV1Api: { name: 'BatchV1Api' },
  CoreV1Api: { name: 'CoreV1Api' },
  CustomObjectsApi: { name: 'CustomObjectsApi' },
  NetworkingV1Api: { name: 'NetworkingV1Api' },
  setHeaderMiddleware: vi.fn(() => ({})),
}))

describe('WorkflowRecipeWatcher signing-key namespace', () => {
  const originalNs = process.env.WRC_CONTROL_PLANE_NAMESPACE

  beforeEach(() => {
    mockCoreApi.readNamespacedSecret.mockClear()
  })

  afterEach(() => {
    if (originalNs === undefined) {
      delete process.env.WRC_CONTROL_PLANE_NAMESPACE
    } else {
      process.env.WRC_CONTROL_PLANE_NAMESPACE = originalNs
    }
  })

  it('reads the signing-key Secret from config.controlPlaneNamespace (per-tenant)', async () => {
    process.env.WRC_CONTROL_PLANE_NAMESPACE = 'control-plane-acme'

    const kc = new k8s.KubeConfig()
    const watcher = new WorkflowRecipeWatcher(kc)

    await (
      watcher as unknown as { tryInitializeWorkflow: () => Promise<void> }
    ).tryInitializeWorkflow()

    expect(mockCoreApi.readNamespacedSecret).toHaveBeenCalledWith({
      name: 'clerum-wrc-signing-key',
      namespace: 'control-plane-acme',
    })
  })

  it('defaults to control-plane when WRC_CONTROL_PLANE_NAMESPACE is unset', async () => {
    delete process.env.WRC_CONTROL_PLANE_NAMESPACE

    const kc = new k8s.KubeConfig()
    const watcher = new WorkflowRecipeWatcher(kc)

    await (
      watcher as unknown as { tryInitializeWorkflow: () => Promise<void> }
    ).tryInitializeWorkflow()

    expect(mockCoreApi.readNamespacedSecret).toHaveBeenCalledWith({
      name: 'clerum-wrc-signing-key',
      namespace: 'control-plane',
    })
  })
})
