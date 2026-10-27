import { Button, Flex, Typography } from 'antd'
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
        <Typography.Title level={1}>How do you want to run Evenfire?</Typography.Title>
        <Flex vertical gap="small">
          <Button block htmlType="button" onClick={() => onAnswerRunStyle('hosted')}>
            <Flex vertical align="start" gap="small">
              <Typography.Text strong>Evenfire hosts it for me</Typography.Text>
              <Typography.Text type="secondary">
                We run and operate it for you. Nothing to deploy.
              </Typography.Text>
            </Flex>
          </Button>
          <Button block htmlType="button" onClick={() => onAnswerRunStyle('selfHosted')}>
            <Flex vertical align="start" gap="small">
              <Typography.Text strong>I’ll run it myself</Typography.Text>
              <Typography.Text type="secondary">
                Deploy Evenfire to a cluster you control.
              </Typography.Text>
            </Flex>
          </Button>
          <Button block htmlType="button" onClick={() => onAnswerRunStyle('compare')}>
            <Flex vertical align="start" gap="small">
              <Typography.Text strong>I have no idea</Typography.Text>
              <Typography.Text type="secondary">
                Tell me more about the other two options.
              </Typography.Text>
            </Flex>
          </Button>
        </Flex>
      </>
    )
  }

  return (
    <>
      <Typography.Title level={1}>Do you already have an Evenfire server?</Typography.Title>
      <Typography.Paragraph type="secondary">
        The desktop app connects to an Evenfire server. Tell us which one and we’ll get you there.
      </Typography.Paragraph>
      <Flex vertical gap="small">
        <Button block htmlType="button" onClick={() => onAnswerOrigin('invited')}>
          <Flex vertical align="start" gap="small">
            <Typography.Text strong>My team already uses Evenfire</Typography.Text>
            <Typography.Text type="secondary">
              Finish setup with the email your team invited.
            </Typography.Text>
          </Flex>
        </Button>
        <Button block htmlType="button" onClick={() => onAnswerOrigin('haveAddress')}>
          <Flex vertical align="start" gap="small">
            <Typography.Text strong>I have a server address</Typography.Text>
            <Typography.Text type="secondary">
              Connect to a server you already know.
            </Typography.Text>
          </Flex>
        </Button>
        <Button block htmlType="button" onClick={() => onAnswerOrigin('gettingStarted')}>
          <Flex vertical align="start" gap="small">
            <Typography.Text strong>No, I’m just getting started</Typography.Text>
            <Typography.Text type="secondary">
              See your options for running Evenfire.
            </Typography.Text>
          </Flex>
        </Button>
      </Flex>
    </>
  )
}
