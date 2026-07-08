import { useEffect, useState } from 'react'
import type { TaskProgress } from '../../uiTypes'
import { useChatStore } from '../useChatStore'
import type { SidebarChatEntry } from './useAgentChatController'

const ACTIVITY_SUMMARY_CHAT_SCAN_LIMIT = 20

function getChatUpdatedTimestamp(chat: { updatedAt: string }): number {
  const timestamp = Date.parse(chat.updatedAt)
  return Number.isNaN(timestamp) ? 0 : timestamp
}

interface UseActivityControllerParams {
  selectedAgent: string | null
  isAuthenticated: boolean
  chatList: SidebarChatEntry[]
  progressByAgentMessage: Record<string, Record<string, TaskProgress>>
  agentNames: string[]
}

export function useActivityController({
  selectedAgent,
  isAuthenticated,
  chatList,
  progressByAgentMessage,
  agentNames,
}: UseActivityControllerParams) {
  const chatStore = useChatStore()

  const [agentLastActiveByAgent, setAgentLastActiveByAgent] = useState<
    Record<string, string | null>
  >({})
  const [selectedAgentActivitySummary, setSelectedAgentActivitySummary] = useState({
    conversations: 0,
    messages: 0,
    toolCalls: 0,
    errors: 0,
    conversationsPerDay: [] as Array<{ dayLabel: string; count: number }>,
  })

  // Compute agentLastActiveByAgent for all agents
  useEffect(() => {
    if (!isAuthenticated || !agentNames.length) {
      setAgentLastActiveByAgent({})
      return
    }

    let cancelled = false
    ;(async () => {
      const entries = await Promise.all(
        agentNames.map(async agentName => {
          try {
            const index = await chatStore.getIndex(agentName)
            const latestUpdatedAt = (index.chats || [])
              .map((chat: { updatedAt: string }) => chat.updatedAt)
              .filter(
                (updatedAt: string) => typeof updatedAt === 'string' && updatedAt.trim().length > 0
              )
              .sort((a: string, b: string) => Date.parse(b) - Date.parse(a))[0]
            return [agentName, latestUpdatedAt || null] as const
          } catch {
            return [agentName, null] as const
          }
        })
      )
      if (!cancelled) {
        setAgentLastActiveByAgent(Object.fromEntries(entries))
      }
    })()

    return () => {
      cancelled = true
    }
  }, [agentNames, chatStore.getIndex, isAuthenticated])

  // Compute selectedAgentActivitySummary
  useEffect(() => {
    if (!selectedAgent) {
      setSelectedAgentActivitySummary({
        conversations: 0,
        messages: 0,
        toolCalls: 0,
        errors: 0,
        conversationsPerDay: [],
      })
      return
    }

    let cancelled = false
    ;(async () => {
      const dateCursor = new Date()
      const dayKeys: string[] = []
      for (let index = 6; index >= 0; index -= 1) {
        const day = new Date(dateCursor)
        day.setDate(day.getDate() - index)
        dayKeys.push(day.toISOString().slice(0, 10))
      }
      const conversationsPerDayMap = new Map<string, number>(dayKeys.map(key => [key, 0]))
      for (const chat of chatList) {
        const chatTimestamp = Date.parse(chat.updatedAt)
        if (Number.isNaN(chatTimestamp)) continue
        const chatDateKey = new Date(chatTimestamp).toISOString().slice(0, 10)
        if (conversationsPerDayMap.has(chatDateKey)) {
          conversationsPerDayMap.set(
            chatDateKey,
            (conversationsPerDayMap.get(chatDateKey) || 0) + 1
          )
        }
      }

      let totalMessages = 0
      let totalErrors = 0
      if (chatList.length > 0) {
        const chatsToScan = [...chatList]
          .sort((left, right) => getChatUpdatedTimestamp(right) - getChatUpdatedTimestamp(left))
          .slice(0, ACTIVITY_SUMMARY_CHAT_SCAN_LIMIT)
        const messageLists = await Promise.all(
          chatsToScan.map(chat => chatStore.loadMessages(selectedAgent, chat.id).catch(() => []))
        )
        for (const messages of messageLists) {
          totalMessages += messages.length
          totalErrors += messages.filter((message: any) => message.isError).length
        }
      }

      const progressByMessage = progressByAgentMessage[selectedAgent] || {}
      let totalToolCalls = 0
      for (const progress of Object.values(progressByMessage)) {
        totalToolCalls += progress.steps.length
      }

      const formatter = new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric' })
      const conversationsPerDay = [...conversationsPerDayMap.entries()].map(([dayKey, count]) => ({
        dayLabel: formatter.format(new Date(dayKey)),
        count,
      }))

      if (!cancelled) {
        setSelectedAgentActivitySummary({
          conversations: chatList.length,
          messages: totalMessages,
          toolCalls: totalToolCalls,
          errors: totalErrors,
          conversationsPerDay,
        })
      }
    })()

    return () => {
      cancelled = true
    }
  }, [chatList, chatStore.loadMessages, progressByAgentMessage, selectedAgent])

  return {
    agentLastActiveByAgent,
    selectedAgentActivitySummary,
  }
}
