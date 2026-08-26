import { AuthBrand } from '@components/AuthBrand'
import { RuntimeConfigDock } from '@components/RuntimeConfigDock'
import { Hosted } from './steps/Hosted'
import { InvitedMember } from './steps/InvitedMember'
import { ManualEnvironment } from './steps/ManualEnvironment'
import { PathChoice } from './steps/PathChoice'
import { SelfHosted } from './steps/SelfHosted'
import type { OnboardingViewModel } from './types'

interface OnboardingPageProps {
  onboarding: OnboardingViewModel
}

/**
 * First-run onboarding (spec §5.2).
 *
 * Rendered instead of AuthPage when the app has no environment at all, so it
 * also carries the environment dock: the Localhost escape hatch (path E) lives
 * there, and a cold install would otherwise have no way to reach it.
 */
export function OnboardingPage({ onboarding }: OnboardingPageProps) {
  const { step, canGoBack, answerOrigin, answerRunStyle, goToManual, back } = onboarding

  return (
    <main className="auth-page">
      <section className="auth-card glass-card auth-card--flow">
        <header className="auth-card__header">
          <AuthBrand />
        </header>
        <div className="auth-card__divider" role="presentation" />

        {/* One wrapper for every step so the card can hold a constant height
            and scroll internally, instead of resizing as steps change. */}
        <div className="auth-card__body">
          {step === 'origin' || step === 'runStyle' ? (
            <PathChoice
              step={step}
              onAnswerOrigin={answerOrigin}
              onAnswerRunStyle={answerRunStyle}
            />
          ) : null}
          {step === 'invited' ? <InvitedMember /> : null}
          {step === 'hosted' ? <Hosted onContinue={goToManual} /> : null}
          {step === 'selfHosted' ? <SelfHosted onContinue={goToManual} /> : null}
          {step === 'manual' ? <ManualEnvironment /> : null}
        </div>

        <div className="auth-card__footer">
          {canGoBack ? (
            <button type="button" className="auth-inline-link" onClick={back}>
              Back
            </button>
          ) : null}
        </div>
      </section>
      <RuntimeConfigDock onAddEnvironment={goToManual} />
    </main>
  )
}
