import type { RefObject } from 'react'

export type ChatEndActions = Readonly<{
  chatEndRef?: RefObject<HTMLDivElement | null>
  scrollChatToBottom?: () => void
}> | null

export type ChatEndFollower = Readonly<{
  /** Call right before the content shows. */
  capture: () => void
  /** Call after each change in size. */
  grew: () => void
}>
