'use client'

import { createContext, useContext, useEffect } from 'react'
import { useRouter } from 'next/navigation'
import { useAuth } from '@components/AuthContext'
import { LoadingScreen } from '@components/LoadingScreen'
import { buildControlUiLoginPath, getCurrentControlUiPath } from '@lib/authRedirect'
import type { AuthGateProps } from './types'

const AuthGateContext = createContext(false)

export function AuthGate({ children }: AuthGateProps) {
  const isInsideAuthGate = useContext(AuthGateContext)
  if (isInsideAuthGate) return <>{children}</>

  return <AuthGateBoundary>{children}</AuthGateBoundary>
}

function AuthGateBoundary({ children }: AuthGateProps) {
  const { authState } = useAuth()
  const router = useRouter()

  useEffect(() => {
    if (!authState.isLoading && !authState.isLoggedIn) {
      router.replace(buildControlUiLoginPath(getCurrentControlUiPath()))
    }
  }, [authState.isLoading, authState.isLoggedIn, router])

  if (authState.isLoading) {
    return <LoadingScreen />
  }

  if (!authState.isLoggedIn) {
    return null
  }

  return <AuthGateContext.Provider value>{children}</AuthGateContext.Provider>
}
