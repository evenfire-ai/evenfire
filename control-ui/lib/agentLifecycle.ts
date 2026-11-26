// Agent lifecycle type, derived from the Host CRD's spec.lifecycle.stateless
// (charts/clerum-crds/crds/host.yaml): true enables the stateless lifecycle —
// mcp-host persists session state to disk and the operator scales the
// Deployment to zero while status.lifecycle.state is suspended. Absent/false
// is the default, continuously-running (stateful) agent.
export type AgentLifecycleType = 'stateful' | 'stateless'

export function agentLifecycleTypeFromSpec(
  spec: { lifecycle?: { stateless?: boolean } } | undefined | null
): AgentLifecycleType {
  return spec?.lifecycle?.stateless === true ? 'stateless' : 'stateful'
}

export const AGENT_TYPE_LABELS: Record<AgentLifecycleType, string> = {
  stateful: 'Stateful',
  stateless: 'Stateless',
}

export const AGENT_TYPE_TOOLTIPS: Record<AgentLifecycleType, string> = {
  stateful: 'This agent runs continuously; its process is never scaled to zero.',
  stateless:
    'This agent persists session state to disk and scales to zero while idle (shown as Idle). It wakes on demand.',
}
