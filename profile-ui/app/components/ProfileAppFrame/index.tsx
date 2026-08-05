'use client'

import type { ReactNode } from 'react'
import { useEffect } from 'react'
import { usePathname, useRouter, useSearchParams } from 'next/navigation'
import { AuthGate } from '@components/AuthGate'
import { ProfileAccessProvider } from '@components/ProfileAccessContext'
import { ProfileShell } from '@components/ProfileShell'
import { PROFILE_ROUTES } from '@constants/routes'
import { getRootInviteToken, isPublicProfileUiPath } from '@lib/profileAppFrame'

export function ProfileAppFrame({ children }: { children: ReactNode }) {
  const router = useRouter()
  const pathname = usePathname()
  const searchParams = useSearchParams()
  const rootInviteToken = getRootInviteToken(pathname, searchParams)

  useEffect(() => {
    if (!rootInviteToken) return
    router.replace(PROFILE_ROUTES.invitation(rootInviteToken))
  }, [rootInviteToken, router])

  if (rootInviteToken) return null

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
