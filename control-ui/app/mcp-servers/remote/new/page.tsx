'use client'

import React from 'react'
import { useRouter } from 'next/navigation'
import { AddRemoteServerWizard } from '@components/AddRemoteServerWizard'
import { AuthGate } from '@components/AuthGate'
import { CreatePageHeader } from '@components/CreatePageHeader'
import { DashboardLayout } from '@components/DashboardLayout'
import { IconServer } from '@components/Sidebar/icons'
import { CONTROL_ROUTES } from '@constants/routes'

export default function AddRemoteServerPage() {
  const router = useRouter()

  return (
    <AuthGate>
      <DashboardLayout isDetailPage>
        <AddRemoteServerWizard
          onInstalled={() => router.push(CONTROL_ROUTES.connectors.root)}
          onCancel={() => router.push(CONTROL_ROUTES.connectors.root)}
          pageHeader={
            <CreatePageHeader
              icon={<IconServer />}
              title="Add remote server"
              subtitle="Discover a remote MCP server by URL and install it as an OAuth connector."
              backLabel="Back to connectors"
              onBack={() => router.push(CONTROL_ROUTES.connectors.root)}
            />
          }
        />
      </DashboardLayout>
    </AuthGate>
  )
}
