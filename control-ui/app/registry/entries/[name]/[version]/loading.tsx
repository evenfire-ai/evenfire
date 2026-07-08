'use client'

import { CreateFlowPanel } from '@components/CreateFlowPanel'
import { CreatePageHeader } from '@components/CreatePageHeader'
import { DashboardLayout } from '@components/DashboardLayout'
import { RegistryEntryDetailSkeleton } from '@components/RegistryEntryDetailSkeleton'
import { IconStore } from '@components/Sidebar/icons'

export default function RegistryEntryDetailLoading() {
  return (
    <DashboardLayout isDetailPage>
      <CreateFlowPanel
        className="cu-detail-flow-panel"
        header={
          <CreatePageHeader
            icon={<IconStore />}
            title="Marketplace entry"
            subtitle="Loading..."
            backLabel="Back to Marketplace"
            backDisabled
            onBack={() => undefined}
          />
        }
      >
        {null}
      </CreateFlowPanel>
      <RegistryEntryDetailSkeleton />
    </DashboardLayout>
  )
}
