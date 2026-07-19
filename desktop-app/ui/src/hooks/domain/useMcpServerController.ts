import { useCallback, useEffect, useMemo, useState } from 'react'
import type { HostRuntimeStatus } from '../../../../src/types'
import { DESKTOP_ROUTES } from '../../constants/navigation'
import type { NavItem } from '../../uiTypes'

interface UseMcpServerControllerParams {
  selectedAgent: string | null
  navItem: NavItem
  isAuthenticated: boolean
  agentProviderByName: Record<string, string | null>
}

export function useMcpServerController({
  selectedAgent,
  navItem,
  isAuthenticated,
  agentProviderByName,
}: UseMcpServerControllerParams) {
  const [hostRuntimeStatus, setHostRuntimeStatus] = useState<HostRuntimeStatus | null>(null)
  const [hostRuntimeLoading, setHostRuntimeLoading] = useState(false)
  const [hostRuntimeError, setHostRuntimeError] = useState<string | null>(null)
  const [hostRuntimeLastUpdatedAt, setHostRuntimeLastUpdatedAt] = useState<number | null>(null)
  const [hostStatusReconnectNonce, setHostStatusReconnectNonce] = useState(0)
  const [mcpHealthRefreshing, setMcpHealthRefreshing] = useState(false)

  useEffect(() => {
    if (navItem !== DESKTOP_ROUTES.agents || !selectedAgent || !isAuthenticated) {
      setHostRuntimeLoading(false)
      setHostRuntimeError(null)
      return
    }

    let cancelled = false
    let unsubscribe: (() => Promise<void>) | null = null
    setHostRuntimeLoading(true)

    const connect = async () => {
      try {
        unsubscribe = await window.clerum.rpc.subscribeHostStatus(
          selectedAgent,
          [selectedAgent],
          event => {
            if (cancelled) return
            if (event.type === 'status') {
              setHostRuntimeStatus(event.status)
              setHostRuntimeError(null)
              setHostRuntimeLastUpdatedAt(Date.now())
              setHostRuntimeLoading(false)
              return
            }
            if (event.type === 'error') {
              setHostRuntimeError(event.message)
              setHostRuntimeLoading(false)
            }
          }
        )
      } catch (error) {
        if (cancelled) return
        setHostRuntimeError(error instanceof Error ? error.message : String(error))
        setHostRuntimeLoading(false)
      }
    }

    void connect()
    return () => {
      cancelled = true
      void unsubscribe?.()
    }
  }, [isAuthenticated, navItem, selectedAgent, hostStatusReconnectNonce])

  const hostRuntimeIsStale = useMemo(() => {
    if (!hostRuntimeLastUpdatedAt) return false
    return Date.now() - hostRuntimeLastUpdatedAt > 12000
  }, [hostRuntimeLastUpdatedAt, hostRuntimeStatus, hostRuntimeError])

  const activeLlmModel = useMemo(() => {
    if (!hostRuntimeStatus) return null

    const statusRecord = hostRuntimeStatus as unknown as Record<string, unknown>
    const directModel = statusRecord.model
    if (typeof directModel === 'string' && directModel.trim()) {
      return directModel.trim()
    }

    const llmRecord = statusRecord.llm
    if (!llmRecord || typeof llmRecord !== 'object') {
      return null
    }

    const modelCandidate = (llmRecord as Record<string, unknown>).model
    if (typeof modelCandidate === 'string' && modelCandidate.trim()) {
      return modelCandidate.trim()
    }

    const nameCandidate = (llmRecord as Record<string, unknown>).name
    if (typeof nameCandidate === 'string' && nameCandidate.trim()) {
      return nameCandidate.trim()
    }

    return null
  }, [hostRuntimeStatus])

  const activeLlmProvider = useMemo(() => {
    if (selectedAgent) {
      const catalogProvider = agentProviderByName[selectedAgent]
      if (typeof catalogProvider === 'string' && catalogProvider.trim()) {
        return catalogProvider.trim().toLowerCase()
      }
    }
    if (!hostRuntimeStatus) return null

    const statusRecord = hostRuntimeStatus as unknown as Record<string, unknown>
    const directProvider = statusRecord.provider
    if (typeof directProvider === 'string' && directProvider.trim()) {
      return directProvider.trim().toLowerCase()
    }

    const llmRecord = statusRecord.llm
    if (!llmRecord || typeof llmRecord !== 'object') {
      if (activeLlmModel?.trim().toLowerCase().startsWith('glm-')) {
        return 'zai'
      }
      return null
    }

    const providerCandidate = (llmRecord as Record<string, unknown>).provider
    if (typeof providerCandidate === 'string' && providerCandidate.trim()) {
      return providerCandidate.trim().toLowerCase()
    }

    if (activeLlmModel?.trim().toLowerCase().startsWith('glm-')) {
      return 'zai'
    }

    return null
  }, [activeLlmModel, agentProviderByName, hostRuntimeStatus, selectedAgent])

  const bumpReconnectNonce = useCallback(() => {
    setHostStatusReconnectNonce(n => n + 1)
  }, [])

  return {
    hostRuntimeStatus,
    hostRuntimeLoading,
    hostRuntimeError,
    hostRuntimeLastUpdatedAt,
    hostRuntimeIsStale,
    activeLlmModel,
    activeLlmProvider,
    mcpHealthRefreshing,
    bumpReconnectNonce,
    setMcpHealthRefreshing,
  }
}
