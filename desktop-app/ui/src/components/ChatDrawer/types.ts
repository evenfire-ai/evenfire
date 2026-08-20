import type { MouseEvent as ReactMouseEvent, ReactNode, RefObject } from 'react'

export type ChatDrawerProps = {
  /**
   * Header content that names the visible conversation. Phase 1 passes a plain
   * title; Phase 2 replaces it with the open-chats switcher select.
   */
  header: ReactNode
  onNewChat: () => void
  onClose: () => void
  /** Scroll container the embedded <ChatPage> anchors to. */
  containerRef: RefObject<HTMLElement | null>
  /**
   * When false the drawer stays mounted but visually hidden until the native
   * embed has finished shrinking, mirroring the notification drawer's
   * bounds-ack anti-flash gate.
   */
  ready: boolean
  /**
   * mousedown handler for the left-edge drag handle that resizes the drawer.
   * Wired from `useChatDrawerResize`.
   */
  onResizeHandleMouseDown: (event: ReactMouseEvent<HTMLElement>) => void
  /** True while a resize drag is in progress — highlights the drag handle. */
  resizing: boolean
  children: ReactNode
}
