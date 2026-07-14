export type AgentActivitySummary = {
  conversations: number
  messages: number
  toolCalls: number
  errors: number
  conversationsPerDay: Array<{
    dayLabel: string
    count: number
  }>
}
