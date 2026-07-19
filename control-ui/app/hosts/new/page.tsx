'use client'

import React, { useEffect, useState } from 'react'
import { useRouter } from 'next/navigation'
import { AuthGate } from '@components/AuthGate'
import { CreateFlowSkeleton } from '@components/CreateFlowSkeleton'
import { CreatePageHeader } from '@components/CreatePageHeader'
import { DashboardLayout } from '@components/DashboardLayout'
import { HostWizard } from '@components/HostWizard'
import { IconRobot } from '@components/Sidebar/icons'
import { CREATE_FLOW_LOADING } from '@constants/createFlowLoading'
import { CONTROL_ROUTES } from '@constants/routes'
import { apiGet } from '@lib/api'

type ApiList = {
  items?: Array<Record<string, unknown>>
}

export default function CreateHostPage() {
  const router = useRouter()
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [mcpServers, setMcpServers] = useState<Array<Record<string, unknown>>>([])
  const [secrets, setSecrets] = useState<Array<Record<string, unknown>>>([])

  useEffect(() => {
    async function loadFormData() {
      setLoading(true)
      setError('')
      try {
        const [mcpResponse, secretResponse] = await Promise.all([
          apiGet('/api/v1/admin/mcp-servers') as Promise<ApiList>,
          apiGet('/api/v1/admin/secrets') as Promise<ApiList>,
        ])
        setMcpServers(mcpResponse.items || [])
        setSecrets(secretResponse.items || [])
      } catch (loadError) {
        setError(
          loadError instanceof Error ? loadError.message : 'Failed to load create-agent data'
        )
      } finally {
        setLoading(false)
      }
    }

    void loadFormData()
  }, [])

  const backToAgents = () => router.push(CONTROL_ROUTES.agents.root)

  return (
    <AuthGate>
      <DashboardLayout isDetailPage>
        {error ? <div className="cu-banner cu-banner--error">{error}</div> : null}
        {loading ? (
          <CreateFlowSkeleton
            {...CREATE_FLOW_LOADING.createAgent}
            onBack={backToAgents}
            backDisabled={false}
          />
        ) : (
          <HostWizard
            mode="page"
            mcpServers={mcpServers as any}
            existingSecrets={secrets as any}
            onCreated={async () => Promise.resolve()}
            onClose={backToAgents}
            pageHeader={
              <CreatePageHeader
                icon={<IconRobot />}
                title="Create agent"
                subtitle="Provision a new agent with context, channels, and access."
                backLabel="Back to agents"
                onBack={backToAgents}
              />
            }
          />
        )}
      </DashboardLayout>
    </AuthGate>
  )
}
