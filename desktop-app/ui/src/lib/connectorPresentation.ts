import type { RpcConnector } from '../../../src/types'
import { isSharedConnector } from './connectorRows'

/**
 * Shared presentation helpers for a connector's tri-state grant, used by BOTH
 * the top-level Connectors panel (`McpServersPage`) and the context detail's
 * Connectors tab (`ContextDetailsPage`). Single source of truth (D4) — never
 * re-derive the label/tone/caption in a second place.
 */

export type StatusPresentation = {
  label: string
  tone: 'success' | 'warning' | 'neutral'
}

export function statusPresentation(status: RpcConnector['status']): StatusPresentation {
  switch (status) {
    case 'authorized':
      return { label: 'Authorized', tone: 'success' }
    case 'requires_setup':
      return { label: 'Requires setup', tone: 'warning' }
    default:
      return { label: 'No OAuth', tone: 'neutral' }
  }
}

/**
 * The per-connector scope caption (spec §1.3 / D-1). A `oauth-user` grant is
 * global to `(server, userId)`, so acting under one agent flips the SAME server
 * across every agent that lists it; a `oauth-context` grant is shared by the
 * whole Context. Surfaced as a tooltip (title) on the status pill so the user
 * understands the blast radius before the derived state changes several rows at
 * once.
 */
export function scopeCaption(connector: RpcConnector): string | null {
  if (connector.status === 'no_oauth') return null
  if (isSharedConnector(connector)) {
    return 'Shared by the team — affects everyone in this context.'
  }
  if (connector.authKind === 'oauth-user') {
    return 'Affects all your agents that use this connector.'
  }
  return null
}
