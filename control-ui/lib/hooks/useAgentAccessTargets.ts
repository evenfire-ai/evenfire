'use client'

import { useEffect, useState } from 'react'
import { agentAccessTargetsFromHosts } from '@lib/agentAccessTargets'
import type { AgentAccessTarget, AgentAccessTargetsState } from '@lib/agentAccessTargets.types'
import { getHosts } from '@lib/api'

/** Loads the agents a connector can be given to (Create connector, Add remote server). */
export function useAgentAccessTargets(): AgentAccessTargetsState {
  const [agentTargets, setAgentTargets] = useState<AgentAccessTarget[]>([])
  const [agentsLoading, setAgentsLoading] = useState(true)
  const [agentsError, setAgentsError] = useState('')

  useEffect(() => {
    let cancelled = false
    setAgentsLoading(true)
    setAgentsError('')

    getHosts()
      .then(result => {
        if (!cancelled) setAgentTargets(agentAccessTargetsFromHosts(result.items ?? []))
      })
      .catch(loadError => {
        if (cancelled) return
        setAgentTargets([])
        setAgentsError(
          loadError instanceof Error ? loadError.message : 'Failed to load available agents'
        )
      })
      .finally(() => {
        if (!cancelled) setAgentsLoading(false)
      })

    return () => {
      cancelled = true
    }
  }, [])

  return { agentTargets, agentsLoading, agentsError }
}
