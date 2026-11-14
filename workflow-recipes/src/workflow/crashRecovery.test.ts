import { describe, expect, it, vi } from 'vitest'
import {
  evaluateCompletedRuntimePodRecovery,
  evaluateCrashRecovery,
  getPodPresence,
  getPodReadiness,
  inspectPodReadiness,
  waitForPodDeletion,
} from './crashRecovery'

describe('crash recovery pod readiness classification', () => {
  it('treats scheduling Pending without a container waiting reason as recoverable wait', () => {
    expect(evaluateCrashRecovery('Pending', { phase: 'initializing' })).toEqual({
      action: 'none',
      message: 'Pod is healthy',
    })
  })

  it('keeps image pull Pending failures bounded by replacement attempts', () => {
    expect(
      evaluateCrashRecovery('Pending', { phase: 'recovering', attempt: 2 }, 'ImagePullBackOff')
    ).toMatchObject({
      action: 'replace',
      newPhase: 'recovering',
      newAttempt: 3,
    })
    expect(
      evaluateCrashRecovery('Pending', { phase: 'recovering', attempt: 3 }, 'ImagePullBackOff')
    ).toMatchObject({
      action: 'fail',
      newPhase: 'failed',
    })
  })

  it('keeps Running CrashLoopBackOff pods bounded by replacement attempts', () => {
    expect(
      evaluateCrashRecovery('Running', { phase: 'recovering', attempt: 2 }, 'CrashLoopBackOff')
    ).toMatchObject({
      action: 'replace',
      newPhase: 'recovering',
      newAttempt: 3,
    })
    expect(
      evaluateCrashRecovery('Running', { phase: 'recovering', attempt: 3 }, 'CrashLoopBackOff')
    ).toMatchObject({
      action: 'fail',
      newPhase: 'failed',
    })
  })

  it('keeps completed runtime pods bounded by replacement attempts', () => {
    expect(
      evaluateCompletedRuntimePodRecovery({ phase: 'recovering', attempt: 2 }, 'mcp_host')
    ).toMatchObject({
      action: 'replace',
      newPhase: 'recovering',
      newAttempt: 3,
    })
    expect(
      evaluateCompletedRuntimePodRecovery({ phase: 'recovering', attempt: 3 }, 'mcp_host')
    ).toMatchObject({
      action: 'fail',
      newPhase: 'failed',
    })
  })

  it('extracts readiness and scheduling details from a Pending pod', () => {
    expect(
      inspectPodReadiness({
        status: {
          phase: 'Pending',
          conditions: [
            {
              type: 'PodScheduled',
              status: 'False',
              reason: 'Unschedulable',
              message: '0/3 nodes are available',
            },
          ],
        },
      })
    ).toEqual({
      kind: 'present',
      phase: 'Pending',
      ready: false,
      schedulingReason: 'Unschedulable',
    })
  })

  it('requires the Ready condition, not only Running phase', () => {
    expect(
      inspectPodReadiness({
        status: {
          phase: 'Running',
          conditions: [{ type: 'Ready', status: 'False' }],
        },
      })
    ).toEqual({
      kind: 'present',
      phase: 'Running',
      ready: false,
    })

    expect(
      inspectPodReadiness({
        status: {
          phase: 'Running',
          conditions: [{ type: 'Ready', status: 'True' }],
        },
      })
    ).toEqual({
      kind: 'present',
      phase: 'Running',
      ready: true,
    })
  })

  it('reports when the pod was created and when its deletion is due', () => {
    const status = { phase: 'Running', conditions: [{ type: 'Ready', status: 'False' }] }

    expect(
      inspectPodReadiness({
        metadata: { uid: 'pod-uid-2', creationTimestamp: new Date('2026-11-13T10:00:00.000Z') },
        status,
      })
    ).toEqual({
      kind: 'present',
      phase: 'Running',
      ready: false,
      uid: 'pod-uid-2',
      createdAt: '2026-11-13T10:00:00.000Z',
    })

    expect(
      inspectPodReadiness({
        metadata: {
          uid: 'pod-uid-2',
          creationTimestamp: new Date('2026-11-13T10:00:00.000Z'),
          deletionTimestamp: new Date('2026-11-13T10:05:30.000Z'),
        },
        status,
      })
    ).toEqual({
      kind: 'terminating',
      phase: 'Running',
      ready: false,
      uid: 'pod-uid-2',
      createdAt: '2026-11-13T10:00:00.000Z',
      deletingAt: '2026-11-13T10:05:30.000Z',
    })
  })
})

describe('inspectPodReadiness on a pod that is being deleted', () => {
  it('never reports a pod with a deletionTimestamp ready, even while its Ready condition is True', () => {
    const status = { phase: 'Running', conditions: [{ type: 'Ready', status: 'True' }] }
    const metadata = { uid: 'pod-uid-4', creationTimestamp: new Date('2026-11-13T10:00:00.000Z') }

    // Control: the same pod is ready while it is not being deleted.
    expect(inspectPodReadiness({ metadata, status })).toEqual({
      kind: 'present',
      phase: 'Running',
      ready: true,
      uid: 'pod-uid-4',
      createdAt: '2026-11-13T10:00:00.000Z',
    })

    expect(
      inspectPodReadiness({
        metadata: { ...metadata, deletionTimestamp: new Date('2026-11-13T10:05:30.000Z') },
        status,
      })
    ).toEqual({
      kind: 'terminating',
      phase: 'Running',
      ready: false,
      uid: 'pod-uid-4',
      createdAt: '2026-11-13T10:00:00.000Z',
      deletingAt: '2026-11-13T10:05:30.000Z',
    })
  })
})

describe('getPodReadiness', () => {
  it('returns the absent state on GET 404 and the inspected pod on GET 200', async () => {
    const readNamespacedPod = vi
      .fn()
      .mockRejectedValueOnce({ code: 404 })
      .mockResolvedValueOnce({
        metadata: { uid: 'pod-uid-3', creationTimestamp: new Date('2026-11-13T10:00:00.000Z') },
        status: { phase: 'Pending' },
      })
    const coreApi = { readNamespacedPod } as unknown as Parameters<typeof getPodReadiness>[0]

    await expect(getPodReadiness(coreApi, 'recipe-mcp-host', 'sandbox-recipes')).resolves.toEqual({
      kind: 'absent',
      ready: false,
    })
    await expect(getPodReadiness(coreApi, 'recipe-mcp-host', 'sandbox-recipes')).resolves.toEqual({
      kind: 'present',
      phase: 'Pending',
      ready: false,
      uid: 'pod-uid-3',
      createdAt: '2026-11-13T10:00:00.000Z',
    })
    expect(readNamespacedPod).toHaveBeenCalledTimes(2)
  })

  it.each([403, 500])('rethrows a GET %i instead of reporting the pod absent', async code => {
    const readNamespacedPod = vi.fn().mockRejectedValueOnce({ code })
    const coreApi = { readNamespacedPod } as unknown as Parameters<typeof getPodReadiness>[0]

    await expect(
      getPodReadiness(coreApi, 'recipe-mcp-host', 'sandbox-recipes')
    ).rejects.toMatchObject({ code })
  })
})

describe('getPodPresence', () => {
  it('returns absent on GET 404 and present on GET 200 with empty status', async () => {
    const readNamespacedPod = vi
      .fn()
      .mockRejectedValueOnce({ code: 404 })
      .mockResolvedValueOnce({ metadata: { name: 'recipe-coordinator' }, status: {} })
    const coreApi = { readNamespacedPod } as unknown as Parameters<typeof getPodPresence>[0]

    await expect(getPodPresence(coreApi, 'recipe-coordinator', 'sandbox-recipes')).resolves.toEqual(
      {
        kind: 'absent',
      }
    )
    await expect(getPodPresence(coreApi, 'recipe-coordinator', 'sandbox-recipes')).resolves.toEqual(
      {
        kind: 'present',
        phase: undefined,
      }
    )
  })

  it.each([403, 500])('rethrows a GET %i instead of reporting the pod absent', async code => {
    const readNamespacedPod = vi.fn().mockRejectedValueOnce({ code })
    const coreApi = { readNamespacedPod } as unknown as Parameters<typeof getPodPresence>[0]

    await expect(
      getPodPresence(coreApi, 'recipe-coordinator', 'sandbox-recipes')
    ).rejects.toMatchObject({ code })
    expect(readNamespacedPod).toHaveBeenCalledWith({
      name: 'recipe-coordinator',
      namespace: 'sandbox-recipes',
    })
  })
})

describe('waitForPodDeletion', () => {
  it('returns true once getPodPresence reports the pod is gone', async () => {
    const readNamespacedPod = vi
      .fn()
      .mockResolvedValueOnce({ status: { phase: 'Running' } })
      .mockRejectedValueOnce({ response: { statusCode: 404 } })
    const coreApi = {
      readNamespacedPod,
    } as unknown as Parameters<typeof waitForPodDeletion>[0]

    await expect(
      waitForPodDeletion(coreApi, 'recipe-mcp-host', 'sandbox-recipes', {
        timeoutMs: 1_000,
        pollIntervalMs: 1,
      })
    ).resolves.toBe(true)
    expect(readNamespacedPod).toHaveBeenCalledTimes(2)
  })

  it('does not treat a GET 200 with empty status.phase as deleted', async () => {
    const readNamespacedPod = vi
      .fn()
      .mockResolvedValue({ metadata: { name: 'recipe-mcp-host' }, status: {} })
    const coreApi = {
      readNamespacedPod,
    } as unknown as Parameters<typeof waitForPodDeletion>[0]

    await expect(
      waitForPodDeletion(coreApi, 'recipe-mcp-host', 'sandbox-recipes', {
        timeoutMs: 20,
        pollIntervalMs: 5,
      })
    ).resolves.toBe(false)
    // Liveness witness: `false` also results if the wait never polled. Several GETs
    // that each answered 200 show it kept looking until the timeout.
    expect(readNamespacedPod.mock.calls.length).toBeGreaterThan(1)
  })
})
