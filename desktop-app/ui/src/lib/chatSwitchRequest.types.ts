export interface PendingChatSwitchRequest {
  agentRef: string
  chatId: string
  revision: number
  scope: string
  state: 'pending' | 'fulfilled' | 'rejected'
  promise: Promise<void>
}
