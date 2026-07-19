'use client'

import React, { Suspense } from 'react'
import { useRouter, useSearchParams } from 'next/navigation'
import { AuthGate } from '@components/AuthGate'
import { CreatePageHeader } from '@components/CreatePageHeader'
import { DashboardLayout } from '@components/DashboardLayout'
import { PublishToRegistryForm } from '@components/PublishToRegistryForm'
import { IconStore } from '@components/Sidebar/icons'
import { CONTROL_ROUTES } from '@constants/routes'

export default function PublishRegistryPage() {
  return (
    <Suspense fallback={null}>
      <PublishRegistryPageContent />
    </Suspense>
  )
}

function PublishRegistryPageContent() {
  const router = useRouter()
  const searchParams = useSearchParams()
  const initialEntryType = searchParams.get('type') === 'recipe' ? 'recipe' : 'mcp-server'

  return (
    <AuthGate>
      <DashboardLayout isDetailPage>
        <PublishToRegistryForm
          initialEntryType={initialEntryType}
          onPublished={() => router.push(CONTROL_ROUTES.marketplace.root)}
          onCancel={() => router.push(CONTROL_ROUTES.marketplace.root)}
          pageHeader={
            <CreatePageHeader
              icon={<IconStore />}
              title="Publish to Marketplace"
              subtitle="Publish connectors or plugins to the Marketplace with versioned metadata."
              backLabel="Back to Marketplace"
              onBack={() => router.push(CONTROL_ROUTES.marketplace.root)}
            />
          }
        />
      </DashboardLayout>
    </AuthGate>
  )
}
