import { Button, Card, Divider, Flex } from 'antd'
import { AuthBrand } from '@components/AuthBrand'
import { RuntimeConfigDock } from '@components/RuntimeConfigDock'
import { authCardBodyPadding, authCardWidth, authPageMinHeight } from '@constants/authLayout'
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

  return (
    <main tabIndex={-1}>
      <Flex align="center" justify="center" style={{ minHeight: authPageMinHeight }}>
        <Card style={{ width: authCardWidth }} styles={{ body: { padding: authCardBodyPadding } }}>
          <Flex vertical gap="large">
            <AuthBrand />
            <Divider />

            <Flex vertical gap="middle">
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
            </Flex>

            {canGoBack ? (
              <Button htmlType="button" onClick={back} type="link">
                Back
              </Button>
            ) : null}
          </Flex>
        </Card>
      </Flex>
      <RuntimeConfigDock onAddEnvironment={goToManual} />
    </main>
  )
}
