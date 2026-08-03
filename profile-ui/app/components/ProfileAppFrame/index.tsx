'use client'

import type { ReactNode } from 'react'
import { usePathname, useSearchParams } from 'next/navigation'
import { AuthGate } from '@components/AuthGate'
import { ProfileAccessProvider } from '@components/ProfileAccessContext'
import { ProfileShell } from '@components/ProfileShell'
import { isPublicProfileUiRequest } from '@lib/profileAppFrame'

export function ProfileAppFrame({ children }: { children: ReactNode }) {
  const pathname = usePathname()
  const searchParams = useSearchParams()

  if (isPublicProfileUiRequest(pathname, searchParams)) {
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
