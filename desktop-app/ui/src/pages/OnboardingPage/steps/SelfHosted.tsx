import { useState } from 'react'
import { useAuthContext } from '@contexts/AuthContext'
import { Button } from '@components/Common'

interface SelfHostedProps {
  /** Continue into the manual environment step, which owns the submit path. */
  onContinue: () => void
}

/**
 * Path B — self-hosted (spec §5.4).
 *
 * Documentation-first: deployment shapes differ too much for a wizard to guide
 * any of them honestly, so this step names the option, links out, and hands to
 * path D. It deliberately shows no prerequisites, no install command and no
 * default address — all three would assume a deployment shape, and
 * self-hosting means any cluster the user controls, remote or local.
 */
export function SelfHosted({ onContinue }: SelfHostedProps) {
  const { busy, setStatus } = useAuthContext()
  const [openingDocs, setOpeningDocs] = useState(false)

  const handleOpenDocs = async () => {
    if (openingDocs) return
    setOpeningDocs(true)
    try {
      // Vite can hot-reload renderer code while Electron still runs an older
      // preload script, matching the guard on the environment delete action.
      if (typeof window.clerum.auth.openDeploymentDocs !== 'function') {
        throw new Error('Restart the desktop app to finish loading the deployment guide link')
      }
      await window.clerum.auth.openDeploymentDocs()
      setStatus('Deployment guide opened in your browser.', 'success', undefined, {
        global: false,
        toast: true,
      })
    } catch (error) {
      setStatus(
        `The deployment guide could not be opened: ${
          error instanceof Error ? error.message : String(error)
        }`,
        'error'
      )
    } finally {
      setOpeningDocs(false)
    }
  }

  return (
    <>
      <h1>Run Evenfire yourself</h1>
      <p className="muted">
        Deploy Evenfire to a Kubernetes cluster you control — your own infrastructure or a local
        one. The deployment guide covers both, including what each shape needs.
      </p>
      <div className="auth-flow-card__actions">
        <Button block disabled={busy || openingDocs} onClick={() => void handleOpenDocs()}>
          Open the deployment guide
        </Button>
        <Button block disabled={busy} onClick={onContinue} variant="soft">
          I have a server — enter its address
        </Button>
      </div>
    </>
  )
}
