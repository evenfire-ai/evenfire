import { AuthGate } from '@components/AuthGate'
import { DashboardLayout } from '@components/DashboardLayout'
import { MicrosoftTeamsImportWizard } from '@components/MicrosoftTeamsImportWizard'

export default function ConnectMicrosoftTeamsPage() {
  return (
    <AuthGate>
      <DashboardLayout isDetailPage>
        <MicrosoftTeamsImportWizard />
      </DashboardLayout>
    </AuthGate>
  )
}
