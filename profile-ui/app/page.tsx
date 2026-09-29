'use client'

import { useEffect, useState } from 'react'
import Link from 'next/link'
import { useAuth } from '@components/AuthContext'
import { AuthGate } from '@components/AuthGate'
import { IconExternalLink } from '@components/icons'
import { PROFILE_ROUTES } from '@constants/routes'
import { getDesktopEnvironment } from '@lib/api'
import { buildDesktopEnvironmentLink } from '@lib/desktopAppLinks'

function HomeContent() {
  const { authState } = useAuth()
  const me = authState.me
  const displayName = me?.profile?.displayName || me?.name || me?.email || 'there'
  const [desktopAppLink, setDesktopAppLink] = useState<
    { state: 'loading' } | { state: 'ready'; href: string } | { state: 'unavailable' }
  >({ state: 'loading' })

  useEffect(() => {
    let isCurrent = true
    void getDesktopEnvironment()
      .then(environment => {
        if (!isCurrent) return
        const href = buildDesktopEnvironmentLink(environment)
        setDesktopAppLink(href ? { state: 'ready', href } : { state: 'unavailable' })
      })
      .catch(() => {
        if (isCurrent) setDesktopAppLink({ state: 'unavailable' })
      })

    return () => {
      isCurrent = false
    }
  }, [])

  return (
    <section className="cu-page-stack">
      <div className="cu-card">
        <div className="cu-card__body">
          <p className="eyebrow">Evenfire Profile</p>
          <h2 className="page-title page-title--large">Welcome, {displayName}</h2>
        </div>
      </div>

      <div className="cu-card">
        <div className="cu-card__body">
          <p className="body-copy">
            You are signed in to the Evenfire <strong>Profile Portal</strong>.
          </p>
          {desktopAppLink.state === 'loading' ? (
            <p className="body-copy" role="status" aria-live="polite">
              Checking desktop app setup…
            </p>
          ) : desktopAppLink.state === 'unavailable' ? (
            <p className="body-copy" role="status" aria-live="polite">
              Desktop app setup is unavailable right now. Visit{' '}
              <Link href={PROFILE_ROUTES.settings.profile}>Settings</Link> to review setup options.
            </p>
          ) : (
            <p className="body-copy">
              Prefer the desktop app?{' '}
              <a className="cu-home-desktop-link" href={desktopAppLink.href}>
                Set up Desktop App <IconExternalLink />
              </a>
            </p>
          )}
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
