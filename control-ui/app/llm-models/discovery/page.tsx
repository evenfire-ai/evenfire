import { AuthGate } from '@components/AuthGate'
import { DashboardLayout } from '@components/DashboardLayout'
import { LlmDiscoveryPanel } from '@components/LlmDiscoveryPanel'

export default function LlmModelsDiscoveryPage() {
  return (
    <AuthGate>
      <DashboardLayout>
        <LlmDiscoveryPanel />
      </DashboardLayout>
    </AuthGate>
  )
}
