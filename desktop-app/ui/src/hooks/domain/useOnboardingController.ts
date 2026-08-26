import { useCallback, useMemo, useState } from 'react'
import type {
  OnboardingOriginAnswer,
  OnboardingRunStyleAnswer,
  OnboardingStep,
  OnboardingViewModel,
} from '@pages/OnboardingPage/types'

/**
 * Whether the hosted path (spec §5.3) is offered in Q2.
 *
 * True: hosting is the first thing someone just getting started should see,
 * and the hosted step has somewhere real to send them — the Evenfire site.
 * It is a link-out, not an in-app signup, because tenant provisioning and the
 * deep-link handoff do not exist yet (see `steps/Hosted.tsx`). Setting this to
 * false collapses Q2 and routes "just getting started" straight to
 * self-hosting.
 */
const HOSTED_SIGNUP_AVAILABLE = true

interface OnboardingState {
  step: OnboardingStep
  history: OnboardingStep[]
}

const INITIAL_STATE: OnboardingState = { step: 'origin', history: [] }

/**
 * Onboarding wizard state (spec §5.1, §5.2).
 *
 * Memory-only by design. A cold install closed mid-questionnaire comes back to
 * Q1: nothing was accomplished worth restoring, and persisting a half-answered
 * wizard can strand the user on a step whose path no longer applies.
 *
 * Step and history are one state value so a step transition is a single
 * update. Nesting `setHistory` inside a `setStep` updater would push a
 * duplicate history entry under StrictMode's double invocation.
 */
export function useOnboardingController(): OnboardingViewModel {
  const [state, setState] = useState<OnboardingState>(INITIAL_STATE)

  const goTo = useCallback((next: OnboardingStep) => {
    setState(current => ({ step: next, history: [...current.history, current.step] }))
  }, [])

  const answerOrigin = useCallback(
    (answer: OnboardingOriginAnswer) => {
      if (answer === 'invited') return goTo('invited')
      if (answer === 'haveAddress') return goTo('manual')
      return goTo(HOSTED_SIGNUP_AVAILABLE ? 'runStyle' : 'selfHosted')
    },
    [goTo]
  )

  const answerRunStyle = useCallback(
    (answer: OnboardingRunStyleAnswer) => {
      if (answer === 'compare') return goTo('compare')
      goTo(answer === 'hosted' ? 'hosted' : 'selfHosted')
    },
    [goTo]
  )

  const goToManual = useCallback(() => goTo('manual'), [goTo])

  const back = useCallback(() => {
    setState(current => {
      const previous = current.history[current.history.length - 1]
      if (!previous) return current
      return { step: previous, history: current.history.slice(0, -1) }
    })
  }, [])

  const reset = useCallback(() => setState(INITIAL_STATE), [])

  return useMemo(
    () => ({
      step: state.step,
      canGoBack: state.history.length > 0,
      answerOrigin,
      answerRunStyle,
      goToManual,
      back,
      reset,
    }),
    [state.step, state.history.length, answerOrigin, answerRunStyle, goToManual, back, reset]
  )
}
