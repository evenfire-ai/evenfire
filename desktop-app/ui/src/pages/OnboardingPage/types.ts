/**
 * First-run onboarding types (spec §5.2).
 *
 * The wizard is one page with a step model and an explicit history stack, not
 * a set of routes. Answers live in the controller; only a path's terminal
 * action touches disk.
 */

export type OnboardingStep =
  | 'origin'
  | 'runStyle'
  | 'compare'
  | 'invited'
  | 'hosted'
  | 'selfHosted'
  | 'manual'

/** Q1 — "Do you already have an Evenfire server?" */
export type OnboardingOriginAnswer = 'invited' | 'haveAddress' | 'gettingStarted'

/**
 * Q2 — "How do you want to run Evenfire?"
 *
 * `compare` is the undecided answer: it leads to a side-by-side of the other
 * two rather than committing the user to either.
 */
export type OnboardingRunStyleAnswer = 'hosted' | 'selfHosted' | 'compare'

export interface OnboardingViewModel {
  step: OnboardingStep
  /** False on the first step, which uses Q1's "I have a server address" as its skip. */
  canGoBack: boolean
  /** Whether Q2 is part of the flow. False until the hosted project exists. */
  hostedAvailable: boolean
  answerOrigin: (answer: OnboardingOriginAnswer) => void
  answerRunStyle: (answer: OnboardingRunStyleAnswer) => void
  goToManual: () => void
  back: () => void
  reset: () => void
}
