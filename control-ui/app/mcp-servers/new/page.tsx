'use client'

import React from 'react'
import { useRouter } from 'next/navigation'
import { AuthGate } from '@components/AuthGate'
import { CreateMcpServerForm } from '@components/CreateMcpServerForm'
import { CreatePageHeader } from '@components/CreatePageHeader'
import { DashboardLayout } from '@components/DashboardLayout'
import { IconCable } from '@components/Sidebar/icons'

export default function CreateMcpServerPage() {
  const router = useRouter()

  return (
    <AuthGate>
      <DashboardLayout isDetailPage>
        <CreateMcpServerForm
          mode="page"
          onCreated={() => router.push('/mcp-servers')}
          onCancel={() => router.push('/mcp-servers')}
          pageHeader={
            <CreatePageHeader
              icon={<IconCable />}
              title="Create connector"
              subtitle="Register a new connector and optionally create its managed deployment metadata."
              backLabel="Back to connectors"
              onBack={() => router.push('/mcp-servers')}
            />
          }
        />
      </DashboardLayout>
    </AuthGate>
  )
}
