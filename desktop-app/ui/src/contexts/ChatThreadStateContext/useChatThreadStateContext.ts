import { useContext } from 'react'
import { ChatThreadStateContext } from './context'
import type { ChatThreadStateContextValue } from './types'

export function useChatThreadStateContext(): ChatThreadStateContextValue {
  const ctx = useContext(ChatThreadStateContext)
  if (!ctx) throw new Error('useChatThreadStateContext must be used within ChatThreadStateProvider')
  return ctx
}
