import { SelectableOption } from '@components/Common'
import type { OnboardingOriginAnswer, OnboardingRunStyleAnswer } from '../types'

interface PathChoiceProps {
  step: 'origin' | 'runStyle'
  onAnswerOrigin: (answer: OnboardingOriginAnswer) => void
  onAnswerRunStyle: (answer: OnboardingRunStyleAnswer) => void
}

/**
 * The questionnaire itself — Q1, and Q2 once the hosted path ships.
 *
 * Q1's "I have a server address" doubles as the wizard's one-click skip, which
 * is why the first step needs no separate skip control.
 */
export function PathChoice({ step, onAnswerOrigin, onAnswerRunStyle }: PathChoiceProps) {
  if (step === 'runStyle') {
    return (
      <>
        <h1>How do you want to run Evenfire?</h1>
        <div className="onboarding-options">
          <SelectableOption
            className="onboarding-option"
            size="lg"
            onClick={() => onAnswerRunStyle('hosted')}
          >
            <span className="onboarding-option__title">Evenfire hosts it for me</span>
            <span className="onboarding-option__hint">
              We run and operate it for you. Nothing to deploy.
            </span>
          </SelectableOption>
          <SelectableOption
            className="onboarding-option"
            size="lg"
            onClick={() => onAnswerRunStyle('selfHosted')}
          >
            <span className="onboarding-option__title">I’ll run it myself</span>
            <span className="onboarding-option__hint">
              Deploy Evenfire to a cluster you control.
            </span>
          </SelectableOption>
          <SelectableOption
            className="onboarding-option"
            size="lg"
            onClick={() => onAnswerRunStyle('compare')}
          >
            <span className="onboarding-option__title">I have no idea</span>
            <span className="onboarding-option__hint">
              Tell me more about the other two options.
            </span>
          </SelectableOption>
        </div>
      </>
    )
  }

  return (
    <>
      <h1>Do you already have an Evenfire server?</h1>
      <p className="muted">
        The desktop app connects to an Evenfire server. Tell us which one and we’ll get you there.
      </p>
      <div className="onboarding-options">
        <SelectableOption
          className="onboarding-option"
          size="lg"
          onClick={() => onAnswerOrigin('invited')}
        >
          <span className="onboarding-option__title">My team already uses Evenfire</span>
          <span className="onboarding-option__hint">
            Finish setup with the email your team invited.
          </span>
        </SelectableOption>
        <SelectableOption
          className="onboarding-option"
          size="lg"
          onClick={() => onAnswerOrigin('haveAddress')}
        >
          <span className="onboarding-option__title">I have a server address</span>
          <span className="onboarding-option__hint">Connect to a server you already know.</span>
        </SelectableOption>
        <SelectableOption
          className="onboarding-option"
          size="lg"
          onClick={() => onAnswerOrigin('gettingStarted')}
        >
          <span className="onboarding-option__title">No, I’m just getting started</span>
          <span className="onboarding-option__hint">See your options for running Evenfire.</span>
        </SelectableOption>
      </div>
    </>
  )
}
