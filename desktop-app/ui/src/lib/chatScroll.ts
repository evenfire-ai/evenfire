import { CHAT_NEAR_BOTTOM_THRESHOLD_PX } from '@constants/agents'

/** The nearest ancestor that scrolls its content, which clips what the user sees. */
export function scrollContainerOf(node: HTMLElement): HTMLElement | null {
  for (let parent = node.parentElement; parent; parent = parent.parentElement) {
    const { overflowY } = getComputedStyle(parent)
    if (overflowY === 'auto' || overflowY === 'scroll') return parent
  }
  return null
}

/**
 * Is the user following the end of the conversation? Walks up from the
 * end-of-chat anchor to the first actually-scrollable ancestor and measures.
 * With no anchor or no scrollable container (content fits, or jsdom where
 * these read 0) the answer is `true`, so an auto-scroll is harmless.
 */
export function isChatEndNearBottom(anchor: HTMLElement | null): boolean {
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
}
