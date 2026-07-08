export type ConnectorAccessPrincipal = {
  id: string
  label: string
}

export type ConnectorAccessSummary = {
  agents: ConnectorAccessPrincipal[]
  users: ConnectorAccessPrincipal[]
  teams: ConnectorAccessPrincipal[]
}

export type ConnectorAccessSummaryMap = Record<string, ConnectorAccessSummary>
