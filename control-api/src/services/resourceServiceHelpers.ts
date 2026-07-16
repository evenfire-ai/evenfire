import type { ClerumResourceType } from '../types.js'

export function extractK8sStatus(err: unknown): number | null {
  if (!err || typeof err !== 'object') return null
  const maybe = err as {
    statusCode?: number
    code?: number
    response?: { statusCode?: number; status?: number }
  }
  if (typeof maybe.statusCode === 'number') return maybe.statusCode
  if (typeof maybe.code === 'number') return maybe.code
  if (maybe.response && typeof maybe.response.statusCode === 'number') {
    return maybe.response.statusCode
  }
  if (maybe.response && typeof maybe.response.status === 'number') return maybe.response.status
  return null
}

export function kindFromPlural(plural: ClerumResourceType): string {
  switch (plural) {
    case 'hosts':
      return 'Host'
    case 'contexts':
      return 'Context'
    case 'communicationchannels':
      return 'CommunicationChannel'
    case 'mcpservers':
      return 'McpServer'
    case 'workflowrecipes':
      return 'WorkflowRecipe'
    case 'workflowrecipepolicies':
      return 'WorkflowRecipePolicy'
    case 'sharedfilesystems':
      return 'SharedFileSystem'
    default:
      return 'Unknown'
  }
}

/**
 * Parse a projected numeric-generation annotation value.
 *
 * Returns the parsed non-negative integer, or null when the annotation is
 * absent OR unparseable. A null result means "no known projected value" so the
 * monotonic projector treats it as safe-to-write (there is nothing to regress
 * below). We do NOT throw on a garbage value: the annotation is a write-only
 * projection and control-api is its sole writer, so a non-numeric value can
 * only come from external tampering — overwriting it with the authoritative
 * Postgres generation is the correct, self-healing outcome.
 */
export function parseProjectedGeneration(raw: string | undefined): number | null {
  if (raw === undefined) return null
  const trimmed = raw.trim()
  if (!/^[0-9]+$/.test(trimmed)) return null
  const parsed = Number(trimmed)
  if (!Number.isSafeInteger(parsed) || parsed < 0) return null
  return parsed
}

/** Add non-empty namespace value(s) to a Set. Handles string | string[]. */
export function addNonEmpty(set: Set<string>, value: string | string[] | undefined): void {
  if (Array.isArray(value)) {
    for (const n of value) {
      const trimmed = n.trim()
      if (trimmed) set.add(trimmed)
    }
  } else if (value) {
    const trimmed = value.trim()
    if (trimmed) set.add(trimmed)
  }
}
