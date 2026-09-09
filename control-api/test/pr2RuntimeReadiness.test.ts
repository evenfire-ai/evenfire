import { describe, expect, it } from 'vitest'
import {
  PR2_RUNTIME_HOPS,
  allPr2RuntimeHopsReady,
  unavailablePr2RuntimeHops,
} from '../src/services/access/pr2RuntimeReadiness.js'

describe('PR 2 runtime all-hops readiness', () => {
  it('starts unavailable for every producer, consumer, and continuation hop', () => {
    expect(PR2_RUNTIME_HOPS).toEqual([
      'action_contracts',
      'control_action_delegation',
      'external_rest_delegation_transport',
      'rpc_proxy_trusted_edge',
      'mcp_host_live_effects',
      'activity_session_search_provenance',
      'rpc_admission_map',
      'sandbox_derived_view',
      'remote_desktop_derived_view',
      'oauth_exact_target',
      'workflow_service_edge',
      'workflow_authority_bindings',
      'workflow_recipes_checkpoint',
      'workflow_approval_child_transition',
      'workflow_artifact_list',
      'gfs_controller_checkpoint',
      'workspace_files_controller_checkpoint',
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
