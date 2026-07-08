import { useContext } from 'react'
import { ChatComposerStateContext } from './context'
import type { ChatComposerStateContextValue } from './types'

export function useChatComposerStateContext(): ChatComposerStateContextValue {
  const ctx = useContext(ChatComposerStateContext)
  if (!ctx)
    throw new Error('useChatComposerStateContext must be used within ChatComposerStateProvider')
  return ctx
}
