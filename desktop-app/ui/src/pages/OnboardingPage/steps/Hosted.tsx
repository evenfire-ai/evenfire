import { LinkOutStep } from './LinkOutStep'

interface HostedProps {
  /** Continue into the manual environment step, which owns the submit path. */
  onContinue: () => void
}

/**
 * Evenfire-hosted, in its link-out form.
 *
 * The hosted signup project does not exist yet: there is no tenant
 * provisioning and no `evenfire://desktop-environment` handoff back into the
 * app. So this step links to the hosted site and offers the manual-address
 * fallback for when the user returns with a server, rather than promising an
 * in-app signup the product cannot complete. When hosted signup ships, this
 * step gains the `state` nonce and the waiting screen; the questionnaire above
 * it does not change.
 */
export function Hosted({ onContinue }: HostedProps) {
  return (
    <LinkOutStep
      title="Evenfire hosts it for you"
      body="We run and operate Evenfire for you — no cluster to deploy or maintain. See what's available on the Evenfire site, then come back and connect with your server's address."
      channel="openHostedSignup"
      linkLabel="See hosted Evenfire"
      successMessage="Evenfire opened in your browser."
      errorMessage="The Evenfire site could not be opened"
      continueLabel="I have a server — enter its address"
      onContinue={onContinue}
    />
  )
}
