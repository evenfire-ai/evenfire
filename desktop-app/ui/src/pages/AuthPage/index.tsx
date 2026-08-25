import type { FormEvent } from 'react'
import { useState } from 'react'
import { useAuthContext } from '@contexts/AuthContext'
import { Button, Field, StatusBanner, TextInput } from '@components/Common'
import { RuntimeConfigDock } from '@components/RuntimeConfigDock'
import { formatDesktopAppVersionTooltip, useDesktopAppInfo } from '@hooks/useDesktopAppInfo'

/**
 * Sign-in for a configured environment.
 *
 * A cold install never reaches this page — the unauthenticated branch renders
 * onboarding instead (spec §4.1), so the invitation email form that used to
 * live here now belongs to the wizard's invited step (spec §5.5). AuthPage has
 * exactly one mode again: sign in, plus the environment dock and its inline
 * add-environment form.
 */
export function AuthPage() {
  const {
    busy,
    email,
    password,
    runtimeConfigSetupName,
    runtimeConfigSetupExternalRestApiBaseUrl,
    authTransitioning,
    backendSwitchHint,
    setEmail,
    setPassword,
    setRuntimeConfigSetupName,
    setRuntimeConfigSetupExternalRestApiBaseUrl,
    setStatus,
    handlePasswordLogin,
    handleSwitchLoginBackend,
    handleSaveRuntimeConfig,
  } = useAuthContext()

  const hasPasswordLoginCredentials = Boolean(email.trim()) && Boolean(password)
  const [runtimeSetupVisible, setRuntimeSetupVisible] = useState(false)
  const hasRuntimeSetupValues =
    Boolean(runtimeConfigSetupName.trim()) &&
    Boolean(runtimeConfigSetupExternalRestApiBaseUrl.trim())
  const [forgotPasswordBusy, setForgotPasswordBusy] = useState(false)
  const desktopAppInfo = useDesktopAppInfo()
  const desktopVersionTooltip = formatDesktopAppVersionTooltip(desktopAppInfo)

  const handlePasswordSubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    if (!busy && hasPasswordLoginCredentials) {
      handlePasswordLogin()
    }
  }

  const handleForgotPasswordClick = async () => {
    if (busy || forgotPasswordBusy) return
    setForgotPasswordBusy(true)
    try {
      await window.clerum.auth.openForgotPassword(email.trim().toLowerCase())
      setStatus('Password reset opened in your browser.', 'success')
    } catch {
      setStatus('Password reset could not be opened.', 'error')
    } finally {
      setForgotPasswordBusy(false)
    }
  }

  const handleRuntimeSetupSubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    if (!busy && hasRuntimeSetupValues) {
      handleSaveRuntimeConfig().then(state => {
        if (state) setRuntimeSetupVisible(false)
      })
    }
  }

  const handleRuntimeSetupCancel = () => {
    setRuntimeSetupVisible(false)
  }

  return (
    <main className="auth-page">
      <section className="auth-card glass-card">
        <header className="auth-card__header">
          <div className="auth-brand" title={desktopVersionTooltip}>
            <img className="auth-brand-mark" src="./logo.svg" alt="" aria-hidden="true" />
            <span className="auth-brand-copy">
              <span className="auth-brand-title">Evenfire</span>
              <span className="auth-brand-subtitle">Desktop App</span>
            </span>
          </div>
        </header>

        {runtimeSetupVisible ? (
          <form className="auth-form-stack" onSubmit={handleRuntimeSetupSubmit}>
            <Field
              label="Environment name"
              htmlFor="runtime-config-name-input"
              wrapperClassName="auth-form-row"
            >
              <TextInput
                id="runtime-config-name-input"
                type="text"
                placeholder="Production"
                value={runtimeConfigSetupName}
                onChange={event => setRuntimeConfigSetupName(event.target.value)}
              />
            </Field>
            <Field
              label="External REST API"
              htmlFor="runtime-config-external-rest-api-input"
              wrapperClassName="auth-form-row"
            >
              <TextInput
                id="runtime-config-external-rest-api-input"
                type="url"
                placeholder="https://example.com"
                value={runtimeConfigSetupExternalRestApiBaseUrl}
                onChange={event => setRuntimeConfigSetupExternalRestApiBaseUrl(event.target.value)}
              />
            </Field>
            <Button block disabled={!hasRuntimeSetupValues || busy} type="submit">
              Save environment
            </Button>
            <button
              type="button"
              className="auth-inline-link"
              onClick={handleRuntimeSetupCancel}
              disabled={busy}
            >
              Go back to login
            </button>
          </form>
        ) : (
          <form className="auth-form-stack" onSubmit={handlePasswordSubmit}>
            <Field label="Email" htmlFor="email-input" wrapperClassName="auth-form-row">
              <TextInput
                id="email-input"
                type="email"
                placeholder="you@evenfire.com"
                value={email}
                onChange={event => setEmail(event.target.value)}
              />
            </Field>
            <Field label="Password" htmlFor="password-input" wrapperClassName="auth-form-row">
              <TextInput
                id="password-input"
                type="password"
                placeholder="Your password"
                value={password}
                onChange={event => setPassword(event.target.value)}
              />
            </Field>
            <Button block disabled={!hasPasswordLoginCredentials || busy} type="submit">
              {authTransitioning ? (
                <span className="auth-button-loading">
                  <span className="auth-button-spinner" aria-hidden="true" />
                  Signing in...
                </span>
              ) : (
                'Sign in'
              )}
            </Button>
            <button
              type="button"
              className="auth-inline-link"
              onClick={() => void handleForgotPasswordClick()}
              disabled={busy || forgotPasswordBusy}
            >
              Forgot password
            </button>
            {backendSwitchHint ? (
              <StatusBanner tone="warn">
                <span className="auth-backend-hint">
                  <span>
                    Couldn’t reach <strong>{backendSwitchHint.activeLabel}</strong>. A local
                    Evenfire looks like it’s running — switch to{' '}
                    <strong>{backendSwitchHint.targetLabel}</strong> and retry?
                  </span>
                  <Button
                    type="button"
                    size="sm"
                    variant="soft"
                    block
                    disabled={busy}
                    onClick={() => void handleSwitchLoginBackend()}
                  >
                    {`Switch to ${backendSwitchHint.targetLabel} & retry`}
                  </Button>
                </span>
              </StatusBanner>
            ) : null}
          </form>
        )}
      </section>
      <RuntimeConfigDock onAddEnvironment={() => setRuntimeSetupVisible(true)} />
    </main>
  )
}
