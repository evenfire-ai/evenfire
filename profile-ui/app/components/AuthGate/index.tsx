'use client'

import { createContext, useContext } from 'react'
import { useAuth } from '@components/AuthContext'
import { LoginPanel } from '@components/LoginPanel'
import type { AuthGateProps } from './types'

const AuthGateContext = createContext(false)

export function AuthGate({ children }: AuthGateProps) {
  const isInsideAuthGate = useContext(AuthGateContext)
  if (isInsideAuthGate) return <>{children}</>

  return <AuthGateBoundary>{children}</AuthGateBoundary>
}

function AuthGateBoundary({ children }: AuthGateProps) {
  const { authState } = useAuth()

  if (authState.isLoading) {
    return (
      <main className="cu-app cu-app--auth">
        <div className="cu-card cu-card--auth">
          <div className="cu-card__body">Loading...</div>
        </div>
      </main>
    )
  }

  if (!authState.isLoggedIn) {
    return <LoginPanel />
  }

  return <AuthGateContext.Provider value>{children}</AuthGateContext.Provider>
}
