import { describe, expect, it, vi } from 'vitest'
import type { WorkflowRecipeCRD } from '../types'
import { readMcpHostPod, sdkLivenessNeedsReconcile } from './mcpHostProbe'

const sdk = (state?: string, uid: string | null = 'pod-1', steps = 0): WorkflowRecipeCRD =>
  ({
    apiVersion: 'clerum.io/v1alpha1',
    kind: 'WorkflowRecipe',
    metadata: { name: 'r', namespace: 'sandbox-recipes', uid: 'u' },
    spec: {
      steps: Array.from({ length: steps }, (_, i) => ({ id: `s${i}` })),
      workloads: [],
      pluginWorkloadSdk: {},
    },
    status: {
      phase: 'active',
      ...(state
        ? {
            pluginWorkloadSdk: {
              state,
              bootstrapPodUid: uid,
              promptBridge: true,
              clientNotifications: false,
            },
          }
        : {}),
    },
  }) as unknown as WorkflowRecipeCRD
const running = { kind: 'present', phase: 'Running', uid: 'pod-1', deleting: false } as const

describe('readMcpHostPod', () => {
  it('reads `${name}-mcp-host` in the given namespace and maps 404 to absent', async () => {
    const readNamespacedPod = vi.fn().mockRejectedValue({ code: 404 })
    const res = await readMcpHostPod({ readNamespacedPod } as never, 'r', 'sandbox-recipes')
    expect(readNamespacedPod).toHaveBeenCalledWith({
      name: 'r-mcp-host',
      namespace: 'sandbox-recipes',
    })
    expect(res).toEqual({ kind: 'absent' })
  })
  it('returns phase, uid and deletion state', async () => {
    const readNamespacedPod = vi.fn().mockResolvedValue({
      metadata: { uid: 'pod-1', deletionTimestamp: new Date() },
      status: { phase: 'Running' },
    })
    expect(await readMcpHostPod({ readNamespacedPod } as never, 'r', 'ns')).toEqual({
      kind: 'present',
      phase: 'Running',
      uid: 'pod-1',
      deleting: true,
    })
  })
  it('rethrows non-404 errors', async () => {
    const readNamespacedPod = vi.fn().mockRejectedValue({ code: 500 })
    await expect(readMcpHostPod({ readNamespacedPod } as never, 'r', 'ns')).rejects.toBeDefined()
  })
})

describe('sdkLivenessNeedsReconcile', () => {
  it('healthy validated pod with matching uid is clean', () => {
    expect(sdkLivenessNeedsReconcile(sdk('validated'), running)).toBe(false)
  })
  it.each([
    ['absent', sdk('validated'), { kind: 'absent' }],
    ['Failed', sdk('validated'), { ...running, phase: 'Failed' }],
    ['deleting', sdk('validated'), { ...running, deleting: true }],
    ['uid mismatch', sdk('validated', 'pod-OLD'), running],
    ['awaiting_policy', sdk('awaiting_policy'), running],
    ['degraded', sdk('degraded'), running],
    ['no state', sdk(undefined), running],
  ])('escalates when %s', (_n, r, pod) => {
    expect(sdkLivenessNeedsReconcile(r as WorkflowRecipeCRD, pod as never)).toBe(true)
  })
  it('validated with null bootstrapPodUid does not compare uids', () => {
    expect(sdkLivenessNeedsReconcile(sdk('validated', null), running)).toBe(false)
  })
  it('disabled: stepless absent is clean, stepless present escalates, SDK workflow is clean', () => {
    expect(sdkLivenessNeedsReconcile(sdk('disabled'), { kind: 'absent' })).toBe(false)
    expect(sdkLivenessNeedsReconcile(sdk('disabled'), running)).toBe(true)
    expect(sdkLivenessNeedsReconcile(sdk('disabled', 'pod-1', 1), running)).toBe(false)
  })
})
