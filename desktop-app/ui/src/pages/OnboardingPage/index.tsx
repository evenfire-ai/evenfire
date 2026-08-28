import { useEffect } from 'react'
import { AuthBrand } from '@components/AuthBrand'
import { RuntimeConfigDock } from '@components/RuntimeConfigDock'
import { CompareRunStyles } from './steps/CompareRunStyles'
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
 * First-run onboarding.
 *
 * Rendered instead of AuthPage when the app has no environment at all, so it
 * also carries the environment dock: the Localhost escape hatch lives
 * there, and a cold install would otherwise have no way to reach it.
 */
export function OnboardingPage({ onboarding }: OnboardingPageProps) {
  const { step, canGoBack, answerOrigin, answerRunStyle, goToManual, back } = onboarding

  // Left arrow steps back through the wizard. There is no matching forward:
  // most steps ask a question, and picking an answer for the user is not
  // navigation. Typing is left alone — a caret moving inside the address or
  // email field must keep moving.
  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'ArrowLeft' || !canGoBack) return
      const target = event.target as HTMLElement | null
      const tag = target?.tagName
      if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || target?.isContentEditable) {
        return
      }
      event.preventDefault()
      back()
    }

    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [canGoBack, back])

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
          {step === 'compare' ? (
            <CompareRunStyles
              onChooseHosted={() => answerRunStyle('hosted')}
              onChooseSelfHosted={() => answerRunStyle('selfHosted')}
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
