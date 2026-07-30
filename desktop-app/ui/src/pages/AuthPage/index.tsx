import type { FormEvent } from 'react'
import { useEffect, useRef, useState } from 'react'
import { useAuthContext } from '@contexts/AuthContext'
import { Button, Field, IconButton, MenuItem, TextInput } from '@components/Common'
import { ConfirmDialog } from '@components/ConfirmDialog'
import { createLocalhostRuntimeConfigOption } from '@constants/runtimeConfig'
import { formatDesktopAppVersionTooltip, useDesktopAppInfo } from '@hooks/useDesktopAppInfo'
import type { DesktopRuntimeConfigOption } from '../../../../src/types'

export function AuthPage() {
  const {
    busy,
    email,
    password,
    desktopSetupStarted,
    runtimeConfigSetupName,
    runtimeConfigSetupExternalRestApiBaseUrl,
    authTransitioning,
    runtimeConfigState,
    runtimeConfigMissing,
    setEmail,
    setPassword,
    setRuntimeConfigSetupName,
    setRuntimeConfigSetupExternalRestApiBaseUrl,
    setStatus,
    handlePasswordLogin,
    handleStartDesktopSetup,
    handleSaveRuntimeConfig,
    handleDeleteRuntimeConfig,
    handleSelectRuntimeConfig,
    handleClearRuntimeConfigSelection,
  } = useAuthContext()

  const runtimeConfigOptions = runtimeConfigState?.options || []
  const activeRuntimeConfigId = runtimeConfigState?.activeOptionId ?? null
  const hasPasswordLoginCredentials = Boolean(email.trim()) && Boolean(password)
  const [runtimeSetupVisible, setRuntimeSetupVisible] = useState(false)
  const hasRuntimeSetupValues =
    Boolean(runtimeConfigSetupName.trim()) &&
    Boolean(runtimeConfigSetupExternalRestApiBaseUrl.trim())
  const [runtimeMenuOpen, setRuntimeMenuOpen] = useState(false)
  const [forgotPasswordBusy, setForgotPasswordBusy] = useState(false)
  const [pendingDeleteOption, setPendingDeleteOption] = useState<DesktopRuntimeConfigOption | null>(
    null
  )
  const runtimeDockRef = useRef<HTMLDivElement | null>(null)
  const savedRuntimeConfigOptions = runtimeConfigOptions.filter(option => option.source === 'file')
  const localhostRuntimeConfigOption = runtimeConfigOptions.find(
    option => option.source === 'localhost'
  )
  const displayedLocalhostRuntimeConfigOption =
    localhostRuntimeConfigOption || createLocalhostRuntimeConfigOption()
  const desktopAppInfo = useDesktopAppInfo()
  const desktopVersionTooltip = formatDesktopAppVersionTooltip(desktopAppInfo)

  const handlePasswordSubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    if (!busy && hasPasswordLoginCredentials) {
      handlePasswordLogin()
    }
  }

  const handleInvitationSetupSubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    if (!busy && email.trim()) {
      handleStartDesktopSetup()
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

  const handleRuntimeOptionSelect = (optionId: string) => {
    setRuntimeMenuOpen(false)
    if (optionId === activeRuntimeConfigId) {
      const selectedOption = runtimeConfigOptions.find(option => option.id === optionId)
      if (selectedOption?.source === 'localhost') {
        handleClearRuntimeConfigSelection()
      }
      return
    }
    handleSelectRuntimeConfig(optionId)
  }

  const confirmDeleteRuntimeOption = () => {
    if (!pendingDeleteOption) return
    handleDeleteRuntimeConfig(pendingDeleteOption.id)
    setPendingDeleteOption(null)
  }

  useEffect(() => {
    if (!runtimeMenuOpen) {
      return
    }

    const handleDocumentPointerDown = (event: PointerEvent) => {
      if (runtimeDockRef.current?.contains(event.target as Node)) {
        return
      }

      setRuntimeMenuOpen(false)
    }

    const handleEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        setRuntimeMenuOpen(false)
      }
    }

    document.addEventListener('pointerdown', handleDocumentPointerDown)
    document.addEventListener('keydown', handleEscape)

    return () => {
      document.removeEventListener('pointerdown', handleDocumentPointerDown)
      document.removeEventListener('keydown', handleEscape)
    }
  }, [runtimeMenuOpen])

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
        ) : null}

        {!runtimeConfigMissing && !runtimeSetupVisible ? (
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
          </form>
        ) : null}

        {runtimeConfigMissing && !runtimeSetupVisible ? (
          <form className="auth-form-stack" onSubmit={handleInvitationSetupSubmit}>
            <Field
              label="Email"
              htmlFor="desktop-setup-email-input"
              wrapperClassName="auth-form-row"
            >
              <TextInput
                id="desktop-setup-email-input"
                type="email"
                placeholder="you@evenfire.com"
                value={email}
                onChange={event => setEmail(event.target.value)}
              />
            </Field>
            <Button block disabled={!email.trim() || busy} type="submit">
              {authTransitioning ? (
                <span className="auth-button-loading">
                  <span className="auth-button-spinner" aria-hidden="true" />
                  Opening setup...
                </span>
              ) : desktopSetupStarted ? (
                'Open setup again'
              ) : (
                'Continue setup'
              )}
            </Button>
          </form>
        ) : null}
      </section>
      {runtimeConfigState ? (
        <aside className="auth-runtime-dock" ref={runtimeDockRef}>
          <IconButton
            className="auth-runtime-dock__toggle"
            aria-label="Open environment selector"
            aria-expanded={runtimeMenuOpen}
            aria-controls="auth-runtime-dock-panel"
            label="Open environment selector"
            onClick={() => setRuntimeMenuOpen(open => !open)}
            variant="soft"
          >
            <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">
              <path d="M19.43 12.98a7.9 7.9 0 0 0 .05-.98 7.9 7.9 0 0 0-.05-.98l2.11-1.65a.48.48 0 0 0 .12-.61l-2-3.46a.49.49 0 0 0-.58-.22l-2.49 1a7.2 7.2 0 0 0-1.7-.98l-.38-2.65A.49.49 0 0 0 14 2h-4a.49.49 0 0 0-.49.41l-.38 2.65a7.2 7.2 0 0 0-1.7.98l-2.49-1a.49.49 0 0 0-.58.22l-2 3.46a.48.48 0 0 0 .12.61l2.11 1.65a7.9 7.9 0 0 0-.05.98 7.9 7.9 0 0 0 .05.98l-2.11 1.65a.48.48 0 0 0-.12.61l2 3.46a.49.49 0 0 0 .58.22l2.49-1a7.2 7.2 0 0 0 1.7.98l.38 2.65A.49.49 0 0 0 10 22h4a.49.49 0 0 0 .49-.41l.38-2.65a7.2 7.2 0 0 0 1.7-.98l2.49 1a.49.49 0 0 0 .58-.22l2-3.46a.48.48 0 0 0-.12-.61Zm-7.43 2.52A3.5 3.5 0 1 1 15.5 12 3.5 3.5 0 0 1 12 15.5Z" />
            </svg>
          </IconButton>
          {runtimeMenuOpen ? (
            <div className="auth-runtime-dock__panel glass-card" id="auth-runtime-dock-panel">
              <div className="auth-runtime-menu__header">
                <span className="auth-runtime-menu__label">Environment</span>
                <IconButton
                  aria-label="Add environment"
                  disabled={busy || authTransitioning}
                  label="Add environment"
                  onClick={() => {
                    setRuntimeMenuOpen(false)
                    setRuntimeSetupVisible(true)
                  }}
                  size="sm"
                  variant="ghost"
                >
                  <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">
                    <path d="M12 5v14" />
                    <path d="M5 12h14" />
                  </svg>
                </IconButton>
              </div>
              <div className="auth-runtime-menu">
                {savedRuntimeConfigOptions.length > 0 ? (
                  <section className="auth-runtime-menu__section">
                    {savedRuntimeConfigOptions.map(option => {
                      const selected = option.id === activeRuntimeConfigId
                      return (
                        <div
                          key={option.id}
                          className={`auth-runtime-menu__row${selected ? ' selected' : ''}`}
                        >
                          <MenuItem
                            className={`auth-runtime-menu__select${selected ? ' selected' : ''}`}
                            active={selected}
                            disabled={busy || authTransitioning}
                            leadingIcon={
                              <span className="auth-runtime-menu__check" aria-hidden="true">
                                {selected ? (
                                  <svg viewBox="0 0 24 24" focusable="false">
                                    <path d="M20 6 9 17l-5-5" />
                                  </svg>
                                ) : null}
                              </span>
                            }
                            onClick={() => handleRuntimeOptionSelect(option.id)}
                          >
                            {option.label}
                          </MenuItem>
                          <IconButton
                            className="auth-runtime-menu__delete"
                            aria-label={`Delete ${option.appName} environment`}
                            color="danger"
                            disabled={busy || authTransitioning}
                            label={`Delete ${option.appName}`}
                            onClick={() => setPendingDeleteOption(option)}
                            size="sm"
                            title={`Delete ${option.appName}`}
                            variant="ghost"
                          >
                            <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">
                              <path d="M3 6h18" />
                              <path d="M8 6V4h8v2" />
                              <path d="M6 6l1 15h10l1-15" />
                              <path d="M10 10v7" />
                              <path d="M14 10v7" />
                            </svg>
                          </IconButton>
                        </div>
                      )
                    })}
                  </section>
                ) : null}
                {displayedLocalhostRuntimeConfigOption ? (
                  <section className="auth-runtime-menu__section">
                    {(() => {
                      const option = displayedLocalhostRuntimeConfigOption
                      const selected = option.id === activeRuntimeConfigId
                      return (
                        <MenuItem
                          className={`auth-runtime-menu__select auth-runtime-menu__select--standalone${
                            selected ? ' selected' : ''
                          }`}
                          active={selected}
                          disabled={busy || authTransitioning}
                          leadingIcon={
                            <span className="auth-runtime-menu__check" aria-hidden="true">
                              {selected ? (
                                <svg viewBox="0 0 24 24" focusable="false">
                                  <path d="M20 6 9 17l-5-5" />
                                </svg>
                              ) : null}
                            </span>
                          }
                          onClick={() => handleRuntimeOptionSelect(option.id)}
                        >
                          Localhost
                        </MenuItem>
                      )
                    })()}
                  </section>
                ) : null}
              </div>
            </div>
          ) : null}
        </aside>
      ) : null}
      {pendingDeleteOption ? (
        <ConfirmDialog
          title="Delete environment?"
          body={
            <p>
              Delete <strong>{pendingDeleteOption.appName}</strong>? This only removes the local
              desktop environment configuration.
            </p>
          }
          confirmLabel="Delete"
          tone="danger"
          onCancel={() => setPendingDeleteOption(null)}
          onConfirm={confirmDeleteRuntimeOption}
        />
      ) : null}
    </main>
  )
}
