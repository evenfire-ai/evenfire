import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, renderHook } from '@testing-library/react'
import type { RolloutWaitOptions } from '@components/UpdateConnectorCredentials/types'
import { useRolloutWait } from '@components/UpdateConnectorCredentials/useRolloutWait'
import { POLL_INTERVAL_MS, POLL_TIMEOUT_MS } from '@constants/connectorCredentials'
import { getMcpServer } from '@lib/api'
import type { McpServerResource } from '@lib/api'

vi.mock('@lib/api', () => ({ getMcpServer: vi.fn() }))
const cutoff = '2026-10-23T12:00:00.000Z'
const target: RolloutWaitOptions = {
  serverName: 'connector',
  cutoff,
  expectedUid: 'uid',
  expectedGeneration: 3,
}
function response(
  status: 'True' | 'False' = 'True',
  options: {
    generation?: number
    observedGeneration?: number
    timestamp?: string
    reason?: string
    uid?: string
  } = {}
): McpServerResource {
  return {
    metadata: { uid: options.uid ?? 'uid', generation: options.generation ?? 3 },
    status: {
      conditions: [
        {
          type: 'DeploymentReady',
          status,
          reason: options.reason ?? (status === 'True' ? 'ReplicasAvailable' : 'RolloutIncomplete'),
          message: 'updated 0/1',
          lastTransitionTime: options.timestamp ?? '2026-10-23T12:00:01.000Z',
          observedGeneration: options.observedGeneration ?? 3,
        },
      ],
    },
  }
}
function start(options: RolloutWaitOptions = target) {
  const hook = renderHook(props => useRolloutWait(props), { initialProps: options })
  act(() => hook.result.current.setPhase('rotating'))
  return hook
}
async function tick(ms = POLL_INTERVAL_MS) {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms)
  })
}
beforeEach(() => {
  vi.useFakeTimers()
  vi.setSystemTime(cutoff)
  vi.resetAllMocks()
  vi.mocked(getMcpServer).mockResolvedValue({
    metadata: { uid: 'uid', generation: 3 },
    status: { conditions: [] },
  })
})
afterEach(() => {
  cleanup()
  vi.useRealTimers()
})

describe('shared rollout observation', () => {
  it('succeeds only with a fresh True for the exact attach generation and UID', async () => {
    vi.mocked(getMcpServer)
      .mockResolvedValueOnce(response('True', { observedGeneration: 2 }))
      .mockResolvedValueOnce(response('True', { timestamp: cutoff }))
      .mockResolvedValueOnce(response())
    const hook = start()
    await tick()
    expect(hook.result.current.phase).toBe('rotating')
    await tick()
    expect(hook.result.current.phase).toBe('rotating')
    await tick()
    expect(hook.result.current.phase).toBe('success')
  })
  it('does not accept missing generation metadata', async () => {
    const missing = response()
    delete missing.metadata.generation
    vi.mocked(getMcpServer).mockResolvedValue(missing)
    const hook = start()
    await tick(POLL_TIMEOUT_MS)
    expect(hook.result.current.phase).toBe('timeout')
  })
  it('does not accept a missing condition observedGeneration', async () => {
    const missing = response()
    delete missing.status.conditions[0].observedGeneration
    vi.mocked(getMcpServer).mockResolvedValue(missing)
    const hook = start()
    await tick()
    expect(hook.result.current.phase).toBe('rotating')
  })
  it.each([{ uid: 'replacement' }, { generation: 4 }])(
    'requires refresh when identity/spec changes %j',
    async changed => {
      vi.mocked(getMcpServer).mockResolvedValue(response('True', changed))
      const hook = start()
      await tick()
      expect(hook.result.current.phase).toBe('failed')
      expect(hook.result.current.phaseMessage).toContain('Refresh')
    }
  )
  it('preserves timestamp-only rotation behavior', async () => {
    const oldProducer = response()
    delete oldProducer.metadata
    delete oldProducer.status.conditions[0].observedGeneration
    vi.mocked(getMcpServer).mockResolvedValue(oldProducer)
    const hook = start({ serverName: 'connector', cutoff })
    await tick()
    expect(hook.result.current.phase).toBe('success')
  })
  it('keeps polling through transient False and RolloutIncomplete, then accepts recovery', async () => {
    vi.mocked(getMcpServer)
      .mockResolvedValueOnce(response('False', { reason: 'WaitingForReplicas' }))
      .mockResolvedValueOnce(response('False'))
      .mockResolvedValue(response())
    const hook = start()
    await tick()
    expect(hook.result.current.phase).toBe('rotating')
    await tick()
    expect(hook.result.current.phase).toBe('rotating')
    await tick()
    expect(hook.result.current.phase).toBe('success')
  })
  it('keeps the HCC diagnostic until its own timeout, including read failures', async () => {
    vi.mocked(getMcpServer)
      .mockResolvedValueOnce(response('False'))
      .mockRejectedValue(new Error('unavailable'))
    const hook = start()
    await tick()
    expect(hook.result.current.phase).toBe('rotating')
    await tick(POLL_TIMEOUT_MS - POLL_INTERVAL_MS)
    expect(hook.result.current.phase).toBe('failed')
    expect(hook.result.current.phaseMessage).toBe('updated 0/1')
  })
  it('distinguishes an inconclusive timeout from a diagnosed failure', async () => {
    const hook = start()
    await tick(POLL_TIMEOUT_MS)
    expect(hook.result.current.phase).toBe('timeout')
  })
  it('ignores a read completing after the timeout', async () => {
    let resolve: (value: McpServerResource) => void
    vi.mocked(getMcpServer).mockImplementation(
      () =>
        new Promise(done => {
          resolve = done
        })
    )
    const hook = start()
    await tick(POLL_TIMEOUT_MS)
    await act(async () => {
      resolve(response())
    })
    expect(hook.result.current.phase).toBe('timeout')
  })
  it('cancels pending reads/timers on reset, new attempt, and unmount', async () => {
    let resolve: (value: McpServerResource) => void
    vi.mocked(getMcpServer).mockImplementation(
      () =>
        new Promise(done => {
          resolve = done
        })
    )
    const hook = start()
    await tick()
    act(() => hook.result.current.setPhase('idle'))
    await act(async () => {
      resolve(response())
    })
    expect(hook.result.current.phase).toBe('idle')
    vi.mocked(getMcpServer).mockResolvedValue(response())
    hook.rerender({ ...target, cutoff: '2026-10-23T12:01:00.000Z' })
    act(() => hook.result.current.setPhase('rotating'))
    await tick()
    expect(hook.result.current.phase).toBe('rotating')
    hook.unmount()
    expect(vi.getTimerCount()).toBe(0)
  })
})
