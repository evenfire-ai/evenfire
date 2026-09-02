import type { ContextResource } from './api'

function normalized(value: unknown): string {
  return String(value ?? '').trim()
}

/**
 * Contexts historically exposed both their Kubernetes resource name and
 * spec.contextId as identifiers. Treat both as aliases everywhere that joins
 * Contexts to Host contextRef values or legacy URLs.
 */
export function contextAliases(context: ContextResource): string[] {
  return Array.from(
    new Set(
      [normalized(context.metadata?.name), normalized(context.spec?.contextId)].filter(Boolean)
    )
  )
}

export function contextWireId(context: ContextResource): string {
  return normalized(context.spec?.contextId) || normalized(context.metadata?.name)
}

export function contextForAlias(
  contexts: readonly ContextResource[],
  alias: string
): ContextResource | undefined {
  const normalizedAlias = normalized(alias)
  if (!normalizedAlias) return undefined
  return contexts.find(context => contextAliases(context).includes(normalizedAlias))
}
