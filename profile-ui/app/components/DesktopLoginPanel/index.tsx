'use client'

import type { FormEvent } from 'react'
import { useEffect, useRef, useState } from 'react'
import Image from 'next/image'
import { buildDesktopLoginErrorLink, parseDesktopLoginFragment } from '@clerum/desktop-app-links'
import { Button } from '@components/Button'
import { DESKTOP_SIGN_IN_COPY } from '@constants/oidc'
import { PROFILE_ROUTES } from '@constants/routes'
import { getOidcSignInMethod } from '@lib/api'
import { navigateToDesktopApp } from '@lib/desktopAppLinks'
import type { DesktopLoginPanelProps, DesktopLoginView } from './types'

/**
 * The page Evenfire Desktop opens as `/desktop-login#challenge=…&state=…`. The values travel
 * only in the fragment, which no browser sends to a server, so the panel reads them here with the
 * package's strict parser and posts exactly those two values to `/api/oidc/desktop-start`. Every
 * sign-in is a provider round trip: the panel never reads or sets the Profile session.
 */
export function DesktopLoginPanel(_props: DesktopLoginPanelProps) {
  const [view, setView] = useState<DesktopLoginView>({ kind: 'loading' })
  const [submitted, setSubmitted] = useState(false)
  // Refs, not state: StrictMode runs the mount effect twice in development, and a double-click
  // can submit again before a render disables the button. Each must still act only once.
  const unavailableFired = useRef(false)
  const submitting = useRef(false)

  useEffect(() => {
    function fireUnavailable(state: string) {
      if (unavailableFired.current) return
      unavailableFired.current = true
      navigateToDesktopApp(buildDesktopLoginErrorLink({ state, error: 'unavailable' }))
    }

    const fragment = parseDesktopLoginFragment(window.location.hash)
    if (!fragment.valid) {
      setView({ kind: 'invalid' })
      // Only a single well-formed state may receive a link; otherwise Desktop's own deadline
      // and Cancel end its wait.
      if (fragment.state !== null) fireUnavailable(fragment.state)
      return
    }

    let cancelled = false
    void getOidcSignInMethod().then(method => {
      if (cancelled) return
      if (!method) {
        setView({ kind: 'unavailable' })
        fireUnavailable(fragment.state)
        return
      }
      setView({
        kind: 'ready',
        challenge: fragment.challenge,
        state: fragment.state,
        label: method.label,
      })
    })
    return () => {
      cancelled = true
    }
  }, [])

  useEffect(() => {
    // Back from the provider can restore this page from the back/forward cache exactly as it was
    // left, Continue disabled. Pressing it again starts a new attempt, so a restore re-enables it.
    function enableAfterRestore(event: PageTransitionEvent) {
      if (!event.persisted) return
      submitting.current = false
      setSubmitted(false)
    }
    window.addEventListener('pageshow', enableAfterRestore)
    return () => window.removeEventListener('pageshow', enableAfterRestore)
  }, [])

  function handleSubmit(event: FormEvent<HTMLFormElement>) {
    if (submitting.current) {
      event.preventDefault()
      return
    }
    submitting.current = true
    setSubmitted(true)
  }

  const errorCopy =
    view.kind === 'invalid'
      ? DESKTOP_SIGN_IN_COPY.invalidLink
      : view.kind === 'unavailable'
        ? DESKTOP_SIGN_IN_COPY.unavailable
        : ''

  return (
    <main className="cu-app cu-app--auth">
      <div className="cu-card cu-card--auth">
        <div className="cu-card__body">
          <div className="cu-login-brand">
            <Image
              className="cu-sidebar__brand-mark"
              src="/brand/logo.svg"
              alt=""
              width={44}
              height={44}
              aria-hidden="true"
            />
            <div className="cu-sidebar__brand-copy">
              <h1 className="cu-sidebar__title">Evenfire</h1>
              <p className="cu-sidebar__subtitle">Profile Portal</p>
            </div>
          </div>
          <h2 className="page-title">{DESKTOP_SIGN_IN_COPY.pageTitle}</h2>
          {errorCopy ? (
            <div className="message message--error-plain" role="alert">
              {errorCopy}
            </div>
          ) : null}
          {view.kind === 'ready' ? (
            <>
              <p className="cu-code-hint">{DESKTOP_SIGN_IN_COPY.pageDescription}</p>
              {/* No name or value on the button: /api/oidc/desktop-start refuses any field but
                  these two. */}
              <form method="post" action={PROFILE_ROUTES.oidcDesktopStart} onSubmit={handleSubmit}>
                <input type="hidden" name="desktopChallenge" value={view.challenge} />
                <input type="hidden" name="desktopState" value={view.state} />
                <Button type="submit" className="cu-btn--block" disabled={submitted}>
                  {`${DESKTOP_SIGN_IN_COPY.continueWith} ${view.label}`}
                </Button>
              </form>
            </>
          ) : null}
        </div>
      </div>
    </main>
  )
}
