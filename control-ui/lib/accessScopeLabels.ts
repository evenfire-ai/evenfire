import type { ContextResource, HostResource } from './api'

export type AccessScopeLabel = {
  label: string
  // False only for the raw-id fallback: nothing could resolve the scope to a
  // user-facing name (no owning agent, no stored display name).
  resolved: boolean
}

function contextIdOf(context: ContextResource): string {
  return String(context.spec?.contextId || context.metadata?.name || '').trim()
}

function hostContextRef(host: HostResource): string {
  return String((host.spec as { contextRef?: string } | undefined)?.contextRef || '').trim()
}

function hostDisplayName(host: HostResource): string {
  return (
    String((host.spec as { host?: string } | undefined)?.host || '').trim() ||
    String(host.metadata?.name || '')
  )
}

/**
 * Builds a labeler that turns an access-scope id (a Context on the wire) into
 * what the user actually sees: the owning agent name(s) when the scope backs
 * hosts, the stored `displayName` otherwise, and the raw id as a muted
 * last resort. Purely a presentation join — no extra API calls of its own.
 */
export function accessScopeLabeler(
  contexts: readonly ContextResource[],
  hosts: readonly HostResource[]
): (scopeId: string) => AccessScopeLabel {
  const contextById = new Map<string, ContextResource>()
  for (const context of contexts) {
    const id = contextIdOf(context)
    if (id) contextById.set(id, context)
  }

  return function labelFor(scopeId: string): AccessScopeLabel {
    const owners = hosts
      .filter(host => hostContextRef(host) === scopeId)
      .map(hostDisplayName)
      .filter(Boolean)
      .sort((left, right) => left.localeCompare(right))
    if (owners.length > 0) return { label: owners.join(', '), resolved: true }

    const display = contextById.get(scopeId)?.spec?.displayName?.trim()
    if (display) return { label: display, resolved: true }
    return { label: scopeId, resolved: false }
  }
}
