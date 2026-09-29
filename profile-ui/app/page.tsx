'use client'

import { useEffect, useState } from 'react'
import { useAuth } from '@components/AuthContext'
import { AuthGate } from '@components/AuthGate'
import { IconExternalLink } from '@components/icons'
import { getDesktopEnvironment } from '@lib/api'
import { buildDesktopEnvironmentLink } from '@lib/desktopAppLinks'

function HomeContent() {
  const { authState } = useAuth()
  const me = authState.me
  const displayName = me?.profile?.displayName || me?.name || me?.email || 'there'
  const [desktopAppHref, setDesktopAppHref] = useState<string | null>(null)

  useEffect(() => {
    let isCurrent = true
    void getDesktopEnvironment()
      .then(environment => {
        if (isCurrent) setDesktopAppHref(buildDesktopEnvironmentLink(environment))
      })
      .catch(() => {
        if (isCurrent) setDesktopAppHref(null)
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
          <p className="body-copy">
            {desktopAppHref ? (
              <a className="cu-home-desktop-link" href={desktopAppHref}>
                Set up Desktop App <IconExternalLink />
              </a>
            ) : (
              <span
                className="cu-home-desktop-link cu-home-desktop-link--unavailable"
                aria-disabled="true"
              >
                Set up Desktop App <IconExternalLink />
              </span>
            )}{' '}
            instead
          </p>
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
