import { type RefObject, useContext, useEffect, useMemo, useRef, useState } from 'react'
import { AgentChatActionsContext } from '@contexts/AgentChatActionsContext'
import { CHAT_NEAR_BOTTOM_THRESHOLD_PX } from '@constants/agents'
import { CHAT_FILE_PREVIEW_FOLLOW_MS } from '@constants/chatRendering'
import { scrollContainerOf } from '@lib/chatScroll'
import type { ChatEndActions, ChatEndFollower } from './useNearChatViewport.types'

/** Latches to true once the element comes within `margin` of the visible chat. */
export function useNearChatViewport(ref: RefObject<HTMLElement | null>, margin: string): boolean {
  const [near, setNear] = useState(() => typeof IntersectionObserver === 'undefined')
  useEffect(() => {
    const node = ref.current
    if (near || !node || typeof IntersectionObserver === 'undefined') return
    const observer = new IntersectionObserver(
      entries => {
        if (entries.some(entry => entry.isIntersecting)) setNear(true)
      },
      { root: scrollContainerOf(node), rootMargin: margin }
    )
    observer.observe(node)
    return () => observer.disconnect()
  }, [margin, near, ref])
  return near
}

/** Keeps the chat pinned to its end while a preview grows, unless the user scrolled away. */
export function useChatEndFollower(actions: ChatEndActions): ChatEndFollower {
  const latest = useRef(actions)
  latest.current = actions
  const followUntil = useRef(0)
  const heightBefore = useRef(0)
  return useMemo(() => {
    const chatOf = () => {
      const end = latest.current?.chatEndRef?.current
      return end ? scrollContainerOf(end) : null
    }
    return {
      capture: () => {
        followUntil.current = Date.now() + CHAT_FILE_PREVIEW_FOLLOW_MS
        heightBefore.current = chatOf()?.scrollHeight ?? 0
      },
      grew: () => {
        if (Date.now() > followUntil.current) return
        const chat = chatOf()
        if (chat) {
          // The height before the growth tells whether the user was at the end.
          const height = Math.min(heightBefore.current, chat.scrollHeight)
          if (height - chat.scrollTop - chat.clientHeight > CHAT_NEAR_BOTTOM_THRESHOLD_PX) {
            // The chat may not have scrolled to its new end yet.
            heightBefore.current = chat.scrollHeight
            return
          }
          heightBefore.current = chat.scrollHeight
        }
        latest.current?.scrollChatToBottom?.()
      },
    }
  }, [])
}

export function useChatEndFollowerFromContext(): ChatEndFollower {
  return useChatEndFollower(useContext(AgentChatActionsContext))
}
