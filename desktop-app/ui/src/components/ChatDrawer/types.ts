import type { ReactNode, RefObject } from 'react'

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
  children: ReactNode
}
