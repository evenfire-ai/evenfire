'use client'

import React, {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react'
import {
  clearToken,
  getMe,
  isSilentApiError,
  loginWithPassword,
  logoutProfileUI,
  setGlobalAuthErrorHandler,
} from '@lib/api'
import { resetProfileAccessCache } from '@lib/profileAccess'
import type { PasswordLoginResponse } from '@/app/types/api'
import type { Me } from '@/app/types/profile'
import type { AuthContextValue, AuthState } from './types'

const AuthContext = createContext<AuthContextValue | undefined>(undefined)

function meFromPasswordLoginResponse(me: PasswordLoginResponse['me']): Me {
  return {
    id: me.id,
    email: me.email,
    name: me.name || undefined,
    picture: me.picture || undefined,
    teamId: me.teamId,
    teamName: me.teamName,
    role: me.role,
    profile: {
      displayName: me.name || me.email,
      channels: {
        emails: [],
        telegramHandles: [],
        slackUserNames: [],
        telegramIds: [],
        discordUserNames: [],
        whatsappNumbers: [],
      },
    },
  }
}

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const sessionExpiredHandledRef = useRef(false)
  const [authState, setAuthState] = useState<AuthState>({
    isLoggedIn: false,
    isLoading: true,
    me: null,
  })

  const checkAuth = useCallback(async () => {
    try {
      const me = await getMe({ silentUnauthorized: true })
      sessionExpiredHandledRef.current = false
      setAuthState({ isLoggedIn: true, isLoading: false, me })
    } catch (error) {
      if (isSilentApiError(error)) {
        setAuthState({ isLoggedIn: false, isLoading: false, me: null })
        return
      }
      clearToken()
      setAuthState({ isLoggedIn: false, isLoading: false, me: null })
    }
  }, [])

  useEffect(() => {
    setGlobalAuthErrorHandler(() => {
      if (sessionExpiredHandledRef.current) return
      sessionExpiredHandledRef.current = true
      resetProfileAccessCache()
      setAuthState({ isLoggedIn: false, isLoading: false, me: null })
    })
  }, [])

  useEffect(() => {
    void checkAuth()
  }, [checkAuth])

  const login = useCallback(async (email: string, password: string) => {
    try {
      const result = await loginWithPassword(email, password)
      resetProfileAccessCache()
      const current = await getMe().catch(error => {
        return meFromPasswordLoginResponse(result.me)
      })
      sessionExpiredHandledRef.current = false
      setAuthState({
        isLoggedIn: true,
        isLoading: false,
        me: current,
      })
      return result
    } catch (error) {
      clearToken()
      setAuthState({ isLoggedIn: false, isLoading: false, me: null })
      throw error
    }
  }, [])

  const logout = useCallback(() => {
    sessionExpiredHandledRef.current = false
    resetProfileAccessCache(authState.me?.id)
    void logoutProfileUI()
    setAuthState({ isLoggedIn: false, isLoading: false, me: null })
  }, [authState.me?.id])

  const value = useMemo(
    () => ({ authState, login, logout, checkAuth }),
    [authState, checkAuth, login, logout]
  )

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>
}

export function useAuth() {
  const context = useContext(AuthContext)
  if (!context) {
    throw new Error('useAuth must be used within an AuthProvider')
  }
  return context
}
