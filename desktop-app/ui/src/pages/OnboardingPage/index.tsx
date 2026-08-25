import { RuntimeConfigDock } from '@components/RuntimeConfigDock'
import { formatDesktopAppVersionTooltip, useDesktopAppInfo } from '@hooks/useDesktopAppInfo'
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
  const desktopAppInfo = useDesktopAppInfo()
  const desktopVersionTooltip = formatDesktopAppVersionTooltip(desktopAppInfo)

  return (
    <main className="auth-page">
      <section className="auth-card glass-card">
        <header className="auth-card__header">
          <div className="auth-brand" title={desktopVersionTooltip}>
            <img className="auth-brand-mark" src="./logo.svg" alt="" aria-hidden="true" />
            <span className="auth-brand-copy">
              <span className="auth-brand-title">Evenfire</span>
              <span className="auth-brand-subtitle">Desktop App</span>
            </span>
          </div>
        </header>

        {step === 'origin' || step === 'runStyle' ? (
          <PathChoice step={step} onAnswerOrigin={answerOrigin} onAnswerRunStyle={answerRunStyle} />
        ) : null}
        {step === 'invited' ? <InvitedMember /> : null}
        {step === 'hosted' ? <Hosted onContinue={goToManual} /> : null}
        {step === 'selfHosted' ? <SelfHosted onContinue={goToManual} /> : null}
        {step === 'manual' ? <ManualEnvironment /> : null}

        {canGoBack ? (
          <button type="button" className="auth-inline-link" onClick={back}>
            Back
          </button>
        ) : null}
      </section>
      <RuntimeConfigDock onAddEnvironment={goToManual} />
    </main>
  )
}
