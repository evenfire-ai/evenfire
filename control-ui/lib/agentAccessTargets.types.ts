/** An agent an operator can give a connector to, with its private Context. */
export type AgentAccessTarget = {
  name: string
  /** Display name, qualified with `name` when another agent shares it. */
  label: string
  /** The immutable agent name (`metadata.name`), shown under the label and searchable. */
  description: string
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
