import { useEffect, useId, useState } from 'react'
import { Button, EmptyState } from '@components/Common'
import { describeGfsReadError } from '@lib/gfsGrantErrors'
import type { GfsReadFailureCardProps } from './types'

/** Sub-second, so a throttled or delayed wake-up cannot leave a stale number on screen. */
const COUNTDOWN_TICK_MS = 250

function secondsUntil(deadline: number | null): number {
  if (deadline === null) return 0
  return Math.max(0, Math.ceil((deadline - Date.now()) / 1000))
}

/**
 * Terminal state for a GFS read the server refused.
 *
 * Before this existed no surface had a way to say "the request was answered,
 * and the answer was no": a rejected read left the loader spinning and the raw
 * IPC string in a red banner. The countdown is the point — it runs to the
 * server's own `retryAfterSeconds` (the value it also puts in `Retry-After`),
 * so the user waits the exact window instead of hammering a budget that is
 * already exhausted.
 *
 * Shared rather than page-local because both read planes need it and they must
 * not drift: the Files page shows it for root discovery and for a folder
 * listing, the composer's picker for the same two. A second copy would be a
 * second countdown to keep correct.
 */
export function GfsReadFailureCard({ failure, onRetry }: GfsReadFailureCardProps) {
  const countdownId = useId()
  const { retryAvailableAt } = failure
  const [remainingSeconds, setRemainingSeconds] = useState(() => secondsUntil(retryAvailableAt))

  // One effect, keyed on the absolute deadline, and every tick recomputes the
  // remainder from the clock. Decrementing a counter instead would drift —
  // each 1000 ms interval actually fires later than that, and Electron
  // throttles timers in a hidden window — so the countdown could still be
  // running after the server's window had closed. Keying on the deadline (a
  // number) rather than on `failure` (an object) is what re-arms the countdown
  // for a second, identically-worded 429.
  useEffect(() => {
    setRemainingSeconds(secondsUntil(retryAvailableAt))
    if (retryAvailableAt === null || retryAvailableAt <= Date.now()) return
    const timer = setInterval(() => {
      const remaining = secondsUntil(retryAvailableAt)
      setRemainingSeconds(remaining)
      if (remaining <= 0) clearInterval(timer)
    }, COUNTDOWN_TICK_MS)
    return () => clearInterval(timer)
  }, [retryAvailableAt])

  return (
    <>
      {/* role="status" announces the switch from the loader to this card once.
          Without it a screen-reader user is left on "Loading files…" with no
          signal that the load has settled into a failure. */}
      <div role="status">
        <EmptyState
          title={
            failure.kind === 'rate-limited' ? 'Too many file requests' : 'Could not load your files'
          }
          body={
            failure.kind === 'rate-limited'
              ? 'File listing is temporarily rate limited. Evenfire will let you retry once the server’s own window closes.'
              : describeGfsReadError(failure.message).message
          }
        />
      </div>
      <div className="da-gfs-footer-actions">
        {remainingSeconds > 0 ? (
          // Deliberately NOT a live region: it changes every second, and a
          // polite region would announce each tick. The button references it
          // instead, so asking for the button reads the wait along with it.
          <span className="muted" id={countdownId}>
            Retry available in{' '}
            <span data-testid="gfs-discovery-retry-seconds">{remainingSeconds}</span>s
          </span>
        ) : null}
        <Button
          aria-describedby={remainingSeconds > 0 ? countdownId : undefined}
          disabled={remainingSeconds > 0}
          onClick={onRetry}
          size="sm"
          variant="outline"
        >
          Retry file listing
        </Button>
      </div>
    </>
  )
}
