import { getErrorCode } from './k8sErrors'

/**
 * Observed result of a delete against the apiserver.
 * Record "gone" only after DELETE 200 or DELETE 404 — never after a swallowed 403/5xx.
 */
export type DeleteOutcome =
  | { kind: 'deleted' }
  | { kind: 'gone' }
  | { kind: 'failed'; code?: number; error: unknown }

export async function observeNamespacedDelete(
  deleteFn: () => Promise<unknown>
): Promise<DeleteOutcome> {
  try {
    await deleteFn()
    return { kind: 'deleted' }
  } catch (error: unknown) {
    const code = getErrorCode(error)
    if (code === 404) return { kind: 'gone' }
    return { kind: 'failed', code, error }
  }
}

export function shouldRecordDelete(outcome: DeleteOutcome): boolean {
  switch (outcome.kind) {
    case 'deleted':
    case 'gone':
      return true
    case 'failed':
      return false
    default: {
      const _exhaustive: never = outcome
      return _exhaustive
    }
  }
}

export function deleteOutcomeFields(outcome: DeleteOutcome): {
  outcome: DeleteOutcome['kind']
  code?: number
} {
  switch (outcome.kind) {
    case 'deleted':
    case 'gone':
      return { outcome: outcome.kind }
    case 'failed':
      return { outcome: outcome.kind, code: outcome.code }
    default: {
      const _exhaustive: never = outcome
      return _exhaustive
    }
  }
}
