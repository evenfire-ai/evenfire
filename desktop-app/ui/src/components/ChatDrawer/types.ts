import type {
  KeyboardEvent as ReactKeyboardEvent,
  MouseEvent as ReactMouseEvent,
  ReactNode,
  RefObject,
} from 'react'

export type ChatDrawerProps = {
  /**
   * Header content that names the visible conversation. Phase 1 passes a plain
   * title; Phase 2 replaces it with the open-chats switcher select.
   */
  header: ReactNode
  onNewChat: () => void
  /** Collapses the drawer; its title-bar toggle owns reopening it. */
  onCollapse: () => void
  /** Ejects the visible conversation into the full-screen chat route. */
  onExpandFullScreen: () => void
  /** Scroll container the embedded <ChatPage> anchors to. */
  containerRef: RefObject<HTMLElement | null>
  /** Anti-flash gate: false keeps an unready drawer hidden until the embed acks its bounds. */
  ready: boolean
  /** Whether the drawer is open; false allows Ant Design to play its exit motion. */
  open: boolean
  /** Called after Ant Design finishes the exit motion. */
  onAfterClose: () => void
  /**
   * mousedown handler for the left-edge drag handle that resizes the drawer.
   * Wired from `useChatDrawerResize`.
   */
  onResizeHandleMouseDown: (event: ReactMouseEvent<HTMLElement>) => void
  /**
   * keydown handler for the focusable drag handle — arrow-key / Home / End
   * resize (WAI-ARIA window-splitter pattern). Wired from `useChatDrawerResize`.
   */
  onResizeHandleKeyDown: (event: ReactKeyboardEvent<HTMLElement>) => void
  /** Current drawer width in px, surfaced as the handle's `aria-valuenow`. */
  width: number
  /** True while a resize drag is in progress — highlights the drag handle. */
  resizing: boolean
  children: ReactNode
}
