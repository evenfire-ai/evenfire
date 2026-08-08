'use client'

import { AuthGate } from '@components/AuthGate'
import { DashboardLayout } from '@components/DashboardLayout'
import { MarketplaceOrgArea } from '@components/MarketplaceOrgArea'

export default function MarketplaceOrgImagesPage() {
  return (
    <AuthGate>
      <DashboardLayout isDetailPage>
        <MarketplaceOrgArea activeTab="images" />
      </DashboardLayout>
    </AuthGate>
  )
}
