import { useEffect, useRef } from 'react'
import type { RefObject } from 'react'
import { useAgentActivityContext } from '@contexts/AgentActivityContext'
import { useNavigationContext } from '@contexts/NavigationContext'
import { EmptyState } from '@components/Common'
import { AgentWorkspace } from '@components/agents/AgentWorkspace'
import { useAgentsDataController } from '@hooks/domain/useAgentsDataController'
import { pickLatestAgent } from '@lib/agents'

type ChatPageProps = {
  scrollContainerRef: RefObject<HTMLElement | null>
}

export function ChatPage({ scrollContainerRef }: ChatPageProps) {
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
          <h2>Chat</h2>
          <p className="muted">Start a conversation with an authorized agent.</p>
        </div>
        <section className="page-card">
          {loading ? (
            <EmptyState title="Loading" body="Fetching authorized agents..." />
          ) : error ? (
            <div className="composer-error">
              <p className="error-text">{error}</p>
            </div>
          ) : (
            <EmptyState
              title="No agents available"
              body="You do not currently have authorized agents in this team."
            />
          )}
        </section>
      </section>
    )
  }

  return <AgentWorkspace mode="chat" scrollContainerRef={scrollContainerRef} />
}

function ChatPageSkeleton() {
  return (
    <section className="agent-page chat-page-skeleton" aria-busy="true">
      <span className="visually-hidden">Fetching authorized agents...</span>
      <div className="agent-workspace-shell page-card">
        <div className="agent-chat-nav-stack">
          <div className="agent-workspace-head">
            <div className="agent-workspace-head-row">
              <div className="agent-workspace-heading-stack">
                <span className="chat-skeleton-line chat-skeleton-line--breadcrumb" />
                <span className="chat-skeleton-line chat-skeleton-line--subtitle" />
              </div>
            </div>
          </div>
        </div>

        <div className="agent-workspace-body-slot chat-page-skeleton__body">
          <span className="chat-skeleton-line chat-skeleton-line--greeting" />
          <div className="chat-page-skeleton__composer">
            <span className="chat-skeleton-line chat-skeleton-line--composer" />
            <span className="chat-skeleton-send" />
          </div>
        </div>
      </div>
    </section>
  )
}
