import { createContext } from 'react'
import type { ChatComposerStateContextValue, ChatComposerStateProviderProps } from './types'

export const ChatComposerStateContext = createContext<ChatComposerStateContextValue | null>(null)

export function ChatComposerStateProvider({ value, children }: ChatComposerStateProviderProps) {
  return (
    <ChatComposerStateContext.Provider value={value}>{children}</ChatComposerStateContext.Provider>
  )
}
