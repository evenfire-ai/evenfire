'use client'

import type { FormEvent } from 'react'
import { useEffect, useState } from 'react'
import Image from 'next/image'
import Link from 'next/link'
import { useAuth } from '@components/AuthContext'
import { Button } from '@components/Button'
import { TextInput } from '@components/TextInput'
import { PROFILE_ROUTES } from '@constants/routes'
import { getIdentityProviders, startMicrosoftIdentityProviderLogin } from '@lib/api'
import type { PublicIdentityProviderConnection } from '@/app/types/identityProviders'
import type { LoginPanelProps } from './types'

export function LoginPanel({
  description = 'Sign in with your Evenfire account credentials.',
}: LoginPanelProps) {
  const { login } = useAuth()
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [error, setError] = useState('')
  const [isSubmitting, setIsSubmitting] = useState(false)
  const [providers, setProviders] = useState<PublicIdentityProviderConnection[]>([])
  const [selectedProviderId, setSelectedProviderId] = useState('')
  const [loadingProviders, setLoadingProviders] = useState(true)
  const [usePassword, setUsePassword] = useState(false)
  const forgotPasswordHref = PROFILE_ROUTES.forgotPassword({
    email: email.trim().toLowerCase(),
  })

  useEffect(() => {
    const queryEmail = new URLSearchParams(window.location.search).get('email')
    if (queryEmail) setEmail(queryEmail.trim().toLowerCase())
  }, [])

  useEffect(() => {
    let cancelled = false
    async function loadProviders() {
      try {
        const response = await getIdentityProviders()
        if (cancelled) return
        const items = response.items || []
        setProviders(items)
        setSelectedProviderId(items[0]?.id || '')
        setUsePassword(items.length === 0)
      } catch {
        if (!cancelled) setUsePassword(true)
      } finally {
        if (!cancelled) setLoadingProviders(false)
      }
    }
    void loadProviders()
    return () => {
      cancelled = true
    }
  }, [])

  async function handleMicrosoftLogin() {
    if (!selectedProviderId) return
    setIsSubmitting(true)
    setError('')
    try {
      const response = await startMicrosoftIdentityProviderLogin({
        connectionId: selectedProviderId,
        flow: 'profile_login',
        returnUrl: `${window.location.origin}/auth/provider-callback`,
      })
      window.location.assign(response.authorizeUrl)
    } catch (nextError) {
      setError(nextError instanceof Error ? nextError.message : 'Microsoft login failed')
      setIsSubmitting(false)
    }
  }

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
          <p className="cu-code-hint">
            {providers.length > 0 && !usePassword
              ? 'Sign in with your work or school account.'
              : description}
          </p>
          {!loadingProviders && providers.length > 0 && !usePassword ? (
            <div className="cu-provider-login">
              {providers.length > 1 ? (
                <div className="cu-field">
                  <label htmlFor="profile-login-provider">Organization</label>
                  <select
                    id="profile-login-provider"
                    className="cu-input"
                    value={selectedProviderId}
                    onChange={event => setSelectedProviderId(event.target.value)}
                    disabled={isSubmitting}
                  >
                    {providers.map(provider => (
                      <option value={provider.id} key={provider.id}>
                        {provider.displayName}
                      </option>
                    ))}
                  </select>
                </div>
              ) : null}
              <Button
                type="button"
                className="cu-btn--block cu-provider-login__button"
                disabled={isSubmitting || !selectedProviderId}
                onClick={() => void handleMicrosoftLogin()}
              >
                <Image
                  src="/brand/microsoft.svg"
                  alt=""
                  width={21}
                  height={21}
                  aria-hidden="true"
                />
                {isSubmitting ? 'Opening Microsoft...' : 'Connect with Microsoft'}
              </Button>
              <button
                type="button"
                className="text-link cu-auth-secondary-action"
                onClick={() => setUsePassword(true)}
                disabled={isSubmitting}
              >
                Use password instead
              </button>
            </div>
          ) : null}
          {usePassword ? (
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
          ) : null}
          {usePassword ? (
            <div className="cu-auth-secondary-actions">
              <Link className="text-link cu-auth-secondary-link" href={forgotPasswordHref}>
                Forgot password
              </Link>
              {providers.length > 0 ? (
                <button
                  type="button"
                  className="text-link cu-auth-secondary-action"
                  onClick={() => setUsePassword(false)}
                >
                  Use Microsoft instead
                </button>
              ) : null}
            </div>
          ) : null}
        </div>
      </div>

      {error ? <div className="cu-banner cu-banner--error cu-login-error">{error}</div> : null}
    </main>
  )
}
