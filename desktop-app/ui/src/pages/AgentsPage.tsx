import type { RefObject } from 'react'
import { EmptyState } from '@components/Common'
import { AgentWorkspace } from '../components/agents/AgentWorkspace'
import { FleetBoard } from '../components/agents/FleetBoard'
import { useNavigationContext } from '../contexts/NavigationContext'
import { useAgentsDataController } from '../hooks/domain/useAgentsDataController'

type AgentsPageProps = {
  scrollContainerRef: RefObject<HTMLElement | null>
}

export function AgentsPage({ scrollContainerRef }: AgentsPageProps) {
  const { agentNames, loading, error } = useAgentsDataController()
  const { selectedAgent } = useNavigationContext()

  return agentNames.length ? (
    selectedAgent ? (
      <AgentWorkspace scrollContainerRef={scrollContainerRef} />
    ) : (
      <FleetBoard />
    )
  ) : (
    <section className="page">
      <div className="page-header">
        <h2>Agents</h2>
        <p className="muted">Create, manage, and monitor your AI agents from one place.</p>
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
            body="You do not currently have authorized agents."
          />
        )}
      </section>
    </section>
  )
}
