'use client'

import { AuthGate } from '@components/AuthGate'
import { DashboardLayout } from '@components/DashboardLayout'
import { MarketplaceOrgArea } from '@components/MarketplaceOrgArea'

export default function MarketplaceOrgConnectionPage() {
  return (
    <AuthGate>
      <DashboardLayout isDetailPage>
        <MarketplaceOrgArea activeTab="connection" />
      </DashboardLayout>
    </AuthGate>
  )
}
