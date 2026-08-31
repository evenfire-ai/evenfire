import type { FormEvent } from 'react'
import { useAuthContext } from '@contexts/AuthContext'
import { Button, Field, SelectableOption, TextInput } from '@components/Common'
import {
  LOCALHOST_RUNTIME_CONFIG_OPTION_ID,
  createLocalhostRuntimeConfigOption,
} from '@constants/runtimeConfig'
import { useLocalhostReachable } from '@hooks/useLocalhostReachable'

/**
 * Manual environment: connect to a server by address.
 *
 * The terminal step for the self-hosted and have-an-address answers alike, so it carries the local-cluster
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

  // One bounded probe on entry. A negative or failed result
  // renders nothing, so a user with no local cluster sees no trace of it. The
  // probe never fills the form or saves on its own.
  const localhostReachable = useLocalhostReachable()
  const localhostOption = createLocalhostRuntimeConfigOption()

  const hasRuntimeSetupValues =
    Boolean(runtimeConfigSetupName.trim()) &&
    Boolean(runtimeConfigSetupExternalRestApiBaseUrl.trim())

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
        <div className="onboarding-options">
          <SelectableOption
            className="onboarding-option"
            size="lg"
            disabled={busy}
            onClick={() => void handleSelectRuntimeConfig(LOCALHOST_RUNTIME_CONFIG_OPTION_ID)}
          >
            <span className="onboarding-option__title">Localhost</span>
            <span className="onboarding-option__hint">
              {localhostOption.externalRestApiBaseUrl}
            </span>
          </SelectableOption>
        </div>
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
