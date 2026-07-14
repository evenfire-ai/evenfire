import { useContext } from 'react'
import { ChatListContext } from './context'
import type { ChatListContextValue } from './types'

export function useChatListContext(): ChatListContextValue {
  const ctx = useContext(ChatListContext)
  if (!ctx) throw new Error('useChatListContext must be used within ChatListProvider')
  return ctx
}
