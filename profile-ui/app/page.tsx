'use client'

import { Suspense, useEffect } from 'react'
import { useRouter, useSearchParams } from 'next/navigation'
import { useAuth } from '@components/AuthContext'
import { AuthGate } from '@components/AuthGate'
import { ProfileShell } from '@components/ProfileShell'
import { PROFILE_ROUTES } from '@constants/routes'

function InvitationRedirect() {
  const router = useRouter()
  const searchParams = useSearchParams()

  useEffect(() => {
    const inviteToken = searchParams.get('inviteToken')
    if (!inviteToken) return
    router.replace(PROFILE_ROUTES.invitation(inviteToken))
  }, [router, searchParams])

  return null
}

function HomeContent() {
  const { authState } = useAuth()
  const me = authState.me
  const displayName = me?.profile?.displayName || me?.name || me?.email || 'there'

  return (
    <ProfileShell currentRoute="home">
      <section className="cu-page-stack">
        <div className="cu-card">
          <div className="cu-card__body">
            <p className="eyebrow">Evenfire Profile</p>
            <h2 className="page-title page-title--large">Welcome, {displayName}</h2>
            <p className="body-copy">You are signed in to your Evenfire profile.</p>
          </div>
        </div>

        <div className="cu-card">
          <div className="cu-card__body cu-profile-summary">
            <div>
              <span className="form-field__label">User</span>
              <div>{displayName}</div>
            </div>
            <div>
              <span className="form-field__label">Email</span>
              <div>{me?.email}</div>
            </div>
          </div>
        </div>
      </section>
    </ProfileShell>
  )
}

export default function Page() {
  return (
    <>
      <Suspense fallback={null}>
        <InvitationRedirect />
      </Suspense>
      <AuthGate>
        <HomeContent />
      </AuthGate>
    </>
  )
}
