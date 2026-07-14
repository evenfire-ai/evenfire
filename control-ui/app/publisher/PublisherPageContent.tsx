import { AuthGate } from '@components/AuthGate'
import { DashboardLayout } from '@components/DashboardLayout'
import { PublisherView } from '@components/PublisherView'
import type { PublisherTab } from '@components/PublisherView/types'

export function PublisherPageContent({ activeTab }: { activeTab: PublisherTab }) {
  return (
    <AuthGate>
      <DashboardLayout isDetailPage>
        <PublisherView activeTab={activeTab} />
      </DashboardLayout>
    </AuthGate>
  )
}
