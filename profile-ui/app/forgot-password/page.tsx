'use client'

import type { KeyboardEvent } from 'react'
import { Suspense, useEffect, useState } from 'react'
import Image from 'next/image'
import Link from 'next/link'
import { useSearchParams } from 'next/navigation'
import { Button } from '@components/Button'
import { TextInput } from '@components/TextInput'
import { PROFILE_ROUTES } from '@constants/routes'
import { requestPasswordReset } from '@lib/api'

function ForgotPasswordContent() {
  const searchParams = useSearchParams()
  const [email, setEmail] = useState('')
  const [sentEmail, setSentEmail] = useState('')
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    setEmail(searchParams.get('email') || '')
  }, [searchParams])

  async function requestReset() {
    const submittedEmail = email.trim().toLowerCase()
    if (!submittedEmail) return

    setBusy(true)
    setError('')
    setEmail(submittedEmail)
    try {
      await requestPasswordReset(submittedEmail)
      setSentEmail(submittedEmail)
    } catch (nextError) {
      setError(nextError instanceof Error ? nextError.message : 'Failed to send reset link')
    } finally {
      setBusy(false)
    }
  }

  function handleEmailKeyDown(event: KeyboardEvent<HTMLInputElement>) {
    if (event.key !== 'Enter') return
    event.preventDefault()
    void requestReset()
  }

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
          <p className="eyebrow">Forgot password</p>
          {sentEmail ? (
            <>
              <h1 className="page-title">Check your email</h1>
              <div className="message message--success message--plain" role="status">
                Password reset request sent to {sentEmail}.
              </div>
              <p className="cu-code-hint">
                If an account exists for that email, the reset link is on its way. Check your inbox
                and follow the link to choose a new password.
              </p>
            </>
          ) : (
            <>
              <h1 className="page-title">Reset password</h1>
              <p className="cu-code-hint">
                Enter your email and we will send a password reset link if the account exists.
              </p>
              <div>
                <div className="cu-field">
                  <label htmlFor="forgot-password-email">Email</label>
                  <TextInput
                    id="forgot-password-email"
                    name="email"
                    type="email"
                    value={email}
                    onChange={event => setEmail(event.currentTarget.value)}
                    onKeyDown={handleEmailKeyDown}
                    autoComplete="username"
                    required
                  />
                </div>
                <Button
                  type="button"
                  className="cu-btn--block"
                  disabled={busy || !email.trim()}
                  onClick={() => void requestReset()}
                >
                  {busy ? 'Sending...' : 'Send reset link'}
                </Button>
              </div>
            </>
          )}
          <div className="cu-auth-return-link">
            <Link className="text-link" href={PROFILE_ROUTES.login()}>
              Back to sign in
            </Link>
          </div>
        </div>
      </div>
      {error ? <div className="cu-banner cu-banner--error cu-login-error">{error}</div> : null}
    </main>
  )
}

export default function ForgotPasswordPage() {
  return (
    <Suspense
      fallback={
        <main className="cu-app cu-app--auth">
          <div className="cu-card cu-card--auth">
            <div className="cu-card__body">Loading...</div>
          </div>
        </main>
      }
    >
      <ForgotPasswordContent />
    </Suspense>
  )
}
