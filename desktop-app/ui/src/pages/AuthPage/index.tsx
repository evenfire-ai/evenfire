import type { FormEvent } from 'react'
import { useState } from 'react'
import { useAuthContext } from '@contexts/AuthContext'
import { Alert, Button, Card, Flex, Input, Spin, Typography } from 'antd'
import { AuthBrand } from '@components/AuthBrand'
import { RuntimeConfigDock } from '@components/RuntimeConfigDock'
import { authCardWidth, authPageMinHeight } from '@constants/authLayout'

/**
 * Sign-in for a configured environment.
 *
 * A cold install never reaches this page — the unauthenticated branch renders
 * onboarding instead, so the invitation email form that used to
 * live here now belongs to the wizard's invited step. AuthPage has
 * exactly one mode again: sign in, plus the environment dock and its inline
 * add-environment form.
 */
export function AuthPage() {
  const {
    busy,
    email,
    password,
    runtimeConfigSetupName,
    runtimeConfigSetupExternalRestApiBaseUrl,
    authTransitioning,
    backendSwitchHint,
    setEmail,
    setPassword,
    setRuntimeConfigSetupName,
    setRuntimeConfigSetupExternalRestApiBaseUrl,
    setStatus,
    handlePasswordLogin,
    handleSwitchLoginBackend,
    handleSaveRuntimeConfig,
  } = useAuthContext()

  const hasPasswordLoginCredentials = Boolean(email.trim()) && Boolean(password)
  const [runtimeSetupVisible, setRuntimeSetupVisible] = useState(false)
  const hasRuntimeSetupValues =
    Boolean(runtimeConfigSetupName.trim()) &&
    Boolean(runtimeConfigSetupExternalRestApiBaseUrl.trim())
  const [forgotPasswordBusy, setForgotPasswordBusy] = useState(false)

  const handlePasswordSubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    if (!busy && hasPasswordLoginCredentials) {
      handlePasswordLogin()
    }
  }

  const handleForgotPasswordClick = async () => {
    if (busy || forgotPasswordBusy) return
    setForgotPasswordBusy(true)
    try {
      await window.clerum.auth.openForgotPassword(email.trim().toLowerCase())
      setStatus('Password reset opened in your browser.', 'success')
    } catch {
      setStatus('Password reset could not be opened.', 'error')
    } finally {
      setForgotPasswordBusy(false)
    }
  }

  const handleRuntimeSetupSubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    if (!busy && hasRuntimeSetupValues) {
      handleSaveRuntimeConfig().then(state => {
        if (state) setRuntimeSetupVisible(false)
      })
    }
  }

  const handleRuntimeSetupCancel = () => {
    setRuntimeSetupVisible(false)
  }

  return (
    <main>
      <Flex align="center" justify="center" style={{ minHeight: authPageMinHeight }}>
        <Card style={{ width: authCardWidth }}>
          <Flex vertical gap="large">
            <AuthBrand />

            {/* Sign-in stays content-sized. The fixed height belongs to the
            onboarding wizard, which needs it because its steps differ wildly
            in length; sign-in has one short form and reads better snug. */}
            {runtimeSetupVisible ? (
              <form onSubmit={handleRuntimeSetupSubmit}>
                <Flex vertical gap="middle">
                  <Flex vertical gap="small">
                    <label htmlFor="runtime-config-name-input">Environment name</label>
                    <Input
                      id="runtime-config-name-input"
                      type="text"
                      placeholder="Production"
                      value={runtimeConfigSetupName}
                      onChange={event => setRuntimeConfigSetupName(event.target.value)}
                    />
                  </Flex>
                  <Flex vertical gap="small">
                    <label htmlFor="runtime-config-external-rest-api-input">
                      External REST API
                    </label>
                    <Input
                      id="runtime-config-external-rest-api-input"
                      type="url"
                      placeholder="https://example.com"
                      value={runtimeConfigSetupExternalRestApiBaseUrl}
                      onChange={event =>
                        setRuntimeConfigSetupExternalRestApiBaseUrl(event.target.value)
                      }
                    />
                  </Flex>
                  <Button block disabled={!hasRuntimeSetupValues || busy} htmlType="submit">
                    Save environment
                  </Button>
                  <Button
                    block
                    disabled={busy}
                    htmlType="button"
                    onClick={handleRuntimeSetupCancel}
                    type="link"
                  >
                    Go back to login
                  </Button>
                </Flex>
              </form>
            ) : (
              <form onSubmit={handlePasswordSubmit}>
                <Flex vertical gap="middle">
                  <Flex vertical gap="small">
                    <label htmlFor="email-input">Email</label>
                    <Input
                      id="email-input"
                      type="email"
                      placeholder="you@evenfire.com"
                      value={email}
                      onChange={event => setEmail(event.target.value)}
                    />
                  </Flex>
                  <Flex vertical gap="small">
                    <label htmlFor="password-input">Password</label>
                    <Input
                      id="password-input"
                      type="password"
                      placeholder="Your password"
                      value={password}
                      onChange={event => setPassword(event.target.value)}
                    />
                  </Flex>
                  <Button block disabled={!hasPasswordLoginCredentials || busy} htmlType="submit">
                    {authTransitioning ? (
                      <Flex align="center" gap="small" justify="center">
                        <Spin aria-hidden="true" size="small" />
                        <span>Signing in...</span>
                      </Flex>
                    ) : (
                      'Sign in'
                    )}
                  </Button>
                  <Button
                    block
                    disabled={busy || forgotPasswordBusy}
                    htmlType="button"
                    onClick={() => void handleForgotPasswordClick()}
                    type="link"
                  >
                    Forgot password
                  </Button>
                  {backendSwitchHint ? (
                    <Alert
                      description={
                        <Flex vertical gap="small">
                          <Typography.Text>
                            Couldn’t reach <strong>{backendSwitchHint.activeLabel}</strong>. A local
                            Evenfire looks like it’s running — switch to{' '}
                            <strong>{backendSwitchHint.targetLabel}</strong> and retry?
                          </Typography.Text>
                          <Button
                            block
                            disabled={busy}
                            htmlType="button"
                            onClick={() => void handleSwitchLoginBackend()}
                          >
                            {`Switch to ${backendSwitchHint.targetLabel} & retry`}
                          </Button>
                        </Flex>
                      }
                      type="warning"
                    />
                  ) : null}
                </Flex>
              </form>
            )}
          </Flex>
        </Card>
      </Flex>
      <RuntimeConfigDock onAddEnvironment={() => setRuntimeSetupVisible(true)} />
    </main>
  )
}
