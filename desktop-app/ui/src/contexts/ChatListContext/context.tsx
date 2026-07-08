import { createContext } from 'react'
import type { ChatListContextValue, ChatListProviderProps } from './types'

export const ChatListContext = createContext<ChatListContextValue | null>(null)

export function ChatListProvider({ value, children }: ChatListProviderProps) {
  return <ChatListContext.Provider value={value}>{children}</ChatListContext.Provider>
}
