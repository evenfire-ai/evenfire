import type { FormEvent } from 'react'
import { useAuthContext } from '@contexts/AuthContext'
import { Button, Flex, Input, Spin, Typography } from 'antd'

/**
 * Invited member: finish setup for an address a team already invited.
 *
 * Behaviour is unchanged from the form this replaces on AuthPage: the same
 * `handleStartDesktopSetup` handler, the same single email field, the same
 * "Open setup again" affordance once setup has been started. Only its home
 * moved. Distinct copy for a missing invitation lands in the follow-up PR.
 */
export function InvitedMember() {
  const { busy, email, desktopSetupStarted, authTransitioning, setEmail, handleStartDesktopSetup } =
    useAuthContext()

  const handleSubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    if (!busy && email.trim()) {
      handleStartDesktopSetup()
    }
  }

  return (
    <>
      <Typography.Title level={1}>Connect to your team</Typography.Title>
      <Typography.Paragraph type="secondary">
        Enter the email address your team invited. We’ll open your browser to finish setup.
      </Typography.Paragraph>
      <form onSubmit={handleSubmit}>
        <Flex vertical gap="middle">
          <Flex vertical gap="small">
            <label htmlFor="desktop-setup-email-input">Email</label>
            <Input
              id="desktop-setup-email-input"
              type="email"
              placeholder="you@evenfire.com"
              value={email}
              onChange={event => setEmail(event.target.value)}
            />
          </Flex>
          <Button block disabled={!email.trim() || busy} htmlType="submit" type="primary">
            {authTransitioning ? (
              <Flex align="center" gap="small" justify="center">
                <Spin aria-hidden="true" size="small" />
                Opening setup...
              </Flex>
            ) : desktopSetupStarted ? (
              'Open setup again'
            ) : (
              'Continue setup'
            )}
          </Button>
        </Flex>
      </form>
    </>
  )
}
