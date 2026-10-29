import { useEffect, useRef } from 'react'
import { useAgentActivityContext } from '@contexts/AgentActivityContext'
import { useNavigationContext } from '@contexts/NavigationContext'
import { Alert, Card, Empty, Flex, Skeleton, Spin, Typography } from 'antd'
import { AgentWorkspace } from '@components/agents/AgentWorkspace'
import { useAgentsDataController } from '@hooks/domain/useAgentsDataController'
import { pickLatestAgent } from '@lib/agents'

export function ChatPage() {
  const { agentNames, loading, error } = useAgentsDataController()
  const { selectedAgent, handleSelectChatAgent: onSelectAgent } = useNavigationContext()
  const { agentLastActiveByAgent } = useAgentActivityContext()
  const didAutoSelect = useRef(false)

  useEffect(() => {
    if (!selectedAgent && agentNames.length) {
      didAutoSelect.current = false
    }
    if (didAutoSelect.current || selectedAgent || !agentNames.length) return
    didAutoSelect.current = true
    const best = pickLatestAgent(agentNames, agentLastActiveByAgent)
    if (best) onSelectAgent(best, { selectLatest: false })
  }, [agentNames, agentLastActiveByAgent, selectedAgent, onSelectAgent])

  if (loading && !agentNames.length) {
    return <ChatPageSkeleton />
  }

  if (!agentNames.length) {
    return (
      <section className="page">
        <div className="page-header">
          <Typography.Title level={2}>Chat</Typography.Title>
          <Typography.Paragraph type="secondary">
            Start a conversation with an authorized agent.
          </Typography.Paragraph>
        </div>
        <Card>
          {loading ? (
            <Flex justify="center">
              <Spin tip="Fetching authorized agents..." />
            </Flex>
          ) : error ? (
            <Alert showIcon title={error} type="error" />
          ) : (
            <Empty description="You do not currently have authorized agents in this team." />
          )}
        </Card>
      </section>
    )
  }

  return <AgentWorkspace mode="chat" />
}

function ChatPageSkeleton() {
  return (
    <section aria-busy="true" aria-label="Loading chat">
      <Flex vertical gap="large">
        <Skeleton active paragraph={{ rows: 1 }} />
        <Skeleton active paragraph={{ rows: 3 }} />
        <Flex align="center" gap="small">
          <Skeleton.Input active block />
          <Skeleton.Button active />
        </Flex>
      </Flex>
    </section>
  )
}
