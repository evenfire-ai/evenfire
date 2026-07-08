'use client'

import { useAuth } from '@components/AuthContext'
import { LoginPanel } from '@components/LoginPanel'
import type { AuthGateProps } from './types'

export function AuthGate({ children }: AuthGateProps) {
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

  return <>{children}</>
}
