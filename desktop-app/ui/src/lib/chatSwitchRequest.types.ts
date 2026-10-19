export interface PendingChatSwitchRequest {
  agentRef: string
  chatId: string
  revision: number
  scope: string
  state: 'pending' | 'fulfilled' | 'rejected'
  promise: Promise<void>
}

/** A chat shown from memory whose last-active write and first local page have not settled. */
export interface ProvisionalSelection {
  /** The switch request that painted it. */
  request: symbol
  /** The selection intent that owns it; a same-row click takes it over. */
  revision: number
  agentRef: string
  chatId: string
}
