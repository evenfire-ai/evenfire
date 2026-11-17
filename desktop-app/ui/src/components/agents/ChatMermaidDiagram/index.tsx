import { useContext, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { AgentChatActionsContext } from '@contexts/AgentChatActionsContext'
import {
  MERMAID_FALLBACK_WIDTH_PX,
  MERMAID_MAX_WIDTH_PX,
  MERMAID_MIN_WIDTH_PX,
  MERMAID_VIEWPORT_MARGIN,
} from '@constants/mermaid'
import { useDocumentTheme } from '@hooks/useDocumentTheme'
import { useStableCallback } from '@hooks/useStableCallback'
import { isChatEndNearBottom, scrollContainerOf } from '@lib/chatScroll'
import { mermaidDiagrams } from '@lib/mermaidDiagram'
import type { DiagramDrawResult } from '../../../../../src/types'
import type { ChatMermaidDiagramProps } from './types'

/** The app's text font, so a diagram's labels match the chat around it. */
function documentFontFamily(): string {
  const value = getComputedStyle(document.documentElement).getPropertyValue('--font-family-base')
  return value.trim() || 'sans-serif'
}

/**
 * A fenced `mermaid` block of an agent reply, drawn as an image when it comes
 * near the visible chat. Code Mermaid cannot draw stays a code block with the
 * reason.
 */
export function ChatMermaidDiagram({ code, codeBlock }: ChatMermaidDiagramProps) {
  const theme = useDocumentTheme()
  // Read again when the theme changes, the moment the app restyles.
  const fontFamily = useMemo(() => documentFontFamily(), [theme])
  const style = useMemo(() => ({ theme, fontFamily }), [fontFamily, theme])
  const chatActions = useContext(AgentChatActionsContext)
  const containerRef = useRef<HTMLDivElement | null>(null)
  const followChatEndRef = useRef(false)
  // A diagram drawn before, in this style, shows at once when the block mounts again.
  const cached = mermaidDiagrams.peek(code, style)
  const [inView, setInView] = useState(
    () => cached !== null || typeof IntersectionObserver === 'undefined'
  )
  // What the block shows, kept while another theme's drawing is on its way.
  const [drawn, setDrawn] = useState<{ code: string; result: DiagramDrawResult } | null>(() =>
    cached ? { code, result: cached } : null
  )

  // The chat follows its end while the user reads it there, as for new messages.
  const isFollowingChatEnd = useStableCallback(() =>
    chatActions ? isChatEndNearBottom(chatActions.chatEndRef.current) : false
  )
  const scrollChatToEnd = useStableCallback(() => chatActions?.scrollChatToBottom())

  useEffect(() => {
    if (inView) return
    const node = containerRef.current
    if (!node) return
    const observer = new IntersectionObserver(
      entries => {
        if (entries.some(entry => entry.isIntersecting)) setInView(true)
      },
      // The chat scrolls inside its own container, so the margin is measured there.
      { root: scrollContainerOf(node), rootMargin: MERMAID_VIEWPORT_MARGIN }
    )
    observer.observe(node)
    return () => observer.disconnect()
  }, [inView])

  useEffect(() => {
    if (!inView || cached) return
    let active = true
    const measured = Math.round(containerRef.current?.clientWidth || MERMAID_FALLBACK_WIDTH_PX)
    const width = Math.min(MERMAID_MAX_WIDTH_PX, Math.max(MERMAID_MIN_WIDTH_PX, measured))
    void mermaidDiagrams.draw(code, style, width).then(result => {
      if (!active) return
      followChatEndRef.current = isFollowingChatEnd()
      setDrawn({ code, result })
    })
    return () => {
      active = false
    }
  }, [cached, code, inView, isFollowingChatEnd, style])

  useLayoutEffect(() => {
    if (!drawn || !followChatEndRef.current) return
    followChatEndRef.current = false
    scrollChatToEnd()
  }, [drawn, scrollChatToEnd])

  // Until the new theme's drawing is ready, the previous one stays.
  const result = cached ?? (drawn?.code === code ? drawn.result : null)
  if (!result) {
    return (
      <div
        ref={containerRef}
        className="chat-mermaid-diagram chat-mermaid-diagram--pending"
        aria-busy="true"
      >
        <span className="visually-hidden">Drawing diagram</span>
      </div>
    )
  }
  if (!result.ok) {
    return (
      <div ref={containerRef} className="chat-mermaid-diagram">
        <p className="chat-mermaid-diagram__note">
          This diagram could not be drawn: {result.reason}.
        </p>
        {codeBlock}
      </div>
    )
  }
  return (
    <div ref={containerRef} className="chat-mermaid-diagram">
      <img
        className="chat-mermaid-diagram__image"
        src={result.image.src}
        width={result.image.width}
        height={result.image.height}
        alt={result.image.label}
      />
    </div>
  )
}
