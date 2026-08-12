import { useCallback, useEffect, useRef } from 'react'
import { CHAT_NEAR_BOTTOM_THRESHOLD_PX } from '@constants/agents'
import type { AgentChatMessage, TaskProgress } from '../../uiTypes'

/**
 * Distance (px) from the bottom of the scroll container within which we still
 * treat the user as "following" the conversation and auto-scroll on new content.
 * Beyond it, the user is reading history and we must NOT yank them down (B4-a).
 */
interface UseChatScrollParams {
  selectedAgent: string | null
  chatMessages: AgentChatMessage[]
  agentSending: boolean
  /**
   * Progress slice for the ACTIVE view only (the selected agent's
   * `progressByMessageId`), NOT the whole cross-agent map. Restricting the
   * effect's dependency here is B4-b: progress churn in a non-visible chat/agent
   * no longer schedules a scroll burst.
   */
  activeChatProgress: Record<string, TaskProgress>
}

/**
 * Owns the chat auto-scroll: the end anchor ref, the multi-frame scroll burst,
 * and cancellation of pending frames/timeouts. Extracted from
 * `useAgentChatController` (Fase 1).
 *
 * Two DELIBERATE behavior changes (B4 mitigations, permitted by the Fase 1 plan):
 *  - B4-a: the auto-scroll EFFECT only scrolls when the user is near the bottom
 *    (`isNearBottom`). Explicit callers (`scrollChatToBottom`, e.g. chat switch /
 *    create) still scroll unconditionally.
 *  - B4-b: the effect depends on the active view's progress slice, not the full
 *    cross-agent `progressByAgentMessage`, so background tasks don't trigger it.
 */
export function useChatScroll({
  selectedAgent,
  chatMessages,
  agentSending,
  activeChatProgress,
}: UseChatScrollParams) {
  const chatEndRef = useRef<HTMLDivElement | null>(null)
  const scrollAnimationFrameIdsRef = useRef<number[]>([])
  const scrollTimeoutIdsRef = useRef<number[]>([])

  const cancelScheduledScrolls = useCallback(() => {
    if (typeof window !== 'undefined') {
      for (const id of scrollAnimationFrameIdsRef.current) {
        window.cancelAnimationFrame(id)
      }
      for (const id of scrollTimeoutIdsRef.current) {
        window.clearTimeout(id)
      }
    }
    scrollAnimationFrameIdsRef.current = []
    scrollTimeoutIdsRef.current = []
  }, [])

  const scrollChatToBottom = useCallback(() => {
    if (typeof window === 'undefined' || typeof document === 'undefined') return
    cancelScheduledScrolls()

    const scheduleAnimationFrame = (callback: () => void) => {
      const id = window.requestAnimationFrame(() => {
        scrollAnimationFrameIdsRef.current = scrollAnimationFrameIdsRef.current.filter(
          pendingId => pendingId !== id
        )
        callback()
      })
      scrollAnimationFrameIdsRef.current.push(id)
    }

    const scheduleTimeout = (callback: () => void, delayMs: number) => {
      const id = window.setTimeout(() => {
        scrollTimeoutIdsRef.current = scrollTimeoutIdsRef.current.filter(
          pendingId => pendingId !== id
        )
        callback()
      }, delayMs)
      scrollTimeoutIdsRef.current.push(id)
    }

    const applyBottomScroll = () => {
      const anchor = chatEndRef.current
      if (!anchor) return

      // Keep the end-of-chat anchor visible.
      anchor.scrollIntoView({ behavior: 'auto', block: 'end' })

      // Force max scroll for every scrollable ancestor.
      let node: HTMLElement | null = anchor.parentElement
      while (node) {
        node.scrollTop = node.scrollHeight
        node = node.parentElement
      }

      // And force page-level roots too.
      const scrollingRoot = document.scrollingElement as HTMLElement | null
      if (scrollingRoot) scrollingRoot.scrollTop = scrollingRoot.scrollHeight
      document.documentElement.scrollTop = document.documentElement.scrollHeight
      document.body.scrollTop = document.body.scrollHeight
    }

    const runBurst = (remainingFrames: number) => {
      if (typeof window === 'undefined' || typeof document === 'undefined') return
      applyBottomScroll()
      if (remainingFrames <= 0) return
      scheduleAnimationFrame(() => runBurst(remainingFrames - 1))
    }

    // Run across several frames and one delayed pass to catch late layout
    // shifts (sticky sections, async message hydration, image/code block sizing).
    scheduleAnimationFrame(() => runBurst(5))
    scheduleTimeout(() => runBurst(2), 80)
  }, [cancelScheduledScrolls])

  // B4-a: is the user currently following the bottom of the conversation? Walk up
  // to the first actually-scrollable ancestor of the anchor and measure. When
  // there is no anchor or no scrollable container (content fits, or SSR/jsdom
  // where these read 0), default to `true` so an auto-scroll is harmless.
  const isNearBottom = useCallback(() => {
    const anchor = chatEndRef.current
    if (!anchor) return true
    let node: HTMLElement | null = anchor.parentElement
    while (node) {
      const { scrollHeight, scrollTop, clientHeight } = node
      if (scrollHeight > clientHeight) {
        return scrollHeight - scrollTop - clientHeight <= CHAT_NEAR_BOTTOM_THRESHOLD_PX
      }
      node = node.parentElement
    }
    return true
  }, [])

  // Auto-scroll effect. B4-a: only when the user is near the bottom. B4-b: the
  // progress dependency is the active view's slice, not the cross-agent map.
  useEffect(() => {
    if (isNearBottom()) scrollChatToBottom()
  }, [
    selectedAgent,
    chatMessages,
    agentSending,
    activeChatProgress,
    isNearBottom,
    scrollChatToBottom,
  ])

  useEffect(() => cancelScheduledScrolls, [cancelScheduledScrolls])

  return { chatEndRef, scrollChatToBottom }
}
