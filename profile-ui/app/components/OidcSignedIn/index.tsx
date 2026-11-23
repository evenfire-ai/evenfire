'use client'

import { useEffect } from 'react'
import { OIDC_SIGNED_IN_MARKER_COOKIE } from '@constants/oidc'
import { PROFILE_ROUTES } from '@constants/routes'
import { clearUnconfirmedLogout } from '@lib/api'

function hasSignedInMarker(): boolean {
  return document.cookie
    .split(';')
    .some(pair => pair.trim() === `${OIDC_SIGNED_IN_MARKER_COOKIE}=1`)
}

/**
 * Landing page of a completed OIDC sign-in. The callback sets a marker cookie only when it
 * just issued a session; with the marker this releases the logout fence. Without it (the page
 * opened by hand) the fence stays, as for any page view. Either way the browser then does a
 * full page load so the auth context re-reads the session after the fence change.
 */
export function OidcSignedIn() {
  useEffect(() => {
    if (hasSignedInMarker()) {
      document.cookie = `${OIDC_SIGNED_IN_MARKER_COOKIE}=; Path=/; Max-Age=0; Secure; SameSite=Lax`
      clearUnconfirmedLogout()
    }
    window.location.replace(PROFILE_ROUTES.root)
  }, [])

  return (
    <main className="cu-app cu-app--auth">
      <div className="cu-card cu-card--auth">
        <div className="cu-card__body">Signing you in...</div>
      </div>
    </main>
  )
}
