import { Flex } from 'antd'
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
  labelledBy,
}: ChatViewWorkspaceProps) {
  return (
    <Flex component="section" vertical className="chat-view-workspace">
      <Flex
        component="section"
        vertical
        aria-label="Current chat"
        aria-labelledby={labelledBy}
        className="chat-view-surface"
        data-selected-surface="chat"
        id={surfaceId}
        role="tabpanel"
      >
        {localSearch}
        <Flex vertical className="chat-view-surface__content">
          {children}
        </Flex>
      </Flex>
    </Flex>
  )
}
