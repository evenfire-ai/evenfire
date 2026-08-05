'use client'

import type { ReactNode } from 'react'
import { usePathname } from 'next/navigation'
import { isPublicControlUiPath } from '@lib/controlAppFrame'
import { PublishScopeProvider } from '@lib/hooks/usePublishScope'
import { useAuth } from './AuthContext'
import { AuthGate } from './AuthGate'
import { DashboardLayout } from './DashboardLayout'

export function ControlAppFrame({ children }: { children: ReactNode }) {
  const pathname = usePathname()
  const { authState } = useAuth()

  if (isPublicControlUiPath(pathname)) {
    return <>{children}</>
  }

  return (
    <AuthGate>
      <PublishScopeProvider cacheKey={authState.id}>
        <DashboardLayout>{children}</DashboardLayout>
      </PublishScopeProvider>
    </AuthGate>
  )
}
