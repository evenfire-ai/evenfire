import type {
  ConnectorAccessPrincipal,
  ConnectorAccessSummary,
} from '../components/McpServerTable.types'
import type { ContextResource, HostResource } from './api'

function comparePrincipals(
  left: ConnectorAccessPrincipal,
  right: ConnectorAccessPrincipal
): number {
  return left.label.localeCompare(right.label) || left.id.localeCompare(right.id)
}

export function sortAccessPrincipals(
  items: readonly ConnectorAccessPrincipal[]
): ConnectorAccessPrincipal[] {
  return [...items].sort(comparePrincipals)
}

export function mergeAccessSummaries(
  summaries: readonly ConnectorAccessSummary[]
): ConnectorAccessSummary {
  const mergeGroup = (group: keyof ConnectorAccessSummary): ConnectorAccessPrincipal[] => {
    const byId = new Map<string, ConnectorAccessPrincipal>()
    for (const principal of summaries.flatMap(summary => summary[group])) {
      const current = byId.get(principal.id)
      if (!current || comparePrincipals(principal, current) < 0) byId.set(principal.id, principal)
    }
    return sortAccessPrincipals([...byId.values()])
  }

  return {
    agents: mergeGroup('agents'),
    users: mergeGroup('users'),
    teams: mergeGroup('teams'),
  }
}

export function contextNamesForConnector(
  contexts: readonly ContextResource[],
  connectorName: string
): string[] {
  return Array.from(
    new Set(
      contexts
        .filter(context => context.spec?.mcpServers?.includes(connectorName))
        .map(context => String(context.metadata?.name || context.spec?.contextId || '').trim())
        .filter(Boolean)
    )
  ).sort((left, right) => left.localeCompare(right))
}

/**
 * Returns only connector scopes owned by at least one Host. Per-install,
 * workflow-recipe, and other private scopes are intentionally excluded from
 * operator-facing agent access views.
 */
export function hostOwnedContextNamesForConnector(
  contexts: readonly ContextResource[],
  hosts: readonly HostResource[],
  connectorName: string
): string[] {
  const hostContextRefs = new Set(
    hosts
      .filter(host => String(host.metadata?.name ?? '').trim())
      .map(host => String(host.spec?.contextRef ?? '').trim())
      .filter(Boolean)
  )
  return contextNamesForConnector(contexts, connectorName).filter(contextName =>
    hostContextRefs.has(contextName)
  )
}
