import type { SuggestedReferenceOutcome } from '@hooks/domain/useComposerAttachments'
import type { SuggestedReference } from '@lib/tabReferenceSuggestion.types'

export type TabReferenceSuggestionValue = {
  /** The active tab's file or folder, ready to attach, or `null` when none is offered. */
  candidate: SuggestedReference | null
  /** Attach `candidate` to the composer. Synchronous: it was resolved beforehand. */
  accept: (candidate: SuggestedReference) => SuggestedReferenceOutcome
}
