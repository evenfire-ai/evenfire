import { createContext, useContext } from 'react'
import type { ChatLinkActivation } from '../lib/chatLinkActivation'

// Inert by default so chat surfaces rendered outside the authenticated App
// (and tests that mock the navigation context) keep links non-navigating.
const inertChatLinkActivation: ChatLinkActivation = async () => {}

const ChatLinkActivationContext = createContext<ChatLinkActivation>(inertChatLinkActivation)

export function useChatLinkActivation(): ChatLinkActivation {
  return useContext(ChatLinkActivationContext)
}

export { ChatLinkActivationContext }
