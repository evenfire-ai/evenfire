import { ChatTabs } from '../ChatTabs'
import type { ChatViewWorkspaceProps } from './types'

export function ChatViewWorkspace({
  activeTabId,
  children,
  localSearch,
  onClose,
  onSelect,
  surfaceId = 'current-chat-surface',
  tabs,
}: ChatViewWorkspaceProps) {
  return (
    <section className="chat-view-workspace" data-active-chat-tab={activeTabId}>
      <ChatTabs
        activeTabId={activeTabId}
        onClose={onClose}
        onSelect={onSelect}
        panelId={surfaceId}
        tabs={tabs}
      />
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
