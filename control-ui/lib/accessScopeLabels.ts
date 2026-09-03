import type { ContextResource, HostResource } from './api'
import { contextAliases, contextForAlias } from './contextIdentity'

export type AccessScopeLabel = {
  label: string
  // False only for the raw-id fallback: nothing could resolve the scope to a
  // user-facing name (no owning agent, no stored display name).
  resolved: boolean
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
  return function labelFor(scopeId: string): AccessScopeLabel {
    const context = contextForAlias(contexts, scopeId)
    const aliases = new Set(context ? contextAliases(context) : [scopeId])
    const owners = hosts
      .filter(host => aliases.has(hostContextRef(host)))
      .map(hostDisplayName)
      .filter(Boolean)
      .sort((left, right) => left.localeCompare(right))
    if (owners.length > 0) return { label: owners.join(', '), resolved: true }

    const display = context?.spec?.displayName?.trim()
    if (display) return { label: display, resolved: true }
    return { label: scopeId, resolved: false }
  }
}
