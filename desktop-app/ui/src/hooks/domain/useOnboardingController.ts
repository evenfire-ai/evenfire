import { useCallback, useMemo, useState } from 'react'
import type {
  OnboardingOriginAnswer,
  OnboardingRunStyleAnswer,
  OnboardingStep,
  OnboardingViewModel,
} from '@pages/OnboardingPage/types'

/**
 * Whether the hosted trial path (spec §5.3) is reachable in this build.
 *
 * False until the hosted signup project exists: Q2 would otherwise offer a
 * choice with one real answer. While false, Q1's "just getting started"
 * routes straight to the self-hosted step. Flipping this to true is the only
 * change this file needs when path A ships (spec §7.1).
 */
const HOSTED_SIGNUP_AVAILABLE = false

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
      // 'hosted' gets its own waiting step in the PR that ships path A
      // (spec §5.3). Until then Q2 is never rendered, so only 'selfHosted'
      // can arrive here.
      if (answer === 'selfHosted') goTo('selfHosted')
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
      hostedAvailable: HOSTED_SIGNUP_AVAILABLE,
      answerOrigin,
      answerRunStyle,
      goToManual,
      back,
      reset,
    }),
    [state.step, state.history.length, answerOrigin, answerRunStyle, goToManual, back, reset]
  )
}
