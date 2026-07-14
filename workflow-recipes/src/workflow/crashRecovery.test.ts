import { describe, expect, it, vi } from 'vitest'
import {
  evaluateCompletedRuntimePodRecovery,
  evaluateCrashRecovery,
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
      phase: 'Running',
      ready: true,
    })
  })
})

describe('waitForPodDeletion', () => {
  it('returns true once getPodPhase reports the pod is gone', async () => {
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
})
