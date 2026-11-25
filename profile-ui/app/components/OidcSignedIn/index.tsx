'use client'

import { useEffect } from 'react'
import { OIDC_SIGNED_IN_MARKER_COOKIE, isOidcReturnTo } from '@constants/oidc'
import { OIDC_RETURN_TO_ROUTES, PROFILE_ROUTES } from '@constants/routes'
import { clearUnconfirmedLogout } from '@lib/api'

function hasSignedInMarker(): boolean {
  return document.cookie
    .split(';')
    .some(pair => pair.trim() === `${OIDC_SIGNED_IN_MARKER_COOKIE}=1`)
}

/** The closed-set page the callback named in `?next=`, otherwise the root. */
function destination(): string {
  const next = new URLSearchParams(window.location.search).get('next')
  return isOidcReturnTo(next) ? OIDC_RETURN_TO_ROUTES[next] : PROFILE_ROUTES.root
}

/**
 * Landing page of a completed OIDC sign-in. The callback sets a marker cookie only when it
 * just issued a session; with the marker this releases the logout fence. Without it (the page
 * opened by hand) the fence stays, as for any page view. Either way the browser then does a
 * full page load of the page sign-in started from (or the root), so the auth context re-reads
 * the session after the fence change.
 */
export function OidcSignedIn() {
  useEffect(() => {
    if (hasSignedInMarker()) {
      document.cookie = `${OIDC_SIGNED_IN_MARKER_COOKIE}=; Path=/; Max-Age=0; Secure; SameSite=Lax`
      clearUnconfirmedLogout()
    }
    window.location.replace(destination())
  }, [])

  return (
    <main className="cu-app cu-app--auth">
      <div className="cu-card cu-card--auth">
        <div className="cu-card__body">Signing you in...</div>
      </div>
    </main>
  )
}
