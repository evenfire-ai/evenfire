/** An agent an operator can give a connector to, with its private Context. */
export type AgentAccessTarget = {
  name: string
  label: string
  contextRef: string
}

export type ResolvedAgentContexts = {
  /** The selected agents that still exist, in selection order. */
  selectedTargets: AgentAccessTarget[]
  /** Their distinct Contexts, in selection order. The first is the primary. */
  contextRefs: string[]
}

export type AgentAccessTargetsState = {
  agentTargets: AgentAccessTarget[]
  agentsLoading: boolean
  agentsError: string
}
