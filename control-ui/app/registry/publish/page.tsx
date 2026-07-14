'use client'

import React from 'react'
import { useRouter } from 'next/navigation'
import { AuthGate } from '@components/AuthGate'
import { CreatePageHeader } from '@components/CreatePageHeader'
import { DashboardLayout } from '@components/DashboardLayout'
import { PublishToRegistryForm } from '@components/PublishToRegistryForm'
import { IconStore } from '@components/Sidebar/icons'

export default function PublishRegistryPage() {
  const router = useRouter()

  return (
    <AuthGate>
      <DashboardLayout isDetailPage>
        <PublishToRegistryForm
          onPublished={() => router.push('/registry')}
          onCancel={() => router.push('/registry')}
          pageHeader={
            <CreatePageHeader
              icon={<IconStore />}
              title="Publish to Marketplace"
              subtitle="Publish connectors or plugins to the Marketplace with versioned metadata."
              backLabel="Back to Marketplace"
              onBack={() => router.push('/registry')}
            />
          }
        />
      </DashboardLayout>
    </AuthGate>
  )
}
