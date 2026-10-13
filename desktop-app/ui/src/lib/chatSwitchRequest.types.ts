export interface PendingChatSwitchRequest {
  agentRef: string
  chatId: string
  revision: number
  scope: string
  settled: boolean
  promise: Promise<void>
}
