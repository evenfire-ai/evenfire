import type { SuggestedFileReferenceOutcome } from '@hooks/domain/useComposerAttachments'
import type { ComposerGlobalFileReference } from '../uiTypes'

export type TabReferenceSuggestionValue = {
  /** The active tab's file, ready to attach, or `null` when none is offered. */
  candidate: ComposerGlobalFileReference | null
  /** Attach `candidate` to the composer. Synchronous: it was resolved beforehand. */
  accept: (candidate: ComposerGlobalFileReference) => SuggestedFileReferenceOutcome
}
