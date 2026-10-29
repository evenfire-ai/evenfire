import { useAuthContext } from '@contexts/AuthContext'
import { Button, Card, Descriptions, Flex, Typography } from 'antd'
import { authCardBodyPadding, authCardWidth, authPageMinHeight } from '@constants/authLayout'

export function UnavailablePage() {
  const { busy, dependencyHealth, setBooting, setStatus, loadSession } = useAuthContext()

  const handleRetry = () => {
    setBooting(true)
    loadSession().catch(error => {
      setStatus(
        `Health recheck failed: ${error instanceof Error ? error.message : String(error)}`,
        'error'
      )
      setBooting(false)
    })
  }

  return (
    <main>
      <Flex align="center" justify="center" style={{ minHeight: authPageMinHeight }}>
        <Card
          style={{ width: authCardWidth }}
          styles={{
            body: { padding: authCardBodyPadding },
            header: { paddingInline: authCardBodyPadding },
          }}
          title={<Typography.Title level={1}>Services Unavailable</Typography.Title>}
        >
          <Flex vertical gap="middle">
            <Typography.Paragraph>
              Cannot render authentication because one or more backend services are unavailable.
            </Typography.Paragraph>
            <Descriptions column={1}>
              <Descriptions.Item label="external-rest-api">
                {dependencyHealth?.externalRestApi.ok ? 'healthy' : 'unavailable'}
              </Descriptions.Item>
              <Descriptions.Item label="rpc-proxy">
                {dependencyHealth?.rpcProxy.ok ? 'healthy' : 'unavailable'}
              </Descriptions.Item>
            </Descriptions>
            <Button block disabled={busy} htmlType="button" onClick={handleRetry}>
              Retry Health Check
            </Button>
          </Flex>
        </Card>
      </Flex>
    </main>
  )
}
