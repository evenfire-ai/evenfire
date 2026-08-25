import type { FormEvent } from 'react'
import { useEffect, useState } from 'react'
import { useAuthContext } from '@contexts/AuthContext'
import { Button, Field, StatusBanner, TextInput } from '@components/Common'
import { LOCALHOST_RUNTIME_CONFIG_OPTION_ID } from '@constants/runtimeConfig'

/**
 * Path D — manual environment (spec §5.6).
 *
 * The terminal step for paths B and D alike, so it carries the local-cluster
 * hint for both. It shares `handleSaveRuntimeConfig` with AuthPage's inline
 * environment form: one submit path, one validation rule.
 */
export function ManualEnvironment() {
  const {
    busy,
    runtimeConfigSetupName,
    runtimeConfigSetupExternalRestApiBaseUrl,
    setRuntimeConfigSetupName,
    setRuntimeConfigSetupExternalRestApiBaseUrl,
    handleSaveRuntimeConfig,
    handleSelectRuntimeConfig,
  } = useAuthContext()

  const [localhostReachable, setLocalhostReachable] = useState(false)

  const hasRuntimeSetupValues =
    Boolean(runtimeConfigSetupName.trim()) &&
    Boolean(runtimeConfigSetupExternalRestApiBaseUrl.trim())

  // One bounded probe on entry (spec §9.4). It takes no URL — the main process
  // only ever checks the built-in Localhost option — and a negative or failed
  // result renders nothing, so a user with no local cluster sees no trace of
  // it. The probe never fills the form or saves on its own.
  useEffect(() => {
    let cancelled = false
    const probe = window.clerum.auth.probeLocalhostReachable
    if (typeof probe !== 'function') return

    probe()
      .then(reachable => {
        if (!cancelled) setLocalhostReachable(reachable)
      })
      .catch(() => undefined)

    return () => {
      cancelled = true
    }
  }, [])

  const handleSubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    if (!busy && hasRuntimeSetupValues) {
      void handleSaveRuntimeConfig()
    }
  }

  return (
    <>
      <h1>Connect to a server</h1>
      <p className="muted">
        Enter the address of your Evenfire server. You can add more environments later.
      </p>
      {localhostReachable ? (
        <StatusBanner tone="info">
          <span className="auth-backend-hint">
            <span>A local Evenfire looks like it’s running on this machine.</span>
            <Button
              type="button"
              size="sm"
              variant="soft"
              block
              disabled={busy}
              onClick={() => void handleSelectRuntimeConfig(LOCALHOST_RUNTIME_CONFIG_OPTION_ID)}
            >
              Use Localhost
            </Button>
          </span>
        </StatusBanner>
      ) : null}
      <form className="auth-form-stack" onSubmit={handleSubmit}>
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
            placeholder="https://evenfire.example.com"
            value={runtimeConfigSetupExternalRestApiBaseUrl}
            onChange={event => setRuntimeConfigSetupExternalRestApiBaseUrl(event.target.value)}
          />
        </Field>
        <Button block disabled={!hasRuntimeSetupValues || busy} type="submit">
          Save environment
        </Button>
      </form>
    </>
  )
}
