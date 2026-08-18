import { describe, expect, it } from 'vitest'
import {
  PR2_RUNTIME_HOPS,
  allPr2RuntimeHopsReady,
  unavailablePr2RuntimeHops,
} from '../src/services/access/pr2RuntimeReadiness.js'

describe('PR 2 runtime all-hops readiness', () => {
  it('starts unavailable for every producer, consumer, and continuation hop', () => {
    expect(PR2_RUNTIME_HOPS).toEqual([
      'operation_contracts',
      'control_action_producer',
      'rpc_proxy_trusted_edge',
      'mcp_host_runtime',
      'workflow_lifecycle',
      'filesystem_controllers',
      'derived_session_transitions',
      'activity_session_search_resumable',
    ])
    expect(allPr2RuntimeHopsReady(undefined)).toBe(false)
    expect(allPr2RuntimeHopsReady(unavailablePr2RuntimeHops)).toBe(false)
  })

  it('requires every named hop and cannot be satisfied by a partial backend', () => {
    const complete = Object.fromEntries(PR2_RUNTIME_HOPS.map(hop => [hop, 'ready'])) as Record<
      (typeof PR2_RUNTIME_HOPS)[number],
      'ready' | 'unavailable'
    >
    expect(allPr2RuntimeHopsReady(complete)).toBe(true)

    for (const missingHop of PR2_RUNTIME_HOPS) {
      expect(allPr2RuntimeHopsReady({ ...complete, [missingHop]: 'unavailable' })).toBe(false)
    }
  })
})
