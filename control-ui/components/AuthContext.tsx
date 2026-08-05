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
import { useRouter } from 'next/navigation'
import { CONTROL_ROUTES } from '@constants/routes'
import {
  type AdminLoginResponse,
  getControlUIAuthMe,
  isSilentApiError,
  loginControlUI,
  logoutControlUI,
  setGlobalAuthErrorHandler,
} from '../lib/api'
import { buildControlUiLoginPath, getCurrentControlUiPath } from '../lib/authRedirect'
import { resetPublishScopeCache } from '../lib/hooks/usePublishScope'
import { invalidateRegistryCapabilityCache } from '../lib/hooks/useRegistryCapability'
import { useToast } from './Toast'

type AuthState = {
  id: string
  isLoggedIn: boolean
  isLoading: boolean
  username: string
  email: string
}

type AuthContextValue = {
  authState: AuthState
  login: (username: string, password: string) => Promise<AdminLoginResponse>
  logout: () => Promise<void>
  checkAuth: () => Promise<void>
}

const AuthContext = createContext<AuthContextValue | undefined>(undefined)

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const router = useRouter()
  const { showToast } = useToast()
  const [authState, setAuthState] = useState<AuthState>({
    id: '',
    isLoggedIn: false,
    isLoading: true,
    username: '',
    email: '',
  })
  const sessionExpiredToastShownRef = useRef(false)

  // The router and ToastProvider callbacks are stable in normal runtime; keep
  // this singleton registration tied to them if either provider is remounted.
  useEffect(() => {
    const handleAuthError = () => {
      if (sessionExpiredToastShownRef.current) return
      sessionExpiredToastShownRef.current = true
      resetPublishScopeCache()
      invalidateRegistryCapabilityCache()
      setAuthState({ id: '', isLoggedIn: false, isLoading: false, username: '', email: '' })
      router.replace(buildControlUiLoginPath(getCurrentControlUiPath()))
      showToast('Session expired. Please sign in again.', { tone: 'error' })
    }
    setGlobalAuthErrorHandler(handleAuthError)
  }, [router, showToast])

  const checkAuth = useCallback(async () => {
    try {
      const response = await getControlUIAuthMe()
      sessionExpiredToastShownRef.current = false
      setAuthState(prev => ({
        ...prev,
        id: response.me.id || prev.id,
        isLoggedIn: true,
        isLoading: false,
        username: response.me.username || prev.username,
        email: response.me.email || prev.email,
      }))
    } catch (error) {
      // Session-expiry errors are handled by the global toast/redirect path.
      if (isSilentApiError(error)) {
        setAuthState({ id: '', isLoggedIn: false, isLoading: false, username: '', email: '' })
        return
      }
      setAuthState({ id: '', isLoggedIn: false, isLoading: false, username: '', email: '' })
    }
  }, [])

  useEffect(() => {
    void checkAuth()
  }, [checkAuth])

  const login = useCallback(
    async (username: string, password: string): Promise<AdminLoginResponse> => {
      const result = await loginControlUI(username, password)
      resetPublishScopeCache()
      invalidateRegistryCapabilityCache()
      sessionExpiredToastShownRef.current = false
      setAuthState({
        id: result.me.id,
        isLoggedIn: true,
        isLoading: false,
        username: result.me.username || username,
        email: result.me.email || '',
      })
      return result
    },
    []
  )

  const logout = useCallback(async () => {
    try {
      await logoutControlUI()
    } finally {
      resetPublishScopeCache(authState.id)
      sessionExpiredToastShownRef.current = false
      // Drop the module-level registry-capability cache so a same-tab
      // logout→login doesn't serve the previous user's org identity.
      invalidateRegistryCapabilityCache()
      setAuthState({ id: '', isLoggedIn: false, isLoading: false, username: '', email: '' })
      router.replace(CONTROL_ROUTES.login)
    }
  }, [authState.id, router])

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
