import { normalizeGfsResourceUri } from '@clerum/desktop-app-links'
import { setResourceComposerPrefill } from './composerDraftStore'
import type { WorkspaceTab } from './workspaceTabs.types'

export function prefillNewConversationWithGfsResource(
  tab: WorkspaceTab | null | undefined,
  agentRef: string | null,
  destinationWorkspaceTabId: string | null | undefined
): boolean {
  const rawUri =
    tab?.kind === 'files' ? tab.files?.path : tab?.kind === 'preview' ? tab.preview?.gfsUri : null
  const uri = rawUri ? normalizeGfsResourceUri(rawUri) : null
  if (!uri || !destinationWorkspaceTabId) return false
  return setResourceComposerPrefill(destinationWorkspaceTabId, uri, agentRef)
}
