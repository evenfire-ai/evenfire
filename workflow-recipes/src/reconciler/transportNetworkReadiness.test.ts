import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import * as k8s from '@kubernetes/client-node'
import type { WorkflowRecipeCRD } from '../types'
import { WorkflowRecipeReconciler } from './workflowRecipeReconciler'

// Pins the documented per-transport ordering contract in
// docs/crds/workflowrecipe.md ("Pod scheduling and NetworkPolicy ordering").
// Only the external-egress path blocks; the stdio path warns and proceeds, and
// the HTTP-without-egress path never waits at all. Before these tests the
// continue-anyway branch was implemented but unverified: deleting the wait
// entirely left the suite green, so the doc claim had nothing holding it up.

// vi.hoisted: vi.mock factories are lifted above the imports, so anything they
// close over must be initialized up there too.
const { mockWaitForNetworkReady, mockWaitForExternalEgressReady, mockApi } = vi.hoisted(() => ({
  mockWaitForNetworkReady: vi.fn(),
  mockWaitForExternalEgressReady: vi.fn(),
  mockApi: new Proxy({}, { get: () => vi.fn().mockResolvedValue({}) }),
}))

vi.mock('./mcpDelegation', async importOriginal => {
  const actual = await importOriginal<typeof import('./mcpDelegation')>()
  return {
    ...actual,
    waitForNetworkReady: mockWaitForNetworkReady,
    waitForExternalEgressReady: mockWaitForExternalEgressReady,
  }
})

vi.mock('@kubernetes/client-node', () => ({
  KubeConfig: vi.fn().mockImplementation(() => ({
    makeApiClient: vi.fn().mockImplementation(() => mockApi),
  })),
  AppsV1Api: { name: 'AppsV1Api' },
  BatchV1Api: { name: 'BatchV1Api' },
  CoreV1Api: { name: 'CoreV1Api' },
  CustomObjectsApi: { name: 'CustomObjectsApi' },
  NetworkingV1Api: { name: 'NetworkingV1Api' },
  setHeaderMiddleware: vi.fn(() => ({})),
}))

const NAMESPACE = 'sandbox-recipes'

// `stdio` transport with no egressBindings -> generic (waits, then proceeds).
// `streamableHttp` with egressBindings   -> external (waits, then throws).
// `streamableHttp` with no egressBindings -> neither bucket (never waits).
function makeRecipe(workloads: WorkflowRecipeCRD['spec']['workloads']): WorkflowRecipeCRD {
  return {
    apiVersion: 'clerum.io/v1alpha1',
    kind: 'WorkflowRecipe',
    metadata: { name: 'test-recipe', namespace: NAMESPACE, uid: 'uid-123' },
    spec: { workloads },
  } as WorkflowRecipeCRD
}

function reconciler() {
  const instance = new WorkflowRecipeReconciler(new k8s.KubeConfig())
  return instance as unknown as {
    waitForTransportNetworkReadiness(
      recipe: WorkflowRecipeCRD,
      preDeployedServers: string[],
      namespace: string
    ): Promise<void>
  }
}

describe('waitForTransportNetworkReadiness: per-transport ordering contract', () => {
  let warn: ReturnType<typeof vi.spyOn>

  beforeEach(() => {
    mockWaitForNetworkReady.mockReset()
    mockWaitForExternalEgressReady.mockReset()
    warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
  })

  afterEach(() => {
    // Restore only the spy created here: vi.restoreAllMocks() would also strip the
    // KubeConfig mock implementation installed by the module factory above.
    warn.mockRestore()
  })

  it('proceeds and warns when a generic stdio workload never confirms network-ready', async () => {
    mockWaitForNetworkReady.mockResolvedValue({ ready: false, pending: ['test-recipe-tool'] })
    const recipe = makeRecipe([
      { id: 'tool', type: 'deployment', image: 'busybox:1.36', transport: { type: 'stdio' } },
    ])

    await expect(
      reconciler().waitForTransportNetworkReadiness(recipe, ['test-recipe-tool'], NAMESPACE)
    ).resolves.toBeUndefined()

    expect(mockWaitForNetworkReady).toHaveBeenCalledTimes(1)
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('test-recipe-tool'))
  })

  it('does not warn when the generic stdio workload does confirm network-ready', async () => {
    mockWaitForNetworkReady.mockResolvedValue({ ready: true, pending: [] })
    const recipe = makeRecipe([
      { id: 'tool', type: 'deployment', image: 'busybox:1.36', transport: { type: 'stdio' } },
    ])

    await reconciler().waitForTransportNetworkReadiness(recipe, ['test-recipe-tool'], NAMESPACE)

    expect(warn).not.toHaveBeenCalled()
  })

  it('throws and creates nothing when an external-egress workload is not ready', async () => {
    mockWaitForExternalEgressReady.mockResolvedValue({
      ready: false,
      pending: ['test-recipe-api'],
      failed: [],
    })
    const recipe = makeRecipe([
      {
        id: 'api',
        type: 'deployment',
        image: 'busybox:1.36',
        transport: { type: 'streamableHttp', path: '/mcp' },
        egressBindings: [{ dns: 'api.example.com', port: 443 }],
      },
    ])

    await expect(
      reconciler().waitForTransportNetworkReadiness(recipe, ['test-recipe-api'], NAMESPACE)
    ).rejects.toThrow(/External egress policy readiness not achieved/)
  })

  it('never waits for an HTTP workload that declares no external egress', async () => {
    const recipe = makeRecipe([
      {
        id: 'api',
        type: 'deployment',
        image: 'busybox:1.36',
        transport: { type: 'streamableHttp', path: '/mcp' },
      },
    ])

    await reconciler().waitForTransportNetworkReadiness(recipe, ['test-recipe-api'], NAMESPACE)

    expect(mockWaitForNetworkReady).not.toHaveBeenCalled()
    expect(mockWaitForExternalEgressReady).not.toHaveBeenCalled()
    expect(warn).not.toHaveBeenCalled()
  })

  it('returns immediately when there are no pre-deployed servers', async () => {
    await reconciler().waitForTransportNetworkReadiness(makeRecipe([]), [], NAMESPACE)

    expect(mockWaitForNetworkReady).not.toHaveBeenCalled()
    expect(mockWaitForExternalEgressReady).not.toHaveBeenCalled()
  })
})
