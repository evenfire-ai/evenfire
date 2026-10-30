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
import { useToast } from '@components/Toast'
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
import type { AuthCheckResult, AuthContextValue, AuthState } from './types'

const AuthContext = createContext<AuthContextValue | undefined>(undefined)

const UNCONFIRMED_REVOCATION_MESSAGE =
  'You are signed out here, but the server could not confirm that your session was revoked. The old session may remain valid until it expires.'

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
  const { showToast } = useToast()
  const sessionExpiredHandledRef = useRef(false)
  const authCheckSequenceRef = useRef(0)
  const [authState, setAuthState] = useState<AuthState>({
    isLoggedIn: false,
    isLoading: true,
    me: null,
  })
  const [signOutIncomplete, setSignOutIncomplete] = useState(false)

  const checkAuth = useCallback(async (): Promise<AuthCheckResult> => {
    const sequence = ++authCheckSequenceRef.current
    try {
      const me = await getMe({ silentUnauthorized: true })
      if (sequence !== authCheckSequenceRef.current) return { status: 'superseded' }
      sessionExpiredHandledRef.current = false
      setAuthState({ isLoggedIn: true, isLoading: false, me })
      return { status: 'authenticated', me }
    } catch (error) {
      if (sequence !== authCheckSequenceRef.current) return { status: 'superseded' }
      if (isSilentApiError(error)) {
        setAuthState({ isLoggedIn: false, isLoading: false, me: null })
        return { status: 'unauthenticated' }
      }
      clearToken()
      setAuthState({ isLoggedIn: false, isLoading: false, me: null })
      return { status: 'unavailable' }
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
    authCheckSequenceRef.current += 1
    try {
      const result = await loginWithPassword(email, password)
      resetProfileAccessCache()
      const current = await getMe().catch(() => {
        return meFromPasswordLoginResponse(result.me)
      })
      sessionExpiredHandledRef.current = false
      setSignOutIncomplete(false)
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

  const requestRevocation = useCallback(() => {
    void logoutProfileUI()
      .then(({ revocationConfirmed, fencePersisted }) => {
        if (revocationConfirmed) {
          setSignOutIncomplete(false)
          return
        }
        if (!fencePersisted) {
          // Browser storage could not record the logout fence, so the local sign-out
          // outlives only this page. The login screen says so and offers a retry.
          setSignOutIncomplete(true)
          return
        }
        setSignOutIncomplete(false)
        showToast(UNCONFIRMED_REVOCATION_MESSAGE, { tone: 'error', durationMs: 7000 })
      })
      .catch(() => {
        showToast(UNCONFIRMED_REVOCATION_MESSAGE, { tone: 'error', durationMs: 7000 })
      })
  }, [showToast])

  const logout = useCallback(() => {
    authCheckSequenceRef.current += 1
    sessionExpiredHandledRef.current = false
    resetProfileAccessCache(authState.me?.id)
    clearToken()
    setSignOutIncomplete(false)
    setAuthState({ isLoggedIn: false, isLoading: false, me: null })
    requestRevocation()
  }, [authState.me?.id, requestRevocation])

  const value = useMemo(
    () => ({
      authState,
      login,
      logout,
      checkAuth,
      signOutIncomplete,
      retrySignOut: requestRevocation,
    }),
    [authState, checkAuth, login, logout, signOutIncomplete, requestRevocation]
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
