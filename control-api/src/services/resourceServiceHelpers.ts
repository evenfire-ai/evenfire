import type { ClerumResourceType } from '../types.js'

/**
 * HTTP status of a Kubernetes-ish error, or null when none can be read.
 *
 * `.httpStatus` is checked LAST, and the position is the point: every earlier
 * field wins as before, so no call site that reads a number today reads a
 * different one after. The only behaviour that changes is where this returned
 * `null` for a status it could have known.
 *
 * That gap was real. `httpStatus` is what this service's OWN error classes
 * carry (`K8sNotFoundError`, `K8sConflictError` in resourceService.ts), and
 * they set nothing else — so `getResource` rejecting with a wrapped 404 read as
 * "unknown status" here. `routes/admin/resources.ts:788` works around exactly
 * that with a hand-written `instanceof K8sNotFoundError` check; the repo's three
 * other status extractors (`http/k8sError.ts:18`, `http/errorHandler.ts:54`,
 * `k8s.ts:719`) all read the field already. This one was the outlier.
 *
 * Existing 404/409 call sites are unaffected: they catch errors thrown by the
 * raw `@kubernetes/client-node` client, whose `ApiException` sets `.code`, and
 * a `K8sNotFoundError` cannot reach them.
 */
export function extractK8sStatus(err: unknown): number | null {
  if (!err || typeof err !== 'object') return null
  const maybe = err as {
    statusCode?: number
    code?: number
    response?: { statusCode?: number; status?: number }
    httpStatus?: number
  }
  if (typeof maybe.statusCode === 'number') return maybe.statusCode
  if (typeof maybe.code === 'number') return maybe.code
  if (maybe.response && typeof maybe.response.statusCode === 'number') {
    return maybe.response.statusCode
  }
  if (maybe.response && typeof maybe.response.status === 'number') return maybe.response.status
  if (typeof maybe.httpStatus === 'number') return maybe.httpStatus
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
    case 'llmhooks':
      return 'LlmHook'
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
