'use client'

import {
  type ReactNode,
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
} from 'react'
import { getControlUISettingsMe, getIdentityProviderConnections } from '@lib/api'
import type { ControlAdminProfile } from '@lib/api'
import type { IdentityProviderConnection } from '@lib/identityProviders.types'
import type { PendingAdminEmailChange, SettingsDataContextValue } from './types'

const SettingsDataContext = createContext<SettingsDataContextValue | undefined>(undefined)

export function SettingsDataProvider({ children }: { children: ReactNode }) {
  const [profile, setProfile] = useState<ControlAdminProfile | null>(null)
  const [connections, setConnections] = useState<IdentityProviderConnection[]>([])
  const [microsoftCallbackUrl, setMicrosoftCallbackUrl] = useState('')
  const [accountLoading, setAccountLoading] = useState(true)
  const [connectionsLoading, setConnectionsLoading] = useState(true)
  const [accountError, setAccountError] = useState('')
  const [integrationsError, setIntegrationsError] = useState('')

  const loadAccount = useCallback(async () => {
    setAccountLoading(true)
    setAccountError('')
    try {
      const response = await getControlUISettingsMe()
      setProfile(response.me)
    } catch (loadError) {
      setAccountError(loadError instanceof Error ? loadError.message : 'Failed to load settings')
    } finally {
      setAccountLoading(false)
    }
  }, [])

  const refreshConnections = useCallback(async () => {
    setConnectionsLoading(true)
    setIntegrationsError('')
    try {
      const response = await getIdentityProviderConnections()
      setConnections(response.items || [])
      setMicrosoftCallbackUrl(response.callbackUrl || '')
    } catch (loadError) {
      setIntegrationsError(
        loadError instanceof Error ? loadError.message : 'Failed to load integrations'
      )
    } finally {
      setConnectionsLoading(false)
    }
  }, [])

  useEffect(() => {
    void Promise.all([loadAccount(), refreshConnections()])
  }, [loadAccount, refreshConnections])

  const updatePendingEmailChange = useCallback(
    (pendingEmailChange: PendingAdminEmailChange | null) => {
      setProfile(current => (current ? { ...current, pendingEmailChange } : current))
    },
    []
  )

  const removeConnection = useCallback((connectionId: string) => {
    setConnections(current => current.filter(connection => connection.id !== connectionId))
  }, [])

  const replaceConnection = useCallback((connection: IdentityProviderConnection) => {
    setConnections(current => current.map(item => (item.id === connection.id ? connection : item)))
  }, [])

  const value = useMemo<SettingsDataContextValue>(
    () => ({
      accountError,
      accountLoading,
      connections,
      connectionsLoading,
      integrationsError,
      microsoftCallbackUrl,
      profile,
      refreshConnections,
      removeConnection,
      replaceConnection,
      updatePendingEmailChange,
      updateProfile: setProfile,
    }),
    [
      accountError,
      accountLoading,
      connections,
      connectionsLoading,
      integrationsError,
      microsoftCallbackUrl,
      profile,
      refreshConnections,
      removeConnection,
      replaceConnection,
      updatePendingEmailChange,
    ]
  )

  return <SettingsDataContext.Provider value={value}>{children}</SettingsDataContext.Provider>
}

export function useSettingsData(): SettingsDataContextValue {
  const context = useContext(SettingsDataContext)
  if (!context) throw new Error('useSettingsData must be used within SettingsDataProvider')
  return context
}
