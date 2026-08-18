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
    throw new Error('Context version is unavailable. Reload before changing membership.')
  }
  return { metadata: { resourceVersion: version }, spec }
}

export function contextMutationError(error: unknown, fallback: string): string {
  if ((error as { status?: unknown } | null)?.status === 409) {
    return 'This Context changed since it was loaded. Reload it before applying your changes.'
  }
  return error instanceof Error ? error.message : fallback
}
