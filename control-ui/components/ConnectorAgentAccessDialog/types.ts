import type { ConnectorAgentTarget, ServerRef } from '@components/McpServerTable.types'

export type ConnectorAgentAccessDialogProps = {
  server: ServerRef
  agentTargets: ConnectorAgentTarget[]
  boundAgentNames: string[]
  pending?: boolean
  onAdd: (
    server: ServerRef,
    agents: Array<Pick<ConnectorAgentTarget, 'name' | 'contextRef'>>
  ) => Promise<boolean>
  onDismiss: () => void
}
