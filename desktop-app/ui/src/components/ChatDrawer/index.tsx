import { IconButton } from '@components/Common'
import { IconClose, IconNewChat } from '@components/SidebarNav/icons'
import { CHAT_DRAWER_MAX_ABSOLUTE, CHAT_DRAWER_MIN_WIDTH } from '@hooks/useChatDrawerResize'
import type { ChatDrawerProps } from './types'

/**
 * Cursor-style chat drawer that coexists with the live sandbox-ui embed on the
 * `apps` route. It is a `position: fixed` right column; the embed slot is
 * shrunk with `padding-right` so the native WebContentsView never overlaps it.
 *
 * The drawer mounts a single <ChatPage> (passed as children) driven by the same
 * global `chatViewTabs` state as the full-screen chat route — no duplicated tab
 * state and no duplicated streams.
 */
export function ChatDrawer({
  header,
  onNewChat,
  onClose,
  containerRef,
  ready,
  onResizeHandleMouseDown,
  onResizeHandleKeyDown,
  width,
  resizing,
  children,
}: ChatDrawerProps) {
  return (
    <aside
      className={`chat-drawer${ready ? ' is-ready' : ''}${resizing ? ' is-resizing' : ''}`}
      aria-label="Chat"
      data-ready={ready ? 'true' : 'false'}
    >
      <div
        className="chat-drawer__resize-handle"
        role="separator"
        tabIndex={0}
        aria-orientation="vertical"
        aria-label="Resize chat drawer"
        aria-valuemin={CHAT_DRAWER_MIN_WIDTH}
        aria-valuemax={CHAT_DRAWER_MAX_ABSOLUTE}
        aria-valuenow={Math.round(width)}
        onMouseDown={onResizeHandleMouseDown}
        onKeyDown={onResizeHandleKeyDown}
      />
      <header className="chat-drawer__header">
        <div className="chat-drawer__header-main">{header}</div>
        <div className="chat-drawer__header-actions">
          <IconButton
            color="neutral"
            variant="ghost"
            size="sm"
            label="New chat"
            title="New chat"
            onClick={onNewChat}
          >
            <IconNewChat />
          </IconButton>
          <IconButton
            color="neutral"
            variant="ghost"
            size="sm"
            label="Close chat drawer"
            title="Close chat drawer"
            onClick={onClose}
          >
            <IconClose />
          </IconButton>
        </div>
      </header>
      <div className="chat-drawer__surface" ref={containerRef as React.RefObject<HTMLDivElement>}>
        {children}
      </div>
    </aside>
  )
}
