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

export function contextMutationError(error: unknown, fallback: string): string {
  if ((error as { status?: unknown } | null)?.status === 409) {
    return 'This access changed since it was loaded. Reload the page before applying your changes.'
  }
  return error instanceof Error ? error.message : fallback
}
