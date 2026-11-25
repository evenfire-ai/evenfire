'use client'

import { useState } from 'react'
import { useAuth } from '@components/AuthContext'
import { Button } from '@components/Button'
import { ProfileApiError, createDesktopAuthorization, isSilentApiError } from '@lib/api'
import { buildDesktopSetupLink, navigateToDesktopApp } from '@lib/desktopAppLinks'
import type { DesktopSetupState } from './types'

const AUTHORIZE_COPY = 'Authorize Evenfire Desktop to finish setting up with this account.'
const OPENED_COPY = "Continue setup in Evenfire Desktop. If it didn't open, authorize again."
const UNAVAILABLE_COPY =
  "Desktop setup by invitation isn't available for this account. Use Settings → Setup desktop app instead."
const FAILED_COPY = "Desktop setup couldn't be authorized. Try again."

/**
 * Authorizes Evenfire Desktop for the signed-in member. The session is the only authority: the
 * link carries the session's email, never the page's `?email=`, which only pre-fills sign-in.
 */
export function DesktopSetupPanel() {
  const { authState } = useAuth()
  const email = (authState.me?.email ?? '').trim().toLowerCase()
  const [state, setState] = useState<DesktopSetupState>('idle')

  async function authorize() {
    if (!email) return
    setState('pending')
    try {
      const { authorizationToken } = await createDesktopAuthorization()
      navigateToDesktopApp(buildDesktopSetupLink(email, authorizationToken))
      setState('opened')
    } catch (error) {
      // Not logged and not shown: the error can carry the edge's body. An expired session (a
      // silent 401) has already handed the page back to sign-in; anything else is retried
      // by pressing the button again.
      if (isSilentApiError(error)) {
        setState('idle')
        return
      }
      setState(error instanceof ProfileApiError && error.status === 404 ? 'unavailable' : 'failed')
    }
  }

  const errorCopy =
    state === 'unavailable' ? UNAVAILABLE_COPY : state === 'failed' ? FAILED_COPY : ''

  return (
    <main className="center-page">
      <section className="page-card">
        <div className="stack-tight">
          <p className="eyebrow">Evenfire Desktop</p>
          <h1 className="page-title page-title--large">Set up desktop app</h1>
          <p className="body-copy">{state === 'opened' ? OPENED_COPY : AUTHORIZE_COPY}</p>
        </div>

        <div className="invite-card">
          <strong>Signed in as</strong>
          <div className="body-copy">{email}</div>
        </div>

        {errorCopy ? <div className="message message--error">{errorCopy}</div> : null}

        <Button onClick={() => void authorize()} disabled={state === 'pending' || !email}>
          {`Authorize Desktop for ${email}`}
        </Button>
      </section>
    </main>
  )
}
