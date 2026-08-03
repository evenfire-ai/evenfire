'use client'

import type { ReactNode } from 'react'
import { usePathname } from 'next/navigation'
import { AuthGate } from '@components/AuthGate'
import { ProfileAccessProvider } from '@components/ProfileAccessContext'
import { ProfileShell } from '@components/ProfileShell'
import { isPublicProfileUiPath } from '@lib/profileAppFrame'

export function ProfileAppFrame({ children }: { children: ReactNode }) {
  const pathname = usePathname()

  if (isPublicProfileUiPath(pathname)) {
    return <>{children}</>
  }

  return (
    <AuthGate>
      <ProfileAccessProvider>
        <ProfileShell>{children}</ProfileShell>
      </ProfileAccessProvider>
    </AuthGate>
  )
}
