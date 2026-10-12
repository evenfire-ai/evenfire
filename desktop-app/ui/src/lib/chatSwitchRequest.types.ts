export interface PendingChatSwitchRequest {
  agentRef: string
  chatId: string
  revision: number
  promise: Promise<void>
}
