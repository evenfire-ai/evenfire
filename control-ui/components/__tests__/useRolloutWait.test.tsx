import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, renderHook } from '@testing-library/react'
import type { RolloutWaitOptions } from '@components/UpdateConnectorCredentials/types'
import { useRolloutWait } from '@components/UpdateConnectorCredentials/useRolloutWait'
import { POLL_INTERVAL_MS, POLL_TIMEOUT_MS } from '@constants/connectorCredentials'
import { getMcpServer } from '@lib/api'
import type { McpServerCondition, McpServerResource } from '@lib/api'

vi.mock('@lib/api', () => ({ getMcpServer: vi.fn() }))
const cutoff = '2026-10-23T12:00:00.000Z'
const target: RolloutWaitOptions = {
  serverName: 'connector',
  cutoff,
  expectedUid: 'uid',
  expectedGeneration: 3,
}
// The HCC-authored refusal message (host-context-controller/src/reconciler.ts,
// spec §4.7): placeholder / source / context names only, never value bytes.
const EGRESS_REFUSAL_MESSAGE =
  '1 value would be refused by the egress-proxy image; the existing ConfigMap and ' +
  'Deployment are unchanged: query placeholder ${API_KEY} (Secret "remote-creds" key ' +
  '"api-key"). See docs/crds/mcpserver.md "Value classes".'
function egressCondition(
  status: 'True' | 'False',
  options: {
    timestamp?: string
    observedGeneration?: number
    message?: string
  } = {}
): McpServerCondition {
  return {
    type: 'EgressProxyValuesValid',
    status,
    reason: status === 'False' ? 'ValueOutsideClass' : 'ValuesWithinClass',
    message:
      options.message ??
      (status === 'False'
        ? EGRESS_REFUSAL_MESSAGE
        : 'Every value the egress-proxy template substitutes is within its class'),
    lastTransitionTime: options.timestamp ?? '2026-10-23T12:00:04.000Z',
    observedGeneration: options.observedGeneration ?? 3,
  }
}
function withoutObservedGeneration(condition: McpServerCondition): McpServerCondition {
  const copy = { ...condition }
  delete copy.observedGeneration
  return copy
}
function response(
  status: 'True' | 'False' = 'True',
  options: {
    generation?: number
    observedGeneration?: number
    timestamp?: string
    reason?: string
    uid?: string
    extraConditions?: McpServerCondition[]
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
        ...(options.extraConditions ?? []),
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
  it('fails as soon as a fresh egress-proxy refusal arrives, without waiting for DeploymentReady', async () => {
    // The PR #1243 shape: the PREVIOUS rollout's DeploymentReady=True is still
    // on the CRD, and the blocking reconcile deliberately writes no
    // DeploymentReady. Without the refusal branch this poll spins to
    // POLL_TIMEOUT_MS and reports the stale True as the current state; the
    // operator only learns why 180s later — or never.
    vi.mocked(getMcpServer)
      .mockResolvedValueOnce(response('True', { timestamp: cutoff }))
      .mockResolvedValue(
        response('True', {
          timestamp: cutoff,
          extraConditions: [egressCondition('False')],
        })
      )
    const hook = start()
    await tick()
    expect(hook.result.current.phase).toBe('rotating')
    await tick()
    expect(hook.result.current.phase).toBe('failed')
    // The HCC message verbatim: placeholder/source/context, no value bytes.
    expect(hook.result.current.phaseMessage).toBe(EGRESS_REFUSAL_MESSAGE)
    // Terminal: the poll stopped, so no later tick resurrects a timeout.
    await tick(POLL_TIMEOUT_MS)
    expect(hook.result.current.phase).toBe('failed')
    expect(hook.result.current.phaseMessage).toBe(EGRESS_REFUSAL_MESSAGE)
  })
  it.each([
    {
      label: 'a block timestamped at or before the write',
      condition: egressCondition('False', { timestamp: cutoff }),
    },
    {
      label: 'a block observed for another generation',
      condition: egressCondition('False', { observedGeneration: 2 }),
    },
    {
      label: 'a block without observedGeneration',
      condition: withoutObservedGeneration(egressCondition('False')),
    },
    {
      label: 'a within-class True',
      condition: egressCondition('True'),
    },
  ])('does not treat $label as this write’s verdict', async ({ condition }) => {
    vi.mocked(getMcpServer).mockResolvedValue(
      response('True', { timestamp: cutoff, extraConditions: [condition] })
    )
    const hook = start()
    await tick()
    expect(hook.result.current.phase).toBe('rotating')
    expect(hook.result.current.phaseMessage).not.toBe(EGRESS_REFUSAL_MESSAGE)
    // Still the pre-existing bounded behavior: no fresh DeploymentReady, no
    // verdict, so the poll ends as an inconclusive timeout — never a failure
    // blamed on a condition this write did not produce.
    await tick(POLL_TIMEOUT_MS - POLL_INTERVAL_MS)
    expect(hook.result.current.phase).toBe('timeout')
  })
  it('reports a fresh refusal for timestamp-only rotation callers', async () => {
    // UpdateConnectorCredentials (/mcp-servers/[name]/edit) passes no identity:
    // the refusal is correlated by the same timestamp-only window this caller
    // already uses for DeploymentReady success.
    const blocked = response('True', {
      timestamp: cutoff,
      extraConditions: [withoutObservedGeneration(egressCondition('False'))],
    })
    delete blocked.metadata
    vi.mocked(getMcpServer).mockResolvedValue(blocked)
    const hook = start({ serverName: 'connector', cutoff })
    await tick()
    expect(hook.result.current.phase).toBe('failed')
    expect(hook.result.current.phaseMessage).toBe(EGRESS_REFUSAL_MESSAGE)
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
