import { Alert, Card, Empty, Flex, Spin, Typography } from 'antd'
import { AgentWorkspace } from '../components/agents/AgentWorkspace'
import { FleetBoard } from '../components/agents/FleetBoard'
import { useNavigationContext } from '../contexts/NavigationContext'
import { useAgentsDataController } from '../hooks/domain/useAgentsDataController'

export function AgentsPage() {
  const { agentNames, loading, error } = useAgentsDataController()
  const { selectedAgent } = useNavigationContext()

  return agentNames.length ? (
    selectedAgent ? (
      <AgentWorkspace />
    ) : (
      <FleetBoard />
    )
  ) : (
    <section className="page">
      <Flex vertical gap="middle">
        <header>
          <Typography.Title level={2}>Agents</Typography.Title>
          <Typography.Paragraph type="secondary">
            Create, manage, and monitor your AI agents from one place.
          </Typography.Paragraph>
        </header>
        <Card>
          {loading ? (
            <Spin tip="Fetching authorized agents..." />
          ) : error ? (
            <Alert type="error" showIcon role="alert" title={error} />
          ) : (
            <Empty description="You do not currently have authorized agents." />
          )}
        </Card>
      </Flex>
    </section>
  )
}
