'use client'

import { AuthGate } from '@components/AuthGate'
import { CodexSubscriptionConnection } from '@components/CodexSubscriptionConnection'
import { DashboardLayout } from '@components/DashboardLayout'

export default function CodexSubscriptionProviderPage() {
  return (
    <AuthGate>
      <DashboardLayout isDetailPage>
        <CodexSubscriptionConnection />
      </DashboardLayout>
    </AuthGate>
  )
}
