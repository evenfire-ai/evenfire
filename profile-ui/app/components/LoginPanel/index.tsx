'use client'

import type { FormEvent } from 'react'
import { useEffect, useState } from 'react'
import Image from 'next/image'
import Link from 'next/link'
import { useAuth } from '@components/AuthContext'
import { Button } from '@components/Button'
import { TextInput } from '@components/TextInput'
import { PROFILE_ROUTES } from '@constants/routes'
import type { LoginPanelProps } from './types'

export function LoginPanel({
  description = 'Sign in with your Evenfire account credentials.',
}: LoginPanelProps) {
  const { login } = useAuth()
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [error, setError] = useState('')
  const [isSubmitting, setIsSubmitting] = useState(false)
  const forgotPasswordHref = PROFILE_ROUTES.forgotPassword({
    email: email.trim().toLowerCase(),
  })

  useEffect(() => {
    const queryEmail = new URLSearchParams(window.location.search).get('email')
    if (queryEmail) setEmail(queryEmail.trim().toLowerCase())
  }, [])

  async function handleLogin(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    setIsSubmitting(true)
    setError('')
    try {
      await login(email.trim().toLowerCase(), password)
      setPassword('')
    } catch (nextError) {
      setError(nextError instanceof Error ? nextError.message : 'Login failed')
    } finally {
      setIsSubmitting(false)
    }
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
          <p className="cu-code-hint">{description}</p>
          <form onSubmit={handleLogin}>
            <div className="cu-field">
              <label htmlFor="profile-login-email">Email</label>
              <TextInput
                id="profile-login-email"
                type="email"
                value={email}
                onChange={event => setEmail(event.target.value)}
                autoComplete="username"
                required
              />
            </div>
            <div className="cu-field">
              <label htmlFor="profile-login-password">Password</label>
              <TextInput
                id="profile-login-password"
                type="password"
                value={password}
                onChange={event => setPassword(event.target.value)}
                autoComplete="current-password"
                required
              />
            </div>
            <Button
              type="submit"
              className="cu-btn--block"
              disabled={isSubmitting || !email.trim() || !password}
            >
              {isSubmitting ? 'Signing in...' : 'Sign in'}
            </Button>
          </form>
          <Link className="text-link cu-auth-secondary-link" href={forgotPasswordHref}>
            Forgot password
          </Link>
        </div>
      </div>

      {error ? <div className="cu-banner cu-banner--error cu-login-error">{error}</div> : null}
    </main>
  )
}
