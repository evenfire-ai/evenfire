import { useEffect, useMemo, useState } from 'react'
import type { TaskProgress } from '../../uiTypes'
import { useChatStore } from '../useChatStore'
import type { SidebarChatEntry } from './useAgentChatController'

interface UseActivityControllerParams {
  selectedAgent: string | null
  isAuthenticated: boolean
  loadMenuData: boolean
  chatList: SidebarChatEntry[]
  progressByAgentMessage: Record<string, Record<string, TaskProgress>>
  agentNames: string[]
}

export function useActivityController({
  selectedAgent,
  isAuthenticated,
  loadMenuData,
  chatList,
  progressByAgentMessage,
  agentNames,
}: UseActivityControllerParams) {
  const chatStore = useChatStore()

  const [agentLastActiveByAgent, setAgentLastActiveByAgent] = useState<
    Record<string, string | null>
  >({})
  const selectedAgentActivitySummary = useMemo(() => {
    if (!selectedAgent) {
      return {
        conversations: 0,
        messages: 0,
        toolCalls: 0,
        errors: 0,
        conversationsPerDay: [] as Array<{ dayLabel: string; count: number }>,
      }
    }

    const dateCursor = new Date()
    const dayKeys: string[] = []
    for (let index = 6; index >= 0; index -= 1) {
      const day = new Date(dateCursor)
      day.setDate(day.getDate() - index)
      dayKeys.push(day.toISOString().slice(0, 10))
    }

    const conversationsPerDayMap = new Map<string, number>(dayKeys.map(key => [key, 0]))
    let totalMessages = 0
    let totalErrors = 0
    let persistedToolCalls = 0

    for (const chat of chatList) {
      totalMessages += chat.messageCount || 0
      totalErrors += chat.errorCount || 0
      persistedToolCalls += chat.toolCallCount || 0

      const chatTimestamp = Date.parse(chat.updatedAt)
      if (Number.isNaN(chatTimestamp)) continue
      const chatDateKey = new Date(chatTimestamp).toISOString().slice(0, 10)
      if (conversationsPerDayMap.has(chatDateKey)) {
        conversationsPerDayMap.set(chatDateKey, (conversationsPerDayMap.get(chatDateKey) || 0) + 1)
      }
    }

    const liveToolCalls = Object.values(progressByAgentMessage[selectedAgent] || {}).reduce(
      (total, progress) => total + progress.steps.length,
      0
    )
    const formatter = new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric' })

    return {
      conversations: chatList.length,
      messages: totalMessages,
      toolCalls: Math.max(persistedToolCalls, liveToolCalls),
      errors: totalErrors,
      conversationsPerDay: [...conversationsPerDayMap.entries()].map(([dayKey, count]) => ({
        dayLabel: formatter.format(new Date(dayKey)),
        count,
      })),
    }
  }, [chatList, progressByAgentMessage, selectedAgent])

  // Compute agentLastActiveByAgent for all agents
  useEffect(() => {
    if (!isAuthenticated || !loadMenuData || !agentNames.length) {
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
  }, [agentNames, chatStore.getIndex, isAuthenticated, loadMenuData])

  return {
    agentLastActiveByAgent,
    selectedAgentActivitySummary,
  }
}
