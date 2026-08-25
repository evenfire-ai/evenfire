import type { FormEvent } from 'react'
import { useAuthContext } from '@contexts/AuthContext'
import { Button, Field, TextInput } from '@components/Common'

/**
 * Path C — invited member (spec §5.5).
 *
 * Behaviour is unchanged from the form this replaces on AuthPage: the same
 * `handleStartDesktopSetup` handler, the same single email field, the same
 * "Open setup again" affordance once setup has been started. Only its home
 * moved. Distinct copy for a missing invitation lands in the follow-up PR.
 */
export function InvitedMember() {
  const { busy, email, desktopSetupStarted, authTransitioning, setEmail, handleStartDesktopSetup } =
    useAuthContext()

  const handleSubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    if (!busy && email.trim()) {
      handleStartDesktopSetup()
    }
  }

  return (
    <>
      <h1>Connect to your team</h1>
      <p className="muted">
        Enter the email address your team invited. We’ll open your browser to finish setup.
      </p>
      <form className="auth-form-stack" onSubmit={handleSubmit}>
        <Field label="Email" htmlFor="desktop-setup-email-input" wrapperClassName="auth-form-row">
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
    </>
  )
}
