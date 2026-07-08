import { AuthGate } from '@components/AuthGate'
import { DashboardLayout } from '@components/DashboardLayout'
import { ProfileAdminHome } from '@components/ProfileAdminHome'
import type { ProfileAdminTab } from '@components/ProfileAdminHome.types'

export function ProfileAdminPageContent({
  activeTab,
  highlightedAdminId = '',
}: {
  activeTab: ProfileAdminTab
  highlightedAdminId?: string
}) {
  return (
    <AuthGate>
      <DashboardLayout>
        <ProfileAdminHome activeTab={activeTab} highlightedAdminId={highlightedAdminId} />
      </DashboardLayout>
    </AuthGate>
  )
}
