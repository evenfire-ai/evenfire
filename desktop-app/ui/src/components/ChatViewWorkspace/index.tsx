import type { ChatViewWorkspaceProps } from './types'

/**
 * Chat surface wrapper for the full-screen chat route. The workspace tab strip
 * is now global (mini-spec 03 §3, `WorkspaceTabStrip` rendered above the seam in
 * `App.tsx`), so this owns only the selected chat surface — the local-search
 * slot and the active conversation.
 */
export function ChatViewWorkspace({
  children,
  localSearch,
  surfaceId = 'current-chat-surface',
}: ChatViewWorkspaceProps) {
  return (
    <section className="chat-view-workspace">
      <section
        aria-label="Current chat"
        className="chat-view-surface"
        data-selected-surface="chat"
        id={surfaceId}
      >
        {localSearch}
        <div className="chat-view-surface__content">{children}</div>
      </section>
    </section>
  )
}
