'use client'

import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import { useParams, useSelectedLayoutSegment } from 'next/navigation'
import { useConnectorDetail } from '@components/ConnectorDetailProvider'
import type { ConnectorAgentBinding, ConnectorAgentTarget } from '@components/McpServerTable.types'
import { getContexts, getHosts, isSilentApiError } from '@lib/api'
import {
  addConnectorToAgentContexts,
  connectorAccessMutationError,
  loadConnectorAccessState,
  removeConnectorFromAgentContext,
} from '@lib/connectorAccessManagement'
import type { ConnectorAccessState } from '@lib/connectorAccessManagement'
import type { ConnectorDetailAccessState } from './types'

const ACCESS_TABS = new Set(['users', 'teams', 'agents'])

const ConnectorDetailAccessContext = createContext<ConnectorDetailAccessState | null>(null)

type LoadedAccessState = {
  name: string
  snapshot: ConnectorAccessState | null
  settled: boolean
  loading: boolean
  error: string
}

export function ConnectorDetailAccessProvider({ children }: { children: ReactNode }) {
  const params = useParams<{ name: string }>()
  const name = decodeURIComponent(params?.name ?? '')
  const selectedSegment = useSelectedLayoutSegment()
  const accessRouteActive = ACCESS_TABS.has(selectedSegment ?? '')
  const { server, loading: connectorLoading } = useConnectorDetail()
  const requestId = useRef(0)
  const [loaded, setLoaded] = useState<LoadedAccessState>({
    name: '',
    snapshot: null,
    settled: false,
    loading: false,
    error: '',
  })
  const [updating, setUpdating] = useState(false)
  const [notice, setNotice] = useState('')

  const load = useCallback(async (): Promise<boolean> => {
    if (!name || !server) return false
    const request = ++requestId.current
    setLoaded(previous => ({
      name,
      snapshot: previous.name === name ? previous.snapshot : null,
      settled: false,
      loading: true,
      error: '',
    }))

    try {
      const [contextsResult, hostsResult] = await Promise.all([getContexts(), getHosts()])
      const snapshot = await loadConnectorAccessState(
        [server],
        contextsResult.items ?? [],
        hostsResult.items ?? []
      )
      if (request !== requestId.current) return false
      setLoaded({ name, snapshot, settled: true, loading: false, error: '' })
      return true
    } catch (caught) {
      if (request !== requestId.current) return false
      if (isSilentApiError(caught)) {
        setLoaded(previous => ({
          name,
          snapshot: previous.name === name ? previous.snapshot : null,
          settled: true,
          loading: false,
          error: '',
        }))
        return false
      }
      setLoaded(previous => ({
        name,
        snapshot: previous.name === name ? previous.snapshot : null,
        settled: true,
        loading: false,
        error: caught instanceof Error ? caught.message : 'Failed to load connector access.',
      }))
      return false
    }
  }, [name, server])

  useEffect(() => {
    if (!accessRouteActive || !server || connectorLoading) return
    if (loaded.name === name && (loaded.settled || loaded.loading)) return
    void load()
  }, [accessRouteActive, connectorLoading, load, loaded.name, loaded.snapshot, name, server])

  useEffect(
    () => () => {
      requestId.current += 1
    },
    []
  )

  const currentSnapshot = loaded.name === name ? loaded.snapshot : null
  const serverName = server?.metadata?.name || name
  const serverNamespace = server?.metadata?.namespace || 'default'
  const agentBindings = currentSnapshot?.bindingsByConnectorName[serverName] ?? []
  const agentTargets = currentSnapshot?.agentTargets ?? []

  const refresh = useCallback(async () => {
    setNotice('')
    await load()
  }, [load])

  const addAgents = useCallback(
    async (agents: Array<Pick<ConnectorAgentTarget, 'name' | 'contextRef'>>) => {
      if (!server || !currentSnapshot) return false
      setUpdating(true)
      setNotice('')
      setLoaded(previous => ({ ...previous, error: '' }))
      try {
        await addConnectorToAgentContexts(
          { name: serverName, namespace: serverNamespace },
          agents,
          currentSnapshot.contexts,
          server.spec
        )
        const refreshed = await load()
        setNotice(
          refreshed
            ? 'Agent access updated. The Users and Teams summaries now reflect this change.'
            : 'Agent access updated, but the Users and Teams summaries could not be refreshed.'
        )
        return true
      } catch (caught) {
        if (isSilentApiError(caught)) return false
        setLoaded(previous => ({
          ...previous,
          error: connectorAccessMutationError(
            caught,
            `Failed to give agents access to ${serverName}`
          ),
        }))
        return false
      } finally {
        setUpdating(false)
      }
    },
    [currentSnapshot, load, server, serverName, serverNamespace]
  )

  const removeBinding = useCallback(
    async (binding: ConnectorAgentBinding) => {
      if (!currentSnapshot) return false
      setUpdating(true)
      setNotice('')
      setLoaded(previous => ({ ...previous, error: '' }))
      try {
        await removeConnectorFromAgentContext(serverName, binding, currentSnapshot.contexts)
        const refreshed = await load()
        setNotice(
          refreshed
            ? 'Agent access updated. The Users and Teams summaries now reflect this change.'
            : 'Agent access updated, but the Users and Teams summaries could not be refreshed.'
        )
        return true
      } catch (caught) {
        if (isSilentApiError(caught)) return false
        setLoaded(previous => ({
          ...previous,
          error: connectorAccessMutationError(
            caught,
            `Failed to remove ${serverName} from agent access`
          ),
        }))
        return false
      } finally {
        setUpdating(false)
      }
    },
    [currentSnapshot, load, serverName]
  )

  const value = useMemo<ConnectorDetailAccessState>(
    () => ({
      snapshot: currentSnapshot,
      agentBindings,
      agentTargets,
      loading:
        accessRouteActive &&
        (connectorLoading ||
          (Boolean(server) && (loaded.name !== name || !loaded.settled || loaded.loading))),
      updating,
      error: loaded.name === name ? loaded.error : '',
      notice,
      refresh,
      addAgents,
      removeBinding,
    }),
    [
      accessRouteActive,
      addAgents,
      agentBindings,
      agentTargets,
      connectorLoading,
      currentSnapshot,
      loaded,
      name,
      notice,
      refresh,
      removeBinding,
      server,
      updating,
    ]
  )

  return (
    <ConnectorDetailAccessContext.Provider value={value}>
      {children}
    </ConnectorDetailAccessContext.Provider>
  )
}

export function useOptionalConnectorDetailAccess(): ConnectorDetailAccessState | null {
  return useContext(ConnectorDetailAccessContext)
}

export function useConnectorDetailAccess(): ConnectorDetailAccessState {
  const context = useOptionalConnectorDetailAccess()
  if (!context) {
    throw new Error('useConnectorDetailAccess must be used within ConnectorDetailAccessProvider')
  }
  return context
}
