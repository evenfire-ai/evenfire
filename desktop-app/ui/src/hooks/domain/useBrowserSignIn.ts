import { useCallback, useEffect, useRef, useState } from 'react'
import {
  BROWSER_SIGN_IN_OUTCOME_COPY,
  BROWSER_SIGN_IN_REFUSAL_COPY,
  START_REJECTION_REREAD_CODES,
} from '@constants/browserSignIn'
import { errorClass } from '@lib/errorClass'
import { ipcErrorCode } from '@lib/ipcErrorCode'
import { newerBrowserSignInSnapshot } from '../../../../src/browserSignInModel'
import type { BrowserSignInSnapshot, BrowserSignInStartResult } from '../../../../src/types'
import type { Tone } from '../../uiTypes'
import type { UseBrowserSignInParams, UseBrowserSignInResult } from './types'

type EndedSnapshot = Extract<BrowserSignInSnapshot, { phase: 'ended' }>

const NO_ATTEMPT: BrowserSignInSnapshot = Object.freeze({ attemptId: null, phase: 'idle' })

/** Every start refusal the renderer reacts to by name (D5); any other shows the failure. */
const START_REJECTION_CODES = Object.freeze([
  ...START_REJECTION_REREAD_CODES,
  'browser_sign_in_requires_signout',
  'browser_sign_in_finishing',
  'browser_open_failed',
] as const)

type StartRejectionCode = (typeof START_REJECTION_CODES)[number]

function isRereadCode(code: StartRejectionCode): boolean {
  return (START_REJECTION_REREAD_CODES as readonly string[]).includes(code)
}

/** The status an outcome shows, or null for `replaced`, which shows nothing (decision 5). */
function outcomeStatus(snapshot: EndedSnapshot): { message: string; tone: Tone } | null {
  switch (snapshot.outcome) {
    case 'signed_in':
      return { message: BROWSER_SIGN_IN_OUTCOME_COPY.signedIn, tone: 'success' }
    case 'cancelled':
      return { message: BROWSER_SIGN_IN_OUTCOME_COPY.cancelled, tone: 'info' }
    case 'timed_out':
      return { message: BROWSER_SIGN_IN_OUTCOME_COPY.timedOut, tone: 'warn' }
    case 'replaced':
      return null
    case 'refused':
      return { message: BROWSER_SIGN_IN_REFUSAL_COPY[snapshot.reason], tone: 'error' }
    case 'failed':
      switch (snapshot.reason) {
        case 'different_environment':
          return { message: BROWSER_SIGN_IN_OUTCOME_COPY.differentEnvironment, tone: 'error' }
        case 'unavailable':
          return { message: BROWSER_SIGN_IN_OUTCOME_COPY.unavailable, tone: 'error' }
        case 'no_longer_available':
          return { message: BROWSER_SIGN_IN_OUTCOME_COPY.noLongerAvailable, tone: 'error' }
        default:
          // No reason, or `environment_changed`: the generic failure (design §10.1).
          return { message: BROWSER_SIGN_IN_OUTCOME_COPY.failed, tone: 'error' }
      }
  }
}

/**
 * The renderer's copy of main's browser sign-in snapshot (D13, C-1). Pushes, the boot read and
 * the replies of start, cancel and acknowledge may arrive in any order, so each is kept only
 * when it is newer than the view (`newerBrowserSignInSnapshot`). The ref is written first, then
 * the state, so `isRedeeming()` reads the newest snapshot before React commits it (V32).
 *
 * An outcome is shown once per attempt from an effect on the committed `ended` view, then
 * acknowledged; main's `idle` snapshot that follows clears the view (plan decision 5).
 */
export function useBrowserSignIn({
  setStatus,
  onSessionNeedsLoad,
  refreshLoginMethods,
}: UseBrowserSignInParams): UseBrowserSignInResult {
  const [view, setView] = useState<BrowserSignInSnapshot>(NO_ATTEMPT)
  const viewRef = useRef<BrowserSignInSnapshot>(NO_ATTEMPT)
  /** The highest attempt id whose outcome this renderer has taken up. Ids only grow (V15). */
  const handledOutcomeRef = useRef(0)

  const apply = useCallback((candidate: BrowserSignInSnapshot) => {
    const next = newerBrowserSignInSnapshot(viewRef.current, candidate)
    if (next === viewRef.current) return
    viewRef.current = next
    setView(next)
  }, [])

  // Subscribe first, then read: a push sent while the read is in flight is kept, and the
  // ordering drops whichever of the two is older (D13, G2-13d).
  useEffect(() => {
    let active = true
    const unsubscribe = window.clerum.auth.onBrowserSignInChanged(apply)
    window.clerum.auth.getBrowserSignInState().then(
      snapshot => {
        if (active) apply(snapshot)
      },
      error => {
        // Pushes still arrive; a stored outcome waits for the next renderer's read (D13).
        console.warn(
          '[useBrowserSignIn] The browser sign-in state could not be read',
          errorClass(error)
        )
      }
    )
    return () => {
      active = false
      unsubscribe()
    }
  }, [apply])

  const showOutcome = useCallback(
    async (snapshot: EndedSnapshot) => {
      const status = outcomeStatus(snapshot)
      if (status) setStatus(status.message, status.tone)
      if (snapshot.outcome === 'signed_in') {
        // Main has installed the session; the renderer loads it whatever it shows (D13). The
        // outcome is acknowledged once the load settles, either way (decision 5).
        try {
          await onSessionNeedsLoad({ preserveNav: true })
        } catch (error) {
          console.warn(
            '[useBrowserSignIn] The session could not be loaded after browser sign-in',
            errorClass(error)
          )
          // Replaces "Signed in.": the login screen is still showing. Fixed text, never the
          // error's message (D18).
          setStatus(BROWSER_SIGN_IN_OUTCOME_COPY.sessionLoadFailed, 'error')
        }
      }
      try {
        apply(await window.clerum.auth.acknowledgeBrowserSignInResult(snapshot.attemptId))
      } catch (error) {
        // Main keeps the outcome until it is acknowledged, so the next renderer's boot read
        // shows it again (D13).
        console.warn(
          '[useBrowserSignIn] The browser sign-in result could not be acknowledged',
          errorClass(error)
        )
      }
    },
    [apply, onSessionNeedsLoad, setStatus]
  )

  useEffect(() => {
    if (view.phase !== 'ended' || view.attemptId <= handledOutcomeRef.current) return
    handledOutcomeRef.current = view.attemptId
    void showOutcome(view)
  }, [view, showOutcome])

  /** D5's reactions. Codes are matched only through `ipcErrorCode` (M5). */
  const onStartRefused = useCallback(
    async (error: unknown) => {
      const code = ipcErrorCode(error, START_REJECTION_CODES)
      if (code !== null && isRereadCode(code)) {
        refreshLoginMethods()
        return
      }
      if (code === 'browser_sign_in_requires_signout') {
        // Main holds a session the renderer does not show (V29).
        try {
          await onSessionNeedsLoad()
        } catch (loadError) {
          console.warn(
            '[useBrowserSignIn] The session could not be loaded after start found one',
            errorClass(loadError)
          )
          setStatus(BROWSER_SIGN_IN_OUTCOME_COPY.sessionLoadFailed, 'error')
        }
        return
      }
      // The snapshot carries these: the attempt redeems, or main ended it `failed` (A3-66).
      if (code === 'browser_sign_in_finishing' || code === 'browser_open_failed') return
      setStatus(BROWSER_SIGN_IN_OUTCOME_COPY.failed, 'error')
    },
    [onSessionNeedsLoad, refreshLoginMethods, setStatus]
  )

  const start = useCallback(async () => {
    let reply: BrowserSignInStartResult
    try {
      reply = await window.clerum.auth.startBrowserSignIn()
    } catch (error) {
      await onStartRefused(error)
      return
    }
    // Start's reply counts as `waiting` for its attempt, ordered with the pushes (C-1).
    apply({ attemptId: reply.attemptId, phase: 'waiting' })
  }, [apply, onStartRefused])

  const cancel = useCallback(async () => {
    try {
      apply(await window.clerum.auth.cancelBrowserSignIn())
    } catch (error) {
      // Main pushes every change, so the view still follows it; only this reply is lost.
      console.warn('[useBrowserSignIn] Browser sign-in could not be cancelled', errorClass(error))
    }
  }, [apply])

  const isRedeeming = useCallback(() => viewRef.current.phase === 'redeeming', [])

  return { view, isRedeeming, start, cancel }
}
