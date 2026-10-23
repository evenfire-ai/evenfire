'use client'

import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react'
import { useParams } from 'next/navigation'
import { getMcpServer, isSilentApiError } from '@lib/api'
import type { McpServerResource } from '@lib/api'
import type { ConnectorDetailProviderProps, ConnectorDetailState } from './types'

const ConnectorDetailContext = createContext<ConnectorDetailState | null>(null)

export function ConnectorDetailProvider({ children }: ConnectorDetailProviderProps) {
  const params = useParams<{ name: string }>()
  const name = decodeURIComponent(params?.name ?? '')
  const requestId = useRef(0)
  const [resourceState, setResourceState] = useState<{
    name: string
    server: McpServerResource | null
    error: string
    settled: boolean
  }>({ name: '', server: null, error: '', settled: false })

  const load = useCallback(async () => {
    if (!name) return

    const request = ++requestId.current
    setResourceState(previous => ({
      name,
      server: previous.name === name ? previous.server : null,
      error: '',
      settled: false,
    }))

    try {
      const server = await getMcpServer(name)
      if (request !== requestId.current) return
      setResourceState({ name, server, error: '', settled: true })
    } catch (caught) {
      if (request !== requestId.current) return
      if (isSilentApiError(caught)) {
        setResourceState(previous => ({
          name,
          server: previous.name === name ? previous.server : null,
          error: '',
          settled: true,
        }))
        return
      }
      setResourceState({
        name,
        server: null,
        error: caught instanceof Error ? caught.message : `Connector ${name} was not found.`,
        settled: true,
      })
    }
  }, [name])

  useEffect(() => {
    if (name) {
      void load()
    } else {
      setResourceState({ name: '', server: null, error: '', settled: true })
    }

    return () => {
      requestId.current += 1
    }
  }, [load, name])

  const value = useMemo<ConnectorDetailState>(
    () => ({
      server: resourceState.name === name ? resourceState.server : null,
      loading: !resourceState.settled || resourceState.name !== name,
      error: resourceState.name === name ? resourceState.error : '',
      load,
    }),
    [load, name, resourceState]
  )

  return <ConnectorDetailContext.Provider value={value}>{children}</ConnectorDetailContext.Provider>
}

export function useConnectorDetail(): ConnectorDetailState {
  const context = useContext(ConnectorDetailContext)
  if (!context) throw new Error('useConnectorDetail must be used within ConnectorDetailProvider')
  return context
}
