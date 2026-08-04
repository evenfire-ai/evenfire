'use client'

import { useAuth } from '@components/AuthContext'
import { AuthGate } from '@components/AuthGate'

function HomeContent() {
  const { authState } = useAuth()
  const me = authState.me
  const displayName = me?.profile?.displayName || me?.name || me?.email || 'there'

  return (
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
  )
}

export default function Page() {
  return (
    <AuthGate>
      <HomeContent />
    </AuthGate>
  )
}
