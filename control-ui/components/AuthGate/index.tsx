'use client'

import { useEffect } from 'react'
import { useRouter } from 'next/navigation'
import { useAuth } from '@components/AuthContext'
import { buildControlUiLoginPath, getCurrentControlUiPath } from '@lib/authRedirect'
import type { AuthGateProps } from './types'

export function AuthGate({ children }: AuthGateProps) {
  const { authState } = useAuth()
  const router = useRouter()

  useEffect(() => {
    if (!authState.isLoading && !authState.isLoggedIn) {
      router.replace(buildControlUiLoginPath(getCurrentControlUiPath()))
    }
  }, [authState.isLoading, authState.isLoggedIn, router])

  if (authState.isLoading) {
    return (
      <div className="cu-app-layout">
        <main className="cu-main">
          <div className="cu-card">
            <div className="cu-card__body">Loading...</div>
          </div>
        </main>
      </div>
    )
  }

  if (!authState.isLoggedIn) {
    return null
  }

  return <>{children}</>
}
