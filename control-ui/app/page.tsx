'use client'

import React, { useEffect, useMemo, useState } from 'react'
import Image from 'next/image'
import { useRouter, useSearchParams } from 'next/navigation'
import { useAuth } from '@components/AuthContext'
import { LoadingScreen } from '@components/LoadingScreen'
import { CONTROL_ROUTES } from '@constants/routes'
import { requestControlAdminPasswordReset } from '@lib/api'
import { sanitizeControlUiReturnPath } from '@lib/authRedirect'

function PageContent() {
  const router = useRouter()
  const searchParams = useSearchParams()
  const { authState, login } = useAuth()
  const [error, setError] = useState('')
  const [username, setUsername] = useState('')
  const [password, setPassword] = useState('')
  const [isSubmittingLogin, setIsSubmittingLogin] = useState(false)
  const [authMode, setAuthMode] = useState<'login' | 'forgot-password'>('login')
  const [resetLogin, setResetLogin] = useState('')
  const [resetMessage, setResetMessage] = useState('')
  const [isSubmittingReset, setIsSubmittingReset] = useState(false)
  const nextPath = useMemo(
    () => sanitizeControlUiReturnPath(searchParams.get('next')),
    [searchParams]
  )

  useEffect(() => {
    if (authState.isLoggedIn && !authState.isLoading) {
      router.replace(nextPath || CONTROL_ROUTES.agents.root)
    }
  }, [authState.isLoggedIn, authState.isLoading, nextPath, router])

  useEffect(() => {
    const loginParam = searchParams.get('login')
    if (!authState.isLoggedIn && loginParam && !username) {
      setUsername(loginParam)
    }
  }, [authState.isLoggedIn, searchParams, username])

  async function handleLogin(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault()
    setIsSubmittingLogin(true)
    setError('')
    try {
      await login(username.trim(), password)
      setPassword('')
    } catch (nextError) {
      setError(nextError instanceof Error ? nextError.message : 'Login failed')
    } finally {
      setIsSubmittingLogin(false)
    }
  }

  async function handlePasswordResetRequest(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault()
    setIsSubmittingReset(true)
    setError('')
    setResetMessage('')
    try {
      await requestControlAdminPasswordReset(resetLogin.trim())
      setResetMessage('If that admin has a registered email, a reset link will be sent.')
    } catch (nextError) {
      setError(nextError instanceof Error ? nextError.message : 'Failed to request password reset')
    } finally {
      setIsSubmittingReset(false)
    }
  }

  if (authState.isLoading || authState.isLoggedIn) {
    return <LoadingScreen />
  }

  return (
    <main className="cu-app cu-app--auth">
      <div className="cu-card cu-card--auth">
        <div className="cu-card__body">
          <div className="cu-login-brand">
            <Image
              className="cu-sidebar__brand-mark cu-sidebar__brand-mark--light"
              src="/brand/logotype-light.svg"
              alt=""
              width={184}
              height={44}
              aria-hidden="true"
            />
            <Image
              className="cu-sidebar__brand-mark cu-sidebar__brand-mark--dark"
              src="/brand/logotype-dark.svg"
              alt="Evenfire"
              width={184}
              height={44}
            />
          </div>
          {authMode === 'login' ? (
            <>
              <p className="cu-code-hint">Sign in with your configured operator account.</p>
              <form onSubmit={handleLogin}>
                <div className="cu-field">
                  <label htmlFor="cu-login-user">Username or email</label>
                  <input
                    id="cu-login-user"
                    className="cu-input"
                    value={username}
                    onChange={event => setUsername(event.target.value)}
                    autoComplete="username"
                    required
                  />
                </div>
                <div className="cu-field">
                  <label htmlFor="cu-login-pass">Password</label>
                  <input
                    id="cu-login-pass"
                    className="cu-input"
                    type="password"
                    value={password}
                    onChange={event => setPassword(event.target.value)}
                    autoComplete="current-password"
                    required
                  />
                </div>
                <button
                  type="submit"
                  className="cu-btn cu-btn--primary cu-btn--block cu-login-submit"
                  disabled={isSubmittingLogin || !username.trim() || !password}
                >
                  {isSubmittingLogin ? 'Signing in...' : 'Sign in'}
                </button>
              </form>
              <button
                type="button"
                className="cu-link cu-auth-secondary-link"
                onClick={() => {
                  setAuthMode('forgot-password')
                  setResetLogin(username)
                  setResetMessage('')
                  setError('')
                }}
              >
                Forgot my password
              </button>
            </>
          ) : (
            <>
              <p className="cu-code-hint">Send a password reset link to your admin email.</p>
              <form onSubmit={handlePasswordResetRequest}>
                <div className="cu-field">
                  <label htmlFor="cu-reset-user">Username or email</label>
                  <input
                    id="cu-reset-user"
                    className="cu-input"
                    value={resetLogin}
                    onChange={event => setResetLogin(event.target.value)}
                    autoComplete="username"
                    required
                  />
                </div>
                <button
                  type="submit"
                  className="cu-btn cu-btn--primary cu-btn--block cu-login-submit"
                  disabled={isSubmittingReset || !resetLogin.trim()}
                >
                  {isSubmittingReset ? 'Sending reset link...' : 'Send reset link'}
                </button>
              </form>
              <button
                type="button"
                className="cu-link cu-auth-secondary-link"
                onClick={() => {
                  setAuthMode('login')
                  setResetMessage('')
                  setError('')
                }}
              >
                Back to sign in
              </button>
              {resetMessage ? (
                <div className="cu-banner cu-banner--info">{resetMessage}</div>
              ) : null}
            </>
          )}
        </div>
      </div>

      {error ? <div className="cu-banner cu-banner--error">{error}</div> : null}
    </main>
  )
}

export default function Page() {
  return (
    <React.Suspense fallback={<LoadingScreen />}>
      <PageContent />
    </React.Suspense>
  )
}
