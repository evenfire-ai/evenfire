import type { FormEvent } from 'react'
import { useAuthContext } from '@contexts/AuthContext'
import { Button, Flex, Input, Typography } from 'antd'
import {
  LOCALHOST_RUNTIME_CONFIG_OPTION_ID,
  createLocalhostRuntimeConfigOption,
} from '@constants/runtimeConfig'
import { useLocalhostReachable } from '@hooks/useLocalhostReachable'

/**
 * Manual environment: connect to a server by address.
 *
 * The terminal step for the self-hosted and have-an-address answers alike, so it carries the local-cluster
 * hint for both. It shares `handleSaveRuntimeConfig` with AuthPage's inline
 * environment form: one submit path, one validation rule.
 */
export function ManualEnvironment() {
  const {
    busy,
    runtimeConfigSetupName,
    runtimeConfigSetupExternalRestApiBaseUrl,
    setRuntimeConfigSetupName,
    setRuntimeConfigSetupExternalRestApiBaseUrl,
    handleSaveRuntimeConfig,
    handleSelectRuntimeConfig,
  } = useAuthContext()

  // One bounded probe on entry. A negative or failed result
  // renders nothing, so a user with no local cluster sees no trace of it. The
  // probe never fills the form or saves on its own.
  const localhostReachable = useLocalhostReachable()
  const localhostOption = createLocalhostRuntimeConfigOption()

  const hasRuntimeSetupValues =
    Boolean(runtimeConfigSetupName.trim()) &&
    Boolean(runtimeConfigSetupExternalRestApiBaseUrl.trim())

  const handleSubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    if (!busy && hasRuntimeSetupValues) {
      void handleSaveRuntimeConfig()
    }
  }

  return (
    <>
      <Typography.Title level={1}>Connect to a server</Typography.Title>
      <Typography.Paragraph type="secondary">
        Enter the address of your Evenfire server. You can add more environments later.
      </Typography.Paragraph>
      {localhostReachable ? (
        <Flex vertical gap="small">
          <Button
            block
            htmlType="button"
            disabled={busy}
            onClick={() => void handleSelectRuntimeConfig(LOCALHOST_RUNTIME_CONFIG_OPTION_ID)}
          >
            <Flex vertical align="start" gap="small">
              <Typography.Text strong>Localhost</Typography.Text>
              <Typography.Text type="secondary">
                {localhostOption.externalRestApiBaseUrl}
              </Typography.Text>
            </Flex>
          </Button>
        </Flex>
      ) : null}
      <form onSubmit={handleSubmit}>
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
            <label htmlFor="runtime-config-external-rest-api-input">External REST API</label>
            <Input
              id="runtime-config-external-rest-api-input"
              type="url"
              placeholder="https://evenfire.example.com"
              value={runtimeConfigSetupExternalRestApiBaseUrl}
              onChange={event => setRuntimeConfigSetupExternalRestApiBaseUrl(event.target.value)}
            />
          </Flex>
          <Button block disabled={!hasRuntimeSetupValues || busy} htmlType="submit" type="primary">
            Save environment
          </Button>
        </Flex>
      </form>
    </>
  )
}
