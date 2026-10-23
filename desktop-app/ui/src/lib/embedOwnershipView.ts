import type { EmbedFailure, EmbedOwnershipState } from './embedOwnership.types'
import type { EmbedViewState } from './embedOwnershipView.types'

/** Projects the ownership state onto what the active app tab shows. */
export function embedViewState(state: EmbedOwnershipState): EmbedViewState {
  const owner = state.owner === null ? undefined : state.views.get(state.owner)
  if (owner) {
    return owner.phase === 'mounted' || owner.phase === 'closeFailed'
      ? { kind: 'mounted', launch: owner }
      : { kind: 'minting', launch: owner }
  }
  if (state.failure !== null && state.failure.tabId === state.activeAppTabId) {
    return { kind: 'failed', failure: state.failure }
  }
  return { kind: 'idle' }
}

export const EMBED_SLOT_UNMEASURED_MESSAGE = 'Embed slot is not laid out — cannot determine bounds'
export const EMBED_CRASHED_MESSAGE = 'The app closed unexpectedly.'

/**
 * Session errors carry the upstream status as "(404):" and bridge failures as
 * "403 Forbidden"; either form picks the user-facing copy.
 */
export function httpStatusOf(message: string): number | null {
  const match = /\((\d{3})\)|\b(\d{3})\s+[A-Za-z]/.exec(message)
  return match ? Number(match[1] ?? match[2]) : null
}

export function embedFailureMessage(failure: EmbedFailure): string {
  if (failure.kind === 'slot') return EMBED_SLOT_UNMEASURED_MESSAGE
  if (failure.kind === 'crashed') return EMBED_CRASHED_MESSAGE
  const message = failure.message ?? ''
  switch (httpStatusOf(message)) {
    case 404:
      return 'This app was removed.'
    case 403:
      return "You don't have access to this app."
    case 409:
      return 'This app is starting up — try again in a moment.'
    default:
      return message
  }
}
