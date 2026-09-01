import { useState } from 'react'
import { useAuthContext } from '@contexts/AuthContext'
import { Button } from '@components/Common'

/** No-argument main-process calls that open a build-time URL in the browser. */
type LinkOutChannel = 'openDeploymentDocs' | 'openHostedSignup'

interface LinkOutStepProps {
  title: string
  body: string
  channel: LinkOutChannel
  linkLabel: string
  successMessage: string
  errorMessage: string
  continueLabel: string
  onContinue: () => void
}

/**
 * Shared shell for the two onboarding steps that hand off to the browser and
 * then wait for the user to come back with an address — self-hosted (§5.4) and
 * hosted (§5.3). Both open a URL the main process owns and both fall back to
 * the manual environment step, so they differ only in copy.
 */
export function LinkOutStep({
  title,
  body,
  channel,
  linkLabel,
  successMessage,
  errorMessage,
  continueLabel,
  onContinue,
}: LinkOutStepProps) {
  const { busy, setStatus } = useAuthContext()
  const [opening, setOpening] = useState(false)

  const handleOpen = async () => {
    if (opening) return
    setOpening(true)
    try {
      // Vite can hot-reload renderer code while Electron still runs an older
      // preload script, matching the guard on the environment delete action.
      const open = window.clerum.auth[channel]
      if (typeof open !== 'function') {
        throw new Error('Restart the desktop app to finish loading this link')
      }
      await open()
      setStatus(successMessage, 'success', undefined, { global: false, toast: true })
    } catch (error) {
      setStatus(
        `${errorMessage}: ${error instanceof Error ? error.message : String(error)}`,
        'error'
      )
    } finally {
      setOpening(false)
    }
  }

  return (
    <>
      <h1>{title}</h1>
      <p className="muted">{body}</p>
      <div className="auth-flow-card__actions">
        <Button block disabled={busy || opening} onClick={() => void handleOpen()}>
          {linkLabel}
        </Button>
        <Button block disabled={busy} onClick={onContinue} variant="soft">
          {continueLabel}
        </Button>
      </div>
    </>
  )
}
