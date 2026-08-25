import { LinkOutStep } from './LinkOutStep'

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
  return (
    <LinkOutStep
      title="Run Evenfire yourself"
      body="Deploy Evenfire to a Kubernetes cluster you control — your own infrastructure or a local one. The deployment guide covers both, including what each shape needs."
      channel="openDeploymentDocs"
      linkLabel="Open the deployment guide"
      successMessage="Deployment guide opened in your browser."
      errorMessage="The deployment guide could not be opened"
      continueLabel="I have a server — enter its address"
      onContinue={onContinue}
    />
  )
}
