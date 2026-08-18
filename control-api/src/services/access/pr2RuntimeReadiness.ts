export const PR2_RUNTIME_HOPS = [
  'operation_contracts',
  'control_action_producer',
  'rpc_proxy_trusted_edge',
  'mcp_host_runtime',
  'workflow_lifecycle',
  'filesystem_controllers',
  'derived_session_transitions',
  'activity_session_search_resumable',
] as const

export type Pr2RuntimeHop = (typeof PR2_RUNTIME_HOPS)[number]
export type Pr2RuntimeHopReadiness = Readonly<Record<Pr2RuntimeHop, 'ready' | 'unavailable'>>

export const unavailablePr2RuntimeHops: Pr2RuntimeHopReadiness = Object.freeze(
  Object.fromEntries(PR2_RUNTIME_HOPS.map(hop => [hop, 'unavailable'])) as Record<
    Pr2RuntimeHop,
    'unavailable'
  >
)

export function allPr2RuntimeHopsReady(
  readiness: Pr2RuntimeHopReadiness | null | undefined
): boolean {
  return Boolean(readiness) && PR2_RUNTIME_HOPS.every(hop => readiness?.[hop] === 'ready')
}
