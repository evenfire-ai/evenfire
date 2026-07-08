import { createContext } from 'react'
import type { ChatThreadStateContextValue, ChatThreadStateProviderProps } from './types'

export const ChatThreadStateContext = createContext<ChatThreadStateContextValue | null>(null)

export function ChatThreadStateProvider({ value, children }: ChatThreadStateProviderProps) {
  return <ChatThreadStateContext.Provider value={value}>{children}</ChatThreadStateContext.Provider>
}
