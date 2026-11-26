import { Button } from '@components/Common'
import { BROWSER_SIGN_IN_COPY } from '@constants/browserSignIn'
import type { BrowserSignInPanelProps } from './types'

/**
 * "Continue with <label>" and the browser sign-in's progress (design §10.1, D14).
 *
 * While the attempt waits, the person finishes in the browser and may cancel; the button stays
 * usable, so a new start replaces an attempt whose page was closed. While it redeems, main is
 * installing a session the server has already issued, which Cancel cannot stop (D10): the
 * button is disabled, Cancel is hidden and "Finishing sign-in…" shows.
 */
export function BrowserSignInPanel({
  label,
  view,
  startDisabled,
  onStart,
  onCancel,
}: BrowserSignInPanelProps) {
  const redeeming = view.phase === 'redeeming'
  return (
    <div className="auth-form-stack">
      <Button block disabled={startDisabled || redeeming} onClick={onStart}>
        {BROWSER_SIGN_IN_COPY.continueWith(label)}
      </Button>
      {view.phase === 'waiting' ? (
        <>
          <p className="auth-flow-card__copy" role="status">
            {BROWSER_SIGN_IN_COPY.waiting}
          </p>
          <Button block size="sm" variant="soft" color="neutral" onClick={onCancel}>
            {BROWSER_SIGN_IN_COPY.cancel}
          </Button>
        </>
      ) : null}
      {redeeming ? (
        <p className="auth-flow-card__copy" role="status">
          <span className="auth-button-loading">
            <span className="auth-button-spinner" aria-hidden="true" />
            {BROWSER_SIGN_IN_COPY.redeeming}
          </span>
        </p>
      ) : null}
    </div>
  )
}
