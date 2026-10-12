export interface PendingChatSwitchRequest {
  agentRef: string
  chatId: string
  revision: number
  scope: string
  promise: Promise<void>
}
