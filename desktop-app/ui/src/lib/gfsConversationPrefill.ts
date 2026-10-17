import { normalizeGfsResourceUri } from '@clerum/desktop-app-links'
import {
  getComposerDraft,
  setComposerDraft,
  setPendingResourceComposerDraft,
} from './composerDraftStore'
import type { WorkspaceTab } from './workspaceTabs.types'

export function prefillNewConversationWithGfsResource(
  tab: WorkspaceTab | null | undefined,
  agentRef: string | null
): boolean {
  const rawUri =
    tab?.kind === 'files' ? tab.files?.path : tab?.kind === 'preview' ? tab.preview?.gfsUri : null
  const uri = rawUri ? normalizeGfsResourceUri(rawUri) : null
  if (!uri || getComposerDraft(null, agentRef ?? undefined)) return false
  if (agentRef) setComposerDraft(null, uri, agentRef)
  else setPendingResourceComposerDraft(uri)
  return true
}
