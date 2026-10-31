import type { ContextSpec } from './api'

export type ContextUpdatePayload = {
  metadata: { resourceVersion: string }
  spec: ContextSpec
}

export function buildContextUpdatePayload(
  resourceVersion: string | undefined,
  spec: ContextSpec
): ContextUpdatePayload {
  const version = resourceVersion?.trim()
  if (!version) {
    throw new Error('A required version is unavailable. Reload before changing access.')
  }
  return { metadata: { resourceVersion: version }, spec }
}

function rejectedContextWriteBody(error: unknown): Record<string, unknown> | null {
  if (!(error instanceof Error)) return null
  if ((error as Error & { status?: unknown }).status !== 422) return null
  const body = (error as Error & { body?: unknown }).body
  return body && typeof body === 'object' ? (body as Record<string, unknown>) : null
}

/**
 * Names a context write tried to add although no connector by that name exists any
 * more (422 `unknown_mcp_server`), or null for any other error. An empty list means
 * the server refused without naming them.
 */
export function unknownMcpServerNames(error: unknown): string[] | null {
  const body = rejectedContextWriteBody(error)
  if (body?.error !== 'unknown_mcp_server') return null
  return Array.isArray(body.mcpServers)
    ? body.mcpServers.filter((name): name is string => typeof name === 'string' && name !== '')
    : []
}

/**
 * The message for a context write control-api refused because of the connectors it
 * adds, or null when the error is something else.
 */
export function contextMcpServerRejection(error: unknown): string | null {
  const unknown = unknownMcpServerNames(error)
  if (unknown) {
    if (unknown.length === 0) {
      return 'A selected connector no longer exists; reload the page and try again.'
    }
    return unknown.length === 1
      ? `The connector ${unknown[0]} no longer exists; reload the page and try again.`
      : `The connectors ${unknown.join(', ')} no longer exist; reload the page and try again.`
  }
  const body = rejectedContextWriteBody(error)
  if (body?.error === 'too_many_mcp_servers') {
    return typeof body.limit === 'number'
      ? `A single change can add at most ${body.limit} connectors; add fewer at once and try again.`
      : 'Too many connectors were added at once; add fewer and try again.'
  }
  return null
}

export function contextMutationError(error: unknown, fallback: string): string {
  if ((error as { status?: unknown } | null)?.status === 409) {
    return 'This access changed since it was loaded. Reload the page before applying your changes.'
  }
  const rejection = contextMcpServerRejection(error)
  if (rejection) return rejection
  return error instanceof Error ? error.message : fallback
}
