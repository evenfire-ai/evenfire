import type { FormEvent } from 'react'
import { useEffect, useState } from 'react'
import { useAuthContext } from '@contexts/AuthContext'
import { AuthBrand } from '@components/AuthBrand'
import { BrowserSignInPanel } from '@components/BrowserSignInPanel'
import { Button, Field, StatusBanner, TextInput } from '@components/Common'
import { RuntimeConfigDock } from '@components/RuntimeConfigDock'
import { BROWSER_SIGN_IN_COPY } from '@constants/browserSignIn'

/**
 * Sign-in for a configured environment.
 *
 * A cold install never reaches this page — the unauthenticated branch renders
 * onboarding instead, so the invitation email form that used to
 * live here now belongs to the wizard's invited step. AuthPage has
 * exactly one mode again: sign in, plus the environment dock and its inline
 * add-environment form.
 *
 * How to sign in comes from main's login model for the bound environment
 * (design §10.1): "Continue with <label>", the password form, or both, and
 * otherwise a message with Retry and no form. The page reads the model each
 * time it shows.
 */
export function AuthPage() {
  const {
    booting,
    busy,
    email,
    password,
    runtimeConfigSetupName,
    runtimeConfigSetupExternalRestApiBaseUrl,
    authTransitioning,
    backendSwitchHint,
    browserSignIn,
    loginScreen,
    refreshLoginMethods,
    setEmail,
    setPassword,
    setRuntimeConfigSetupName,
    setRuntimeConfigSetupExternalRestApiBaseUrl,
    setStatus,
    handlePasswordLogin,
    handleSwitchLoginBackend,
    handleSaveRuntimeConfig,
    handleStartBrowserSignIn,
    handleCancelBrowserSignIn,
  } = useAuthContext()

  // Main reads the methods each time the login screen shows (design §10.1). Nothing else reads
  // them on mount, so without this the model stays `loading`.
  useEffect(() => {
    refreshLoginMethods()
  }, [refreshLoginMethods])

  // While a browser sign-in redeems, main is installing a session the server already issued; a
  // password sign-in now would discard it (D14, G1-m7). A waiting one leaves the form usable
  // (decision 9).
  const redeeming = browserSignIn.phase === 'redeeming'
  const hasPasswordLoginCredentials = Boolean(email.trim()) && Boolean(password)
  const [runtimeSetupVisible, setRuntimeSetupVisible] = useState(false)
  const hasRuntimeSetupValues =
    Boolean(runtimeConfigSetupName.trim()) &&
    Boolean(runtimeConfigSetupExternalRestApiBaseUrl.trim())
  const [forgotPasswordBusy, setForgotPasswordBusy] = useState(false)
  // `authTransitioning` also holds while a browser sign-in redeems (decision 8), which is not a
  // password sign-in, so the submit says "Signing in..." only for the flows that set the flag
  // themselves (R-15).
  const passwordSigningIn = authTransitioning && !redeeming

  const handlePasswordSubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    if (!busy && !redeeming && hasPasswordLoginCredentials) {
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

  // Saving an environment and the backend switch change the binding, which would discard a
  // browser sign-in that redeems (R-38). The controller refuses both then (I-1); the page shows
  // it by disabling them on the widened flag, as the dock does.
  const environmentChangeBlocked = busy || authTransitioning

  const handleRuntimeSetupSubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    if (!environmentChangeBlocked && hasRuntimeSetupValues) {
      handleSaveRuntimeConfig().then(state => {
        if (state) setRuntimeSetupVisible(false)
      })
    }
  }

  const handleRuntimeSetupCancel = () => {
    setRuntimeSetupVisible(false)
  }

  /** The password form. Below a provider it is the secondary action, under its own heading. */
  const renderPasswordForm = (belowProvider: boolean) => (
    <form className="auth-form-stack" onSubmit={handlePasswordSubmit}>
      {belowProvider ? (
        <p className="auth-flow-card__copy">{BROWSER_SIGN_IN_COPY.passwordHeading}</p>
      ) : null}
      <Field label="Email" htmlFor="email-input" wrapperClassName="auth-form-row">
        <TextInput
          id="email-input"
          type="email"
          placeholder="you@evenfire.com"
          value={email}
          disabled={redeeming}
          onChange={event => setEmail(event.target.value)}
        />
      </Field>
      <Field label="Password" htmlFor="password-input" wrapperClassName="auth-form-row">
        <TextInput
          id="password-input"
          type="password"
          placeholder="Your password"
          value={password}
          disabled={redeeming}
          onChange={event => setPassword(event.target.value)}
        />
      </Field>
      <Button
        block
        variant={belowProvider ? 'soft' : 'solid'}
        disabled={!hasPasswordLoginCredentials || busy || redeeming}
        type="submit"
      >
        {passwordSigningIn ? (
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
              Couldn’t reach <strong>{backendSwitchHint.activeLabel}</strong>. A local Evenfire
              looks like it’s running — switch to <strong>{backendSwitchHint.targetLabel}</strong>{' '}
              and retry?
            </span>
            <Button
              type="button"
              size="sm"
              variant="soft"
              block
              disabled={environmentChangeBlocked}
              onClick={() => void handleSwitchLoginBackend()}
            >
              {`Switch to ${backendSwitchHint.targetLabel} & retry`}
            </Button>
          </span>
        </StatusBanner>
      ) : null}
    </form>
  )

  /** The login screen for main's model (design §10.1). */
  const renderLoginScreen = () => {
    switch (loginScreen.kind) {
      case 'loading':
        return (
          <p className="auth-flow-card__copy" role="status">
            <span className="auth-button-loading">
              <span className="auth-button-spinner" aria-hidden="true" />
              {BROWSER_SIGN_IN_COPY.loadingMethods}
            </span>
          </p>
        )
      case 'misconfigured':
      case 'unreachable':
        // No form and no guess: Retry reads the methods again. Not while an auth action runs:
        // a binding change in flight (each sets `busy`) has moved the request epoch, and a read
        // sent then could apply the binding being left until the change's own read lands
        // (Task 13 review).
        return (
          <div className="auth-form-stack">
            {loginScreen.kind === 'misconfigured' ? (
              <StatusBanner tone="error" text={BROWSER_SIGN_IN_COPY.misconfigured} />
            ) : (
              <StatusBanner tone="warn" text={BROWSER_SIGN_IN_COPY.unreachable} />
            )}
            <Button
              block
              disabled={busy || authTransitioning}
              onClick={() => refreshLoginMethods()}
            >
              {BROWSER_SIGN_IN_COPY.retry}
            </Button>
          </div>
        )
      case 'methods': {
        const { provider } = loginScreen
        return (
          <>
            {provider ? (
              <BrowserSignInPanel
                label={provider.label}
                view={browserSignIn}
                startDisabled={booting || busy || authTransitioning}
                onStart={() => void handleStartBrowserSignIn()}
                onCancel={() => void handleCancelBrowserSignIn()}
              />
            ) : null}
            {provider && loginScreen.password ? (
              <div className="auth-card__divider" role="presentation" />
            ) : null}
            {loginScreen.password ? renderPasswordForm(provider !== null) : null}
          </>
        )
      }
    }
  }

  return (
    <main className="auth-page">
      <section className="auth-card glass-card">
        <header className="auth-card__header">
          <AuthBrand />
        </header>

        {/* Sign-in stays content-sized. The fixed height belongs to the
            onboarding wizard, which needs it because its steps differ wildly
            in length; sign-in has one short form and reads better snug. */}
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
            <Button
              block
              disabled={!hasRuntimeSetupValues || environmentChangeBlocked}
              type="submit"
            >
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
          renderLoginScreen()
        )}
      </section>
      <RuntimeConfigDock onAddEnvironment={() => setRuntimeSetupVisible(true)} />
    </main>
  )
}
